/**
 * Operator configuration of the sticker plugin.
 *
 * @module dsh-im-stickers/config
 */
import z from '@deepseek-ai/schemastery'

/**
 * One sticker category. `id` is what a sticker stores and the tools filter by; `name` is what people read; `desc` is
 * the meaning the agent and the classifier are given.
 */
export interface StickerType {
  id: string
  name: string
  desc: string
}

/** The automatic sticker after the bot finishes talking. */
export interface AutoConfig {
  /** Append stickers automatically at all. */
  enabled: boolean
  /** Chance (0–100) that a finished burst of the bot's messages gets one. */
  percent: number
  /** Quiet time after the bot's last message before its burst counts as finished, ms. */
  gapMs: number
  /** Type the automatic sticker is picked from; empty picks from every enabled sticker. */
  tag: string
}

/**
 * One per-chat rule; a rule without criteria matches every chat, all matching rules apply in order.
 */
export interface StickerRule {
  /** Chat keys (`bot|chatId`) or bare platform chat ids. */
  chats?: string[]
  /** Admission source ids. */
  sources?: string[]
  /** Bot ids; `qq:*`-style prefixes are written as the platform name followed by a colon (`qq:`). */
  bots?: string[]
  /** Overrides of the automatic sticker for the matched chats. */
  auto?: Partial<AutoConfig>
}

/** The vision call that describes and tags a new sticker. */
export interface ClassifyConfig {
  /** Classify new stickers automatically. */
  enabled: boolean
  /** Provider route of a vision-capable model; with `model`. Absent: no automatic classification. */
  provider?: string
  model?: string
  reasoningEffort?: string
  maxTokens: number
  timeoutMs: number
  /** Stickers classified at once. */
  concurrency: number
}

/** Validated operator configuration. */
export interface StickersConfig {
  /** Where sticker files and previews live; empty means `~/.dsh/im-stickers`. */
  dataDir: string
  /** Categories offered to the classifier and listed to the agent. */
  types: StickerType[]
  /** Stickers below this weight (0–100) are never picked without an explicit id. */
  minWeight: number
  auto: AutoConfig
  rules: StickerRule[]
  classify: ClassifyConfig
  /** ImageMagick executable; when it cannot run, previews and animation frames are skipped. */
  magick: string
  /** Largest file accepted for a sticker, bytes. */
  maxBytes: number
  /** Tools registered for agents. */
  tools: string[]
  /** Add the sticker section to hosted sessions' system prompts. */
  prompt: boolean
}

/** A neutral default category list. */
export const DEFAULT_STICKER_TYPES: StickerType[] = [
  { id: 'general', name: '通用', desc: '没有特定含义，随时发都合适' },
  { id: 'speechless', name: '无语', desc: '无语、恼火、不满' },
  { id: 'wow', name: '惊讶', desc: '惊讶、兴奋' },
  { id: 'confused', name: '疑惑', desc: '疑惑、不解' },
  { id: 'sad', name: '难过', desc: '难过、不安、委屈、不好意思' },
  { id: 'happy', name: '开心', desc: '开心、得意、被逗笑' },
  { id: 'close', name: '亲近', desc: '对对方的亲近、友好' },
  { id: 'other', name: '其它', desc: '其它类型' },
]

/**
 * The default rules: a QQ official bot answers a group passively and its quota of replies per message is small, so
 * the automatic sticker is rarer there.
 */
export const DEFAULT_RULES: StickerRule[] = [{ bots: ['qq:'], auto: { percent: 3 } }]

/** Validated operator configuration. */
export const Config: z<StickersConfig> = z.object({
  dataDir: z.string().default(''),
  types: z.array(z.object({
    id: z.string().required(),
    name: z.string().required(),
    desc: z.string().default(''),
  })).default(DEFAULT_STICKER_TYPES),
  minWeight: z.natural().max(100).default(0),
  auto: z.object({
    enabled: z.boolean().default(true),
    percent: z.number().min(0).max(100).default(8),
    gapMs: z.natural().min(1000).default(7_000),
    tag: z.string().default('general'),
  }),
  rules: z.array(z.object({
    chats: z.array(z.string()),
    sources: z.array(z.string()),
    bots: z.array(z.string()),
    auto: z.object({
      enabled: z.boolean(),
      percent: z.number().min(0).max(100),
      gapMs: z.natural().min(1000),
      tag: z.string(),
    }),
  })).default(DEFAULT_RULES),
  classify: z.object({
    enabled: z.boolean().default(true),
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string(),
    maxTokens: z.natural().min(1).default(3000),
    timeoutMs: z.natural().min(1).default(180_000),
    concurrency: z.natural().min(1).max(8).default(3),
  }),
  magick: z.string().default('magick'),
  maxBytes: z.natural().min(1).default(8 * 1024 * 1024),
  tools: z.array(z.string()).default(['send_sticker', 'sticker_search', 'sticker_collect']),
  prompt: z.boolean().default(true),
}) as unknown as z<StickersConfig>

/** What a rule is matched against. */
export interface StickerSubject {
  chat: string
  source?: string | undefined
  bot?: string | undefined
}

/**
 * The automatic-sticker settings of one chat after the rules.
 * @param config - the operator configuration.
 * @param subject - the chat.
 * @param override - the panel's switch for this chat, applied last.
 * @returns the effective settings.
 */
export function autoFor(config: StickersConfig, subject: StickerSubject, override?: Partial<AutoConfig>): AutoConfig {
  let auto: AutoConfig = { ...config.auto }
  const bare = subject.chat.includes('|') ? subject.chat.slice(subject.chat.indexOf('|') + 1) : subject.chat
  const listed = (list: string[] | undefined, ...values: (string | undefined)[]): boolean =>
    list === undefined || list.length === 0 || values.some(value => value !== undefined && list.includes(value))
  const botListed = (list: string[] | undefined): boolean =>
    list === undefined || list.length === 0
    || list.some(entry => subject.bot !== undefined && (entry === subject.bot || (entry.endsWith(':') && subject.bot.startsWith(entry))))
  for (const rule of config.rules) {
    if (!listed(rule.chats, subject.chat, bare) || !listed(rule.sources, subject.source) || !botListed(rule.bots)) continue
    auto = { ...auto, ...definedOf(rule.auto) }
  }
  return { ...auto, ...definedOf(override) }
}

function definedOf<T extends object>(value: Partial<T> | undefined): Partial<T> {
  if (value === undefined) return {}
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>
}
