/**
 * `PromptButton` and `PromptChoices`: the one-tap answers that send a prompt to the agent.
 *
 * A click sends its text as a message to the session that published the card. By default the control is one-time (its
 * place is then taken by the line naming who answered) and only the requester may click it; `once={false}` keeps it
 * clickable, `sender` changes who may click. `sender="anyone"` opens a card to the whole chat, `sender="ou_…"` names
 * one person.
 *
 * @module dsh-im-card/vm/presets/quick-reply
 */
import { cardHandle } from '../actions.ts'
import { useState } from '../hooks.ts'
import { h } from '../jsx.ts'
import {
  ask,
  buttonStyle,
  doneLine,
  plainText,
  type AnsweredBy,
  type ButtonStyleProps,
  type PromptReplyProps,
} from './shared.tsx'

/** Props of `<PromptButton>`. */
export interface PromptButtonProps extends ButtonStyleProps, PromptReplyProps {
  /** Text sent to the agent on click (default: the children, read as text). */
  prompt?: string
  children?: unknown
}

/** One option of `<PromptChoices>`: a bare string sends its own label. */
export interface PromptChoice {
  label: string
  /** Text sent when this option is picked (default: `label`). */
  prompt?: string
  variant?: string
  theme?: string
}

/** Props of `<PromptChoices>`: a row of one-tap answers; the picked row collapses to the answer. */
export interface PromptChoicesProps extends PromptReplyProps {
  options: (string | PromptChoice)[]
  width?: 'auto' | 'fill'
  align?: 'left' | 'center' | 'right'
  variant?: string
  theme?: string
  size?: string
}

/** One option, resolved: what it shows, what it sends, and the styling it carries. */
interface ResolvedChoice {
  label: string
  prompt: string
  option?: PromptChoice
}

/**
 * Resolve one option of a choices row.
 * @param given - a bare label, or an object with its own prompt and styling.
 */
function choiceOf(given: unknown): ResolvedChoice {
  if (typeof given === 'string') return { label: given, prompt: given }
  if (given === null || typeof given !== 'object') return { label: String(given), prompt: String(given) }
  const option = given as PromptChoice & { value?: unknown }
  const label = option.label === undefined ? String(option.value === undefined ? '' : option.value) : String(option.label)
  return { label, prompt: option.prompt === undefined ? label : String(option.prompt), option }
}

/**
 * A quick reply: a click sends `prompt` to the agent. One-time by default (`once={false}` keeps it clickable), and
 * only the requester may click it unless `sender` says otherwise.
 * @param props - the prompt, the label and the styling.
 */
export function PromptButton(props: PromptButtonProps) {
  const p = props === null || props === undefined ? ({} as PromptButtonProps) : props
  const [used, setUsed] = useState<AnsweredBy | null>(null)
  const once = p.once !== false
  const label = plainText(p.children)
  const prompt = p.prompt === undefined ? label : String(p.prompt)
  const click = (event: unknown) => {
    const who = ask(p, prompt, event, cardHandle)
    if (who === null) return
    if (p.toast !== undefined) cardHandle.toast(String(p.toast), 'success')
    else if (!once) cardHandle.toast('已发送', 'success')
    if (once) setUsed(who)
  }
  if (once && used !== null) return p.done !== undefined ? p.done : doneLine('✅ 已选择', label, used)
  const attrs = buttonStyle(p, { onClick: click, disabled: p.disabled === true ? true : undefined })
  return <button {...attrs}>{p.children}</button>
}

/** What a used choices row remembers: the label it answered with, and who did. */
interface UsedChoice {
  label: string
  who: AnsweredBy
}

/**
 * A row of one-tap quick replies: the picked option sends its prompt and the row collapses to the answer
 * (`once={false}` keeps the row and only shows a toast).
 * @param props - the options and the styling.
 */
export function PromptChoices(props: PromptChoicesProps) {
  const p = props === null || props === undefined ? ({} as PromptChoicesProps) : props
  const [used, setUsed] = useState<UsedChoice | null>(null)
  const once = p.once !== false
  const options = (Array.isArray(p.options) ? p.options : []).map(choiceOf)
  if (once && used !== null) return p.done !== undefined ? p.done : doneLine('✅ 已选择', used.label, used.who)
  const buttons = options.map((choice, index) => {
    const style: PromptChoice = choice.option !== undefined ? choice.option : ({} as PromptChoice)
    const attrs = buttonStyle(p, {})
    if (style.variant !== undefined) attrs.variant = style.variant
    if (style.theme !== undefined) attrs.theme = style.theme
    attrs.key = String(index)
    attrs.onClick = (event: unknown) => {
      const who = ask(p, choice.prompt, event, cardHandle)
      if (who === null) return
      if (p.toast !== undefined) cardHandle.toast(String(p.toast), 'success')
      else if (!once) cardHandle.toast('已发送', 'success')
      if (once) setUsed({ label: choice.label, who })
    }
    return <button {...attrs}>{choice.label}</button>
  })
  return (
    <button-group width={p.width === undefined ? 'fill' : p.width} align={p.align}>
      {buttons}
    </button-group>
  )
}
