/**
 * What the presets share: who may click, what a click sends, and the button attributes a card may pass through.
 *
 * The presets are the six components every card has without importing anything (`PromptButton`, `PromptChoices`,
 * `PromptForm`, `Switch`, `Segmented`, `Stepper`). They are written here in TSX — the same vocabulary a card is
 * written in — and their props mirror `types/dsh-card.d.ts`, the declarations a card is type-checked against. Keep the
 * two in step: that file is what the model sees, this one is what runs.
 *
 * @module dsh-im-card/vm/presets/shared
 */
import { agent, type CardHandle } from '../actions.ts'
import { g } from '../globals.ts'
import { h, type VNode } from '../jsx.ts'

/** Attributes every button of the platform accepts; a preset passes through the ones its card set. */
export interface ButtonStyleProps {
  theme?: string
  /** Exact platform button type; wins over `theme`. */
  variant?: string
  size?: string
  width?: string | number
  icon?: string
  confirm?: { title: string; text: string }
  tip?: string
  disabled?: boolean
  disabledTip?: string
}

/** Who a quick reply is addressed to. */
export interface PromptTargetProps {
  /** `'requester'` (default), `'anyone'`, or one person's open_id. */
  sender?: string
  /** How that person is named in toasts and in the line a used control leaves. */
  senderName?: string
}

/** What every quick reply shares: one click, one message to the agent. */
export interface PromptReplyProps extends PromptTargetProps {
  /** Restrict to one click (default `true`). */
  once?: boolean
  /** Toast shown to the clicker once the message went out. */
  toast?: string
  /** What replaces the control once used (default: the `✅ 已选择 …` line). */
  done?: unknown
}

/** The person a quick reply is addressed to. */
export interface PromptTarget {
  /** Their open_id; `''` means anyone. */
  id: string
  /** Their name, or `''` when unknown. */
  name: string
}

/** Who clicked, as the platform reported it. */
export interface EventUser {
  id: string
  name?: string
}

/** Who answered a used quick reply. */
export interface AnsweredBy {
  id: string
  name: string
}

/**
 * The plain text of a child list; a nested element contributes nothing.
 * @param children - what was passed inside an element.
 */
export function plainText(children: unknown): string {
  if (typeof children === 'string') return children
  if (typeof children === 'number' || typeof children === 'bigint') return String(children)
  if (Array.isArray(children)) {
    let out = ''
    for (const child of children) out += plainText(child)
    return out
  }
  return ''
}

/**
 * The person a card answers: `__cardContext.requester`, when the host could resolve one.
 * @returns who it is, or `undefined` when the host published nobody.
 */
export function requester(): { id: string; name?: string } | undefined {
  const context = g.__cardContext
  const who = context !== undefined && typeof context === 'object' ? context.requester : undefined
  return who !== undefined && who !== null && typeof who.id === 'string' && who.id !== '' ? who : undefined
}

/**
 * Who may use a quick reply: `sender` is an open_id, `'requester'` (default) or `'anyone'`; `senderName` labels that
 * person. `'requester'` without a known requester admits everyone, because nobody could be named.
 * @param props - the preset's props.
 */
export function targetOf(props: PromptTargetProps): PromptTarget {
  const who = requester()
  const mode = props.sender === undefined ? 'requester' : String(props.sender)
  const id = mode === 'anyone' ? '' : mode === 'requester' ? (who === undefined ? '' : who.id) : mode
  const name =
    props.senderName !== undefined
      ? String(props.senderName)
      : who !== undefined && typeof who.name === 'string'
        ? who.name
        : ''
  return { id, name }
}

/**
 * A mention of the person, or their name when it is known.
 * @param who - the person answering, if one is known.
 * @returns the inline node to place, or `null` when nobody is named.
 */
export function personOf(who: AnsweredBy | undefined): VNode | string | null {
  if (who === undefined || who === null || who.id === '') return null
  if (typeof who.name === 'string' && who.name !== '') return who.name
  return h('at', { type: 'user', id: who.id }, [])
}

/**
 * Send one prompt on behalf of a click, enforcing `sender`.
 * @param props - the preset's props.
 * @param text - the prompt to send.
 * @param event - the event the platform reported.
 * @param card - the card handle, for the toasts a refusal shows.
 * @returns who sent it, or `null` when the click was refused (the toast says why).
 */
export function ask(props: PromptTargetProps, text: unknown, event: unknown, card: CardHandle): AnsweredBy | null {
  const target = targetOf(props)
  const reported = event !== null && typeof event === 'object' ? (event as { user?: EventUser }).user : undefined
  const user: Partial<EventUser> = reported ? reported : {}
  const id = typeof user.id === 'string' ? user.id : ''
  if (target.id !== '' && id !== target.id) {
    card.toast('只有 ' + (target.name || '发起人') + ' 可以点击', 'warning')
    return null
  }
  const body = typeof text === 'string' ? text.trim() : ''
  if (body === '') {
    card.toast('这条回复没有内容', 'error')
    return null
  }
  const sent = agent.send(body)
  if (!sent || sent.ok !== true) {
    card.toast('发送失败：' + ((sent && sent.error) || '未知原因'), 'error')
    return null
  }
  const name = typeof user.name === 'string' && user.name !== '' ? user.name : target.name
  return { id, name }
}

/**
 * The line a used-up quick reply leaves: `✅ 已选择「确认」 · 张三`.
 * @param mark - the leading text (`✅ 已选择`, `✅ 已提交`).
 * @param label - what was picked, or `''` for a form.
 * @param who - who answered, if known.
 */
export function doneLine(mark: string, label: string, who: AnsweredBy | undefined): VNode {
  const kids: unknown[] = [mark]
  if (label !== '') kids.push('「' + label + '」')
  const person = personOf(who)
  if (person !== null) kids.push(' · ', person)
  return h('p', {}, ...kids)
}

/**
 * Button attributes taken from a preset's props (`undefined` ones are dropped).
 * @param props - the preset's props.
 * @param extra - attributes of the call site (handler, type, width).
 */
export function buttonStyle(props: ButtonStyleProps, extra?: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = extra === undefined ? {} : extra
  for (const key of ['variant', 'theme', 'size', 'width', 'icon', 'confirm', 'tip', 'disabledTip'] as const) {
    const value: unknown = props[key]
    if (value !== undefined) out[key] = value
  }
  return out
}
