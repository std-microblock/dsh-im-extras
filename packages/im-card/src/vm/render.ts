/**
 * The renderer: vnodes in, card nodes out.
 *
 * There is no virtual DOM and no diff. A render walks the whole tree, calls every component, collects the element
 * nodes, and the host republishes the resulting card. What survives between renders is the component instances: their
 * hooks live there, keyed by *instance path* (parent path + position + component name), so a component that keeps its
 * position keeps its state.
 *
 * Interactions are routed by *token*: a `button` with an `onClick`, a `select` with an `onSelect` and a checkbox
 * `input` with an `onChange` get a random token as their `id`, and `click(token, event)` runs the handler of that
 * token. A token is remembered by position key (instance path + position within the instance's output, with keys
 * replacing indexes), so the id of a button stays the same across re-renders — a click that arrives late still lands
 * on the button the person saw.
 *
 * Bounds are checked here because a card is model-written code: nesting depth, node count and render-phase update
 * loops all have a limit, and deep recursion is stopped before it traps the WASM stack instead of throwing.
 *
 * @module dsh-im-card/vm/render
 */
import { context, type Handler, type Instance, type Pass } from './context.ts'
import { errorText, formatArg, host, reportError } from './host.ts'
import { rejectPendingRequests } from './http.ts'
import { Fragment, isVNode, jsx, type VNode } from './jsx.ts'
import { clearTimers } from './timers.ts'

/** One node of the output tree: an element `{ t: tag, a: attrs, c: children }` or text `{ t: 'text', a: { content } }`. */
export interface CardNode {
  t: string
  a: Record<string, unknown>
  c: CardNode[]
}

/**
 * A component: a function of its props, returning anything {@link walk} accepts.
 *
 * `any` for the props: a card picks their type, and the runtime never reads them.
 */
export type Component = (props: any) => unknown

const MAX_COMPONENT_DEPTH = 64
/** Deep recursion traps the WASM stack instead of throwing, so nesting is capped well before that. */
const MAX_ELEMENT_DEPTH = 256
const MAX_NODES = 2000
const MAX_PASSES = 25

/** The mounted root: a vnode, once `mount` ran. */
let root: VNode | null = null
/** Committed component instances, by instance path. */
let instances = new Map<string, Instance>()
/** Committed position key → token. */
let tokens = new Map<string, string>()
/** Committed token → handler. */
let handlers = new Map<string, Handler>()

/** A render is due; set between the state change and the host's `render()` call. */
let dirty = false
/** A render pass is running. */
let rendering = false
/** A component updated itself during its own render; another pass of the same render is needed. */
let renderPhaseUpdate = false

/** A component instance at a path, with no hooks yet. */
function newInstance(path: string, name: string): Instance {
  return { path, name, hooks: [], unmounted: false }
}

/**
 * Ask for a render.
 *
 * Called by a state setter. During a render it only marks the pass as needing another one (a component that sets its
 * own state while rendering); otherwise the host is told once per dirty cycle, and it decides when to call `render`.
 */
export function markDirty(): void {
  if (rendering) {
    renderPhaseUpdate = true
    return
  }
  if (!dirty) {
    dirty = true
    host('schedule', '')
  }
}

/** The pass in progress; every function below runs inside one. */
function pass(): Pass {
  const current = context.pass
  if (current === null) throw new Error('the renderer is not walking a pass')
  return current
}

/**
 * A token for one position, reusing the one it had last render.
 * @param posKey - instance path and position within the instance's output.
 */
function tokenFor(posKey: string): string {
  const current = pass()
  const known = current.tokens.get(posKey)
  if (known !== undefined) return known
  let token = tokens.get(posKey)
  // A position that had no token, or whose token another position already took this pass (a duplicate key), mints one.
  if (token === undefined || current.handlers.has(token)) {
    do token = randomToken()
    while (current.handlers.has(token) || handlers.has(token))
  }
  current.tokens.set(posKey, token)
  return token
}

/** A random token: ten lowercase base-36 characters. */
function randomToken(): string {
  let s = ''
  while (s.length < 10) s += Math.random().toString(36).slice(2)
  return s.slice(0, 10)
}

/**
 * Convert an attribute value to a JSON-safe value.
 * @param v - the value a card passed.
 * @param depth - nesting depth, bounded so a deep object cannot cost a whole pass.
 * @returns the value to emit, or `undefined` for "drop it": `null`, functions, symbols, non-finite numbers, vnodes and
 * non-plain objects never reach the output (nor anything inside them).
 */
function jsonSafe(v: unknown, depth: number): unknown {
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return v
    case 'number':
      return Number.isFinite(v) ? v : undefined
    case 'object': {
      if (v === null || depth > 16 || isVNode(v)) return undefined
      if (Array.isArray(v)) return v.map((x) => jsonSafe(x, depth + 1)).filter((x) => x !== undefined)
      const proto = Object.getPrototypeOf(v)
      if (proto !== Object.prototype && proto !== null) return undefined
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(v)) {
        const s = jsonSafe((v as Record<string, unknown>)[k], depth + 1)
        if (s !== undefined) out[k] = s
      }
      return out
    }
    default:
      return undefined // undefined, function, symbol, bigint
  }
}

/**
 * Append one node, counting against {@link MAX_NODES}.
 * @param out - the node list being built.
 * @param node - the node to append.
 */
function pushNode(out: CardNode[], node: CardNode): void {
  if (++pass().nodes > MAX_NODES) throw new Error('card output exceeds ' + MAX_NODES + ' nodes')
  out.push(node)
}

/**
 * Render `value` into `out`.
 * @param value - anything a component returned: vnode, string, number, array, `null`/`undefined`/boolean (nothing).
 * @param inst - the instance whose output this is.
 * @param pos - position within that instance's output; children extend it with `>`.
 * @param out - the node list being built.
 * @param depth - component nesting depth.
 * @param elDepth - element nesting depth.
 * @param keyed - whether `pos` already encodes this vnode's key (array children do).
 */
function walk(
  value: unknown,
  inst: Instance,
  pos: string,
  out: CardNode[],
  depth: number,
  elDepth: number,
  keyed: boolean,
): void {
  if (value == null || typeof value === 'boolean' || typeof value === 'function') return
  if (typeof value === 'string') {
    if (value !== '') pushNode(out, { t: 'text', a: { content: value }, c: [] })
    return
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    pushNode(out, { t: 'text', a: { content: String(value) }, c: [] })
    return
  }
  if (Array.isArray(value)) {
    const usedKeys = new Set<string>()
    for (let i = 0; i < value.length; i++) {
      const child: unknown = value[i]
      const key = isVNode(child) && child.key !== null ? child.key : null
      // A duplicate key falls back to the index so positions (and tokens) stay unique.
      const useKey = key !== null && !usedKeys.has(key)
      if (useKey) usedKeys.add(key)
      walk(child, inst, pos + '.' + (useKey ? '$' + key : String(i)), out, depth, elDepth, true)
    }
    return
  }
  if (!isVNode(value)) throw new Error('objects are not valid as a card child: ' + formatArg(value))

  if (value.key != null && !keyed) pos += '$' + value.key
  const { type, props } = value

  if (type === Fragment) {
    walk(props.children, inst, pos + '>', out, depth, elDepth, false)
    return
  }

  if (typeof type === 'function') {
    if (depth + 1 > MAX_COMPONENT_DEPTH) throw new Error('component nesting too deep')
    const name = (type as { name?: string }).name || 'anonymous'
    const path = inst.path + '/' + pos + ':' + name
    let child = instances.get(path) || pass().pending.get(path)
    if (child === undefined) {
      child = newInstance(path, name)
      pass().pending.set(path, child)
    }
    if (pass().seen.has(path)) throw new Error('duplicate component position ' + path)
    pass().seen.set(path, child)
    const prevInstance = context.instance
    const prevHookIndex = context.hookIndex
    context.instance = child
    context.hookIndex = 0
    let result: unknown
    try {
      result = (type as Component)(props)
    } finally {
      context.instance = prevInstance
      context.hookIndex = prevHookIndex
    }
    walk(result, child, '', out, depth + 1, elDepth, false)
    return
  }

  if (typeof type !== 'string') throw new TypeError('invalid element type: ' + String(type))
  if (elDepth + 1 > MAX_ELEMENT_DEPTH) throw new Error('element nesting too deep')

  const attrs: Record<string, unknown> = {}
  let handler: Handler | null = null
  for (const k of Object.keys(props)) {
    if (k === 'children') continue
    const v = props[k]
    if (typeof v === 'function') {
      // Only the controls the platform reports get a token; any other function prop is not an attribute.
      if (type === 'button' && k === 'onClick') handler = v as Handler
      else if (type === 'select' && k === 'onSelect') handler = v as Handler
      else if (type === 'input' && k === 'onChange') handler = v as Handler
      continue
    }
    const s = jsonSafe(v, 0)
    if (s !== undefined) attrs[k] = s
  }
  if (handler !== null) {
    const token = tokenFor(inst.path + '|' + pos)
    attrs.id = token
    if (type === 'button' && attrs.type === undefined) attrs.type = 'action'
    pass().handlers.set(token, handler)
  } else if (type === 'button' && attrs.type === undefined) {
    // A button without a handler is a label: it still needs a type, and its click finds no handler.
    attrs.type = 'action'
    if (attrs.id === undefined) attrs.id = 'inert'
  }
  const node: CardNode = { t: type, a: attrs, c: [] }
  pushNode(out, node)
  walk(props.children, inst, pos + '>', node.c, depth, elDepth + 1, false)
}

/** The root's instance: it owns `root` and nothing else, so the tree has one instance path prefix. */
const rootInstance = newInstance('', 'root')

/** What one pass produced. */
interface PassResult {
  tree: CardNode[]
  pass: Pass
}

/**
 * Run one render pass: walk the root and collect its nodes, instances, tokens and effects.
 * @param pending - instances an earlier pass of the same render already created.
 */
function renderPass(pending: Map<string, Instance>): PassResult {
  const current: Pass = { pending, seen: new Map(), tokens: new Map(), handlers: new Map(), effects: [], nodes: 0 }
  context.pass = current
  context.instance = null
  context.hookIndex = 0
  const tree: CardNode[] = []
  if (root !== null) walk(root, rootInstance, '', tree, 0, 0, false)
  return { tree, pass: current }
}

/**
 * Mark an instance gone and run the cleanups of its effects.
 * @param inst - the instance.
 */
function unmountInstance(inst: Instance): void {
  inst.unmounted = true
  for (const h of inst.hooks) {
    if (h !== undefined && h.kind === 'effect' && typeof h.cleanup === 'function') {
      const cleanup = h.cleanup
      h.cleanup = undefined
      try {
        cleanup()
      } catch (e) {
        reportError(e)
      }
    }
  }
}

/**
 * Adopt a pass: instances the pass did not reach are gone, tokens and handlers become the committed ones, and the
 * effects run — all cleanups of re-running effects first, then all effect bodies, in React's order.
 * @param done - the pass to adopt.
 */
function commit(done: Pass): void {
  for (const [path, inst] of instances) if (!done.seen.has(path)) unmountInstance(inst)
  instances = done.seen
  tokens = done.tokens
  handlers = done.handlers
  for (const e of done.effects) {
    const cleanup = e.hook.cleanup
    e.hook.cleanup = undefined
    if (typeof cleanup === 'function') {
      try {
        cleanup()
      } catch (err) {
        reportError(err)
      }
    }
  }
  for (const e of done.effects) {
    e.hook.mounted = true
    e.hook.deps = e.deps
    try {
      const cleanup = e.fn()
      if (typeof cleanup === 'function') e.hook.cleanup = cleanup as () => void
    } catch (err) {
      reportError(err)
    }
  }
}

/**
 * Render the mounted tree.
 * @returns `{ ok: true, tree }` or `{ ok: false, error }`, as JSON. A failing render keeps the committed state, so the
 * next render can still succeed.
 */
export function render(): string {
  dirty = false
  if (root == null) return JSON.stringify({ ok: true, tree: [] })
  const pending = new Map<string, Instance>()
  let result: PassResult | undefined
  rendering = true
  try {
    for (let n = 1; ; n++) {
      renderPhaseUpdate = false
      result = renderPass(pending)
      if (!renderPhaseUpdate) break
      if (n >= MAX_PASSES) throw new Error('too many re-renders')
    }
  } catch (e) {
    return JSON.stringify({ ok: false, error: errorText(e) })
  } finally {
    rendering = false
    context.instance = null
    context.pass = null
  }
  commit(result!.pass)
  return JSON.stringify({ ok: true, tree: result!.tree })
}

/**
 * Start a card.
 * @param component - the default export: a component function or an element.
 * @param propsJson - the props of that component, as JSON (`null`/absent for none).
 * @throws TypeError when the default export is neither.
 */
export function mount(component: unknown, propsJson: string | null): void {
  if (root != null) unmount()
  if (isVNode(component)) root = component
  else if (typeof component === 'function') root = jsx(component, propsJson ? (JSON.parse(propsJson) as Record<string, unknown>) : {}, [])
  else throw new TypeError('card default export must be a component function or an element')
}

/**
 * Run the handler of one interaction token.
 * @param token - the `id` the platform sent back.
 * @param eventJson - the event the platform reported, as JSON.
 * @returns `{ found }`, as JSON: `false` when no handler sits at that token (the card moved on).
 */
export function click(token: string, eventJson: string | null): string {
  const handler = handlers.get(String(token))
  if (handler === undefined) return JSON.stringify({ found: false })
  try {
    const event = eventJson ? JSON.parse(eventJson) : {}
    const r = handler(event)
    if (r !== null && typeof r === 'object' && typeof (r as { then?: unknown }).then === 'function') {
      ;(r as Promise<unknown>).then(undefined, reportError)
    }
  } catch (e) {
    reportError(e)
  }
  return JSON.stringify({ found: true })
}

/**
 * Freeze the card: run every cleanup, drop the tree, the handlers and the timers, and reject the requests still
 * waiting — nobody will answer the promises a card is blocked on once its VM is gone.
 */
export function unmount(): void {
  for (const inst of instances.values()) unmountInstance(inst)
  instances = new Map()
  tokens = new Map()
  handlers = new Map()
  root = null
  dirty = false
  rejectPendingRequests('the card was closed')
  clearTimers()
}
