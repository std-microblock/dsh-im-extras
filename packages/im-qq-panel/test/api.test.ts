import assert from 'node:assert/strict'
import test from 'node:test'
import * as api from '../src/api.ts'
import { fakeRequest, PlatformError } from './helpers.ts'

test('字符计数：中文按 2 个字符计算', () => {
  assert.equal(api.textWeight('help'), 4)
  assert.equal(api.textWeight('帮助'), 4)
  assert.equal(api.textWeight('抽奖助力'), 8)
  assert.equal(api.textWeight(''), 0)
})

test('菜单校验：接受 camelCase，输出平台 snake_case', () => {
  const menu = api.normalizeMenu({
    items: [
      { type: 'send_message', name: '帮助', sendMessage: '/help' },
      { type: 'link', name: '官网', link: 'https://example.com' },
      { type: 'switch', name: '搜索', switchId: 'search', switchDefault: true },
      { type: 'menu', name: '更多', subMenuItems: [{ type: 'send_message', name: '设置', sendMessage: '/settings' }] },
    ],
  })
  assert.deepEqual(menu.items[0], { type: 'send_message', name: '帮助', send_message: '/help' })
  assert.deepEqual(menu.items[1], { type: 'link', name: '官网', link: 'https://example.com' })
  assert.deepEqual(menu.items[2], { type: 'switch', name: '搜索', switch: { switch_id: 'search', default: true } })
  assert.deepEqual(menu.items[3], {
    type: 'menu',
    name: '更多',
    sub_menu_items: [{ type: 'send_message', name: '设置', send_message: '/settings' }],
  })
  assert.deepEqual(api.normalizeMenu({ items: [{ type: 'send_message', name: '帮助', send_message: '/help' }] }).items,
    [{ type: 'send_message', name: '帮助', send_message: '/help' }])
})

test('菜单校验：拒绝超长名称、非 https 链接、非法类型、超量子菜单与超过 10 项', () => {
  assert.throws(() => api.normalizeMenu({ items: [{ type: 'send_message', name: '一二三四五六', sendMessage: 'x' }] }), /超长/)
  assert.throws(() => api.normalizeMenu({ items: [{ type: 'link', name: '官网', link: 'http://example.com' }] }), /https/)
  assert.throws(() => api.normalizeMenu({ items: [{ type: 'bogus', name: 'x' }] }), /type/)
  assert.throws(() => api.normalizeMenu({
    items: [{
      type: 'menu',
      name: '更多',
      subMenuItems: Array.from({ length: 6 }, (_, index) => ({ type: 'send_message', name: `s${index}`, sendMessage: 'x' })),
    }],
  }), /子菜单数量/)
  const items = Array.from({ length: 11 }, (_, index) => ({ type: 'send_message', name: `i${index}`, sendMessage: 'x' }))
  assert.throws(() => api.normalizeMenu({ items }), /最多 10 个/)
})

test('面板校验：scope/targetType/关联对象约束', () => {
  const base = { items: [{ type: 'command', name: '/help' }] }
  assert.deepEqual(api.buildPanelCreate({ scope: 'c2c', ...base }), {
    scope: 'c2c',
    target_type: 'all',
    panel: { items: [{ type: 'command', name: '/help', only_admin: false }] },
  })
  assert.deepEqual(api.buildPanelCreate({ scope: 'group', targetType: 'specific', groupOpenIds: ['G1'], ...base }).group_openids, ['G1'])
  assert.throws(() => api.buildPanelCreate({ scope: 'channel', targetType: 'specific', userOpenIds: ['U1'], ...base }), /只支持 c2c\/group/)
  assert.throws(() => api.buildPanelCreate({ scope: 'dm', targetType: 'specific', userOpenIds: ['U1'], ...base }), /只支持 c2c\/group/)
  assert.throws(() => api.buildPanelCreate({ scope: 'c2c', targetType: 'specific', ...base }), /userOpenIds/)
  assert.throws(() => api.buildPanelCreate({ scope: 'c2c', items: Array.from({ length: 21 }, (_, i) => ({ type: 'command', name: `c${i}` })) }), /最多 20 个/)
  assert.throws(() => api.buildPanelCreate({ scope: 'c2c', panel: { items: [{ type: 'link', name: '官网', link: 'http://example.com' }] } }), /https/)
  assert.throws(() => api.buildPanelCreate({ scope: 'c2c', panel: { items: [{ type: 'command', name: '/help', desc: '一二三四五六七八九十壹贰叁肆伍陆' }] } }), /超长/)
})

test('面板校验：target 操作体', () => {
  assert.deepEqual(api.buildPanelTarget({ op: 'add', groupOpenIds: ['G2'] }), { op: 'add', group_openids: ['G2'] })
  assert.deepEqual(api.buildPanelTarget({ op: 'del', user_openids: ['U1'] }), { op: 'del', user_openids: ['U1'] })
  assert.throws(() => api.buildPanelTarget({ op: 'remove', userOpenIds: ['U1'] }), /op/)
  assert.throws(() => api.buildPanelTarget({ op: 'add' }), /必须提供/)
})

test('请求封装：路径、方法、请求体与响应解析', async () => {
  const request = fakeRequest({
    'GET /v2/menu': { version: 40, menu: { items: [] } },
    'PUT /v2/menu': ({ data }) => ({ version: 41, echoed: data }),
    'POST /v2/panels': { panel_id: 'p_new' },
    'GET /v2/panels': { records: [{ panel_id: 'p1' }], next_cursor: '', is_end: true },
    'GET /v2/panels/p_old': { panel_id: 'p_old', target_type: 'specific', user_openids: ['U1'] },
    'PUT /v2/panels/p_old': { version: 7 },
    'DELETE /v2/panels/p_old': undefined,
    'PUT /v2/panels/p_old/target': undefined,
  })

  assert.deepEqual(await api.getMenu(request), { version: 40, menu: { items: [] } })
  assert.equal((await api.updateMenu(request, { items: [{ type: 'send_message', name: '帮助', sendMessage: '/help' }] })).version, 41)
  assert.deepEqual(await api.createPanel(request, { scope: 'c2c', panel: { items: [{ type: 'command', name: '/help' }] } }), { panelId: 'p_new', scope: 'c2c' })
  const page = await api.getPanels(request, { scope: 'c2c', limit: 10 })
  assert.deepEqual(page.records, [{ panel_id: 'p1' }])
  assert.equal(page.isEnd, true)
  assert.equal((await api.getPanel(request, 'p_old')).panel_id, 'p_old')
  assert.equal((await api.updatePanel(request, 'p_old', { items: [{ type: 'command', name: '/new' }] })).version, 7)
  assert.equal(await api.deletePanel(request, 'p_old'), true)
  assert.equal(await api.updatePanelTarget(request, 'p_old', { op: 'add', userOpenIds: ['U2'] }), true)

  assert.deepEqual(request.calls.map(call => `${call.method} ${call.path}`), [
    'GET /v2/menu',
    'PUT /v2/menu',
    'POST /v2/panels',
    'GET /v2/panels?scope=c2c&limit=10',
    'GET /v2/panels/p_old',
    'PUT /v2/panels/p_old',
    'DELETE /v2/panels/p_old',
    'PUT /v2/panels/p_old/target',
  ])
  assert.deepEqual(request.calls[1]!.data, { menu: { items: [{ type: 'send_message', name: '帮助', send_message: '/help' }] } })
  assert.deepEqual(request.calls[7]!.data, { op: 'add', user_openids: ['U2'] })
})

test('分页：一直拉到 is_end，并防止游标重复', async () => {
  const pages: Record<string, unknown> = {
    '': { records: [{ panel_id: 'p1' }], next_cursor: 'c1', is_end: false },
    c1: { records: [{ panel_id: 'p2' }, { panel_id: 'p1' }], next_cursor: 'c2', is_end: false },
    c2: { records: [{ panel_id: 'p3' }], next_cursor: '', is_end: true },
  }
  const request = fakeRequest({ 'GET /v2/panels': ({ query }) => pages[query.get('cursor') ?? ''] })
  const records = await api.getAllPanels(request, 'c2c')
  assert.deepEqual(records.map(record => record.panel_id), ['p1', 'p2', 'p3'])
  assert.equal(request.calls.length, 3)

  const looping = fakeRequest({ 'GET /v2/panels': { records: [], next_cursor: 'stuck', is_end: false } })
  assert.deepEqual(await api.getAllPanels(looping, 'c2c'), [])
  assert.equal(looping.calls.length, 2)
})

test('错误：adapter 的 QqApiError 形状（status/code/body）可以描述并识别限频', () => {
  const error = new PlatformError('PUT /v2/menu answered 400', { status: 400, body: { err_code: 40030014, message: '菜单类型不合法', trace_id: 'abc' } })
  assert.equal(api.describeError(error), '菜单类型不合法（err_code 40030014），trace_id abc')
  assert.equal(api.errorCode(error), 40030014)
  assert.equal(api.isRateLimited(error), false)
  assert.equal(api.isRateLimited(new PlatformError('x', { status: 400, body: { err_code: 40023001 } })), true)
  assert.equal(api.isRateLimited(new PlatformError('x', { status: 429 })), true)
  assert.equal(api.isRateLimited(new PlatformError('x', { status: 400, code: 40023001 })), true)
  assert.match(api.describeError(new Error('boom')), /boom/)
})

test('差异规整：平台返回值与本地期望值可比较', () => {
  assert.deepEqual(api.canonicalPanelItem({ type: 'command', name: '/help', only_admin: undefined }), {
    type: 'command',
    name: '/help',
    only_admin: false,
  })
  assert.deepEqual(api.canonicalMenuItem({ type: 'menu', name: '更多', sub_menu_items: [{ type: 'link', name: '官网', link: 'https://a.com' }] }), {
    type: 'menu',
    name: '更多',
    sub_menu_items: [{ type: 'link', name: '官网', link: 'https://a.com' }],
  })
})
