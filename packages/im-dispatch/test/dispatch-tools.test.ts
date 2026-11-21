/**
 * The dispatch tools: registration per role list, the declared values each side sees (checked against each tool's
 * output schema), argument validation, refused operations as declared values, and the role gate.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { TOOL_NAMES } from '../src/index.ts'
import { compileParameters, validate } from '../src/schema.ts'
import { CHAT_KEY, FakeTools, OTHER_KEY, boot, quiet, type Harness } from './dispatch-fakes.ts'

const value = FakeTools.value

/** Admit a few messages into one chat. */
async function conversation(harness: Harness): Promise<string[]> {
  const texts = ['the request', 'some context', 'more context', 'the last word']
  for (const [index, text] of texts.entries()) await harness.receive(text, index === 0 ? {} : quiet())
  return texts
}

test('the tools the operator listed for either role are registered', () => {
  assert.deepEqual([...boot().tools.tools.keys()].sort(), [...TOOL_NAMES].sort())
  assert.deepEqual([...boot({ tools: { main: ['list_tasks'], worker: ['im_search'] } }).tools.tools.keys()].sort(),
    ['im_search', 'list_tasks'])
  assert.deepEqual([...boot({ tools: { main: [], worker: [] } }).tools.tools.keys()], [])
  const tools = boot().tools.tools
  assert.equal(tools.get('list_tasks')?.isConcurrencySafe?.({}), true)
  assert.equal(tools.get('list_route_rules')?.isConcurrencySafe?.({}), true)
  assert.equal(tools.get('query_chronicle')?.isConcurrencySafe?.({ question: '发版进展？' }), true)
  assert.equal(tools.get('query_chronicle')?.isConcurrencySafe?.({}), false)
  assert.equal(tools.get('list_tasks')?.isConcurrencySafe?.({ extra: 1 }), false)
})

test('the compiled parameters are the raw JSON Schema the registry takes', () => {
  const create = boot().tools.tools.get('create_task')!
  assert.deepEqual(create.parameters.required, ['title'])
  assert.deepEqual((create.parameters.properties as Record<string, unknown>).range, {
    type: 'object',
    description: 'A contiguous run of that chat, both ends included, instead of listing many references.',
    additionalProperties: false,
    properties: {
      from: { type: 'string', description: 'First message of the run.' },
      to: { type: 'string', description: 'Last message of the run.' },
    },
    required: ['from', 'to'],
  })
  const schema = compileParameters({ n: { type: 'integer', required: true }, tags: { type: 'array', items: { type: 'string' } } })
  assert.deepEqual(validate(schema, { n: 1, tags: ['a'] }), [])
  assert.deepEqual(validate(schema, { n: 1.5, tags: [2], x: true }), [
    'value.n must be integer', 'value.tags[0] must be string', 'value.x is not allowed',
  ])
  assert.deepEqual(validate(schema, {}), ['value.n is required'])
})

test('create_task starts a task from the message a request names, with the messages around it', async () => {
  const harness = boot()
  await conversation(harness)
  const main = harness.agent(harness.router().sessionId)
  const started = value(await harness.tools.call('create_task', { title: 'Read them', messages: ['#2'] }, main, 'start-one'))
  assert.deepEqual(started, { id: 1, title: 'Read them', chat: CHAT_KEY, updatedAt: 1 })
  const input = harness.im.texts('task:1').join('\n')
  for (const text of ['the request', 'some context', 'more context', 'the last word']) assert.match(input, new RegExp(text))
  assert.equal(harness.tasks.starts[0]?.placement?.trigger?.seq, 2)

  // The same call replays the start.
  assert.deepEqual(value(await harness.tools.call('create_task', { title: 'Read them', messages: ['#2'] }, main, 'start-one')), started)
  assert.deepEqual(value(await harness.tools.call('list_tasks', {}, main)), { tasks: [started] })
})

test('create_task reads a range, a platform id and a full message key, and honours the context bound', async () => {
  const harness = boot({ contextMessages: 0 })
  const spoken = await conversation(harness)
  const main = harness.agent(harness.router().sessionId)
  assert.equal(value(await harness.tools.call('create_task', { title: 'Range', range: { from: '#1', to: '#3' } }, main)).id, 1)
  const brief = harness.im.texts('task:1').join('\n')
  assert.match(brief, new RegExp(spoken[0]!))
  assert.match(brief, new RegExp(spoken[2]!))
  assert.doesNotMatch(brief, new RegExp(spoken[3]!))

  const byId = harness.im.history.after(CHAT_KEY, 2, 1)[0]!
  value(await harness.tools.call('create_task', { title: 'ById', chat: 'chat', messages: [byId.key.split('|')[1]] }, main))
  assert.equal(harness.tasks.starts[1]?.placement?.trigger, byId)
  const byKey = harness.im.history.after(CHAT_KEY, 3, 1)[0]!
  value(await harness.tools.call('create_task', { title: 'ByKey', messages: [byKey.key] }, main))
  assert.equal(harness.tasks.starts[2]?.placement?.trigger, byKey)
})

test('create_task answers the message that carried the request, not the bot post it quoted', async () => {
  const harness = boot()
  await conversation(harness)
  const main = harness.agent(harness.router().sessionId)
  // An alert webhook posts into the group; a person answers it with an @ and names both messages.
  const alert = harness.im.store('**高频告警折叠** received safety end event before finish event', {
    ...quiet(), sender: { id: 'ou_alert', name: '告警机器人', isBot: true, self: false },
  })
  const request = harness.im.store('@小助手 建一个任务，内容就是排查这个告警', { quote: { key: alert.key } })
  value(await harness.tools.call('create_task', {
    title: '排查 safety end event 告警', messages: [alert.key, request.key],
  }, main, 'start-quoted'))

  // The worker answers the request: its cards name the person who asked, not the webhook that only carried the alert.
  assert.equal(harness.tasks.starts.at(-1)?.placement?.trigger?.key, request.key)
  const brief = harness.im.texts('task:1').join('\n')
  assert.match(brief, /高频告警折叠/)
  assert.match(brief, /建一个任务/)
})

test('a task handoff keeps its context in the trigger thread', async () => {
  const harness = boot({ contextMessages: 2 })
  await conversation(harness)
  harness.im.store('别的线程的闲聊', { thread: { id: 'omt-other' } })
  harness.im.store('主时间线闲聊', {})
  const request = harness.im.store('线程里的请求', { thread: { id: 'omt-mine' } })
  const main = harness.agent(harness.router().sessionId)
  value(await harness.tools.call('create_task', { title: 'Review', messages: [`#${request.seq}`] }, main))
  const brief = harness.im.texts('task:1').join('\n')
  assert.match(brief, /线程里的请求/)
  assert.doesNotMatch(brief, /别的线程的闲聊/)
  assert.doesNotMatch(brief, /主时间线闲聊/)
})

test('a task handoff includes a stored message quoted by the request even outside contextMessages or its thread', async () => {
  const harness = boot({ contextMessages: 1 })
  const rootPost = await harness.receive('很早的根消息内容', quiet({
    sender: { id: 'bot-user', name: 'Bot', isBot: true, self: true },
  }))
  await harness.receive('中间消息 1', quiet())
  await harness.receive('中间消息 2', quiet())
  const request = await harness.receive('只回复这条根消息', {
    thread: { id: 'omt-root' },
    quote: { key: rootPost.key },
  })
  const main = harness.agent(harness.router().sessionId)
  const created = value(await harness.tools.call('create_task', {
    title: 'Quoted root', chat: CHAT_KEY, messages: [`#${request.seq}`],
  }, main))
  assert.equal(created.id, 1)
  const brief = harness.im.texts('task:1').join('\n')
  assert.match(brief, /很早的根消息内容/)
  assert.match(brief, /只回复这条根消息/)
  assert.ok(brief.indexOf('很早的根消息内容') < brief.indexOf('只回复这条根消息'))
})

test('a task handoff naming both a main-timeline root and a thread reply still includes prior messages in that thread', async () => {
  const harness = boot({ contextMessages: 2 })
  await harness.receive('无关的旧消息', quiet())
  const rootPost = await harness.receive('.', {})
  const fileInThread = await harness.receive('[文件 all_126_first_disposal.csv]', quiet({
    thread: { id: 'omt-126' },
    quote: { key: rootPost.key },
  }))
  const request = await harness.receive('@bot 找找这些用户中谁最早被封', {
    thread: { id: 'omt-126' },
    quote: { key: rootPost.key },
  })
  const main = harness.agent(harness.router().sessionId)
  const created = value(await harness.tools.call('create_task', {
    title: 'Thread file', chat: CHAT_KEY, messages: [`#${rootPost.seq}`, `#${request.seq}`],
  }, main))
  assert.equal(created.id, 1)
  const brief = harness.im.texts('task:1').join('\n')
  assert.match(brief, /all_126_first_disposal\.csv/)
  assert.match(brief, /找找这些用户中谁最早被封/)
  assert.ok(brief.indexOf(fileInThread.text) < brief.indexOf(request.text))
})

test('route_messages_to_task delivers named messages to a task, once each', async () => {
  const harness = boot()
  await conversation(harness)
  const main = harness.agent(harness.router().sessionId)
  value(await harness.tools.call('create_task', { title: 'Watch', messages: ['#1'] }, main))
  const last = harness.im.history.after(CHAT_KEY, 3, 1)[0]!
  const routed = value(await harness.tools.call('route_messages_to_task', { id: 1, messages: [{ message: `#${last.seq}` }] }, main))
  assert.deepEqual(routed.messages, [{ seq: last.seq, from: 'User', time: 1000, text: last.text }])
  assert.deepEqual(routed.task, { id: 1, title: 'Watch', chat: CHAT_KEY, updatedAt: 1 })
  const before = harness.im.texts('task:1')
  assert.match(before.join('\n'), /the last word/)
  await harness.tools.call('route_messages_to_task', { id: 1, messages: [{ chat: CHAT_KEY, message: `#${last.seq}` }] }, main)
  assert.deepEqual(harness.im.texts('task:1'), before)
})

test('a refused task operation is a declared value', async () => {
  const harness = boot({ maxTaskMessages: 2 })
  await conversation(harness)
  const main = harness.agent(harness.router().sessionId)
  const call = async (name: string, args: unknown) => value(await harness.tools.call(name, args, main))
  assert.deepEqual(await call('create_task', { title: 'T', chat: 'nowhere', messages: ['#1'] }), {
    status: 'error', code: 'access', message: 'No chat nowhere has reached dispatch; use the chat key of the arriving context.',
  })
  assert.deepEqual(await call('create_task', { title: 'T', messages: ['#99'] }),
    { status: 'error', code: 'access', message: `No message #99 is stored in chat ${CHAT_KEY}.` })
  assert.deepEqual(await call('create_task', { title: 'T', range: { from: '#3', to: '#1' } }),
    { status: 'error', code: 'capacity', message: 'A message range ends before it starts.' })
  assert.deepEqual(await call('create_task', { title: 'T', range: { from: '#1', to: '#4' } }),
    { status: 'error', code: 'capacity', message: 'That range reaches further than 2 messages; name fewer.' })
  assert.deepEqual(await call('create_task', { title: 'T', messages: ['#1', '#2', '#3'] }),
    { status: 'error', code: 'capacity', message: 'Name at most 2 messages in one task start.' })
  assert.deepEqual(await call('route_messages_to_task', { id: 1, messages: [] }),
    { status: 'error', code: 'capacity', message: 'Route at least one message to a task.' })
  assert.deepEqual(await call('route_messages_to_task', { id: 9, messages: [{ message: '#1' }] }),
    { status: 'error', code: 'access', message: 'This session has no task #9.' })

  await harness.receive('elsewhere', quiet({ chatKey: OTHER_KEY }))
  const mismatch = await call('create_task', { title: 'T', chat: OTHER_KEY })
  assert.equal(mismatch.status, 'error')
  assert.match(String(mismatch.message), new RegExp(`is stored in chat ${OTHER_KEY.replace('|', '\\|')}`))

  // A per-chat router knows its home chat even with no live trigger, and still asks which messages to run when none are named.
  harness.im.triggers.clear()
  assert.deepEqual(await call('create_task', { title: 'T', chat: CHAT_KEY }),
    { status: 'error', code: 'capacity', message: 'Name the messages that carry the request, with messages or range.' })
  assert.deepEqual(await call('create_task', { title: 'T' }),
    { status: 'error', code: 'capacity', message: 'Name the messages that carry the request, with messages or range.' })
})

test('the tool of the other side, a caller outside the IM host, and invalid arguments are refused', async () => {
  const harness = boot()
  await conversation(harness)
  const main = harness.agent(harness.router().sessionId)
  value(await harness.tools.call('create_task', { title: 'Watch', messages: ['#1'] }, main))
  const worker = harness.worker(1)
  assert.deepEqual(value(await harness.tools.call('create_task', { title: 'Nested', messages: ['#1'] }, worker)),
    { status: 'error', code: 'access', message: 'Only a chat router starts, steers, and routes tasks.' })
  assert.deepEqual(value(await harness.tools.call('router_reply', { text: 'hi' }, worker)),
    { status: 'error', code: 'access', message: 'Only a chat router starts, steers, and routes tasks.' })
  assert.deepEqual(value(await harness.tools.call('steer_task', { id: 1, text: 'hi' }, worker)),
    { status: 'error', code: 'access', message: 'Only a chat router starts, steers, and routes tasks.' })
  assert.deepEqual(value(await harness.tools.call('list_tasks', {}, worker)),
    { status: 'error', code: 'access', message: 'Only a chat router starts, steers, and routes tasks.' })
  assert.deepEqual(value(await harness.tools.call('list_route_rules', {}, { session: { id: 'nope' } })),
    { status: 'error', code: 'ownership', message: 'Dispatch tools require a session that the IM host serves.' })
  assert.deepEqual(value(await harness.tools.call('list_route_rules', {}, undefined)),
    { status: 'error', code: 'ownership', message: 'Dispatch tools require a session that the IM host serves.' })
  const invalid = await harness.tools.call('add_route_rule', { mode: 'move' }, worker)
  assert.ok('error' in invalid)
  assert.match(invalid.error.message, /invalid arguments: arguments\.mode must be one of "copy", "cut"/)
})

test('route rules and history search work through the tool calls', async () => {
  const harness = boot()
  await conversation(harness)
  const main = harness.agent(harness.router().sessionId)
  value(await harness.tools.call('create_task', { title: 'Watch', messages: ['#1'] }, main))
  const worker = harness.worker(1)
  const rule = { id: 1, task: 1, match: 'im.at_me', mode: 'copy', note: 'Pictures' }
  assert.deepEqual(value(await harness.tools.call('add_route_rule', { match: 'im.at_me', mode: 'copy', note: 'Pictures' }, worker)), rule)
  assert.deepEqual(value(await harness.tools.call('update_route_rule', { id: 1, mode: 'cut' }, worker)), { ...rule, mode: 'cut' })
  const renamed = { ...rule, mode: 'cut', match: 'im.at_me && !im.chat.direct', note: 'Renamed' }
  assert.deepEqual(value(await harness.tools.call('update_route_rule', { id: 1, match: renamed.match, note: 'Renamed' }, worker)), renamed)
  assert.deepEqual(value(await harness.tools.call('list_route_rules', {}, worker)), { rules: [renamed] })
  assert.deepEqual(value(await harness.tools.call('list_route_rules', {}, main)), { rules: [renamed] })
  assert.equal(value(await harness.tools.call('remove_route_rule', { id: 1 }, worker)).id, 1)
  assert.deepEqual(value(await harness.tools.call('list_route_rules', {}, worker)), { rules: [] })

  assert.deepEqual(value(await harness.tools.call('im_search', { match: 'im.at_me', pages: 1 }, worker)),
    { scanned: 4, messages: [{ seq: 1, from: 'User', time: 1000, text: 'the request' }] })
  const page = value(await harness.tools.call('im_search', { match: 'true', pages: 1, chat: CHAT_KEY, cursor: '2' }, worker))
  assert.equal(page.scanned, 1)
  assert.equal(value(await harness.tools.call('add_route_rule', { mode: 'copy' }, worker)).match, 'true')
})

test('router_reply, steer_task, list_tasks profiles, and query_chronicle work end to end', async () => {
  const harness = boot()
  await harness.receive('hello group')
  const main = harness.agent(harness.router().sessionId)

  const reply = value(await harness.tools.call('router_reply', { text: '你好，我在的 🙂' }, main))
  assert.equal(reply.status, 'confirmed')
  assert.equal(harness.im.sent.length, 1)
  assert.match(JSON.stringify(harness.im.sent[0]?.content), /你好，我在的/)

  await harness.receive('@bot 帮忙查发版进度')
  const started = value(await harness.tools.call('create_task', { title: '发版进度', messages: ['#3'] }, main))
  await harness.tasks.describe(started.id ? `im-task:${started.id}` : 'nope', {
    description: '追踪本周五全量发版状态',
    wantedTopics: ['发版'],
    topicScope: 'all',
    followThread: false,
  })
  const listed = value(await harness.tools.call('list_tasks', {}, main)) as { tasks: Array<Record<string, unknown>> }
  assert.equal(listed.tasks[0]?.description, '追踪本周五全量发版状态')
  assert.deepEqual(listed.tasks[0]?.wantedTopics, ['发版'])
  assert.equal(listed.tasks[0]?.topicScope, 'all')
  assert.equal(listed.tasks[0]?.followThread, false)

  // Router from OTHER_KEY steers task #1 across chats.
  await harness.receive('@bot 那发版卡住了吗？', { chatKey: OTHER_KEY })
  const otherRouter = harness.agent(harness.router(OTHER_KEY).sessionId)
  const steered = value(await harness.tools.call('steer_task', { id: 1, text: '另一个群也在问发版进度' }, otherRouter))
  assert.equal(steered.id, 1)
  assert.match(harness.im.texts('task:1').join('\n'), /另一个群也在问发版进度/)

  const chron = value(await harness.tools.call('query_chronicle', { question: '发版' }, otherRouter))
  assert.equal(typeof chron.answer, 'string')
  assert.ok(Number(chron.latestId) >= 1)
})

test('configure_chat persists, updates, clears chat policies, and rejects worker callers', async () => {
  const first = boot()
  await conversation(first)
  const main = first.agent(first.router().sessionId)

  const updated = value(await first.tools.call('configure_chat', {
    wakeMode: 'watch',
    replyMode: 'mention_only',
    watchTopics: ['支付网关 502 告警', ' 支付网关 502 告警 ', 'OOM'],
    watchNote: '看到支付网关报错立即开任务排查',
  }, main))
  assert.deepEqual(updated, {
    chat: CHAT_KEY,
    wakeMode: 'watch',
    replyMode: 'mention_only',
    watchTopics: ['支付网关 502 告警', 'OOM'],
    watchNote: '看到支付网关报错立即开任务排查',
  })

  // Partial update preserves existing watchTopics/watchNote while switching replyMode.
  const proactive = value(await first.tools.call('configure_chat', {
    wakeMode: 'auto',
    replyMode: 'proactive',
    replyPolicy: '讨论 Go 并发 bug 时可以插话提醒',
  }, main))
  assert.equal(proactive.wakeMode, 'auto')
  assert.equal(proactive.replyMode, 'proactive')
  assert.deepEqual(proactive.watchTopics, ['支付网关 502 告警', 'OOM'])
  assert.equal(proactive.replyPolicy, '讨论 Go 并发 bug 时可以插话提醒')

  // Passing [] or "" clears watch fields cleanly.
  const cleared = value(await first.tools.call('configure_chat', {
    wakeMode: 'mention',
    replyMode: 'mention_only',
    watchTopics: [],
    watchNote: '',
    replyPolicy: '',
  }, main))
  assert.deepEqual(cleared, {
    chat: CHAT_KEY,
    wakeMode: 'mention',
    replyMode: 'mention_only',
    watchTopics: [],
  })

  value(await first.tools.call('create_task', { title: 'Worker Caller Check', messages: ['#1'] }, main))
  const worker = first.worker(1)
  assert.deepEqual(value(await first.tools.call('configure_chat', { wakeMode: 'auto' }, worker)), {
    status: 'error', code: 'access', message: 'Only a chat router starts, steers, and routes tasks.',
  })
  await first.host.dispose()

  // Restart retains persisted chat config from `im_rules.chats`.
  const second = boot({}, first.storage.media)
  const configs = await second.host.panelChatConfigs()
  assert.deepEqual(configs, [{ chat: CHAT_KEY, wakeMode: 'mention', replyMode: 'mention_only', watchTopics: [] }])
  await second.host.dispose()
})

test('an unexpected failure is left to the tool runtime', async () => {
  const harness = boot()
  await conversation(harness)
  harness.im.failFormat = new Error('network down')
  const result = await harness.tools.call('create_task', { title: 'T', messages: ['#1'] }, harness.agent(harness.router().sessionId))
  assert.ok('error' in result)
  assert.match(result.error.message, /network down/)
})

test('a strategy that never saw traffic disposes cleanly', async () => {
  const harness = boot()
  await harness.host.dispose()
  assert.equal(harness.host.dispatcher, undefined)
})
