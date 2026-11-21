import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ImageTools, StickerLibrary, stickersTab, type RunResult, type StickerTabService } from '../src/index.ts'
import { config, memoryStorage, PNG, png, quiet, tempDir } from './helpers.ts'

const failing = async (): Promise<RunResult> => ({ code: -1, stdout: Buffer.alloc(0), stderr: '' })
const BASE = 'http://panel.test/api/im-panel/tab?id=stickers'

async function setup() {
  const { dir, cleanup } = await tempDir()
  const { storage } = memoryStorage()
  const library = new StickerLibrary({ storage, dir, image: new ImageTools('magick', failing), logger: quiet, classifier: () => undefined }, config())
  await library.open()
  const sent: unknown[] = []
  const service = {
    list: (filter: never) => library.list(filter),
    stats: () => library.stats(),
    types: () => library.types(),
    job: () => library.jobState(),
    file: (id: number, thumb?: boolean) => library.read(id, thumb),
    upload: async (files: { name?: string; data: Uint8Array }[]) => Promise.all(files.map(async (file) => {
      try {
        const { row, created } = await library.add({ data: file.data, source: 'upload', ...file.name === undefined ? {} : { name: file.name } })
        return { id: row.id, created }
      } catch (error) { return { error: (error as Error).message } }
    })),
    update: (id: number, patch: never) => library.update(id, patch),
    updateMany: (ids: number[], patch: never) => library.updateMany(ids, patch),
    remove: (ids: number[]) => library.remove(ids),
    classify: (ids?: number[], options?: { force?: boolean }) => library.beginClassify(ids, options),
    cancelJob: () => library.cancelJob(),
    collect: async () => { throw new Error('no chat') },
    overrides: () => library.overrides(),
    setChat: (chat: string, value: never) => library.setChat(chat, value),
    autoOf: () => ({ enabled: true, percent: 8, gapMs: 7000, tag: 'general' }),
    send: async (chat: string, id: number) => { sent.push([chat, id]); return { status: 'confirmed' } },
  } as unknown as StickerTabService
  const tab = stickersTab(service)
  const call = (method: string, path: string, query = '', body?: BodyInit, headers?: HeadersInit) => {
    const url = new URL(`${BASE}&path=${path}${query ? `&${query}` : ''}`)
    const request = new Request(url, { method, ...body === undefined ? {} : { body }, ...headers === undefined ? {} : { headers } })
    const params = new URLSearchParams(url.search)
    params.delete('id')
    params.delete('path')
    return tab.fetch!(request, { path, query: params })
  }
  return { library, tab, call, sent, cleanup }
}

describe('sticker panel tab', () => {
  it('uploads multipart files, lists them and serves the image', async () => {
    const t = await setup()
    try {
      const form = new FormData()
      form.append('file', new File([PNG], 'a.png', { type: 'image/png' }))
      form.append('file', new File([Buffer.from('nope')], 'b.txt'))
      const uploaded = await (await t.call('POST', 'upload', '', form)).json() as { results: unknown[] }
      assert.equal(uploaded.results.length, 2)
      assert.deepEqual(uploaded.results[0], { id: 1, created: true })
      assert.match(JSON.stringify(uploaded.results[1]), /not a PNG/)

      const list = await (await t.call('GET', '', 'limit=10')).json() as { items: { id: number }[]; total: number; types: unknown[]; stats: { total: number } }
      assert.deepEqual(list.items.map(i => i.id), [1])
      assert.equal(list.total, 1)
      assert.equal(list.stats.total, 1)
      assert.ok(list.types.length > 0)

      const image = await t.call('GET', 'file', 'sticker=1&thumb=1')
      assert.equal(image.headers.get('content-type'), 'image/png')
      assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG)
      assert.equal((await t.call('GET', 'file', 'sticker=99')).status, 404)
    } finally { await t.cleanup() }
  })

  it('filters, edits in batch, removes, and reports errors as toasts', async () => {
    const t = await setup()
    try {
      const a = (await t.library.add({ data: png(1), source: 'upload' })).row
      const b = (await t.library.add({ data: png(2), source: 'upload' })).row
      const json = (body: unknown) => t.call('POST', '', '', JSON.stringify(body), { 'content-type': 'application/json' }).then(r => r.json())
      assert.equal((await json({ action: 'update', id: a.id, tags: ['general'], weight: 80 }) as { ok: boolean }).ok, true)
      const tagged = await (await t.call('GET', '', 'tags=general')).json() as { items: { id: number }[] }
      assert.deepEqual(tagged.items.map(i => i.id), [a.id])
      const untagged = await (await t.call('GET', '', 'untagged=1')).json() as { items: { id: number }[] }
      assert.deepEqual(untagged.items.map(i => i.id), [b.id])
      assert.deepEqual(await json({ action: 'update-many', ids: [a.id, b.id], enabled: false }), { ok: true, text: '已更新 2 个表情' })
      const disabled = await (await t.call('GET', '', 'enabled=false')).json() as { total: number }
      assert.equal(disabled.total, 2)
      assert.deepEqual(await json({ action: 'send', chat: 'lark:a|c', id: a.id }), { ok: true, text: '已发送' })
      assert.deepEqual(t.sent, [['lark:a|c', a.id]])
      assert.deepEqual(await json({ action: 'remove', ids: [b.id] }), { ok: true, text: '已删除 1 个表情' })
      assert.deepEqual(await json({ action: 'collect', chat: 'c', media: '1.1' }), { ok: false, text: 'no chat' })
      assert.deepEqual(await json({ action: 'nope' }), { ok: false, text: 'unknown action nope' })
      const chats = await json({ action: 'set-chat', chat: 'lark:a|c', enabled: false }) as { ok: boolean }
      assert.equal(chats.ok, true)
      const overrides = await (await t.call('GET', 'chats', 'chat=lark:a|c')).json() as { overrides: unknown[]; auto: unknown }
      assert.equal(overrides.overrides.length, 1)
      assert.ok(overrides.auto)
    } finally { await t.cleanup() }
  })
})
