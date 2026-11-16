/**
 * Value-based pruning rules. Unlike the official size-based pruner, these
 * ask "is this output still true / still useful?", not "is it long?".
 *
 * The planner is pure: it reads a surface snapshot and returns which tool
 * results to replace with what tombstone. It never removes a node, so tool
 * call / result pairing is always preserved.
 */
import { canonicalArgs, readPath, readRangeKey, writtenPaths } from './paths.ts'
import type { SacredNode, SacredToolCall, Plan, PlanItem, PlanOptions, PruneReason } from './types.ts'

/** Every tombstone starts with this, so a pruned node is never pruned twice. */
export const TOMBSTONE_MARK = '⟪sacred⟫'

export const PLAN_DEFAULTS: Required<Omit<PlanOptions, 'pinned'>> = {
  protectRecentToolResults: 4,
  minChars: 200,
  failedKeepChars: 400,
}

export function codePoints(s: string): number {
  let n = 0
  for (const _ of s) n++
  return n
}

export function head(s: string, n: number): string {
  const pts = Array.from(s)
  return pts.length <= n ? s : `${pts.slice(0, n).join('')}…`
}

export function tombstone(reason: PruneReason, item: { toolName: string; path?: string; supersededBy: number; errorHead?: string }): string {
  const target = item.path === undefined ? item.toolName : `${item.toolName} ${item.path}`
  switch (reason) {
    case 'superseded-by-write':
      return `${TOMBSTONE_MARK} Pruned stale branch: this ${target} output is outdated — the file was modified later (seq ${item.supersededBy}). Re-read the file if you need its current content.`
    case 'superseded-by-read':
      return `${TOMBSTONE_MARK} Pruned: the same ${target} was read again later (seq ${item.supersededBy}); see that result.`
    case 'duplicate':
      return `${TOMBSTONE_MARK} Pruned duplicate: identical ${target} call with identical output appears later (seq ${item.supersededBy}).`
    case 'manual':
      return `${TOMBSTONE_MARK} Pruned by the user: this ${target} output was removed from context to save space. The original is kept in the session log; ask the user to restore it if you need it. It began:\n${item.errorHead ?? ''}`
    case 'failed-retried':
      return `${TOMBSTONE_MARK} Pruned failed attempt of ${target}; a later ${item.toolName} call succeeded (seq ${item.supersededBy}). Lesson kept — original error began:\n${item.errorHead ?? ''}`
  }
}

interface Located {
  index: number
  node: SacredNode
  call: SacredToolCall
  callIndex: number
}

/**
 * Plan value-based replacements over one surface snapshot.
 * @param nodes - surface nodes in surface order.
 * @param options - pins and thresholds.
 */
export function planPrune(nodes: readonly SacredNode[], options: PlanOptions = {}): Plan {
  const opts = { ...PLAN_DEFAULTS, ...options }
  const pinned = options.pinned ?? new Set<number>()

  // Index tool calls by id, remembering the surface position of the request.
  const calls = new Map<string, { call: SacredToolCall; index: number }>()
  nodes.forEach((node, index) => {
    for (const call of node.toolCalls ?? []) calls.set(call.id, { call, index })
  })

  const results: Located[] = []
  nodes.forEach((node, index) => {
    if (node.kind !== 'tool' || node.toolCallId === undefined) return
    const found = calls.get(node.toolCallId)
    if (found) results.push({ index, node, call: found.call, callIndex: found.index })
  })

  const protectedFrom = Math.max(0, results.length - opts.protectRecentToolResults)
  const items: PlanItem[] = []

  for (let r = 0; r < protectedFrom; r++) {
    const cur = results[r]!
    if (pinned.has(cur.node.seq) || cur.node.text.startsWith(TOMBSTONE_MARK)) continue
    const later = results.slice(r + 1)
    const item = staleBy(cur, later, nodes) ?? duplicateOf(cur, later) ?? failedRetried(cur, later, opts.failedKeepChars)
    if (item === undefined) continue
    if (item.reason !== 'failed-retried' && cur.node.chars < opts.minChars) continue
    if (item.charsAfter >= item.charsBefore) continue
    items.push(item)
  }

  const indexOf = new Map(nodes.map((n, i) => [n.seq, i]))
  const firstIndex = items.length === 0 ? -1 : Math.min(...items.map((i) => indexOf.get(i.seq)!))
  return {
    items,
    charsBefore: items.reduce((s, i) => s + i.charsBefore, 0),
    charsAfter: items.reduce((s, i) => s + i.charsAfter, 0),
    firstIndex,
  }
}

function make(cur: Located, reason: PruneReason, supersededBy: number, path?: string, errorHead?: string): PlanItem {
  const replacementText = tombstone(reason, { toolName: cur.call.name, path, supersededBy, errorHead })
  return {
    seq: cur.node.seq,
    reason,
    toolName: cur.call.name,
    ...(path === undefined ? {} : { path }),
    supersededBy,
    charsBefore: cur.node.chars,
    replacementText,
    charsAfter: codePoints(replacementText),
  }
}

/** A read made stale by a later successful write to, or re-read of, the same path. */
function staleBy(cur: Located, later: Located[], nodes: readonly SacredNode[]): PlanItem | undefined {
  const path = readPath(cur.call)
  if (path === undefined || cur.node.isError) return undefined
  // Writes can appear in any assistant node after the read's result.
  for (let i = cur.index + 1; i < nodes.length; i++) {
    for (const call of nodes[i]!.toolCalls ?? []) {
      if (!writtenPaths(call).includes(path)) continue
      const res = later.find((l) => l.call.id === call.id)
      if (res && !res.node.isError) return make(cur, 'superseded-by-write', res.node.seq, path)
    }
  }
  const key = readRangeKey(cur.call)
  const reread = later.find((l) => readPath(l.call) === path && readRangeKey(l.call) === key && !l.node.isError)
  return reread ? make(cur, 'superseded-by-read', reread.node.seq, path) : undefined
}

function duplicateOf(cur: Located, later: Located[]): PlanItem | undefined {
  const args = canonicalArgs(cur.call.args)
  const dup = later.find((l) => l.call.name === cur.call.name
    && canonicalArgs(l.call.args) === args
    && l.node.text === cur.node.text
    && l.node.isError === cur.node.isError)
  return dup ? make(cur, 'duplicate', dup.node.seq) : undefined
}

function failedRetried(cur: Located, later: Located[], keep: number): PlanItem | undefined {
  if (!cur.node.isError) return undefined
  const ok = later.find((l) => l.call.name === cur.call.name && !l.node.isError)
  return ok ? make(cur, 'failed-retried', ok.node.seq, readPath(cur.call), head(cur.node.text, keep)) : undefined
}
