/**
 * Choosing stickers: filtering the library, scoring a free-text hint against descriptions and type meanings, and the
 * weighted draw that favours heavy stickers but softens the ones used recently, so the same picture does not come back
 * twice in a row.
 *
 * Everything here is pure; time and randomness are parameters.
 *
 * @module dsh-im-stickers/pick
 */
import type { StickerType } from './config.ts'
import type { StickerRecord } from './domain.ts'

/** Filter and order of a library listing. */
export interface StickerFilter {
  /** Every listed tag must be present (AND). */
  tags?: string[]
  /** Only stickers without tags. */
  untagged?: boolean
  /** Free text matched against description, title and tag names. */
  query?: string
  enabled?: boolean
  source?: StickerRecord['source']
  ids?: number[]
  /** `weight` (default), `uses`, `recent` (last used), `newest`, `oldest`. */
  order?: 'weight' | 'uses' | 'recent' | 'newest' | 'oldest'
  limit?: number
  offset?: number
}

/**
 * Filter and order stickers.
 * @param rows - the library.
 * @param filter - the listing request.
 * @param types - the configured types (the query also matches their names).
 * @returns the matching stickers, ordered and paged.
 */
export function filterStickers(rows: Iterable<StickerRecord>, filter: StickerFilter = {}, types: readonly StickerType[] = []): StickerRecord[] {
  const query = filter.query?.trim().toLowerCase()
  const ids = filter.ids === undefined ? undefined : new Set(filter.ids)
  const out: StickerRecord[] = []
  for (const row of rows) {
    if (ids !== undefined && !ids.has(row.id)) continue
    if (filter.enabled !== undefined && row.enabled !== filter.enabled) continue
    if (filter.source !== undefined && row.source !== filter.source) continue
    if (filter.untagged === true && row.tags.length > 0) continue
    if (filter.tags !== undefined && !filter.tags.every(tag => row.tags.includes(tag))) continue
    if (query) {
      const names = row.tags.map(tag => types.find(type => type.id === tag)?.name ?? tag)
      const haystack = `${row.desc}\n${row.title}\n${row.tags.join(' ')}\n${names.join(' ')}`.toLowerCase()
      if (!haystack.includes(query)) continue
    }
    out.push(row)
  }
  const order = filter.order ?? 'weight'
  out.sort((a, b) => {
    switch (order) {
      case 'uses': return b.uses - a.uses || b.weight - a.weight || b.id - a.id
      case 'recent': return b.lastUsed - a.lastUsed || b.id - a.id
      case 'newest': return b.id - a.id
      case 'oldest': return a.id - b.id
      default: return b.weight - a.weight || a.uses - b.uses || b.id - a.id
    }
  })
  const offset = Math.max(0, filter.offset ?? 0)
  const limit = Math.max(0, Math.min(filter.limit ?? 500, 1000))
  return out.slice(offset, offset + limit)
}

/**
 * Character pairs of a short Chinese text, without spaces and particles, for fuzzy hint matching.
 * @param text - the text.
 * @returns its bigrams in order.
 */
export function bigrams(text: string): string[] {
  const clean = Array.from(text.replace(/[\s，。、！？的了吗呢,.!?]/g, ''))
  const out: string[] = []
  for (let i = 0; i + 1 < clean.length; i++) out.push(clean[i]! + clean[i + 1]!)
  return out
}

/**
 * How well one sticker matches a hint. Descriptions say only what the picture shows, so a hint about a mood
 * (“被逗笑了”) matches through the type's name and meaning.
 * @param row - the sticker.
 * @param hint - lower-cased free text about the situation.
 * @param types - the configured types.
 * @returns 0 for no match, higher for better matches.
 */
export function hintScore(row: StickerRecord, hint: string, types: readonly StickerType[]): number {
  if (!hint) return 0
  const desc = row.desc.toLowerCase()
  let score = desc.includes(hint) ? 6 : 0
  for (const pair of bigrams(desc)) if (hint.includes(pair)) score += 1
  for (const tag of row.tags) {
    const type = types.find(t => t.id === tag)
    const name = (type?.name ?? tag).toLowerCase()
    if (hint.includes(name) || name.includes(hint) || hint.includes(tag)) score += 5
    const meaning = (type?.desc ?? '').toLowerCase()
    if (meaning && bigrams(meaning).some(pair => hint.includes(pair))) score += 3
  }
  return score + (score > 0 ? row.weight / 100 : 0)
}

/**
 * The recent-use factor of one sticker: a quarter of its weight within five minutes of its last use, 60 % within the
 * hour, 85 % within the day.
 * @param lastUsed - epoch ms of its last use, 0 when never used.
 * @param now - the current time.
 * @returns the multiplier.
 */
export function recencyFactor(lastUsed: number, now: number): number {
  if (!lastUsed) return 1
  const age = now - lastUsed
  return age < 5 * 60_000 ? 0.25 : age < 3600_000 ? 0.6 : age < 86400_000 ? 0.85 : 1
}

/**
 * Pick one entry by weight, softened by recent use and jittered ±15 %.
 * @param entries - candidates with their weights.
 * @param now - the current time.
 * @param rnd - the die (0 ≤ rnd() < 1).
 * @returns the chosen sticker, or undefined for an empty list.
 */
export function weightedPick(
  entries: readonly { row: StickerRecord; weight: number }[], now: number = Date.now(), rnd: () => number = Math.random,
): StickerRecord | undefined {
  if (entries.length === 0) return undefined
  const scored = entries.map(entry => ({
    row: entry.row,
    score: (entry.weight + 5) * recencyFactor(entry.row.lastUsed, now) * (0.85 + rnd() * 0.3),
  }))
  const total = scored.reduce((sum, entry) => sum + entry.score, 0)
  let roll = rnd() * total
  for (const entry of scored) {
    roll -= entry.score
    if (roll <= 0) return entry.row
  }
  return scored[scored.length - 1]!.row
}

/** A pick request. */
export interface PickOptions {
  /** Every listed tag must be present. */
  tags?: string[]
  /** Free text about the situation. */
  hint?: string
  /** Never these ids (the one just sent, typically). */
  exclude?: number[]
  minWeight?: number
}

/**
 * Choose one enabled sticker. With a hint, the best-scoring eight are drawn from by score; without one (or when
 * nothing matches the hint) every candidate is drawn from by weight.
 * @param rows - the library.
 * @param options - tags, hint, exclusions and the weight floor.
 * @param types - the configured types.
 * @param now - the current time.
 * @param rnd - the die.
 * @returns the chosen sticker, or undefined when nothing qualifies.
 */
export function pickSticker(
  rows: Iterable<StickerRecord>, options: PickOptions, types: readonly StickerType[],
  now: number = Date.now(), rnd: () => number = Math.random,
): StickerRecord | undefined {
  const minWeight = options.minWeight ?? 0
  const exclude = new Set(options.exclude ?? [])
  const pool = filterStickers(rows, { enabled: true, ...options.tags?.length ? { tags: options.tags } : {}, limit: 1000 }, types)
    .filter(row => row.weight >= minWeight && !exclude.has(row.id))
  if (pool.length === 0) return undefined
  const hint = String(options.hint ?? '').trim().toLowerCase()
  const scored = pool.map(row => ({ row, score: hintScore(row, hint, types) }))
  const top = hint ? scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 8) : []
  const candidates = top.length > 0 ? top.map(s => ({ row: s.row, weight: s.score * 10 })) : pool.map(row => ({ row, weight: row.weight }))
  return weightedPick(candidates, now, rnd)
}

/**
 * The identity of one sticker as history and tool results show it: `#158 a cat hiding under a blanket`.
 * @param row - the sticker.
 * @returns its label.
 */
export function stickerLabel(row: Pick<StickerRecord, 'id' | 'desc'>): string {
  const desc = row.desc.replace(/\s+/g, ' ').trim().slice(0, 24)
  return `#${row.id}${desc ? ` ${desc}` : ''}`
}
