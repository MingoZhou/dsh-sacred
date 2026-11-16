/**
 * dsh-sacred — browser half.
 *
 * Registers a 「上下文裁剪 / Context Pruning」 tab (`conversation.view` slot) next to 对话 / 轨迹,
 * fed by the host's /sacred/api routes.
 */
import React from 'react'
import { HttpSacredApi } from './api.ts'
import { SacredApp } from './App.tsx'
import { detectLang, makeT } from './i18n.ts'
// esbuild loads .css as text
import cssText from './styles.css'

export const name = 'dsh-sacred'
export const inject = ['slots']

interface SlotRegistryLike {
  inject: (key: string, callback: () => unknown) => void
  register: (options: Record<string, unknown>, component: unknown) => () => void
}

interface ClientContextLike {
  slots: SlotRegistryLike
  effect: (callback: () => () => void, label?: string) => void
}

const api = new HttpSacredApi()

function WorldTreeTab(props: { sessionId?: string }): React.ReactElement {
  return React.createElement(SacredApp, { api, ...(props.sessionId ? { sessionId: props.sessionId } : {}) })
}

export function apply(ctx: ClientContextLike): void {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset['plugin'] = 'dsh-sacred'
    style.textContent = cssText
    document.head.append(style)
    return () => style.remove()
  }, 'dsh-sacred: styles')

  const t = makeT(detectLang())
  ctx.slots.inject('conversation.view', () =>
    ctx.slots.register(
      { name: 'conversation.view', id: 'sacred', order: 70, label: t('tab') },
      WorldTreeTab,
    ),
  )
}
