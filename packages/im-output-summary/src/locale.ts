/** Text of the summary renderer, per locale. */
import type { SummaryLocale } from './config.ts'

/** Everything the summary renderer writes into chat. */
export interface SummaryStrings {
  /** Status line while the model is thinking (no tool running). */
  thinking: string
  /** Status line while a tool runs: the tool's name and how many calls the turn made so far. */
  calling(name: string, calls: number): string
  /** Closing line of a turn that answered: elapsed time and the number of tool calls. */
  footer(elapsed: string, calls: number): string
  /** A duration for {@link footer}: one decimal second below a minute, minutes above. */
  elapsed(ms: number): string
  /** Note appended to an answer cut at `maxChars`. */
  truncated: string
  /** Closing line of a turn that answered nothing and could not be recalled. */
  done: string
  /** Closing line of a failed turn that answered nothing. */
  error(message: string): string
  /** Suffix of the footer of a cancelled turn nobody is named in. */
  cancelled: string
  /** Words before the mention of whoever stopped the turn: `已由 @名字 取消`. */
  stoppedBefore: string
  /** Words after that mention. */
  stoppedAfter: string
  /** Label of the stop button. */
  stop: string
  /** The stop instruction of a platform that renders no action button (the fallback of the stop control). */
  stopHint: string
}

const zh: SummaryStrings = {
  thinking: '⏳ 思考中',
  calling: (name, calls) => `⏳ 调用 ${name}（共 ${calls} 次）`,
  footer: (elapsed, calls) => `${elapsed} · ${calls} 次工具调用`,
  elapsed: ms => (ms < 60_000
    ? `${(Math.max(0, ms) / 1000).toFixed(1)} 秒`
    : `${Math.floor(ms / 60_000)} 分 ${Math.floor((ms % 60_000) / 1000)} 秒`),
  truncated: '（内容过长，已截断）',
  done: '已完成',
  error: message => `出错：${message}`,
  cancelled: '已取消',
  stoppedBefore: '已由 ',
  stoppedAfter: ' 取消',
  stop: '停止',
  stopHint: '回复 /stop 停止',
}

const en: SummaryStrings = {
  thinking: '⏳ Thinking',
  calling: (name, calls) => `⏳ Running ${name} (${calls} calls)`,
  footer: (elapsed, calls) => `${elapsed} · ${calls} tool calls`,
  elapsed: ms => (ms < 60_000
    ? `${(Math.max(0, ms) / 1000).toFixed(1)}s`
    : `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`),
  truncated: '(truncated, the answer is too long)',
  done: 'Done',
  error: message => `Error: ${message}`,
  cancelled: 'cancelled',
  stoppedBefore: 'stopped by ',
  stoppedAfter: '',
  stop: 'Stop',
  stopHint: 'Reply /stop to stop',
}

const tables: Record<SummaryLocale, SummaryStrings> = { zh, en }

/**
 * Strings of one locale.
 * @param locale - reply language the renderer publishes in.
 * @returns the complete string table of that locale.
 */
export function stringsOf(locale: SummaryLocale): SummaryStrings {
  return tables[locale]
}
