/**
 * Dispatch routing when an inbound group message only replies to (quotes) a bot message without `@bot`.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { DISPATCHER_CHAT_PREFIX, DispatchHost } from '../src/index.ts'
import type { ChatRefLike, ImStoredMessage } from '../src/types.ts'
import { BOT, CHAT_KEY, boot, quiet } from './dispatch-fakes.ts'

test('replying to a stored bot message without @bot wakes the router and sets im.at_me', async () => {
  const harness = boot({ autoThread: false })
  await harness.receive('open task')
  const main = harness.agent(harness.router().sessionId)
  const task = await harness.host.startTask(main, { title: 'Watch' }, 'start-1')
  const worker = harness.worker(task.id)
  await harness.host.addRule(worker, { match: 'im.at_me', mode: 'copy', note: 'addressed messages' })

  const botReply = harness.im.store('bot answer', quiet({
    sender: { id: 'bot-user', name: 'Bot', isBot: true, self: true },
  }))
  const reply = await harness.receive('follow up by reply only', quiet({
    quote: { key: botReply.key },
    sender: { id: 'user-2', name: 'Bob', self: false },
  }))

  const dispatcher = harness.dispatcher()
  assert.deepEqual(harness.outcomes.get(reply.key), {
    kind: 'handled',
    by: 'dispatch',
    sessions: [dispatcher.sessionId, task.session],
  })
  assert.match(harness.im.texts(dispatcher.sessionId).join('\n'), /follow up by reply only/)
  assert.match(harness.im.texts(task.session).join('\n'), /follow up by reply only/)

  // A bot's own message quoting itself must never wake the dispatcher.
  const ownEcho = await harness.receive('self echo', quiet({
    quote: { key: botReply.key },
    sender: { id: 'bot-user', name: 'Bot', isBot: true, self: true },
  }))
  assert.deepEqual(harness.outcomes.get(ownEcho.key), { kind: 'ignored' })

  await harness.host.dispose()
})

test('replying without @bot to another human or another bot stays ignored', async () => {
  const harness = boot()
  const humanPost = harness.im.store('human post', quiet({
    sender: { id: 'user-2', name: 'Bob', self: false },
  }))
  const otherBotPost = harness.im.store('other bot post', quiet({
    sender: { id: 'other-bot', name: 'OtherBot', isBot: true, self: false },
  }))

  const replyHuman = await harness.receive('reply to human', quiet({ quote: { key: humanPost.key } }))
  const replyOtherBot = await harness.receive('reply to other bot', quiet({ quote: { key: otherBotPost.key } }))

  assert.deepEqual(harness.outcomes.get(replyHuman.key), { kind: 'ignored' })
  assert.deepEqual(harness.outcomes.get(replyOtherBot.key), { kind: 'ignored' })
  assert.equal(harness.im.texts(`${DISPATCHER_CHAT_PREFIX}${CHAT_KEY}`).length, 0)

  await harness.host.dispose()
})

test('replying to an unstored bot message resolves via quote.sender or bot.getMessage and degrades cleanly on error', async () => {
  const base = boot()
  let lookupResult: { sender: { id: string; name?: string; isBot?: boolean } } | Error = new Error('not run')
  const lookups: Array<{ chat: ChatRefLike; id: string }> = []
  const imWithBot = Object.assign(base.im, {
    bot: () => ({
      selfId: 'ou_self',
      getMessage: async (chat: ChatRefLike, id: string) => {
        lookups.push({ chat, id })
        if (lookupResult instanceof Error) throw lookupResult
        return lookupResult
      },
    }),
  })
  const host = new DispatchHost({
    im: imWithBot,
    tasks: base.tasks,
    storage: base.storage,
    logger: base.logger,
    config: base.config,
  })

  const receive = async (text: string, patch: Parameters<typeof imWithBot.store>[1]) => {
    const message = imWithBot.store(text, patch)
    const outcome = await host.handle({
      message,
      deliver: (target, options) => imWithBot.sessions.deliver(target, {
        ...options,
        id: options.id ?? message.key,
        content: options.content ?? [message],
        trigger: options.trigger ?? message,
      }),
    }, () => Promise.resolve({ kind: 'ignored' }))
    return { message, outcome }
  }

  // 1. quote.sender matches bot.selfId without needing getMessage.
  const viaQuoteSender = await receive('via quote.sender selfId', quiet({
    quote: { key: `${BOT}|om_stream_1`, sender: { id: 'ou_self', isBot: true } },
  }))
  assert.equal(viaQuoteSender.outcome.kind, 'handled')
  assert.equal(lookups.length, 0)

  // 2. quote.sender matches bot appId suffix (`fake:bot` -> `bot`) when isBot is true.
  const viaAppId = await receive('via quote.sender appId', quiet({
    quote: { key: `${BOT}|om_stream_2`, sender: { id: 'bot', isBot: true } },
  }))
  assert.equal(viaAppId.outcome.kind, 'handled')
  assert.equal(lookups.length, 0)

  // 3. Unstored quote without sender falls back to bot.getMessage (e.g. in-flight streaming card).
  lookupResult = { sender: { id: 'ou_self', name: 'Bot', isBot: true } }
  const viaGetMessage = await receive('via getMessage self', quiet({
    quote: { key: `${BOT}|om_stream_3` },
  }))
  assert.equal(viaGetMessage.outcome.kind, 'handled')
  assert.deepEqual(lookups, [{ chat: { id: 'chat', type: 'group' }, id: 'om_stream_3' }])

  // 4. getMessage returning another bot or human stays ignored.
  lookupResult = { sender: { id: 'other-bot', name: 'Other', isBot: true } }
  const viaOtherBot = await receive('via getMessage other bot', quiet({
    quote: { key: `${BOT}|om_other_bot` },
  }))
  assert.deepEqual(viaOtherBot.outcome, { kind: 'ignored' })

  // 5. Failing getMessage degrades cleanly to ignored.
  lookupResult = new Error('network down')
  const viaFailure = await receive('via getMessage failure', quiet({
    quote: { key: `${BOT}|om_missing` },
  }))
  assert.deepEqual(viaFailure.outcome, { kind: 'ignored' })

  await host.dispose()
})

test('a cut thread rule intercepts reply-to-bot without duplicating to dispatcher, and exclusive tasks refuse unauthorized replies', async () => {
  const base = boot()
  const sentReplies: Array<{ chat: string; content: unknown; options: unknown }> = []
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
  })

  const receive = async (text: string, patch: Partial<ImStoredMessage> = {}) => {
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

  const { message: opening } = await receive('owner start', {
    thread: { id: 'thr_1' },
    sender: { id: 'user-1', name: 'Alice', self: false },
  })
  const main = base.agent(base.router().sessionId)
  const task = await host.startTask(main, { title: 'Exclusive reply', messages: [opening.key] }, 'start-1')
  exclusiveSession = task.session
  const worker = base.worker(task.id)
  await host.addRule(worker, { match: 'im.thread_id === "thr_1"', mode: 'cut' })

  const botMsg = imWithSend.store('bot status', quiet({
    thread: { id: 'thr_1' },
    sender: { id: 'bot-user', name: 'Bot', isBot: true, self: true },
  }))

  const dispatcherId = base.router().sessionId
  const dispatcherBefore = imWithSend.texts(dispatcherId).length
  const workerBefore = imWithSend.texts(task.session).length

  // Authorized owner replying to the bot inside the subscribed thread reaches the task alone.
  const ownerReply = await receive('owner reply to bot', quiet({
    thread: { id: 'thr_1' },
    quote: { key: botMsg.key },
    sender: { id: 'user-1', name: 'Alice', self: false },
  }))
  assert.deepEqual(ownerReply.outcome, { kind: 'handled', by: 'dispatch', sessions: [task.session] })
  assert.equal(imWithSend.texts(task.session).length, workerBefore + 1)
  assert.equal(imWithSend.texts(dispatcherId).length, dispatcherBefore)

  // Unauthorized user replying to the bot without @bot still gets the exclusivity refusal reply.
  const bobReply = await receive('bob reply to bot', quiet({
    thread: { id: 'thr_1' },
    quote: { key: botMsg.key },
    sender: { id: 'user-2', name: 'Bob', self: false },
  }))
  assert.deepEqual(bobReply.outcome, { kind: 'handled', by: 'dispatch', sessions: [] })
  assert.equal(imWithSend.texts(task.session).length, workerBefore + 1)
  assert.equal(imWithSend.texts(dispatcherId).length, dispatcherBefore)
  assert.equal(sentReplies.length, 1)
  assert.match(JSON.stringify(sentReplies[0]?.content), /user-1/)

  await host.dispose()
})
