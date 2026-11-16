/**
 * EN / 中文 for the 上下文裁剪 tab.
 * Language resolution: explicit choice (persisted) > browser language > en.
 */
export type Lang = 'zh' | 'en'

const STORAGE_KEY = 'dshs-lang'

/** key → [中文, English] */
const MESSAGES = {
  'tab': ['上下文裁剪', 'Context Pruning'],
  'title': ['上下文裁剪', 'Context Pruning'],
  'subtitle': ['SACRED TIMELINE · 剪除异常分支，守护神圣时间线', 'SACRED TIMELINE · prune the variants, guard the timeline'],
  'stat.turns': ['轮对话', 'turns'],
  'stat.branches': ['次工具调用', 'tool calls'],
  'stat.anomalies': ['处可裁剪', 'stale'],
  'stat.pinned': ['已钉住', 'pinned'],
  'stat.void': ['已裁剪', 'pruned'],
  'cta.prune': ['裁剪 {n} 处异常分支 · −{tokens}', 'Prune {n} variants · −{tokens}'],
  'cta.pruning': ['正在裁剪…', 'Pruning…'],
  'cta.clean': ['时间线稳定 · 无异常分支', 'Timeline stable · no variants'],
  'saving': ['可节省约 {chars} 字符（≈ {tokens} tokens）', 'Saves about {chars} chars (≈ {tokens} tokens)'],
  'cache': ['裁剪后，从第 {n} 个节点起前缀缓存失效', 'Prefix cache breaks from node {n} on'],
  'busy': ['Agent 正在运行，这一轮结束后才能操作。', 'The agent is running. Actions resume when this turn ends.'],
  'loading': ['加载中…', 'Loading…'],
  'error': ['加载失败：{error}', 'Failed to load: {error}'],
  'error.hint': ['请确认 dsh-sacred 插件已启用，并已重启 DSH。', 'Make sure the dsh-sacred plugin is enabled and DSH was restarted.'],
  'error.host': ['dsh-sacred 的宿主插件没有启动（接口未注册）', 'The dsh-sacred host plugin is not running (API route missing)'],
  'error.hostHint': ['前端已加载，但后端没有。请查看启动 DSH 的终端里与 dsh-sacred 相关的报错，或访问 /sacred/api/health 检查。', 'The tab loaded but the host half did not. Check the DSH terminal for dsh-sacred errors, or open /sacred/api/health.'],
  'error.liveHint': ['在这个会话里发一条消息让它加载，然后点重试。', 'Send a message in this conversation so it loads, then retry.'],
  'retry': ['重试', 'Retry'],
  'empty.session': ['打开一个会话，就能看到它的上下文结构。', 'Open a conversation to see its context.'],
  'empty.tree': ['这个会话还没有工具调用。', 'No tool calls in this conversation yet.'],
  'root': ['会话起点', 'session start'],
  'turn': ['第 {n} 轮', 'Turn {n}'],
  'turn.system': ['起始', 'Start'],
  'void.title': ['已裁剪 · 可召回', 'Pruned · restorable'],
  'void.empty': ['还没有裁剪过内容。裁剪掉的原文会列在这里，可以随时召回。', 'Nothing pruned yet. Pruned originals are listed here and can be restored.'],
  'void.hint': ['原文仍完整保存在会话日志里', 'Originals are still in the session log'],
  'detail.pick': ['点击任意节点或分支查看详情。', 'Click any node or branch for details.'],
  'detail.prompt': ['用户指令', 'User prompt'],
  'detail.reply': ['最后回复', 'Last reply'],
  'detail.output': ['工具输出', 'Tool output'],
  'detail.chars': ['{n} 字符', '{n} chars'],
  'act.prune': ['裁剪', 'Prune'],
  'act.pin': ['钉住', 'Pin'],
  'act.unpin': ['取消钉住', 'Unpin'],
  'act.restore': ['召回', 'Restore'],
  'status.healthy': ['正常', 'nominal'],
  'status.error': ['失败', 'failed'],
  'status.anomaly': ['异常分支', 'variant'],
  'status.pinned': ['已钉住', 'pinned'],
  'status.pruned': ['已裁剪', 'pruned'],
  'reason.superseded-by-write': ['文件之后被修改了，这份读取结果已经过时', 'The file was modified later; this read is outdated'],
  'reason.superseded-by-read': ['同一个文件、同一个范围之后又读了一次', 'The same file and range was read again later'],
  'reason.duplicate': ['同样的调用、同样的输出，之后又出现了一次', 'Identical call with identical output appears later'],
  'reason.failed-retried': ['这次调用失败了，之后同一工具已成功；只保留报错开头作为教训', 'This call failed and the tool later succeeded; only the error head is kept'],
  'reason.branch-cut': ['整段分支被收束为摘要', 'A whole branch was condensed into a summary'],
  'legend.healthy': ['正常分支', 'nominal'],
  'legend.anomaly': ['异常分支', 'variant'],
  'legend.pinned': ['钉住', 'pinned'],
  'legend.pruned': ['已裁剪', 'pruned'],
  'toast.pruned': ['已裁剪 {n} 处，释放约 {tokens} tokens', 'Pruned {n} outputs, freed about {tokens} tokens'],
  'toast.pinned': ['已钉住', 'Pinned'],
  'toast.unpinned': ['已取消钉住', 'Unpinned'],
  'toast.restored': ['已召回', 'Restored'],
  'pin.note': ['钉住的内容永远不会被裁剪。', 'Pinned content is never pruned.'],
  'lang.toggle': ['English', '中文'],
  'reason.manual': ['手动裁剪', 'Pruned by hand'],
  'act.drop': ['手动裁剪', 'Prune by hand'],
  'close': ['关闭', 'Close'],
  'now': ['现在', 'now'],
  'fit': ['适应', 'Fit'],
  'legend.hint': ['拖动平移 · 滚轮缩放 · 点击查看', 'drag to pan · scroll to zoom · click for details'],
  'detail.share': ['占上下文 {n}%', '{n}% of context'],
  'detail.calls': ['{n} 次工具调用', '{n} tool calls'],
  'ctx.title': ['上下文负载 · Context load', 'Context load'],
  'ctx.estimated': ['估算', 'estimated'],
  'ctx.remaining': ['剩余 {n}', '{n} left'],
  'ctx.untilCompact': ['距自动压缩还有 {n}', '{n} until auto-compaction'],
  'ctx.overCompact': ['已超过自动压缩线，下一步可能触发整段摘要', 'Past the auto-compaction line — the next step may summarize'],
  'ctx.saved': ['本会话已释放 {n}', '{n} freed in this session'],
  'ctx.compactAt': ['自动压缩 {n}%', 'auto-compact {n}%'],
  'ctx.after': ['裁剪后 {n}', 'after {n}'],
  'ctx.system': ['系统提示', 'System'],
  'ctx.overhead': ['工具定义', 'Tool schemas'],
  'ctx.user': ['用户', 'User'],
  'ctx.assistant': ['助手', 'Assistant'],
  'ctx.tool': ['工具输出', 'Tool output'],
  'ctx.reserved': ['预留输出', 'Reserved output'],
  'ctx.prunable': ['可裁剪', 'Prunable'],
  'suggest.title': ['检测到的异常分支', 'Variants detected'],
  'suggest.empty': ['时间线稳定：规则没有发现异常分支。', 'Timeline stable: the rules found no variants.'],
  'suggest.emptyWhy': ['只有这几种情况会被自动建议：文件读完后又被修改、同一调用重复了且输出相同、失败后又成功（且报错足够长）。其他内容是否重要只有你知道，可以在下方或时间线上手动裁剪。', 'Only these are suggested automatically: a file read that was later modified, an identical repeated call, a failure followed by success (with a long enough error). Anything else is your call — prune it by hand below or on the timeline.'],
  'top.title': ['负载最重的分支', 'Heaviest branches'],
  'top.hint': ['确定不再需要的，可以直接手动裁剪；原文会保留，随时召回。', 'If you no longer need one, prune it by hand. The original is kept and can be restored.'],
} as const satisfies Record<string, readonly [string, string]>

export type Key = keyof typeof MESSAGES
export type T = (key: Key, vars?: Record<string, string | number>) => string

export function detectLang(): Lang {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (stored === 'en' || stored === 'zh') return stored
  } catch {
    /* storage unavailable (private mode, sandboxed frame) */
  }
  const nav = globalThis.navigator?.language ?? 'en'
  return nav.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

export function storeLang(lang: Lang): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, lang)
  } catch {
    /* best effort */
  }
}

export function makeT(lang: Lang): T {
  const i = lang === 'zh' ? 0 : 1
  return (key, vars) => {
    let s: string = MESSAGES[key]?.[i] ?? key
    for (const [k, v] of Object.entries(vars ?? {})) s = s.replace(`{${k}}`, String(v))
    return s
  }
}
