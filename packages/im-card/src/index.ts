/**
 * `dsh-im-card`: interactive Feishu cards written as React-like TSX.
 *
 * - `ctx.imCards` runs every card: one QuickJS VM per card, hooks, click callbacks, timers, `agent.send`, a data
 *   folder (`fs`, `useStoredState`) and bounded `fetch`, whole-VM snapshots that survive restarts (see `service.ts`).
 * - `im_send_card` publishes a card from a `.tsx` file (registered where `tools`, `fs` and `workingDirectory` exist).
 * - `dsh-im-output-summary` embeds ```` ```satori-tsx ```` blocks of a streamed answer through {@link ImCardsService.turn}.
 * - The prebuilt quick-reply components (`PromptButton`, `PromptChoices`, `PromptForm`, `Switch`, `Segmented`,
 *   `Stepper`) are part of the card vocabulary, and {@link GUIDANCE} teaches them from the first turn on.
 * - The `im-card` skill teaches the model how to write cards.
 *
 * ```yaml
 * - dsh-im-card:
 *     maxLive: 32
 *     editIntervalMs: 1000
 * ```
 *
 * @module dsh-im-card
 */
import { readFileSync } from 'node:fs'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ImActivity, ImApi, ImChatKey, ImMessageKey } from '@deepseek-ai/dsh-im'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-working-directory'
import { bundleCard, normalizePath, type CardFiles } from './bundle.ts'
import { Config, type CardsConfig } from './config.ts'
import { GUIDANCE, GUIDANCE_ORDER, GUIDANCE_SECTION } from './guidance.ts'
import { CardService } from './service.ts'
import { applyCardTool } from './tools.ts'
import { TurnCardSet, type TurnCards } from './turn.ts'

export { bundleCard, CARD_TYPES, CardSourceError, type CardBundle } from './bundle.ts'
export { Config, type CardsConfig } from './config.ts'
export { cardFiles, DEFAULT_DATA_DIR } from './data.ts'
export { imCardsDomain, type CardRecord, type HostRecord } from './domain.ts'
export {
  CardEngine, CardVm, type CardContext, type CardFetchReply, type CardFetchRequest, type CardFetchResult,
  type CardFilesReply, type CardFilesRequest, type CardNode, type CardSnapshot, type CardVmHost,
} from './engine.ts'
export { GUIDANCE, GUIDANCE_ORDER, GUIDANCE_SECTION } from './guidance.ts'
export { cardFetch, type FetchLimits } from './http.ts'
export {
  CARD_BUTTON_PREFIX, CardService, requesterFrom, type RequesterSender, type CardActionContext,
  type CardActionHandler, type CardGuardContext, type CardGuardResult, type CardInteractionGuard,
} from './service.ts'
export { TurnCardSet, type TurnCards } from './turn.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Interactive cards. */
    imCards: ImCardsService
  }
}

const SKILL = readFileSync(new URL('../skill/SKILL.md', import.meta.url), 'utf8')

/** The card service, provided as `ctx.imCards`. */
export class ImCardsService extends Service {
  static inject = ['im', 'storageDomain']
  static Config = Config

  readonly cards: CardService
  private readonly home: Context
  private readonly im: ImApi

  constructor(ctx: Context, readonly config: CardsConfig) {
    super(ctx, 'imCards')
    this.home = ctx
    this.im = ctx.im
    this.cards = new CardService(ctx, this.im, config)
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void>, void> {
    const ctx = this.home
    await this.cards.open()
    yield async () => { await this.cards.dispose() }
    ctx.inject(['tools', 'fs', 'workingDirectory'], (scoped) => { applyCardTool(scoped, this.im, this.cards) })
    ctx.inject(['skills'], (scoped) => {
      const { description, body } = frontmatter(SKILL)
      scoped.effect(() => scoped.skills.register({ name: 'im-card', description, content: body, source: 'runtime' }))
    })
    // The prebuilt components are told up front, so a confirmation does not depend on the model loading the skill.
    ctx.inject(['systemPrompt'], (scoped) => {
      const text = this.config.guidance ?? GUIDANCE
      if (text === '') return
      scoped.effect(() => scoped.systemPrompt.section({
        name: GUIDANCE_SECTION, order: GUIDANCE_ORDER, interpolate: false, text,
      }))
    })
  }

  /**
   * Open the cards of one streamed turn (consumed by `dsh-im-output-summary`).
   * @param activity - the turn.
   * @param chat - the chat the turn publishes into.
   * @returns the turn's card set.
   */
  turn(activity: ImActivity, chat: ImChatKey): TurnCards {
    return new TurnCardSet(this.cards, activity, chat, a => this.filesFor(a))
  }

  /**
   * Register a synchronous host action handler invoked by trusted preset components (e.g. `<AuthRequest>`).
   * @param name - host action name.
   * @param handler - action handler.
   * @returns disposer removing the registration.
   */
  registerAction(name: string, handler: import('./service.ts').CardActionHandler): () => void {
    return this.cards.registerAction(name, handler)
  }

  /**
   * Register an interaction guard checked before any click, select, or checkbox toggle reaches a card VM.
   * @param guard - guard predicate.
   * @returns disposer removing the guard.
   */
  registerGuard(guard: import('./service.ts').CardInteractionGuard): () => void {
    return this.cards.registerGuard(guard)
  }

  /**
   * Push a host-originated event into a live or stored card, re-rendering and republishing if state changed.
   * @param cardId - target card id.
   * @param channel - channel name.
   * @param data - JSON-serializable payload.
   * @returns whether a listener in the card handled the event.
   */
  pushEvent(cardId: string, channel: string, data: unknown): Promise<boolean> {
    return this.cards.pushEvent(cardId, channel, data)
  }

  /**
   * Compile an inline TSX card snippet (without local file imports) and publish it directly into a hosted session.
   * Used by host plugins such as `dsh-im-session-auth` to post interactive preset cards (e.g. `<AuthRequest />`).
   */
  async publishInline(request: {
    source: string
    props?: unknown
    session: SessionId
    chat: ImChatKey
    quote?: ImMessageKey
    thread?: string
    operationId?: string
    requester?: { id: string; name?: string }
    grant?: boolean
  }): Promise<import('./service.ts').PublishedCard> {
    const emptyFiles: CardFiles = { read: async () => undefined }
    const bundle = await bundleCard(
      { inline: request.source, cwd: '/' },
      emptyFiles,
      {
        maxModules: this.config.maxModules,
        maxBytes: this.config.maxSourceBytes,
        typecheck: false,
      },
    )
    return await this.cards.publish({
      bundle,
      props: request.props ?? {},
      session: request.session,
      chat: request.chat,
      ...request.quote === undefined ? {} : { quote: request.quote },
      ...request.thread === undefined ? {} : { thread: request.thread },
      ...request.operationId === undefined ? {} : { operationId: request.operationId },
      ...request.requester === undefined ? {} : { requester: request.requester },
      ...request.grant === undefined ? {} : { grant: request.grant },
    })
  }

  /** The working directory and file reader of a turn's session, when the deployment has a filesystem. */
  private async filesFor(activity: ImActivity): Promise<{ files: CardFiles; cwd: string } | undefined> {
    const fs = this.home.get('fs') as Context['fs'] | undefined
    const wd = this.home.get('workingDirectory') as Context['workingDirectory'] | undefined
    if (fs === undefined || wd === undefined) return undefined
    const agent = await this.im.sessions.agent(activity.session.sessionId)
    const cwd = await wd.ensure(agent)
    const cwdTarget = await fs.resolve('.', { cwd })
    return {
      cwd: normalizePath(fs.processPath(cwdTarget)),
      files: {
        read: async (path) => {
          try {
            const target = await fs.resolve(path, { cwd })
            const info = await fs.stat(target)
            return info?.type === 'file' ? await fs.readText(target) : undefined
          } catch {
            // Absent or unreadable: the bundler probes the next candidate.
            return undefined
          }
        },
      },
    }
  }
}

/** Split YAML-ish frontmatter (`description:` only) from a skill file. */
function frontmatter(text: string): { description: string; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  if (match === null) return { description: 'Interactive IM cards', body: text }
  const description = /^description:\s*(.+)$/m.exec(match[1]!)?.[1]?.trim() ?? 'Interactive IM cards'
  return { description, body: text.slice(match[0].length) }
}

export default ImCardsService
