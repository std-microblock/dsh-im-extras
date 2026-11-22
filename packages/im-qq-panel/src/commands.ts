/**
 * Command-panel items generated from the commands the bot answers.
 *
 * The Koishi original read Koishi's command registry. A dsh-im bot has no single registry, so the plugin gathers
 * {@link CommandEntry} lists from the sources it can see — the built-in commands of `dsh-im-session-commands`
 * (declared in this plugin's configuration, because that plugin does not publish its list), the `/skill` commands of
 * `dsh-im-dispatch` (`ctx.imDispatch.skills()`), and extra entries from the configuration — and this module turns
 * them into panel items.
 *
 * Item shape follows the platform limits: name ≤ 14 and description ≤ 30 (CJK counts 2). The name is also what a tap
 * puts into the input box, so it carries the command prefix (`/` by default).
 *
 * @module dsh-im-qq-panel/commands
 */

import { LIMITS, textWeight } from './api.ts'

/** One command a panel may list. */
export interface CommandEntry {
  /** Command name without the prefix (`help`, `ticket-intake`). */
  name: string
  /** Other names that run the same command; a CJK alias that fits is preferred as the label. */
  aliases?: readonly string[]
  /** One-line description. */
  description?: string
  /** Where the entry came from: `session`, `skills`, `extra`. */
  source: string
  /** Only group / channel administrators may tap it. */
  onlyAdmin?: boolean
}

/** Options of {@link generateItems}: one panel's selection. */
export interface GenerateOptions {
  /** Prefix written before the label (`/`). */
  prefix?: string
  /** Patterns listed first, in this order (`*` wildcard, case-insensitive; matched against name and aliases). */
  include?: readonly string[]
  /** Patterns left out. */
  exclude?: readonly string[]
  /** Item budget including `extraItems`; default 20. */
  maxItems?: number
  /** Items appended after the generated ones (links …), in platform-or-config shape. */
  extraItems?: readonly Record<string, unknown>[]
}

/** A selected command with its label. */
export interface GeneratedEntry {
  name: string
  label: string
  desc: string | undefined
  source: string
  onlyAdmin: boolean
  included: boolean
}

/** Commands of this plugin itself, never listed. */
export const DEFAULT_EXCLUDE: readonly string[] = ['qqmenu*', 'qqpanel*', 'qqsync']

function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Wildcard match: `*` is any run of characters; without one the match is equality. Case-insensitive.
 * @param pattern - the pattern.
 * @param name - the candidate.
 */
export function matchPattern(pattern: string, name: string): boolean {
  const text = String(pattern ?? '').trim().toLowerCase()
  if (!text) return false
  const target = String(name ?? '').toLowerCase()
  if (!text.includes('*')) return target === text
  return new RegExp(`^${text.split('*').map(escapeRegExp).join('.*')}$`).test(target)
}

function namesOf(entry: CommandEntry): string[] {
  return [entry.name, ...entry.aliases ?? []]
}

function matchesEntry(patterns: readonly string[] | undefined, entry: CommandEntry): boolean {
  return (patterns ?? []).some(pattern => namesOf(entry).some(name => matchPattern(pattern, name)))
}

/**
 * Shorten a text to a platform width (CJK counts 2), with an ellipsis.
 * @param text - the text.
 * @param limit - the width.
 */
export function truncate(text: string, limit: number): string {
  if (textWeight(text) <= limit) return text
  let result = ''
  for (const char of text) {
    if (textWeight(result + char) + 2 > limit) break
    result += char
  }
  return `${result.trimEnd()}…`
}

/**
 * The label of an entry: prefix + the name or alias that fits the platform limit, CJK ones first (they read better
 * in QQ), then the shortest.
 * @param entry - the command.
 * @param prefix - command prefix.
 * @returns the label, or undefined when no name fits.
 */
export function pickLabel(entry: CommandEntry, prefix: string): string | undefined {
  const seen = new Set<string>()
  const scored: { candidate: string; weight: number; wide: boolean }[] = []
  for (const raw of [...entry.aliases ?? [], entry.name]) {
    const candidate = String(raw ?? '').trim().replace(/^\/+/, '')
    if (!candidate || seen.has(candidate)) continue
    seen.add(candidate)
    const weight = textWeight(prefix + candidate)
    if (weight > LIMITS.panelItemName) continue
    scored.push({ candidate, weight, wide: textWeight(candidate) > candidate.length })
  }
  scored.sort((a, b) => (Number(b.wide) - Number(a.wide)) || (a.weight - b.weight) || (a.candidate.length - b.candidate.length))
  return scored.length ? prefix + scored[0]!.candidate : undefined
}

function describe(entry: CommandEntry): string | undefined {
  const text = String(entry.description ?? '').replace(/\s+/g, ' ').trim()
  return text ? truncate(text, LIMITS.panelItemDesc) : undefined
}

/**
 * Select and label the entries of one panel.
 * @param entries - every command from every source, in source order.
 * @param options - the panel's selection.
 * @returns the selected entries (unsorted) and warnings.
 */
export function collectEntries(entries: readonly CommandEntry[], options: GenerateOptions = {}): { entries: GeneratedEntry[]; warnings: string[] } {
  const prefix = options.prefix ?? '/'
  const exclude = [...DEFAULT_EXCLUDE, ...options.exclude ?? []]
  const warnings: string[] = []
  const out: GeneratedEntry[] = []
  const names = new Set<string>()
  for (const entry of entries) {
    const name = String(entry?.name ?? '').trim().replace(/^\/+/, '')
    if (!name || names.has(name.toLowerCase())) continue
    if (matchesEntry(exclude, entry)) continue
    names.add(name.toLowerCase())
    const label = pickLabel({ ...entry, name }, prefix)
    if (!label) {
      warnings.push(`命令 ${name} 的名称超出平台限制（含前缀最多 ${LIMITS.panelItemName} 个字符），已跳过`)
      continue
    }
    out.push({
      name,
      label,
      desc: describe(entry),
      source: entry.source,
      onlyAdmin: Boolean(entry.onlyAdmin),
      included: matchesEntry(options.include, entry),
    })
  }
  return { entries: out, warnings }
}

/**
 * Generate the items of one command panel.
 * @param entries - every command from every source, in source order.
 * @param options - the panel's selection.
 * @returns the items (configuration shape, validated later), the warnings and the selected entries.
 */
export function generateItems(entries: readonly CommandEntry[], options: GenerateOptions = {}): {
  items: Record<string, unknown>[]
  warnings: string[]
  entries: GeneratedEntry[]
} {
  const maxItems = options.maxItems ?? LIMITS.panelItems
  const { entries: selected, warnings } = collectEntries(entries, options)
  const byName = new Map(entries.map(entry => [String(entry.name).replace(/^\/+/, ''), entry]))
  const orderOf = (entry: GeneratedEntry): number => {
    const source = byName.get(entry.name)
    const index = (options.include ?? []).findIndex(pattern => source !== undefined
      ? namesOf(source).some(name => matchPattern(pattern, name))
      : matchPattern(pattern, entry.name))
    return index < 0 ? Number.MAX_SAFE_INTEGER : index
  }
  // Explicit include first (in include order), then source order — a stable sort keeps the latter.
  const sorted = selected.map((entry, index) => ({ entry, index }))
    .sort((a, b) => (orderOf(a.entry) - orderOf(b.entry)) || (a.index - b.index))
    .map(({ entry }) => entry)
  const extraItems = (options.extraItems ?? []).map(item => ({ ...item }))
  const budget = Math.max(0, maxItems - extraItems.length)
  if (sorted.length > budget) {
    const dropped = sorted.slice(budget).map(entry => entry.label)
    warnings.push(`命令数量 ${sorted.length} 超过面板上限 ${maxItems}，已按顺序保留前 ${budget} 个，忽略：${dropped.join('、')}（可用 include/exclude 调整）`)
  }
  const items: Record<string, unknown>[] = sorted.slice(0, budget).map(entry => ({
    type: 'command',
    name: entry.label,
    ...entry.desc === undefined ? {} : { desc: entry.desc },
    onlyAdmin: entry.onlyAdmin,
  }))
  items.push(...extraItems)
  return { items, warnings, entries: sorted }
}
