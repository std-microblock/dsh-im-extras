/**
 * VNodes and the JSX factories.
 *
 * JSX in this package compiles with esbuild's classic transform to `h(tag, props, ...children)`, and `h` is what the
 * presets in `presets/` are written against. A *card* bundle compiles to the same shape with `__h__`, which is the
 * same function republished as a global, plus `__jsx__(tag, attrs, kids)` — the three-argument form the harness's own
 * transpiler emits. Both end in {@link jsx}, and a vnode stays lazy: nothing runs until the renderer reaches it.
 *
 * @module dsh-im-card/vm/jsx
 */
import { g } from './globals.ts'

/** The marker `<>…</>` compiles to; `Symbol.for` so a restored snapshot keeps the same identity. */
export const Fragment: symbol = Symbol.for('dsh.card.fragment')

/** A lazy element: the renderer calls {@link VNode.type} when it reaches this node. */
export interface VNode {
  readonly $$vnode: true
  /** A tag name, a component function, or {@link Fragment}. */
  readonly type: unknown
  /** Attributes without `key`; `children` collects whatever was passed inside the element. */
  readonly props: Record<string, unknown>
  /** Position identity for a keyed child; absent from `props` so a card never sees it as an attribute. */
  readonly key: string | null
}

/**
 * Whether a value is a vnode.
 * @param v - any value a component returned or a card passed as a child.
 */
export function isVNode(v: unknown): v is VNode {
  return v !== null && typeof v === 'object' && (v as { $$vnode?: unknown }).$$vnode === true
}

/**
 * Build a lazy vnode.
 * @param type - a tag name, a component function or {@link Fragment}.
 * @param attrs - attributes as written; `key` is taken out of them.
 * @param kids - the children, in order. One child becomes `props.children` as is, several as an array.
 * @returns the vnode.
 */
export function jsx(
  type: unknown,
  attrs: Record<string, unknown> | null | undefined,
  kids: unknown[] | null | undefined,
): VNode {
  const props: Record<string, unknown> = {}
  let key: string | null = null
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      if (k === 'key') key = attrs.key == null ? null : String(attrs.key)
      else props[k] = attrs[k]
    }
  }
  if (kids && kids.length === 1) props.children = kids[0]
  else if (kids && kids.length > 1) props.children = kids
  return { $$vnode: true, type, props, key }
}

/**
 * The variadic factory esbuild's classic transform emits (here and into a card bundle, as `__h__`).
 * @param type - a tag name, a component function or {@link Fragment}.
 * @param props - attributes, `null` when the element has none.
 * @param children - the element's children, in order.
 * @returns the vnode.
 */
export function h(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): VNode {
  return jsx(type, props, children)
}

/** Publish `__jsx__`, `__fragment__` and `__h__` for the card module that runs after the runtime. */
export function installJsx(): void {
  g.__jsx__ = jsx
  g.__fragment__ = Fragment
  g.__h__ = h
}

declare global {
  /** The JSX of the presets in `presets/`: the same vocabulary a card gets from `types/dsh-card.d.ts`. */
  namespace JSX {
    /** What a JSX expression produces: a lazy vnode. */
    type Element = VNode
    /** Attributes of an intrinsic element; which tags and attributes are valid is the host's check, not this one. */
    interface IntrinsicElements {
      [name: string]: Record<string, unknown>
    }
    /** The prop children are placed in (`<p>text</p>`). */
    interface ElementChildrenAttribute {
      children: unknown
    }
  }
}
