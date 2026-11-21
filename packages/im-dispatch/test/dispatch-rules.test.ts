/**
 * The rule fields of one stored message and the QuickJS rule engine: the values a rule expression sees as `im`, and
 * the bounds and failures of evaluating one.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { newQuickJSWASMModule } from '@tootallnate/quickjs-emscripten'
import { RULE_FIELDS, RuleEngine, messageType, ruleInput } from '../src/rules.ts'
import type { ElementLike, ImStoredMessage } from '../src/types.ts'

/** One element. */
function h(type: string, attrs: Record<string, unknown> = {}, ...children: (ElementLike | string)[]): ElementLike {
  return {
    type,
    attrs,
    children: children.map(child => (typeof child === 'string' ? { type: 'text', attrs: { content: child }, children: [] } : child)),
  }
}

/** One stored message over the given content. */
function message(content: ElementLike, patch: Partial<ImStoredMessage> = {}): ImStoredMessage {
  return {
    key: 'fake:bot|m-1',
    seq: 7,
    chat: { key: 'fake:bot|chat', bot: 'fake:bot', ref: { id: 'chat', type: 'group' }, source: 'team' },
    sender: { id: 'user-1', name: 'Alice', self: false },
    content,
    text: 'hello',
    mentions: { self: true, all: false, users: [] },
    addressed: true,
    time: 1000,
    ...patch,
  }
}

test('the message kind derives the v3 rule type from the normalized content', () => {
  assert.equal(messageType(h('message', {}, 'hello')), 'text')
  assert.equal(messageType(h('message', {}, h('quote', { id: 'q' }), 'hello')), 'text')
  assert.equal(messageType(h('message', {}, h('p', {}, 'one'), h('p', {}, 'two'))), 'post')
  assert.equal(messageType(h('message', {}, h('img', { src: 'image' }))), 'image')
  assert.equal(messageType(h('message', {}, h('audio', { src: 'audio' }))), 'audio')
  assert.equal(messageType(h('message', {}, h('video', { src: 'video' }))), 'video')
  assert.equal(messageType(h('message', {}, h('file', { src: 'file' }))), 'file')
  assert.equal(messageType(h('message', {}, h('forward', { id: 'f' }))), 'merge_forward')
  assert.equal(messageType(h('message', {}, h('raw', { platform: 'qq', type: 'ark' }))), 'ark')
  // A title does not count as a text block.
  assert.equal(messageType(h('message', {}, h('title', {}, 'Only a title'))), 'text')
})

test('a rule reads the message identity, sender, addressing and thread links', () => {
  assert.deepEqual(ruleInput(message(h('message', {}, 'hello'), {
    mentions: { self: true, all: false, users: [{ id: 'user-2', name: 'Bob' }] },
    thread: { id: 'th-1', root: 'm-0' },
    quote: { key: 'fake:bot|m-0', sender: { id: 'user-2' }, text: 'earlier' },
  })), {
    id: 'm-1',
    source: 'team',
    chat: { id: 'chat', direct: false },
    sender: { id: 'user-1', type: 'user' },
    at_me: true,
    mentions: ['user-2'],
    content: 'hello',
    type: 'text',
    time: 1000,
    thread_id: 'th-1',
    root_id: 'm-0',
    parent_id: 'm-0',
    resources: [],
  })
  const direct = ruleInput(message(h('message', {}, 'x'), {
    chat: { key: 'fake:bot|dm', bot: 'fake:bot', ref: { id: 'dm', type: 'direct' }, source: 'team' },
    sender: { id: 'bot-1', isBot: true, self: false },
    addressed: false,
  }))
  assert.deepEqual(direct.chat, { id: 'dm', direct: true })
  assert.deepEqual(direct.sender, { id: 'bot-1', type: 'bot' })
  assert.equal(direct.at_me, false)
  assert.equal(ruleInput(message(h('message', {}, 'x'), { addressed: false }), true).at_me, true)
  assert.equal(direct.thread_id, null)
  assert.equal(direct.root_id, null)
  assert.equal(direct.parent_id, null)
  assert.match(RULE_FIELDS, /im\.sender\.id/)
})

test('a rule lists the media a message carries, with their names', () => {
  const resources = ruleInput(message(h('message', {},
    h('p', {}, 'look', h('img', { src: 'image', alt: 'diagram' })),
    h('file', { src: 'file', name: 'report.pdf' }),
    h('video', { src: 'video' }),
  ))).resources
  assert.deepEqual(resources, [
    { type: 'image', name: 'diagram' },
    { type: 'file', name: 'report.pdf' },
    { type: 'video', name: null },
  ])
})

test('the engine compiles, matches, and reports failures without leaking state between rules', async () => {
  // A budget that bounds a runaway rule without being a deadline for an ordinary one: the interrupt handler compares
  // against wall clock, so a budget of a few milliseconds also fires on `im.content === "hello"` while the rest of the
  // workspace's suites are running.
  const engine = new RuleEngine(await newQuickJSWASMModule(), { timeoutMs: 500, memoryBytes: 16 * 1024 * 1024 })
  assert.equal(engine.check('im.at_me'), undefined)
  assert.match(engine.check('im.content.includes(') ?? '', /^SyntaxError/)
  const input = ruleInput(message(h('message', {}, 'hello')))
  const outcomes = engine.evaluate(new Map([
    [1, 'im.content === "hello"'],
    [2, 'im.sender.id === "nobody"'],
    [3, 'im.thread_id.length > 0'],
    [4, '(() => { while (true) {} })()'],
    [5, '(() => { im.content = "changed"; return true })()'],
    [6, '(globalThis.leak = 1, true)'],
    [7, 'im.content === "hello" && typeof globalThis.leak === "undefined"'],
    [8, '(() => { throw "plain" })()'],
  ]), input)
  assert.deepEqual(outcomes.get(1), { matched: true })
  assert.deepEqual(outcomes.get(2), { matched: false })
  assert.match(outcomes.get(3)?.error ?? '', /^TypeError/)
  assert.match(outcomes.get(4)?.error ?? '', /^InternalError/)
  // The fields are frozen: an assignment in strict mode throws.
  assert.match(outcomes.get(5)?.error ?? '', /^TypeError/)
  assert.deepEqual(outcomes.get(6), { matched: true })
  assert.deepEqual(outcomes.get(7), { matched: true })
  assert.deepEqual(outcomes.get(8), { matched: false, error: 'plain' })
  assert.equal(engine.evaluate(new Map(), input).size, 0)
})
