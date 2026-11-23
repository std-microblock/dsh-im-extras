/**
 * Whether one outgoing text really is markdown, or only prose that happens to travel in a `<markdown>` element.
 *
 * A send tool publishes text as a `<markdown>` element either way, but that element promises nothing: the IM host
 * picks the cheapest platform mode that renders the content, and the text mode of every adapter renders plain
 * paragraphs (and plain `<text>`) natively. A bot that writes three plain sentences into `<markdown>` therefore still
 * reaches the chat as one ordinary text bubble — the markdown mode is what a heading, a list, a fence, a table, inline
 * code, emphasis or a link target drags in, because the text mode has no handler for those.
 *
 * That is the distinction the length guard needs: a text bubble that grew past `limits.maxTextChars` may not go out as
 * a wall of chat text, while the same words laid out as markdown are a document the reader expects to be long.
 *
 * The test is by inspection of the source (no markdown parser here: the extras must not depend on the harness's
 * markdown package). It is deliberately generous — a false `false` only asks the agent to shorten a message, while a
 * false `true` would let a wall of text through — so it looks for the constructs the text mode cannot show.
 *
 * @module dsh-im-polish/markdown
 */

/** The constructs a text-only renderer has no handler for. */
const MARKDOWN = [
  /^[ \t]*```/m, // fenced code block
  /^[ \t]*~~~[^\n]*$/m, // fenced code block, tilde style
  /^[ \t]{0,3}#{1,6}[ \t]/m, // ATX heading
  /^[ \t]{0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+\S/m, // list item
  /^[ \t]{0,3}>/m, // block quote
  /^[ \t]{0,3}\|.*\|[ \t]*$/m, // table row
  /^[ \t]{0,3}(?:[*-][ \t]*){3,}$/m, // thematic break
  /^[ \t]{0,3}(?:_[ \t]*){3,}$/m, // thematic break, underscores
  /`[^`\n]+`/, // inline code
  /\*\*[^\s*][^*\n]*\*\*/, // strong
  /__[^\s_][^_\n]*__/, // strong, underscores
  /!?\[[^\]\n]+\]\([^)\s]+\)/, // link or image target
] as const

/**
 * Whether the platform will render this text as markdown rather than as one plain text bubble.
 * @param source - the text of a `<markdown>` (or plain) element, as the agent wrote it.
 * @returns true when the text carries a construct only a markdown renderer shows as such.
 */
export function usesMarkdown(source: string): boolean {
  const text = String(source ?? '')
  if (text.trim() === '') return false
  return MARKDOWN.some(pattern => pattern.test(text))
}

/**
 * The sentence the agent reads when its plain text bubble was too long to send.
 * @param length - how many characters the message carried.
 * @param limit - the configured `limits.maxTextChars`.
 * @returns the reason recorded on the dropped send.
 */
export function tooLongMessage(length: number, limit: number): string {
  return `这条 ${length} 个字，超过 ${limit} 字的纯文本上限，没有发出。超过 ${limit} 字的内容别当普通气泡发：`
    + `要么写成 markdown（标题、列表、代码块、表格、链接，平台会按 markdown 渲染），`
    + `要么用 typst 渲成图片再发（\`typ2img -e '…'\` 出 PNG，再用 im_send_file 发出去），`
    + `要么压到 ${limit} 字以内只说要紧的那句。`
}
