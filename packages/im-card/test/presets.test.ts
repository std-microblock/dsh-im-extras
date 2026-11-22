/**
 * The preset components (`PromptButton`, `PromptChoices`, `PromptForm`, `Switch`, `Segmented`, `Stepper`): bundled and
 * type-checked like any card, then driven in a real QuickJS VM — a click sends its prompt to the agent, the control
 * turns into the answer, only the requester may click it, and a form sends what was filled in. Every rendered tree is
 * also validated as message content and against the Lark card limits.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { bundleCard, type CardBundle, type CardFiles } from '../src/bundle.ts'
import { vendor } from './vendor.ts'
import { CardEngine, type CardNode, type CardVm, type CardVmHost } from '../src/engine.ts'

const core = await vendor('plugin-im-core')
const lark = await vendor('plugin-im-adapter-lark')
type El = { type: string; attrs: Record<string, unknown>; children: El[] }
const h = core.h as ((tag: string, attrs: Record<string, unknown>, ...kids: El[]) => El) & { text(s: string): El }
const normalize = core.normalize as (el: El) => El
const cardMode = lark.LarkBot.prototype.createCardMode.call({ config: {} })

const files: CardFiles = { read: path => readFile(path, 'utf8').catch(() => undefined) }
const LIMITS = { maxModules: 16, maxBytes: 256 * 1024 }
const REQUESTER = { id: 'ou_req', name: '张三' }

function recorder(): CardVmHost & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    schedule: () => { calls.push('schedule') },
    timers: () => {},
    toast: (content, type) => { calls.push(`toast ${type} ${content}`) },
    agent: (text) => { calls.push(`agent ${text}`); return { ok: true } },
    files: () => ({ ok: false, error: 'this test gives the card no data folder' }),
    fetch: () => ({ ok: false, error: 'this test lets no request out' }),
    close: () => { calls.push('close') },
    log: (level, text) => { calls.push(`log ${level} ${text}`) },
    error: (text) => { calls.push(`error ${text}`) },
  }
}

function elementOf(node: CardNode): El {
  if (node.t === 'text') return h.text(String(node.a.content ?? ''))
  return h(node.t, { ...node.a }, ...node.c.map(elementOf))
}

/** The tree as the platform validates it: structure, message content, and the Lark card limits. */
function check(tree: CardNode[], label: string): void {
  const roots = tree.length === 1 && tree[0]!.t === 'message' ? tree[0]!.c : tree
  const message = normalize(h('message', {}, ...roots.map(elementOf)))
  const result = core.transform(message, { bot: {}, target: { chat: { id: 'lark:test', type: 'group' } }, mode: cardMode })
  assert.equal(result.msgs.length, 1, `${label}: one card message`)
  for (const draft of result.msgs) assert.deepEqual(cardMode.check(draft), [], `${label}: Lark limits`)
  assert.deepEqual(result.report.dropped, [], `${label}: dropped elements`)
}

/** Every node of a tree, depth first. */
function flat(tree: CardNode[]): CardNode[] {
  return tree.flatMap(node => [node, ...flat(node.c)])
}

/** The text of a tree, concatenated. */
function text(tree: CardNode[]): string {
  return flat(tree).filter(node => node.t === 'text').map(node => String(node.a.content ?? '')).join('')
}

/** Tokens of the clickable buttons, in render order; `type` narrows to action or submit buttons. */
function tokens(tree: CardNode[], type?: 'action' | 'submit'): string[] {
  return flat(tree)
    .filter(node => node.t === 'button' && node.a.disabled !== true && typeof node.a.id === 'string' && node.a.id !== 'inert')
    .filter(node => type === undefined || node.a.type === type)
    .map(node => String(node.a.id))
}

interface Opened {
  card: CardVm
  host: CardVmHost & { calls: string[] }
  /** Render and validate. */
  render(): CardNode[]
  /** Clicks a token as the requester (or as `user`), then checks nothing threw inside the VM. */
  click(token: string, user?: { id: string; name?: string }, extra?: Record<string, unknown>): void
  /** The `agent.send` texts so far. */
  sent(): string[]
}

/** Bundle one inline card, start it in a real VM, and render it once; `null` starts it with no known requester. */
async function open(
  source: string,
  requester: { id: string; name?: string } | null = REQUESTER,
  limits: { typecheck?: boolean } = {},
): Promise<Opened> {
  const bundle: CardBundle = await bundleCard({ inline: source, cwd: '/w' }, files, { ...LIMITS, ...limits })
  const engine = await CardEngine.create({ memoryBytes: 16 << 20, cpuMs: 2000 })
  const host = recorder()
  const card = await engine.start(bundle, {}, host, requester === null ? {} : { requester })
  const opened: Opened = {
    card,
    host,
    render() {
      const out = card.render()
      assert.ok(out.ok, `render: ${out.ok ? '' : out.error}`)
      check(out.tree, 'render')
      return out.tree
    },
    click(token, user = REQUESTER, extra = {}) {
      assert.equal(card.click(token, { user, time: 1, ...extra }), true, 'the token routes to a handler')
      assert.deepEqual(host.calls.filter(call => call.startsWith('error')), [], 'no uncaught error')
    },
    sent() {
      return host.calls.filter(call => call.startsWith('agent')).map(call => call.slice('agent '.length))
    },
  }
  opened.render()
  return opened
}

test('a PromptButton sends its prompt once and turns into the answer', async () => {
  const opened = await open(`export default function Card() {
    return <message><p>要现在部署吗？</p><PromptButton prompt="确认部署" variant="primary_filled">确认部署</PromptButton></message>
  }`)
  opened.click(tokens(opened.render(), 'action')[0]!)
  assert.deepEqual(opened.sent(), ['确认部署'])
  const after = opened.render()
  assert.deepEqual(tokens(after), [], 'the button is gone')
  assert.match(text(after), /✅ 已选择「确认部署」 · 张三/)
})

test('a quick reply admits only the requester unless it says otherwise', async () => {
  const opened = await open(`export default function Card() {
    return <message>
      <PromptChoices options={["确认", "取消"]} />
      <PromptButton prompt="再看看" once={false}>再看看</PromptButton>
    </message>
  }`)
  const [confirm, cancel, again] = tokens(opened.render(), 'action')
  opened.click(cancel!, { id: 'ou_other', name: '李四' })
  assert.deepEqual(opened.sent(), [], 'a stranger sends nothing')
  assert.match(opened.host.calls.filter(call => call.startsWith('toast')).join('\n'), /toast warning 只有 张三 可以点击/)
  // The requester may: the row collapses to who answered, the repeatable button stays.
  opened.click(confirm!)
  assert.deepEqual(opened.sent(), ['确认'])
  const after = opened.render()
  assert.match(text(after), /✅ 已选择「确认」 · 张三/)
  assert.deepEqual(tokens(after, 'action'), [again])

  // sender="anyone" opens a card to the whole chat; once={false} keeps it clickable and toasts.
  const shared = await open(`export default function Card() {
    return <message><PromptChoices sender="anyone" once={false} options={[{ label: "周末来", prompt: "周末我来" }, "不来"]} /></message>
  }`)
  const sharedTokens = tokens(shared.render(), 'action')
  shared.click(sharedTokens[1]!, { id: 'ou_other' })
  assert.deepEqual(shared.sent(), ['不来'])
  assert.match(shared.host.calls.join('\n'), /toast success 已发送/)
  assert.deepEqual(tokens(shared.render(), 'action'), sharedTokens, 'the row stays')
})

test('a PromptForm sends the filled text and names who submitted it', async () => {
  const opened = await open(`export default function Card() {
    return <message>
      <p>这条反馈怎么处理？</p>
      <PromptForm
        prompt="反馈处理：{level}｜回电：{callback}｜备注：{note}"
        fields={[
          { name: 'level', label: '优先级', type: 'select', options: ['高', '中', '低'], value: '中' },
          { name: 'note', label: '备注', type: 'multiline', placeholder: '补充说明' },
          { name: 'callback', label: '需要回电', type: 'checkbox' },
          { name: 'urgent', label: '紧急', type: 'switch' },
        ]}
      />
    </message>
  }`)
  const first = opened.render()
  const form = flat(first).find(node => node.t === 'form')
  assert.ok(form, 'a form is rendered')
  assert.deepEqual(flat([form]).filter(node => node.t === 'input').map(node => node.a.name), ['note', 'callback'],
    'a form holds only form components')
  assert.ok(/紧急/.test(text(first)), 'the switch field keeps its caption above the form')
  const [submit] = tokens(first, 'submit')
  opened.click(submit!, REQUESTER, { values: { level: '高', note: '客户在群里追问', callback: true, urgent: true } })
  assert.deepEqual(opened.sent(), ['反馈处理：高｜回电：是｜备注：客户在群里追问'])
  const after = opened.render()
  assert.match(text(after), /✅ 已提交 · 张三/)
  assert.match(text(after), /反馈处理：高/)
  assert.deepEqual(tokens(after, 'submit'), [], 'the form is replaced by the answer')
})

test('a switch, a segmented row and a stepper keep their own state', async () => {
  const opened = await open(`import { useState } from 'dsh:card'
  export default function Card() {
    const [on, setOn] = useState(false)
    const [size, setSize] = useState('中杯')
    const [n, setN] = useState(1)
    return <message>
      <p>夜间 {on ? '开' : '关'}｜{size}｜{n}</p>
      <Switch label="夜间模式" onChange={setOn} />
      <Segmented label="杯型" options={['小杯', '中杯', '大杯']} onChange={setSize} />
      <Stepper label="数量" value={1} min={1} max={3} onChange={setN} unit="杯" />
    </message>
  }`)
  assert.match(text(opened.render()), /夜间 关｜中杯｜1/)
  /** The token of the button whose label is exactly `label`. */
  const byLabel = (label: string): string => {
    const button = flat(opened.render()).find(node => node.t === 'button' && text([node]) === label)
    assert.ok(button, `a "${label}" button`)
    return String(button.a.id)
  }
  opened.click(byLabel('开启'), { id: 'ou_someone' })
  opened.click(byLabel('大杯'), { id: 'ou_someone' })
  opened.click(byLabel('+'), { id: 'ou_someone' })
  assert.match(text(opened.render()), /夜间 开｜大杯｜2/)
  assert.deepEqual(opened.sent(), [], 'a control that does not send keeps quiet')
})

test('a card with no known requester admits anyone; an unknown field type is refused at render', async () => {
  const opened = await open(`export default function Card() {
    return <message><PromptButton prompt="好" senderName="李四">好</PromptButton></message>
  }`, null)
  opened.click(tokens(opened.render(), 'action')[0]!, { id: 'ou_anyone' })
  assert.deepEqual(opened.sent(), ['好'])

  // The types refuse an unknown field; the runtime refuses one that reached it anyway (a hand-written or untyped card).
  await assert.rejects(open(`export default function Card() {
    return <message><PromptForm fields={[{ name: 'x', type: 'date' }]} /></message>
  }`, REQUESTER, { typecheck: false }), /unknown field type "date"/)
})

test('the presets are type-checked: a wrong prop is a card error, not a broken card', async () => {
  for (const source of [
    'export default () => <message><PromptButton prompt="x" variant="big">x</PromptButton></message>',
    'export default () => <message><PromptChoices options="确认" /></message>',
    'export default () => <message><PromptForm /></message>',
    'export default () => <message><PromptButton prompt="x" unknown={1}>x</PromptButton></message>',
    'export default () => <message><Switch value="on" /></message>',
    'export default () => <message><AuthRequest capabilities={[123]} /></message>',
  ]) {
    await assert.rejects(bundleCard({ inline: source, cwd: '/w' }, files, LIMITS), /does not type-check/, source)
  }
})

test('the system-prompt guidance names every preset and shows a card that compiles', async () => {
  const { GUIDANCE } = await import('../src/guidance.ts')
  for (const name of ['PromptButton', 'PromptChoices', 'PromptForm', 'Switch', 'Segmented', 'Stepper', 'AuthRequest', 'satori-tsx']) {
    assert.ok(GUIDANCE.includes(name), `the guidance mentions ${name}`)
  }
  const block = /```satori-tsx\n([\s\S]*?)```/.exec(GUIDANCE)
  assert.ok(block, 'the guidance shows a satori-tsx block')
  const bundle = await bundleCard({ inline: block[1]!, cwd: '/w' }, files, LIMITS)
  const card = await (await CardEngine.create({ memoryBytes: 16 << 20, cpuMs: 2000 }))
    .start(bundle, {}, recorder(), { requester: REQUESTER })
  const out = card.render()
  assert.ok(out.ok, out.ok ? '' : out.error)
  check(out.tree, 'guidance example')
  card.dispose()
})

test('AuthRequest compiles and validates cleanly across 0, 1, and multiple capabilities', async () => {
  for (const source of [
    'export default () => <message><AuthRequest reason="请先认领本任务" /></message>',
    'export default () => <message><AuthRequest capabilities={["feishu-project"]} reason="需要访问飞书项目" /></message>',
    'export default () => <message><AuthRequest capabilities={["feishu-project", { id: "prod-db", label: "生产库只读", defaultChecked: false }]} /></message>',
  ]) {
    const opened = await open(source)
    const tree = opened.render()
    assert.ok(tree.length > 0)
    opened.card.dispose()
  }
})

test('bare JSX without export default bundles, type-checks, renders, and handles clicks cleanly', async () => {
  for (const source of [
    '<AuthRequest capabilities={["feishu-project"]} reason="查看你飞书项目里的空间与工作项（只读查询）" />',
    'const reason = "只读";\n<AuthRequest capabilities={["feishu-project"]} reason={reason} />',
  ]) {
    const opened = await open(source)
    const tree = opened.render()
    assert.ok(tree.length > 0)
    assert.match(text(tree), /请求会话独占与能力授权/)
    const actionTokens = tokens(tree, 'action')
    assert.ok(actionTokens.length > 0)
    opened.click(actionTokens[0]!)
    opened.card.dispose()
  }
  await assert.rejects(
    bundleCard({ inline: '<AuthRequest capabilities={[123]} />', cwd: '/w' }, files, LIMITS),
    /does not type-check/,
  )
})
