/**
 * Wording of the texts of a task: the brief its worker reads first, the steering header, and the notice a worker's note
 * leaves in the owner session.
 */

/** Language of the task texts; `zh` and `en` are the supported tables. */
export type SessionTasksLocale = 'zh' | 'en'

/** Every text the plugin hands a worker or an owner, as templates filled with {@link fill}. */
export interface SessionTaskStrings {
  /** Header of the input a new worker reads first. */
  brief: string
  /** Header of a steer from the owner. */
  steer: string
  /** Notice carrying the worker's note. */
  note: string
}

const ZH: SessionTaskStrings = {
  brief: '后台任务 #{id}：{title}',
  steer: '任务 #{id} 的主人发来的消息：\n\n{text}',
  note: '后台任务 #{id}「{title}」的记录：{note}',
}

const EN: SessionTaskStrings = {
  brief: 'Background task #{id}: {title}',
  steer: 'Message from the session that owns task #{id}:\n\n{text}',
  note: 'Background task #{id} ({title}) recorded: {note}',
}

/**
 * The texts of one configured locale.
 * @param locale - configured reply language; anything but `en` falls back to Chinese.
 * @returns the string table of that locale.
 */
export function stringsOf(locale: SessionTasksLocale): SessionTaskStrings {
  return locale === 'en' ? EN : ZH
}

/**
 * Fill one template: every `{name}` becomes the value of `values[name]`.
 * @param template - the template, e.g. `'后台任务 #{id}：{title}'`.
 * @param values - placeholder values.
 * @returns the filled text.
 */
export function fill(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = values[name]
    return value === undefined ? match : String(value)
  })
}
