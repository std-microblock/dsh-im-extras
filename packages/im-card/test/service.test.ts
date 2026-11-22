import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { bundleCard } from '../src/bundle.ts'
import { CardService, CARD_BUTTON_PREFIX, requesterFrom } from '../src/service.ts'
import { vendor } from './vendor.ts'

const core = await vendor('plugin-im-core')

const CHAT = 'lark:test|oc_1'
const COUNTER = `
import { useState, useCard } from 'dsh:card'
export default function C() {
  const [n, setN] = useState(0)
  const card = useCard()
  return <message>
    <p>count {n}</p>
    <button onClick={() => { setN(n + 1); card.toast('ok ' + (n + 1), 'success') }}>+1</button>
    <button onClick={() => { card.send('done at ' + n); setN(100); card.close() }}>finish</button>
  </message>
}`

/** A fake ctx + im: an in-memory storage domain, a bot that records sends and edits. */
function harness() {
  const listeners = new Map<string, ((event: any) => void)[]>()
  const tables = new Map<string, Map<string, unknown>>()
  const domain = {
    table: (name: string) => {
      let t = tables.get(name)
      if (!t) tables.set(name, t = new Map())
      return {
        get: (k: string) => structuredClone(t!.get(k)),
        put: async (k: string, v: unknown) => { t!.set(k, structuredClone(v)) },
        keys: () => t!.keys(),
        entries: () => t!.entries(),
      }
    },
    close: async () => {},
  }
  const sent: any[] = []
  const edits: { id: string; text: string }[] = []
  const deliveries: any[] = []
  let seq = 0
  const handleOfCalls: { id: string; mode?: string; kind?: string }[] = []
  const bot = {
    id: 'lark:test',
    platform: 'lark',
    // An adapter that edits in place: the card service probes this hook.
    editPayload: async () => {},
    handleOf: (ref: any, mode: string, kind: string) => {
      handleOfCalls.push({ id: ref.id, mode, kind })
      return { bot: 'lark:test', target: { chat: ref.chat }, mode, parts: [{ id: ref.id, kind: kind ?? 'card-inline', time: 0 }], createdAt: 0, edits: 0, content: core.h('message') }
    },
    edit: async (handle: any, content: any) => {
      edits.push({ id: handle.parts[0].id, text: core.toText(content) })
      return { handle, report: {} }
    },
  }
  const ctx: any = {
    storageDomain: { open: async () => domain },
    on: (name: string, fn: any) => { listeners.set(name, [...(listeners.get(name) ?? []), fn]) },
    logger: { info() {}, warn: (...a: unknown[]) => { console.log('warn', ...a) } },
  }
  const im: any = {
    bot: () => bot,
    chat: () => ({ ref: { id: 'oc_1', type: 'group' } }),
    send: async (_chat: string, content: any) => {
      const id = `om_${++seq}`
      sent.push({ id, text: core.toText(content), content })
      return { status: 'confirmed', handle: { bot: 'lark:test', target: { chat: { id: 'oc_1', type: 'group' } }, mode: 'card', parts: [{ id, kind: 'card-inline', time: 0 }], createdAt: 0, edits: 0, content } }
    },
    sessions: { deliver: async (session: string, d: any) => { deliveries.push({ session, d }) } },
    // No stored messages: the card knows no requester unless a test supplies one.
    history: { latest: () => undefined, before: () => [], after: () => [], get: () => undefined },
  }
  const emit = (name: string, event: any) => { for (const fn of listeners.get(name) ?? []) fn(event) }
  return { ctx, im, sent, edits, deliveries, emit, tables, handleOfCalls }
}

function buttonsOf(content: any): string[] {
  const out: string[] = []
  const walk = (el: any) => { if (el.type === 'button' && el.attrs.type === 'action') out.push(el.attrs.id); el.children?.forEach(walk) }
  walk(content)
  return out
}

/** Every control of the card by tag, so a test can address the select it rendered. */
function controlsOf(content: any, tag: string): any[] {
  const out: any[] = []
  const walk = (el: any) => { if (el.type === tag) out.push(el); el.children?.forEach(walk) }
  walk(content)
  return out
}

const config = {
  maxLive: 4, memoryBytes: 16 << 20, cpuMs: 1000, editIntervalMs: 200, snapshotDelayMs: 50, maxModules: 4,
  maxSourceBytes: 1e5, agentPerMinute: 6, agentMaxChars: 2000, maxSlotsPerTurn: 4, wakeOnTimer: false,
  dataDir: '.dsh/im-card/data', filesMaxBytes: 1 << 20, fetchTimeoutMs: 5000, fetchMaxBytes: 1 << 20, fetchPerMinute: 20,
  fetchConcurrent: 3, fetchHosts: [], fetchAllowPrivate: false,
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

/** A card that ticks on its own: the one shape that would need a timer to keep running while the card is not loaded. */
const TICKER = `
import { useState, useEffect } from 'dsh:card'
export default function T() {
  const [n, setN] = useState(0)
  useEffect(() => { const id = setInterval(() => setN((v) => v + 1), 200); return () => clearInterval(id) }, [])
  return <message><p>tick {n}</p></message>
}`

/** Count the VM restores a service performs; a revive is the only thing that restores one. */
function countRestores(service: CardService): () => number {
  const engine = (service as any).engine
  const restore = engine.restore.bind(engine)
  let restores = 0
  engine.restore = (...args: unknown[]) => {
    restores++
    return restore(...args)
  }
  return () => restores
}

test('publish, click, toast, edit, persist, restart, click again, close', async () => {
  const h = harness()
  const service = new CardService(h.ctx, h.im, config)
  await service.open()
  const bundle = await bundleCard({ inline: COUNTER, cwd: '/w' }, { read: async () => undefined }, { maxModules: 4, maxBytes: 1e5 })
  const published = await service.publish({ bundle, props: {}, session: 'im-s1' as any, chat: CHAT as any })
  assert.equal(published.status, 'confirmed')
  assert.match(h.sent[0].text, /count 0/)
  const [inc, finish] = buttonsOf(h.sent[0].content)
  assert.ok(inc?.startsWith(`${CARD_BUTTON_PREFIX}${published.id}:`))

  const answers: any[] = []
  const click = (id: string) => h.emit('im/button', {
    id, user: { id: 'ou_a' }, time: Date.now(),
    raw: { id: `ev${Math.random()}`, respond: async (a: any) => { answers.push(a) }, defer() {} },
  })
  click(inc!)
  await wait(400)
  assert.deepEqual(answers.at(-1), { toast: { type: 'success', content: 'ok 1' } })
  assert.match(h.edits.at(-1)!.text, /count 1/)
  await wait(200)
  assert.ok((h.tables.get('cards')!.get(published.id) as any).snapshot, 'snapshot persisted')

  // "Restart": a new service over the same store; the click revives the VM from its snapshot and runs.
  await service.dispose()
  const again = new CardService(h.ctx, h.im, config)
  await again.open()
  click(inc!)
  await wait(500)
  assert.match(h.edits.at(-1)!.text, /count 2/, 'state survived the restart and the old token still works')
  assert.deepEqual(h.handleOfCalls.at(-1), { id: h.sent[0].id, mode: 'card', kind: 'card-inline' },
    'the handle is rebuilt in the mode and part kind the publication reported')

  click(finish!)
  await wait(600)
  assert.equal(h.deliveries.length, 1)
  assert.match(h.deliveries[0].d.content[0].text, /done at 2/)
  assert.match(h.edits.at(-1)!.text, /count 100/, 'state set together with close() is shown')
  const record = h.tables.get('cards')!.get(published.id) as any
  assert.equal(record.closed, true)
  click(inc!)
  await wait(200)
  assert.equal(answers.at(-1).toast.type, 'warning', 'a closed card answers that it expired')
  await again.dispose()
})

test('a snapshot from another build re-runs the card and drops the click', async () => {
  const h = harness()
  const service = new CardService(h.ctx, h.im, config)
  await service.open()
  const bundle = await bundleCard({ inline: COUNTER, cwd: '/w' }, { read: async () => undefined }, { maxModules: 4, maxBytes: 1e5 })
  const published = await service.publish({ bundle, props: {}, session: 'im-s1' as any, chat: CHAT as any })
  await wait(150)
  await service.dispose()
  const cards = h.tables.get('cards')!
  const record = cards.get(published.id) as any
  record.snapshot.baseline = 'other-build'
  cards.set(published.id, record)
  const again = new CardService(h.ctx, h.im, config)
  await again.open()
  const answers: any[] = []
  h.emit('im/button', {
    id: buttonsOf(h.sent[0].content)[0], user: { id: 'ou_a' }, time: Date.now(),
    raw: { id: 'e1', respond: async (a: any) => { answers.push(a) }, defer() {} },
  })
  await wait(500)
  assert.match(answers[0].toast.content, /重新加载/)
  assert.match(h.edits.at(-1)!.text, /count 0/)
  await again.dispose()
})

test('hot reload swaps the code in place with fresh state; broken code leaves the card running', async () => {
  const h = harness()
  const service = new CardService(h.ctx, h.im, config)
  await service.open()
  const read = { read: async () => undefined }
  const v1 = await bundleCard({ inline: COUNTER, cwd: '/w' }, read, { maxModules: 4, maxBytes: 1e5 })
  const published = await service.publish({ bundle: v1, props: {}, session: 'im-s1' as any, chat: CHAT as any })
  const [inc] = buttonsOf(h.sent[0].content)
  h.emit('im/button', { id: inc, user: { id: 'u' }, time: 0, raw: { id: 'e1', respond: async () => {}, defer() {} } })
  await wait(300)
  assert.match(h.edits.at(-1)!.text, /count 1/)

  const v2 = await bundleCard({ inline: COUNTER.replace('count {n}', 'total {n}'), cwd: '/w' }, read, { maxModules: 4, maxBytes: 1e5 })
  await service.reload({ card: published.id, bundle: v2, session: 'im-s1' as any })
  assert.match(h.edits.at(-1)!.text, /total 0/, 'new code, fresh state, same message')
  assert.equal(h.edits.at(-1)!.id, h.sent[0].id)

  const broken = await bundleCard({ inline: 'export default () => { throw new Error("boom") }', cwd: '/w' }, read, { maxModules: 4, maxBytes: 1e5 })
  await assert.rejects(service.reload({ card: published.id, bundle: broken, session: 'im-s1' as any }), /boom/)
  await assert.rejects(service.reload({ card: published.id, bundle: v2, session: 'im-other' as any }), /another session/)
  await service.dispose()
})

test('a restart revives each stored card once instead of cycling through them', async () => {
  const h = harness()
  // `wakeOnTimer` is the deployment that records due times, so it is also the one a restart used to spin in.
  const timed = { ...config, wakeOnTimer: true }
  const service = new CardService(h.ctx, h.im, timed)
  await service.open()
  const bundle = await bundleCard({ inline: COUNTER, cwd: '/w' }, { read: async () => undefined }, { maxModules: 4, maxBytes: 1e5 })
  // More open cards than `maxLive` (4): the rest of this test is about what a restart does with them.
  for (let index = 0; index < 6; index++) {
    await service.publish({ bundle, props: {}, session: 'im-s1' as any, chat: CHAT as any })
  }
  await service.dispose()

  // Restart. Every card carries a snapshot and no recorded due time, so the service revives each one once to learn
  // whether it holds timers. These cards hold none, so a revive must settle them: a card whose stored due time
  // survives its own revival is woken again by the eviction that makes room for it, and the store cycles forever.
  const again = new CardService(h.ctx, h.im, timed)
  await again.open()
  const restores = countRestores(again)
  await wait(600)
  const settled = restores()
  assert.ok(settled <= 6, `six cards revive at most once each, saw ${settled} restores`)
  await wait(400)
  assert.equal(restores(), settled, 'no card is woken again after the restart settled')
  await again.dispose()
})

test('a timer of a freed card does not bring it back', async () => {
  const h = harness()
  const service = new CardService(h.ctx, h.im, config)
  await service.open()
  const restores = countRestores(service)
  const read = { read: async () => undefined }
  const ticker = await bundleCard({ inline: TICKER, cwd: '/w' }, read, { maxModules: 4, maxBytes: 1e5 })
  const filler = await bundleCard({ inline: COUNTER, cwd: '/w' }, read, { maxModules: 4, maxBytes: 1e5 })
  const published = await service.publish({ bundle: ticker, props: {}, session: 'im-s1' as any, chat: CHAT as any })
  assert.match(h.sent[0].text, /tick 0/)
  // Four more cards push the ticker out of `maxLive`, so its VM is freed with a tick still pending.
  for (let index = 0; index < 4; index++) {
    await service.publish({ bundle: filler, props: {}, session: 'im-s1' as any, chat: CHAT as any })
  }
  const record = h.tables.get('cards')!.get(published.id) as any
  assert.equal(record.wake, undefined, 'a card whose timers cannot wake it stores no due time')
  const editsBefore = h.edits.length
  await wait(600)
  assert.equal(restores(), 0, 'no due timer revived the freed card')
  assert.equal(h.edits.length, editsBefore, 'the freed card was not republished')
  await service.dispose()
})

test('with wakeOnTimer a due timer revives the card it belongs to', async () => {
  const h = harness()
  const service = new CardService(h.ctx, h.im, { ...config, wakeOnTimer: true })
  await service.open()
  const restores = countRestores(service)
  const read = { read: async () => undefined }
  const ticker = await bundleCard({ inline: TICKER, cwd: '/w' }, read, { maxModules: 4, maxBytes: 1e5 })
  const filler = await bundleCard({ inline: COUNTER, cwd: '/w' }, read, { maxModules: 4, maxBytes: 1e5 })
  const published = await service.publish({ bundle: ticker, props: {}, session: 'im-s1' as any, chat: CHAT as any })
  for (let index = 0; index < 4; index++) {
    await service.publish({ bundle: filler, props: {}, session: 'im-s1' as any, chat: CHAT as any })
  }
  const record = h.tables.get('cards')!.get(published.id) as any
  assert.ok(record.wake > Date.now(), 'the freed card stored the moment its tick is due')
  const editsBefore = h.edits.length
  await wait(700)
  assert.ok(restores() > 0, 'the due timer revived the card')
  assert.ok(h.edits.length > editsBefore, 'the revived card ticked and republished itself')
  await service.dispose()
})

const PICKER = `
import { useState } from 'dsh:card'
export default function P() {
  const [picked, setPicked] = useState('-')
  const [sent, setSent] = useState('-')
  return <message>
    <p>picked {picked} sent {sent}</p>
    <select name="size" onSelect={(e) => setPicked(e.values.join('+'))}>
      <option value="s">Small</option>
      <option value="l">Large</option>
    </select>
    <form name="order">
      <input name="title" label="Title" />
      <button type="submit" onClick={(e) => setSent(String(e.values?.title ?? '-'))}>Send</button>
    </form>
  </message>
}`

test('a select pick and a form submit reach their handlers', async () => {
  const h = harness()
  const service = new CardService(h.ctx, h.im, config)
  await service.open()
  const bundle = await bundleCard({ inline: PICKER, cwd: '/w' }, { read: async () => undefined }, { maxModules: 4, maxBytes: 1e5 })
  const published = await service.publish({ bundle, props: {}, session: 'im-s1' as any, chat: CHAT as any })
  assert.match(h.sent[0].text, /picked - sent -/)

  const answers: any[] = []
  const respond = async (a: any) => { answers.push(a) }
  const raw = (id: string) => ({ id, respond, defer() {} })

  const [size] = controlsOf(h.sent[0].content, 'select')
  assert.ok(String(size.attrs.id).startsWith(`${CARD_BUTTON_PREFIX}${published.id}:`), 'the handled select is routed')
  assert.equal(size.attrs.name, 'size', 'the form key survives')
  h.emit('im/select', { id: size.attrs.id, values: ['l'], user: { id: 'ou_a' }, time: Date.now(), raw: raw('ev1') })
  await wait(400)
  assert.match(h.edits.at(-1)!.text, /picked l sent -/)
  assert.deepEqual(answers.at(-1), {})

  const [submit] = controlsOf(h.sent[0].content, 'button').filter((el: any) => el.attrs.type === 'submit')
  assert.ok(String(submit.attrs.id).startsWith(`${CARD_BUTTON_PREFIX}${published.id}:`))
  h.emit('im/button', {
    id: submit.attrs.id, values: { title: 'Weekly' }, user: { id: 'ou_a' }, time: Date.now(), raw: raw('ev2'),
  })
  await wait(400)
  assert.match(h.edits.at(-1)!.text, /picked l sent Weekly/)

  // A pick that reaches no handler is silent: a select without `onSelect` legitimately only feeds its form, so it
  // must not republish the card the way a stale button does.
  const editsBefore = h.edits.length
  h.emit('im/select', {
    id: `${CARD_BUTTON_PREFIX}${published.id}:unknown`, values: ['x'], user: { id: 'ou_a' }, time: Date.now(), raw: raw('ev3'),
  })
  await wait(400)
  assert.equal(h.edits.length, editsBefore)
  assert.deepEqual(answers.at(-1), {})
  await service.dispose()
})

const CHECKER = `
import { useState } from 'dsh:card'
export default function C() {
  const [agreed, setAgreed] = useState(false)
  return <message>
    <p>agreed {agreed ? 'yes' : 'no'}</p>
    <input name="agree" type="checkbox" label="Agree" value={agreed} onChange={(e) => setAgreed(e.checked)} />
  </message>
}`

test('a checkbox toggle reaches its handler', async () => {
  const h = harness()
  const service = new CardService(h.ctx, h.im, config)
  await service.open()
  const bundle = await bundleCard({ inline: CHECKER, cwd: '/w' }, { read: async () => undefined }, { maxModules: 4, maxBytes: 1e5 })
  const published = await service.publish({ bundle, props: {}, session: 'im-s1' as any, chat: CHAT as any })
  assert.match(h.sent[0].text, /agreed no/)

  // The checkbox is the one form control whose toggle is routed: its token is minted even without a form.
  const [box] = controlsOf(h.sent[0].content, 'input')
  assert.ok(String(box.attrs.id).startsWith(`${CARD_BUTTON_PREFIX}${published.id}:`), 'the handled checkbox is routed')
  assert.equal(box.attrs.name, 'agree')

  const answers: any[] = []
  h.emit('im/check', {
    id: box.attrs.id, checked: true, user: { id: 'ou_a' }, time: Date.now(),
    raw: { id: 'ev1', respond: async (a: any) => { answers.push(a) }, defer() {} },
  })
  await wait(400)
  assert.match(h.edits.at(-1)!.text, /agreed yes/)
  assert.deepEqual(answers.at(-1), {})
  await service.dispose()
})

const STORED = `
import { useStoredState } from 'dsh:card'
export default function S() {
  const [n, setN] = useStoredState('count.json', 0)
  return <message>
    <p>n {n}</p>
    <button onClick={() => setN(n + 1)}>+1</button>
  </message>
}`

/** A click on the first button of the last sent card, answered the way the platform does. */
function press(h: ReturnType<typeof harness>, content: any): void {
  const [token] = buttonsOf(content)
  h.emit('im/button', {
    id: token, user: { id: 'ou_a' }, time: Date.now(), raw: { id: 'ev1', respond: async () => {}, defer() {} },
  })
}

test('a card keeps a value in its data folder, and a second card reads it', async () => {
  const h = harness()
  const dir = mkdtempSync(join(tmpdir(), 'im-card-service-'))
  try {
    const service = new CardService(h.ctx, h.im, config)
    await service.open()
    const bundle = await bundleCard({ inline: STORED, cwd: dir }, { read: async () => undefined }, { maxModules: 4, maxBytes: 1e5 })
    await service.publish({ bundle, props: {}, session: 'im-s1' as any, chat: CHAT as any, cwd: dir })
    assert.match(h.sent[0].text, /n 0/)

    press(h, h.sent[0].content)
    await wait(400)
    assert.match(h.edits.at(-1)!.text, /n 1/)
    const file = join(dir, '.dsh/im-card/data/count.json')
    assert.equal(JSON.parse(readFileSync(file, 'utf8')), 1, 'the value is written where the operator put the folder')

    // Another card from the same working directory starts from that file, not from `0`.
    await service.publish({ bundle, props: {}, session: 'im-s1' as any, chat: CHAT as any, cwd: dir })
    assert.match(h.sent[1].text, /n 1/)
    await service.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const ASKER = `
import { useState } from 'dsh:card'
export default function A() {
  const [line, setLine] = useState('-')
  return <message>
    <p>line {line}</p>
    <button onClick={() => {
      fetch('http://127.0.0.1:PORT/answer')
        .then((r) => r.text())
        .then((text) => setLine(text))
        .catch((e) => setLine('error ' + e.message))
    }}>ask</button>
  </message>
}`

test('a card fetches through the service and the answer republishes it', async () => {
  const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('fetched') })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  const h = harness()
  try {
    const service = new CardService(h.ctx, h.im, { ...config, fetchAllowPrivate: true })
    await service.open()
    const source = ASKER.replace('PORT', String(address.port))
    const bundle = await bundleCard({ inline: source, cwd: '/w' }, { read: async () => undefined }, { maxModules: 4, maxBytes: 1e5 })
    await service.publish({ bundle, props: {}, session: 'im-s1' as any, chat: CHAT as any })
    assert.match(h.sent[0].text, /line -/)

    press(h, h.sent[0].content)
    await wait(700)
    assert.match(h.edits.at(-1)!.text, /line fetched/)
    await service.dispose()
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => { server.close(() => { resolve() }) })
  }
})

test('a card may not reach a private address when the deployment forbids it', async () => {
  const server = createServer((_req, res) => { res.writeHead(200); res.end('internal') })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  const h = harness()
  try {
    const service = new CardService(h.ctx, h.im, config)
    await service.open()
    const source = ASKER.replace('PORT', String(address.port))
    const bundle = await bundleCard({ inline: source, cwd: '/w' }, { read: async () => undefined }, { maxModules: 4, maxBytes: 1e5 })
    await service.publish({ bundle, props: {}, session: 'im-s1' as any, chat: CHAT as any })

    press(h, h.sent[0].content)
    await wait(500)
    assert.match(h.edits.at(-1)!.text, /line error 127\.0\.0\.1 resolves to a private address/)
    await service.dispose()
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => { server.close(() => { resolve() }) })
  }
})

test('a card names the newest person of the chat as its requester, never a bot', async () => {
  const h = harness()
  const messages = [
    { seq: 1, sender: { id: 'ou_person', name: '张三' } },
    { seq: 2, sender: { id: 'ou_alert', name: '告警机器人', isBot: true } },
    { seq: 3, sender: { id: 'ou_alert2', isBot: true } },
    { seq: 4, sender: { id: 'ou_self', isBot: true, self: true } },
  ]
  h.im.history = {
    latest: () => messages.at(-1),
    before: (_chat: string, before: number) => messages.filter((m) => m.seq < before),
    after: () => [],
    get: () => undefined,
  }
  const service = new CardService(h.ctx, h.im, config)
  await service.open()
  const bundle = await bundleCard(
    { inline: COUNTER, cwd: '/w' }, { read: async () => undefined }, { maxModules: 4, maxBytes: 1e5 },
  )

  const published = await service.publish({ bundle, props: {}, session: 'im-s1' as any, chat: CHAT as any })
  assert.deepEqual((service as any).table().get(published.id).requester, { id: 'ou_person', name: '张三' })

  // A chat whose only writers are bots names nobody: naming one would restrict the card's buttons to somebody who can
  // never press one, which is how an alert-triggered card silently refused every click.
  h.im.history = {
    latest: () => messages[3],
    before: () => messages.slice(1),
    after: () => [],
    get: () => undefined,
  }
  const second = await service.publish({ bundle, props: {}, session: 'im-s2' as any, chat: CHAT as any })
  assert.equal((service as any).table().get(second.id).requester, undefined)

  // The trigger sender of a turn is read by the same function, so this is the whole rule.
  assert.equal(requesterFrom({ id: 'ou_alert', name: '告警机器人', isBot: true }), undefined)
  assert.equal(requesterFrom({ id: 'ou_self', self: true }), undefined)
  assert.equal(requesterFrom({ id: '' }), undefined)
  assert.equal(requesterFrom(undefined), undefined)
  assert.deepEqual(requesterFrom({ id: 'ou_person', name: '张三' }), { id: 'ou_person', name: '张三' })
  assert.deepEqual(requesterFrom({ id: 'ou_person' }), { id: 'ou_person' })

  await service.dispose()
})

test('registerGuard, registerAction, and pushEvent work across clicks and async host updates', async () => {
  const h = harness()
  const service = new CardService(h.ctx, h.im, config)
  await service.open()
  const guardCalls: string[] = []
  const disposeGuard = service.registerGuard(({ user }) => {
    guardCalls.push(user.id)
    return user.id === 'ou_owner' ? { ok: true } : { ok: false, toast: '会话已被独占' }
  })
  const disposeDescribe = service.registerAction('auth:describe', () => ({
    ok: true,
    capabilities: [{ id: 'feishu-project', title: '飞书项目', description: '读取工作项' }],
  }))
  const actionContexts: any[] = []
  const disposeGrant = service.registerAction('auth:grant', (ctx) => {
    actionContexts.push(ctx)
    return {
      ok: true,
      toast: '已发送私聊登录',
      state: {
        status: 'pending',
        owner: ctx.user,
        actor: ctx.user,
        items: [{ id: 'feishu-project', title: '飞书项目', status: 'pending', message: '请在私聊完成登录' }],
      },
    }
  })

  const bundle = await bundleCard({
    inline: `export default () => <message><AuthRequest capabilities={["feishu-project"]} reason="需要查单" /></message>`,
    cwd: '/w',
  }, { read: async () => undefined }, { maxModules: 4, maxBytes: 1e5 })
  const published = await service.publish({
    bundle, props: {}, session: 'im-s1' as any, chat: CHAT as any, requester: { id: 'ou_owner', name: '张三' },
  })
  assert.equal(published.status, 'confirmed')
  assert.match(h.sent[0].text, /飞书项目/)

  const [grantBtn] = buttonsOf(h.sent[0].content)
  const answers: any[] = []
  h.emit('im/button', {
    id: grantBtn!, user: { id: 'ou_stranger', name: '路人' }, time: Date.now(),
    raw: { id: 'ev1', respond: async (a: any) => { answers.push(a) }, defer() {} },
  })
  await wait(200)
  assert.deepEqual(answers.at(-1), { toast: { type: 'warning', content: '会话已被独占' } })
  assert.equal(h.edits.length, 0, 'blocked click never enters VM')

  h.emit('im/button', {
    id: grantBtn!, user: { id: 'ou_owner', name: '张三' }, time: Date.now(),
    raw: { id: 'ev2', respond: async (a: any) => { answers.push(a) }, defer() {} },
  })
  await wait(400)
  assert.deepEqual(answers.at(-1), { toast: { type: 'success', content: '已发送私聊登录' } })
  assert.match(h.edits.at(-1)!.text, /等待 张三 在私聊中完成登录/)

  const handled = await service.pushEvent(published.id, 'auth', {
    status: 'granted',
    owner: { id: 'ou_owner', name: '张三' },
    actor: { id: 'ou_owner', name: '张三' },
    items: [{ id: 'feishu-project', title: '飞书项目', status: 'active' }],
  })
  assert.equal(handled, true)
  await wait(400)
  assert.match(h.edits.at(-1)!.text, /已授权并独占会话/)
  assert.deepEqual(guardCalls, ['ou_stranger', 'ou_owner'])
  assert.equal(actionContexts.at(-1)?.message, 'lark:test|om_1')

  disposeGuard()
  disposeDescribe()
  disposeGrant()
  await service.dispose()
})
