/**
 * `PromptForm`: a few fields and one submit, which sends them as one prompt.
 *
 * A platform `<form>` holds form components only, so the button fields (`switch`, `radio`/`segmented`, `number`/
 * `stepper`) are drawn above it and keep their values in the component's own state; the native controls' values arrive
 * with the submit click. Either way the result is one text: `prompt` with `{name}` placeholders, or `标签：值` pairs.
 *
 * A platform without form controls (QQ: markdown and a keyboard) gets the same form made of buttons: a `select` becomes a
 * row of options, a `checkbox` a switch, and a text field asks for a chat reply (with a keyboard button that fills the
 * input box where the platform has one); the submit is an action button. A platform whose buttons cannot be clicked
 * at all gets the fields as a reply template.
 *
 * @module dsh-im-card/vm/presets/form
 */
import { cardHandle, platform } from '../actions.ts'
import { useState } from '../hooks.ts'
import { h, type VNode } from '../jsx.ts'
import { Stepper, Segmented, Switch } from './controls.tsx'
import type { SegmentOption } from './controls.tsx'
import { ask, buttonStyle, doneLine, type AnsweredBy, type ButtonStyleProps, type PromptReplyProps } from './shared.tsx'

/** One field of `<PromptForm>`; `type` picks the control (`text` when absent). */
export interface PromptField {
  name: string
  /** `text` (default), `multiline`, `password`, `checkbox`, `select`, `switch`, `radio`/`segmented`, `number`/`stepper`. */
  type?: string
  /** Caption above the field. */
  label?: string
  placeholder?: string
  /** Initial value: the text of a field, the state of a checkbox, the number of a stepper. */
  value?: string | boolean | number
  maxLength?: number
  required?: boolean
  disabled?: boolean
  /** The options of a `select`, `radio` or `segmented` field. */
  options?: SegmentOption[]
  min?: number
  max?: number
  step?: number
  /** Appended to a number, e.g. `人`. */
  unit?: string
  onLabel?: string
  offLabel?: string
}

/** Props of `<PromptForm>`. */
export interface PromptFormProps extends PromptReplyProps, ButtonStyleProps {
  fields: PromptField[]
  /** Text sent on submit, with `{name}` placeholders of the field values (default: `标签：值` pairs). */
  prompt?: string
  submitLabel?: string
  /** Form name on the platform; defaults to `prompt-form`. */
  name?: string
}

/** Field types that live in the platform's `<form>` (their values arrive with the submit click). */
const FORM_FIELD_TYPES = ['text', 'multiline', 'password', 'checkbox', 'select']

/** The values collected for a submit: the field's own state first, then what the platform reported. */
type FormValues = Record<string, unknown>

/** What a submitted form remembers, to show what was sent. */
interface Submitted {
  who: AnsweredBy
  answer: string
}

/**
 * The type of a field.
 * @param field - the field definition; `text` when it names none.
 */
function fieldType(field: PromptField): string {
  return field.type === undefined ? 'text' : String(field.type)
}

/**
 * A whole number, or the fallback when the value is not one.
 * @param value - what the card passed.
 * @param fallback - what to use instead.
 */
function intOf(value: unknown, fallback: number | undefined): number | undefined {
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n) : fallback
}

/**
 * Render one value as text inside a prompt.
 * @param value - a field's value.
 */
function textOf(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (Array.isArray(value)) return value.join('、')
  if (typeof value === 'boolean') return value ? '是' : '否'
  return String(value)
}

/**
 * Substitute a form's values into the prompt template.
 * @param template - the text with `{name}` placeholders; empty for `标签：值` pairs.
 * @param values - the values, by field name.
 * @param fields - the fields, in order (for the caption and the order of the pairs).
 */
function fillTemplate(template: unknown, values: FormValues, fields: PromptField[]): string {
  if (typeof template === 'string' && template !== '') {
    return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
      Object.prototype.hasOwnProperty.call(values, name) ? textOf(values[name]) : whole,
    )
  }
  const parts: string[] = []
  for (const field of fields) {
    const text = textOf(values[String(field.name)])
    if (text !== '') parts.push((field.label === undefined ? String(field.name) : String(field.label)) + '：' + text)
  }
  return parts.join('，')
}

/**
 * One platform form control of a form field.
 * @param field - the field definition.
 * @param type - its resolved type (`text`, `multiline`, `password`, `checkbox` or `select`).
 * @param name - its form key.
 * @param label - its caption, when it has one.
 * @param choose - remembers a pick made before the submit (a select reports itself).
 */
function formControl(
  field: PromptField,
  type: string,
  name: string,
  label: string | undefined,
  choose: (name: string, value: unknown) => void,
): VNode {
  const placeholder = field.placeholder === undefined ? undefined : String(field.placeholder)
  if (type === 'select') {
    const options = (Array.isArray(field.options) ? field.options : []).map((option) => {
      if (typeof option === 'object' && option !== null) {
        const value = String(option.value === undefined ? option.label : option.value)
        return (
          <option key={value} value={value}>
            {String(option.label === undefined ? value : option.label)}
          </option>
        )
      }
      return (
        <option key={String(option)} value={String(option)}>
          {String(option)}
        </option>
      )
    })
    return (
      <select
        name={name}
        placeholder={placeholder === undefined ? label : placeholder}
        value={field.value === undefined ? undefined : String(field.value)}
        required={field.required === true ? true : undefined}
        disabled={field.disabled === true ? true : undefined}
        // A pick is reported immediately; the same value also arrives with the submit.
        onSelect={(event: unknown) => choose(name, (event as { values: string[] }).values[0])}
      >
        {options}
      </select>
    )
  }
  if (type === 'checkbox') {
    return <input name={name} type="checkbox" label={label} value={field.value === true ? true : undefined} />
  }
  return (
    <input
      name={name}
      type={type === 'text' ? undefined : type}
      label={label}
      placeholder={placeholder}
      value={field.value === undefined ? undefined : String(field.value)}
      maxLength={field.maxLength === undefined ? undefined : intOf(field.maxLength, undefined)}
      required={field.required === true ? true : undefined}
      disabled={field.disabled === true ? true : undefined}
    />
  )
}

/**
 * A form that sends what was filled in as one prompt: `fields` names the controls, `prompt` is the text with `{name}`
 * placeholders (default: `label：value` pairs). Button fields (switch / radio / number) stand above the platform form,
 * because a `<form>` holds only form components.
 * @param props - the fields, the prompt and the submit styling.
 */
export function PromptForm(props: PromptFormProps) {
  const p = props === null || props === undefined ? ({} as PromptFormProps) : props
  const fields = (Array.isArray(p.fields) ? p.fields : []).filter((field) => field !== null && typeof field === 'object')
  const [choices, setChoices] = useState<FormValues>({})
  const [used, setUsed] = useState<Submitted | null>(null)
  const once = p.once !== false
  const choose = (name: string, value: unknown) =>
    setChoices((previous) => {
      const next: FormValues = {}
      for (const key of Object.keys(previous)) next[key] = previous[key]
      next[name] = value
      return next
    })
  const submit = (event: unknown) => {
    const values: FormValues = {}
    const given = event !== null && typeof event === 'object' ? (event as { values?: FormValues }).values : undefined
    const reported: FormValues = given !== undefined && given !== null ? given : {}
    for (const field of fields) {
      const name = String(field.name)
      values[name] = choices[name] !== undefined ? choices[name] : reported[name]
    }
    const text = fillTemplate(p.prompt, values, fields)
    const who = ask(p, text, event, cardHandle)
    if (who === null) return
    if (p.toast !== undefined) cardHandle.toast(String(p.toast), 'success')
    else if (!once) cardHandle.toast('已发送', 'success')
    if (once) setUsed({ who, answer: text })
  }
  if (once && used !== null) {
    if (p.done !== undefined) return p.done
    const chars = Array.from(used.answer)
    const answer = chars.length > 200 ? chars.slice(0, 199).join('') + '…' : used.answer
    return [doneLine('✅ 已提交', '', used.who), <small>{answer}</small>]
  }

  const shown = platform()
  if (!shown.buttons) return replyTemplate(fields, p.submitLabel)
  const blocks: unknown[] = []
  const controls: unknown[] = []
  for (const field of fields) {
    let type = fieldType(field)
    const name = String(field.name)
    const label = field.label === undefined ? undefined : String(field.label)
    if (FORM_FIELD_TYPES.indexOf(type) >= 0 && !shown.forms) {
      // No native form controls: the field is drawn with buttons, or asks for a chat reply.
      if (type === 'select') type = 'radio'
      else if (type === 'checkbox') type = 'switch'
      else {
        blocks.push(...textPrompt(field, name, label))
        continue
      }
    }
    if (FORM_FIELD_TYPES.indexOf(type) >= 0) {
      controls.push(formControl(field, type, name, label, choose))
      continue
    }
    if (label !== undefined) blocks.push(<p><b>{label}</b></p>)
    if (type === 'switch') {
      blocks.push(
        <Switch
          value={field.value === true}
          onChange={(next) => choose(name, next)}
          disabled={field.disabled}
          onLabel={field.onLabel}
          offLabel={field.offLabel}
        />,
      )
      continue
    }
    if (type === 'radio' || type === 'segmented') {
      blocks.push(
        <Segmented
          options={field.options === undefined ? [] : field.options}
          value={field.value === undefined ? undefined : String(field.value)}
          onChange={(next) => choose(name, next)}
          disabled={field.disabled}
        />,
      )
      continue
    }
    if (type === 'number' || type === 'stepper') {
      blocks.push(
        <Stepper
          value={field.value as number | undefined}
          min={field.min}
          max={field.max}
          step={field.step}
          unit={field.unit}
          onChange={(next) => choose(name, next)}
          disabled={field.disabled}
        />,
      )
      continue
    }
    throw new Error(
      'unknown field type "' +
        type +
        '" (' +
        name +
        '); use text, multiline, password, checkbox, select, switch, radio or number',
    )
  }
  const submitAttrs = buttonStyle(p, {
    type: 'submit',
    onClick: submit,
    width: 'fill',
    variant: p.variant === undefined ? 'primary_filled' : p.variant,
  })
  const submitLabel = p.submitLabel === undefined ? '提交' : String(p.submitLabel)
  if (!shown.forms) {
    // The values were collected by the buttons above; the submit is a plain action button.
    submitAttrs.type = 'action'
    blocks.push(<button {...submitAttrs}>{submitLabel}</button>)
    return blocks
  }
  controls.push(<button {...submitAttrs}>{submitLabel}</button>)
  blocks.push(<form name={p.name === undefined ? 'prompt-form' : String(p.name)}>{controls}</form>)
  return blocks
}

/**
 * A text field on a platform without form controls: its caption, a line asking for a chat reply, and a keyboard button
 * that puts the caption into the reader's input box.
 * @param field - the field definition.
 * @param name - its form key.
 * @param label - its caption, when it has one.
 */
function textPrompt(field: PromptField, name: string, label: string | undefined): VNode[] {
  const caption = label === undefined ? name : label
  const hint = field.placeholder === undefined ? '' : '（' + String(field.placeholder) + '）'
  return [
    <p>
      <b>{caption}</b>
      {'：请直接在聊天中回复' + hint}
    </p>,
    <button type="input" text={caption + '：'}>
      {'填写' + caption}
    </button>,
  ]
}

/**
 * The form as a reply template, for a platform whose buttons cannot be clicked: one line per field.
 * @param fields - the fields, in order.
 * @param submitLabel - what the submit would have said.
 */
function replyTemplate(fields: PromptField[], submitLabel: string | undefined): unknown[] {
  const lines = fields.map((field) => {
    const caption = field.label === undefined ? String(field.name) : String(field.label)
    const options = Array.isArray(field.options)
      ? '（' + field.options.map((option) => typeof option === 'object' && option !== null
        ? String(option.label === undefined ? option.value : option.label)
        : String(option)).join(' / ') + '）'
      : ''
    return <li>{caption + '：' + options}</li>
  })
  return [
    <p>{'请按下面的格式直接回复' + (submitLabel === undefined ? '' : '（' + submitLabel + '）') + '：'}</p>,
    <ul>{lines}</ul>,
  ]
}
