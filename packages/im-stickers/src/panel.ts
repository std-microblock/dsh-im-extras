/**
 * The host half of the sticker tab of `dsh-im-panel` (tab id `stickers`).
 *
 * The tab answers every request itself (`fetch`), because it serves images and accepts uploads. The panel is optional
 * and described structurally, so this package neither imports nor depends on it.
 *
 * Routes (all under `/api/im-panel/tab?id=stickers`):
 *
 * - `GET path=` (or `list`): `{ items, total, stats, types, job }`; query `q`, `tags` (comma separated), `untagged`,
 *   `enabled` (`true`/`false`), `source`, `order`, `limit`, `offset`.
 * - `GET path=file&sticker=<id>[&thumb=1]`: the image (the preview when one exists and `thumb` is set).
 * - `GET path=chats[&chat=<key>]`: the per-chat automatic-sticker switches, and the effective settings of `chat`.
 * - `POST path=upload` (multipart, files under `file`): `{ results: [{ id, created } | { error, name }] }`.
 * - `POST path=` JSON `{ action, … }`:
 *   `update { id, desc?, tags?, weight?, enabled?, title? }`,
 *   `update-many { ids, weight?, enabled?, tags?, addTags?, removeTags? }`, `remove { ids }`,
 *   `classify { ids?, force? }`, `cancel-job`, `collect { chat, media }`, `set-chat { chat, enabled?, percent? | clear }`,
 *   `send { chat, id }`.
 *
 * @module dsh-im-stickers/panel
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ImChatKey } from '@deepseek-ai/dsh-im'
import type { ImStickersService } from './index.ts'
import type { StickerFilter } from './pick.ts'

/** The id of the sticker tab. */
export const STICKERS_TAB = 'stickers'

/** The part of a panel tab definition this package uses. */
export interface PanelTabDefinition {
  id: string
  title: string
  order?: number
  badge?: () => number | undefined
  fetch?: (request: Request, route: { path: string; query: URLSearchParams }) => Promise<Response>
}

/** The part of the panel's host service this package uses. */
export interface PanelHost {
  tab(definition: PanelTabDefinition): () => void
}

/** The service methods the tab uses. */
export type StickerTabService = Pick<ImStickersService,
  'list' | 'stats' | 'types' | 'job' | 'file' | 'upload' | 'update' | 'updateMany' | 'remove' | 'classify' | 'cancelJob'
  | 'collect' | 'overrides' | 'setChat' | 'autoOf' | 'send'>

/**
 * Register the sticker tab once the panel is mounted.
 * @param ctx - the plugin context.
 * @param service - the sticker service.
 */
export function applyPanel(ctx: Context, service: StickerTabService): void {
  ctx.inject(['imPanel' as never], (scoped) => {
    const panel = (scoped as unknown as { imPanel: PanelHost }).imPanel
    scoped.effect(() => panel.tab(stickersTab(service)))
  })
}

const ORDERS = new Set(['weight', 'uses', 'recent', 'newest', 'oldest'])

/**
 * The sticker tab definition.
 * @param service - the sticker service.
 * @returns the definition the panel registers.
 */
export function stickersTab(service: StickerTabService): PanelTabDefinition {
  return {
    id: STICKERS_TAB,
    title: '表情库',
    order: 60,
    badge: () => {
      const job = service.job()
      return job?.running ? job.total - job.done : undefined
    },
    fetch: async (request, { path, query }) => {
      try {
        if (request.method === 'GET' || request.method === 'HEAD') return await read(service, path, query)
        if (path === 'upload') {
          const form = await request.formData()
          const files = await Promise.all(form.getAll('file')
            .filter((entry): entry is File => typeof entry !== 'string')
            .map(async file => ({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) })))
          if (files.length === 0) return Response.json({ ok: false, text: '没有收到文件' })
          return Response.json({ results: await service.upload(files) })
        }
        return Response.json(await command(service, await request.json()))
      } catch (error) {
        return Response.json({ ok: false, text: error instanceof Error ? error.message : String(error) })
      }
    },
  }
}

async function read(service: StickerTabService, path: string, query: URLSearchParams): Promise<Response> {
  if (path === 'file') {
    const file = await service.file(Number(query.get('sticker')), query.has('thumb'))
    if (file === undefined) return new Response('not found', { status: 404 })
    return new Response(file.data, { headers: { 'content-type': file.mime, 'cache-control': 'private, max-age=3600' } })
  }
  if (path === 'chats') {
    const chat = query.get('chat')
    return Response.json({ overrides: service.overrides(), ...chat ? { auto: service.autoOf(chat) } : {} })
  }
  if (path !== '' && path !== 'list') return Response.json({ ok: false, text: `unknown path ${path}` }, { status: 404 })
  const base = filterOf(query)
  const limit = Math.max(1, Math.min(Number(query.get('limit') ?? 60) || 60, 500))
  const offset = Math.max(0, Number(query.get('offset') ?? 0) || 0)
  const all = service.list({ ...base, limit: 1000 })
  return Response.json({
    items: all.slice(offset, offset + limit),
    total: all.length,
    stats: service.stats(),
    types: service.types(),
    job: service.job() ?? null,
  })
}

function filterOf(query: URLSearchParams): StickerFilter {
  const tags = (query.get('tags') ?? '').split(',').map(tag => tag.trim()).filter(Boolean)
  const enabled = query.get('enabled')
  const source = query.get('source')
  const order = query.get('order')
  return {
    ...tags.length > 0 ? { tags } : {},
    ...query.get('untagged') === 'true' || query.get('untagged') === '1' ? { untagged: true } : {},
    ...query.get('q') ? { query: query.get('q')! } : {},
    ...enabled === 'true' || enabled === 'false' ? { enabled: enabled === 'true' } : {},
    ...source === 'upload' || source === 'chat' ? { source } : {},
    ...order && ORDERS.has(order) ? { order: order as NonNullable<StickerFilter['order']> } : {},
  }
}

interface Command {
  action?: string
  id?: number
  ids?: number[]
  desc?: string
  title?: string
  tags?: string[]
  addTags?: string[]
  removeTags?: string[]
  weight?: number
  enabled?: boolean
  force?: boolean
  chat?: string
  media?: string
  percent?: number
  clear?: boolean
}

async function command(service: StickerTabService, body: unknown): Promise<unknown> {
  const c = (body ?? {}) as Command
  const patch = {
    ...c.desc === undefined ? {} : { desc: c.desc },
    ...c.title === undefined ? {} : { title: c.title },
    ...c.tags === undefined ? {} : { tags: c.tags },
    ...c.weight === undefined ? {} : { weight: c.weight },
    ...c.enabled === undefined ? {} : { enabled: c.enabled },
  }
  switch (c.action) {
    case 'update': {
      const row = await service.update(Number(c.id), patch)
      if (row === undefined) throw new Error(`没有表情 #${c.id}`)
      return { ok: true, text: `已更新 #${row.id}`, sticker: row }
    }
    case 'update-many': {
      const changed = await service.updateMany(c.ids ?? [], {
        ...patch,
        ...c.addTags === undefined ? {} : { addTags: c.addTags },
        ...c.removeTags === undefined ? {} : { removeTags: c.removeTags },
      })
      return { ok: true, text: `已更新 ${changed} 个表情` }
    }
    case 'remove': {
      const removed = await service.remove(c.ids ?? [])
      return { ok: true, text: `已删除 ${removed} 个表情` }
    }
    case 'classify': {
      const job = service.classify(c.ids, { force: c.force === true })
      return { ok: true, text: `开始分类 ${job.total} 个表情`, job }
    }
    case 'cancel-job':
      return { ok: service.cancelJob(), text: '已请求停止' }
    case 'collect': {
      if (!c.chat || !c.media) throw new Error('chat and media are required')
      const { row, created } = await service.collect(c.chat as ImChatKey, c.media)
      return { ok: true, text: created ? `已收藏为 #${row.id}` : `已经在表情库里了（#${row.id}）`, sticker: row }
    }
    case 'set-chat': {
      if (!c.chat) throw new Error('chat is required')
      const stored = await service.setChat(c.chat, c.clear ? undefined : {
        ...c.enabled === undefined ? {} : { enabled: c.enabled },
        ...c.percent === undefined ? {} : { percent: c.percent },
      })
      return { ok: true, text: stored === undefined ? '已恢复为配置默认' : '已保存', auto: service.autoOf(c.chat) }
    }
    case 'send': {
      if (!c.chat) throw new Error('chat is required')
      const result = await service.send(c.chat as ImChatKey, Number(c.id))
      return { ok: result.status === 'confirmed', text: result.status === 'confirmed' ? '已发送' : `${result.status} ${result.error ?? ''}` }
    }
    default:
      throw new Error(`unknown action ${String(c.action)}`)
  }
}
