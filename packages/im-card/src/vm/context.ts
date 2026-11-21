/**
 * The render model: what a component instance is, what a hook holds, and the mutable context one render pass keeps.
 *
 * The renderer (`render.ts`) and the hooks (`hooks.ts`) are the two halves of the same mechanism and cannot be split
 * further: a hook is stored on an instance the renderer owns, and a state change has to ask the renderer for a new
 * pass. They therefore share this module — the types they both describe and the context object they both advance —
 * and never call each other's internals.
 *
 * @module dsh-im-card/vm/context
 */

/** The handler of one interaction token: a button's `onClick`, a select's `onSelect` or a checkbox's `onChange`. */
export type Handler = (event: unknown) => unknown

/** A reducer of `useReducer`, and the dispatched action of it. */
// `any` here is the point: a card picks both types, and the runtime only ever moves them around.
export type Reducer = (state: any, action: any) => any

/** What `useEffect` may return: a cleanup. */
export type Cleanup = () => void

/** A `useState`/`useReducer` slot. */
export interface StateHook {
  kind: 'state'
  value: unknown
  reducer: Reducer
  dispatch: (action: unknown) => void
}

/** A `useEffect` slot: its deps, its cleanup, and whether it ever ran. */
export interface EffectHook {
  kind: 'effect'
  mounted: boolean
  deps: readonly unknown[] | undefined
  cleanup: Cleanup | undefined
}

/** A `useMemo`/`useCallback` slot. */
export interface MemoHook {
  kind: 'memo'
  computed: boolean
  deps: readonly unknown[] | undefined
  value: unknown
}

/** A `useRef` slot. */
export interface RefHook {
  kind: 'ref'
  ref: { current: unknown }
}

/** A `useId` slot. */
export interface IdHook {
  kind: 'id'
  id: string
}

/** One hook of one component instance, in call order. */
export type Hook = StateHook | EffectHook | MemoHook | RefHook | IdHook

/** The kind of a hook, as {@link Hook} discriminates them. */
export type HookKind = Hook['kind']

/** One component instance: its position, its hooks, and whether it was unmounted. */
export interface Instance {
  /** Instance path: the root's is `''`, a child's is its parent's path, position and component name. */
  path: string
  /** Component name, for the instance path and error messages. */
  name: string
  /** Hooks in call order; a gap means the component called fewer hooks this render (reported as an order change). */
  hooks: Hook[]
  /** Set by {@link unmountInstance}: a late `setState` of a gone component does nothing. */
  unmounted: boolean
}

/** One effect to run after a pass commits. */
export interface EffectEntry {
  hook: EffectHook
  fn: () => unknown
  deps: readonly unknown[] | undefined
}

/** One render pass: what it produced, and what it saw. */
export interface Pass {
  /** Instances that existed before this render and may still be reused. */
  pending: Map<string, Instance>
  /** Instances this pass reached, by path — the next {@link Instance} map once it commits. */
  seen: Map<string, Instance>
  /** Position key → token, for this pass. */
  tokens: Map<string, string>
  /** Token → handler, for this pass. */
  handlers: Map<string, Handler>
  /** Effects to run once the pass commits. */
  effects: EffectEntry[]
  /** Nodes pushed so far, bounded by `MAX_NODES`. */
  nodes: number
}

/** The per-pass render context: which component is executing, and how far through its hooks it is. */
export const context: {
  /** The instance whose component is executing, if any. */
  instance: Instance | null
  /** Index of the next hook of {@link instance}. */
  hookIndex: number
  /** The pass in progress. */
  pass: Pass | null
} = {
  instance: null,
  hookIndex: 0,
  pass: null,
}
