/**
 * The pure halves of the polish step: which sub-styles one send draws, how a model answer is read back (a rewrite, or
 * the marker that says "do not send"), and whether a rewrite is safe to publish in place of the original.
 *
 * @module dsh-im-polish/style
 */

/**
 * Draw `min`..`max` distinct sub-styles in random order (clamped to the pool).
 * @param subs - the configured pool.
 * @param min - fewest to draw.
 * @param max - most to draw.
 * @param rnd - the die (0 ≤ rnd() < 1), injectable for tests.
 * @returns the drawn sub-styles.
 */
export function pickSubStyles(subs: readonly string[], min: number, max: number, rnd: () => number = Math.random): string[] {
  const pool = [...new Set((subs ?? []).map(s => String(s).trim()).filter(Boolean))]
  if (pool.length === 0) return []
  const lo = count(min)
  const hi = Math.max(lo, count(max))
  const draw = Math.min(hi, lo + Math.floor(rnd() * (hi - lo + 1)))
  const out: string[] = []
  for (let i = 0; i < draw && pool.length > 0; i++) out.push(...pool.splice(Math.floor(rnd() * pool.length), 1))
  return out
}

function count(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

/** What one model answer says. */
export type PolishAnswer =
  | { kind: 'skip' }
  | { kind: 'text'; text: string }

/**
 * Read one model answer: the configured marker alone (optionally fenced or quoted) means "this repeats what was just
 * said, send nothing"; anything else is the rewrite.
 * @param raw - the model's text.
 * @param marker - the do-not-send marker the prompt names.
 * @returns the decoded answer.
 */
export function readAnswer(raw: string, marker: string): PolishAnswer {
  const text = String(raw ?? '').trim()
  const bare = text.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '').replace(/^["'“「]|["'”」]$/g, '').trim()
  if (marker !== '' && bare === marker) return { kind: 'skip' }
  return { kind: 'text', text }
}

/**
 * The guards a rewrite has to pass before it replaces what the agent wrote: a polished sentence is never worth a wrong
 * one. Anything that drops a link, a mention, a number or a markdown target, balloons in length, grows extra lines or
 * comes back empty is thrown away, and the caller sends the original instead.
 * @param raw - the model's rewrite.
 * @param original - the text the agent wrote.
 * @param maxChars - the longest message the chat should receive.
 * @returns the cleaned rewrite, or undefined when it must not be used.
 */
export function acceptStyled(raw: string, original: string, maxChars: number): string | undefined {
  return checkStyled(raw, original, maxChars).text
}

/**
 * {@link acceptStyled} with the reason a rewrite was refused, for the polish log.
 * @param raw - the model's rewrite.
 * @param original - the text the agent wrote.
 * @param maxChars - the longest message the chat should receive.
 * @returns the cleaned rewrite, or the reason it was refused.
 */
export function checkStyled(raw: string, original: string, maxChars: number): { text?: string; reason?: string } {
  let out = String(raw ?? '').trim()
  if (!out) return { reason: 'empty' }
  // a fenced block, then a "改写：" style label the model sometimes prefixes
  out = out.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '').trim()
  out = out.replace(/^(?:输出|改写|润色|重写|结果|回答|output|rewrite)\s*[:：]\s*/i, '').trim()
  out = unwrapQuotes(out)
  if (!out) return { reason: 'empty' }
  if (out.length > maxChars) return { reason: 'too-long' }
  // a rewrite twice the size (or 12 chars longer) is padding, not styling
  if (out.length > Math.max(original.length * 2, original.length + 12)) return { reason: 'grew' }
  // one message must not turn into a paragraph of its own: a one-line sentence stays one line
  if (out.split('\n').length > Math.max(1, original.split('\n').length)) return { reason: 'extra-lines' }
  for (const url of original.match(/https?:\/\/[^\s，。）】)>\]]+/g) ?? []) {
    if (!out.includes(url)) return { reason: `lost-link ${url}` }
  }
  for (const m of original.matchAll(/\]\(([^)]+)\)/g)) {
    if (!out.includes(m[1]!)) return { reason: `lost-link ${m[1]}` }
  }
  for (const tag of original.match(/<at\b[^>]*>(?:[^<]*<\/at>)?/g) ?? []) {
    if (!out.includes(tag)) return { reason: `lost-mention ${tag}` }
  }
  for (const at of original.replace(/<at\b[^>]*>(?:[^<]*<\/at>)?/g, '').match(/@[^\s，。！？、,.!?<]{2,}/g) ?? []) {
    if (!out.includes(at)) return { reason: `lost-mention ${at}` }
  }
  for (const code of original.match(/`[^`\n]+`/g) ?? []) {
    if (!out.includes(code) && !out.includes(code.slice(1, -1))) return { reason: `lost-code ${code}` }
  }
  for (const token of original.match(/\d[\d.\-:/]*/g) ?? []) {
    const number = token.replace(/[.\-:/]+$/, '')
    if (number.length >= 2 && !out.includes(number)) return { reason: `lost-number ${number}` }
  }
  return { text: out }
}

/** Straight/typographic quotes around the whole answer are decoration, not content. */
function unwrapQuotes(text: string): string {
  for (const [open, close] of [['"', '"'], ["'", "'"], ['“', '”'], ['「', '」']] as const) {
    if (!text.startsWith(open) || !text.endsWith(close) || text.length <= open.length + close.length) continue
    const inner = text.slice(open.length, text.length - close.length)
    // 「」 is a quoting device a style may allow: only unwrap a lone outer pair
    if (open === '「' && inner.includes('「')) continue
    return inner.trim()
  }
  return text
}
