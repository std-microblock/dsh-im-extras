import assert from 'node:assert/strict'
import test from 'node:test'
import { collectEntries, generateItems, matchPattern, pickLabel, truncate, type CommandEntry } from '../src/commands.ts'

const SESSION: CommandEntry[] = [
  { name: 'help', description: '显示可用命令', source: 'session' },
  { name: 'status', description: '查看会话状态', source: 'session' },
  { name: 'stop', description: '停止正在运行的会话', source: 'session' },
]
const SKILLS: CommandEntry[] = [
  { name: 'ticket-intake', aliases: ['产品需求'], description: '产品侧需求建单规范', source: 'skills' },
  { name: 'quick-note', aliases: ['笔记'], description: '普通技能', source: 'skills' },
  { name: 'a-really-long-skill-name', description: '太长了', source: 'skills' },
]

test('matchPattern：通配与大小写', () => {
  assert.equal(matchPattern('help', 'HELP'), true)
  assert.equal(matchPattern('ticket-*', 'ticket-intake'), true)
  assert.equal(matchPattern('ticket', 'ticket-intake'), false)
  assert.equal(matchPattern('', 'x'), false)
})

test('truncate：按平台宽度截断并加省略号', () => {
  assert.equal(truncate('短描述', 30), '短描述')
  const long = '这是一段非常非常非常非常非常非常长的描述文字'
  const cut = truncate(long, 30)
  assert.ok(cut.endsWith('…'))
  assert.ok([...cut].length < [...long].length)
})

test('pickLabel：优先能放下的中文别名，其次最短；都放不下时 undefined', () => {
  assert.equal(pickLabel(SKILLS[0]!, '/'), '/产品需求')
  assert.equal(pickLabel(SESSION[0]!, '/'), '/help')
  assert.equal(pickLabel(SKILLS[2]!, '/'), undefined)
  assert.equal(pickLabel({ name: 'x', aliases: ['/已带斜杠'], source: 'extra' }, '/'), '/已带斜杠')
})

test('collectEntries：去重、默认排除本插件指令、超长名称给出警告', () => {
  const { entries, warnings } = collectEntries([
    ...SESSION,
    { name: 'help', description: '重复', source: 'extra' },
    { name: 'qqpanel.sync', source: 'extra' },
    ...SKILLS,
  ], { prefix: '/' })
  assert.deepEqual(entries.map(entry => entry.name), ['help', 'status', 'stop', 'ticket-intake', 'quick-note'])
  assert.equal(entries[0]!.desc, '显示可用命令')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /a-really-long-skill-name/)
})

test('generateItems：include 排在前面（可按别名命中），exclude 生效，extraItems 计入上限', () => {
  const result = generateItems([...SESSION, ...SKILLS], {
    prefix: '/',
    include: ['笔记', 'help'],
    exclude: ['stop'],
    maxItems: 4,
    extraItems: [{ type: 'link', name: '文档', link: 'https://example.com/docs' }],
  })
  assert.deepEqual(result.items.map(item => item.name), ['/笔记', '/help', '/status', '文档'])
  assert.deepEqual(result.items[1], { type: 'command', name: '/help', desc: '显示可用命令', onlyAdmin: false })
  assert.ok(result.warnings.some(warning => /超过面板上限 4/.test(warning) && /产品需求/.test(warning)))
})

test('generateItems：自定义前缀与 onlyAdmin', () => {
  const result = generateItems([{ name: 'ban', description: '禁言', onlyAdmin: true, source: 'extra' }], { prefix: '' })
  assert.deepEqual(result.items, [{ type: 'command', name: 'ban', desc: '禁言', onlyAdmin: true }])
})
