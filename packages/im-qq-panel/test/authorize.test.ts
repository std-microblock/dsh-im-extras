import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { Fragment } from '@deepseek-ai/cordis-plugin-im-core'
import {
  ASSETS, assetUrls, buildTransferUrl, normalizeGroupCode, runAuthorize, validateIdentity, type AuthorizeDeps,
} from '../src/authorize.ts'
import { Config } from '../src/config.ts'
import { elements, fakeLogger, textOf } from './helpers.ts'

// Fake identity for tests: the plugin carries no real bot QQ number or UID.
const FAKE_BOT_UIN = '1234567890'
const FAKE_BOT_UID = 'u_FAKEUID0123456789ab'
const IMAGES = { authorize: 'file:///a.png', manual: 'file:///m.png', groupCode: 'file:///g.png' }

function setup(overrides: Record<string, unknown> = {}, images: AuthorizeDeps['images'] = IMAGES) {
  const options = Config.parse({ authorize: { botUin: FAKE_BOT_UIN, botUid: FAKE_BOT_UID, ...overrides } }).authorize
  const logger = fakeLogger()
  return { deps: { options, images, logger } satisfies AuthorizeDeps, logger }
}

function io(platform = 'qq', results: boolean[] = []) {
  const sent: Fragment[] = []
  return {
    platform,
    sent,
    async send(content: Fragment) {
      sent.push(content)
      return results.length ? results.shift()! : true
    },
  }
}

function decodeUrl(url: string): unknown {
  return JSON.parse(new URL(url).searchParams.get('open_kuikly_info')!)
}

test('授权页地址：JSON 单行压缩后整体编码，数字字段为 number', () => {
  const url = buildTransferUrl({ groupCode: '100200300', botUin: FAKE_BOT_UIN, botUid: FAKE_BOT_UID })
  assert.ok(url.startsWith('https://club.vip.qq.com/transfer?open_kuikly_info=%7B%22page_name%22%3A%22ai_group_service_agreement_pop_page%22'))
  assert.deepEqual(decodeUrl(url), {
    page_name: 'ai_group_service_agreement_pop_page',
    groupCode: 100200300,
    botUin: Number(FAKE_BOT_UIN),
    botUid: FAKE_BOT_UID,
    screen: 1,
  })
  assert.ok(!url.includes(' '))
})

test('群号解析：去空白、全角转半角，拒绝非数字与越界长度', () => {
  assert.deepEqual(normalizeGroupCode(' 1234 5678 '), { ok: true, groupCode: '12345678' })
  assert.deepEqual(normalizeGroupCode('１２３４５６７８９'), { ok: true, groupCode: '123456789' })
  assert.deepEqual(normalizeGroupCode(undefined), { ok: false, reason: 'missing' })
  assert.deepEqual(normalizeGroupCode('   '), { ok: false, reason: 'missing' })
  for (const bad of ['群号123', '1234', '0123456', '1234567890123']) {
    const parsed = normalizeGroupCode(bad)
    assert.equal(parsed.ok === false && parsed.reason, 'invalid')
  }
})

test('插件不内置机器人身份：默认值为空，指令名「授权全消息」，别名 qqauth', () => {
  const defaults = Config.parse({}).authorize
  assert.equal(defaults.botUin, '')
  assert.equal(defaults.botUid, '')
  assert.equal(defaults.command, '授权全消息')
  assert.deepEqual(defaults.aliases, ['qqauth'])
  assert.equal(validateIdentity(defaults).ok, false)
})

test('QQ 平台带群号：先发示意图与教程图，再发带授权 link 按钮的卡片', async () => {
  const { deps } = setup()
  const target = io('qq')
  assert.equal(await runAuthorize(target, '123456789', deps), undefined)
  assert.equal(target.sent.length, 2)
  assert.deepEqual(elements(target.sent[0], 'img').map(node => node.attrs.src), [IMAGES.authorize, IMAGES.manual])

  const card = target.sent[1]
  const [link, retry] = elements(card, 'button')
  assert.equal(link!.attrs.type, 'link')
  assert.deepEqual(decodeUrl(String(link!.attrs.href)), {
    page_name: 'ai_group_service_agreement_pop_page',
    groupCode: 123456789,
    botUin: Number(FAKE_BOT_UIN),
    botUid: FAKE_BOT_UID,
    screen: 1,
  })
  assert.equal(retry!.attrs.type, 'input')
  assert.equal(retry!.attrs.text, '/授权全消息 ')
  // No link in the text: an official bot's bare link is refused.
  assert.ok(!textOf(card).includes('https://'))
  assert.match(textOf(card), /群 123456789/)
})

test('QQ 平台缺群号：发群号教程图与「填写群号」按钮；格式错误时提示原输入', async () => {
  const { deps } = setup()
  const target = io('qq')
  await runAuthorize(target, '', deps)
  assert.equal(target.sent.length, 2)
  assert.deepEqual(elements(target.sent[0], 'img').map(node => node.attrs.src), [IMAGES.groupCode])
  const [fill] = elements(target.sent[1], 'button')
  assert.equal(fill!.attrs.type, 'input')
  assert.equal(fill!.attrs.text, '/授权全消息 ')
  assert.match(textOf(target.sent[1]), /授权全消息 123456789/)

  const invalid = io('qq')
  await runAuthorize(invalid, 'abc', deps)
  assert.match(textOf(invalid.sent[1]), /「abc」不是有效的群号/)
})

test('按钮消息发送失败（或抛错）时改发纯文本兜底（不含链接）', async () => {
  const { deps, logger } = setup()
  const target = io('qq', [true, false, true])
  await runAuthorize(target, '123456789', deps)
  assert.equal(target.sent.length, 3)
  assert.equal(typeof target.sent[2], 'string')
  assert.match(String(target.sent[2]), /手动设置/)
  assert.ok(!String(target.sent[2]).includes('https://'))
  assert.ok(logger.lines.some(([level]) => level === 'warn'))

  const throwing = {
    platform: 'qq',
    sent: [] as Fragment[],
    async send(content: Fragment) {
      this.sent.push(content)
      if (typeof content !== 'string' && elements(content, 'button').length) throw new Error('keyboard refused')
      return true
    },
  }
  await runAuthorize(throwing, '123456789', deps)
  assert.equal(typeof throwing.sent.at(-1), 'string')
})

test('非 QQ 平台：纯文本附授权页地址', async () => {
  const { deps } = setup()
  const target = io('lark')
  await runAuthorize(target, '123456789', deps)
  assert.equal(target.sent.length, 2)
  assert.match(String(target.sent[1]), /授权页：https:\/\/club\.vip\.qq\.com\/transfer\?open_kuikly_info=/)
})

test('sendImages=false 时不发图片；图片缺失时跳过', async () => {
  const noImages = setup({ sendImages: false })
  const target = io('qq')
  await runAuthorize(target, '123456789', noImages.deps)
  assert.equal(target.sent.length, 1)
  assert.equal(elements(target.sent[0], 'button').length, 2)

  const missing = setup({}, { manual: 'file:///m.png' })
  const target2 = io('qq')
  await runAuthorize(target2, '123456789', missing.deps)
  assert.equal(elements(target2.sent[0], 'img').length, 1)
})

test('自定义指令名与输入前缀会同步到按钮预填内容', async () => {
  const { deps } = setup({ command: '授权', inputPrefix: '!' })
  const target = io('qq')
  await runAuthorize(target, '123456789', deps)
  assert.equal(elements(target.sent[1], 'button')[1]!.attrs.text, '!授权 ')
})

test('身份配置无效或缺失时拒绝生成', async () => {
  const bad = setup({ botUin: 'abc' })
  const target = io('qq')
  assert.match(String(await runAuthorize(target, '123456789', bad.deps)), /botUin 配置无效/)
  assert.equal(target.sent.length, 0)
  const missing = setup({ botUin: '', botUid: '' })
  assert.match(String(await runAuthorize(io('qq'), '123456789', missing.deps)), /botUin 未配置/)
  const noUid = setup({ botUid: '' })
  assert.match(String(await runAuthorize(io('qq'), '123456789', noUid.deps)), /botUid 未配置/)
})

test('随包的三张教程图都存在且是 PNG', () => {
  const urls = assetUrls()
  for (const key of Object.keys(ASSETS) as (keyof typeof ASSETS)[]) {
    assert.ok(urls[key], `缺少 ${key}`)
    const bytes = readFileSync(fileURLToPath(urls[key]!))
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  }
})
