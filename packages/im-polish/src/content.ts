/**
 * Which outgoing messages are text the polish step may reword, and how the reworded text goes back into the same
 * shape.
 *
 * Only plain text and markdown qualify: a string, `<text>`, `<br>`, `<markdown>`, optionally inside one `<message>`
 * root and next to a `<quote>`. A message carrying anything else — an image, a file, a card, buttons, a mention
 * element, a sticker — is not touched at all: rewording only its text nodes would split the sentence around elements
 * the model never sees, and those messages are rarely chat prose anyway.
 *
 * @module dsh-im-polish/content
 */
import { h, isElement, type Element, type Fragment } from '@deepseek-ai/cordis-plugin-im-core'

/** The text of one polishable message and how to put a rewrite back. */
export interface TextContent {
  /** The message text as the model reads it. */
  text: string
  /** The message is markdown (the platform renders it), not plain text. */
  markdown: boolean
  /**
   * The same message with its text replaced.
   * @param text - the rewrite.
   * @returns content of the original's shape.
   */
  rebuild(text: string): Fragment
}

/**
 * The polishable text of one outgoing message.
 * @param content - the caller's content.
 * @returns its text and a rebuild function, or undefined when the message carries anything but text.
 */
export function textContent(content: Fragment): TextContent | undefined {
  let wrapper = false
  let items: readonly (string | Element)[]
  if (typeof content === 'string') items = [content]
  else if (isElement(content)) {
    if (content.type === 'message') {
      wrapper = true
      items = content.children
    } else items = [content]
  } else items = content
  const quotes: Element[] = []
  let text = ''
  let markdown = false
  for (const item of items) {
    if (typeof item === 'string') {
      text += item
      continue
    }
    if (!isElement(item)) return undefined
    switch (item.type) {
      case 'text':
        text += String((item.attrs as { content?: unknown }).content ?? '')
        break
      case 'br':
        text += '\n'
        break
      case 'markdown':
        if (markdown) text += '\n'
        markdown = true
        text += String((item.attrs as { content?: unknown }).content ?? '')
        break
      case 'quote':
        quotes.push(item)
        break
      default:
        return undefined
    }
  }
  if (text.trim() === '') return undefined
  return {
    text,
    markdown,
    rebuild: (next: string): Fragment => {
      const body = markdown ? h.markdown(next) : next
      if (!wrapper && quotes.length === 0) return body
      return h('message', ...quotes, body)
    },
  }
}
