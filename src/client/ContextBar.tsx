/** Context budget: used / remaining / where it goes / what pruning frees. */
import React from 'react'
import type { ContextStats } from '../engine.ts'
import type { T } from './i18n.ts'
import { fmtTokens } from './timeline/Timeline.tsx'

interface Props {
  context: ContextStats
  t: T
  /** Hovering a suggestion previews only its savings. */
  previewTokens?: number
  action: React.ReactNode
}

const SEGMENTS = [
  ['system', 'ctx.system'],
  ['overhead', 'ctx.overhead'],
  ['user', 'ctx.user'],
  ['assistant', 'ctx.assistant'],
  ['tool', 'ctx.tool'],
] as const

export function ContextBar({ context: c, t, previewTokens, action }: Props): React.ReactElement {
  const used = c.totalTokens
  const window = c.contextWindow
  const scale = window ?? Math.max(used * 1.25, 1)
  const pct = (n: number) => `${Math.max(0, Math.min(100, (n / scale) * 100))}%`
  const prunable = previewTokens ?? c.prunableTokens
  const after = Math.max(0, used - prunable)
  const reserved = window ? Math.min(c.reservedOutputTokens, Math.max(0, window - used)) : 0
  const remaining = window ? Math.max(0, window - used - reserved) : undefined
  const usage = window ? used / window : undefined
  const threshold = window ? window * c.thresholdRatio : undefined
  const level = usage === undefined ? 'ok' : usage >= c.thresholdRatio ? 'hot' : usage >= c.thresholdRatio * 0.75 ? 'warm' : 'ok'
  // the prunable slice sits at the end of the tool-output segment
  const toolEnd = c.breakdown.system + c.breakdown.overhead + c.breakdown.user + c.breakdown.assistant + c.breakdown.tool

  return (
    <section className="sac-ctx">
      <div className="sac-ctx-top">
        <div className="sac-ctx-figure">
          <span className="sac-ctx-label">{t('ctx.title')}{c.measured ? '' : ` · ${t('ctx.estimated')}`}</span>
          <div className="sac-ctx-numbers">
            <b>{fmtTokens(used)}</b>
            {window ? <span>/ {fmtTokens(window)} tokens</span> : <span>tokens</span>}
            {usage !== undefined && <em className={`is-${level}`}>{Math.round(usage * 100)}%</em>}
            {c.model && <i>{c.model}</i>}
          </div>
          <div className="sac-ctx-sub">
            {remaining !== undefined && <span>{t('ctx.remaining', { n: fmtTokens(remaining) })}</span>}
            {threshold !== undefined && <span>{used < threshold ? t('ctx.untilCompact', { n: fmtTokens(threshold - used) }) : t('ctx.overCompact')}</span>}
            {c.savedTokens > 0 && <span className="is-good">{t('ctx.saved', { n: fmtTokens(c.savedTokens) })}</span>}
          </div>
        </div>
        <div className="sac-ctx-action">{action}</div>
      </div>

      <div className="sac-bar" role="img" aria-label={`${fmtTokens(used)} / ${window ? fmtTokens(window) : '?'}`}>
        <div className="sac-bar-track">
          {SEGMENTS.map(([k]) => (
            <span key={k} className={`sac-bar-seg is-${k}`} style={{ width: pct(c.breakdown[k]) }} />
          ))}
          {reserved > 0 && <span className="sac-bar-seg is-reserved" style={{ width: pct(reserved) }} />}
        </div>
        {prunable > 0 && (
          <span className="sac-bar-prunable" style={{ left: pct(toolEnd - prunable), width: pct(prunable) }} />
        )}
        {threshold !== undefined && (
          <span className="sac-bar-mark is-threshold" style={{ left: pct(threshold) }}>
            <i>{t('ctx.compactAt', { n: Math.round(c.thresholdRatio * 100) })}</i>
          </span>
        )}
        {prunable > 0 && (
          <span className="sac-bar-mark is-after" style={{ left: pct(after) }}>
            <i>{t('ctx.after', { n: fmtTokens(after) })}</i>
          </span>
        )}
      </div>

      <div className="sac-ctx-legend">
        {SEGMENTS.map(([k, label]) => (
          <span key={k} className={`is-${k}`}>{t(label)} <b>{fmtTokens(c.breakdown[k])}</b></span>
        ))}
        {reserved > 0 && <span className="is-reserved">{t('ctx.reserved')} <b>{fmtTokens(reserved)}</b></span>}
        {prunable > 0 && <span className="is-prunable">{t('ctx.prunable')} <b>−{fmtTokens(prunable)}</b></span>}
      </div>
    </section>
  )
}
