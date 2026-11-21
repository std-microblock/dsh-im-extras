/**
 * From a rendered card tree to platform-neutral elements.
 *
 * The runtime emits `{ t, a, c }` nodes; a card's root is `<message>` (or any flow content, which is wrapped in one).
 * The tree is validated with the vocabulary's own `normalize`, so an unknown element or a misplaced block reaches the
 * card author as one readable error instead of a refused publication.
 *
 * @module dsh-im-card/tree
 */
import { h, normalize, type Element } from '@deepseek-ai/cordis-plugin-im-core'
import type { CardNode } from './engine.ts'

/** A tree that is not valid card content. */
export class CardTreeError extends Error {
  override readonly name = 'CardTreeError'
}

/** Build one element from one node (attributes are JSON values; `text` keeps its content). */
function elementOf(node: CardNode): Element {
  if (node.t === 'text') return h.text(String(node.a.content ?? ''))
  const children = node.c.map(elementOf)
  // `h` accepts any tag at runtime; the vocabulary check happens in `normalize` below.
  const make = h as unknown as (tag: string, attrs: Record<string, unknown>, ...kids: Element[]) => Element
  return make(node.t, { ...node.a }, ...children)
}

/**
 * The elements of one rendered card.
 * @param tree - root nodes the runtime produced.
 * @returns the children of the card's `<message>` root: what the card contributes to a message.
 * @throws CardTreeError when the tree is not valid message content.
 */
export function cardElements(tree: CardNode[]): Element[] {
  const roots = tree.length === 1 && tree[0]!.t === 'message' ? tree[0]!.c : tree
  const elements = roots.map(elementOf)
  try {
    normalize(h('message', ...elements))
  } catch (error) {
    throw new CardTreeError(`invalid card content: ${error instanceof Error ? error.message : String(error)}`)
  }
  return elements
}

/**
 * The plain text a card stands for when it cannot render (a summary of its visible text).
 * @param tree - root nodes.
 * @returns the concatenated text content.
 */
export function textOf(tree: CardNode[]): string {
  const out: string[] = []
  const walk = (node: CardNode): void => {
    if (node.t === 'text') out.push(String(node.a.content ?? ''))
    else node.c.forEach(walk)
  }
  tree.forEach(walk)
  return out.join('').trim()
}
