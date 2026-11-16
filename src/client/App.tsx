import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { buildTree, type Branch, type Turn } from '../core/tree.ts'
import { ApiError, type ClientView, type SacredApi } from './api.ts'
import { ContextBar } from './ContextBar.tsx'
import { makeT, detectLang, storeLang, type Key, type Lang, type T } from './i18n.ts'
import { fmtTokens, Timeline, type Selection } from './timeline/Timeline.tsx'
import logoDark from '../../assets/brand/logo-dark-96.webp'
import logoLight from '../../assets/brand/logo-light-96.webp'

export interface AppProps {
  api: SacredApi
  sessionId?: string
  /** Initial language; the user can switch it from the header (persisted). */
  lang?: Lang
  onLangChange?: (lang: Lang) => void
  /** Poll interval for live sessions; 0 disables (demo). */
  pollMs?: number
}

const CUT_MS = 1100
const GITHUB = 'https://github.com/MingoZhou/dsh-sacred'
const GITHUB_PATH = 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z'

export function SacredApp({ api, sessionId, lang: initialLang, onLangChange, pollMs = 4000 }: AppProps): React.ReactElement {
  const [lang, setLangState] = useState<Lang>(initialLang ?? detectLang())
  useEffect(() => { if (initialLang) setLangState(initialLang) }, [initialLang])
  const setLang = useCallback((l: Lang) => { setLangState(l); storeLang(l); onLangChange?.(l) }, [onLangChange])
  const t = useMemo(() => makeT(lang), [lang])
  const [view, setView] = useState<ClientView | null>(null)
  const [error, setError] = useState<{ message: string; code?: string } | null>(null)
  const [selected, setSelected] = useState<Selection>(null)
  const [cutting, setCutting] = useState<ReadonlySet<number>>(new Set())
  const [preview, setPreview] = useState<number | undefined>(undefined)
  const [toast, setToast] = useState<string | null>(null)
  const busyRef = useRef(false)

  const flash = useCallback((msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 2800)
  }, [])

  const load = useCallback(async () => {
    if (!sessionId || busyRef.current) return
    try {
      setView(await api.view(sessionId))
      setError(null)
    } catch (e) {
      setError({ message: e instanceof Error ? e.message : String(e), ...(e instanceof ApiError && e.code ? { code: e.code } : {}) })
    }
  }, [api, sessionId])

  useEffect(() => {
    setView(null)
    setSelected(null)
    void load()
    if (!pollMs) return
    const id = window.setInterval(() => { if (document.visibilityState === 'visible') void load() }, pollMs)
    return () => window.clearInterval(id)
  }, [load, pollMs])

  const run = useCallback(async (fn: () => Promise<{ view: ClientView }>, done?: (r: { view: ClientView }) => string) => {
    busyRef.current = true
    try {
      const r = await fn()
      setView(r.view)
      if (done) flash(done(r))
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e))
    } finally {
      busyRef.current = false
    }
  }, [flash])

  const prune = useCallback(async (seqs?: number[], manual = false) => {
    if (!sessionId || !view) return
    const targets = seqs ?? view.plan.items.map((i) => i.seq)
    if (targets.length === 0) return
    busyRef.current = true
    setPreview(undefined)
    setCutting(new Set(targets))
    await new Promise((r) => window.setTimeout(r, CUT_MS))
    setCutting(new Set())
    await run(() => api.prune(sessionId, seqs, manual), (r) => {
      const res = r as unknown as { pruned: number; savedTokens?: number }
      return t('toast.pruned', { n: res.pruned, tokens: fmtTokens(res.savedTokens ?? 0) })
    })
  }, [api, run, sessionId, t, view])

  const tree = useMemo(() => (view ? buildTree(view) : null), [view])

  const tools = (
    <div className="sac-tools">
      <button className="sac-iconbtn sac-lang" onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')} title={t('lang.toggle')} aria-label={t('lang.toggle')}>
        {lang === 'zh' ? 'EN' : '中'}
      </button>
      <a className="sac-iconbtn" href={GITHUB} target="_blank" rel="noreferrer" title="GitHub" aria-label="GitHub">
        <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d={GITHUB_PATH} /></svg>
      </a>
    </div>
  )
  const head = <header className="sac-head"><Title t={t} />{tools}</header>

  if (!sessionId) return <Shell>{head}<Empty text={t('empty.session')} /></Shell>
  if (error && !view) {
    return (
      <Shell>
        {head}
        <div className="sac-empty">
          <p className="sac-error">{error.code === 'host-missing' ? t('error.host') : t('error', { error: error.message })}</p>
          <p className="sac-muted">{error.code === 'host-missing' ? t('error.hostHint') : error.code === 'not-live' ? t('error.liveHint') : t('error.hint')}</p>
          <button className="sac-btn" onClick={() => void load()}>{t('retry')}</button>
        </div>
      </Shell>
    )
  }
  if (!view || !tree) return <Shell>{head}<div className="sac-loading"><span />{t('loading')}</div></Shell>

  const { turns, totals } = tree
  const plan = view.plan
  const allBranches = turns.flatMap((x) => x.branches)
  const branch = selected?.type === 'branch' ? allBranches.find((b) => b.key === selected.key) : undefined
  const turn = selected?.type === 'turn' ? turns[selected.index] : undefined
  const disabled = view.busy === true || cutting.size > 0
  const total = Math.max(1, view.context.totalTokens)
  const top = allBranches
    .filter((b) => b.status !== 'pruned' && b.status !== 'pinned' && b.resultSeq !== undefined)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 6)
  const select = (b: Branch) => setSelected({ type: 'branch', key: b.key })
  const pinSeq = (seq: number) => void run(() => api.pin(sessionId, seq), () => t('toast.pinned'))
  const unpinSeq = (seq: number) => void run(() => api.unpin(sessionId, seq), () => t('toast.unpinned'))
  const restoreSeq = (seq: number) => void run(() => api.restore(sessionId, seq), () => t('toast.restored'))

  const cta = (
    <button className="sac-prune-btn" disabled={disabled || plan.items.length === 0} onClick={() => void prune()}
      onMouseEnter={() => setPreview(undefined)}>
      <span className="sac-shears">✂</span>
      {cutting.size > 0 ? t('cta.pruning')
        : plan.items.length === 0 ? t('cta.clean')
          : t('cta.prune', { n: plan.items.length, tokens: fmtTokens(totals.savingTokens) })}
    </button>
  )

  return (
    <Shell>
      {head}
      {view.busy && <div className="sac-banner">{t('busy')}</div>}
      <ContextBar context={view.context} t={t} action={cta} {...(preview !== undefined ? { previewTokens: preview } : {})} />
      <div className="sac-main">
        <div className="sac-stage">
          <div className="sac-legend">
            <span className="is-healthy">{t('legend.healthy')}</span>
            <span className="is-anomaly">{t('legend.anomaly')}</span>
            <span className="is-pinned">{t('legend.pinned')}</span>
            <span className="is-pruned">{t('legend.pruned')}</span>
            <span className="sac-legend-hint">{t('legend.hint')}</span>
          </div>
          {turns.length === 0
            ? <Empty text={t('empty.tree')} />
            : <Timeline turns={turns} {...(view.context.contextWindow ? { contextWindow: view.context.contextWindow } : {})}
                selected={selected} cutting={cutting} onSelect={setSelected} t={t} />}
        </div>

        <aside className="sac-side">
          {(branch || turn) && (
            <section className="sac-card sac-detail-card">
              <button className="sac-close" onClick={() => setSelected(null)} aria-label={t('close')}>×</button>
              {branch ? <BranchDetail b={branch} t={t} disabled={disabled} share={branch.tokens / total}
                onPrune={() => branch.resultSeq !== undefined && void prune([branch.resultSeq], branch.status !== 'anomaly')}
                onPin={() => branch.resultSeq !== undefined && pinSeq(branch.resultSeq)}
                onUnpin={() => branch.resultSeq !== undefined && unpinSeq(branch.resultSeq)}
                onRestore={() => branch.resultSeq !== undefined && restoreSeq(branch.resultSeq)} />
                : turn ? <TurnDetail turn={turn} t={t} disabled={disabled} share={turn.tokens / total}
                  onPin={() => turn.userSeq !== undefined && pinSeq(turn.userSeq)}
                  onUnpin={() => turn.userSeq !== undefined && unpinSeq(turn.userSeq)} /> : null}
            </section>
          )}

          <section className="sac-card">
            <h3>{t('suggest.title')} <small>{plan.items.length}</small></h3>
            {plan.items.length === 0 ? (
              <>
                <p className="sac-muted">{t('suggest.empty')}</p>
                <p className="sac-muted sac-note">{t('suggest.emptyWhy')}</p>
              </>
            ) : (
              <ul className="sac-list">
                {plan.items.map((i) => {
                  const b = allBranches.find((x) => x.resultSeq === i.seq)
                  return (
                    <li key={i.seq} onMouseEnter={() => setPreview(i.tokensSaved ?? 0)} onMouseLeave={() => setPreview(undefined)}
                      onClick={() => b && select(b)}>
                      <div>
                        <span className="sac-li-title"><code>{i.toolName}</code>{b?.label ?? i.path ?? `#${i.seq}`}</span>
                        <em>{t(`reason.${i.reason}` as Key)}</em>
                      </div>
                      <b className="is-red">−{fmtTokens(i.tokensSaved ?? 0)}</b>
                      <button disabled={disabled} onClick={(e) => { e.stopPropagation(); void prune([i.seq]) }}>{t('act.prune')}</button>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          <section className="sac-card">
            <h3>{t('top.title')}</h3>
            <p className="sac-muted sac-note-top">{t('top.hint')}</p>
            <ul className="sac-list">
              {top.map((b) => (
                <li key={b.key} onClick={() => select(b)}>
                  <div>
                    <span className="sac-li-title"><code>{b.toolName}</code>{b.label}</span>
                    <span className="sac-li-bar"><i style={{ width: `${Math.max(2, (b.tokens / Math.max(1, top[0]!.tokens)) * 100)}%` }} /></span>
                  </div>
                  <b>{fmtTokens(b.tokens)}<small>{Math.max(0.1, (b.tokens / total) * 100).toFixed(1)}%</small></b>
                  <button disabled={disabled} onClick={(e) => { e.stopPropagation(); void prune([b.resultSeq!], b.status !== 'anomaly') }}>{t('act.drop')}</button>
                </li>
              ))}
            </ul>
          </section>

          <section className="sac-card sac-void">
            <h3>{t('void.title')} <small>{view.void.length}</small></h3>
            {view.void.length === 0 ? <p className="sac-muted">{t('void.empty')}</p> : (
              <>
                <p className="sac-muted sac-void-hint">{t('void.hint')}</p>
                <ul className="sac-list">
                  {view.void.map((v) => (
                    <li key={v.replacementSeq}>
                      <div>
                        <span className="sac-li-title"><code>{v.toolName ?? 'tool'}</code>{v.label ?? `#${v.originalSeq}`}</span>
                        <em>{t(`reason.${v.reason}` as Key)}</em>
                      </div>
                      <button disabled={disabled} onClick={() => restoreSeq(v.replacementSeq)}>{t('act.restore')}</button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        </aside>
      </div>
      {toast && <div className="sac-toast">{toast}</div>}
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="sac-root">{children}</div>
}

function Title({ t }: { t: T }): React.ReactElement {
  return (
    <div className="sac-brand">
      <a className="sac-logo" href={GITHUB} target="_blank" rel="noreferrer" aria-label="dsh-sacred">
        <img className="sac-logo-light" src={logoLight} alt="" width={40} height={40} />
        <img className="sac-logo-dark" src={logoDark} alt="" width={40} height={40} />
      </a>
      <div className="sac-titles">
        <h1 className="sac-title">{t('title')}</h1>
        <p className="sac-sub">{t('subtitle')}</p>
      </div>
    </div>
  )
}

function Empty({ text }: { text: string }): React.ReactElement {
  return <div className="sac-empty"><p>{text}</p></div>
}

function Badge({ status, t }: { status: Branch['status']; t: T }): React.ReactElement {
  return <span className={`sac-badge is-${status}`}>{t(`status.${status}` as Key)}</span>
}

function BranchDetail({ b, t, disabled, share, onPrune, onPin, onUnpin, onRestore }: {
  b: Branch; t: T; disabled: boolean; share: number
  onPrune: () => void; onPin: () => void; onUnpin: () => void; onRestore: () => void
}): React.ReactElement {
  const reason = b.plan?.reason ?? b.prunedReason
  return (
    <div className="sac-detail">
      <div className="sac-detail-head">
        <code>{b.toolName}</code>
        <Badge status={b.status} t={t} />
      </div>
      <div className="sac-detail-path" title={b.path ?? b.label}>{b.path ?? b.label}</div>
      <div className="sac-detail-meta">
        <span><b>{fmtTokens(b.tokens)}</b> tokens</span>
        <span>{t('detail.share', { n: (share * 100).toFixed(1) })}</span>
        {b.resultSeq !== undefined && <span>seq {b.resultSeq}</span>}
      </div>
      {reason && <p className={`sac-reason is-${b.status}`}>{t(`reason.${reason}` as Key)}</p>}
      <h4>{t('detail.output')}</h4>
      <pre className="sac-pre">{b.preview || '—'}</pre>
      <div className="sac-actions">
        {b.status === 'anomaly' && <button className="is-red" disabled={disabled} onClick={onPrune}>✂ {t('act.prune')}</button>}
        {(b.status === 'healthy' || b.status === 'error') && <button className="is-red" disabled={disabled} onClick={onPrune}>✂ {t('act.drop')}</button>}
        {b.status === 'pruned' && <button disabled={disabled} onClick={onRestore}>↺ {t('act.restore')}</button>}
        {b.status === 'pinned'
          ? <button disabled={disabled} onClick={onUnpin}>{t('act.unpin')}</button>
          : b.status !== 'pruned' && <button className="is-gold" disabled={disabled} onClick={onPin}>◆ {t('act.pin')}</button>}
      </div>
    </div>
  )
}

function TurnDetail({ turn, t, disabled, share, onPin, onUnpin }: {
  turn: Turn; t: T; disabled: boolean; share: number; onPin: () => void; onUnpin: () => void
}): React.ReactElement {
  return (
    <div className="sac-detail">
      <div className="sac-detail-head">
        <code>{turn.userSeq === undefined ? t('turn.system') : t('turn', { n: turn.index + 1 })}</code>
        {turn.userPinned && <Badge status="pinned" t={t} />}
      </div>
      <div className="sac-detail-meta">
        <span><b>{fmtTokens(turn.tokens)}</b> tokens</span>
        <span>{t('detail.share', { n: (share * 100).toFixed(1) })}</span>
        <span>{t('detail.calls', { n: turn.branches.length })}</span>
      </div>
      <h4>{t('detail.prompt')}</h4>
      <pre className="sac-pre sac-pre-prompt">{turn.userText || '—'}</pre>
      {turn.replyText && <><h4>{t('detail.reply')}</h4><pre className="sac-pre">{turn.replyText}</pre></>}
      {turn.userSeq !== undefined && (
        <div className="sac-actions">
          {turn.userPinned
            ? <button disabled={disabled} onClick={onUnpin}>{t('act.unpin')}</button>
            : <button className="is-gold" disabled={disabled} onClick={onPin}>◆ {t('act.pin')}</button>}
        </div>
      )}
      <p className="sac-muted sac-note">{t('pin.note')}</p>
    </div>
  )
}
