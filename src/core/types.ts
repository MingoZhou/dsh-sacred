/**
 * Dependency-free model of a session surface, so the pruning rules can be
 * planned and tested without a running harness. The host adapter
 * (`src/index.ts`) converts real dsh surface nodes into these.
 */

export interface SacredToolCall {
  /** Provider-issued call id; matches `SacredNode.toolCallId` on the result. */
  id: string
  name: string
  /** Parsed JSON arguments (an empty object when unparsable). */
  args: Record<string, unknown>
}

export type SacredNodeKind = 'user' | 'assistant' | 'tool' | 'other'

/** One model-visible surface node, in surface order. */
export interface SacredNode {
  /** Session seq of the event currently occupying this surface position. */
  seq: number
  kind: SacredNodeKind
  /** Concatenated text blocks. */
  text: string
  /** Text length in Unicode code points. */
  chars: number
  /** Tool calls requested by an assistant node. */
  toolCalls?: SacredToolCall[]
  /** For tool results: the call this result answers. */
  toolCallId?: string
  /** For tool results: whether the tool reported failure. */
  isError?: boolean
  /** Token price of this node (tokenMeter when available, heuristic otherwise). */
  tokens?: number
}

export type PruneReason =
  /** A file read whose file was later written / edited / patched. */
  | 'superseded-by-write'
  /** A file read repeated later with the same range. */
  | 'superseded-by-read'
  /** Same tool + same arguments + same output seen again later. */
  | 'duplicate'
  /** A failed call whose tool later succeeded; only the error head is kept. */
  | 'failed-retried'
  /** The user chose to prune this output by hand. */
  | 'manual'

export interface PlanItem {
  /** Surface seq of the tool result to replace. */
  seq: number
  reason: PruneReason
  toolName: string
  /** File path involved, when the rule is file-based. */
  path?: string
  /** Seq of the later node that made this one stale. */
  supersededBy: number
  charsBefore: number
  /** Model-facing text that replaces the original output (the "tombstone"). */
  replacementText: string
  charsAfter: number
  /** Tokens this replacement saves (node price − tombstone estimate). */
  tokensSaved?: number
}

export interface PlanOptions {
  /** Surface seqs the user pinned; never touched. */
  pinned?: ReadonlySet<number>
  /** The most recent N tool results are always left alone. */
  protectRecentToolResults?: number
  /** Tool results shorter than this are not worth a replacement (except failures). */
  minChars?: number
  /** Characters of an error message kept in a failed-retried tombstone. */
  failedKeepChars?: number
}

export interface Plan {
  items: PlanItem[]
  charsBefore: number
  charsAfter: number
  /** Surface position (0-based index) of the earliest replacement, or -1. */
  firstIndex: number
  /** Total tokens saved, when node prices are known. */
  tokensSaved?: number
}
