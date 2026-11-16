/** Standalone demo: the real SacredEngine running on an in-browser sample session. */
import React, { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { heuristicTokens, MemoryStore, SacredEngine, type Meter } from '../src/engine.ts'
import type { ClientView, SacredApi } from '../src/client/api.ts'
import { SacredApp } from '../src/client/App.tsx'
import type { Lang } from '../src/client/i18n.ts'
import cssText from '../src/client/styles.css'
import { buildSample, type DemoSession } from './sample.ts'

class DemoApi implements SacredApi {
  private readonly engine = new SacredEngine({ store: new MemoryStore() })
  private readonly session: DemoSession
  constructor(pinned: boolean) {
    const { session, pinnedPrompt } = buildSample()
    this.session = session
    if (pinned) this.engine.pin(session, pinnedPrompt)
  }
  /** Stand-in for dsh's tokenMeter: heuristic prices plus a system prompt and tool schemas. */
  private meter(): Meter {
    let sum = 0
    for (const seq of this.session.surface.nodes) {
      const m = this.session.deriveEventMessage(this.session.eventAt(seq)!)
      for (const b of m.content) sum += b.type === 'text' ? heuristicTokens((b as { text: string }).text) : heuristicTokens(String((b as { arguments?: string }).arguments ?? ''))
    }
    return { totalTokens: sum + 6400, contextWindow: 32_000, thresholdRatio: 0.8, reservedOutputTokens: 4000, model: 'deepseek-v4-flash' }
  }
  private v(): ClientView {
    const view = this.engine.view(this.session, this.meter())
    // the demo has no separate system node: book the fixed prompt as "system"
    view.context.breakdown.system += 2400
    view.context.breakdown.overhead -= 2400
    return view
  }
  async view() { return this.v() }
  async prune(_: string, seqs?: number[], manual?: boolean) {
    const plan = manual && seqs ? this.engine.manualPlan(this.session, seqs) : this.engine.plan(this.session, seqs ? new Set(seqs) : undefined)
    const p = this.engine.prune(this.session, plan)
    return { pruned: p.items.length, saved: p.charsBefore - p.charsAfter, savedTokens: p.tokensSaved ?? 0, view: this.v() }
  }
  async pin(_: string, seq: number) { this.engine.pin(this.session, seq); return { view: this.v() } }
  async unpin(_: string, seq: number) { this.engine.unpin(this.session, seq); return { view: this.v() } }
  async restore(_: string, seq: number) { this.engine.restore(this.session, seq); return { view: this.v() } }
}

const params = new URLSearchParams(location.search)

function Demo(): React.ReactElement {
  const [lang, setLang] = useState<Lang>(params.get('lang') === 'en' ? 'en' : 'zh')
  const [theme, setTheme] = useState<'light' | 'dark'>(params.get('theme') === 'dark' ? 'dark' : 'light')
  const [gen, setGen] = useState(0)
  const api = useMemo(() => new DemoApi(true), [gen])
  const zh = lang === 'zh'
  return (
    <div className="demo-shell" data-theme={theme}>
      <div className="demo-top">
        <div className="demo-title">{zh ? '修复登录接口 401（示例会话）' : 'Fix login 401 (sample session)'}</div>
        <span className="demo-spacer" />
        <button onClick={() => setGen((g) => g + 1)}>{zh ? '重置示例' : 'Reset'}</button>
        <button onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}>{theme === 'light' ? (zh ? '深色' : 'Dark') : (zh ? '浅色' : 'Light')}</button>
      </div>
      <div className="demo-tabs">
        <span>{zh ? '对话' : 'Chat'}</span>
        <span>{zh ? '轨迹' : 'Trace'}</span>
        <span>Replay</span>
        <span className="is-active">{zh ? '上下文裁剪' : 'Context Pruning'}</span>
      </div>
      <div className="demo-body">
        <SacredApp key={gen} api={api} sessionId="demo-token-refresh" lang={lang} onLangChange={setLang} pollMs={0} />
      </div>
      <div className="demo-foot">
        {zh
          ? 'dsh-sacred 在线演示：示例会话，浏览器里运行的是真实的裁剪引擎，不需要安装 DSH'
          : 'dsh-sacred live demo: a sample session running the real pruning engine in your browser, no harness required'}
      </div>
    </div>
  )
}

const style = document.createElement('style')
style.textContent = cssText + `
html, body, #root { height: 100%; margin: 0; }
body { font-family: ui-sans-serif, system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif; }
.demo-shell { --bg: #ffffff; --ink: #0e1116; --ink3: #6f7786; --line: rgba(0,0,0,.08); --btn: #ffffff;
  height: 100%; display: flex; flex-direction: column; background: var(--bg); color: var(--ink); }
.demo-shell[data-theme='dark'] { --bg: #16171a; --ink: #f2f3f5; --ink3: #8b919d; --line: rgba(255,255,255,.08); --btn: #1f2125; }
.demo-top { display: flex; align-items: center; gap: 8px; padding: 12px 24px 4px; }
.demo-title { font-size: 14px; font-weight: 500; }
.demo-spacer { flex: 1; }
.demo-top button { font: inherit; font-size: 12px; color: var(--ink); background: var(--btn); border: 1px solid var(--line); border-radius: 7px; height: 28px; padding: 0 10px; cursor: pointer; }
.demo-tabs { display: flex; gap: 26px; padding: 0 24px; border-bottom: 1px solid var(--line); font-size: 13px; color: var(--ink3); }
.demo-tabs span { padding: 10px 0 9px; }
.demo-tabs .is-active { color: #3b6fe0; box-shadow: inset 0 -2px #3b6fe0; }
.demo-body { flex: 1; min-height: 0; }
.demo-foot { padding: 7px 24px; font-size: 11px; color: var(--ink3); border-top: 1px solid var(--line); }
`
document.head.append(style)
createRoot(document.getElementById('root')!).render(<Demo />)
