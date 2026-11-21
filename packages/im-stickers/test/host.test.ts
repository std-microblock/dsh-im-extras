import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { h } from '@deepseek-ai/cordis-plugin-im-core'
import type { ImChatKey, ImMessage, ImSendResult } from '@deepseek-ai/dsh-im'
import { applyTools, ImageTools, StickerHost, StickerLibrary, stickerPrompt, type RunResult } from '../src/index.ts'
import { config, memoryStorage, PNG, png, quiet, tempDir } from './helpers.ts'

const CHAT = 'lark:app|chat-1' as ImChatKey
const failing = async (): Promise<RunResult> => ({ code: -1, stdout: Buffer.alloc(0), stderr: '' })

function stored(seq: number, content: ReturnType<typeof h>, self: boolean, text = ''): ImMessage {
  return {
    key: `lark:app|m${seq}`, seq, chat: { key: CHAT, bot: 'lark:app', source: 'lark' },
    sender: { id: self ? 'bot' : 'u1', self }, content, text, mentions: { self: false, all: false, users: [] },
    addressed: false, time: Date.now(), via: self ? 'self' : 'platform',
  } as unknown as ImMessage
}

async function setup(patch: Parameters<typeof config>[0] = {}) {
  const { dir, cleanup } = await tempDir()
  const { storage } = memoryStorage()
  const cfg = config(patch)
  const library = new StickerLibrary({
    storage, dir, image: new ImageTools('magick', failing), logger: quiet, classifier: () => undefined,
  }, cfg)
  await library.open()
  const messages: ImMessage[] = []
  const sends: { chat: string; content: unknown; options: unknown }[] = []
  let now = 0
  const pending = new Map<number, { at: number; fn: () => void }>()
  let nextTimer = 1
  const fetched: string[] = []
  const im = {
    history: { after: (_chat: ImChatKey, seq: number, limit: number) => messages.filter(m => m.seq > seq).slice(0, limit) },
    chat: () => ({ key: CHAT, bot: 'lark:app', source: 'lark' }),
    send: async (chat: ImChatKey, content: unknown, options: unknown): Promise<ImSendResult> => {
      sends.push({ chat, content, options })
      return { status: 'confirmed' }
    },
  }
  let roll = 0
  const host = new StickerHost({
    im: im as never,
    library,
    fetch: () => async (src: string) => {
      fetched.push(src)
      return { data: src.startsWith('data:') ? Buffer.from(src.slice(src.indexOf(',') + 1), 'base64') : png(9) }
    },
    logger: quiet,
    resolveHost: async () => ['93.184.216.34'],
    timers: {
      set: (fn: () => void, ms: number) => { const id = nextTimer++; pending.set(id, { at: now + ms, fn }); return id },
      clear: (id: unknown) => { pending.delete(id as number) },
    },
    rnd: () => roll,
  }, cfg)
  const advance = async (ms: number) => {
    now += ms
    for (const [id, timer] of [...pending]) if (timer.at <= now) { pending.delete(id); timer.fn() }
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
  }
  return { library, host, messages, sends, fetched, advance, cleanup, setRoll: (value: number) => { roll = value } }
}

describe('collecting chat pictures', () => {
  it('stores the picture a media id names, with its origin, once', async () => {
    const t = await setup()
    try {
      const src = `data:image/png;base64,${PNG.toString('base64')}`
      t.messages.push(stored(12, h('message', '看这个', h('file', { src: 'https://x/a.pdf', name: 'a.pdf' }), h('img', { src, alt: '猫' })), false))
      const { row, created } = await t.host.collect(CHAT, '#12.2')
      assert.equal(created, true)
      assert.equal(row.source, 'chat')
      assert.deepEqual(row.origin, { chat: CHAT, message: 'lark:app|m12', seq: 12, index: 2 })
      assert.equal(row.title, '猫')
      assert.equal((await t.host.collect(CHAT, '12.2')).created, false)
      await assert.rejects(t.host.collect(CHAT, '12.1'), /is a file, not an image/)
      await assert.rejects(t.host.collect(CHAT, '13.1'), /no stored message #13/)
      await assert.rejects(t.host.collect(CHAT, 'abc'), /not a media id/)
    } finally { await t.cleanup() }
  })

  it('refuses a picture whose source points into this host', async () => {
    const t = await setup()
    try {
      t.messages.push(stored(3, h('message', h('img', { src: 'file:///etc/hosts' })), false))
      await assert.rejects(t.host.collect(CHAT, '3'), /refused file:/)
      assert.equal(t.fetched.length, 0)
    } finally { await t.cleanup() }
  })
})

describe('sending and the automatic sticker', () => {
  it('sends a sticker as an image naming it, and counts the use', async () => {
    const t = await setup()
    try {
      const { row } = await t.library.add({ data: PNG, source: 'upload' })
      await t.library.update(row.id, { desc: '挥手的小人', tags: ['general'] })
      await t.host.send(CHAT, t.library.get(row.id)!, { session: 's1', operationId: 'op' })
      const content = t.sends[0]!.content as { type: string; attrs: { src: string; alt: string } }
      assert.equal(content.type, 'img')
      assert.match(content.attrs.src, /^file:/)
      assert.equal(content.attrs.alt, '表情 #1 挥手的小人')
      assert.deepEqual(t.sends[0]!.options, { session: 's1', operationId: 'op' })
      assert.equal(t.library.get(row.id)?.uses, 1)
      assert.equal(t.host.lastSentIn(CHAT), row.id)
    } finally { await t.cleanup() }
  })

  it('appends a sticker after the bot\'s burst goes quiet, when the die says so', async () => {
    const t = await setup()
    try {
      const { row } = await t.library.add({ data: PNG, source: 'upload' })
      await t.library.update(row.id, { tags: ['general'] })
      t.host.stored(stored(1, h('message', '先这样'), true, '先这样'))
      await t.advance(3000)
      t.host.stored(stored(2, h('message', '有问题再说'), true, '有问题再说'))
      await t.advance(6999)
      assert.equal(t.sends.length, 0, 'not quiet long enough yet')
      t.setRoll(0.1)
      await t.advance(1)
      assert.equal(t.sends.length, 1)
      assert.deepEqual(t.sends[0]!.options, {}, 'the automatic sticker carries no session')
      // The sticker's own stored message opens no new burst.
      t.host.stored(stored(3, h('message', h('img', { src: 'file:///x.png', alt: '表情 #1' })), true, '[图片 #3.1 表情 #1]'))
      await t.advance(10_000)
      assert.equal(t.sends.length, 1)
    } finally { await t.cleanup() }
  })

  it('skips the roll after a burst that already carried a sticker, ignores other people, and follows switches', async () => {
    const t = await setup()
    try {
      const { row } = await t.library.add({ data: PNG, source: 'upload' })
      await t.library.update(row.id, { tags: ['general'] })
      t.setRoll(0)
      t.host.stored(stored(1, h('message', '哈哈'), true, '哈哈'))
      t.host.stored(stored(2, h('message', h('img', { src: 'file:///x.png', alt: '表情 #1' })), true))
      await t.advance(8000)
      assert.equal(t.sends.length, 0, 'the agent already sent one')
      t.host.stored(stored(3, h('message', '别人说的话'), false, '别人说的话'))
      await t.advance(8000)
      assert.equal(t.sends.length, 0, 'only the bot\'s own messages count')
      await t.library.setChat(CHAT, { enabled: false })
      t.host.stored(stored(4, h('message', '又说一句'), true, '又说一句'))
      await t.advance(8000)
      assert.equal(t.sends.length, 0, 'switched off for this chat')
      await t.library.setChat(CHAT, undefined)
      t.host.stored(stored(5, h('message', '再说一句'), true, '再说一句'))
      await t.advance(8000)
      assert.equal(t.sends.length, 1)
    } finally { await t.cleanup() }
  })

  it('sends nothing when no sticker of the type exists', async () => {
    const t = await setup()
    try {
      t.setRoll(0)
      t.host.stored(stored(1, h('message', '好'), true, '好'))
      await t.advance(8000)
      assert.equal(t.sends.length, 0)
    } finally { await t.cleanup() }
  })
})

describe('tools', () => {
  async function tools() {
    const t = await setup()
    const registered = new Map<string, { execute: (args: unknown, exec: unknown) => Promise<unknown> }>()
    const record = { sessionId: 's1', owner: 'conversation', bindings: [{ chat: CHAT, writable: true, home: true }] }
    const im = {
      sessions: { of: (id: string) => (id === 's1' ? record : undefined), get: () => undefined, trigger: () => undefined },
    }
    const ctx = { tools: { register: (tool: { name: string; execute: never }) => { registered.set(tool.name, tool) } } }
    applyTools(ctx as never, im as never, t.library, t.host, ['send_sticker', 'sticker_search', 'sticker_collect'])
    const exec = { callId: 'call-1', signal: new AbortController().signal, agent: { session: { id: 's1' } } }
    return { ...t, registered, exec }
  }

  it('search lists enabled stickers; send picks by tag; collect saves a chat picture', async () => {
    const t = await tools()
    try {
      const a = (await t.library.add({ data: png(1), source: 'upload' })).row
      await t.library.update(a.id, { tags: ['speechless'], desc: '翻白眼的狗' })
      const b = (await t.library.add({ data: png(2), source: 'upload' })).row
      await t.library.update(b.id, { enabled: false })
      const search = await t.registered.get('sticker_search')!.execute({}, t.exec) as { stickers: { id: number }[]; total: number }
      assert.deepEqual(search.stickers.map(s => s.id), [a.id])
      assert.equal(search.total, 1)
      const sent = await t.registered.get('send_sticker')!.execute({ tags: ['speechless'] }, t.exec) as { status: string; sticker: string }
      assert.equal(sent.status, 'confirmed')
      assert.equal(sent.sticker, `#${a.id} 翻白眼的狗`)
      assert.equal(t.sends[0]!.chat, CHAT)
      const refused = await t.registered.get('send_sticker')!.execute({ id: b.id }, t.exec) as { status: string }
      assert.equal(refused.status, 'error')
      const foreign = await t.registered.get('send_sticker')!.execute({ chat: 'lark:app|other' }, t.exec) as { status: string; code: string }
      assert.equal(foreign.code, 'access')
      const outsider = await t.registered.get('sticker_search')!.execute({}, { ...t.exec, agent: { session: { id: 'nobody' } } }) as { code: string }
      assert.equal(outsider.code, 'ownership')

      t.messages.push(stored(5, h('message', h('img', { src: 'https://cdn.example/x.png' })), false))
      const collected = await t.registered.get('sticker_collect')!.execute({ id: '5.1', desc: '一只鸭子', tags: ['general'] }, t.exec) as { created: boolean; sticker: { desc: string; tags: string[] } }
      assert.equal(collected.created, true)
      assert.equal(collected.sticker.desc, '一只鸭子')
      assert.deepEqual(collected.sticker.tags, ['general'])
      const missing = await t.registered.get('sticker_collect')!.execute({ id: '9.1' }, t.exec) as { status: string; code: string }
      assert.equal(missing.code, 'unavailable')
    } finally { await t.cleanup() }
  })

  it('writes a prompt section only for a non-empty library with send_sticker', () => {
    const types = [{ id: 'general', name: '通用', desc: '随时可发' }]
    assert.equal(stickerPrompt(types, 0, ['send_sticker']), '')
    assert.equal(stickerPrompt(types, 3, ['sticker_search']), '')
    const text = stickerPrompt(types, 3, ['send_sticker', 'sticker_search', 'sticker_collect'])
    assert.match(text, /3 张/)
    assert.match(text, /通用（general）/)
    assert.match(text, /sticker_collect/)
    assert.doesNotMatch(text, /自动/)
  })
})
