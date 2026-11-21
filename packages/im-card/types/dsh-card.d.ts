/**
 * Types of the card API, served to the type checker as the module `dsh:card` and as the JSX namespace of every card.
 * Cards are type-checked against this file before they are published.
 *
 * - Components are plain functions: `function Row(props: { label: string }) { return <p>{props.label}</p> }` — define
 *   them in the card file or import them from another relative file (`import { Row } from './row.tsx'`).
 * - Hooks follow React's rules: call them unconditionally, in the same order on every render.
 */

/** Anything a component may return or pass as children. */
export type Child = JSX.Element | string | number | boolean | null | undefined | readonly Child[]

/** A function component. */
export type Component<P = {}> = (props: P) => Child

/** Props of a component that accepts children. */
export type PropsWithChildren<P = {}> = P & { children?: Child }

/** Who clicked and what the button carried. */
export interface ClickEvent {
  /** The clicker: `id` is the Feishu open_id (show it with `<at type="user" id={e.user.id} />`; `name` is usually absent). */
  user: { id: string; name?: string }
  /** The button's `data` attribute, when it has one. */
  data?: string
  /** Values of the `<form>` a submit button stands in, keyed by each control's `name`. */
  values?: Record<string, string | string[] | boolean>
  /** Click time, epoch ms. */
  time: number
}

/** Who picked and what they chose in a `<select>`. */
export interface SelectEvent {
  /** The person who picked: `id` is the Feishu open_id. */
  user: { id: string; name?: string }
  /** Chosen option values: one for a single select, all of them for a `multiple` one. */
  values: string[]
  /** The control's `data` attribute, when it has one. */
  data?: string
  /** Pick time, epoch ms. */
  time: number
}

/** Who toggled a checkbox, and its state after the toggle. */
export interface CheckEvent {
  /** The person who toggled it: `id` is the Feishu open_id. */
  user: { id: string; name?: string }
  /** The state after the toggle. */
  checked: boolean
  /** The control's `data` attribute, when it has one. */
  data?: string
  /** Toggle time, epoch ms. */
  time: number
}

/** Result of a message to the agent. */
export interface SendResult { ok: boolean; error?: string }

// ---------------------------------------------------------------------------------------------------------------
// The card's data folder and requests
//
// A card may read and write files, but only inside the folder its deployment gave it: paths are relative, and
// anything that would leave the folder (an absolute path, `..`, a link pointing out) is a thrown error. `fetch` is
// the other door out: one HTTP(S) request, answered later and bounded by the operator's rules.
// ---------------------------------------------------------------------------------------------------------------

/** One entry of the card's data folder. */
export interface FileEntry {
  /** Name of the file or directory. */
  name: string
  /** Whether this entry is a directory. */
  dir: boolean
  /** Bytes of a file (`0` for a directory). */
  size: number
}

/**
 * The card's data folder. The folder is fixed when the card is published and stored with it, so a card always reads
 * the same files; cards published from one working directory share it, so name your own files (`poll-42.json`) or
 * pass the path in through props. A path is relative, `/`-separated (`state.json`, `polls/week.json`).
 */
export interface CardFs {
  /** The text of a file, or `undefined` when there is no such file. */
  readFile(path: string): string | undefined
  /** Write a file, creating its folders and replacing what it held. */
  writeFile(path: string, text: string): void
  /** Add to the end of a file, creating it when needed. */
  appendFile(path: string, text: string): void
  /** Delete a file; deleting what is not there does nothing. */
  removeFile(path: string): void
  /** Whether something exists at that path. */
  exists(path: string): boolean
  /** The entries of a folder (`''` is the data folder itself). */
  listFiles(path?: string): FileEntry[]
  /** A file parsed as JSON, or `fallback` when there is no file. A corrupt file throws. */
  readJson<T = unknown>(path: string, fallback: T): T
  /** A value stored as JSON (indented, so the file stays readable). */
  writeJson(path: string, value: unknown): void
}

/** What to send with a request. */
export interface CardFetchInit {
  /** HTTP method; `GET` when absent. A `GET` or `HEAD` request cannot carry a body. */
  method?: string
  /** Request headers. */
  headers?: Record<string, string>
  /** Request body. */
  body?: string
}

/** A response of {@link fetch}. */
export interface CardResponse {
  /** Whether the status is 2xx. */
  ok: boolean
  /** HTTP status code. */
  status: number
  /** Reason phrase, when the server sent one. */
  statusText: string
  /** Final URL, after redirects. */
  url: string
  /** Response headers, read case-insensitively. */
  headers: { get(name: string): string | undefined }
  /** The body as text. */
  text(): Promise<string>
  /** The body parsed as JSON. */
  json<T = unknown>(): Promise<T>
}

/** The card's data folder (also the global `fs`). */
export declare const fs: CardFs
/** One HTTP(S) request (also the global `fetch`); a refused or failed request rejects with the reason. */
export declare function fetch(url: string, init?: CardFetchInit): Promise<CardResponse>
/**
 * State like `useState`, kept as JSON in the card's data folder: it starts from the stored value (or from `initial`
 * when the file is absent or unreadable) and every set writes the new value back.
 */
export declare function useStoredState<S>(path: string, initial: S | (() => S)): [S, SetState<S>]

/** The card itself. */
export interface CardHandle {
  /** Show a short notice to the person whose click is being handled (no effect outside a click). */
  toast(content: string, type?: 'info' | 'success' | 'warning' | 'error'): void
  /** Freeze the card: state set in the same handler is shown, then every button is disabled and updates stop. */
  close(): void
  /** Deliver a message to the agent that published the card (rate limited; call it from clicks). */
  send(text: string): SendResult
}

type SetState<S> = (value: S | ((previous: S) => S)) => void
type Deps = readonly unknown[]

export declare function useState<S>(initial: S | (() => S)): [S, SetState<S>]
export declare function useState<S = undefined>(): [S | undefined, SetState<S | undefined>]
export declare function useReducer<S, A>(reducer: (state: S, action: A) => S, initial: S): [S, (action: A) => void]
export declare function useReducer<S, A, I>(reducer: (state: S, action: A) => S, arg: I, init: (arg: I) => S): [S, (action: A) => void]
export declare function useEffect(effect: () => void | (() => void), deps?: Deps): void
export declare function useLayoutEffect(effect: () => void | (() => void), deps?: Deps): void
export declare function useMemo<T>(factory: () => T, deps: Deps): T
export declare function useCallback<T extends (...args: never[]) => unknown>(callback: T, deps: Deps): T
export declare function useRef<T>(initial: T): { current: T }
export declare function useId(): string
export declare function useCard(): CardHandle
/** `<Fragment>` (same as `<>…</>`). */
export declare const Fragment: unique symbol
/** The agent that published the card. */
export declare const agent: { send(text: string): SendResult }

type Theme = 'default' | 'info' | 'success' | 'warning' | 'danger'
type Color = 'default' | 'muted' | 'info' | 'success' | 'warning' | 'danger'
type Align = 'left' | 'center' | 'right'
type ButtonVariant =
  | 'default' | 'primary' | 'danger' | 'text' | 'primary_text' | 'danger_text' | 'primary_filled' | 'danger_filled' | 'laser'

// ---------------------------------------------------------------------------------------------------------------
// Preset components: quick replies and form controls
//
// They are global (no import, no definition), so a card uses them straight away. A click sends a prompt to the agent
// that published the card, which is how a card asks a question and gets an answer.
// ---------------------------------------------------------------------------------------------------------------

/**
 * Who may use a quick reply: an open_id, `'requester'` (default — the person whose message the card answers) or
 * `'anyone'`. A card with no known requester admits everyone.
 */
export type PromptSender = 'requester' | 'anyone' | (string & {})

/** The person a quick reply is addressed to. */
export interface PromptTarget {
  /** `'requester'` (default), `'anyone'`, or one person's open_id. */
  sender?: PromptSender
  /** How that person is named in toasts and in the line a used control leaves (default: their name). */
  senderName?: string
}

/** What every quick reply shares: one click, one message to the agent. */
export interface PromptReply extends PromptTarget {
  /** Restrict to one click (default `true`): the control disappears and its place names who answered. `false` keeps it. */
  once?: boolean
  /** Toast shown to the clicker after the message went out. */
  toast?: string
  /** What replaces the control once used (default `✅ 已选择「label」 · @person`, or `✅ 已提交 …` for a form). */
  done?: Child
}

/** Props of `<PromptButton>`. */
export interface PromptButtonProps extends ButtonStyle, PromptReply {
  /** Text sent to the agent on click (default: the children, read as text). */
  prompt?: string
  children?: Child
}

/** One option of `<PromptChoices>`: a bare string sends its own label. */
export interface PromptChoice {
  label: string
  /** Text sent when this option is picked (default: `label`). */
  prompt?: string
  variant?: ButtonVariant
  theme?: Theme
}

/** Props of `<PromptChoices>`: a row of one-tap answers; the picked row collapses to the answer. */
export interface PromptChoicesProps extends PromptReply {
  options: (string | PromptChoice)[]
  width?: 'auto' | 'fill'
  align?: Align
  variant?: ButtonVariant
  theme?: Theme
  size?: 'tiny' | 'small' | 'medium' | 'large'
}

/** One field of `<PromptForm>`; `type` picks the control (`text` when absent). */
export type PromptField =
  | {
    name: string
    type?: 'text' | 'multiline' | 'password'
    /** Caption above the field. */
    label?: string
    placeholder?: string
    /** Initial text. */
    value?: string
    maxLength?: number
    required?: boolean
    disabled?: boolean
  }
  | { name: string; type: 'checkbox'; label?: string; value?: boolean }
  | {
    name: string
    type: 'select'
    label?: string
    placeholder?: string
    options: (string | { label: string; value: string })[]
    value?: string
    required?: boolean
    disabled?: boolean
  }
  | { name: string; type: 'switch'; label?: string; value?: boolean; onLabel?: string; offLabel?: string; disabled?: boolean }
  | {
    name: string
    type: 'radio' | 'segmented'
    label?: string
    options: (string | { label: string; value: string })[]
    value?: string
    disabled?: boolean
  }
  | {
    name: string
    type: 'number' | 'stepper'
    label?: string
    value?: number
    min?: number
    max?: number
    step?: number
    unit?: string
    disabled?: boolean
  }

/**
 * Props of `<PromptForm>`: `fields`, then one submit that sends the filled text. Button fields
 * (`switch`, `radio`, `number`) are drawn above the platform form, because a `<form>` holds only form components.
 */
export interface PromptFormProps extends PromptReply {
  fields: PromptField[]
  /** Text sent on submit, with `{name}` placeholders of the field values (default: `标签：值` pairs). */
  prompt?: string
  submitLabel?: string
  variant?: ButtonVariant
  /** Form name on the platform; defaults to `prompt-form`. */
  name?: string
}

/** Props of `<Switch>`: a two-button on/off control holding its own state. */
export interface SwitchProps {
  label?: string
  /** Initial state. */
  value?: boolean
  onChange?: (on: boolean) => void
  disabled?: boolean
  /** Labels of the two states (default `关闭` / `开启`). */
  onLabel?: string
  offLabel?: string
  align?: Align
}

/** Props of `<Segmented>`: one choice among options, as filled/unfilled buttons. */
export interface SegmentedProps {
  label?: string
  options: (string | { label: string; value: string })[]
  value?: string
  onChange?: (value: string) => void
  disabled?: boolean
  align?: Align
}

/** Props of `<Stepper>`: a number with − n +, clamped to `min`/`max`. */
export interface StepperProps {
  label?: string
  value?: number
  min?: number
  max?: number
  step?: number
  /** Appended to the number, e.g. `人`. */
  unit?: string
  onChange?: (value: number) => void
  disabled?: boolean
  align?: Align
}

/** One capability entry accepted by `<AuthRequest capabilities={[…]} />`. */
export interface AuthCapabilityOption {
  /** Registered capability id, e.g. `'feishu-project'`. */
  id: string
  /** Optional display label overriding the capability provider's default title. */
  label?: string
  /** Optional short description shown under the capability name. */
  description?: string
  /** Whether the checkbox starts checked when multiple capabilities are listed (default `true`). */
  defaultChecked?: boolean
}

/**
 * Props of `<AuthRequest>`: request session exclusivity and capability grants via trusted host actions.
 * Unlike quick replies, `sender` defaults to `'anyone'` — whoever clicks authorizes with their own identity and
 * claims session exclusivity (when not already exclusive); pass an explicit `sender` to restrict who may click.
 */
export interface AuthRequestProps extends PromptTarget {
  /** Capabilities to request; omit or pass `[]` to claim pure session exclusivity. */
  capabilities?: (string | AuthCapabilityOption)[]
  /** Why authorization / exclusivity is needed. */
  reason?: string
  /** Optional heading shown above the request. */
  title?: string
  /** Optional confirmation dialog before granting. */
  confirm?: { title: string; text: string }
  /** Optional replacement content once granted (used when no active revocable capabilities remain). */
  done?: Child
}

/** A quick reply: one click sends `prompt` to the agent. */
export declare const PromptButton: (props: PromptButtonProps) => JSX.Element
/** A row of one-tap answers; the picked row collapses to the answer. */
export declare const PromptChoices: (props: PromptChoicesProps) => JSX.Element
/** A few fields and one submit that sends them as one prompt. */
export declare const PromptForm: (props: PromptFormProps) => JSX.Element
/** A stateful on/off toggle. */
export declare const Switch: (props: SwitchProps) => JSX.Element
/** A stateful single choice among options. */
export declare const Segmented: (props: SegmentedProps) => JSX.Element
/** A stateful number with − n +. */
export declare const Stepper: (props: StepperProps) => JSX.Element
/** Request session exclusivity and capability grants via trusted host actions. */
export declare const AuthRequest: (props: AuthRequestProps) => JSX.Element

/** Presentation shared by every button. */
interface ButtonStyle {
  theme?: Theme
  /** Exact Feishu button type; wins over `theme`. */
  variant?: ButtonVariant
  size?: 'tiny' | 'small' | 'medium' | 'large'
  /** `default` (fits the label), `fill` (the available width) or pixels. */
  width?: 'default' | 'fill' | number
  /** Feishu standard icon token, e.g. `done_outlined`. */
  icon?: string
  /** Confirmation dialog before the click takes effect. */
  confirm?: { title: string; text: string }
  /** Hover text. */
  tip?: string
  disabled?: boolean
  /** Hover text while disabled. */
  disabledTip?: string
}

type WithChildren<A = {}> = A & { children?: Child; key?: string | number }

/** An action button (with or without a handler: without one it is an inert label), a link button or a form submit. */
type ButtonProps =
  | WithChildren<ButtonStyle & { type?: 'action'; onClick?: (event: ClickEvent) => void | Promise<void>; data?: string }>
  | WithChildren<ButtonStyle & { type: 'submit'; onClick: (event: ClickEvent) => void | Promise<void>; data?: string }>
  | WithChildren<ButtonStyle & { type: 'link'; href: string }>

/** Presentation and form identity shared by both kinds of `<select>`. */
interface SelectStyle {
  /** Callback identity; only meaningful together with `onSelect`. */
  id?: string
  /** Form key: the name its value takes in the enclosing `<form>`'s submit. */
  name?: string
  placeholder?: string
  /** Initially chosen option value(s); an `<option selected>` works too. */
  value?: string | string[]
  required?: boolean
  disabled?: boolean
  data?: string
}

/**
 * A dropdown. `onSelect` receives the pick: a `multiple` select reports each pick too, with the options chosen so
 * far. Inside a `<form>` the submit additionally carries the settled value as `ClickEvent.values[name]`.
 */
type SelectProps = WithChildren<
  SelectStyle & { multiple?: boolean; onSelect?: (event: SelectEvent) => void | Promise<void> }
>

/** Presentation of a form control; the text kinds need a form key, a checkbox may report itself instead. */
interface InputStyle {
  type?: 'text' | 'multiline' | 'password' | 'checkbox'
  /** The caption above a text field, or the label of a checkbox. */
  label?: string
  placeholder?: string
  /** Initial value: the text of a field, the state of a checkbox. */
  value?: string | boolean
  maxLength?: number
  required?: boolean
  disabled?: boolean
  /** A checkbox toggle, with the state after it. Only `type="checkbox"` reports itself. */
  onChange?: (event: CheckEvent) => void | Promise<void>
}

/** A form control: `name` is its form key, and a checkbox may additionally report its own toggles. */
type InputProps = WithChildren<InputStyle & { name: string }>

declare global {
  /** A quick reply: one click sends `prompt` to the agent (one-time and restricted to the requester by default). */
  function PromptButton(props: PromptButtonProps): JSX.Element
  /** A row of one-tap answers; the picked row collapses to the answer. */
  function PromptChoices(props: PromptChoicesProps): JSX.Element
  /** A few fields and one submit that sends them as one prompt. */
  function PromptForm(props: PromptFormProps): JSX.Element
  /** A stateful on/off toggle. */
  function Switch(props: SwitchProps): JSX.Element
  /** A stateful single choice among options. */
  function Segmented(props: SegmentedProps): JSX.Element
  /** A stateful number with − n +. */
  function Stepper(props: StepperProps): JSX.Element
  /** Request session exclusivity and capability grants via trusted host actions. */
  function AuthRequest(props: AuthRequestProps): JSX.Element

  /**
   * Timers of the card: they run only while the card is loaded, never revive it, and an interval runs at most every
   * 100 ms; each state change re-publishes the card.
   */
  function setTimeout(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): number
  function clearTimeout(id: number | undefined): void
  function setInterval(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): number
  function clearInterval(id: number | undefined): void
  function queueMicrotask(callback: () => void): void
  /** Card logs go to the bot's log, not to the chat. */
  const console: {
    log(...args: unknown[]): void
    info(...args: unknown[]): void
    debug(...args: unknown[]): void
    warn(...args: unknown[]): void
    error(...args: unknown[]): void
  }

  /** The card's data folder: the only files a card may touch. */
  const fs: CardFs
  /** State like `useState`, stored as JSON in the card's data folder. */
  function useStoredState<S>(path: string, initial: S | (() => S)): [S, SetState<S>]
  /** One HTTP(S) request, bounded by the deployment's rules. */
  function fetch(url: string, init?: CardFetchInit): Promise<CardResponse>

  namespace JSX {
    /** What a JSX expression produces. */
    interface Element { readonly $$vnode: true }
    interface ElementChildrenAttribute { children: {} }
    interface IntrinsicAttributes { key?: string | number }
    /** Exactly the elements a Feishu card renders; anything else is a type error. */
    interface IntrinsicElements {
      message: WithChildren
      /** Card header; `theme` colors it. */
      title: WithChildren<{ subtitle?: string; theme?: Theme }>
      p: WithChildren
      b: WithChildren
      i: WithChildren
      s: WithChildren
      code: WithChildren
      a: WithChildren<{ href: string }>
      at: WithChildren<{ type: 'user'; id: string } | { type: 'all' }>
      span: WithChildren<{ color?: Color }>
      br: WithChildren
      h1: WithChildren
      h2: WithChildren
      h3: WithChildren
      h4: WithChildren
      h5: WithChildren
      h6: WithChildren
      ul: WithChildren
      ol: WithChildren<{ start?: number }>
      li: WithChildren<{ checked?: boolean }>
      blockquote: WithChildren
      pre: WithChildren<{ lang?: string }>
      hr: WithChildren
      table: WithChildren
      tr: WithChildren
      th: WithChildren<{ align?: Align }>
      td: WithChildren<{ align?: Align }>
      /** Collapsible panel; its first child is a `<summary>`. */
      details: WithChildren<{ open?: boolean }>
      summary: WithChildren
      /** Caption-sized text. */
      small: WithChildren
      img: WithChildren<{ src: string; alt?: string; width?: number; height?: number }>
      button: ButtonProps
      /** A row of buttons; `width="fill"` makes equal-width columns. */
      'button-group': WithChildren<{ width?: 'auto' | 'fill'; align?: Align }>
      /**
       * A dropdown (see `SelectProps`). A single select reports its pick through `onSelect`; a `multiple` one is
       * reported only by the submit of the form it stands in. A card republishes its whole message on every change, so
       * pass the submitted value back as `value` or the next republish shows the control empty.
       */
      select: SelectProps
      /** One choice of a `<select>`; its label is the children. */
      option: WithChildren<{ value: string; selected?: boolean }>
      /** Groups form controls so one submit button sends their values together (as `ClickEvent.values`). */
      form: WithChildren<{ name: string }>
      /**
       * A form control. `type="checkbox"` is the platform's checkbox — the one control that reports itself, through
       * `onChange`; every other type reaches a handler only through the `<form>`'s submit button.
       */
      input: InputProps
      /** GFM markdown source rendered as card markdown. */
      markdown: WithChildren<{ content?: string }>
    }
  }
}
