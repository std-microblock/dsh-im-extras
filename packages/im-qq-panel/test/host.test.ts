import assert from 'node:assert/strict'
import test from 'node:test'
import { Config } from '../src/config.ts'
import {
  QqPanelHost, formatResult, groupOpenIdOf, managementCommand, parseInvocation, type HostDeps,
} from '../src/host.ts'
import { qqPanelTab } from '../src/panel.ts'
import { PlatformError, elements, fakeBot, fakeEvent, fakeLogger, fakeRequest, textOf } from './helpers.ts'

const ignored = async () => ({ kind: 'ignored' as const })

function setup(config: Record<string, unknown>, routes: Parameters<typeof fakeRequest>[0], extra: Partial<HostDeps> = {}) {
  const request = fakeRequest(routes)
  const bot = fakeBot(request)
  const logger = fakeLogger()
  const timers: (() => void)[] = []
  const host = new QqPanelHost(Config.parse({ admins: ['ADMIN_OPENID'], ...config }), {
    bots: () => [bot, { id: 'lark:x', platform: 'lark', status: 1 }],
    logger,
    images: { authorize: 'file:///a.png', manual: 'file:///m.png', groupCode: 'file:///g.png' },
    setTimeout: (callback) => { timers.push(callback); return () => {} },
    ...extra,
  })
  return { host, request, bot, logger, timers }
}

const EMPTY_PLATFORM = {
  'GET /v2/menu': { version: 3, menu: { items: [] } },
  'GET /v2/panels': { records: [], next_cursor: '', is_end: true },
}

test('parseInvocation：核心解析的 ASCII 命令、@ 后的中文命令、全角斜杠', () => {
  assert.deepEqual(parseInvocation({ text: '/qqpanel sync', command: { name: 'qqpanel', rawInput: ' sync' } }), { name: 'qqpanel', args: 'sync' })
  assert.deepEqual(parseInvocation({ text: '@机器人 /授权全消息 123456789' }), { name: '授权全消息', args: '123456789' })
  assert.deepEqual(parseInvocation({ text: '／qq面板' }), { name: 'qq面板', args: '' })
  assert.equal(parseInvocation({ text: '帮我 /qqsync' }), undefined)
  assert.deepEqual(managementCommand({ name: 'QQPanel', args: 'delete p1' }), { command: 'panel.delete', args: 'p1' })
  assert.deepEqual(managementCommand({ name: 'qq面板', args: '同步' }), { command: 'panel.sync', args: '' })
  assert.equal(managementCommand({ name: 'help', args: '' }), undefined)
  assert.equal(groupOpenIdOf('group:G1'), 'G1')
  assert.equal(groupOpenIdOf('user:U1'), undefined)
})

test('按命令来源生成面板：session 内置命令 + /skill 命令；内容一致时不发写请求', async () => {
  const { host, request } = setup({
    panels: [{ key: 'c2c', scope: 'c2c' }],
  }, {
    ...EMPTY_PLATFORM,
    'POST /v2/panels': ({ data }) => ({ panel_id: 'p_new', echoed: data }),
  }, {
    skills: async () => [{ name: 'ticket-intake', description: '产品侧需求建单规范', commands: ['产品需求'] }],
  })
  const result = await host.sync()
  assert.deepEqual(result.menu, { action: 'skipped', version: 3, reason: '配置未提供菜单项且 allowEmptyMenu=false，未改动平台菜单' })
  assert.deepEqual(result.panels, [{ action: 'created', key: 'c2c', panelId: 'p_new' }])
  const created = request.calls.find(call => call.method === 'POST')!.data as { panel: { items: { name: string }[]; remark: string } }
  assert.deepEqual(created.panel.items.map(item => item.name), ['/help', '/status', '/new', '/clear', '/stop', '/产品需求'])
  assert.equal(created.panel.remark, 'dsh:c2c')
  assert.ok(!request.calls.some(call => call.method === 'PUT'), 'empty menu is never sent')

  // Second run: the platform now has the same panel → no write at all.
  request.routes['GET /v2/panels'] = ({ query }: { query: URLSearchParams }) => ({
    records: query.get('scope') === 'c2c'
      ? [{ panel_id: 'p_new', scope: 'c2c', target_type: 'all', panel: { items: created.panel.items, remark: 'dsh:c2c' } }]
      : [],
    is_end: true,
  })
  const before = request.calls.length
  const again = await host.sync()
  assert.deepEqual(again.panels, [{ action: 'unchanged', key: 'c2c', panelId: 'p_new' }])
  assert.ok(request.calls.slice(before).every(call => call.method === 'GET'))
})

test('菜单：不一致时下发，一致时不发；allowEmptyMenu 才会清空', async () => {
  const items = [{ type: 'send_message', name: '帮助', sendMessage: '/help' }]
  const { host, request } = setup({ menu: { items } }, {
    ...EMPTY_PLATFORM,
    'PUT /v2/menu': { version: 4 },
  })
  const result = await host.sync({ resources: ['menu'] })
  assert.deepEqual(result.menu, { action: 'updated', version: 4, from: 0, to: 1 })
  request.routes['GET /v2/menu'] = { version: 4, menu: { items: [{ type: 'send_message', name: '帮助', send_message: '/help' }] } }
  assert.equal((await host.sync({ resources: ['menu'] })).menu?.action, 'unchanged')

  const empty = setup({ allowEmptyMenu: true }, {
    'GET /v2/menu': { version: 9, menu: { items: [{ type: 'link', name: '官网', link: 'https://a.com' }] } },
    'PUT /v2/menu': { version: 10 },
  })
  assert.equal((await empty.host.sync({ resources: ['menu'] })).menu?.action, 'updated')
  assert.deepEqual(empty.request.calls.at(-1)!.data, { menu: { items: [] } })
})

test('限频（err_code 40023001）后停止本次剩余面板写操作', async () => {
  const { host } = setup({
    panels: [
      { key: 'a', scope: 'c2c', source: 'manual', items: [{ name: '/a' }] },
      { key: 'b', scope: 'c2c', source: 'manual', items: [{ name: '/b' }] },
      { key: 'c', scope: 'group', source: 'manual', items: [{ name: '/c' }] },
    ],
  }, {
    ...EMPTY_PLATFORM,
    'POST /v2/panels': () => { throw new PlatformError('POST /v2/panels answered 400', { status: 400, body: { err_code: 40023001, message: '请求过于频繁' } }) },
  })
  const result = await host.sync({ resources: ['panels'] })
  assert.deepEqual(result.panels.map(item => item.action), ['failed', 'skipped', 'skipped'])
  assert.ok(result.warnings.some(warning => /限频/.test(warning)))
  assert.match(result.failures[0]!, /请求过于频繁（err_code 40023001）/)
})

test('scope / targetType 变化时删除重建；specific 面板用 target 增删 openid；prune 只删带前缀的面板', async () => {
  const records = [
    { panel_id: 'p1', scope: 'group', target_type: 'all', panel: { items: [{ type: 'command', name: '/a' }], remark: 'dsh:a' } },
    { panel_id: 'p2', scope: 'group', target_type: 'specific', panel: { items: [{ type: 'command', name: '/b', only_admin: false }], remark: 'dsh:b' } },
    { panel_id: 'p3', scope: 'group', target_type: 'all', panel: { items: [], remark: 'dsh:gone' } },
    { panel_id: 'p4', scope: 'group', target_type: 'all', panel: { items: [], remark: '平台手工配置' } },
  ]
  const { host, request } = setup({
    prune: true,
    panels: [
      { key: 'a', scope: 'group', targetType: 'specific', groupOpenIds: ['G1'], source: 'manual', items: [{ name: '/a' }] },
      { key: 'b', scope: 'group', targetType: 'specific', groupOpenIds: ['G1', 'G2'], source: 'manual', items: [{ name: '/b' }] },
    ],
  }, {
    'GET /v2/menu': { version: 1, menu: {} },
    'GET /v2/panels': ({ query }: { query: URLSearchParams }) => ({ records: query.get('scope') === 'group' ? records : [], is_end: true }),
    'GET /v2/panels/p2': { panel_id: 'p2', group_openids: ['G1', 'G9'] },
    'DELETE /v2/panels/p1': undefined,
    'DELETE /v2/panels/p3': undefined,
    'POST /v2/panels': { panel_id: 'p1b' },
    'PUT /v2/panels/p2/target': undefined,
  })
  const result = await host.sync({ resources: ['panels'] })
  assert.deepEqual(result.panels.map(item => item.action), ['recreated', 'unchanged', 'target-added', 'target-removed', 'deleted'])
  assert.deepEqual(request.calls.filter(call => call.method !== 'GET').map(call => `${call.method} ${call.path}`), [
    'DELETE /v2/panels/p1',
    'POST /v2/panels',
    'PUT /v2/panels/p2/target',
    'PUT /v2/panels/p2/target',
    'DELETE /v2/panels/p3',
  ])
  assert.deepEqual(request.calls.filter(call => call.path.endsWith('/target')).map(call => call.data), [
    { op: 'add', group_openids: ['G2'] },
    { op: 'del', group_openids: ['G9'] },
  ])
})

test('dryRun：只计算差异，不发写请求', async () => {
  const { host, request } = setup({ dryRun: true, menu: { items: [{ name: '帮助', sendMessage: '/help' }] }, panels: [{ key: 'a', scope: 'c2c', source: 'manual', items: [{ name: '/a' }] }] }, EMPTY_PLATFORM)
  const result = await host.sync()
  assert.equal(result.menu?.action, 'dry-run')
  assert.deepEqual(result.panels, [{ action: 'dry-run', type: 'create', key: 'a' }])
  assert.ok(request.calls.every(call => call.method === 'GET'))
  assert.match(formatResult(result), /演练模式/)
})

test('管理指令：非管理员被拒绝；管理员查看面板、查当前群 openid、删除面板', async () => {
  const { host, bot, request } = setup({
    panels: [{ key: 'g', scope: 'group', targetType: 'specific', groupOpenIds: ['GROUP_OPENID'], source: 'manual', items: [{ name: '/a' }] }],
  }, { ...EMPTY_PLATFORM, 'DELETE /v2/panels/p9': undefined })

  const stranger = fakeEvent('/qqsync', { command: { name: 'qqsync', rawInput: '' }, sender: { id: 'SOMEONE' } }, bot)
  assert.deepEqual(await host.handle(stranger, ignored), { kind: 'handled', by: 'qq-panel' })
  assert.match(String(stranger.replies[0]), /没有管理/)
  assert.equal(request.calls.length, 0)

  const group = fakeEvent('@机器人 /面板群号', {}, bot)
  await host.handle(group, ignored)
  assert.match(String(group.replies[0]), /当前群 OpenID：GROUP_OPENID/)
  assert.match(String(group.replies[0]), /g：指定生效（含本群）/)

  const list = fakeEvent('/qqpanel', { command: { name: 'qqpanel', rawInput: '' } }, bot)
  await host.handle(list, ignored)
  assert.match(String(list.replies[0]), /平台生效面板 0 个/)
  assert.match(String(list.replies[0]), /待处理动作 1 个：新建/)

  const del = fakeEvent('/qqpanel delete p9', { command: { name: 'qqpanel', rawInput: ' delete p9' } }, bot)
  await host.handle(del, ignored)
  assert.equal(String(del.replies[0]), '已删除面板 p9。')

  const other = fakeEvent('/help', { command: { name: 'help', rawInput: '' } }, bot)
  assert.deepEqual(await host.handle(other, ignored), { kind: 'ignored' })
  const unaddressed = fakeEvent('/qqsync', { addressed: false }, bot)
  assert.deepEqual(await host.handle(unaddressed, ignored), { kind: 'ignored' })
})

test('授权指令：任何人可用，经 event.reply 先发图片再发按钮；按钮失败时纯文本兜底', async () => {
  const { host, bot } = setup({ authorize: { botUin: '1234567890', botUid: 'u_FAKEUID0123456789ab' } }, EMPTY_PLATFORM)
  const event = fakeEvent('@机器人 /授权全消息 123456789', { sender: { id: 'ANY_MEMBER' } }, bot)
  assert.deepEqual(await host.handle(event, ignored), { kind: 'handled', by: 'qq-panel' })
  assert.equal(event.replies.length, 2)
  assert.equal(elements(event.replies[0], 'img').length, 2)
  assert.equal(elements(event.replies[1], 'button')[0]!.attrs.type, 'link')

  const failing = fakeEvent('/qqauth 123456789', { command: { name: 'qqauth', rawInput: ' 123456789' } }, bot,
    (content, index) => index === 1)
  await host.handle(failing, ignored)
  assert.equal(failing.replies.length, 3)
  assert.match(textOf(failing.replies[2]), /授权按钮发送失败/)

  const unconfigured = setup({}, EMPTY_PLATFORM)
  const reply = fakeEvent('/qqauth 123456789', { command: { name: 'qqauth', rawInput: ' 123456789' } }, unconfigured.bot)
  await unconfigured.host.handle(reply, ignored)
  assert.match(String(reply.replies[0]), /botUin 未配置/)
})

test('自动同步：机器人上线后延迟同步一次，离线后再上线会重新同步；dispose 后不再同步', async () => {
  const { host, bot, timers, request } = setup({ panels: [] }, EMPTY_PLATFORM)
  host.onBotStatus(bot)
  host.onBotStatus(bot)
  assert.equal(timers.length, 1)
  timers.shift()!()
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(request.calls.some(call => call.path === '/v2/menu'))

  bot.status = 0
  host.onBotStatus(bot)
  bot.status = 1
  host.onBotStatus(bot)
  assert.equal(timers.length, 1)

  host.dispose()
  const count = request.calls.length
  timers.shift()!()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(request.calls.length, count)
})

test('im-panel tab：读取现状与执行同步', async () => {
  const { host } = setup({ panels: [{ key: 'a', scope: 'c2c', source: 'manual', items: [{ name: '/a' }] }] }, {
    ...EMPTY_PLATFORM,
    'POST /v2/panels': { panel_id: 'p_new' },
  })
  const tab = qqPanelTab(host)
  const state = await tab.read!({ path: '', query: new URLSearchParams() }) as { bots: unknown[]; report?: { desired: unknown[] } }
  assert.deepEqual(state.bots, [{ id: 'qq:app', online: true }])
  assert.equal(state.report?.desired.length, 1)
  const answer = await tab.command!({ path: '', body: { action: 'sync', resources: ['panels'] } }) as { ok: boolean; text: string }
  assert.equal(answer.ok, true)
  assert.match(answer.text, /面板：新建 1/)
})
