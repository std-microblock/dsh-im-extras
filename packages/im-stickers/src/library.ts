/**
 * The sticker library: records in the `im_stickers` domain, bytes and previews in the data directory, the
 * classification jobs, and the pick.
 *
 * A picture is stored once (keyed by the SHA-1 of its bytes): uploading it again or collecting it from another chat
 * returns the existing sticker. A new sticker is classified in the background when a classifier is available; a
 * failure is recorded on the sticker (`error`) and never blocks the import. One classification job runs at a time
 * and reports its progress through `emit`.
 *
 * @module dsh-im-stickers/library
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { StickerChatOverride, StickerOrigin, StickerRecord } from './domain.ts'
import { imStickersDomain, type ImStickersDomain } from './domain.ts'
import type { StickersConfig, StickerType } from './config.ts'
import { extensionOf, headerSize, isAnimated, sniffMime, type EncodedImage, type ImageTools } from './image.ts'
import { filterStickers, pickSticker, type PickOptions, type StickerFilter } from './pick.ts'
import { parseClassification } from './prompt.ts'

/** Progress of one background job. */
export interface StickerJob {
  id: string
  kind: 'classify'
  total: number
  done: number
  failed: number
  running: boolean
  cancelled: boolean
  started: number
  finished: number
  current: string
  errors: string[]
}

/** What the library tells its listeners. */
export type LibraryEvent =
  | { type: 'sticker'; id: number; removed?: true }
  | { type: 'job'; job: StickerJob }

/** Describes one sticker from its pictures: the classifier's raw answer. */
export type Classifier = (frames: EncodedImage[], types: readonly StickerType[], signal?: AbortSignal) => Promise<string>

/** What the library needs. */
export interface LibraryDeps {
  storage: Pick<DomainFacility, 'open'>
  /** The data directory. */
  dir: string
  image: ImageTools
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void }
  /** The classifier in force, or undefined when none is configured or no model service is mounted. */
  classifier: () => Classifier | undefined
  emit?: (event: LibraryEvent) => void
  now?: () => number
}

/** Fields an operator may change. */
export interface StickerPatch {
  desc?: string
  tags?: string[]
  weight?: number
  enabled?: boolean
  title?: string
}

/** Counts for the panel header. */
export interface StickerStats {
  total: number
  enabled: number
  undescribed: number
  untagged: number
  failed: number
  bySource: Record<string, number>
  byTag: Record<string, number>
}

/** One new file for the library. */
export interface StickerInput {
  data: Uint8Array
  /** File name or alt text. */
  name?: string
  source: StickerRecord['source']
  origin?: StickerOrigin
}

export class StickerLibrary {
  readonly thumbDir: string
  private domain: ImStickersDomain | undefined
  private nextId = 1
  private job: StickerJob | undefined
  private readonly running = new Set<Promise<unknown>>()
  private readonly now: () => number

  constructor(readonly deps: LibraryDeps, public config: StickersConfig) {
    this.thumbDir = join(deps.dir, 'thumbs')
    this.now = deps.now ?? Date.now
  }

  /** Open the domain and create the data directory. */
  async open(): Promise<void> {
    const domain = await this.deps.storage.open(imStickersDomain)
    this.domain = domain
    for (const [, row] of domain.table('stickers').entries()) this.nextId = Math.max(this.nextId, row.id + 1)
    await mkdir(this.thumbDir, { recursive: true })
  }

  /** Cancel the running job, wait for in-flight work and close the domain. */
  async dispose(): Promise<void> {
    if (this.job?.running) this.job.cancelled = true
    await Promise.allSettled([...this.running])
    const domain = this.domain
    this.domain = undefined
    await domain?.close()
  }

  // ---------------------------------------------------------------------------------------------------------------
  // reads

  /** The configured categories. */
  types(): StickerType[] { return this.config.types }

  /** Every sticker, unordered. */
  all(): StickerRecord[] {
    const table = this.domain?.table('stickers')
    return table === undefined ? [] : [...table.entries()].map(([, row]) => row)
  }

  /**
   * Filter, order and page the library.
   * @param filter - the listing request.
   * @returns the matching stickers.
   */
  list(filter: StickerFilter = {}): StickerRecord[] {
    return filterStickers(this.all(), filter, this.types())
  }

  /**
   * One sticker.
   * @param id - its id.
   * @returns the record, when it exists.
   */
  get(id: number): StickerRecord | undefined {
    return this.domain?.table('stickers').get(String(id))
  }

  /** Stickers an agent may pick from. */
  enabledCount(): number {
    let count = 0
    for (const row of this.all()) if (row.enabled) count++
    return count
  }

  /** Counts for the panel. */
  stats(): StickerStats {
    const stats: StickerStats = { total: 0, enabled: 0, undescribed: 0, untagged: 0, failed: 0, bySource: {}, byTag: {} }
    for (const row of this.all()) {
      stats.total++
      if (row.enabled) stats.enabled++
      if (!row.desc) stats.undescribed++
      if (row.tags.length === 0) stats.untagged++
      if (row.error) stats.failed++
      stats.bySource[row.source] = (stats.bySource[row.source] ?? 0) + 1
      if (row.enabled) for (const tag of row.tags) stats.byTag[tag] = (stats.byTag[tag] ?? 0) + 1
    }
    return stats
  }

  /**
   * Absolute path of a sticker's bytes or its preview.
   * @param row - the sticker.
   * @param thumb - the preview, when one exists.
   * @returns the path.
   */
  filePath(row: StickerRecord, thumb = false): string {
    return thumb && row.thumb ? join(this.thumbDir, row.thumb) : join(this.deps.dir, row.file)
  }

  /**
   * The bytes of a sticker or its preview, for the panel.
   * @param id - the sticker id.
   * @param thumb - the preview when one exists, else the original.
   * @returns bytes and media type, or undefined.
   */
  async read(id: number, thumb = false): Promise<EncodedImage | undefined> {
    const row = this.get(id)
    if (row === undefined) return undefined
    const useThumb = thumb && row.thumb !== ''
    const data = await readFile(this.filePath(row, useThumb)).catch(() => undefined)
    if (data === undefined) return undefined
    return { data, mime: useThumb ? 'image/png' : row.mime }
  }

  /**
   * Choose one enabled sticker.
   * @param options - tags, hint, exclusions; the weight floor defaults to `minWeight`.
   * @param rnd - the die.
   * @returns the sticker, or undefined when none qualifies.
   */
  pick(options: PickOptions = {}, rnd: () => number = Math.random): StickerRecord | undefined {
    return pickSticker(this.all(), { minWeight: this.config.minWeight, ...options }, this.types(), this.now(), rnd)
  }

  // ---------------------------------------------------------------------------------------------------------------
  // writes

  /**
   * Store one picture (or find it already stored), then classify it in the background.
   * @param input - bytes, name, source and origin.
   * @returns the sticker and whether it is new.
   * @throws Error for a file that is not an image or is over `maxBytes`.
   */
  async add(input: StickerInput): Promise<{ row: StickerRecord; created: boolean }> {
    const domain = this.domainOf()
    const data = Buffer.from(input.data.buffer, input.data.byteOffset, input.data.byteLength)
    if (data.byteLength === 0) throw new Error('empty file')
    if (data.byteLength > this.config.maxBytes) throw new Error(`file too large (${data.byteLength} bytes, limit ${this.config.maxBytes})`)
    const mime = sniffMime(data)
    if (mime === undefined) throw new Error('not a PNG, JPEG, GIF, WebP or BMP image')
    const sha = createHash('sha1').update(data).digest('hex')
    const key = `sha1:${sha}`
    const existing = this.all().find(row => row.key === key)
    if (existing !== undefined) return { row: existing, created: false }
    const file = `${sha}.${extensionOf(mime)}`
    await mkdir(this.thumbDir, { recursive: true })
    await writeFile(join(this.deps.dir, file), data)
    const preview = await this.deps.image.thumbnail(join(this.deps.dir, file)).catch(() => undefined)
    let thumb = ''
    if (preview !== undefined) {
      thumb = `${sha}.png`
      await writeFile(join(this.thumbDir, thumb), preview).catch(() => { thumb = '' })
    }
    const size = headerSize(data)
    const now = this.now()
    const row: StickerRecord = {
      id: this.nextId++,
      key,
      source: input.source,
      ...input.origin === undefined ? {} : { origin: input.origin },
      title: (input.name ?? '').slice(0, 120),
      desc: '',
      tags: [],
      weight: 50,
      enabled: true,
      format: isAnimated(data) ? 'animated' : 'static',
      mime,
      width: size?.width ?? 0,
      height: size?.height ?? 0,
      size: data.byteLength,
      file,
      thumb,
      uses: 0,
      lastUsed: 0,
      created: now,
      updated: now,
      error: '',
    }
    await domain.table('stickers').put(String(row.id), row)
    this.deps.emit?.({ type: 'sticker', id: row.id })
    if (this.config.classify.enabled && this.deps.classifier() !== undefined) this.background(this.classify(row.id))
    return { row, created: true }
  }

  /**
   * Change one sticker.
   * @param id - the sticker.
   * @param patch - the fields to change; the weight is clamped to 0–100, unknown tags are dropped.
   * @returns the updated sticker, or undefined when it does not exist.
   */
  async update(id: number, patch: StickerPatch): Promise<StickerRecord | undefined> {
    const domain = this.domainOf()
    const row = this.get(id)
    if (row === undefined) return undefined
    const known = new Set(this.types().map(type => type.id))
    const next: StickerRecord = {
      ...row,
      ...patch.desc === undefined ? {} : { desc: patch.desc.replace(/\s+/g, ' ').trim().slice(0, 120) },
      ...patch.tags === undefined ? {} : { tags: [...new Set(patch.tags)].filter(tag => known.has(tag)) },
      ...patch.weight === undefined ? {} : { weight: Math.max(0, Math.min(100, Math.round(patch.weight))) },
      ...patch.enabled === undefined ? {} : { enabled: patch.enabled },
      ...patch.title === undefined ? {} : { title: patch.title.slice(0, 120) },
      updated: this.now(),
    }
    await domain.table('stickers').put(String(id), next)
    this.deps.emit?.({ type: 'sticker', id })
    return next
  }

  /**
   * Change many stickers at once (panel batch actions). `addTags` / `removeTags` edit the tag lists instead of
   * replacing them.
   * @param ids - the stickers.
   * @param patch - the fields to set.
   * @returns how many stickers changed.
   */
  async updateMany(ids: readonly number[], patch: StickerPatch & { addTags?: string[]; removeTags?: string[] }): Promise<number> {
    let changed = 0
    for (const id of new Set(ids)) {
      const row = this.get(id)
      if (row === undefined) continue
      let tags = patch.tags
      if (patch.addTags !== undefined || patch.removeTags !== undefined) {
        const base = tags ?? row.tags
        tags = [...base, ...patch.addTags ?? []].filter(tag => !(patch.removeTags ?? []).includes(tag))
      }
      const { addTags: _add, removeTags: _remove, ...rest } = patch
      if (await this.update(id, { ...rest, ...tags === undefined ? {} : { tags } })) changed++
    }
    return changed
  }

  /**
   * Delete stickers and their files (best effort: the record is the truth).
   * @param ids - the stickers.
   * @returns how many were deleted.
   */
  async remove(ids: readonly number[]): Promise<number> {
    const domain = this.domainOf()
    let removed = 0
    for (const id of new Set(ids)) {
      const row = this.get(id)
      if (row === undefined) continue
      await domain.table('stickers').delete(String(id))
      // Another sticker never shares the file: the file name is the content hash, and a hash is stored once.
      await unlink(this.filePath(row)).catch(() => {})
      if (row.thumb) await unlink(this.filePath(row, true)).catch(() => {})
      this.deps.emit?.({ type: 'sticker', id, removed: true })
      removed++
    }
    return removed
  }

  /**
   * Count one use (the pick softens recently used stickers).
   * @param id - the sticker sent.
   */
  async recordUse(id: number): Promise<void> {
    const row = this.get(id)
    if (row === undefined) return
    await this.domainOf().table('stickers').put(String(id), { ...row, uses: row.uses + 1, lastUsed: this.now() })
  }

  // ---------------------------------------------------------------------------------------------------------------
  // classification

  /**
   * Describe and tag one sticker with the vision model. Failures are recorded on the sticker and never thrown.
   * @param id - the sticker.
   * @param force - also re-classify a sticker that already has a description.
   * @param signal - cancellation.
   * @returns the updated sticker.
   */
  async classify(id: number, force = false, signal?: AbortSignal): Promise<StickerRecord | undefined> {
    const row = this.get(id)
    if (row === undefined) return undefined
    if (row.desc && row.tags.length > 0 && !force) return row
    const classifier = this.deps.classifier()
    if (classifier === undefined) return this.fail(id, 'no classifier: configure classify.provider and classify.model')
    const path = this.filePath(row)
    const original = await readFile(path).catch(() => undefined)
    if (original === undefined) return this.fail(id, 'the sticker file is missing')
    const frames = await this.deps.image.visionFrames(path, { data: original, mime: row.mime }).catch(() => [])
    if (frames.length === 0) return this.fail(id, 'no picture the model can read (no ImageMagick, or an unsupported format); describe it by hand')
    try {
      const text = await classifier(frames, this.types(), signal)
      const { tags, desc } = parseClassification(text, this.types())
      if (!desc && tags.length === 0) return this.fail(id, `the model gave no usable answer: ${text.slice(0, 120) || '(empty)'}`)
      const current = this.get(id)
      if (current === undefined) return undefined
      const next: StickerRecord = {
        ...current, desc: desc || current.desc, tags: tags.length > 0 ? tags : current.tags, error: '', updated: this.now(),
      }
      await this.domainOf().table('stickers').put(String(id), next)
      this.deps.emit?.({ type: 'sticker', id })
      return next
    } catch (error) {
      if (signal?.aborted) throw error
      const message = error instanceof Error ? error.message : String(error)
      this.deps.logger.warn('sticker classify #%d: %s', id, message)
      return this.fail(id, `classification failed: ${message}`.slice(0, 200))
    }
  }

  /**
   * Start a background job classifying stickers, `classify.concurrency` at a time.
   * @param ids - the stickers; absent means every sticker without a description or tags.
   * @param options - `force` re-classifies stickers that already have both.
   * @returns the job.
   * @throws Error when a job is already running or nothing needs classifying.
   */
  beginClassify(ids?: readonly number[], options: { force?: boolean } = {}): StickerJob {
    if (this.job?.running) throw new Error(`a sticker job is already running (${this.job.done}/${this.job.total})`)
    const wanted = ids === undefined
      ? this.all().filter(row => !row.desc || row.tags.length === 0).map(row => row.id)
      : [...new Set(ids)].filter(id => this.get(id) !== undefined)
    if (wanted.length === 0) throw new Error('nothing to classify')
    const job: StickerJob = {
      id: randomUUID().slice(0, 8), kind: 'classify', total: wanted.length, done: 0, failed: 0,
      running: true, cancelled: false, started: this.now(), finished: 0, current: '', errors: [],
    }
    this.job = job
    this.deps.emit?.({ type: 'job', job: { ...job } })
    this.background(this.runJob(job, wanted, options.force === true))
    return job
  }

  /** The current or last job. */
  jobState(): StickerJob | undefined { return this.job === undefined ? undefined : { ...this.job, errors: [...this.job.errors] } }

  /** Ask the running job to stop after the stickers in flight. */
  cancelJob(): boolean {
    if (!this.job?.running) return false
    this.job.cancelled = true
    return true
  }

  private async runJob(job: StickerJob, ids: number[], force: boolean): Promise<void> {
    let index = 0
    const workers = Array.from({ length: Math.max(1, Math.min(this.config.classify.concurrency, ids.length)) }, async () => {
      for (;;) {
        if (job.cancelled) return
        const id = ids[index++]
        if (id === undefined) return
        job.current = `#${id}`
        try {
          const row = await this.classify(id, force)
          if (row?.error) {
            job.failed++
            if (job.errors.length < 20) job.errors.push(`#${id}: ${row.error}`)
          }
        } catch (error) {
          job.failed++
          if (job.errors.length < 20) job.errors.push(`#${id}: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
          job.done++
          this.deps.emit?.({ type: 'job', job: { ...job } })
        }
      }
    })
    await Promise.all(workers)
    job.running = false
    job.finished = this.now()
    job.current = ''
    this.deps.emit?.({ type: 'job', job: { ...job } })
  }

  private async fail(id: number, error: string): Promise<StickerRecord | undefined> {
    const row = this.get(id)
    if (row === undefined) return undefined
    const next = { ...row, error, updated: this.now() }
    await this.domainOf().table('stickers').put(String(id), next)
    this.deps.emit?.({ type: 'sticker', id })
    return next
  }

  private background(work: Promise<unknown>): void {
    const tracked = work.catch((error: unknown) => { this.deps.logger.warn('sticker background work failed: %s', error) })
    this.running.add(tracked)
    void tracked.finally(() => { this.running.delete(tracked) })
  }

  /** Wait for background classification (tests and shutdown). */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running])
  }

  // ---------------------------------------------------------------------------------------------------------------
  // per-chat automatic sticker switches

  /** The panel's per-chat switches. */
  overrides(): StickerChatOverride[] {
    const table = this.domain?.table('chats')
    return table === undefined ? [] : [...table.entries()].map(([, value]) => value)
  }

  /**
   * The panel's switch of one chat.
   * @param chat - chat key.
   * @returns the switch, when set.
   */
  override(chat: string): StickerChatOverride | undefined {
    return this.domain?.table('chats').get(chat)
  }

  /**
   * Set or clear the automatic-sticker switch of one chat.
   * @param chat - chat key.
   * @param value - `enabled` and/or `percent`; undefined clears the switch.
   * @returns the stored switch.
   */
  async setChat(chat: string, value: { enabled?: boolean; percent?: number } | undefined): Promise<StickerChatOverride | undefined> {
    const table = this.domainOf().table('chats')
    if (value === undefined || (value.enabled === undefined && value.percent === undefined)) {
      await table.delete(chat)
      return undefined
    }
    const stored: StickerChatOverride = {
      chat,
      ...value.enabled === undefined ? {} : { enabled: value.enabled },
      ...value.percent === undefined ? {} : { percent: Math.max(0, Math.min(100, value.percent)) },
      updatedAt: this.now(),
    }
    await table.put(chat, stored)
    return stored
  }

  private domainOf(): ImStickersDomain {
    if (this.domain === undefined) throw new Error('The sticker store is not open.')
    return this.domain
  }
}
