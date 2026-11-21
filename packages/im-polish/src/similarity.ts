/**
 * How alike two short chat messages are, for the repeat guard.
 *
 * The comparison runs on a normalized key: mentions, media labels, quotes, links' surrounding markup, whitespace and
 * punctuation are dropped and Latin letters are lower-cased, so a rewrite that only moved a comma, added a `~` or
 * dropped an `@` cannot hide that it says the same thing. The measure is Sørensen–Dice over character bigrams — cheap,
 * language-agnostic, and for Chinese (where a bigram is roughly a word) it tracks "the same sentence worded slightly
 * differently" well: two wordings of one answer typically score above 0.8, two different answers on one topic below
 * 0.5.
 *
 * @module dsh-im-polish/similarity
 */

/** Characters that carry no meaning for the comparison: whitespace, ASCII and CJK punctuation, symbols, kaomoji parts. */
const NOISE = /[\s\p{P}\p{S}]+/gu

/** `[图片 #12.1]`-style media labels and `<at …>` / `@name` mentions. */
const LABELS = /\[(?:图片|文件|语音|视频|表情|image|file|sticker)[^\]]*\]/giu
const AT_TAGS = /<at\b[^>]*>(?:[^<]*<\/at>)?/giu
const AT_NAMES = /@[^\s，。！？、,.!?@]{1,32}/gu

/**
 * The comparison key of one message.
 * @param text - the message text as the chat reads it.
 * @returns the text without mentions, media labels, whitespace and punctuation, Latin letters lower-cased.
 */
export function similarityKey(text: string): string {
  return String(text ?? '')
    .replace(LABELS, '')
    .replace(AT_TAGS, '')
    .replace(AT_NAMES, '')
    .replace(NOISE, '')
    .toLowerCase()
}

/** Bigram multiset of one key. */
function bigrams(text: string): Map<string, number> {
  const chars = Array.from(text)
  const out = new Map<string, number>()
  for (let i = 0; i + 1 < chars.length; i++) {
    const gram = chars[i]! + chars[i + 1]!
    out.set(gram, (out.get(gram) ?? 0) + 1)
  }
  return out
}

/**
 * Sørensen–Dice coefficient over character bigrams of two already-normalized keys.
 * @param a - one key.
 * @param b - the other key.
 * @returns 0 for no shared bigram, 1 for the same characters in the same order.
 */
export function diceSimilarity(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  const left = bigrams(a)
  const right = bigrams(b)
  let shared = 0
  for (const [gram, count] of left) shared += Math.min(count, right.get(gram) ?? 0)
  const total = (Array.from(a).length - 1) + (Array.from(b).length - 1)
  return total > 0 ? (2 * shared) / total : 0
}

/** The most similar earlier message. */
export interface SimilarMatch {
  /** Dice similarity of the two keys. */
  score: number
  /** The earlier message, as given. */
  text: string
  /** Its position in the list it came from. */
  index: number
}

/**
 * Find the earlier message one candidate is most like.
 * @param candidate - the message about to go out.
 * @param previous - the bot's recent messages.
 * @param minChars - both keys must have at least this many characters, or the pair is not compared: below that,
 *   people repeat "ok" all day and it is not a repeat.
 * @returns the best match, or undefined when nothing was comparable.
 */
export function mostSimilar(candidate: string, previous: readonly string[], minChars: number): SimilarMatch | undefined {
  const key = similarityKey(candidate)
  if (Array.from(key).length < minChars) return undefined
  let best: SimilarMatch | undefined
  previous.forEach((text, index) => {
    const other = similarityKey(text)
    if (Array.from(other).length < minChars) return
    const score = diceSimilarity(key, other)
    if (best === undefined || score > best.score) best = { score, text, index }
  })
  return best
}
