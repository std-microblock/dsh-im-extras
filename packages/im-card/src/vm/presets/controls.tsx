/**
 * `Switch`, `Segmented` and `Stepper`: stateful buttons a card can use on its own or inside a `<PromptForm>` field.
 *
 * They hold their own state (so a click republishes the card at once) and report every change through `onChange`; a
 * form field uses that callback to remember the value for its submit, because a platform `<form>` holds form
 * components only and these are buttons.
 *
 * @module dsh-im-card/vm/presets/controls
 */
import { useState } from '../hooks.ts'
import { h, type VNode } from '../jsx.ts'

/** Props shared by the three controls: a caption cell and where the row sits. */
export interface ControlProps {
  /** Caption drawn as the row's first cell, as a disabled text button, so the row keeps its columns. */
  label?: string
  align?: 'left' | 'center' | 'right'
  disabled?: boolean
}

/** Props of `<Switch>`: a two-button on/off control. */
export interface SwitchProps extends ControlProps {
  /** Initial state. */
  value?: boolean
  onChange?: (on: boolean) => void
  /** Label of the on state (default `开启`). */
  onLabel?: string
  /** Label of the off state (default `关闭`). */
  offLabel?: string
}

/** One choice of `<Segmented>`: a bare string is both its label and its value. */
export type SegmentOption = string | { label: string; value: string }

/** Props of `<Segmented>`: one choice among options, as filled/unfilled buttons. */
export interface SegmentedProps extends ControlProps {
  options: SegmentOption[]
  value?: string
  onChange?: (value: string) => void
}

/** Props of `<Stepper>`: a number with − n +, clamped to `min`/`max`. */
export interface StepperProps extends ControlProps {
  value?: number
  min?: number
  max?: number
  step?: number
  /** Appended to the number, e.g. `人`. */
  unit?: string
  onChange?: (value: number) => void
}

/**
 * A whole number, or the fallback when the value is not one.
 * @param value - what the card passed.
 * @param fallback - what to use instead.
 */
function intOf(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n) : fallback
}

/**
 * A row whose first cell is the field's caption (a disabled text button, so the row keeps its columns).
 * @param p - the control's props (`label`, `align`).
 * @param cells - the controls of the row.
 */
function viewRow(p: ControlProps, cells: unknown[]): VNode {
  const all: unknown[] =
    p.label === undefined ? cells : [h('button', { size: 'small', variant: 'text', disabled: true }, String(p.label)), ...cells]
  return h('button-group', { align: p.align }, ...all)
}

/**
 * An on/off toggle (关闭 / 开启): both states are buttons, the current one is filled.
 * @param props - the initial state, the labels and the change callback.
 */
export function Switch(props: SwitchProps): VNode {
  const p = props === null || props === undefined ? ({} as SwitchProps) : props
  const [on, setOn] = useState(p.value === true)
  const change = (next: boolean) => {
    if (p.disabled === true || next === on) return
    setOn(next)
    if (typeof p.onChange === 'function') p.onChange(next)
  }
  return viewRow(p, [
    <button size="small" variant={on ? 'default' : 'primary_filled'} onClick={() => change(false)}>
      {p.offLabel === undefined ? '关闭' : String(p.offLabel)}
    </button>,
    <button size="small" variant={on ? 'primary_filled' : 'default'} onClick={() => change(true)}>
      {p.onLabel === undefined ? '开启' : String(p.onLabel)}
    </button>,
  ])
}

/**
 * A single choice among options, as filled/unfilled buttons.
 * @param props - the options, the value and the change callback.
 */
export function Segmented(props: SegmentedProps): VNode {
  const p = props === null || props === undefined ? ({} as SegmentedProps) : props
  const options = (Array.isArray(p.options) ? p.options : []).map((option) =>
    typeof option === 'object' && option !== null
      ? {
          label: String(option.label === undefined ? option.value : option.label),
          value: String(option.value === undefined ? option.label : option.value),
        }
      : { label: String(option), value: String(option) },
  )
  const [value, setValue] = useState(p.value === undefined ? null : String(p.value))
  const change = (next: string) => {
    if (p.disabled === true || next === value) return
    setValue(next)
    if (typeof p.onChange === 'function') p.onChange(next)
  }
  return viewRow(
    p,
    options.map((option) => (
      <button
        size="small"
        variant={String(option.value) === value ? 'primary_filled' : 'default'}
        onClick={() => change(String(option.value))}
      >
        {option.label}
      </button>
    )),
  )
}

/**
 * A number with − n +, clamped to `min`/`max`.
 * @param props - the range, the step and the change callback.
 */
export function Stepper(props: StepperProps): VNode {
  const p = props === null || props === undefined ? ({} as StepperProps) : props
  const min = intOf(p.min, 0)
  const max = intOf(p.max, Math.max(min, 99))
  const step = Math.max(1, intOf(p.step, 1))
  const start = Math.min(max, Math.max(min, intOf(p.value, min)))
  const [n, setN] = useState(start)
  const change = (next: number) => {
    const clamped = Math.min(max, Math.max(min, next))
    if (p.disabled === true || clamped === n) return
    setN(clamped)
    if (typeof p.onChange === 'function') p.onChange(clamped)
  }
  return viewRow(p, [
    <button size="small" disabled={n <= min} onClick={() => change(n - step)}>
      −
    </button>,
    <button size="small" variant="text" disabled={true}>
      {String(n) + (p.unit === undefined ? '' : String(p.unit))}
    </button>,
    <button size="small" disabled={n >= max} onClick={() => change(n + step)}>
      +
    </button>,
  ])
}
