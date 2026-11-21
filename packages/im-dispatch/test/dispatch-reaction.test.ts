/**
 * Inbound reaction handling and batching tests:
 * - only reactions by others on the bot's own messages produce an event (self-reactions and reactions to others are ignored)
 * - router reactions debounce and batch with multiple reactions, ambient chatter, and direct `@bot` wakes
 * - in-batch add/remove cancellation suppresses accidental clicks
 * - `trigger="reaction"` permits `router_reply` even under default `replyMode="mention_only"`
 * - task-owned message reactions route and batch to the owning worker (and coalesce with concurrent thread messages)
 * - exclusive ACL and `followThread: false` are respected
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { DispatchHost } from '../src/index.ts'
import { splitKey } from '../src/im.ts'
import type { ImReactionEventLike, ImStoredMessage, SessionAuthLike } from '../src/types.ts'
import { boot, quiet } from './dispatch-fakes.ts'

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function reactionEvent(
  message: ImStoredMessage,
  emoji: string,
  patch: Partial<ImReactionEventLike> = {},
): ImReactionEventLike {
  return {
    action: 'added',
    emoji,
    chat: message.chat,
    user: { id: 'u-alice' },
    bot: { id: message.chat.bot, selfId: 'bot-user' },
    message,
    time: 1_700_000_000_000,
    ...patch,
  }
}

test('reactions by others on bot messages batch for the router, resolve cached user names, and allow router_reply', async () => {
  const harness = boot({ ambientDebounceMs: 30 })
  await harness.receive('@bot 帮我看下发布状态', { sender: { id: 'u-alice', name: 'Alice', self: false } })
  const routerId = harness.router().sessionId
  await harness.host.configureChat(harness.agent(routerId), { wakeMode: 'watch' })
  const botMsg = harness.im.store('已确认：生产环境已发布完成', quiet({
    sender: { id: 'bot-user', name: 'Bot', isBot: true, self: true },
  }))

  // Two reactions within the debounce window merge into ONE router wake.
  await harness.host.onReaction(reactionEvent(botMsg, 'THUMBSUP', { id: 'ev-1', user: { id: 'u-alice' } }))
  await harness.host.onReaction(reactionEvent(botMsg, 'HEART', { id: 'ev-2', user: { id: 'u-bob', name: 'Bob' } }))

  // Nothing delivered yet during debounce window.
  assert.equal(harness.im.logs.get(routerId)?.length, 1)
  await wait(70)

  const logs = harness.im.logs.get(routerId)!
  assert.equal(logs.length, 2)
  const wake = logs[1]!
  assert.equal(wake.delivery.mode, 'steer')
  assert.match(wake.text, /trigger="reaction"/)
  assert.match(wake.text, /<reaction-notice>/)
  assert.match(wake.text, new RegExp(`<im-reaction action="added" message="#${botMsg.seq}" from="Alice" user-id="u-alice" emoji="THUMBSUP"`))
  assert.match(wake.text, new RegExp(`<im-reaction action="added" message="#${botMsg.seq}" from="Bob" user-id="u-bob" emoji="HEART"`))
  assert.match(wake.text, /preview="已确认：生产环境已发布完成"/)

  // Even under default `replyMode="mention_only"`, a reaction wake may call `router_reply` and quotes the reacted msg.
  const replied = await harness.host.routerReply(harness.agent(routerId), { text: '收到反馈' }, 'call-react-reply')
  assert.equal(replied.status, 'confirmed')
  assert.equal(harness.im.sent.at(-1)?.options?.quote, botMsg.key)

  await harness.host.dispose()
})

test('ignores reactions on other users messages, self-reactions, and cancels opposite add/remove within one batch', async () => {
  const harness = boot({ ambientDebounceMs: 25 })
  const userMsg = await harness.receive('@bot hi', { sender: { id: 'u-alice', name: 'Alice', self: false } })
  const botMsg = harness.im.store('你好', quiet({
    sender: { id: 'bot-user', name: 'Bot', isBot: true, self: true },
  }))
  const routerId = harness.router().sessionId
  assert.equal(harness.im.logs.get(routerId)?.length, 1)

  // Reaction on another user's message: ignored.
  await harness.host.onReaction(reactionEvent(userMsg, 'THUMBSUP', { id: 'ev-other' }))
  // Bot's own reaction on its own message: ignored.
  await harness.host.onReaction(reactionEvent(botMsg, 'Typing', { id: 'ev-self', user: { id: 'bot-user', isBot: true } }))
  // Accidental click + immediate undo within debounce window: cancels out.
  await harness.host.onReaction(reactionEvent(botMsg, 'THUMBSUP', { id: 'ev-add', action: 'added' }))
  await harness.host.onReaction(reactionEvent(botMsg, 'THUMBSUP', { id: 'ev-rem', action: 'removed' }))

  await wait(60)
  assert.equal(harness.im.logs.get(routerId)?.length, 1)
  await harness.host.dispose()
})

test('reactions batch together with concurrent ambient messages and direct @bot messages', async () => {
  const harness = boot({ ambientDebounceMs: 35 })
  await harness.receive('@bot init')
  const routerId = harness.router().sessionId
  await harness.host.configureChat(harness.agent(routerId), { wakeMode: 'auto' })
  const botMsg = harness.im.store('方案 A 与方案 B 已整理', quiet({
    sender: { id: 'bot-user', name: 'Bot', isBot: true, self: true },
  }))

  // 1) Unaddressed chatter + reaction within the same debounce window -> ONE combined wake.
  await harness.receive('我也觉得方案 A 好', quiet({ sender: { id: 'u-bob', name: 'Bob', self: false } }))
  await harness.host.onReaction(reactionEvent(botMsg, 'THUMBSUP', { id: 'ev-b1', user: { id: 'u-bob' } }))
  await wait(80)

  const logsAfterAmbient = harness.im.logs.get(routerId)!
  assert.equal(logsAfterAmbient.length, 2)
  assert.match(logsAfterAmbient[1]!.text, /trigger="reaction"/)
  assert.match(logsAfterAmbient[1]!.text, /我也觉得方案 A 好/)
  assert.match(logsAfterAmbient[1]!.text, /emoji="THUMBSUP"/)

  // 2) Reaction followed immediately by a direct `@bot` message -> ONE combined direct wake (timer cancelled).
  await harness.host.onReaction(reactionEvent(botMsg, 'QUESTION', { id: 'ev-b2', user: { id: 'u-carol', name: 'Carol' } }))
  await harness.receive('@bot 这里细节展开讲下', { sender: { id: 'u-carol', name: 'Carol', self: false } })
  await wait(80)

  const logsAfterDirect = harness.im.logs.get(routerId)!
  assert.equal(logsAfterDirect.length, 3)
  assert.match(logsAfterDirect[2]!.text, /trigger="direct"/)
  assert.match(logsAfterDirect[2]!.text, /这里细节展开讲下/)
  assert.match(logsAfterDirect[2]!.text, /emoji="QUESTION"/)
  await harness.host.dispose()
})

test('reactions on a task worker message batch to that worker, coalesce with thread follow-ups, and respect ACL and followThread', async () => {
  const allowedUsers = new Set<string>(['u-owner'])
  const auth: SessionAuthLike = {
    isExclusive: () => true,
    canInteract: (_sessionId, userId) => allowedUsers.has(userId),
    aclOf: () => ({
      sessionId: '',
      exclusive: true,
      owner: { id: 'u-owner', name: 'Owner' },
      allowedUsers: [],
      grants: [],
    }),
    operatorUnlock: async () => true,
  }

  const base = boot({ ambientDebounceMs: 30 })
  const host = new DispatchHost({
    im: base.im,
    tasks: base.tasks,
    storage: base.storage,
    logger: base.logger,
    config: base.config,
    auth: () => auth,
    chronicle: base.chronicle,
    ephemeral: base.ephemeral,
  })
  base.im.onStored = (msg) => { host.onStored(msg) }

  const req = base.im.store('@bot 跑下压测', { sender: { id: 'u-owner', name: 'Owner', self: false } })
  await host.handle({
    message: req,
    deliver: (target, options) => base.im.sessions.deliver(target, {
      ...options,
      id: options.id ?? req.key,
      content: options.content ?? [req],
      trigger: options.trigger ?? req,
    }),
  }, () => Promise.resolve({ kind: 'ignored' }))

  const routerId = base.router().sessionId
  await host.configureChat(base.agent(routerId), { wakeMode: 'watch' })
  const task = await host.startTask(base.agent(routerId), { title: '压测任务', messages: [req.key] }, 'call-t1')
  await base.tasks.describe(task.session, { followThread: true })
  const rootId = splitKey(req.key).id
  const workerMsg = base.im.store('压测报告已生成，要发布吗？', quiet({
    sender: { id: 'bot-user', name: 'Bot', isBot: true, self: true },
    thread: { id: 'omt_1', root: rootId },
    quote: { key: req.key },
  }))
  await wait(10)

  const initialWorkerCount = base.im.logs.get(task.session)!.length
  const initialRouterCount = base.im.logs.get(routerId)!.length

  // Unauthorized user's reaction on an exclusive task is silently dropped (does not leak to router).
  await host.onReaction(reactionEvent(workerMsg, 'THUMBSUP', {
    id: 'ev-unauth',
    user: { id: 'u-stranger', name: 'Stranger' },
    session: task.session,
  }))
  await wait(60)
  assert.equal(base.im.logs.get(task.session)!.length, initialWorkerCount)
  assert.equal(base.im.logs.get(routerId)!.length, initialRouterCount)

  // Authorized owner reacts twice -> batched into ONE worker delivery without setting a trigger.
  await host.onReaction(reactionEvent(workerMsg, 'THUMBSUP', {
    id: 'ev-ok-1',
    user: { id: 'u-owner' },
    session: task.session,
  }))
  await host.onReaction(reactionEvent(workerMsg, 'DONE', {
    id: 'ev-ok-2',
    user: { id: 'u-owner' },
    session: task.session,
  }))
  await wait(70)

  const workerLogs = base.im.logs.get(task.session)!
  assert.equal(workerLogs.length, initialWorkerCount + 1)
  assert.equal(base.im.logs.get(routerId)!.length, initialRouterCount)
  const reactDelivery = workerLogs.at(-1)!
  assert.equal(reactDelivery.delivery.trigger, undefined)
  assert.match(reactDelivery.text, /<im-reactions /)
  assert.match(reactDelivery.text, /emoji="THUMBSUP"/)
  assert.match(reactDelivery.text, /emoji="DONE"/)

  // Reaction followed by a thread follow-up message coalesces into ONE worker delivery.
  await host.onReaction(reactionEvent(workerMsg, 'HEART', {
    id: 'ev-ok-3',
    user: { id: 'u-owner' },
    session: task.session,
  }))
  const follow = base.im.store('顺便补一下 P99 数据', quiet({
    sender: { id: 'u-owner', name: 'Owner', self: false },
    thread: { id: 'omt_1', root: rootId },
  }))
  await host.handle({
    message: follow,
    deliver: (target, options) => base.im.sessions.deliver(target, {
      ...options,
      id: options.id ?? follow.key,
      content: options.content ?? [follow],
      trigger: options.trigger ?? follow,
    }),
  }, () => Promise.resolve({ kind: 'ignored' }))
  await wait(70)

  assert.equal(base.im.logs.get(task.session)!.length, initialWorkerCount + 2)
  const merged = base.im.logs.get(task.session)!.at(-1)!
  assert.match(merged.text, /顺便补一下 P99 数据/)
  assert.match(merged.text, /emoji="HEART"/)
  assert.equal(merged.delivery.trigger, follow)

  // Once followThread is false, reactions fall back to the router instead of waking the muted worker.
  await base.tasks.describe(task.session, { followThread: false })
  await host.onReaction(reactionEvent(workerMsg, 'QUESTION', {
    id: 'ev-after-mute',
    user: { id: 'u-owner' },
    session: task.session,
  }))
  await wait(70)
  assert.equal(base.im.logs.get(task.session)!.length, initialWorkerCount + 2)
  assert.equal(base.im.logs.get(routerId)!.length, initialRouterCount + 1)
  assert.match(base.im.logs.get(routerId)!.at(-1)!.text, /emoji="QUESTION"/)

  await host.dispose()
  await base.host.dispose()
})
