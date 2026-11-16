/**
 * Turn a SacredView into the tree drawing model: each user turn is a
 * node on the trunk, each tool call is a branch growing from it.
 */
import { TOMBSTONE_MARK } from './rules.ts'
import type { PlanItem, PruneReason, SacredNode } from './types.ts'

export type BranchStatus = 'healthy' | 'error' | 'anomaly' | 'pinned' | 'pruned'

export interface Branch {
  /** Tool call id. */
  key: string
  toolName: string
  /** Short human label: file name, command, pattern. */
  label: string
  path?: string
  /** Seq of the result node (the one pins / prunes act on). */
  resultSeq?: number
  status: BranchStatus
  isError: boolean
  chars: number
  /** Token price on the surface now (tombstone price once pruned). */
  tokens: number
  preview: string
  plan?: PlanItem
  /** For pruned branches: why they were pruned (parsed back from the ledger). */
  prunedReason?: PruneReason
  prunedChars?: number
}

export interface Turn {
  index: number
  userSeq?: number
  userText: string
  userPinned: boolean
  replyText: string
  branches: Branch[]
  /** All tokens of this turn on the surface (user + assistant + tool results). */
  tokens: number
}

export interface TreeTotals {
  turns: number
  branches: number
  anomalies: number
  pinned: number
  pruned: number
  savingChars: number
  savingTokens: number
}

/** The subset of SacredView the tree needs (kept structural so the client can import it). */
export interface TreeInput {
  nodes: SacredNode[]
  plan: { items: PlanItem[]; tokensSaved?: number }
  pins: number[]
  void: Array<{ replacementSeq: number; reason: string; charsBefore?: number }>
}

function basename(p: string): string {
  const parts = p.split('/')
  return parts[parts.length - 1] || p
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}

export function branchLabel(name: string, args: Record<string, unknown>): { label: string; path?: string } {
  const path = str(args['file_path']) ?? str(args['path'])
  if (['read', 'write', 'edit', 'str_replace_editor'].includes(name) && path) return { label: basename(path), path }
  const cmd = str(args['command'])
  if (cmd) return { label: cmd.length > 28 ? `${cmd.slice(0, 27)}…` : cmd }
  const pattern = str(args['pattern']) ?? str(args['query'])
  if (pattern) return { label: pattern.length > 28 ? `${pattern.slice(0, 27)}…` : pattern }
  if (name === 'apply_patch') {
    const m = /\*\*\* (?:Update|Add|Delete) File: (.+)/.exec(str(args['patch']) ?? str(args['input']) ?? '')
    if (m?.[1]) return { label: basename(m[1].trim()), path: m[1].trim() }
  }
  return { label: name }
}

export function buildTree(view: TreeInput): { turns: Turn[]; totals: TreeTotals } {
  const pins = new Set(view.pins)
  const planBySeq = new Map(view.plan.items.map((i) => [i.seq, i]))
  const voidBySeq = new Map(view.void.map((v) => [v.replacementSeq, v]))
  const results = new Map<string, SacredNode>()
  for (const n of view.nodes) if (n.kind === 'tool' && n.toolCallId) results.set(n.toolCallId, n)

  const turns: Turn[] = []
  let cur: Turn | undefined
  const open = (user?: SacredNode): Turn => {
    const t: Turn = {
      index: turns.length,
      ...(user ? { userSeq: user.seq } : {}),
      userText: user?.text ?? '',
      userPinned: user ? pins.has(user.seq) : false,
      replyText: '',
      branches: [],
      tokens: user?.tokens ?? 0,
    }
    turns.push(t)
    return t
  }

  for (const n of view.nodes) {
    if (n.kind === 'user') { cur = open(n); continue }
    if (n.kind !== 'assistant') continue
    cur ??= open()
    cur.tokens += n.tokens ?? 0
    if (n.text.trim()) cur.replyText = n.text
    for (const call of n.toolCalls ?? []) {
      const res = results.get(call.id)
      const { label, path } = branchLabel(call.name, call.args)
      const plan = res ? planBySeq.get(res.seq) : undefined
      const tomb = res !== undefined && res.text.startsWith(TOMBSTONE_MARK)
      const voided = res ? voidBySeq.get(res.seq) : undefined
      if (res) cur.tokens += res.tokens ?? 0
      const status: BranchStatus = res && pins.has(res.seq) ? 'pinned'
        : tomb ? 'pruned'
          : plan ? 'anomaly'
            : res?.isError ? 'error' : 'healthy'
      cur.branches.push({
        key: call.id,
        toolName: call.name,
        label,
        ...(path ? { path } : {}),
        ...(res ? { resultSeq: res.seq } : {}),
        status,
        isError: res?.isError ?? false,
        chars: res?.chars ?? 0,
        tokens: res?.tokens ?? 0,
        preview: res?.text ?? '',
        ...(plan ? { plan } : {}),
        ...(voided ? { prunedReason: voided.reason as PruneReason } : {}),
        ...(voided?.charsBefore !== undefined ? { prunedChars: voided.charsBefore } : {}),
      })
    }
  }

  const all = turns.flatMap((t) => t.branches)
  return {
    turns,
    totals: {
      turns: turns.length,
      branches: all.length,
      anomalies: all.filter((b) => b.status === 'anomaly').length,
      pinned: view.pins.length,
      pruned: all.filter((b) => b.status === 'pruned').length,
      savingChars: view.plan.items.reduce((s, i) => s + i.charsBefore - i.charsAfter, 0),
      savingTokens: view.plan.tokensSaved ?? view.plan.items.reduce((s, i) => s + (i.tokensSaved ?? 0), 0),
    },
  }
}
