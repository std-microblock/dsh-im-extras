/**
 * The card VM's global object, as the runtime sees it.
 *
 * The runtime is evaluated as a plain script inside a QuickJS VM (`quickjs-wasi`), so it has neither a module system
 * nor any host API: everything it may touch is installed by the host before the script runs (`__host`) or by the
 * runtime itself for the card module that is evaluated after it (`useState`, `PromptButton`, `setTimeout`, …).
 *
 * These declarations are hand-written on purpose. The VM is neither a browser nor Node, so `lib.dom` and
 * `@types/node` would both describe globals that do not exist inside it — and a call to one of them would fail only
 * at click time, in a VM whose error the operator has to dig out of the log.
 *
 * @module dsh-im-card/vm/globals
 */

/** What the host tells a card about its audience, set with `globalThis.__cardContext` before the mount. */
export interface CardContext {
  /** The person whose message the card answers: the default owner of its quick replies. */
  requester?: { id: string; name?: string }
}

/** `console` inside the VM: every line goes out as the host's `log` op. */
export interface VmConsole {
  log(...args: unknown[]): void
  info(...args: unknown[]): void
  debug(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/**
 * A timer callback. Card code passes anything; its arguments are handed back unchanged.
 *
 * `any[]` and not `unknown[]`: a callback declared with parameters (`(x: number) => void`) has to stay assignable to
 * it, and the values come out of a VM with no type checking either way.
 */
export type TimerCallback = (...args: any[]) => void

/** The JSX factory a card bundle calls: `__jsx__(tag, attrs, childrenArray)`, always three arguments. */
export type JsxFactory = (
  type: unknown,
  attrs: Record<string, unknown> | null | undefined,
  kids: unknown[] | null | undefined,
) => unknown

/** The variadic factory esbuild's classic transform emits into a card bundle: `h(tag, props, ...children)`. */
export type VNodeFactory = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => unknown

/** What the service drives a live card through (`globalThis.__card`); a card bundle never touches it. */
export interface CardHostApi {
  /** Start a card from its default export (a component or an element) and its props. */
  mount(component: unknown, propsJson: string | null): void
  /** Render the mounted tree: `{ ok: true, tree }` or `{ ok: false, error }`, as JSON. */
  render(): string
  /** Run the handler a token belongs to: `{ found }`, as JSON. */
  click(token: string, eventJson: string | null): string
  /** The earliest due timer (epoch ms) or -1. */
  nextTimer(): number
  /** Run every timer due at `nowMs`. */
  fireTimers(nowMs: number): void
  /** Settle one request the card is waiting on: `{ found }`, as JSON. */
  settleFetch(id: string, replyJson: string): string
  /** Deliver one host-originated event to subscribed preset components: `{ handled }`, as JSON. */
  pushEvent(channel: string, dataJson: string): string
  /** Freeze the card: cleanups run and everything the VM held is dropped. */
  unmount(): void
}

/** The VM's global object. Members are either read by the runtime or assigned by it while it initialises. */
export interface VmGlobal {
  /** The host bridge: strings in, string out. The one entry the host installs before the runtime runs. */
  __host(op: string, payload: string): string
  console: VmConsole
  queueMicrotask(fn: () => void): void
  setTimeout(fn: TimerCallback, ms?: number, ...args: unknown[]): number
  setInterval(fn: TimerCallback, ms?: number, ...args: unknown[]): number
  clearTimeout(id: unknown): void
  clearInterval(id: unknown): void
  /** The JSX factory of `dsh:card` cards. */
  __jsx__: JsxFactory
  /** The marker `<>…</>` compiles to. */
  __fragment__: symbol
  /** The variadic factory esbuild emits into a card bundle. */
  __h__: VNodeFactory
  /** The host-facing entry (see {@link CardHostApi}). */
  __card: CardHostApi
  /** The hooks, `Fragment`, `agent`, `fs`, `fetch` and the presets, as the module `dsh:card` exports them. */
  __cardApi: unknown
  /** What the host published about the card's audience; absent when it knows nothing. */
  __cardContext?: CardContext
}

/** The VM global object, typed. */
export const g = globalThis as unknown as VmGlobal

/**
 * Install one global a card module uses by name (`useState`, `PromptButton`, …).
 * @param name - the global's name.
 * @param value - what a card sees under it.
 */
export function setGlobal(name: string, value: unknown): void {
  ;(globalThis as unknown as Record<string, unknown>)[name] = value
}
