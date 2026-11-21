/**
 * `dsh-im-polish`: send-time wording polish for dsh-im.
 *
 * The plugin listens to `im/before-send`. A text or markdown message a session publishes through `ctx.im.send` is
 * rewritten in the configured style — one main style plus a few sub-styles drawn at random per send — by a short
 * model call that also sees the chat's recent messages and the bot's own last few, so successive messages neither
 * sound alike nor say the same thing twice. A rewrite that loses a link, a mention, a number or code, or grows too
 * long, is discarded and the original goes out. A message that repeats one of the bot's recent messages (bigram Dice
 * at or above `repeat.threshold`, or the model's skip marker on a draft that is close to one) is retried once with
 * feedback and otherwise dropped: the send then reports `dropped: true` with a reason the agent reads.
 *
 * Messages with images, files, cards or other elements, streams, code blocks, tables and long answers are left
 * untouched. Every decision is recorded in the `im_polish` storage domain; `ctx.imPolish` lists the records, counts
 * them, previews a decision and switches the polish per chat for the panel.
 *
 * @module dsh-im-polish
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ImChatKey, ImOutgoing } from '@deepseek-ai/dsh-im'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { Config, type PolishConfig } from './config.ts'
import type { ChatOverride, PolishRecord } from './domain.ts'
import { PolishHost, type PolishRecordFilter, type PolishStats } from './host.ts'
import { complete, type Complete } from './llm.ts'
import { applyPanel } from './panel.ts'
import type { PolishOutcome } from './polisher.ts'

export {
  Config, DEFAULT_MAIN_STYLE, DEFAULT_SUB_STYLES, resolveChat, ruleMatches,
  type ContextConfig, type LimitsConfig, type ModelConfig, type PolishConfig, type PolishRule, type RepeatConfig,
  type ResolvedChatConfig, type RuleSubject, type StyleConfig,
} from './config.ts'
export { textContent, type TextContent } from './content.ts'
export { imPolishDomain, type ChatOverride, type ImPolishDomain, type PolishRecord } from './domain.ts'
export { PolishHost, type PolishHostDeps, type PolishRecordFilter, type PolishStats } from './host.ts'
export { complete, COMPLETION_TIMEOUT_CODE, type Complete, type CompletionRequest } from './llm.ts'
export { decide, repeatMessage, type PolishAttempt, type PolishInput, type PolishOutcome } from './polisher.ts'
export { applyPanel, POLISH_TAB, polishTab, type PanelHost, type PanelTabDefinition } from './panel.ts'
export { polishSystem, polishUser, type SystemPromptInput, type UserPromptInput } from './prompt.ts'
export { diceSimilarity, mostSimilar, similarityKey, type SimilarMatch } from './similarity.ts'
export { acceptStyled, checkStyled, pickSubStyles, readAnswer, type PolishAnswer } from './style.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Send-time polish: its log, its per-chat switches and a preview. */
    imPolish: ImPolishService
  }
  interface Events {
    /**
     * One polish decision was recorded.
     * @param record - the stored record.
     * @mode emit
     */
    'im-polish/record'(record: PolishRecord): void
  }
}

/** The polish service (`ctx.imPolish`). */
export class ImPolishService extends Service {
  /** `llm` is read when a send is polished (`ctx.get`), so a deployment without it still checks for repeats. */
  static inject = ['im', 'storageDomain']
  static Config = Config

  readonly host: PolishHost
  private readonly home: Context

  constructor(ctx: Context, config: PolishConfig) {
    super(ctx, 'imPolish')
    this.home = ctx
    this.host = new PolishHost({
      im: ctx.im,
      storage: ctx.storageDomain,
      complete: (): Complete | undefined => (ctx.get('llm') === undefined ? undefined : request => complete(ctx, request)),
      logger: ctx.logger,
      onRecord: record => { ctx.emit('im-polish/record', record) },
    }, config)
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void>, void> {
    await this.host.open()
    yield async () => { await this.host.dispose() }
    this.home.on('im/before-send', async (outgoing: ImOutgoing, next) => {
      try {
        await this.host.beforeSend(outgoing)
      } catch (error) {
        // A broken polish must never cost the agent its message.
        this.home.logger.warn('IM polish failed for %s; sending as is: %s', outgoing.chat, error)
      }
      return next()
    })
    // The operator panel is optional: its tab appears when `dsh-im-panel` is mounted.
    applyPanel(this.home, this)
  }

  /** The configuration in force. */
  get config(): PolishConfig { return this.host.config }

  /**
   * Recorded decisions, newest first.
   * @param filter - chat, action, free text and paging.
   * @returns the records.
   */
  records(filter?: PolishRecordFilter): PolishRecord[] { return this.host.records(filter) }

  /**
   * One recorded decision.
   * @param id - the record id.
   * @returns the record, when kept.
   */
  record(id: string): PolishRecord | undefined { return this.host.get(id) }

  /**
   * Counts of the log.
   * @param filter - chat and the earliest decision time.
   * @returns totals per action and reason.
   */
  stats(filter?: { chat?: string; since?: number }): PolishStats { return this.host.stats(filter) }

  /**
   * Delete records.
   * @param filter - one chat, or everything.
   * @returns how many were deleted.
   */
  clear(filter?: { chat?: string }): Promise<number> { return this.host.clear(filter) }

  /** The per-chat switches the panel set. */
  overrides(): ChatOverride[] { return this.host.overrides() }

  /**
   * Switch the polish for one chat; `undefined` returns it to the configuration.
   * @param chat - chat key.
   * @param enabled - the switch.
   * @returns the stored switch.
   */
  setChat(chat: string, enabled: boolean | undefined): Promise<ChatOverride | undefined> { return this.host.setChat(chat, enabled) }

  /**
   * Whether the polish is on for one chat, with the style it would use.
   * @param chat - chat key.
   * @returns the effective switch, style and note.
   */
  chatState(chat: ImChatKey): ReturnType<PolishHost['resolve']> { return this.host.resolve(this.host.subjectOf(chat, undefined)) }

  /**
   * What the polish would make of one text in one chat; nothing is sent or recorded.
   * @param chat - chat key.
   * @param text - the draft.
   * @param session - optional session (its route and preset).
   * @returns the decision.
   */
  preview(chat: ImChatKey, text: string, session?: string): Promise<PolishOutcome> { return this.host.preview(chat, text, session) }
}

export default ImPolishService
