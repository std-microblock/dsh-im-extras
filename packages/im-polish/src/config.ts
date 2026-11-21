/**
 * Operator configuration of the polish plugin.
 *
 * ```yaml
 * - dsh-im-polish:
 *     style:
 *       main: Short IM sentences; plain words; no filler.
 *       subs: [...]
 *     model: { provider: deepseek, model: deepseek-chat }
 *     rules:
 *       - sources: [work-lark]
 *         enabled: false
 *       - chats: ['qq:123|456']
 *         style: { main: ... }
 * ```
 *
 * @module dsh-im-polish/config
 */
import z from '@deepseek-ai/schemastery'

/** How the bot words what it says: one main style, plus a few sub-styles drawn at random for every send. */
export interface StyleConfig {
  /** The style every rewrite follows. */
  main: string
  /** The pool one send draws from; each entry should read as optional (“if it fits, …”). */
  subs: string[]
  /** Fewest sub-styles one send draws. */
  pickMin: number
  /** Most sub-styles one send draws. */
  pickMax: number
}

/**
 * One per-chat rule. A rule without criteria matches every chat; a rule with several lists matches when every list
 * that is present matches. All matching rules apply in order, later ones overriding earlier ones.
 */
export interface PolishRule {
  /** Chat keys (`bot|chatId`) or bare platform chat ids. */
  chats?: string[]
  /** Admission source ids (`sources[].id` of dsh-im). */
  sources?: string[]
  /** Bot ids (`qq:…`, `lark:…`). */
  bots?: string[]
  /** Agent presets of the sending session. */
  presets?: string[]
  /** Owners of the sending session's hosted record (`conversation`, `dispatcher`, …). */
  owners?: string[]
  /** Switch the polish on or off for the matched chats. */
  enabled?: boolean
  /** Style fields that replace the global ones. */
  style?: Partial<StyleConfig>
  /** Extra plain-language instructions appended to the polish prompt for these chats. */
  note?: string
}

/** The model route of the rewrite call. */
export interface ModelConfig {
  /** Provider route; with `model`. Absent: the sending session's own route. */
  provider?: string
  /** Model id; with `provider`. */
  model?: string
  /** Reasoning effort; absent picks the route's cheapest (`off`, else `low`). */
  reasoningEffort?: string
  /** Sampling temperature: higher means more varied wording. */
  temperature: number
  /** Output-token cap of one rewrite. */
  maxTokens: number
  /** Deadline of one rewrite call; the original goes out when it passes. */
  timeoutMs: number
}

/** The guard against saying the same thing twice. */
export interface RepeatConfig {
  /** Bigram-Dice similarity at or above which a message counts as a repeat of one of the bot's recent messages. */
  threshold: number
  /** Normalized characters both messages need before they are compared at all. */
  minChars: number
  /** Only the bot's messages from this many milliseconds back count. */
  windowMs: number
  /** Ask for one more rewrite with feedback before dropping a repeat. */
  retry: boolean
  /** Drop a message that is still a repeat (otherwise it goes out and is only logged). */
  drop: boolean
  /** Let the model answer with the skip marker to drop a message whose substance repeats a recent one. */
  modelDrop: boolean
  /**
   * A skip marker is honoured only when the original is at least this similar to one of the bot's recent messages,
   * so a model that misreads the instruction cannot silence a message with new content.
   */
  modelDropMinSimilarity: number
}

/** What the rewrite sees of the chat. */
export interface ContextConfig {
  /** Most recent chat messages shown (the bot's own included). */
  messages: number
  /** The bot's own recent messages listed separately as “do not sound like these”, and compared for repeats. */
  botMessages: number
  /** Characters of one context message shown at most. */
  maxChars: number
}

/** Which messages are eligible at all. */
export interface LimitsConfig {
  /** Longer messages go out untouched: long answers are content, not chat. */
  maxInputChars: number
  /** Messages with more lines go out untouched. */
  maxLines: number
  /** Longest rewrite accepted. */
  maxOutputChars: number
  /** Shorter messages go out untouched. */
  minChars: number
}

/** Validated operator configuration. */
export interface PolishConfig {
  /** Global switch; rules and panel overrides refine it per chat. */
  enabled: boolean
  style: StyleConfig
  rules: PolishRule[]
  model: ModelConfig
  context: ContextConfig
  repeat: RepeatConfig
  limits: LimitsConfig
  /** The answer that means “do not send this”. */
  skipMarker: string
  /** Polish records kept for the panel. */
  maxRecords: number
}

/** A neutral default main style; deployments replace it. */
export const DEFAULT_MAIN_STYLE = '自然的 IM 口语：句子简短，用词平实，不堆砌客套话和总结句，不用「不是…而是…」这类句式'

/** A neutral default sub-style pool; every entry is optional by wording. */
export const DEFAULT_SUB_STYLES = [
  '如有需要，可以省掉主语，只留关键信息',
  '如有需要，可以用「嗯/好/行」这类短词开头',
  '如有需要，可以把一句长句拆成两句短句',
  '如有需要，可以用反问代替陈述',
  '如有需要，可以换一个更口语的近义词',
  '如有需要，可以把结论放在最前面',
]

const styleFields = {
  main: z.string().role('textarea').default(DEFAULT_MAIN_STYLE),
  subs: z.array(z.string()).default(DEFAULT_SUB_STYLES),
  pickMin: z.natural().default(1),
  pickMax: z.natural().default(2),
}

/** Validated operator configuration. */
export const Config: z<PolishConfig> = z.object({
  enabled: z.boolean().default(true),
  style: z.object(styleFields),
  rules: z.array(z.object({
    chats: z.array(z.string()),
    sources: z.array(z.string()),
    bots: z.array(z.string()),
    presets: z.array(z.string()),
    owners: z.array(z.string()),
    enabled: z.boolean(),
    style: z.object({
      main: z.string().role('textarea'),
      subs: z.array(z.string()),
      pickMin: z.natural(),
      pickMax: z.natural(),
    }),
    note: z.string().role('textarea'),
  })).default([]),
  model: z.object({
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string(),
    temperature: z.number().min(0).max(2).default(1),
    maxTokens: z.natural().min(1).default(400),
    timeoutMs: z.natural().min(1).default(20_000),
  }),
  context: z.object({
    messages: z.natural().default(12),
    botMessages: z.natural().default(5),
    maxChars: z.natural().min(1).default(200),
  }),
  repeat: z.object({
    threshold: z.number().min(0).max(1).default(0.82),
    minChars: z.natural().default(8),
    windowMs: z.natural().default(30 * 60_000),
    retry: z.boolean().default(true),
    drop: z.boolean().default(true),
    modelDrop: z.boolean().default(true),
    modelDropMinSimilarity: z.number().min(0).max(1).default(0.45),
  }),
  limits: z.object({
    maxInputChars: z.natural().min(1).default(400),
    maxLines: z.natural().min(1).default(6),
    maxOutputChars: z.natural().min(1).default(600),
    minChars: z.natural().default(1),
  }),
  skipMarker: z.string().default('<no-send/>'),
  maxRecords: z.natural().min(1).default(1000),
}) as unknown as z<PolishConfig>

/** The style, switch and note that apply to one send after the rules. */
export interface ResolvedChatConfig {
  enabled: boolean
  style: StyleConfig
  note: string
}

/** What a rule is matched against. */
export interface RuleSubject {
  chat: string
  source?: string | undefined
  bot?: string | undefined
  preset?: string | undefined
  owner?: string | undefined
}

/**
 * Whether one rule applies.
 * @param rule - the configured rule.
 * @param subject - the chat and the sending session.
 * @returns true when every criterion the rule lists matches.
 */
export function ruleMatches(rule: PolishRule, subject: RuleSubject): boolean {
  const bare = subject.chat.includes('|') ? subject.chat.slice(subject.chat.indexOf('|') + 1) : subject.chat
  const listed = (list: string[] | undefined, value: string | undefined, alt?: string): boolean =>
    list === undefined || list.length === 0 || (value !== undefined && list.includes(value)) || (alt !== undefined && list.includes(alt))
  return listed(rule.chats, subject.chat, bare)
    && listed(rule.sources, subject.source)
    && listed(rule.bots, subject.bot)
    && listed(rule.presets, subject.preset)
    && listed(rule.owners, subject.owner)
}

/**
 * Fold the rules that match one send onto the global configuration, then the panel's per-chat switch.
 * @param config - the operator configuration.
 * @param subject - the chat and the sending session.
 * @param override - the panel's switch for this chat, when one was set.
 * @returns the effective switch, style and note.
 */
export function resolveChat(config: PolishConfig, subject: RuleSubject, override?: { enabled?: boolean | undefined }): ResolvedChatConfig {
  let enabled = config.enabled
  let style: StyleConfig = { ...config.style, subs: [...config.style.subs] }
  const notes: string[] = []
  for (const rule of config.rules) {
    if (!ruleMatches(rule, subject)) continue
    if (rule.enabled !== undefined) enabled = rule.enabled
    if (rule.style !== undefined) {
      style = {
        main: rule.style.main ?? style.main,
        subs: rule.style.subs ?? style.subs,
        pickMin: rule.style.pickMin ?? style.pickMin,
        pickMax: rule.style.pickMax ?? style.pickMax,
      }
    }
    if (rule.note !== undefined && rule.note.trim() !== '') notes.push(rule.note.trim())
  }
  if (override?.enabled !== undefined) enabled = override.enabled
  return { enabled, style, note: notes.join('\n') }
}
