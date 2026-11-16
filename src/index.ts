/**
 * dsh-sacred — host half.
 *
 * Value-based context pruning for DeepSeek Harness. Each tool result the
 * rules mark as stale (read then overwritten, re-read, duplicated, failed and
 * retried) is replaced on the session *surface* by a short tombstone, the same
 * replay-safe way the official tool-result pruner works: the original stays in
 * the append-only log, the replacement cites it via `sourceEventSeqs`, and a
 * `compaction/prune` shadow-price event keeps token accounting honest.
 *
 * Three entry points share one SacredEngine:
 *  - `/sacred` slash command;
 *  - an `agent/pre-step` listener (prepended, so it runs before
 *    `dsh-compaction-basic` checks pressure);
 *  - a small HTTP API for the 「上下文裁剪」 tab (sessions resolved through
 *    `sessionController.resolveAgent`, the same path DSH uses to open one):
 *
 *      GET  /sacred/api/session/<id>           → SacredView (+ busy)
 *      POST /sacred/api/session/<id>/prune     { seqs?: number[] }
 *      POST /sacred/api/session/<id>/pin       { seq }
 *      POST /sacred/api/session/<id>/unpin     { seq }
 *      POST /sacred/api/session/<id>/restore   { seq }
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plan, PlanOptions } from './core/index.ts'
import { SacredEngine, SacredError, type Meter, type SacredView } from './engine.ts'
import type {
  AgentLike, CommandInvocation, CommandResult, CompactionLike, ContextLike, LiveAgentLike, SessionLike, TokenMeterLike,
} from './host-types.ts'
import { defaultStateDir, FileStore } from './store.ts'

export * from './core/index.ts'
export * from './engine.ts'

export const name = 'dsh-sacred'
/**
 * Only services every DSH web profile has are required, so a missing or renamed
 * optional service can never keep the plugin from starting. Everything else
 * (tokenMeter, compaction, sessionController, agents) is read on demand with
 * `ctx.get` and degrades gracefully across DSH versions.
 */
export const inject = ['webServer', 'commands']

export const VERSION = '0.2.0'

/** Same as dsh-llm `freezeMessage`: a frozen structured clone. */
function freezeMessage<T>(message: T): T {
  const deepFreeze = (v: unknown): unknown => {
    if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
      Object.freeze(v)
      for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k])
    }
    return v
  }
  return deepFreeze(structuredClone(message)) as T
}

export interface Config extends Omit<PlanOptions, 'pinned'> {
  /** Prune automatically before each model step (default true). */
  auto?: boolean
  /**
   * Only prune automatically when at least this many characters are saved.
   * Batching matters: every prune invalidates the provider's prefix cache from
   * the first replaced node on, so small frequent prunes cost more than they save.
   */
  minSavingsChars?: number
  /** Where pins and the prune ledger live (default `$DSH_HOME/sacred`). */
  stateDir?: string
  /** URL prefix of the HTTP API used by the 上下文裁剪 tab. */
  routePrefix?: string
  /** Characters of each node's text sent to the browser (default 600). */
  previewChars?: number
  /** Where automatic compaction starts, as a fraction of the window (match compaction-basic; default 0.8). */
  thresholdRatio?: number
}

const DEFAULTS = { auto: true, minSavingsChars: 6000, routePrefix: '/sacred/api', previewChars: 600, thresholdRatio: 0.8 }

function describe(p: Plan, total: number): string {
  if (p.items.length === 0) return '时间线很干净：没有可剪除的异常分支。'
  const lines = p.items.map((i) =>
    `  seq ${i.seq}  ${i.reason.padEnd(19)} ${i.toolName}${i.path ? ` ${i.path}` : ''}  ${i.charsBefore}→${i.charsAfter} 字符`)
  return [
    `可剪除 ${p.items.length} 个异常分支，节省约 ${p.charsBefore - p.charsAfter} 字符：`,
    ...lines,
    `缓存代价：从第 ${p.firstIndex + 1}/${total} 个节点起前缀缓存失效。运行 /sacred prune 执行。`,
  ].join('\n')
}

export function apply(ctx: ContextLike, config: Config = {}): void {
  const cfg = { ...DEFAULTS, ...config }
  const service = <T>(name: string): T | undefined => {
    try {
      return ctx.get?.(name, false) as T | undefined
    } catch {
      return undefined
    }
  }
  const log = (level: 'info' | 'warn', msg: string): void => {
    try { ctx.logger?.[level]?.(msg) } catch { /* logger unavailable */ }
  }
  const engine = new SacredEngine({
    store: new FileStore(config.stateDir ?? defaultStateDir()),
    freeze: freezeMessage,
    estimate: (m) => {
      const meter = service<TokenMeterLike>('tokenMeter')
      return meter ? meter.estimateMessage(m) : Math.ceil(JSON.stringify(m.content).length / 3)
    },
    ...(cfg.protectRecentToolResults === undefined ? {} : { protectRecentToolResults: cfg.protectRecentToolResults }),
    ...(cfg.minChars === undefined ? {} : { minChars: cfg.minChars }),
    ...(cfg.failedKeepChars === undefined ? {} : { failedKeepChars: cfg.failedKeepChars }),
  })

  // ---------------------------------------------------------------- command
  async function command(inv: CommandInvocation): Promise<CommandResult> {
    const session = inv.agent.session
    const [sub = 'status', ...rest] = inv.rawInput.trim().split(/\s+/).filter(Boolean)
    const nums = rest.map(Number)
    const badSeq = nums.some((n) => !Number.isInteger(n))
    try {
      switch (sub) {
        case 'status':
          return { kind: 'success', text: describe(engine.plan(session), session.surface.nodes.length) }
        case 'prune': {
          const p = engine.prune(session)
          return { kind: 'success', text: p.items.length === 0 ? '没有可剪除的分支。' : `已剪除 ${p.items.length} 个异常分支，节省约 ${p.charsBefore - p.charsAfter} 字符。原文在虚空中，可用 /sacred restore <seq> 召回。` }
        }
        case 'drop': {
          if (nums.length === 0 || badSeq) return { kind: 'error', text: '用法：/sacred drop <seq> [seq…]（手动裁剪指定的工具输出）' }
          const p = engine.prune(session, engine.manualPlan(session, nums))
          return { kind: 'success', text: p.items.length === 0 ? '这些节点不能裁剪（不是工具输出、已钉住或已裁剪）。' : `已手动裁剪 ${p.items.length} 处，节省约 ${p.tokensSaved ?? 0} tokens。` }
        }
        case 'pin':
        case 'unpin': {
          if (nums.length !== 1 || badSeq) return { kind: 'error', text: `用法：/sacred ${sub} <seq>` }
          if (sub === 'pin') engine.pin(session, nums[0]!)
          else engine.unpin(session, nums[0]!)
          return { kind: 'success', text: sub === 'pin' ? `seq ${nums[0]} 已钉入神圣时间线，sacred 永不剪除。` : `已取消钉住 seq ${nums[0]}。` }
        }
        case 'pins': {
          const pins = engine.state(session).pins
          return { kind: 'success', text: pins.length === 0 ? '还没有钉住任何节点。' : `已钉住：${pins.join(', ')}` }
        }
        case 'restore': {
          if (nums.length !== 1 || badSeq) return { kind: 'error', text: '用法：/sacred restore <seq>' }
          const r = engine.restore(session, nums[0]!)
          return { kind: 'success', text: `已从虚空召回 seq ${r.originalSeq}（现为 seq ${r.seq}）。`, sourceEventSeq: r.seq }
        }
        case 'cut': {
          if (nums.length !== 2 || badSeq) return { kind: 'error', text: '用法：/sacred cut <起始seq> <结束seq>' }
          const pins = new Set(engine.state(session).pins)
          const nodes = session.surface.nodes
          const a = nodes.indexOf(nums[0]!), b = nodes.indexOf(nums[1]!)
          if (a < 0 || b < 0 || a > b) return { kind: 'error', text: '区间不在当前上下文中，或起止顺序颠倒。' }
          const hit = nodes.slice(a, b + 1).filter((s) => pins.has(s))
          if (hit.length > 0) return { kind: 'error', text: `区间包含钉住的节点 ${hit.join(', ')}，拒绝剪除。` }
          const compaction = service<CompactionLike>('compaction')
          if (!compaction?.compactRegion) return { kind: 'error', text: '当前 DSH 版本没有提供 compactRegion，无法整段裁剪。' }
          const r = await compaction.compactRegion(nums[0]!, nums[1]!, inv.agent, inv.signal)
          const state = engine.state(session)
          state.ledger.push({ originalSeq: nums[0]!, replacementSeq: r.summarySeq, reason: 'branch-cut', at: Date.now() })
          return { kind: 'success', text: `已将 ${r.shadowedSeqs.length} 个节点（约 ${r.shadowedTokenCount} tokens）的分支收束为一块墓碑。`, sourceEventSeq: r.summarySeq }
        }
        default:
          return { kind: 'error', text: '用法：/sacred [status|prune|drop <seq…>|pin <seq>|unpin <seq>|pins|restore <seq>|cut <start> <end>]' }
      }
    } catch (error: unknown) {
      if (error instanceof SacredError) return { kind: 'error', text: error.message }
      throw error
    }
  }

  ctx.effect(function* () {
    yield ctx.commands.register({
      definitionId: '@mingozhou/dsh-sacred',
      name: 'sacred',
      description: 'Prune stale context branches, pin what matters, restore anything',
      handler: command,
    })
  }, 'dsh-sacred command')

  // ---------------------------------------------------------------- auto
  if (cfg.auto) {
    ctx.on('agent/pre-step', async ({ agent, signal }: { agent: AgentLike; signal: AbortSignal }, next) => {
      if (!signal.aborted) {
        try {
          const p = engine.plan(agent.session)
          if (p.charsBefore - p.charsAfter >= cfg.minSavingsChars) {
            engine.prune(agent.session, p)
            log('info', `sacred: pruned ${p.items.length} stale branches (~${p.charsBefore - p.charsAfter} chars)`)
          }
        } catch (error: unknown) {
          log('warn', `sacred: prune failed: ${error instanceof Error ? error.message : String(error)}; continuing`)
        }
      }
      return next()
    }, { prepend: true })
  }

  // ---------------------------------------------------------------- HTTP
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: cfg.routePrefix,
    handler: (req, res) => handle(req, res),
  }), 'dsh-sacred http')
  log('info', `sacred: v${VERSION} ready — /sacred command, HTTP API at ${cfg.routePrefix}`)

  /**
   * Live agent for a session id. Tries, in order: the public
   * `sessionController.resolveAgent` (newer DSH), the controller's internal
   * agent resolver (DSH 0.2.1), then the live-agent registry. The first two
   * resume a persisted session the same way DSH does when you open it.
   */
  async function resolveAgent(id: string): Promise<LiveAgentLike | string> {
    type Resolver = { resolveAgent?: (id: string) => Promise<{ agent: LiveAgentLike } | { error: unknown }> }
    const sc = service<Resolver & { agents?: Resolver }>('sessionController')
    const resolver = typeof sc?.resolveAgent === 'function' ? sc
      : typeof sc?.agents?.resolveAgent === 'function' ? sc.agents : undefined
    if (resolver) {
      try {
        const r = await resolver.resolveAgent!.call(resolver, id)
        if ('agent' in r) return r.agent
        const e = r.error as { message?: string; code?: string } | string
        return typeof e === 'string' ? e : (e?.message ?? e?.code ?? '会话无法加载')
      } catch (error: unknown) {
        log('warn', `sacred: resolveAgent failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const live = service<{ get(id: string): LiveAgentLike | undefined }>('agents')?.get(id)
    return live ?? '会话当前没有加载。请在这个会话里发一条消息，然后重试。'
  }

  /** Measure a session the way dsh does: tokenMeter for prices, the routed model for the window. */
  async function meterFor(session: SessionLike): Promise<Meter> {
    const m: Meter = { thresholdRatio: cfg.thresholdRatio }
    try {
      const tm = service<{ measure(s: unknown): { totalTokens: number; nodes: readonly { seq: number; tokens: number }[] } }>('tokenMeter')
      if (typeof tm?.measure === 'function') {
        const r = tm.measure(session)
        m.tokens = new Map(r.nodes.map((n) => [n.seq, n.tokens]))
        m.totalTokens = r.totalTokens
      }
    } catch (error: unknown) {
      log('warn', `sacred: tokenMeter.measure failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      const config = session.requestHeader?.()?.config
      if (config?.provider && config.model) {
        m.model = config.model
        const llm = service<{ resolveModelInfo(p: string, m: string): Promise<{ context?: { contextWindow?: number }; defaultMaxTokens?: number }> }>('llm')
        if (typeof llm?.resolveModelInfo === 'function') {
          const info = await llm.resolveModelInfo(config.provider, config.model)
          if (info.context?.contextWindow) m.contextWindow = info.context.contextWindow
          m.reservedOutputTokens = config.maxTokens ?? info.defaultMaxTokens ?? 0
        }
      }
    } catch (error: unknown) {
      log('warn', `sacred: model info unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
    return m
  }

  async function viewOf(session: SessionLike): Promise<SacredView> {
    return slim(engine.view(session, await meterFor(session)))
  }

  function slim(view: SacredView): SacredView {
    return { ...view, nodes: view.nodes.map((n) => ({ ...n, text: n.text.slice(0, cfg.previewChars) })) }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://local')
    if (url.pathname === `${cfg.routePrefix}/health`) {
      return json(res, 200, {
        ok: true,
        version: VERSION,
        services: Object.fromEntries(['tokenMeter', 'llm', 'compaction', 'sessionController', 'agents']
          .map((n) => [n, service(n) !== undefined])),
      })
    }
    const m = new RegExp(`^${cfg.routePrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/session/([^/]+)(?:/(prune|pin|unpin|restore))?$`).exec(url.pathname)
    if (!m) return json(res, 404, { error: 'not found' })
    const id = decodeURIComponent(m[1]!)
    const action = m[2]
    const agent = await resolveAgent(id)
    if (typeof agent === 'string') return json(res, 404, { error: agent, code: 'not-live' })
    const session = agent.session
    const busy = agent.status === 'running'
    try {
      if (action === undefined) {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        return json(res, 200, { ...(await viewOf(session)), busy })
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
      if (busy) return json(res, 409, { error: 'Agent 正在运行，等这一轮结束再操作。', code: 'busy' })
      const body = await readJson(req)
      const seq = typeof body['seq'] === 'number' ? body['seq'] : undefined
      switch (action) {
        case 'prune': {
          const seqs = Array.isArray(body['seqs']) ? new Set(body['seqs'].filter((s): s is number => typeof s === 'number')) : undefined
          const meter = await meterFor(session)
          const plan = body['manual'] === true && seqs ? engine.manualPlan(session, seqs, meter) : engine.plan(session, seqs, meter)
          const p = engine.prune(session, plan)
          return json(res, 200, { pruned: p.items.length, saved: p.charsBefore - p.charsAfter, savedTokens: p.tokensSaved ?? 0, view: await viewOf(session) })
        }
        case 'pin':
        case 'unpin':
          if (seq === undefined) return json(res, 400, { error: 'seq required' })
          if (action === 'pin') engine.pin(session, seq)
          else engine.unpin(session, seq)
          return json(res, 200, { view: await viewOf(session) })
        case 'restore': {
          if (seq === undefined) return json(res, 400, { error: 'seq required' })
          const r = engine.restore(session, seq)
          return json(res, 200, { restored: r, view: await viewOf(session) })
        }
      }
    } catch (error: unknown) {
      if (error instanceof SacredError) return json(res, 400, { error: error.message, code: error.code })
      log('warn', `sacred http: ${error instanceof Error ? error.message : String(error)}`)
      return json(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 64 * 1024) throw new SacredError('range', 'request body too large')
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return {}
  try {
    const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
