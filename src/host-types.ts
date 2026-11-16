/**
 * Minimal structural views of the dsh host objects this plugin touches,
 * mirroring `@deepseek-ai/dsh-session`, `dsh-llm` and `dsh-compaction`
 * (DSH 0.2.x). Kept local — like dsh-replay's `*Like` interfaces — so the
 * plugin builds without the harness workspace.
 */

export interface TextBlock { type: 'text'; text: string }
export interface ToolCallBlockLike { type: 'tool-call'; id: string; name: string; arguments: string }
export type ContentBlockLike = TextBlock | ToolCallBlockLike | { type: string; [k: string]: unknown }

export interface MessageLike {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool'
  content: readonly ContentBlockLike[]
  toolCallId?: string
  isError?: boolean
  [k: string]: unknown
}

export interface SessionEventLike {
  seq: number
  type: string
  data: { message?: MessageLike; [k: string]: unknown }
}

export interface SessionLike {
  readonly id?: string
  readonly surface: { readonly nodes: readonly number[] }
  eventAt(seq: number): SessionEventLike | undefined
  deriveEventMessage(event: SessionEventLike): MessageLike
  append(
    type: string,
    data: Record<string, unknown>,
    options?: { surfaceOp?: { op: 'replace'; startSeq: number; endSeq: number }; sourceEventSeqs?: number[] },
  ): { seq: number }
  /** Latest durable request header (dsh Session); its config names the routed model. */
  requestHeader?(): { config: { provider: string; model: string; maxTokens?: number } } | undefined
}

export interface AgentLike { session: SessionLike }

export interface TokenMeterLike { estimateMessage(message: MessageLike): number }

export interface CompactionLike {
  compactRegion(start: number, end: number, agent: AgentLike, signal?: AbortSignal): Promise<{
    summarySeq: number
    shadowedSeqs: number[]
    shadowedTokenCount: number
  }>
}

export type CommandResult = { kind: 'success' | 'error'; text: string; sourceEventSeq?: number }

export interface CommandInvocation {
  agent: AgentLike
  rawInput: string
  signal: AbortSignal
}

export interface CommandsLike {
  register(def: { definitionId: string; name: string; description: string; handler: (i: CommandInvocation) => Promise<CommandResult> }): () => void
}

export interface LoggerLike { info(msg: string): void; warn(msg: string): void }

export interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void>
  }): () => void
}

export type LiveAgentLike = AgentLike & { status?: 'idle' | 'running' }

/** `ctx.sessionController` (dsh-session-controller): resolves or resumes the live agent of a session. */
export interface SessionControllerLike {
  resolveAgent(sessionId: string): Promise<{ agent: LiveAgentLike } | { error: unknown }>
}

export interface ContextLike {
  commands: CommandsLike
  logger?: LoggerLike
  /** Cordis: read a service without declaring it in `inject`. */
  get?(name: string, strict?: boolean): unknown
  on(
    event: 'agent/pre-step',
    listener: (payload: { agent: AgentLike; signal: AbortSignal }, next: () => Promise<unknown>) => Promise<unknown>,
    options?: { prepend?: boolean },
  ): () => void
  webServer: WebServerLike
  effect(fn: () => Generator<unknown, void, unknown> | (() => void), label?: string): void
}
