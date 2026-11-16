/**
 * A realistic sample session: fixing a token-refresh bug, with the usual
 * stale reads, duplicate greps and failed test runs left behind.
 * Built as an in-memory session with dsh's surface/replace semantics, so the
 * demo runs the real SacredEngine.
 */
import type { MessageLike, SessionEventLike, SessionLike } from '../src/host-types.ts'

export class DemoSession implements SessionLike {
  readonly id: string
  private readonly log: SessionEventLike[] = []
  readonly surface = { nodes: [] as number[] }
  constructor(id: string) { this.id = id }
  eventAt(seq: number) { return this.log[seq - 1] }
  deriveEventMessage(e: SessionEventLike): MessageLike { return e.data.message! }
  append(type: string, data: Record<string, unknown>, options?: { surfaceOp?: { op: 'replace'; startSeq: number; endSeq: number } }) {
    const seq = this.log.length + 1
    this.log.push({ seq, type, data })
    if (data['message'] !== undefined) {
      const op = options?.surfaceOp
      if (op) this.surface.nodes[this.surface.nodes.indexOf(op.startSeq)] = seq
      else this.surface.nodes.push(seq)
    }
    return { seq }
  }
}

const TOKEN_TS = `import { db } from '../db'
import { sign, verify } from './jwt'
import type { Session, TokenPair } from './types'

export const ACCESS_TTL = 15 * 60 // seconds
export const REFRESH_TTL = 30 * 24 * 60 * 60 // seconds

/** Issue a fresh access/refresh pair for a session. */
export async function issueTokens(session: Session): Promise<TokenPair> {
  const now = Date.now()
  const access = await sign({ sid: session.id, uid: session.userId, exp: now + ACCESS_TTL })
  const refresh = await sign({ sid: session.id, kind: 'refresh', exp: now + REFRESH_TTL })
  await db.sessions.update(session.id, { refreshHash: hash(refresh), rotatedAt: now })
  return { access, refresh, expiresAt: now + ACCESS_TTL }
}

/** True when the access token expires within the grace window. */
export function needsRefresh(expiresAt: number, graceMs = 30_000): boolean {
  return expiresAt - Date.now() < graceMs
}

export async function refreshTokens(refreshToken: string): Promise<TokenPair> {
  const claims = await verify(refreshToken)
  if (claims.kind !== 'refresh') throw new AuthError('wrong token kind')
  if (claims.exp < Date.now() / 1000) throw new AuthError('refresh expired')
  const session = await db.sessions.get(claims.sid)
  if (!session || session.refreshHash !== hash(refreshToken)) {
    await revokeFamily(claims.sid)
    throw new AuthError('refresh reuse detected')
  }
  return issueTokens(session)
}
`.repeat(3)

const SESSION_TS = `import { db } from '../db'
import { refreshTokens, needsRefresh } from './token'

export async function withSession<T>(req: Request, fn: (s: Session) => Promise<T>): Promise<T> {
  const auth = parseAuthHeader(req.headers.get('authorization'))
  let session = await db.sessions.byAccess(auth.access)
  if (session && needsRefresh(session.expiresAt)) {
    const pair = await refreshTokens(auth.refresh)
    session = { ...session, ...pair }
  }
  if (!session) throw new HttpError(401, 'session expired')
  return fn(session)
}
`.repeat(4)

const GREP = Array.from({ length: 34 }, (_, i) => `src/${['auth/token.ts', 'auth/session.ts', 'api/login.ts', 'api/me.ts', 'client/http.ts', 'client/retry.ts'][i % 6]}:${12 + i * 7}:  ${['const pair = await refreshTokens(auth.refresh)', 'export async function refreshTokens(refreshToken: string)', 'if (res.status === 401) return refreshTokens(store.refresh)', "throw new AuthError('refresh expired')", 'refreshToken: string', 'scheduleRefresh(pair.expiresAt)'][i % 6]}`).join('\n')

const FAIL_1 = `FAIL  tests/auth/token.test.ts
  ● refreshTokens › rejects an expired refresh token

    expect(received).rejects.toThrow()

    Received promise resolved instead of rejected
    Resolved to value: {"access":"eyJhbGciOi…","refresh":"eyJhbGciOi…","expiresAt":1763290127412}

      41 |   it('rejects an expired refresh token', async () => {
      42 |     const t = await sign({ sid: 's1', kind: 'refresh', exp: Date.now() - 1000 })
    > 43 |     await expect(refreshTokens(t)).rejects.toThrow('refresh expired')
         |                                    ^
      44 |   })

      at Object.<anonymous> (tests/auth/token.test.ts:43:36)
${'      at processTicksAndRejections (node:internal/process/task_queues:105:5)\n'.repeat(6)}
Tests:       1 failed, 11 passed, 12 total
Time:        3.214 s`

const FAIL_2 = `FAIL  tests/auth/session.test.ts
  ● withSession › refreshes when access token is about to expire

    TypeError: Cannot read properties of undefined (reading 'refresh')

      at withSession (src/auth/session.ts:7:42)
      at Object.<anonymous> (tests/auth/session.test.ts:28:11)
${'      at runTest (node_modules/jest-circus/build/run.js:316:16)\n'.repeat(8)}
  ● withSession › keeps the old pair when refresh is not needed
    Jest worker encountered 4 child process exceptions, exceeding retry limit

Tests:       2 failed, 14 passed, 16 total
Time:        4.087 s`

let counter = 0
const id = () => `call_${++counter}`

export function buildSample(): { session: DemoSession; pinnedPrompt: number } {
  counter = 0
  const s = new DemoSession('demo-token-refresh')
  const user = (text: string) => s.append('user/message', { message: { role: 'user', content: [{ type: 'text', text }] } }).seq
  const say = (text: string) => s.append('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text }] } })
  const tool = (name: string, args: object, output: string, isError = false) => {
    const callId = id()
    s.append('assistant/message', { message: { role: 'assistant', content: [{ type: 'tool-call', id: callId, name, arguments: JSON.stringify(args) }] } })
    s.append('tool/result', { message: { role: 'tool', toolCallId: callId, isError, content: [{ type: 'text', text: output }] } })
  }

  const pinnedPrompt = user('登录接口偶尔返回 401，帮我查一下 token 刷新逻辑。\n约束：不能改数据库 schema，对外 API 必须保持兼容。')
  tool('glob', { pattern: 'src/auth/**/*.ts' }, 'src/auth/jwt.ts\nsrc/auth/session.ts\nsrc/auth/token.ts\nsrc/auth/types.ts')
  tool('grep', { pattern: 'refreshToken', path: 'src' }, GREP)
  tool('read', { file_path: 'src/auth/token.ts' }, TOKEN_TS)
  tool('read', { file_path: 'src/auth/session.ts' }, SESSION_TS)
  tool('grep', { path: 'src', pattern: 'refreshToken' }, GREP)
  say('找到了：`issueTokens` 里 `exp` 用的是毫秒（Date.now()），而 `refreshTokens` 把它当秒来比较，所以刷新令牌几乎永远不会被判过期；另一边 access 的 `exp` 又被 JWT 库当成秒，导致它提前很多失效，于是偶发 401。')

  user('好，直接修复，然后把测试跑通。')
  tool('edit', { file_path: 'src/auth/token.ts', old_string: 'exp: now + ACCESS_TTL', new_string: 'exp: Math.floor(now / 1000) + ACCESS_TTL' }, 'Edited src/auth/token.ts (1 replacement)')
  tool('bash', { command: 'pnpm test auth' }, FAIL_1, true)
  tool('read', { file_path: 'src/auth/token.ts' }, TOKEN_TS.replace('exp: now + ACCESS_TTL', 'exp: Math.floor(now / 1000) + ACCESS_TTL'))
  tool('edit', { file_path: 'src/auth/token.ts', old_string: 'exp: now + REFRESH_TTL', new_string: 'exp: Math.floor(now / 1000) + REFRESH_TTL' }, 'Edited src/auth/token.ts (1 replacement)')
  tool('bash', { command: 'pnpm test auth' }, FAIL_2, true)
  tool('edit', { file_path: 'src/auth/session.ts', old_string: 'auth.refresh', new_string: 'auth.refresh ?? session.refresh' }, 'Edited src/auth/session.ts (1 replacement)')
  tool('bash', { command: 'pnpm test auth -- --runInBand' }, 'PASS  tests/auth/token.test.ts\nPASS  tests/auth/session.test.ts\n\nTests:       16 passed, 16 total\nTime:        3.902 s')
  say('修好了：access / refresh 的 `exp` 统一成秒；session.ts 在请求没带 refresh 时回退到会话里存的那份。16 个测试全部通过。')

  user('顺便给 refresh 流程补几个单元测试，覆盖令牌复用检测。')
  tool('read', { file_path: 'tests/auth/token.test.ts' }, "import { refreshTokens } from '../../src/auth/token'\n\ndescribe('refreshTokens', () => {\n  it('rejects an expired refresh token', async () => { /* … */ })\n})\n".repeat(6))
  tool('write', { file_path: 'tests/auth/token.test.ts', content: '…' }, 'Wrote tests/auth/token.test.ts (128 lines)')
  tool('bash', { command: 'pnpm test auth' }, 'PASS  tests/auth/token.test.ts\nPASS  tests/auth/session.test.ts\n\nTests:       21 passed, 21 total')
  tool('read', { file_path: 'docs/auth.md' }, '# Auth\n\nAccess tokens live 15 minutes; refresh tokens rotate on every use and a reused refresh token revokes the whole family.\n'.repeat(4))
  say('新增 5 个用例：过期、类型错误、复用检测会吊销整个令牌族、轮换后旧令牌失效、宽限窗口内主动刷新。21 个测试全部通过。')

  return { session: s, pinnedPrompt }
}
