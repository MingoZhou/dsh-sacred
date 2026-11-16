/**
 * SacredEngine — every operation the plugin performs on a session, with no
 * dependency on Node or on the harness packages. The host (`index.ts`), the
 * HTTP API and the browser demo all drive this same class, so the demo runs
 * the real pruning logic.
 */
import { codePoints, head, planPrune, PLAN_DEFAULTS, TOMBSTONE_MARK, tombstone } from './core/rules.ts'
import { branchLabel } from './core/tree.ts'
import type { Plan, PlanItem, PlanOptions, PruneReason, SacredNode, SacredToolCall } from './core/types.ts'
import type { MessageLike, SessionLike } from './host-types.ts'

export interface LedgerEntry {
  originalSeq: number
  replacementSeq: number
  reason: PruneReason | 'restored' | 'branch-cut'
  at: number
  charsBefore?: number
  charsAfter?: number
}

export interface SessionState {
  pins: number[]
  ledger: LedgerEntry[]
}

export interface StateStore {
  get(sessionId: string): SessionState
  save(sessionId: string): void
}

export class MemoryStore implements StateStore {
  private readonly map = new Map<string, SessionState>()
  get(id: string): SessionState {
    let s = this.map.get(id)
    if (!s) this.map.set(id, (s = { pins: [], ledger: [] }))
    return s
  }
  save(): void { /* in-memory */ }
}

export interface EngineOptions extends Omit<PlanOptions, 'pinned'> {
  store: StateStore
  /** Freeze a message before it enters the log (host: dsh-llm `freezeMessage`). */
  freeze?: <T>(message: T) => T
  /** Token estimate for the shadow-price event (host: `ctx.tokenMeter.estimateMessage`). */
  estimate?: (message: MessageLike) => number
}

export class SacredError extends Error {
  readonly code: 'not-found' | 'not-pruned' | 'gone' | 'pinned' | 'range'
  constructor(code: SacredError['code'], message: string) {
    super(message)
    this.code = code
  }
}

/**
 * Token measurement supplied by the host (dsh tokenMeter + model info), or
 * approximated by the demo. Everything optional degrades to heuristics.
 */
export interface Meter {
  /** Route-priced tokens per surface seq. */
  tokens?: ReadonlyMap<number, number>
  /** Current request pressure (prompt incl. tool definitions, system, messages). */
  totalTokens?: number
  /** Model context window. */
  contextWindow?: number
  /** Fraction of the window where automatic compaction starts (dsh default 0.8). */
  thresholdRatio?: number
  /** Output tokens reserved per request (counted against the same window). */
  reservedOutputTokens?: number
  /** provider/model label. */
  model?: string
}

export interface ContextStats {
  totalTokens: number
  contextWindow?: number
  thresholdRatio: number
  reservedOutputTokens: number
  model?: string
  /** Where the tokens go. `overhead` = tool definitions and request framing. */
  breakdown: { system: number; user: number; assistant: number; tool: number; overhead: number }
  /** Tokens the current suggestions would free. */
  prunableTokens: number
  /** Tokens already freed by sacred in this session (tombstones still on the surface). */
  savedTokens: number
  /** True when the numbers come from dsh's tokenMeter, false for heuristic estimates. */
  measured: boolean
}

/** Heuristic token price of text (≈ 3 chars / token, mixed CJK + code). */
export function heuristicTokens(text: string): number {
  return Math.ceil(codePoints(text) / 3)
}

/** What the UI needs to draw one session. */
export interface SacredView {
  sessionId: string
  nodes: SacredNode[]
  context: ContextStats
  plan: Plan
  pins: number[]
  /** Pruned items still on the surface as tombstones, newest first. */
  void: Array<LedgerEntry & { toolName?: string; path?: string; label?: string }>
  /** Seqs on the surface that are tombstones. */
  tombstones: number[]
}

export function sessionIdOf(session: SessionLike): string {
  return session.id ?? 'default'
}

/** Project the current surface into the dependency-free rule model. */
export function snapshot(session: SessionLike): SacredNode[] {
  const nodes: SacredNode[] = []
  for (const seq of [...session.surface.nodes]) {
    const event = session.eventAt(seq)
    if (event === undefined || event.data.message === undefined) continue
    const message = session.deriveEventMessage(event)
    let text = ''
    const toolCalls: SacredToolCall[] = []
    for (const block of message.content) {
      if (block.type === 'text') text += (block as { text: string }).text
      else if (block.type === 'tool-call') {
        const b = block as { id: string; name: string; arguments: string }
        let args: Record<string, unknown> = {}
        try {
          const parsed: unknown = JSON.parse(b.arguments)
          if (parsed !== null && typeof parsed === 'object') args = parsed as Record<string, unknown>
        } catch { /* malformed arguments: treat as no known path */ }
        toolCalls.push({ id: b.id, name: b.name, args })
      }
    }
    const kind = message.role === 'tool' ? 'tool'
      : message.role === 'assistant' ? 'assistant'
        : message.role === 'user' ? 'user' : 'other'
    nodes.push({
      seq, kind, text, chars: codePoints(text),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
      ...(message.isError === undefined ? {} : { isError: message.isError }),
    })
  }
  return nodes
}

export class SacredEngine {
  readonly options: Required<Omit<PlanOptions, 'pinned'>>
  private readonly store: StateStore
  private readonly freeze: <T>(message: T) => T
  private readonly estimate: (message: MessageLike) => number

  constructor(opts: EngineOptions) {
    this.store = opts.store
    this.freeze = opts.freeze ?? (<T>(m: T) => Object.freeze(m))
    this.estimate = opts.estimate ?? ((m) => Math.ceil(m.content.reduce((n, b) => n + (b.type === 'text' ? codePoints((b as { text: string }).text) : 0), 0) / 3))
    this.options = {
      protectRecentToolResults: opts.protectRecentToolResults ?? PLAN_DEFAULTS.protectRecentToolResults,
      minChars: opts.minChars ?? PLAN_DEFAULTS.minChars,
      failedKeepChars: opts.failedKeepChars ?? PLAN_DEFAULTS.failedKeepChars,
    }
  }

  state(session: SessionLike): SessionState {
    return this.store.get(sessionIdOf(session))
  }

  plan(session: SessionLike, only?: ReadonlySet<number>, meter?: Meter): Plan {
    const nodes = priced(snapshot(session), meter)
    const p = withTokens(planPrune(nodes, { ...this.options, pinned: new Set(this.state(session).pins) }), nodes)
    if (only === undefined) return p
    return summarize(p.items.filter((i) => only.has(i.seq)), nodes)
  }

  /**
   * A plan that prunes the given tool results by hand, whatever the rules say.
   * Pinned nodes, non-tool nodes and existing tombstones are skipped.
   */
  manualPlan(session: SessionLike, seqs: Iterable<number>, meter?: Meter): Plan {
    const nodes = priced(snapshot(session), meter)
    const pins = new Set(this.state(session).pins)
    const calls = new Map<string, SacredToolCall>()
    for (const n of nodes) for (const c of n.toolCalls ?? []) calls.set(c.id, c)
    const want = new Set(seqs)
    const items: PlanItem[] = []
    for (const n of nodes) {
      if (!want.has(n.seq) || n.kind !== 'tool' || pins.has(n.seq) || n.text.startsWith(TOMBSTONE_MARK)) continue
      const call = calls.get(n.toolCallId ?? '')
      const toolName = call?.name ?? 'tool'
      const label = call ? branchLabel(call.name, call.args) : { label: toolName }
      const path = label.path
      const replacementText = tombstone('manual', { toolName, ...(path ? { path } : {}), supersededBy: 0, errorHead: head(n.text, 160) })
      items.push({
        seq: n.seq, reason: 'manual', toolName, ...(path ? { path } : {}), supersededBy: 0,
        charsBefore: n.chars, replacementText, charsAfter: codePoints(replacementText),
      })
    }
    return summarize(items, nodes)
  }

  /** Swap one surface node for a new tool/result event carrying `message`. */
  private replaceNode(session: SessionLike, seq: number, message: MessageLike, shadowed: MessageLike, sourceSeq: number): number {
    const event = session.eventAt(seq)!
    session.append('compaction/prune', {
      shadowedRange: { start: seq, end: seq },
      shadowedSeqs: [seq],
      shadowedTokenCount: this.estimate(shadowed),
    })
    return session.append('tool/result', { ...event.data, message: this.freeze(message) }, {
      surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
      sourceEventSeqs: [sourceSeq],
    }).seq
  }

  /** Apply a plan (default: the full current plan). Returns the plan actually applied. */
  prune(session: SessionLike, p: Plan = this.plan(session)): Plan {
    const id = sessionIdOf(session)
    const state = this.store.get(id)
    for (const item of p.items) {
      const event = session.eventAt(item.seq)
      if (event === undefined) continue
      const original = session.deriveEventMessage(event)
      const tomb: MessageLike = { ...original, content: [{ type: 'text', text: item.replacementText }] }
      const replacementSeq = this.replaceNode(session, item.seq, tomb, original, item.seq)
      state.ledger.push({
        originalSeq: item.seq, replacementSeq, reason: item.reason, at: Date.now(),
        charsBefore: item.charsBefore, charsAfter: item.charsAfter,
      })
    }
    if (p.items.length > 0) this.store.save(id)
    return p
  }

  pin(session: SessionLike, seq: number): void {
    if (!session.surface.nodes.includes(seq)) throw new SacredError('not-found', `seq ${seq} 不在当前上下文中。`)
    const state = this.state(session)
    state.pins = [...new Set([...state.pins, seq])]
    this.store.save(sessionIdOf(session))
  }

  unpin(session: SessionLike, seq: number): void {
    const state = this.state(session)
    state.pins = state.pins.filter((s) => s !== seq)
    this.store.save(sessionIdOf(session))
  }

  /** Put an original back in place of its tombstone. Returns the new surface seq. */
  restore(session: SessionLike, seq: number): { originalSeq: number; seq: number } {
    const state = this.state(session)
    const entry = this.liveEntries(session).find((e) => e.replacementSeq === seq || e.originalSeq === seq)
    if (!entry) {
      const known = state.ledger.some((e) => e.replacementSeq === seq || e.originalSeq === seq)
      throw known
        ? new SacredError('gone', `seq ${seq} 的墓碑已不在当前上下文中（可能已被压缩），无法原位恢复。`)
        : new SacredError('not-pruned', `seq ${seq} 不是 sacred 剪除过的节点。`)
    }
    const original = session.deriveEventMessage(session.eventAt(entry.originalSeq)!)
    const tomb = session.deriveEventMessage(session.eventAt(entry.replacementSeq)!)
    const back = this.replaceNode(session, entry.replacementSeq, original, tomb, entry.originalSeq)
    state.ledger.push({ originalSeq: entry.originalSeq, replacementSeq: back, reason: 'restored', at: Date.now() })
    this.store.save(sessionIdOf(session))
    return { originalSeq: entry.originalSeq, seq: back }
  }

  /** Ledger prunes whose tombstone is still on the surface (restorable), newest first. */
  liveEntries(session: SessionLike): LedgerEntry[] {
    const surface = new Set(session.surface.nodes)
    return this.state(session).ledger
      .filter((e) => e.reason !== 'restored' && e.reason !== 'branch-cut' && surface.has(e.replacementSeq))
      .reverse()
  }

  view(session: SessionLike, meter?: Meter): SacredView {
    const nodes = priced(snapshot(session), meter)
    const calls = new Map<string, SacredToolCall>()
    for (const n of nodes) for (const c of n.toolCalls ?? []) calls.set(c.id, c)
    const bySeq = new Map(nodes.map((n) => [n.seq, n]))
    const voidItems = this.liveEntries(session).map((e) => {
      const call = calls.get(bySeq.get(e.replacementSeq)?.toolCallId ?? '')
      if (!call) return { ...e }
      const { label, path } = branchLabel(call.name, call.args)
      return { ...e, toolName: call.name, label, ...(path ? { path } : {}) }
    })
    const plan = withTokens(planPrune(nodes, { ...this.options, pinned: new Set(this.state(session).pins) }), nodes)
    const breakdown = { system: 0, user: 0, assistant: 0, tool: 0, overhead: 0 }
    for (const n of nodes) {
      const k = n.kind === 'other' ? 'system' : n.kind
      breakdown[k] += n.tokens ?? 0
    }
    const surface = breakdown.system + breakdown.user + breakdown.assistant + breakdown.tool
    const totalTokens = Math.max(meter?.totalTokens ?? surface, surface)
    breakdown.overhead = totalTokens - surface
    const savedTokens = voidItems.reduce((sum, v) => {
      const now = nodes.find((n) => n.seq === v.replacementSeq)?.tokens ?? 0
      return sum + Math.max(0, Math.ceil((v.charsBefore ?? 0) / 3) - now)
    }, 0)
    return {
      sessionId: sessionIdOf(session),
      nodes,
      context: {
        totalTokens,
        ...(meter?.contextWindow ? { contextWindow: meter.contextWindow } : {}),
        thresholdRatio: meter?.thresholdRatio ?? 0.8,
        reservedOutputTokens: meter?.reservedOutputTokens ?? 0,
        ...(meter?.model ? { model: meter.model } : {}),
        breakdown,
        prunableTokens: plan.tokensSaved ?? 0,
        savedTokens,
        measured: meter?.tokens !== undefined,
      },
      plan,
      pins: [...this.state(session).pins],
      void: voidItems,
      tombstones: nodes.filter((n) => n.kind === 'tool' && n.text.startsWith(TOMBSTONE_MARK)).map((n) => n.seq),
    }
  }
}

/** Attach a token price to every node: measured when available, heuristic otherwise. */
function priced(nodes: SacredNode[], meter?: Meter): SacredNode[] {
  return nodes.map((n) => {
    const measured = meter?.tokens?.get(n.seq)
    const fallback = heuristicTokens(n.text) + (n.toolCalls ?? []).reduce((s, c) => s + heuristicTokens(JSON.stringify(c.args)) + 4, 0) + 4
    return { ...n, tokens: measured ?? fallback }
  })
}

function itemTokens(item: PlanItem, nodes: readonly SacredNode[]): number {
  const before = nodes.find((n) => n.seq === item.seq)?.tokens ?? heuristicTokens('x'.repeat(item.charsBefore))
  return Math.max(0, before - heuristicTokens(item.replacementText))
}

function withTokens(p: Plan, nodes: readonly SacredNode[]): Plan {
  return summarize(p.items, nodes, p.firstIndex)
}

function summarize(items: PlanItem[], nodes: readonly SacredNode[], firstIndex?: number): Plan {
  const priced = items.map((i) => ({ ...i, tokensSaved: itemTokens(i, nodes) }))
  const indexOf = new Map(nodes.map((n, i) => [n.seq, i]))
  return {
    items: priced,
    charsBefore: priced.reduce((s, i) => s + i.charsBefore, 0),
    charsAfter: priced.reduce((s, i) => s + i.charsAfter, 0),
    firstIndex: firstIndex ?? (priced.length === 0 ? -1 : Math.min(...priced.map((i) => indexOf.get(i.seq) ?? Infinity))),
    tokensSaved: priced.reduce((s, i) => s + (i.tokensSaved ?? 0), 0),
  }
}
