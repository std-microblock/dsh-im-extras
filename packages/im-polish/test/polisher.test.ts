import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { decide, type CompletionRequest, type PolishInput } from '../src/index.ts'
import { baseConfig } from './helpers.ts'

function input(patch: Partial<PolishInput> = {}): PolishInput {
  return {
    draft: '这个问题是显卡驱动太旧导致的，更新驱动就行',
    markdown: false,
    transcript: '#1 10:00 甲: 游戏一开就崩',
    botRecent: [],
    style: { main: 'short', subs: ['s1', 's2'], pickMin: 1, pickMax: 1 },
    note: '',
    route: { provider: 'p', model: 'm' },
    ...patch,
  }
}

/** A completion stub that answers from a list and records the requests. */
function scripted(...answers: (string | Error)[]) {
  const requests: CompletionRequest[] = []
  const complete = async (request: CompletionRequest): Promise<string> => {
    requests.push(request)
    const next = answers.shift()
    if (next === undefined) throw new Error('unexpected call')
    if (next instanceof Error) throw next
    return next
  }
  return { complete, requests }
}

const earlier = '扩展列表就在 profile 的 extensions.json 里，jq 一行就能导出'

describe('decide', () => {
  it('uses an accepted rewrite and shows the model the chat and the bot\'s recent messages', async () => {
    const { complete, requests } = scripted('显卡驱动太旧了 更新一下驱动就好')
    const outcome = await decide(input({ botRecent: ['刚才那个链接打不开吗'] }), baseConfig(), complete, () => 0)
    assert.equal(outcome.action, 'rewritten')
    assert.equal(outcome.text, '显卡驱动太旧了 更新一下驱动就好')
    assert.equal(outcome.subs.length, 1)
    assert.equal(requests.length, 1)
    const user = String(requests[0]!.user)
    assert.match(user, /<recent-chat>[\s\S]*游戏一开就崩/)
    assert.match(user, /<bot-recent>[\s\S]*刚才那个链接打不开吗/)
    assert.match(requests[0]!.system, /<no-send\/>/)
  })

  it('keeps the original when the rewrite fails the safety check', async () => {
    const { complete } = scripted('去官网看看吧')
    const outcome = await decide(input({ draft: '去 https://example.com/dl 下 2.0 版' }), baseConfig(), complete)
    assert.equal(outcome.action, 'kept')
    assert.equal(outcome.text, '去 https://example.com/dl 下 2.0 版')
    assert.match(outcome.reason ?? '', /^rejected lost-link/)
  })

  it('keeps the original when the model call fails', async () => {
    const { complete } = scripted(new Error('boom'))
    const outcome = await decide(input(), baseConfig(), complete)
    assert.equal(outcome.action, 'kept')
    assert.equal(outcome.reason, 'error boom')
  })

  it('retries a rewrite that sounds like a recent message, with feedback naming it', async () => {
    const { complete, requests } = scripted('扩展列表在 profile 的 extensions.json 里 jq 一行就能导出', '那个列表文件 jq 导一下就有')
    const outcome = await decide(input({ draft: '列表文件在 profile 里，用 jq 导出一下', botRecent: [earlier] }), baseConfig(), complete)
    assert.equal(requests.length, 2)
    assert.match(String(requests[1]!.user), /太像了/)
    assert.equal(outcome.action, 'rewritten')
    assert.equal(outcome.text, '那个列表文件 jq 导一下就有')
    assert.deepEqual(outcome.attempts.map(a => a.verdict), ['similar', 'accepted'])
  })

  it('falls back to the original when both rewrites are too close but the original is not', async () => {
    const close = '扩展列表在 profile 的 extensions.json 里 jq 一行就能导出'
    const { complete } = scripted(close, close)
    const outcome = await decide(input({ draft: '列表文件在 profile 里，用 jq 导出一下', botRecent: [earlier] }), baseConfig(), complete)
    assert.equal(outcome.action, 'kept')
    assert.equal(outcome.reason, 'rewrite-similar')
  })

  it('drops a draft that repeats a recent message after one retry', async () => {
    const close = '扩展列表在 profile 的 extensions.json 里 jq 一行就能导出'
    const { complete, requests } = scripted(close, close)
    const outcome = await decide(input({ draft: '扩展列表就在 profile 的 extensions.json 里（jq 一行就能导出）', botRecent: [earlier] }), baseConfig(), complete)
    assert.equal(requests.length, 2)
    assert.equal(outcome.action, 'dropped')
    assert.equal(outcome.reason, 'repeat')
    assert.match(outcome.dropMessage ?? '', /没有发出/)
    assert.ok((outcome.similar?.score ?? 0) >= 0.82)
  })

  it('lets a repeat through when dropping is off', async () => {
    const close = '扩展列表在 profile 的 extensions.json 里 jq 一行就能导出'
    const { complete } = scripted(close)
    const config = baseConfig()
    config.repeat = { ...config.repeat, drop: false, retry: false }
    const outcome = await decide(input({ draft: earlier, botRecent: [earlier] }), config, complete)
    assert.notEqual(outcome.action, 'dropped')
    assert.equal(outcome.reason, 'repeat-allowed')
  })

  it('honours the skip marker only for a draft close to a recent message', async () => {
    const honoured = await decide(
      input({ draft: '扩展列表就在 profile 的 extensions.json 里', botRecent: [earlier] }), baseConfig(), scripted('<no-send/>').complete)
    assert.equal(honoured.action, 'dropped')
    assert.equal(honoured.reason, 'model-skip')

    const ignored = await decide(input({ botRecent: [earlier] }), baseConfig(), scripted('<no-send/>').complete)
    assert.equal(ignored.action, 'kept')
    assert.equal(ignored.reason, 'skip-ignored')

    const config = baseConfig()
    config.repeat = { ...config.repeat, modelDrop: false }
    const off = await decide(
      input({ draft: '扩展列表就在 profile 的 extensions.json 里', botRecent: [earlier] }), config, scripted('<no-send/>').complete)
    assert.notEqual(off.reason, 'model-skip')
  })

  it('still checks repeats when no model route is available', async () => {
    const { complete, requests } = scripted()
    const kept = await decide(input({ route: undefined }), baseConfig(), complete)
    assert.equal(kept.action, 'kept')
    assert.equal(kept.reason, 'no-route')
    const dropped = await decide(input({ route: undefined, draft: earlier, botRecent: [earlier] }), baseConfig(), complete)
    assert.equal(dropped.action, 'dropped')
    assert.equal(requests.length, 0)
  })
})
