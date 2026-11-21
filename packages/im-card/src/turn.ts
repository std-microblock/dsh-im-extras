/**
 * The cards of one streamed turn: the {@link TurnCardService} the summary renderer consumes. A ```` ```satori-tsx ````
 * block is compiled and mounted once its closing fence arrives; until then (and while the VM starts) its place shows
 * a placeholder line, and a block that fails shows the error. The turn renderer republishes its message whenever a
 * card changes; once the turn ends, the card service owns the message and republishes it on later changes.
 *
 * @module dsh-im-card/turn
 */
import { randomBytes } from 'node:crypto'
import { h, type Element, type MessageHandle } from '@deepseek-ai/cordis-plugin-im-core'
import type { ImActivity, ImChatKey } from '@deepseek-ai/dsh-im'
import { bundleCard, normalizePath, type CardFiles } from './bundle.ts'
import { CardService, requesterFrom } from './service.ts'

/** The structural contract `dsh-im-output-summary` consumes (kept in sync with its `cards.ts`). */
export interface TurnCards {
  render(index: number, source: string, complete: boolean): Element[]
  slot(index: number): Element
  attach(update: () => void): void
  adopt(handle: MessageHandle, slotted: Element<'message'>): Promise<void>
  readonly count: number
  /** Resolves once every card block started so far has mounted or failed. */
  settle(): Promise<void>
  dispose(): void
}

/** Reads the files an inline card imports, relative to its session's working directory. */
export type FilesFor = (activity: ImActivity) => Promise<{ files: CardFiles; cwd: string } | undefined>

type SlotState =
  | { kind: 'starting'; source: string }
  | { kind: 'live'; id: string }
  | { kind: 'failed'; error: string }

/** One turn's cards. */
export class TurnCardSet implements TurnCards {
  private readonly slots = new Map<number, SlotState>()
  private readonly host = `turn-${randomBytes(6).toString('hex')}`
  private detach: (() => void) | undefined
  private update: (() => void) | undefined
  private readonly pending = new Set<Promise<void>>()

  private readonly service: CardService
  private readonly activity: ImActivity
  private readonly chat: ImChatKey
  private readonly filesFor: FilesFor

  constructor(service: CardService, activity: ImActivity, chat: ImChatKey, filesFor: FilesFor) {
    this.service = service
    this.activity = activity
    this.chat = chat
    this.filesFor = filesFor
  }

  get count(): number {
    let n = 0
    for (const state of this.slots.values()) if (state.kind === 'live') n++
    return n
  }

  attach(update: () => void): void {
    this.update = update
    this.detach = this.service.attachStream(this.host, update)
  }

  render(index: number, source: string, complete: boolean): Element[] {
    if (!complete) return [h('small', h.text('⏳ 正在生成卡片…'))]
    let state = this.slots.get(index)
    if (state === undefined) {
      if (this.slots.size >= this.service.config.maxSlotsPerTurn) {
        state = { kind: 'failed', error: `一条消息最多 ${this.service.config.maxSlotsPerTurn} 张卡片` }
        this.slots.set(index, state)
      } else {
        state = { kind: 'starting', source }
        this.slots.set(index, state)
        const started = this.start(index, source)
        this.pending.add(started)
        void started.finally(() => this.pending.delete(started))
      }
    }
    switch (state.kind) {
      case 'starting': return [h('small', h.text('⏳ 正在加载卡片…'))]
      case 'failed': return [h('small', h.text(`⚠️ 卡片无法显示：${state.error}`))]
      case 'live': return this.service.slotElements(state.id) ?? []
    }
  }

  slot(index: number): Element {
    const state = this.slots.get(index)
    return state?.kind === 'live' ? CardService.slot(this.cardIndex(state.id)) : this.render(index, '', true)[0]!
  }

  async adopt(handle: MessageHandle, slotted: Element<'message'>): Promise<void> {
    const ids = this.ids()
    // Slot placeholders were numbered by block index; the host stores them by position in `ids`.
    await this.service.adoptHost(this.host, handle, slotted, ids)
  }

  async settle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending])
  }

  dispose(): void {
    this.detach?.()
    this.detach = undefined
  }

  private ids(): string[] {
    return [...this.slots.entries()]
      .sort(([a], [b]) => a - b)
      .flatMap(([, state]) => (state.kind === 'live' ? [state.id] : []))
  }

  private cardIndex(id: string): number {
    return this.ids().indexOf(id)
  }

  private async start(index: number, source: string): Promise<void> {
    try {
      const where = await this.filesFor(this.activity)
      const files: CardFiles = where?.files ?? { read: async () => undefined }
      const bundle = await bundleCard({ inline: source, cwd: normalizePath(where?.cwd ?? '/') }, files, {
        maxModules: this.service.config.maxModules, maxBytes: this.service.config.maxSourceBytes,
      })
      // The message that started the turn names the person the card answers (quick replies default to them). A bot
      // that only posted an alert names nobody: it cannot press a button, so the card asks whoever is reading it.
      const requester = requesterFrom(this.activity.trigger?.sender)
      const card = await this.service.mountSlot({
        bundle, props: {}, session: this.activity.session.sessionId, chat: this.chat, host: this.host, index,
        ...where?.cwd === undefined ? {} : { cwd: where.cwd },
        ...requester === undefined ? {} : { requester },
      })
      this.slots.set(index, { kind: 'live', id: card.id })
    } catch (error) {
      this.slots.set(index, { kind: 'failed', error: (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '' })
    }
    this.update?.()
  }
}
