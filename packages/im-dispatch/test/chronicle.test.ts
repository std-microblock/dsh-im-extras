/**
 * Prefix-cached cross-chat Chronicle tests:
 * - monotonic `#id` compaction across task starts, cross-chat routes, and bot outbound replies
 * - filtering of ephemeral messages (TriggerLinks, working status, exclusivity refusals, `🔗 查看工作过程`)
 * - immutable chunk prefix-cache invariance (`system`, `tools: undefined`, sticky `sessionId`, sealed chunks)
 * - high-watermark bulk chunk eviction & `sessionSalt` rotation
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CHRONICLE_QUERY_SYSTEM_PROMPT, EphemeralTracker, isEphemeralSelfMessage,
} from '../src/chronicle/index.ts'
import { CHAT_KEY, FakeLlm, OTHER_KEY, boot, quiet } from './dispatch-fakes.ts'

test('Chronicle compacts events with monotonic #id and skips ephemeral messages', async () => {
  const llm = new FakeLlm((options) => {
    if (options.system?.includes('压缩器')) {
      const text = String(options.messages[0]?.content[0]?.text ?? '')
      if (text.includes('发版卡片')) return JSON.stringify({ subject: 'release发版', summary: '启动后台任务生成发版卡片。' })
      if (text.includes('结论已同步')) return JSON.stringify({ subject: '机器人回复', summary: '向群内回复发版卡片已完成。' })
      return JSON.stringify({ subject: '任务更新', summary: '路由了一条消息到已有任务。' })
    }
    const serialized = options.messages.map(m => String(m.content[0]?.text ?? '')).join('\n')
    assert.match(serialized, /release发版/)
    assert.match(serialized, /向群内回复发版卡片已完成/)
    return 'Task #1 已在群里生成发版卡片并回复。'
  })

  const harness = boot({}, undefined, llm)
  await harness.receive('@bot 每次发版做一个卡片')
  const main = harness.agent(harness.router().sessionId)
  await harness.host.startTask(main, { title: '发版卡片', messages: ['#1'] }, 'start-1')

  // Real bot reply -> MUST enter Chronicle.
  await harness.im.send(CHAT_KEY, { type: 'markdown', attrs: { content: '结论已同步：卡片上线。' }, children: [] })

  // Ephemeral messages -> MUST NOT enter Chronicle (even when stored before explicit tracking).
  harness.im.store('🔗 查看工作过程', quiet({ sender: { id: 'bot-user', name: 'Bot', isBot: true, self: true } }))
  harness.im.store('⌨️ 正在工作中', quiet({ sender: { id: 'bot-user', name: 'Bot', isBot: true, self: true } }))
  harness.im.store('当前任务由 Alice 独占，如需协作请让其 @bot 授权给你', quiet({
    sender: { id: 'bot-user', name: 'Bot', isBot: true, self: true },
  }))
  const markedKey = `${CHAT_KEY}-refusal`
  harness.ephemeral.mark(markedKey)
  const markedMsg = harness.im.store('custom transient text', quiet({
    key: markedKey,
    sender: { id: 'bot-user', name: 'Bot', isBot: true, self: true },
  }))
  const tracker = new EphemeralTracker()
  tracker.mark(markedKey)
  assert.equal(isEphemeralSelfMessage(markedMsg, tracker), true)

  harness.ephemeral.mark(`${CHAT_KEY}-ephemeral-2`)
  harness.im.store('tracked ephemeral notice', quiet({
    key: `${CHAT_KEY}-ephemeral-2`,
    sender: { id: 'bot-user', name: 'Bot', isBot: true, self: true },
  }))

  await harness.chronicle.flush()
  const status = await harness.chronicle.status()
  assert.equal(status.entries, 2)
  assert.equal(status.latestId, 2)
  assert.equal(status.recent.every(entry => !entry.summary.includes('查看工作过程') && !entry.summary.includes('正在工作中')), true)

  const res = await harness.chronicle.query({ question: '发版卡片做好了吗', chat: OTHER_KEY })
  assert.equal(res.latestId, 2)
  assert.equal(res.entriesScanned, 2)
  assert.match(res.answer, /已/)
  await harness.host.dispose()
})

test('Chronicle fork queries maintain exact prefix-cache invariance across sealed chunks', async () => {
  const llm = new FakeLlm()
  const harness = boot({ chronicle: { chunkSize: 3, maxEntries: 100 } }, undefined, llm)

  // Produce 4 entries: chunk #1..#3 sealed, entry #4 in tail.
  for (let i = 1; i <= 4; i++) {
    await harness.im.send(CHAT_KEY, { type: 'markdown', attrs: { content: `真实交付进展 #${i}` }, children: [] })
  }
  await harness.chronicle.flush()
  const status1 = await harness.chronicle.status()
  assert.equal(status1.entries, 4)
  assert.equal(status1.chunks, 1)

  llm.calls.length = 0
  await harness.chronicle.query({ question: '第一个问题' })
  assert.equal(llm.calls.length, 1)
  const call1 = llm.calls[0]!.options

  // Query #2 should not add entries to Chronicle AND must keep chunk[0], system, tools, sessionId byte-identical.
  await harness.chronicle.query({ question: '第二个问题', chat: OTHER_KEY })
  assert.equal(llm.calls.length, 2)
  const call2 = llm.calls[1]!.options
  assert.equal((await harness.chronicle.status()).entries, 4)

  assert.equal(call1.system, CHRONICLE_QUERY_SYSTEM_PROMPT)
  assert.equal(call2.system, CHRONICLE_QUERY_SYSTEM_PROMPT)
  assert.equal(call1.tools, undefined)
  assert.equal(call2.tools, undefined)
  assert.equal(call1.sessionId, 'im-chronicle-v1')
  assert.equal(call2.sessionId, call1.sessionId)
  // Chunk 0 (immutable entries #1..#3) and tail (#4) are identical; only trailing <query> differs.
  assert.deepEqual(call1.messages.slice(0, -1), call2.messages.slice(0, -1))
  assert.match(String(call1.messages.at(-1)?.content[0]?.text), /第一个问题/)
  assert.match(String(call2.messages.at(-1)?.content[0]?.text), /第二个问题/)

  // Appending entry #5 modifies only tail, leaving sealed Chunk 0 completely byte-identical.
  await harness.im.send(OTHER_KEY, { type: 'markdown', attrs: { content: '群2 新结论 #5' }, children: [] })
  await harness.chronicle.flush()
  llm.calls.length = 0
  await harness.chronicle.query({ question: '第三个问题' })
  const call3 = llm.calls[0]!.options
  assert.equal(call3.sessionId, call1.sessionId)
  assert.deepEqual(call3.messages[0], call1.messages[0])
  assert.equal(call3.messages.length, 3)

  await harness.host.dispose()
})

test('Chronicle bulk-evicts oldest ~25% sealed chunks once maxEntries is exceeded', async () => {
  const harness = boot({ chronicle: { chunkSize: 4, maxEntries: 100 } })
  // Exceed 100 entries (104 = 26 chunks of 4).
  for (let i = 1; i <= 104; i++) {
    await harness.im.send(CHAT_KEY, { type: 'markdown', attrs: { content: `批量消息 ${i}` }, children: [] })
  }
  await harness.chronicle.flush()
  const status = await harness.chronicle.status()
  // Target evict = max(4, floor(100 * 0.25)) = 25 -> 7 chunks (28 entries) evicted at once -> 76 remain.
  assert.ok(status.entries < 100 && status.entries >= 60, `expected bulk eviction leaving 60..99 entries, got ${status.entries}`)
  assert.equal(status.latestId, 104)

  // Subsequent entries do NOT evict one-by-one until hitting maxEntries again.
  await harness.im.send(CHAT_KEY, { type: 'markdown', attrs: { content: '新增条目 105' }, children: [] })
  await harness.chronicle.flush()
  const afterOneMore = await harness.chronicle.status()
  assert.equal(afterOneMore.entries, status.entries + 1)

  await harness.host.dispose()
})
