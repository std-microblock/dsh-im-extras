import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { h } from '@deepseek-ai/cordis-plugin-im-core'
import type { ImChatKey, ImMessage, ImOutgoing } from '@deepseek-ai/dsh-im'
import { PolishHost, type CompletionRequest, type PolishConfig, type PolishRecord } from '../src/index.ts'
import { baseConfig } from './helpers.ts'

const CHAT = 'qq:bot|group-1' as ImChatKey

function message(seq: number, text: string, self: boolean, time = Date.now()): ImMessage {
  return {
    key: `qq:bot|m${seq}`, seq, chat: { key: CHAT, bot: 'qq:bot', source: 'qq-groups' }, sender: { id: self ? 'bot' : 'u1', name: self ? 'bot' : '甲', self },
    content: h('message', text), text, mentions: { self: false, all: false, users: [] }, addressed: false, time, via: self ? 'self' : 'platform',
  } as unknown as ImMessage
}

function harness(config: PolishConfig, answers: string[], stored: ImMessage[] = []) {
  const tables = new Map<string, Map<string, unknown>>()
  const domain = {
    table: (name: string) => {
      const store = tables.get(name) ?? new Map<string, unknown>()
      tables.set(name, store)
      return {
        get: (key: string) => store.get(key),
        keys: () => new Map(store).keys(),
        entries: () => new Map(store).entries(),
        put: async (key: string, value: unknown) => { store.set(key, value) },
        delete: async (key: string) => store.delete(key),
      }
    },
    close: async () => {},
  }
  const requests: CompletionRequest[] = []
  const records: PolishRecord[] = []
  const im = {
    history: {
      latest: () => stored.at(-1),
      before: (_chat: ImChatKey, seq: number, limit: number, keep?: (m: ImMessage) => boolean) =>
        stored.filter(m => m.seq < seq && (keep === undefined || keep(m))).slice(-limit),
    },
    format: async (messages: readonly ImMessage[]) => [{ type: 'text', text: messages.map(m => `#${m.seq} ${m.sender.name}: ${m.text}`).join('\n') }],
    sessions: { of: () => ({ owner: 'conversation', composition: { provider: 'sp', model: 'sm', agentPreset: 'chat' } }) },
    chat: () => ({ key: CHAT, bot: 'qq:bot', source: 'qq-groups' }),
  }
  const host = new PolishHost({
    im: im as never,
    storage: { open: async () => domain } as never,
    complete: () => async (request) => {
      requests.push(request)
      const answer = answers.shift()
      if (answer === undefined) throw new Error('no answer')
      return answer
    },
    logger: { info() {}, warn() {}, debug() {} },
    onRecord: record => { records.push(record) },
    rnd: () => 0,
  }, config)
  return { host, requests, records, tables }
}

function outgoing(content: ImOutgoing['content'], session?: string): ImOutgoing {
  return { chat: CHAT, options: session === undefined ? {} : { session: session as never }, original: content, content }
}

describe('PolishHost', () => {
  it('rewrites a text send in place and records it, using the session route', async () => {
    const { host, requests, records } = harness(baseConfig(), ['驱动太旧了 更新一下就好'], [message(1, '游戏一开就崩', false)])
    await host.open()
    const draft = outgoing(h.markdown('这是显卡驱动太旧导致的，更新驱动就好'), 's1')
    await host.beforeSend(draft)
    assert.equal((draft.content as { attrs: { content: string } }).attrs.content, '驱动太旧了 更新一下就好')
    assert.equal(draft.drop, undefined)
    assert.equal(requests[0]?.provider, 'sp')
    assert.match(String(requests[0]?.user), /游戏一开就崩/)
    assert.equal(records.length, 1)
    assert.equal(records[0]?.action, 'rewritten')
    assert.equal(records[0]?.model, 'sp/sm')
    assert.equal(host.records().length, 1)
    assert.equal(host.stats().rewritten, 1)
  })

  it('drops a repeat of the bot\'s recent message and tells the agent why', async () => {
    const earlier = '扩展列表就在 profile 的 extensions.json 里，jq 一行就能导出'
    const close = '扩展列表在 profile 的 extensions.json 里 jq 一行就能导出'
    const { host, records } = harness(baseConfig(), [close, close], [message(1, '怎么导出扩展', false), message(2, earlier, true)])
    await host.open()
    const draft = outgoing('扩展列表就在 profile 的 extensions.json 里（jq 一行就能导出）', 's1')
    await host.beforeSend(draft)
    assert.match(draft.drop ?? '', /没有发出/)
    assert.equal(records[0]?.action, 'dropped')
    assert.equal(host.records({ action: 'dropped' }).length, 1)
  })

  it('compares the second of two quick sends with the first before the store has it', async () => {
    const text = '扩展列表就在 profile 的 extensions.json 里，jq 一行就能导出'
    const config = baseConfig()
    config.model = { ...config.model, provider: 'p', model: 'm' }
    const { host } = harness(config, [text, text, text], [])
    await host.open()
    const first = outgoing(text)
    const second = outgoing(text)
    await Promise.all([host.beforeSend(first), host.beforeSend(second)])
    assert.equal(first.drop, undefined)
    assert.match(second.drop ?? '', /没有发出/)
  })

  it('leaves images, cards and code untouched', async () => {
    const { host, requests } = harness(baseConfig(), [])
    await host.open()
    const image = outgoing(h('message', '看图', h('img', { src: 'https://x/y.png' })), 's1')
    await host.beforeSend(image)
    const code = outgoing('```\nnpm i\n```', 's1')
    await host.beforeSend(code)
    assert.equal(requests.length, 0)
    assert.equal(image.drop, undefined)
  })

  it('follows rules and the panel switch per chat', async () => {
    const config = baseConfig({ rules: [{ sources: ['qq-groups'], enabled: false }] })
    const { host, requests } = harness(config, ['改过了'])
    await host.open()
    const draft = outgoing('原来的话', 's1')
    await host.beforeSend(draft)
    assert.equal(requests.length, 0)
    assert.equal(host.resolve(host.subjectOf(CHAT, undefined)).enabled, false)
    await host.setChat(CHAT, true)
    await host.beforeSend(draft)
    assert.equal(requests.length, 1)
    assert.equal(host.overrides().length, 1)
    await host.setChat(CHAT, undefined)
    assert.equal(host.overrides().length, 0)
  })

  it('bounds the log to maxRecords', async () => {
    const config = baseConfig({ maxRecords: 2 })
    const { host, tables } = harness(config, ['一', '二', '三'])
    await host.open()
    for (const text of ['第一句话', '第二句话', '第三句话']) await host.beforeSend(outgoing(text, 's1'))
    assert.equal(tables.get('records')?.size, 2)
    assert.deepEqual(host.records().map(r => r.original), ['第三句话', '第二句话'])
    assert.equal(await host.clear(), 2)
  })
})

describe('the text bubble ceiling', () => {
  const capped = (maxTextChars: number, patch: Partial<PolishConfig> = {}) =>
    baseConfig({ limits: { maxInputChars: 400, maxLines: 6, minChars: 1, maxTextChars }, ...patch })
  const long = '这条消息特别长，长到已经超过上限了，群友看着就是一大坨字，根本不想读完，所以它不该当一个纯文本气泡发出去'

  it('refuses a plain text bubble over the ceiling and names the two ways out', async () => {
    const { host, requests, records } = harness(capped(20), [])
    await host.open()
    const draft = outgoing(long, 's1')
    await host.beforeSend(draft)
    assert.match(draft.drop ?? '', /没有发出/)
    assert.match(draft.drop ?? '', /超过 20 字/)
    assert.match(draft.drop ?? '', /markdown/)
    assert.match(draft.drop ?? '', /typ2img/)
    assert.equal(requests.length, 0, 'a refused message is never polished')
    assert.equal(records[0]?.action, 'dropped')
    assert.equal(records[0]?.reason, 'too-long')
  })

  it('runs whatever the polish switch says, including off', async () => {
    const { host } = harness(capped(20, { rules: [{ sources: ['qq-groups'], enabled: false }] }), [])
    await host.open()
    const draft = outgoing(long, 's1')
    await host.beforeSend(draft)
    assert.match(draft.drop ?? '', /没有发出/)
    assert.equal(host.resolve(host.subjectOf(CHAT, undefined)).enabled, false)
  })

  it('does not measure a message that really is markdown', async () => {
    const { host } = harness(capped(20), [])
    await host.open()
    const list = ['- 第一条：装好依赖', '- 第二条：跑构建', '- 第三条：把产物推上去', '- 第四条：等 CI 绿了再合'].join('\n')
    const draft = outgoing(h.markdown(list), 's1')
    await host.beforeSend(draft)
    assert.equal(draft.drop, undefined)
    // …and a markdown document is not polished either: it is content, not chat.
    assert.match((draft.content as { attrs: { content: string } }).attrs.content, /第一条/)
  })

  it('leaves an image and a short bubble alone', async () => {
    const { host, requests } = harness(capped(20), ['好 我看看'])
    await host.open()
    const image = outgoing(h('message', long, h('img', { src: 'https://x/y.png' })), 's1')
    await host.beforeSend(image)
    assert.equal(image.drop, undefined, 'a picture is never measured')
    const short = outgoing('好 我看看', 's1')
    await host.beforeSend(short)
    assert.equal(requests.length, 1)
    assert.equal(short.drop, undefined)
  })

  it('keeps the draft when a rewrite outgrows the ceiling', async () => {
    const draftText = '驱动太旧 更新就好'
    const { host, records } = harness(capped(20), [
      '这个问题是显卡驱动太旧导致的，把驱动更新到最新版本就可以了，更新完再开一次游戏试试看',
    ])
    await host.open()
    const draft = outgoing(draftText, 's1')
    await host.beforeSend(draft)
    assert.equal(draft.drop, undefined)
    assert.equal((draft.content as { attrs?: { content?: string } }).attrs?.content ?? draft.content, draftText)
    assert.equal(records[0]?.action, 'kept')
    assert.equal(records[0]?.reason, 'rewrite-too-long')
  })

  it('answers the same question in the panel preview', async () => {
    const { host, requests } = harness(capped(20), ['好 我看看'])
    await host.open()
    const refused = await host.preview(CHAT, long, 's1')
    assert.equal(refused.action, 'dropped')
    assert.equal(refused.reason, 'too-long')
    assert.match(refused.dropMessage ?? '', /超过 20 字/)
    assert.equal(requests.length, 0, 'a refused preview never calls the model')
    const rewritten = await host.preview(CHAT, '好 我看一下', 's1')
    assert.equal(rewritten.action, 'rewritten')
    assert.equal(rewritten.text, '好 我看看')
  })
})
