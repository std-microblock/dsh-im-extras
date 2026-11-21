/**
 * Dispatch routing strategy tests:
 * - per-chat & per-topic read-only routers with cursor-based full-context deltas & `/clear` resets
 * - QuickJS route rules (`copy` / `cut`)
 * - hybrid automatic thread follow-up (`followThread`, auto-threading, dynamic `omt_` thread learning)
 * - cross-chat worker continuity & read+thread-write grants
 * - 5-step router guardrail (`agent/pre-step`) & ACL exclusivity
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DISPATCHER_CHAT_PREFIX, DISPATCHER_TOPIC_PREFIX, DispatchHost,
} from '../src/index.ts'
import { splitKey } from '../src/im.ts'
import type { PreStepDecisionLike } from '../src/types.ts'
import { BOT, CHAT_KEY, COMPOSITION, OTHER_KEY, boot, quiet, type Harness } from './dispatch-fakes.ts'

const signal = () => new AbortController().signal

async function watching(
  harness: Harness,
  msgRef = '#1',
): Promise<{ main: ReturnType<Harness['agent']>; worker: ReturnType<Harness['agent']>; session: string }> {
  const main = harness.agent(harness.router().sessionId)
  const task = await harness.host.startTask(main, { title: 'Watch', messages: [msgRef] }, `watch-${msgRef}`)
  return { main, worker: harness.worker(task.id), session: task.session }
}

function all(harness: Harness, session: string): string {
  return harness.im.texts(session).join('\n')
}

function grants(harness: Harness, session: string): [string, boolean, string | undefined][] {
  return (harness.im.sessions.get(session)?.bindings ?? []).map(binding => [binding.chat, binding.writable, binding.thread])
}

test('per-chat read-only routers isolate chats and retain seen chats across restarts', async () => {
  const first = boot()
  const msg1 = await first.receive('first message')
  const router1 = first.router(CHAT_KEY)
  assert.equal(router1.key, `${DISPATCHER_CHAT_PREFIX}${CHAT_KEY}`)
  assert.equal(router1.owner, 'dispatch')
  assert.equal(router1.output, 'none')
  assert.deepEqual(router1.bindings, [{ chat: CHAT_KEY, writable: false, home: true }])
  assert.deepEqual(first.outcomes.get(msg1.key), { kind: 'handled', by: 'dispatch', sessions: [router1.sessionId] })
  assert.match(all(first, router1.sessionId), new RegExp(`<im-chat key="${CHAT_KEY.replace('|', '\\|')}"`))
  assert.match(all(first, router1.sessionId), /first message/)
  assert.equal(first.im.logs.get(router1.sessionId)?.[0]?.delivery.mode, 'steer')

  const quietMsg = await first.receive('just chatting', quiet({ chatKey: OTHER_KEY }))
  assert.deepEqual(first.outcomes.get(quietMsg.key), { kind: 'ignored' })
  assert.deepEqual(first.router(OTHER_KEY).bindings, [{ chat: OTHER_KEY, writable: false, home: true }])
  assert.deepEqual(first.im.texts(first.router(OTHER_KEY).sessionId), [])
  await first.host.dispose()

  const restarted = boot({}, first.storage.media)
  // `boot()` opens routers lazily on `opened`; a quiet receive waits for `opened` and confirms pre-loaded bindings.
  const quietRestart = await restarted.receive('just chatting', quiet({ chatKey: OTHER_KEY }))
  assert.deepEqual(restarted.outcomes.get(quietRestart.key), { kind: 'ignored' })
  assert.deepEqual(restarted.router(CHAT_KEY).bindings, [{ chat: CHAT_KEY, writable: false, home: true }])
  assert.deepEqual(restarted.router(OTHER_KEY).bindings, [{ chat: OTHER_KEY, writable: false, home: true }])
  const wakeOther = await restarted.receive('wake other chat', { chatKey: OTHER_KEY })
  assert.match(all(restarted, restarted.router(OTHER_KEY).sessionId), /just chatting[\s\S]*wake other chat/)
  assert.equal(wakeOther.chat.key, OTHER_KEY)
  assert.equal(restarted.storage.media.get('im_rules')?.tables.get('chats')?.size, 2)
  await restarted.host.dispose()
})

test('per-chat full-context delta includes unaddressed chatter and resets cleanly on onSessionReset', async () => {
  const harness = boot({ freshContextMessages: 2 })
  await harness.receive('历史0', quiet())
  await harness.receive('历史1', quiet())
  await harness.receive('历史2', quiet())
  await harness.receive('@bot 每次发版帮我发一个卡片')
  const { main, session } = await watching(harness, '#4')
  await harness.tasks.describe(session, {
    description: 'release 每次发版卡片生成',
    wantedTopics: ['发版卡片'],
    topicScope: 'chat',
  })

  const routerId = harness.router().sessionId
  const wake1 = all(harness, routerId)
  // Initial wake only backfilled 2 prior messages (`历史1`, `历史2`), skipping `历史0`.
  assert.doesNotMatch(wake1, /历史0/)
  assert.match(wake1, /历史1[\s\S]*历史2[\s\S]*每次发版帮我发一个卡片/)

  // Unaddressed group discussion happens before another @bot request (distinct feature request).
  await harness.receive('群友A：顺便觉得应该支持自定义快捷键', quiet({ sender: { id: 'u2', name: '群友A', self: false } }))
  await harness.receive('群友B：+1 快捷键很好用', quiet({ sender: { id: 'u3', name: '群友B', self: false } }))
  // Ephemeral working stub must NOT pollute router context delta.
  harness.im.store('🔗 查看工作过程', quiet({ sender: { id: 'bot-user', name: 'Bot', isBot: true, self: true } }))
  await harness.receive('@bot 帮我实现群友提的功能')

  const deliveries = harness.im.logs.get(routerId)!
  const wake2Text = deliveries[deliveries.length - 1]!.text
  assert.match(wake2Text, /支持自定义快捷键/)
  assert.match(wake2Text, /帮我实现群友提的功能/)
  assert.doesNotMatch(wake2Text, /查看工作过程/)
  assert.match(wake2Text, /<tasks-delta>[\s\S]*change="new"[\s\S]*release 每次发版卡片生成[\s\S]*发版卡片/)
  assert.ok(main.session.id === routerId)

  // `/clear` resets message & task cursors so next wake backfills freshContextMessages (2) and <tasks-snapshot>.
  const freshRecord = await harness.im.sessions.ensure({
    key: harness.router().key,
    owner: 'dispatch',
    composition: COMPOSITION,
    bindings: harness.router().bindings,
  })
  await harness.host.onSessionReset(freshRecord)
  await harness.receive('@bot 清空后再来一句')
  const wake3Text = harness.im.logs.get(routerId)!.at(-1)!.text
  assert.match(wake3Text, /帮我实现群友提的功能[\s\S]*清空后再来一句/)
  assert.match(wake3Text, /<tasks-snapshot>[\s\S]*release 每次发版卡片生成/)
})

test('topic-mode chats isolate router sessions and cursors per thread', async () => {
  const harness = boot()
  const topicChat = { key: `${BOT}|topic-grp`, bot: BOT, ref: { id: 'topic-grp', type: 'topic' }, source: 'team' }
  await harness.receive('topic A quiet', quiet({ chatKey: topicChat.key, chat: topicChat, thread: { id: 'th-A' } }))
  await harness.receive('topic B quiet', quiet({ chatKey: topicChat.key, chat: topicChat, thread: { id: 'th-B' } }))
  await harness.receive('@bot ask A', { chatKey: topicChat.key, chat: topicChat, thread: { id: 'th-A' } })
  await harness.receive('@bot ask B', { chatKey: topicChat.key, chat: topicChat, thread: { id: 'th-B' } })

  const routerA = harness.router(topicChat.key, 'th-A')
  const routerB = harness.router(topicChat.key, 'th-B')
  assert.equal(routerA.key, `${DISPATCHER_TOPIC_PREFIX}${topicChat.key}:th-A`)
  assert.equal(routerB.key, `${DISPATCHER_TOPIC_PREFIX}${topicChat.key}:th-B`)
  assert.match(all(harness, routerA.sessionId), /topic A quiet[\s\S]*ask A/)
  assert.doesNotMatch(all(harness, routerA.sessionId), /topic B quiet/)
  assert.match(all(harness, routerB.sessionId), /topic B quiet[\s\S]*ask B/)
  assert.doesNotMatch(all(harness, routerB.sessionId), /topic A quiet/)
})

test('invalid composition fails loudly', () => {
  const harness = boot()
  assert.throws(() => new DispatchHost({
    im: harness.im, tasks: harness.tasks, storage: harness.storage, logger: harness.logger,
    config: { ...harness.config, worker: { ...COMPOSITION, cwd: 'relative/path' } },
  }), /absolute cwd/)
})

test('autoThread confines group tasks (not on threadless platforms) and learns platform thread ids', async () => {
  const harness = boot({ autoThread: true })
  const request = await harness.receive('open a main-timeline task')
  const rootMsgId = splitKey(request.key).id
  const main = harness.agent(harness.router().sessionId)
  const task = await harness.host.startTask(main, { title: 'AutoThreaded' }, 'call-1')
  assert.deepEqual(harness.tasks.starts[0]?.placement, {
    bindings: [{ chat: CHAT_KEY, writable: true, home: true, thread: rootMsgId }],
    trigger: request,
  })
  assert.equal(harness.im.triggers.get(task.session), request)
  assert.equal(task.chat, CHAT_KEY)
  // Idempotent replay.
  assert.equal((await harness.host.startTask(main, { title: 'AutoThreaded' }, 'call-1')).id, task.id)
  assert.equal(harness.tasks.starts.length, 1)

  // Bot reply creates a platform thread `omt_1` with `root = rootMsgId`: host dynamically learns `omt_1`.
  harness.im.store('初版完成', quiet({
    sender: { id: 'bot-user', name: 'Bot', isBot: true, self: true },
    thread: { id: 'omt_1', root: rootMsgId },
    quote: { key: request.key },
  }))
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(grants(harness, task.session), [
    [CHAT_KEY, true, rootMsgId],
    [CHAT_KEY, true, 'omt_1'],
  ])

  // By default (followThread not enabled), unaddressed follow-up inside `omt_1` is ignored.
  const ignoredFollow = await harness.receive('未开启跟贴时的消息', quiet({ thread: { id: 'omt_1', root: rootMsgId } }))
  assert.deepEqual(harness.outcomes.get(ignoredFollow.key), { kind: 'ignored' })

  // Opting into `followThread: true` delivers unaddressed follow-ups inside `omt_1` without needing a QuickJS rule.
  await harness.tasks.describe(task.session, { followThread: true })
  const follow = await harness.receive('把按钮颜色改绿', quiet({ thread: { id: 'omt_1', root: rootMsgId } }))
  assert.deepEqual(harness.outcomes.get(follow.key), { kind: 'handled', by: 'dispatch', sessions: [task.session] })
  assert.equal(harness.host.deliveryCause(task.session, follow.key)?.kind, 'thread')
  assert.match(all(harness, task.session), /把按钮颜色改绿/)
  assert.doesNotMatch(all(harness, harness.router().sessionId), /把按钮颜色改绿/)

  // `@bot` inside `omt_1` goes through the chat router with `<thread-context>` instead of bypassing it.
  await harness.receive('@bot 顺便帮我查一下别的问题', { thread: { id: 'omt_1', root: rootMsgId } })
  const latestRouterWake = harness.im.logs.get(harness.router().sessionId)!.at(-1)!.text
  assert.match(latestRouterWake, /<thread-context task="#1" title="AutoThreaded"/)

  // Disabling `followThread` stops Tier-2 automatic unaddressed delivery.
  await harness.tasks.describe(task.session, { followThread: false })
  const afterClose = await harness.receive('无关闲聊', quiet({ thread: { id: 'omt_1', root: rootMsgId } }))
  assert.deepEqual(harness.outcomes.get(afterClose.key), { kind: 'ignored' })
  assert.doesNotMatch(all(harness, task.session), /无关闲聊/)

  // Direct chats and groups of a threadless platform (`qq` is in the default `threadlessPlatforms`) do NOT auto-thread.
  const dm = await harness.receive('@bot dm question', {
    chatKey: `${BOT}|dm1`,
    chat: { key: `${BOT}|dm1`, bot: BOT, ref: { id: 'dm1', type: 'direct' }, source: 'team' },
  })
  const dmTask = await harness.host.startTask(harness.agent(harness.router(`${BOT}|dm1`).sessionId), {
    title: 'DM', messages: [dm.key],
  }, 'dm-1')
  assert.deepEqual(grants(harness, dmTask.session), [[`${BOT}|dm1`, true, undefined]])

  const qqBot = 'qq:10001'
  const qqChatKey = `${qqBot}|grp9`
  const qqMsg = await harness.receive('@bot qq question', {
    key: `${qqBot}|qm1`,
    chatKey: qqChatKey,
    chat: { key: qqChatKey, bot: qqBot, ref: { id: 'grp9', type: 'group' }, source: 'team' },
  })
  const qqTask = await harness.host.startTask(harness.agent(harness.router(qqChatKey).sessionId), {
    title: 'QQ', messages: [qqMsg.key],
  }, 'qq-1')
  assert.deepEqual(grants(harness, qqTask.session), [[qqChatKey, true, undefined]])
})

test('explicit QuickJS route rules deliver copies or cut messages from router', async () => {
  const harness = boot({ autoThread: false })
  await harness.receive('watch alice')
  const { main, worker, session } = await watching(harness)
  const routerId = harness.router().sessionId
  assert.deepEqual(await harness.host.addRule(worker, { match: 'im.sender.id === \'user-1\'', mode: 'copy', note: 'Alice asked' }),
    { id: 1, task: 1, match: 'im.sender.id === \'user-1\'', mode: 'copy', note: 'Alice asked' })
  assert.match(all(harness, routerId), /Task #1 \(Watch\) added route rule #1 \(copy\)/)

  const muted = await harness.receive('a muted message', quiet())
  const loud = await harness.receive('a loud message')
  await harness.receive('a stranger speaks', quiet({ sender: { id: 'user-2', name: 'Bob', self: false } }))
  await harness.receive('another chat', quiet({ chatKey: OTHER_KEY }))
  const taskTexts = all(harness, session)
  assert.match(taskTexts, /a muted message/)
  assert.match(taskTexts, /a loud message/)
  assert.doesNotMatch(taskTexts, /a stranger speaks/)
  assert.doesNotMatch(taskTexts, /another chat/)
  assert.deepEqual(harness.outcomes.get(muted.key), { kind: 'handled', by: 'dispatch', sessions: [session] })
  assert.deepEqual(harness.outcomes.get(loud.key), { kind: 'handled', by: 'dispatch', sessions: [routerId, session] })
  assert.equal(harness.im.triggers.get(session), loud)

  assert.equal((await harness.host.updateRule(worker, 1, { mode: 'cut' })).mode, 'cut')
  await harness.receive('a cut message')
  assert.match(all(harness, session), /a cut message/)
  assert.doesNotMatch(all(harness, routerId), /a cut message/)

  await harness.tasks.note(session, 'Watched.')
  const rules = await harness.host.listRules(main)
  assert.equal(rules[0]?.note, 'Alice asked')
})

test('cross-chat routeToTask grants full-chat read plus thread-confined write on autoThread groups', async () => {
  const harness = boot({ autoThread: true })
  await harness.receive('open a task', { thread: { id: 'th-1' } })
  const { session } = await watching(harness)
  assert.deepEqual(grants(harness, session), [[CHAT_KEY, true, 'th-1']])

  // Wake router in OTHER_KEY and route unthreaded OTHER_KEY message to Task #1.
  await harness.receive('@bot check OTHER_KEY', { chatKey: OTHER_KEY })
  const elsewhere = await harness.receive('a question elsewhere', quiet({ chatKey: OTHER_KEY }))
  const otherRouter = harness.agent(harness.router(OTHER_KEY).sessionId)
  const routed = await harness.host.routeToTask(otherRouter, 1, [{ chat: OTHER_KEY, message: `#${elsewhere.seq}` }])
  assert.deepEqual(routed.messages, [elsewhere])
  const elsewhereMsgId = splitKey(elsewhere.key).id
  assert.deepEqual(grants(harness, session), [
    [CHAT_KEY, true, 'th-1'],
    [OTHER_KEY, false, undefined],
    [OTHER_KEY, true, elsewhereMsgId],
  ])
  assert.equal(harness.im.triggers.get(session), elsewhere)
})

test('autoThread:false preserves open writable chat grants when routing across chats', async () => {
  const harness = boot({ autoThread: false })
  await harness.receive('open a task', { thread: { id: 'th-1' } })
  const { main, session } = await watching(harness)
  const elsewhere = await harness.receive('a question elsewhere', quiet({ chatKey: OTHER_KEY }))
  await harness.host.routeToTask(main, 1, [{ chat: OTHER_KEY, message: `#${elsewhere.seq}` }])
  assert.deepEqual(grants(harness, session), [[CHAT_KEY, true, 'th-1'], [OTHER_KEY, true, undefined]])
})

test('a routed message makes a read-only prebound thread writable keeping its thread', async () => {
  const harness = boot()
  await harness.receive('open a task')
  const { main, session } = await watching(harness)
  await harness.im.sessions.bind(session, [
    { chat: CHAT_KEY, writable: true, home: true },
    { chat: OTHER_KEY, writable: false, thread: 'th-9' },
  ])
  const watched = await harness.receive('a watched thread speaks', quiet({ chatKey: OTHER_KEY, thread: { id: 'th-9' } }))
  await harness.host.routeToTask(main, 1, [{ chat: OTHER_KEY, message: `#${watched.seq}` }])
  assert.deepEqual(grants(harness, session), [[CHAT_KEY, true, undefined], [OTHER_KEY, true, 'th-9']])
})

test('5-step router guardrail warns on maxRouterSteps, forces wrap-up at +1, and rejects further steps', async () => {
  const harness = boot({ maxRouterSteps: 5 })
  await harness.receive('@bot hello')
  const routerAgent = harness.agent(harness.router().sessionId)
  const worker = (await watching(harness)).worker
  const baseMsg = { role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }
  const passNext = (): Promise<PreStepDecisionLike> => Promise.resolve({ kind: 'enter', messages: [baseMsg] })

  // Steps 1-4 pass untouched.
  for (let s = 1; s <= 4; s++) {
    const res = await harness.host.beforeStep({ agent: routerAgent, messages: [baseMsg], turn: 1, step: s, signal: signal() }, passNext)
    assert.equal(res.kind, 'enter')
    if (res.kind === 'enter') assert.equal(res.messages.length, 1)
  }

  // Step 5 appends soft warning.
  const step5 = await harness.host.beforeStep({ agent: routerAgent, messages: [baseMsg], turn: 1, step: 5, signal: signal() }, passNext)
  assert.equal(step5.kind, 'enter')
  if (step5.kind === 'enter') {
    assert.equal(step5.messages.length, 2)
    assert.match(String(step5.messages[1]?.content[0]?.text), /第 5\/5 步/)
  }

  // Step 6 appends hard wrap-up order.
  const step6 = await harness.host.beforeStep({ agent: routerAgent, messages: [baseMsg], turn: 1, step: 6, signal: signal() }, passNext)
  assert.equal(step6.kind, 'enter')
  if (step6.kind === 'enter') {
    assert.match(String(step6.messages[1]?.content[0]?.text), /硬上限 6/)
  }

  // Step 7 rejects to prevent infinite loops.
  const step7 = await harness.host.beforeStep({ agent: routerAgent, messages: [baseMsg], turn: 1, step: 7, signal: signal() }, passNext)
  assert.deepEqual(step7, { kind: 'reject' })

  // A new turn resets step count, and workers are never constrained by router guardrails.
  const turn2 = await harness.host.beforeStep({ agent: routerAgent, messages: [baseMsg], turn: 2, step: 1, signal: signal() }, passNext)
  assert.equal(turn2.kind, 'enter')
  if (turn2.kind === 'enter') assert.equal(turn2.messages.length, 1)

  const workerStep = await harness.host.beforeStep({ agent: worker, messages: [baseMsg], turn: 1, step: 99, signal: signal() }, passNext)
  assert.equal(workerStep.kind, 'enter')
  if (workerStep.kind === 'enter') assert.equal(workerStep.messages.length, 1)
})

test('rules are validated, bounded per task, and report their evaluation failures', async () => {
  const harness = boot({ maxRulesPerTask: 3, ruleTimeoutMs: 500 })
  await harness.receive('watch')
  const { main, worker } = await watching(harness)
  await assert.rejects(harness.host.addRule(worker, { match: 'im.content.includes(', mode: 'copy' }), /does not compile: SyntaxError/)
  await assert.rejects(harness.host.addRule(worker, { match: '  ', mode: 'copy' }), /must not be empty/)
  await assert.rejects(harness.host.addRule(worker, { match: 'x'.repeat(2001), mode: 'copy' }), /exceeds 2000 characters/)
  await assert.rejects(harness.host.addRule(worker, { mode: 'copy', note: 'n'.repeat(2001) }), /note exceeds/)
  await assert.rejects(harness.host.addRule(main, { mode: 'copy' }), /Only a worker of a dispatch task/)
  await harness.host.addRule(worker, { match: 'im.thread_id.length > 0', mode: 'copy' })
  await harness.host.addRule(worker, { match: '(() => { while (true) {} })()', mode: 'cut', note: '   ' })
  await harness.host.addRule(worker, { mode: 'copy' })
  await assert.rejects(harness.host.addRule(worker, { mode: 'copy' }), /already holds 3 route rules/)

  await harness.receive('a message for every rule', quiet())
  const rules = await harness.host.listRules(worker)
  assert.deepEqual(rules.map(rule => [rule.id, rule.errors, rule.lastError?.split(':')[0]]),
    [[1, 1, 'TypeError'], [2, 1, 'InternalError'], [3, undefined, undefined]])
  assert.equal('note' in rules[1]!, false)
  assert.equal(rules[2]?.match, 'true')
  assert.deepEqual(await harness.host.updateRule(worker, 1, { match: 'im.thread_id === null', note: 'Plain messages' }),
    { id: 1, task: 1, match: 'im.thread_id === null', mode: 'copy', note: 'Plain messages' })
  assert.equal((await harness.host.listRules(worker))[0]?.errors, undefined)
  await assert.rejects(harness.host.updateRule(worker, 9, { mode: 'cut' }), /holds no route rule #9/)
})

test('routers oversee every rule across tasks and either side removes one', async () => {
  const harness = boot()
  await harness.receive('watch')
  const { main, worker, session } = await watching(harness)
  await harness.host.addRule(worker, { match: 'im.at_me', mode: 'cut' })
  await harness.host.addRule(worker, { match: 'im.chat.direct', mode: 'copy' })
  assert.deepEqual((await harness.host.listRules(main)).map(rule => rule.id), [1, 2])
  assert.equal((await harness.host.removeRule(main, 1)).id, 1)
  assert.match(all(harness, session), /The router removed your route rule #1 \(cut\) of task #1/)
  assert.equal((await harness.host.removeRule(worker, 2)).id, 2)
  assert.match(all(harness, harness.router().sessionId), /Task #1 \(Watch\) removed its route rule #2/)
  assert.deepEqual(harness.storage.media.get('im_rules')?.global, { nextRule: 3 })
})

test('a committed rule stands when its notice cannot be delivered', async () => {
  const harness = boot()
  await harness.receive('watch')
  const { worker } = await watching(harness)
  harness.im.failDeliver = new Error('offline')
  assert.equal((await harness.host.addRule(worker, { mode: 'copy' })).id, 1)
  const line = harness.logger.lines.find(entry => entry.level === 'error')
  assert.match(line?.format ?? '', /was not delivered/)
  assert.equal(line?.args[0], 'rule #1 added')
})

test('history search scans a chat newest first and continues from a cursor', async () => {
  const harness = boot({ searchPageSize: 2 })
  await harness.receive('first')
  await harness.receive('second', quiet({ sender: { id: 'user-2', name: 'Bob', self: false } }))
  await harness.receive('third', quiet())
  const main = harness.agent(harness.router().sessionId)

  const found = await harness.host.search(main, { match: 'im.sender.id === \'user-1\'', pages: 1 }, signal())
  assert.deepEqual(found.messages.map(message => message.text), ['third'])
  assert.equal(found.scanned, 2)
  assert.equal(found.next, '2')
  const older = await harness.host.search(main, { match: 'true', pages: 1, cursor: '2' }, signal())
  assert.deepEqual(older.messages.map(message => message.text), ['first'])
  assert.equal(older.next, undefined)

  await harness.receive('elsewhere', quiet({ chatKey: OTHER_KEY }))
  assert.deepEqual(await harness.host.search(main, { match: 'false', pages: 1, chat: 'other' }, signal()),
    { messages: [], scanned: 1 })
})

test('a caller outside the IM host or outside dispatch is refused', async () => {
  const harness = boot()
  await assert.rejects(harness.host.addRule(undefined as never, { mode: 'copy' }),
    { name: 'ImError', code: 'ownership', message: 'Dispatch tools require a session that the IM host serves.' })
  await harness.im.sessions.ensure({ key: 'stranger', owner: 'nobody', composition: COMPOSITION, bindings: [] })
  await assert.rejects(harness.host.listRules(harness.agent('stranger')),
    /Only a router or a dispatch task worker can do this\./)
})

test('each side gets its own guidance, and an operator may replace either', async () => {
  const harness = boot()
  await harness.receive('first message')
  assert.match(harness.host.prompt(harness.agent(harness.router().sessionId)), /前台 Router 会话/)
  const { worker } = await watching(harness)
  const text = harness.host.prompt(worker)
  assert.match(text, /task_describe/)
  assert.match(text, /output=none/)
  await harness.im.sessions.ensure({ key: 'stranger', owner: 'nobody', composition: COMPOSITION, bindings: [] })
  assert.equal(harness.host.prompt(harness.agent('stranger')), '')
  assert.equal(harness.host.prompt(), '')

  const custom = boot({ prompts: { main: 'Route only.', worker: 'Subscribe only.' }, workerOutput: 'summary' })
  await custom.receive('first message')
  assert.equal(custom.host.prompt(custom.agent(custom.router().sessionId)), 'Route only.')
  const started = await watching(custom)
  assert.equal(custom.host.prompt(started.worker), 'Subscribe only.')
  assert.equal(custom.im.sessions.get('task:1')?.output, 'summary')

  const streaming = boot({ workerOutput: 'summary' })
  await streaming.receive('first message')
  assert.match(streaming.host.prompt((await watching(streaming)).worker), /自动流式发布/)
})

test('exclusive tasks withhold unauthorized thread messages (both rule & Tier-2), refuse @bot with throttle, and reject routeToTask', async () => {
  const base = boot()
  const sentReplies: Array<{ chat: string; content: unknown; options: unknown }> = []
  let clock = 1_000_000
  const imWithSend = Object.assign(base.im, {
    send: async (chat: string, content: unknown, options: unknown) => {
      sentReplies.push({ chat, content, options })
      return { status: 'confirmed' as const }
    },
  })

  let exclusiveSession = ''
  const auth = {
    isExclusive: (sid: string) => sid === exclusiveSession,
    canInteract: (sid: string, uid: string) => sid !== exclusiveSession || uid === 'user-1',
    aclOf: (sid: string) => sid === exclusiveSession
      ? {
          sessionId: sid,
          exclusive: true,
          owner: { id: 'user-1', name: 'Alice' },
          allowedUsers: [{ id: 'user-1', name: 'Alice', addedAt: 1 }],
          grants: [],
        }
      : undefined,
    operatorUnlock: async () => true,
  }

  const host = new DispatchHost({
    im: imWithSend,
    tasks: base.tasks,
    storage: base.storage,
    logger: base.logger,
    config: base.config,
    auth: () => auth,
    now: () => clock,
  })

  const receive = async (text: string, patch: Parameters<Harness['receive']>[1] = {}) => {
    const message = imWithSend.store(text, patch)
    const outcome = await host.handle({
      message,
      deliver: (target, options) => imWithSend.sessions.deliver(target, {
        ...options,
        id: options.id ?? message.key,
        content: options.content ?? [message],
        trigger: options.trigger ?? message,
      }),
    }, () => Promise.resolve({ kind: 'ignored' }))
    return { message, outcome }
  }

  const { message: first } = await receive('owner start', { thread: { id: 'thr_1' } })
  const main = base.agent(base.router().sessionId)
  const task = await host.startTask(main, { title: 'Exclusive task', messages: [first.key] }, 'start-1')
  exclusiveSession = task.session
  const worker = base.worker(task.id)
  const rule = await host.addRule(worker, { match: 'im.thread_id === "thr_1"', mode: 'cut' })
  assert.equal((await host.taskOfRule(rule.id))?.id, task.id)

  const dispatcherId = base.router().sessionId
  const dispatcherCountBefore = imWithSend.texts(dispatcherId).length
  const workerCountBefore = imWithSend.texts(task.session).length

  await receive('owner followup', { thread: { id: 'thr_1' }, addressed: false, sender: { id: 'user-1', name: 'Alice', self: false } })
  assert.equal(imWithSend.texts(task.session).length, workerCountBefore + 1)

  const quietBob = await receive('bob chatter', {
    thread: { id: 'thr_1' },
    addressed: false,
    sender: { id: 'user-2', name: 'Bob', self: false },
  })
  assert.deepEqual(quietBob.outcome, { kind: 'handled', by: 'dispatch', sessions: [] })
  assert.equal(imWithSend.texts(task.session).length, workerCountBefore + 1)
  assert.equal(imWithSend.texts(dispatcherId).length, dispatcherCountBefore)
  assert.equal(sentReplies.length, 0)

  const pingBob1 = await receive('@bot help', {
    thread: { id: 'thr_1' },
    addressed: true,
    mentions: { self: true, all: false, users: [] },
    sender: { id: 'user-2', name: 'Bob', self: false },
  })
  assert.deepEqual(pingBob1.outcome, { kind: 'handled', by: 'dispatch', sessions: [] })
  assert.equal(sentReplies.length, 1)

  clock += 16_000
  await receive('@bot help later', {
    thread: { id: 'thr_1' },
    addressed: true,
    mentions: { self: true, all: false, users: [] },
    sender: { id: 'user-2', name: 'Bob', self: false },
  })
  assert.equal(sentReplies.length, 2)

  await assert.rejects(
    host.routeToTask(main, task.id, [{ message: pingBob1.message.key }]),
    { name: 'ImError', code: 'access', message: /exclusive to Alice/ },
  )

  await host.dispose()
})

test('per-router incremental task delta only sends new or updated tasks across chats and survives restarts', async () => {
  const first = boot()
  await first.receive('@bot 先建一个本群任务')
  const routerA = first.agent(first.router(CHAT_KEY).sessionId)
  const task1 = await first.host.startTask(routerA, { title: '本群初始任务' }, 't1')

  // Subsequent wake on Chat A sees Task #1 once as <tasks-delta change="new">.
  await first.receive('@bot 本群再问一句')
  const wakeA2 = first.im.logs.get(routerA.session.id)!.at(-1)!.text
  assert.match(wakeA2, /<tasks-delta>[\s\S]*id="#1" change="new" title="本群初始任务"/)
  assert.doesNotMatch(wakeA2, /<tasks-snapshot>/)

  // With no new or updated tasks, Wake 3 on Chat A emits neither <tasks-snapshot> nor <tasks-delta>.
  await first.receive('@bot 没有新任务的时候再问一句')
  const wakeA3 = first.im.logs.get(routerA.session.id)!.at(-1)!.text
  assert.doesNotMatch(wakeA3, /<tasks-snapshot>|<tasks-delta>/)

  // Meanwhile Chat B starts Task #2 (even with empty wantedTopics) and Task #1 gets updated.
  await first.receive('@bot B 群也起一个任务', { chatKey: OTHER_KEY })
  const routerB = first.agent(first.router(OTHER_KEY).sessionId)
  const task2 = await first.host.startTask(routerB, { title: 'B 群跨群新任务' }, 't2')
  await first.tasks.describe(task2.session, { description: 'B 群任务详情', wantedTopics: [] })
  await first.tasks.note(task1.session, '本群任务刚刚更新了进度')

  // Chat A wakes up later (e.g. 30 minutes later): receives ONLY Task #2 (new) and Task #1 (updated).
  await first.receive('@bot 30 分钟后回来问一句')
  const wakeA4 = first.im.logs.get(routerA.session.id)!.at(-1)!.text
  assert.match(wakeA4, /<tasks-delta>[\s\S]*id="#2" change="new" title="B 群跨群新任务"/)
  assert.match(wakeA4, /id="#1" change="updated" title="本群初始任务"[\s\S]*本群任务刚刚更新了进度/)

  // And after that, repeating without changes emits no task block again.
  await first.receive('@bot 紧接着再问一句')
  const wakeA5 = first.im.logs.get(routerA.session.id)!.at(-1)!.text
  assert.doesNotMatch(wakeA5, /<tasks-snapshot>|<tasks-delta>/)
  await first.host.dispose()

  // Persisted deliveredTasks survives restart without re-sending <tasks-snapshot>.
  const restarted = boot({}, first.storage.media)
  await restarted.receive('@bot 重启后再问一句')
  const postRestartWake = restarted.im.logs.get(restarted.router(CHAT_KEY).sessionId)!.at(-1)!.text
  assert.doesNotMatch(postRestartWake, /<tasks-snapshot>/)

  const chatRecord = restarted.storage.media.get('im_rules')!.tables.get('chats')!.get(CHAT_KEY) as {
    deliveredTasks?: Record<string, number>
  }
  assert.equal(typeof chatRecord.deliveredTasks?.['1'], 'number')
  assert.equal(typeof chatRecord.deliveredTasks?.['2'], 'number')

  const restartedRouterB = restarted.agent(restarted.router(OTHER_KEY).sessionId)
  const storedTask = await restarted.tasks.start({
    owner: restartedRouterB.session.id,
    title: '重启后的新增任务',
  })
  assert.equal(storedTask.id, 1)
  await restarted.host.dispose()
})

test('wakeMode and replyMode separate debounced ambient router wakes from proactive chat replies', async () => {
  let clock = 20_000_000
  const base = boot({ ambientDebounceMs: 15, maxAutoRepliesPerHour: 2 })
  const imWithSend = Object.assign(base.im, {
    send: async (chat: string, content: unknown, options: Record<string, unknown> = {}) => {
      base.im.sent.push({ chat, content, options })
      return { status: 'confirmed' as const, message: base.im.store('[bot reply]', quiet({ chatKey: chat, sender: { id: 'bot-user', name: 'Bot', isBot: true, self: true } })) }
    },
  })
  const host = new DispatchHost({
    im: imWithSend,
    tasks: base.tasks,
    storage: base.storage,
    logger: base.logger,
    config: base.config,
    now: () => clock,
  })
  const receive = async (text: string, patch: Parameters<Harness['receive']>[1] = {}) => {
    const message = imWithSend.store(text, patch)
    const outcome = await host.handle({
      message,
      deliver: (target, options) => imWithSend.sessions.deliver(target, {
        ...options,
        id: options.id ?? message.key,
        content: options.content ?? [message],
        trigger: options.trigger ?? message,
      }),
    }, () => Promise.resolve({ kind: 'ignored' }))
    return { message, outcome }
  }

  // Default watch mode with no watches ignores unaddressed chatter completely.
  const quietDefault = await receive('随便聊聊', quiet())
  assert.deepEqual(quietDefault.outcome, { kind: 'ignored' })

  // Direct mention establishes router; configure silent watch mode (`mention_only` reply).
  const initialDirect = await receive('@bot 帮忙盯住支付网关 502 告警')
  const main = base.agent(base.router().sessionId)
  const routerId = base.router().sessionId
  await host.configureChat(main, {
    wakeMode: 'watch',
    replyMode: 'mention_only',
    watchTopics: ['支付网关 502 告警'],
    watchNote: '出现 502 告警时后台建任务排查，不要闲聊回复',
  })

  // Burst unaddressed messages coalesce into ONE debounced ambient wake.
  const b1 = await receive('今天天气真好', quiet())
  const b2 = await receive('【监控告警】支付网关 502 告警 instance=gw-03', quiet({ sender: { id: 'alert-bot', name: '告警机器人', isBot: true, self: false } }))
  assert.deepEqual(b1.outcome, { kind: 'handled', by: 'dispatch', sessions: [] })
  assert.deepEqual(b2.outcome, { kind: 'handled', by: 'dispatch', sessions: [] })
  const countBeforeAmbient = imWithSend.logs.get(routerId)!.length
  await new Promise(resolve => setTimeout(resolve, 40))
  const logsAfterAmbient = imWithSend.logs.get(routerId)!
  assert.equal(logsAfterAmbient.length, countBeforeAmbient + 1)
  const ambientText = logsAfterAmbient.at(-1)!.text
  assert.match(ambientText, /trigger="ambient" wake-mode="watch" reply-mode="mention_only"/)
  assert.match(ambientText, /<watch-topics>支付网关 502 告警<\/watch-topics>/)
  assert.match(ambientText, /<ambient-notice>[\s\S]*禁止在此模式下调用 router_reply/)
  assert.match(ambientText, /今天天气真好[\s\S]*支付网关 502 告警/)

  // `routerReply` is hard-blocked in ambient + mention_only, while `startTask` succeeds using ambient message (not old @bot trigger).
  await assert.rejects(
    host.routerReply(main, { text: '收到告警' }, 'r-block'),
    { name: 'ImError', code: 'access', message: /mention_only/ },
  )
  const spawned = await host.startTask(main, { title: '排查支付网关 502' }, 'ambient-spawn')
  assert.equal(base.tasks.starts.at(-1)?.placement?.trigger?.key, b2.message.key)
  assert.notEqual(base.tasks.starts.at(-1)?.placement?.trigger?.key, initialDirect.message.key)
  assert.equal(spawned.id, 1)

  // `wakeMode: 'mention'` cancels pending ambient timer and ignores future unaddressed chatter even with watchTopics intact.
  await receive('又来一条消息', quiet())
  await host.configureChat(main, { wakeMode: 'mention' })
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(imWithSend.logs.get(routerId)!.length, countBeforeAmbient + 1)
  const mentionOnlyIgnored = await receive('不被唤醒的消息', quiet())
  assert.deepEqual(mentionOnlyIgnored.outcome, { kind: 'ignored' })

  // `wakeMode: 'watch'` + `replyMode: 'proactive'` (even with empty watchTopics!) ALSO wakes ambiently so topic auto-reply works.
  await host.configureChat(main, { wakeMode: 'watch', replyMode: 'proactive', watchTopics: [], replyPolicy: '有人聊到 SQL 慢查询时简要补充' })
  await receive('感觉这个 SQL 慢查询有索引问题', quiet())
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(imWithSend.logs.get(routerId)!.length, countBeforeAmbient + 2)
  assert.equal((await host.routerReply(main, { text: '可以 EXPLAIN 看看走没走联合索引' }, 'p1')).status, 'confirmed')

  // Switching to `wakeMode: 'auto'` keeps proactive cap intact (`maxAutoRepliesPerHour: 2`).
  await host.configureChat(main, { wakeMode: 'auto', replyMode: 'proactive' })
  await receive('慢查询阈值一般配多少', quiet())
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal((await host.routerReply(main, { text: '也可以看下慢查询日志阈值' }, 'p2')).status, 'confirmed')
  await assert.rejects(
    host.routerReply(main, { text: '第三条超限' }, 'p3'),
    { name: 'ImError', code: 'capacity', message: /2 次\/小时/ },
  )

  // Own self messages arriving alone never loop ambient wakes, even in `auto` mode.
  const countBeforeSelf = imWithSend.logs.get(routerId)!.length
  const selfIgnored = await receive('机器人自己的播报', quiet({ sender: { id: 'bot-user', name: 'Bot', isBot: true, self: true } }))
  assert.deepEqual(selfIgnored.outcome, { kind: 'ignored' })
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(imWithSend.logs.get(routerId)!.length, countBeforeSelf)

  await host.dispose()
})

test('a thread follow-up the bot was not addressed in reaches the worker marked as overheard', async () => {
  const harness = boot({ autoThread: true })
  const request = await harness.receive('@bot 盯一下这个告警')
  const rootId = splitKey(request.key).id
  const main = harness.agent(harness.router().sessionId)
  const task = await harness.host.startTask(main, { title: 'Overhear' }, 'overhear-1')
  await harness.tasks.describe(task.session, { followThread: true })

  // The bot's own reply threads the task on `omt_9`, which the host learns dynamically.
  harness.im.store('已收到', quiet({
    sender: { id: 'bot-user', name: 'Bot', isBot: true, self: true },
    thread: { id: 'omt_9', root: rootId },
    quote: { key: request.key },
  }))
  await new Promise(resolve => setTimeout(resolve, 10))

  const chatter = await harness.receive('@运维机器人 你直接去集群里看看', quiet({
    thread: { id: 'omt_9', root: rootId },
    mentions: { self: false, all: false, users: [{ id: 'ou_sre', name: '运维机器人' }] },
  }))
  assert.equal(harness.host.deliveryCause(task.session, chatter.key)?.kind, 'thread')
  const followUp = harness.im.texts(task.session).at(-1)!
  assert.match(followUp, /<im-thread-followup chat="[^"]+" message="#\d+" mentioned="运维机器人">/)
  assert.match(followUp, /这条消息没有 @ 你，也不是对你的回复（它 @ 的是 运维机器人）/)
  assert.match(followUp, /你直接去集群里看看/)

  // A message handed over on purpose is the task's work, so it carries no overheard marker.
  const directed = await harness.receive('这台机器重启一下', quiet())
  const directedTask = await harness.host.startTask(main, { title: 'Directed', messages: [`#${directed.seq}`] }, 'directed-1')
  assert.doesNotMatch(all(harness, directedTask.session), /<im-thread-followup/)
})
