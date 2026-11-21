/**
 * The hooks.
 *
 * They are React's, restricted to what a card needs: no virtual DOM, so a state change only marks the card dirty and
 * the whole tree renders again. A hook is stored on the instance whose component is executing, in call order, which is
 * why their order may not change between renders (that is reported instead of silently mixing up slots).
 *
 * @module dsh-im-card/vm/hooks
 */
import {
  context,
  type EffectHook,
  type Hook,
  type HookKind,
  type Instance,
  type MemoHook,
  type Reducer,
  type StateHook,
} from './context.ts'
import { markDirty } from './render.ts'

/** The setter of a `useState`: a value, or a function of the previous one. */
export type SetState<S> = (next: S | ((previous: S) => S)) => void

/** Numbering behind `useId`; a VM carries it, so a restored card keeps numbering where it left off. */
let idCounter = 0

/**
 * Take the hook at the current position, creating it on the first render of its instance.
 * @param kind - the hook's kind; a different one than last render is an order change.
 * @param create - builds the hook's initial state.
 * @returns that same hook object on every render of the instance.
 */
function nextHook<K extends HookKind>(kind: K, create: (inst: Instance) => Extract<Hook, { kind: K }>): Extract<Hook, { kind: K }> {
  const inst = context.instance
  if (inst === null) throw new Error('hooks can only be called while rendering a component')
  const i = context.hookIndex++
  const existing: Hook | undefined = inst.hooks[i]
  if (existing === undefined) {
    const hook = create(inst)
    inst.hooks[i] = hook
    return hook
  }
  if (existing.kind !== kind) {
    throw new Error('hook order changed between renders (expected ' + existing.kind + ', got ' + kind + ')')
  }
  return existing as Extract<Hook, { kind: K }>
}

/**
 * Whether an effect or a memo has to run again.
 * @param prev - the deps of the previous render (`undefined` means "no deps given", i.e. every render).
 * @param next - the deps of this render.
 */
function depsChanged(prev: readonly unknown[] | undefined, next: readonly unknown[] | undefined): boolean {
  if (next == null || prev == null) return true
  if (prev.length !== next.length) return true
  for (let i = 0; i < next.length; i++) if (!Object.is(prev[i], next[i])) return true
  return false
}

/**
 * State with a reducer.
 * @param reducer - computes the next state from the current one and the action.
 * @param initialArg - the initial state, or the argument `init` takes.
 * @param init - optional lazy initializer.
 * @returns the current state and its dispatch.
 */
export function useReducer<S, A>(
  reducer: (state: S, action: A) => S,
  initialArg: S,
  init?: (arg: S) => S,
): [S, (action: A) => void] {
  const hook = nextHook('state', (inst) => {
    const h: StateHook = {
      kind: 'state',
      value: init === undefined ? initialArg : init(initialArg),
      reducer: reducer as Reducer,
      dispatch: () => {},
    }
    h.dispatch = (action: unknown) => {
      if (inst.unmounted) return
      const next = h.reducer(h.value, action)
      if (Object.is(next, h.value)) return
      h.value = next
      markDirty()
    }
    return h
  })
  // The dispatch reads the reducer through the hook, so a render always dispatches with the latest one.
  hook.reducer = reducer as Reducer
  return [hook.value as S, hook.dispatch as (action: A) => void]
}

/**
 * The reducer of `useState`: an action is the next value, or a function of the previous one.
 * @param prev - the current state.
 * @param action - what was passed to the setter.
 */
function stateReducer<S>(prev: S, action: S | ((previous: S) => S)): S {
  return typeof action === 'function' ? (action as (previous: S) => S)(prev) : action
}

/**
 * Resolve a `useState` initial value, calling it when it is a function.
 * @param initial - the value, or a factory of it.
 */
function resolveInitial<S>(initial: S | (() => S)): S {
  return typeof initial === 'function' ? (initial as () => S)() : initial
}

/**
 * Local state of a component.
 * @param initial - the initial value, or a factory of it (called once).
 * @returns the value and its setter.
 */
export function useState<S>(initial: S | (() => S)): [S, SetState<S>] {
  return useReducer<S, S | ((previous: S) => S)>(stateReducer, initial as S, resolveInitial)
}

/**
 * Run a side effect after the render that committed it; the cleanup runs before the next run and on unmount.
 * @param fn - the effect, optionally returning its cleanup.
 * @param deps - run again when one of these changes; absent means every render.
 */
export function useEffect(fn: () => unknown, deps?: readonly unknown[]): void {
  const hook = nextHook('effect', (): EffectHook => ({ kind: 'effect', mounted: false, deps: undefined, cleanup: undefined }))
  const pass = context.pass
  if (pass === null) throw new Error('hooks can only be called while rendering a component')
  if (!hook.mounted || depsChanged(hook.deps, deps)) pass.effects.push({ hook, fn, deps })
}

/**
 * A value computed once per change of its deps.
 * @param fn - computes the value.
 * @param deps - recompute when one of these changes.
 */
export function useMemo<T>(fn: () => T, deps: readonly unknown[]): T {
  const hook = nextHook('memo', (): MemoHook => ({ kind: 'memo', computed: false, deps: undefined, value: undefined }))
  if (!hook.computed || depsChanged(hook.deps, deps)) {
    hook.value = fn()
    hook.deps = deps
    hook.computed = true
  }
  return hook.value as T
}

/**
 * A function kept identical while its deps do not change.
 * @param fn - the function.
 * @param deps - the deps.
 */
export function useCallback<T>(fn: T, deps: readonly unknown[]): T {
  return useMemo(() => fn, deps)
}

/**
 * A mutable box that survives renders.
 * @param initial - its initial `current`.
 */
export function useRef<T>(initial: T): { current: T } {
  return nextHook('ref', () => ({ kind: 'ref', ref: { current: initial } })).ref as { current: T }
}

/** An id that is stable across renders of one instance (`c1`, `c2`, …). */
export function useId(): string {
  return nextHook('id', () => ({ kind: 'id', id: 'c' + ++idCounter })).id
}
