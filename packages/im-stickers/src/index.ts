/**
 * `dsh-im-stickers`: a sticker library for dsh-im.
 *
 * Stickers are pictures the bot may send as a reaction. They enter the library by panel upload or by collecting a
 * picture someone posted in a chat (`sticker_collect`, or `ctx.imStickers.collect` from a panel); a vision model then
 * writes a one-line description of each and tags it with the configured types. Agents send them with `send_sticker`
 * (by id, or picked by tags and a hint — weighted, with recently used stickers softened) and browse with
 * `sticker_search`; a system prompt section explains the etiquette. When the bot finishes a burst of messages in a
 * chat and stays quiet for `auto.gapMs`, a sticker may follow automatically (`auto.percent`, lower on QQ by default,
 * configurable and switchable per chat).
 *
 * Every sticker goes out as an image element, which every platform renders. Records live in the `im_stickers`
 * storage domain; files and previews in `dataDir`. ImageMagick (`magick`) makes previews and lets the classifier see
 * animations frame by frame; without it both degrade instead of failing.
 *
 * @module dsh-im-stickers
 */
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { createResourceFetcher } from '@deepseek-ai/cordis-plugin-im-core'
import type { ImChatKey, ImMessage, ImSendResult } from '@deepseek-ai/dsh-im'
import type { ContentBlock, ImageBlock } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { Config, type AutoConfig, type StickersConfig } from './config.ts'
import type { StickerChatOverride, StickerRecord } from './domain.ts'
import { StickerHost, type ResourceFetch, type StickerSendOptions } from './host.ts'
import { ImageTools, type EncodedImage } from './image.ts'
import {
  StickerLibrary, type Classifier, type LibraryEvent, type StickerJob, type StickerPatch, type StickerStats,
} from './library.ts'
import { complete } from './llm.ts'
import type { PickOptions, StickerFilter } from './pick.ts'
import { classifySystem, classifyUser } from './prompt.ts'
import { applyPanel } from './panel.ts'
import { applyPrompt, applyTools } from './tools.ts'

export {
  autoFor, Config, DEFAULT_RULES, DEFAULT_STICKER_TYPES,
  type AutoConfig, type ClassifyConfig, type StickerRule, type StickersConfig, type StickerSubject, type StickerType,
} from './config.ts'
export { admitSource, isPublicAddress, mediaElements, parseMediaId, type HostResolver, type MediaElement } from './collect.ts'
export { imStickersDomain, type ImStickersDomain, type StickerChatOverride, type StickerOrigin, type StickerRecord } from './domain.ts'
export { StickerHost, STICKER_ALT_PREFIX, type ResourceFetch, type StickerHostDeps, type StickerSendOptions } from './host.ts'
export {
  extensionOf, headerSize, ImageTools, isAnimated, MODEL_IMAGE_TYPES, run, sampleIndices, sniffMime,
  type EncodedImage, type RunResult, type Runner,
} from './image.ts'
export {
  StickerLibrary, type Classifier, type LibraryDeps, type LibraryEvent, type StickerInput, type StickerJob,
  type StickerPatch, type StickerStats,
} from './library.ts'
export { complete, type Complete, type CompletionRequest } from './llm.ts'
export {
  bigrams, filterStickers, hintScore, pickSticker, recencyFactor, stickerLabel, weightedPick,
  type PickOptions, type StickerFilter,
} from './pick.ts'
export {
  classifySystem, classifyUser, parseClassification, parseJsonLoose, PROMPT_ORDER, PROMPT_SECTION, stickerPrompt,
} from './prompt.ts'
export { applyPanel, STICKERS_TAB, stickersTab, type PanelHost, type PanelTabDefinition, type StickerTabService } from './panel.ts'
export { MessageSegments, segmentWantsSticker, type MessageSegment, type SegmentTimers } from './segments.ts'
export { applyPrompt, applyTools, STICKER_TOOLS } from './tools.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The sticker library. */
    imStickers: ImStickersService
  }
  interface Events {
    /**
     * A sticker was added, changed or removed, or a job progressed.
     * @param event - what changed.
     * @mode emit
     */
    'im-stickers/changed'(event: LibraryEvent): void
  }
}

/** Structural face of the attachment service: only image saving is used. */
interface ImageSaver {
  saveImages(inputs: readonly { data: Uint8Array; mediaType: string; name?: string }[]): Promise<readonly ImageBlock['attachment'][]>
}

/**
 * The data directory of a configuration.
 * @param config - the operator configuration.
 * @returns an absolute path.
 */
export function dataDirOf(config: Pick<StickersConfig, 'dataDir'>): string {
  const configured = config.dataDir.trim()
  if (configured === '') return join(homedir(), '.dsh', 'im-stickers')
  const expanded = configured.startsWith('~') ? join(homedir(), configured.slice(1)) : configured
  return isAbsolute(expanded) ? expanded : resolve(expanded)
}

/** The sticker service (`ctx.imStickers`). */
export class ImStickersService extends Service {
  /** `llm`, `attachments` and `http` are read when they are needed (`ctx.get`), so the library works without them. */
  static inject = ['im', 'llm', 'storageDomain']
  static Config = Config

  readonly library: StickerLibrary
  readonly host: StickerHost
  readonly dir: string
  private readonly home: Context
  private fetcher: ResourceFetch | undefined

  constructor(ctx: Context, readonly config: StickersConfig) {
    super(ctx, 'imStickers')
    this.home = ctx
    this.dir = dataDirOf(config)
    this.library = new StickerLibrary({
      storage: ctx.storageDomain,
      dir: this.dir,
      image: new ImageTools(config.magick),
      logger: ctx.logger,
      classifier: () => this.classifier(),
      emit: event => { ctx.emit('im-stickers/changed', event) },
    }, config)
    this.host = new StickerHost({
      im: ctx.im,
      library: this.library,
      fetch: () => {
        if (ctx.get('http') === undefined) return undefined
        this.fetcher ??= createResourceFetcher(ctx, { maxBytes: config.maxBytes, redirect: 'error', timeout: 60_000 })
        return this.fetcher
      },
      logger: ctx.logger,
    }, config)
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void>, void> {
    const ctx = this.home
    await this.library.open()
    yield async () => {
      this.host.stop()
      await this.library.dispose()
    }
    ctx.on('im/stored', (message: ImMessage) => { this.host.stored(message) })
    const tools = this.config.tools
    ctx.inject(['tools'], (scoped) => { applyTools(scoped, ctx.im, this.library, this.host, tools) })
    if (this.config.prompt) {
      ctx.inject(['systemPrompt'], (scoped) => { applyPrompt(scoped, ctx.im, this.library, tools) })
    }
    // The operator panel is optional: its tab appears when `dsh-im-panel` is mounted.
    applyPanel(ctx, this)
    ctx.logger.info('IM stickers: %d in %s', this.library.all().length, this.dir)
  }

  /** The vision classifier, when a route is configured and the model and attachment services are mounted. */
  private classifier(): Classifier | undefined {
    const { provider, model, reasoningEffort, maxTokens, timeoutMs } = this.config.classify
    const ctx = this.home
    if (!provider || !model || ctx.get('llm') === undefined) return undefined
    const attachments = ctx.get('attachments') as ImageSaver | undefined
    if (attachments === undefined) return undefined
    return async (frames: EncodedImage[], types, signal) => {
      const blocks: ContentBlock[] = [{ type: 'text', text: classifyUser(frames.length) }]
      for (const frame of frames) {
        const [attachment] = await attachments.saveImages([{ data: frame.data, mediaType: frame.mime }])
        if (attachment !== undefined) blocks.push({ type: 'image', attachment })
      }
      if (blocks.length === 1) throw new Error('the attachment store accepted none of the pictures')
      return complete(ctx, {
        provider, model, system: classifySystem(types), user: blocks, temperature: 0.2, maxTokens, timeoutMs,
        ...reasoningEffort === undefined ? {} : { reasoningEffort },
        ...signal === undefined ? {} : { signal },
      })
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // the panel's and other plugins' API

  /** Filter, order and page the library (disabled stickers included unless `enabled` says otherwise). */
  list(filter?: StickerFilter): StickerRecord[] { return this.library.list(filter) }

  /** One sticker. */
  get(id: number): StickerRecord | undefined { return this.library.get(id) }

  /** Counts for the panel header. */
  stats(): StickerStats { return this.library.stats() }

  /** The configured types. */
  types(): StickersConfig['types'] { return this.library.types() }

  /**
   * The bytes of a sticker or its preview.
   * @param id - the sticker.
   * @param thumb - the preview when one exists.
   * @returns bytes and media type.
   */
  file(id: number, thumb = false): Promise<EncodedImage | undefined> { return this.library.read(id, thumb) }

  /**
   * Add uploaded files; each is stored once and classified in the background.
   * @param files - name and bytes of each file.
   * @returns per file: the sticker, whether it is new, or why it was refused.
   */
  async upload(files: readonly { name?: string; data: Uint8Array }[]): Promise<({ id: number; created: boolean } | { error: string; name?: string })[]> {
    const out: ({ id: number; created: boolean } | { error: string; name?: string })[] = []
    for (const file of files) {
      try {
        const { row, created } = await this.library.add({ data: file.data, source: 'upload', ...file.name === undefined ? {} : { name: file.name } })
        out.push({ id: row.id, created })
      } catch (error) {
        out.push({ error: error instanceof Error ? error.message : String(error), ...file.name === undefined ? {} : { name: file.name } })
      }
    }
    return out
  }

  /**
   * Collect a picture posted in a chat.
   * @param chat - chat key.
   * @param id - media id (`12.1`).
   * @returns the sticker and whether it is new.
   */
  collect(chat: ImChatKey, id: string, signal?: AbortSignal): Promise<{ row: StickerRecord; created: boolean }> {
    return this.host.collect(chat, id, signal)
  }

  /** Change one sticker. */
  update(id: number, patch: StickerPatch): Promise<StickerRecord | undefined> { return this.library.update(id, patch) }

  /** Change many stickers (weight, enabled, tags, added or removed tags). */
  updateMany(ids: readonly number[], patch: StickerPatch & { addTags?: string[]; removeTags?: string[] }): Promise<number> {
    return this.library.updateMany(ids, patch)
  }

  /** Delete stickers and their files. */
  remove(ids: readonly number[]): Promise<number> { return this.library.remove(ids) }

  /** Start classifying stickers (all undescribed or untagged ones when `ids` is absent). */
  classify(ids?: readonly number[], options?: { force?: boolean }): StickerJob { return this.library.beginClassify(ids, options) }

  /** The current or last job. */
  job(): StickerJob | undefined { return this.library.jobState() }

  /** Stop the running job. */
  cancelJob(): boolean { return this.library.cancelJob() }

  /** Choose one enabled sticker. */
  pick(options?: PickOptions): StickerRecord | undefined { return this.library.pick(options) }

  /**
   * Send one sticker into a chat, outside any session (panel test send).
   * @param chat - chat key.
   * @param id - sticker id.
   * @param options - attribution and idempotency.
   * @returns the publication result.
   */
  async send(chat: ImChatKey, id: number, options?: StickerSendOptions): Promise<ImSendResult> {
    const row = this.library.get(id)
    if (row === undefined) throw new Error(`no sticker #${id}`)
    return this.host.send(chat, row, options)
  }

  /** The per-chat automatic-sticker switches. */
  overrides(): StickerChatOverride[] { return this.library.overrides() }

  /** Set or clear one chat's automatic-sticker switch. */
  setChat(chat: string, value: { enabled?: boolean; percent?: number } | undefined): Promise<StickerChatOverride | undefined> {
    return this.library.setChat(chat, value)
  }

  /** The automatic-sticker settings in force for one chat. */
  autoOf(chat: string): AutoConfig { return this.host.autoOf(chat) }
}

export default ImStickersService
