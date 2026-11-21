/**
 * Slash-command skill invocation (`/<skill-name>` or a declared alias such as `/建单`) and skill extension metadata
 * (command aliases and automatic capability authorization requests).
 *
 * @module dsh-im-dispatch/skills
 */

import type {
  ElementLike, ImStoredMessage, Logger, SkillDefinitionLike, SkillRegistryLike,
} from './types.ts'

/** Parsed leading slash invocation from an inbound IM message. */
export interface SlashInvocation {
  /** Command token after `/` without leading slash (e.g. `建单`, `ticket-intake`). */
  readonly token: string
  /** Remaining user text after the command token (trimmed, may be empty). */
  readonly args: string
}

/** Extension parameters parsed from a skill's YAML frontmatter `metadata` block. */
export interface SkillExtensions {
  /** Extra slash command aliases (without leading `/`) declared by the skill. */
  readonly commands: readonly string[]
  /** Capability ids to auto-request via `im-session-auth` when invoked (e.g. `['issue-tracker']`); ignored when `ctx.imAuth` is not mounted. */
  readonly capabilities: readonly string[]
  /** Optional custom reason shown on the auto-sent `<AuthRequest />` card. */
  readonly authReason?: string
  /** Optional custom title shown on the auto-sent `<AuthRequest />` card. */
  readonly authTitle?: string
}

/** Resolved slash skill ready to spawn a task worker. */
export interface ResolvedSlashSkill {
  readonly token: string
  readonly args: string
  readonly skill: SkillDefinitionLike
  readonly extensions: SkillExtensions
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function normalizeCommandToken(raw: string): string {
  const trimmed = raw.trim().replace(/^\/+/, '')
  return trimmed.toLowerCase()
}

function readStringList(value: unknown): string[] {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? [trimmed] : []
  }
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed.length > 0) out.push(trimmed)
  }
  return out
}

function readOptionalString(meta: Readonly<Record<string, unknown>>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = meta[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/** Extract slash-command aliases and auto-auth capability extensions from a skill's `metadata`. */
export function extractSkillExtensions(skill: Pick<SkillDefinitionLike, 'metadata'>): SkillExtensions {
  const meta = skill.metadata
  if (meta === undefined || typeof meta !== 'object' || meta === null) {
    return { commands: [], capabilities: [] }
  }

  const commandSet = new Set<string>()
  for (const key of ['commands', 'command', 'aliases', 'alias']) {
    for (const entry of readStringList(meta[key])) {
      const cleaned = entry.replace(/^\/+/, '').trim()
      if (cleaned.length > 0) commandSet.add(cleaned)
    }
  }

  const capSet = new Set<string>()
  for (const key of ['capabilities', 'authCapabilities', 'auth_capabilities', 'autoAuth', 'auto_auth']) {
    for (const entry of readStringList(meta[key])) {
      if (entry.length > 0) capSet.add(entry)
    }
  }

  const authReason = readOptionalString(meta, 'authReason', 'auth_reason')
  const authTitle = readOptionalString(meta, 'authTitle', 'auth_title')

  return {
    commands: [...commandSet],
    capabilities: [...capSet],
    ...authReason === undefined ? {} : { authReason },
    ...authTitle === undefined ? {} : { authTitle },
  }
}

/** Collect plain text from normalized message elements while skipping leading `<at>` mentions and `<quote>` nodes. */
function textWithoutLeadingMentions(root: ElementLike): { text: string; sawAt: boolean } {
  const parts: string[] = []
  let started = false
  let sawAt = false

  const walk = (node: ElementLike): void => {
    if (node.type === 'quote') return
    if (node.type === 'at') {
      sawAt = true
      if (!started) return
      const name = typeof node.attrs.name === 'string' ? node.attrs.name : ''
      parts.push(name ? `@${name}` : '')
      return
    }
    if (node.type === 'text') {
      const content = typeof node.attrs.content === 'string' ? node.attrs.content : ''
      if (!started) {
        const trimmed = content.trimStart()
        if (trimmed.length === 0) return
        started = true
        parts.push(trimmed)
      } else {
        parts.push(content)
      }
      return
    }
    if (node.type === 'br') {
      if (started) parts.push('\n')
      return
    }
    const isBlock = node.type === 'p' || node.type === 'div' || node.type === 'li'
    const before = parts.length
    for (const child of node.children) walk(child)
    if (isBlock && parts.length > before) parts.push('\n')
  }

  walk(root)
  return { text: parts.join('').trim(), sawAt }
}

/**
 * Parse a leading `/command [args]` invocation from an addressed IM message.
 * Handles both direct `/建单 ...` and group `@bot /建单 ...` messages.
 */
export function parseSlashInvocation(message: ImStoredMessage): SlashInvocation | undefined {
  let candidate = ''
  if (message.content !== undefined && Array.isArray(message.content.children) && message.content.children.length > 0) {
    const extracted = textWithoutLeadingMentions(message.content)
    if (extracted.sawAt || extracted.text.length > 0) {
      candidate = extracted.text
    }
  }
  if (candidate.length === 0) {
    candidate = message.text.trim()
  }
  // Also strip leading `@mention` tokens from plain text (e.g. tests or adapters without `<at>` elements).
  if (!candidate.startsWith('/') && candidate.startsWith('@')) {
    const stripped = candidate.replace(/^(?:@\S+\s+)+/, '').trim()
    if (stripped.startsWith('/')) candidate = stripped
  }

  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(candidate)
  if (match === null) return undefined
  const token = match[1]!.trim()
  if (token.length === 0) return undefined
  return { token, args: (match[2] ?? '').trim() }
}

/** Render one loaded skill in the canonical `<skill_content>` format expected by the harness. */
export function renderSkillContentBlock(skill: Pick<SkillDefinitionLike, 'name' | 'provider' | 'resourceBase' | 'content'>): string {
  const base = skill.resourceBase
  let resourceHint: string[]
  if (base === undefined) {
    resourceHint = [
      `Resources for this skill are managed by provider "${escapeText(skill.provider)}".`,
      'Load referenced resources only as needed.',
    ]
  } else if (base.kind === 'directory') {
    resourceHint = [
      `Base directory for this skill: ${escapeText(base.path)}`,
      'Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.',
    ]
  } else if (base.kind === 'url') {
    resourceHint = [
      `Base URL for this skill: ${escapeText(base.url)}`,
      'Resolve relative URLs mentioned by this skill against the base URL before using them. Load referenced resources only as needed.',
    ]
  } else {
    resourceHint = [
      `Resources for this skill: ${escapeText(base.description)}`,
      'Load referenced resources only as needed.',
    ]
  }

  return [
    `<skill_content name="${escapeAttr(skill.name)}">`,
    '<skill_resources>',
    ...resourceHint,
    '</skill_resources>',
    '',
    '<skill_instructions>',
    skill.content,
    '</skill_instructions>',
    '</skill_content>',
  ].join('\n')
}

/** Cached resolver mapping `/<token>` (skill name or `metadata.commands` alias) to user-invocable skills. */
export class SkillCommandResolver {
  private readonly getRegistry: () => SkillRegistryLike | undefined
  private readonly logger: Logger
  private cache: { cwd: string; byToken: Map<string, string> } | undefined

  constructor(getRegistry: () => SkillRegistryLike | undefined, logger: Logger) {
    this.getRegistry = getRegistry
    this.logger = logger
  }

  /** Drop cached slash-command index (called when `skills/change` fires). */
  invalidate(): void {
    this.cache = undefined
  }

  /** Resolve a slash command token to a freshly loaded user-invocable skill definition, or `undefined` if unknown. */
  async resolve(token: string, args: string, cwd: string): Promise<ResolvedSlashSkill | undefined> {
    const registry = this.getRegistry()
    if (registry === undefined) return undefined

    const key = normalizeCommandToken(token)
    if (key.length === 0) return undefined

    const index = await this.indexFor(registry, cwd)
    const skillName = index.get(key)
    if (skillName === undefined) return undefined

    let definition: SkillDefinitionLike | undefined
    try {
      definition = await registry.get(skillName, { cwd })
    } catch (error) {
      this.logger.warn('im-dispatch: failed to load skill %s for /%s: %s', skillName, token, String(error))
      return undefined
    }
    if (definition === undefined || definition.invocation.userInvocable === false) {
      this.invalidate()
      return undefined
    }

    return {
      token,
      args,
      skill: definition,
      extensions: extractSkillExtensions(definition),
    }
  }

  private async indexFor(registry: SkillRegistryLike, cwd: string): Promise<Map<string, string>> {
    if (this.cache !== undefined && this.cache.cwd === cwd) return this.cache.byToken
    const byToken = new Map<string, string>()
    let summaries
    try {
      summaries = await registry.list({ cwd })
    } catch (error) {
      this.logger.warn('im-dispatch: failed to list skills for slash commands: %s', String(error))
      return byToken
    }

    // First register canonical skill names, then declared command aliases.
    for (const summary of summaries) {
      if (summary.invocation.userInvocable === false) continue
      const nameKey = normalizeCommandToken(summary.name)
      if (nameKey.length > 0 && !byToken.has(nameKey)) {
        byToken.set(nameKey, summary.name)
      }
    }

    await Promise.all(summaries.map(async (summary) => {
      if (summary.invocation.userInvocable === false) return
      try {
        const def = await registry.get(summary.name, { cwd })
        if (def === undefined || def.invocation.userInvocable === false) return
        const ext = extractSkillExtensions(def)
        for (const cmd of ext.commands) {
          const aliasKey = normalizeCommandToken(cmd)
          if (aliasKey.length > 0 && !byToken.has(aliasKey)) {
            byToken.set(aliasKey, summary.name)
          }
        }
      } catch (error) {
        this.logger.warn('im-dispatch: failed to inspect metadata of skill %s: %s', summary.name, String(error))
      }
    }))

    this.cache = { cwd, byToken }
    return byToken
  }
}
