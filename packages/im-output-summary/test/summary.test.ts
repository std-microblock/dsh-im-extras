import assert from 'node:assert/strict'
import test from 'node:test'
import { h, type Element, type Fragment, type MessageHandle, type MessageStream, type SendResult } from '@deepseek-ai/cordis-plugin-im-core'
import type { ImActivity, ImOutputIO, ImSegment } from '@deepseek-ai/dsh-im'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { apply as applySummary } from '../src/index.ts'
import type { SummaryConfig } from '../src/config.ts'
import type { TurnCardService, TurnCards } from '../src/cards.ts'
import type { MessageComposer } from '../src/renderer.ts'
import { SummaryRenderer } from '../src/renderer.ts'
import { NO_OUTPUT_TOOL } from '../src/tools.ts'
import { AUTH_STOP_BUTTON_PREFIX, LEGACY_STOP_BUTTON_PREFIX, STOP_BUTTON_PREFIX } from '../src/view.ts'

/** The hosted session every turn of these tests belongs to. */
const SESSION = 'im-s1' as SessionId

/** Chat key the fake host publishes into. */
const CHAT = 'lark:cli_test|oc_123' as const

/** Where a test's page link points. */
const PAGE = 'http://127.0.0.1:3242/sessions/im-s1'

/**
 * Operator configuration of the renderer under test.
 * @param overrides - fields this test changes.
 * @returns the complete configuration.
 */
function config(overrides: Partial<SummaryConfig> = {}): SummaryConfig {
  return {
    locale: 'zh',
    maxChars: 4000,
    intervalMs: 1200,
    firstOutput: 'immediate',
    showStop: true,
    progress: false,
    progressFirstDelayMs: 5000,
    progressIntervalMs: 20_000,
    progressMinSteps: 0,
    progressTimeoutMs: 120_000,
    progressMaxChars: 600,
    ...overrides,
  }
}

/** One node of a published element tree. */
interface Node {
  type: string
  attrs: Record<string, unknown>
  children: Node[]
}

/**
 * One activity snapshot of the turn under test.
 * @param segments - the segments the turn produced so far.
 * @param status - the settled state of the turn.
 * @returns the activity as `im/activity` reports one.
 */
function activity(segments: ImSegment[] = [], status: ImActivity['status'] = 'running', error?: string): ImActivity {
  return {
    session: {
      sessionId: SESSION,
      key: 'task:1',
      owner: 'task',
      composition: { agentPreset: 'im-dispatch-worker', cwd: '/work', provider: 'deepseek-official', model: 'deepseek-flash' },
      bindings: [{ chat: CHAT, writable: true, home: true }],
      output: 'summary',
      generation: 1,
      createdAt: 0,
      lastActiveAt: 0,
    },
    turn: 1,
    status,
    segments,
    ...error === undefined ? {} : { error },
    startedAt: 0,
    updatedAt: 1000,
  }
}

/** A text segment of the turn's answer. */
function text(value: string): ImSegment {
  return { kind: 'text', text: value }
}

/** A finished tool call of the turn. */
function tool(name: string): ImSegment {
  return { kind: 'tool', callId: `call-${name}`, name, args: '{}', status: 'done', result: '' }
}

/** The tool call the turn is running right now. */
function runningTool(name: string): ImSegment {
  return { kind: 'tool', callId: `call-${name}`, name, args: '{}', status: 'running' }
}

/** The stream one turn opened, as this fake host drives it. */
class FakeStream implements MessageStream {
  readonly strategy = 'patch'
  /** Every state the turn published while it ran. */
  readonly updates: Node[] = []
  /** The state the turn closed with, if it closed. */
  closedWith: Node | undefined
  /** The abort the turn requested, if it aborted. */
  aborted: { recall?: boolean; reason?: string } | undefined
  state: MessageStream['state'] = 'idle'
  handle: MessageHandle | undefined
  readonly done: Promise<SendResult>
  /** Whether the platform allows the published message to be recalled. */
  recallable = true

  constructor() {
    this.done = Promise.resolve({ status: 'confirmed' })
  }

  update(content: Fragment): void {
    this.updates.push(content as Node)
    this.state = 'open'
  }

  async close(final?: Fragment): Promise<SendResult> {
    this.closedWith = final as Node | undefined
    this.state = 'closed'
    this.handle ??= { parts: [], edits: 0, state: 'closed', content: this.closedWith } as MessageHandle
    return { status: 'confirmed', handle: this.handle }
  }

  async abort(options: { recall?: boolean; reason?: string } = {}): Promise<boolean> {
    this.aborted = options
    this.state = 'closed'
    return options.recall === true && this.recallable
  }
}

/**
 * The IM output sink of one turn: the streams it opened and the plain messages it sent.
 * @returns the sink and what it received.
 */
function sink() {
  const streams: FakeStream[] = []
  const sent: Node[] = []
  const io: ImOutputIO = {
    chat: CHAT,
    stream: async () => {
      const stream = new FakeStream()
      streams.push(stream)
      return stream
    },
    send: async (content) => {
      sent.push(content as Node)
      return { status: 'confirmed', handle: { parts: [], edits: 0, state: 'confirmed', content: content as Node } as MessageHandle }
    },
  }
  return { io, streams, sent }
}

/**
 * Every node of a published tree, depth first.
 * @param node - the root.
 * @returns the root and all of its descendants.
 */
function nodesOf(node: Node | undefined): Node[] {
  if (node === undefined) return []
  return [node, ...node.children.flatMap(child => nodesOf(child))]
}

/**
 * All text a published tree carries: element text and the markdown blocks of the answer.
 * @param node - the root.
 * @returns the concatenated text.
 */
function textOf(node: Node | undefined): string {
  return nodesOf(node).flatMap((entry) => {
    if (entry.type === 'text') return [String(entry.attrs.content ?? '')]
    if (entry.type === 'markdown') return [String(entry.attrs.content ?? '')]
    return []
  }).join('')
}

/**
 * The page link a contributing plugin added, as the message carries it.
 * @param node - the root.
 * @returns the href of its anchor, or `undefined` when it holds none.
 */
function linkOf(node: Node | undefined): string | undefined {
  return nodesOf(node).find(entry => entry.type === 'a')?.attrs.href as string | undefined
}

/** What a contributing plugin adds to the message: one line holding a link. */
function pageLine(): Element<'small'> {
  return h('small', h('a', { href: PAGE }, h.text('查看工作过程')))
}

/**
 * Open one turn on a renderer and keep what the fake host received.
 * @param options - the renderer configuration, whether a plugin contributes, and the first activity.
 * @returns the renderer, the turn, the sink, and the composer the renderer was given.
 */
function turnHarness(options: {
  config?: Partial<SummaryConfig>
  contribute?: boolean
  first?: ImActivity
  cards?: () => TurnCardService | undefined
} = {}) {
  const compose: MessageComposer | undefined = options.contribute === true
    ? (message, next) => (message.hasProcessMessage ? next() : [...next(), pageLine()])
    : undefined
  const renderer = new SummaryRenderer(config(options.config), undefined, undefined, options.cards, compose)
  const { io, streams, sent } = sink()
  const first = options.first ?? activity()
  const output = renderer.begin(first, io)
  return { renderer, output, streams, sent }
}

/** Let the renderer's own promise chain settle. */
function settled(): Promise<void> {
  return new Promise(resolve => { setImmediate(resolve) })
}

test('a turn publishes its progress message as soon as it starts', async () => {
  const { streams, sent } = turnHarness()
  await settled()
  assert.equal(streams.length, 1)
  assert.equal(streams[0]!.updates.length, 1)
  assert.match(textOf(streams[0]!.updates[0]), /思考中/)
  assert.deepEqual(sent, [])
})

test('first-tool keeps the message back until the turn calls a tool', async () => {
  const { output, streams } = turnHarness({ config: { firstOutput: 'first-tool' }, first: activity([text('先想一下')]) })
  await settled()
  assert.deepEqual(streams, [])
  output.update(activity([text('先想一下'), runningTool('read_file')]), 'tool')
  await settled()
  assert.equal(streams.length, 1)
  assert.match(textOf(streams[0]!.updates.at(-1)), /read_file/)
})

test('first-tool still delivers the answer of a turn that called no tool', async () => {
  const { output, streams, sent } = turnHarness({ config: { firstOutput: 'first-tool' }, first: activity([text('直接回答')]) })
  await settled()
  assert.deepEqual(streams, [])
  await output.end(activity([text('直接回答')], 'done'))
  assert.equal(streams.length, 0)
  assert.equal(sent.length, 1)
  assert.match(textOf(sent[0]), /直接回答/)
  assert.match(textOf(sent[0]), /0 次工具调用/)
})

test('the silencing call is not the tool call the message waits for', async () => {
  const segments = [tool(NO_OUTPUT_TOOL)]
  const { output, streams } = turnHarness({ config: { firstOutput: 'first-tool' }, first: activity([text('看一眼')]) })
  output.update(activity(segments), 'tool')
  await settled()
  assert.deepEqual(streams, [])
})

test('a silenced turn that published nothing leaves the chat untouched', async () => {
  const { renderer, output, streams, sent } = turnHarness({ config: { firstOutput: 'first-tool' } })
  assert.equal(await renderer.silence(SESSION), false)
  await output.end(activity([text('只更新卡片')], 'done'))
  assert.deepEqual(streams, [])
  assert.deepEqual(sent, [])
})

test('silencing a turn that already published withdraws its message and posts nothing more', async () => {
  const { renderer, output, streams, sent } = turnHarness()
  await settled()
  assert.equal(streams.length, 1)
  assert.equal(await renderer.silence(SESSION), true)
  assert.deepEqual(streams[0]!.aborted, { recall: true, reason: 'no_output' })
  await output.end(activity([text('只更新卡片')], 'done'))
  assert.equal(streams[0]!.closedWith, undefined)
  assert.deepEqual(sent, [])
})

test('a streamed turn collapses its process card to the link and sends the answer as a new message', async () => {
  const running = turnHarness({ contribute: true })
  assert.equal(running.renderer.streamsMessage, true)
  await settled()
  assert.equal(linkOf(running.streams[0]!.updates[0]), PAGE)
  await running.output.end(activity([tool('read_file'), text('最终答案')], 'done'))
  assert.equal(linkOf(running.streams[0]!.closedWith), PAGE)
  assert.doesNotMatch(textOf(running.streams[0]!.closedWith), /最终答案/)
  assert.equal(running.sent.length, 1)
  assert.match(textOf(running.sent[0]), /最终答案/)
  assert.match(textOf(running.sent[0]), /1 次工具调用/)
  assert.equal(linkOf(running.sent[0]), undefined)

  const noTool = turnHarness({
    config: { firstOutput: 'first-tool' },
    contribute: true,
    first: activity([text('直接回答')]),
  })
  await settled()
  await noTool.output.end(activity([text('直接回答')], 'done'))
  assert.equal(noTool.streams.length, 0)
  assert.equal(noTool.sent.length, 1)
  assert.match(textOf(noTool.sent[0]), /直接回答/)
  assert.match(textOf(noTool.sent[0]), /0 次工具调用/)
  assert.equal(linkOf(noTool.sent[0]), PAGE)

  const stopped = turnHarness({ contribute: true })
  await settled()
  await stopped.output.end(activity([], 'cancelled'))
  assert.equal(stopped.sent.length, 0)
  assert.match(textOf(stopped.streams[0]!.closedWith), /已取消/)
  assert.equal(linkOf(stopped.streams[0]!.closedWith), PAGE)
})

test('a streamed turn that fails without an answer collapses its process card and sends the error as a new message', async () => {
  const { output, streams, sent } = turnHarness({ contribute: true })
  await settled()
  await output.end(activity([tool('bash')], 'error', 'boom'))
  assert.equal(linkOf(streams[0]!.closedWith), PAGE)
  assert.doesNotMatch(textOf(streams[0]!.closedWith), /boom/)
  assert.equal(sent.length, 1)
  assert.match(textOf(sent[0]), /出错：boom/)
  assert.equal(linkOf(sent[0]), undefined)
})

test('a streamed turn that finishes with no answer keeps the collapsed process link card instead of recalling', async () => {
  const { output, streams, sent } = turnHarness({ contribute: true })
  await settled()
  await output.end(activity([tool('im_send_card')], 'done'))
  assert.equal(streams[0]!.aborted, undefined)
  assert.equal(linkOf(streams[0]!.closedWith), PAGE)
  assert.deepEqual(sent, [])
})

test('an inline card in a streamed turn is adopted onto the newly sent result handle without repeating the link', async () => {
  const adopted: { handle: MessageHandle; slotted: Node }[] = []
  const fakeCards: TurnCards = {
    count: 1,
    render: () => [h('text', { content: '[card]' })],
    slot: index => h('text', { content: `[slot:${index}]` }),
    attach: () => {},
    settle: async () => {},
    dispose: () => {},
    adopt: async (handle, slotted) => {
      adopted.push({ handle, slotted: slotted as unknown as Node })
    },
  }
  const source = [
    '下面是结果：',
    '```satori-tsx',
    'export default () => <text>hi</text>',
    '```',
  ].join('\n')
  const { output, streams, sent } = turnHarness({
    contribute: true,
    cards: () => ({ turn: () => fakeCards }),
  })
  await settled()
  await output.end(activity([tool('read_file'), text(source)], 'done'))
  assert.equal(linkOf(streams[0]!.closedWith), PAGE)
  assert.equal(sent.length, 1)
  assert.equal(linkOf(sent[0]), undefined)
  assert.equal(adopted.length, 1)
  assert.equal(adopted[0]!.handle.content, sent[0])
  assert.equal(linkOf(adopted[0]!.slotted), undefined)
  assert.match(textOf(adopted[0]!.slotted), /\[slot:0\]/)
})

test('a deployment whose plugins contribute nothing publishes no link', async () => {
  const { output, streams } = turnHarness()
  await settled()
  await output.end(activity([text('完成')], 'done'))
  assert.equal(linkOf(streams[0]!.updates[0]), undefined)
  assert.equal(linkOf(streams[0]!.closedWith), undefined)
})

test('a turn that produced nothing posts nothing and is recalled', async () => {
  const { output, streams, sent } = turnHarness()
  await settled()
  await output.end(activity([], 'done'))
  assert.deepEqual(streams[0]!.aborted, { recall: true, reason: 'nothing to show' })
  assert.deepEqual(sent, [])
})

test('a cancelled turn closes with its footer', async () => {
  const { output, streams } = turnHarness()
  await settled()
  await output.end(activity([], 'cancelled'))
  assert.match(textOf(streams[0]!.closedWith), /已取消/)
})

test('a turn stopped from its own card names whoever pressed stop', async () => {
  const { renderer, output, streams } = turnHarness()
  await settled()
  renderer.stoppedBy({ id: `dsh:stop:${SESSION}`, user: { id: 'ou_9', name: '张三' } })
  await output.end(activity([], 'cancelled'))
  const mention = nodesOf(streams[0]!.closedWith).find(entry => entry.type === 'at')
  assert.deepEqual(mention?.attrs, { type: 'user', id: 'ou_9', name: '张三' })
  assert.match(textOf(streams[0]!.closedWith), /已由 /)
  assert.match(textOf(streams[0]!.closedWith), / 取消/)
})

test('a click that is not this turn\'s stop control attributes nothing', async () => {
  const { renderer, output, streams } = turnHarness()
  await settled()
  renderer.stoppedBy({ id: 'dsh:stop:im-other', user: { id: 'ou_9', name: '张三' } })
  renderer.stoppedBy({ id: 'card:approve', user: { id: 'ou_9', name: '张三' } })
  await output.end(activity([], 'cancelled'))
  assert.equal(nodesOf(streams[0]!.closedWith).some(entry => entry.type === 'at'), false)
  assert.match(textOf(streams[0]!.closedWith), /已取消/)
})

test('dsh:auth-stop button blocks unauthorized clicks with toast and allows authorized owner to stop', async () => {
  const listeners = new Map<string, ((...args: any[]) => any)[]>()
  const stoppedSessions: string[] = []
  let registeredRenderer: any

  const ctx: any = {
    logger: { info() {}, warn() {}, error() {} },
    get: (name: string) => name === 'imAuth'
      ? { canInteract: (_sid: string, uid: string) => uid === 'ou_owner' }
      : undefined,
    im: {
      outputs: { register: (r: any) => { registeredRenderer = r; return () => {} } },
      sessions: {
        get: (id: string) => id === SESSION
          ? { sessionId: SESSION, bindings: [{ chat: CHAT, writable: true }] }
          : undefined,
        stop: async (id: string) => { stoppedSessions.push(id) },
      },
    },
    on: (name: string, fn: any) => {
      const list = listeners.get(name) ?? []
      list.push(fn)
      listeners.set(name, list)
      return () => {}
    },
    inject: () => () => {},
    effect: (fn: () => any) => { fn(); return () => {} },
    waterfall: (_name: string, _msg: any, next: () => any) => next(),
  }

  applySummary(ctx, config())
  assert.ok(registeredRenderer)

  const streams: any[] = []
  const io: ImOutputIO = {
    chat: CHAT,
    stream: async () => {
      const updates: any[] = []
      const s = {
        strategy: 'edit' as const,
        updates,
        closedWith: undefined as any,
        update(content: any) { updates.push(content) },
        async close(content: any) { s.closedWith = content; return { handle: { parts: [{ id: 'om_1' }] } } },
        async abort() { return true },
      }
      streams.push(s)
      return s as any
    },
    send: async () => ({} as any),
  }

  const output = registeredRenderer.begin(activity([]), io)
  await settled()
  const buttons = nodesOf(streams[0].updates[0]).filter(n => n.type === 'button')
  assert.equal(buttons[0]?.attrs.id, `${AUTH_STOP_BUTTON_PREFIX}${SESSION}`)

  const toasts: any[] = []
  for (const fn of listeners.get('im/button') ?? []) {
    await fn({
      id: `${AUTH_STOP_BUTTON_PREFIX}${SESSION}`,
      chat: { key: CHAT },
      user: { id: 'ou_other', name: '路人' },
      raw: { respond: async (p: any) => { toasts.push(p) } },
    })
  }
  assert.equal(stoppedSessions.length, 0)
  assert.equal(toasts[0]?.toast?.type, 'warning')

  for (const fn of listeners.get('im/button') ?? []) {
    await fn({
      id: `${AUTH_STOP_BUTTON_PREFIX}${SESSION}`,
      chat: { key: CHAT },
      user: { id: 'ou_owner', name: '独占者' },
      raw: { respond: async () => {} },
    })
  }
  assert.deepEqual(stoppedSessions, [SESSION])
  await output.end(activity([], 'cancelled'))
  const mention = nodesOf(streams[0].closedWith).find(entry => entry.type === 'at')
  assert.deepEqual(mention?.attrs, { type: 'user', id: 'ou_owner', name: '独占者' })
})

test('summary:stop and legacy dsh:stop clicks stop a session bound to the button\'s chat; failures are only logged', async () => {
  const listeners = new Map<string, ((...args: any[]) => any)[]>()
  const stopped: string[] = []
  const warnings: unknown[][] = []
  let registeredRenderer: any
  let failStop = false
  const ctx: any = {
    logger: { info() {}, warn(...args: unknown[]) { warnings.push(args) }, error() {} },
    get: () => undefined,
    im: {
      outputs: { register: (r: any) => { registeredRenderer = r; return () => {} } },
      sessions: {
        get: (id: string) => id === SESSION
          ? { sessionId: SESSION, bindings: [{ chat: CHAT, writable: true }] }
          : undefined,
        stop: async (id: string) => {
          if (failStop) throw new Error('boom')
          stopped.push(id)
        },
      },
    },
    on: (name: string, fn: any) => {
      listeners.set(name, [...listeners.get(name) ?? [], fn])
      return () => {}
    },
    inject: () => () => {},
    effect: (fn: () => any) => { fn(); return () => {} },
    waterfall: (_name: string, _msg: any, next: () => any) => next(),
  }
  applySummary(ctx, config())
  const click = async (id: string, chat: string = CHAT) => {
    for (const fn of listeners.get('im/button') ?? []) {
      await fn({ id, chat: { key: chat }, user: { id: 'ou_1', name: '甲' } })
    }
    await settled()
  }

  // The renderer's own button carries the plugin prefix.
  const streams: any[] = []
  const io: ImOutputIO = {
    chat: CHAT,
    stream: async () => {
      const s = {
        strategy: 'edit' as const, updates: [] as any[], closedWith: undefined as any,
        update(content: any) { s.updates.push(content) },
        async close(content: any) { s.closedWith = content; return { handle: { parts: [{ id: 'om_1' }] } } },
        async abort() { return true },
      }
      streams.push(s)
      return s as any
    },
    send: async () => ({} as any),
  }
  const output = registeredRenderer.begin(activity([]), io)
  await settled()
  const buttons = nodesOf(streams[0].updates[0]).filter(n => n.type === 'button')
  assert.equal(buttons[0]?.attrs.id, `${STOP_BUTTON_PREFIX}${SESSION}`)
  assert.equal(STOP_BUTTON_PREFIX, 'summary:stop:')

  await click(`${STOP_BUTTON_PREFIX}${SESSION}`, 'lark:other-chat')
  await click(`${STOP_BUTTON_PREFIX}im-unknown`)
  await click('card:approve')
  assert.deepEqual(stopped, [])

  await click(`${STOP_BUTTON_PREFIX}${SESSION}`)
  await click(`${LEGACY_STOP_BUTTON_PREFIX}${SESSION}`)
  assert.deepEqual(stopped, [SESSION, SESSION])

  failStop = true
  await click(`${STOP_BUTTON_PREFIX}${SESSION}`)
  assert.equal(warnings.length, 1)
  assert.match(String(warnings[0]![0]), /could not stop/)

  await output.end(activity([], 'cancelled'))
  const mention = nodesOf(streams[0].closedWith).find(entry => entry.type === 'at')
  assert.deepEqual(mention?.attrs, { type: 'user', id: 'ou_1', name: '甲' })
})