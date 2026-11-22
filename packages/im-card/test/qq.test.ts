/**
 * The card service on QQ: markdown with a keyboard, no in-place edits, no toasts, no form controls. The bot renders
 * through the real QQ markdown mode (`plugin-im-adapter-qq`), so the capability probe, the render notes and the
 * keyboard limits are the adapter's own; publishing is faked.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { bundleCard } from '../src/bundle.ts'
import { CardService, CARD_BUTTON_PREFIX, routedId } from '../src/service.ts'
import { vendor } from './vendor.ts'

const core = await vendor('plugin-im-core')
const qq = await vendor('plugin-im-adapter-qq')

const CHAT = 'qq:test|group:g1'
const REF = { id: 'group:g1', type: 'group' }
const COUNTER = `
import { useState, useCard } from 'dsh:card'
export default function C() {
  const [n, setN] = useState(0)
  const card = useCard()
  return <message>
    <p>count {n} on {card.platform.name} edit {String(card.platform.edit)} forms {String(card.platform.forms)}</p>
    <button onClick={() => { setN(n + 1); card.toast('ok ' + (n + 1), 'success') }}>+1</button>
    <button onClick={() => { setN(n) }}>same</button>
  </message>
}`
const TICKER = `
import { useState, useEffect } from 'dsh:card'
export default function T() {
  const [n, setN] = useState(0)
  useEffect(() => { const id = setInterval(() => setN((v) => v + 1), 100); return () => clearInterval(id) }, [])
  return <message><p>tick {n}</p></message>
}`
const FORM = `export default () => <message><PromptForm fields={[
  { name: "size", label: "尺寸", type: "select", options: ["S", "L"] },
  { name: "urgent", label: "加急", type: "checkbox" },
  { name: "note", label: "备注" },
]} prompt="尺寸 {size} 加急 {urgent} 备注 {note}" /></message>`

const config = {
  maxLive: 4, memoryBytes: 16 << 20, cpuMs: 1000, editIntervalMs: 200, snapshotDelayMs: 50, maxModules: 4,
  maxSourceBytes: 1e5, agentPerMinute: 6, agentMaxChars: 2000, maxSlotsPerTurn: 4, wakeOnTimer: true,
  dataDir: '', filesMaxBytes: 1 << 20, fetchTimeoutMs: 5000, fetchMaxBytes: 1 << 20, fetchPerMinute: 20,
  fetchConcurrent: 3, fetchHosts: [], fetchAllowPrivate: false,
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
const read = { read: async () => undefined }
const LIMITS = { maxModules: 4, maxBytes: 1e5 }

/** A QQ bot whose `render` is the real markdown mode (with or without a keyboard) and whose sends are recorded. */
function harness(keyboard = true) {
  const modes = qq.QQBot.prototype.createModes.call({
    config: { linkPolicy: 'text', passive: { groupReplies: 5, c2cReplies: 4 } }, keyboardEnabled: keyboard,
  })
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
  let seq = 0
  const published = (content: any) => {
    const id = `qm_${++seq}`
    return { bot: 'qq:test', target: { chat: REF }, mode: 'markdown', parts: [{ id, kind: 'message', time: 0 }], createdAt: Date.now(), edits: 0, content }
  }
  const sent: { id: string; text: string; content: any }[] = []
  const resent: { id: string; text: string; referrer: unknown; session?: string; content: any }[] = []
  const deleted: string[] = []
  const handleOfCalls: unknown[][] = []
  const render = (target: any, content: any) => {
    const { content: stripped } = core.splitDirectives(content)
    const result = core.transform(core.normalize(stripped), { bot, target, mode: modes.markdown })
    return { mode: 'markdown', payloads: result.msgs, report: result.report }
  }
  const bot: any = {
    id: 'qq:test',
    platform: 'qq',
    modes,
    render: async (target: any, content: any) => render(target, content),
    handleOf: (ref: any, mode?: string, kind?: string) => {
      handleOfCalls.push([ref.id, mode, kind])
      return { bot: 'qq:test', target: { chat: ref.chat }, mode: mode ?? 'text', parts: [{ id: ref.id, kind: kind ?? 'message', time: 0 }], createdAt: Date.now(), edits: 0, content: core.h('message') }
    },
    edit: async () => { throw new Error('qq: the adapter cannot edit messages') },
    // Every publication goes through `ctx.im.send`; a direct bot send would skip the store and `im/before-send`.
    send: async () => { throw new Error('the card service must publish through ctx.im.send') },
    delete: async (handle: any) => { deleted.push(handle.parts[0].id) },
  }
  const ctx: any = {
    storageDomain: { open: async () => domain },
    on: (name: string, fn: any) => { listeners.set(name, [...(listeners.get(name) ?? []), fn]) },
    logger: { info() {}, warn() {} },
  }
  const im: any = {
    bot: () => bot,
    chat: () => ({ ref: REF }),
    send: async (_chat: string, content: any, options: any = {}) => {
      const handle = published(content)
      // An answer to a click carries the click's referrer; the first publication of a card carries none.
      if (options.referrer !== undefined) {
        resent.push({ id: handle.parts[0]!.id, text: core.toText(content), referrer: options.referrer, session: options.session, content })
      } else sent.push({ id: handle.parts[0]!.id, text: core.toText(content), content })
      return { status: 'confirmed', handle }
    },
    sessions: { deliver: async () => {} },
    history: { latest: () => undefined, before: () => [], after: () => [], get: () => undefined },
  }
  const emit = (name: string, event: any) => { for (const fn of listeners.get(name) ?? []) fn(event) }
  return { ctx, im, bot, sent, resent, deleted, handleOfCalls, emit, tables }
}

function buttonsOf(content: any): string[] {
  const out: string[] = []
  const walk = (el: any) => { if (el.type === 'button' && el.attrs.type === 'action') out.push(el.attrs.id); el.children?.forEach(walk) }
  walk(content)
  return out
}

/** A QQ click: no `respond`, a referrer carrying the click's event id, and the message the keyboard belonged to. */
function qqClick(id: string, message: string, event = `ev${Math.random()}`) {
  return {
    id, user: { id: 'u_member' }, time: Date.now(), bot: { id: 'qq:test' },
    raw: { id: event, referrer: { event_id: event, chatId: REF.id }, message: { id: message, chat: REF }, defer() {} },
  }
}

test('QQ: the card is published in markdown, probed as not editable, and its mode is recorded', async () => {
  const h = harness()
  const service = new CardService(h.ctx, h.im, config)
  await service.open()
  const bundle = await bundleCard({ inline: COUNTER, cwd: '/w' }, read, LIMITS)
  const { notes } = await service.rehearse({ bundle, props: {}, chat: CHAT as any })
  assert.ok(notes.some(note => /cannot edit/.test(note)), 'the model learns that the card is resent on clicks')
  assert.ok(notes.some(note => /toast/.test(note)))
  assert.ok(!notes.some(note => /Not clickable/.test(note)), 'keyboard buttons are clickable')
  const published = await service.publish({ bundle, props: {}, session: 'im-s1' as any, chat: CHAT as any })
  assert.equal(published.status, 'confirmed')
  assert.match(h.sent[0]!.text, /count 0 on qq edit false forms false/)
  const record = h.tables.get('cards')!.get(published.id) as any
  assert.equal(record.mode, 'markdown')
  assert.equal(record.partKind, 'message')
  assert.deepEqual(record.platform, { name: 'qq', edit: false, buttons: true, forms: false, toast: false })
  await service.dispose()
})

test('QQ: a click resends the card as a passive reply, recalls the old message, and old copies go inert', async () => {
  const h = harness()
  const service = new CardService(h.ctx, h.im, config)
  await service.open()
  const bundle = await bundleCard({ inline: COUNTER, cwd: '/w' }, read, LIMITS)
  const published = await service.publish({ bundle, props: {}, session: 'im-s1' as any, chat: CHAT as any })
  const first = h.sent[0]!
  const [inc] = buttonsOf(first.content)
  assert.ok(inc?.startsWith(`${CARD_BUTTON_PREFIX}${published.id}:`))

  // Some QQ clients omit `button_id`: the adapter then reports the id up to the first `:` and the whole data.
  const click = qqClick('dsh', first.id, 'e1')
  Object.assign(click, { data: inc })
  assert.equal(routedId(click), inc)
  h.emit('im/button', click)
  await wait(400)
  assert.equal(h.resent.length, 1, 'the click is answered with the new state')
  assert.match(h.resent[0]!.text, /count 1/)
  assert.deepEqual(h.resent[0]!.referrer, { event_id: 'e1', chatId: REF.id }, 'through the click (a passive reply)')
  assert.equal(h.resent[0]!.session, 'im-s1', 'under the session that owns the card, through ctx.im.send')
  assert.deepEqual(h.deleted, [first.id], 'the old copy is recalled')
  const record = h.tables.get('cards')!.get(published.id) as any
  assert.equal(record.message, h.resent[0]!.id, 'the card now lives in the new message')

  // The old copy (if the platform kept it) no longer drives the card.
  h.emit('im/button', qqClick(inc!, first.id, 'e2'))
  await wait(300)
  assert.equal(h.resent.length, 1)

  // A click that changes nothing sends nothing.
  const [, same] = buttonsOf(h.resent[0]!.content)
  h.emit('im/button', qqClick(same!, h.resent[0]!.id, 'e3'))
  await wait(300)
  assert.equal(h.resent.length, 1)

  // After a restart the old message is rebuilt in the recorded mode for the recall.
  await service.dispose()
  const again = new CardService(h.ctx, h.im, config)
  await again.open()
  const [inc2] = buttonsOf(h.resent[0]!.content)
  h.emit('im/button', qqClick(inc2!, h.resent[0]!.id, 'e4'))
  await wait(500)
  assert.equal(h.resent.length, 2)
  assert.match(h.resent[1]!.text, /count 2/)
  assert.deepEqual(h.handleOfCalls.at(-1), [h.resent[0]!.id, 'markdown', 'message'])
  assert.deepEqual(h.deleted, [first.id, h.resent[0]!.id])
  await again.dispose()
})

test('QQ: resends are bounded per card, and a toast becomes a one-line reply only when configured', async () => {
  const h = harness()
  const service = new CardService(h.ctx, h.im, { ...config, replaceLimit: 2, toastFallback: 'text' as const })
  await service.open()
  const bundle = await bundleCard({ inline: COUNTER, cwd: '/w' }, read, LIMITS)
  await service.publish({ bundle, props: {}, session: 'im-s1' as any, chat: CHAT as any })
  let current = h.sent[0]!
  for (let index = 0; index < 3; index++) {
    const [inc] = buttonsOf(current.content)
    h.emit('im/button', qqClick(inc!, current.id))
    await wait(400)
    current = h.resent.filter(entry => entry.text.includes('count')).at(-1) ?? current
  }
  const cards = h.resent.filter(entry => entry.text.includes('count'))
  const toasts = h.resent.filter(entry => entry.text.startsWith('ok '))
  assert.equal(cards.length, 2, 'the third change waits for a later click')
  assert.deepEqual(toasts.map(entry => entry.text), ['ok 1', 'ok 2', 'ok 3'])
  await service.dispose()
})

test('QQ: timers never republish the card, even with wakeOnTimer', async () => {
  const h = harness()
  const service = new CardService(h.ctx, h.im, config)
  await service.open()
  const bundle = await bundleCard({ inline: TICKER, cwd: '/w' }, read, LIMITS)
  const published = await service.publish({ bundle, props: {}, session: 'im-s1' as any, chat: CHAT as any })
  await wait(500)
  assert.equal(h.resent.length, 0)
  assert.deepEqual(h.deleted, [])
  await wait(100)
  const record = h.tables.get('cards')!.get(published.id) as any
  assert.ok(record.snapshot, 'the ticks still change (and persist) the card state')
  await service.dispose()
})

test('QQ: PromptForm falls back to buttons with a keyboard, and to a reply template without one', async () => {
  const h = harness()
  const service = new CardService(h.ctx, h.im, config)
  await service.open()
  const bundle = await bundleCard({ inline: FORM, cwd: '/w' }, read, LIMITS)
  const { notes } = await service.rehearse({ bundle, props: {}, chat: CHAT as any })
  assert.ok(!notes.some(note => /Not clickable/.test(note)), `the form renders without lost interactions: ${notes.join(' | ')}`)
  await service.publish({ bundle, props: {}, session: 'im-s1' as any, chat: CHAT as any })
  const tags = new Set<string>()
  const walk = (el: any) => { tags.add(el.type); el.children?.forEach(walk) }
  walk(h.sent[0]!.content)
  assert.ok(!tags.has('form') && !tags.has('select'), 'no native form controls on QQ')
  const labels: string[] = []
  const collect = (el: any) => {
    if (el.type === 'button') labels.push(el.children.map((child: any) => core.toText(child)).join(''))
    el.children?.forEach(collect)
  }
  collect(h.sent[0]!.content)
  assert.ok(labels.includes('S') && labels.includes('L'), `the select became an option row: ${labels.join(', ')}`)
  assert.ok(labels.includes('提交'))
  assert.match(h.sent[0]!.text, /请直接在聊天中回复/)
  await service.dispose()

  const bare = harness(false)
  const plain = new CardService(bare.ctx, bare.im, config)
  await plain.open()
  const checked = await plain.rehearse({ bundle, props: {}, chat: CHAT as any })
  assert.ok(checked.notes.some(note => /not clickable/i.test(note)), 'without a keyboard the platform has no buttons')
  await plain.publish({ bundle, props: {}, session: 'im-s1' as any, chat: CHAT as any })
  assert.match(bare.sent[0]!.text, /请按下面的格式直接回复/)
  assert.deepEqual(buttonsOf(bare.sent[0]!.content), [], 'a reply template has no buttons')
  await plain.dispose()
})
