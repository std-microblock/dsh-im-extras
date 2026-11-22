/**
 * The im-card skill: every example card and every complete card block of SKILL.md (```tsx / ```satori-tsx fences)
 * bundles, renders, validates as message content, survives a click on its first action button, and fits the Lark
 * card limits (≤ 200 elements, ≤ 30 KB) through the real Lark card mode.
 */
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { bundleCard, normalizePath, type CardBundle, type CardFiles } from '../src/bundle.ts'
import { vendor } from './vendor.ts'
import { CardEngine, type CardNode, type CardVmHost } from '../src/engine.ts'

const core = await vendor('plugin-im-core')
const lark = await vendor('plugin-im-adapter-lark')
type El = { type: string; attrs: Record<string, unknown>; children: El[] }
const h = core.h as ((tag: string, attrs: Record<string, unknown>, ...kids: El[]) => El) & { text(s: string): El }
const normalize = core.normalize as (el: El) => El
// `createCardMode` is not exported from the built lib; `LarkBot#createCardMode` only reads `this.config`.
const cardMode = lark.LarkBot.prototype.createCardMode.call({ config: {} })

const SKILL_DIR = fileURLToPath(new URL('../skill/', import.meta.url))
const files: CardFiles = { read: path => readFile(path, 'utf8').catch(() => undefined) }
const LIMITS = { maxModules: 16, maxBytes: 256 * 1024 }

/** The data folder every checked card shares: an example may use `fs` / `useStoredState` exactly as the skill teaches. */
const store = new Map<string, string>()

/** The card's data folder in memory; paths are refused the way the real host refuses them. */
function fileReply(request: { op: string; path: string; text?: string }): { ok: boolean; value?: unknown; error?: string } {
  const path = request.path
  if (path.startsWith('/') || path.split('/').includes('..')) return { ok: false, error: `path escapes the card folder: ${path}` }
  switch (request.op) {
    case 'read': return { ok: true, value: store.get(path) }
    case 'write': store.set(path, String(request.text ?? '')); return { ok: true }
    case 'append': store.set(path, (store.get(path) ?? '') + String(request.text ?? '')); return { ok: true }
    case 'remove': store.delete(path); return { ok: true }
    case 'stat': return { ok: true, value: store.has(path) }
    case 'list': return { ok: true, value: [] }
    default: return { ok: false, error: `unknown file operation ${request.op}` }
  }
}

function recorder(): CardVmHost & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    schedule: () => { calls.push('schedule') },
    timers: () => {},
    toast: (content, type) => { calls.push(`toast ${type} ${content}`) },
    agent: (text) => { calls.push(`agent ${text}`); return { ok: true } },
    files: request => fileReply(request),
    fetch: () => ({ ok: false, error: 'a checked card sends no request' }),
    close: () => { calls.push('close') },
    log: (level, text) => { calls.push(`log ${level} ${text}`) },
    error: (text) => { calls.push(`error ${text}`) },
  }
}

function elementOf(node: CardNode): El {
  if (node.t === 'text') return h.text(String(node.a.content ?? ''))
  return h(node.t, { ...node.a }, ...node.c.map(elementOf))
}

/** Validate a rendered tree as tree.ts does, then through the Lark card mode; returns the first action token. */
function check(tree: CardNode[], label: string): string | undefined {
  const roots = tree.length === 1 && tree[0]!.t === 'message' ? tree[0]!.c : tree
  const message = normalize(h('message', {}, ...roots.map(elementOf)))
  const result = core.transform(message, { bot: {}, target: { chat: { id: 'lark:test', type: 'group' } }, mode: cardMode })
  assert.equal(result.msgs.length, 1, `${label}: one card message`)
  for (const draft of result.msgs) {
    assert.deepEqual(cardMode.check(draft), [], `${label}: Lark limits (200 elements, 30 KB)`)
  }
  assert.deepEqual(result.report.dropped, [], `${label}: dropped elements`)
  return firstAction(tree)
}

function actions(nodes: CardNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    const routed = node.t === 'button' && (node.a.type === 'action' || node.a.type === 'submit')
    if (routed && node.a.disabled !== true && typeof node.a.id === 'string') out.push(node.a.id)
    actions(node.c, out)
  }
  return out
}

function firstAction(nodes: CardNode[]): string | undefined {
  return actions(nodes)[0]
}

async function exercise(bundle: CardBundle, label: string): Promise<void> {
  const engine = await CardEngine.create({ memoryBytes: 16 << 20, cpuMs: 2000 })
  const host = recorder()
  const card = await engine.start(bundle, {}, host)
  try {
    const first = card.render()
    assert.ok(first.ok, `${label}: ${first.ok ? '' : first.error}`)
    const token = check(first.tree, label)
    assert.ok(token, `${label}: has an action button`)
    assert.equal(card.click(token, { user: { id: 'u1', name: 'A' }, time: Date.now() }), true)
    const second = card.render()
    assert.ok(second.ok, `${label} after click: ${second.ok ? '' : second.error}`)
    check(second.tree, `${label} after click`)
    // Then walk the card: click the k-th enabled action button of the current render, k = 0, 1, 2, …
    let tree = second.tree
    for (let k = 0; k < 12; k++) {
      const all = actions(tree)
      if (all.length === 0) break
      assert.equal(card.click(all[k % all.length]!, { user: { id: `u${k % 3}` }, time: Date.now() }), true)
      const next = card.render()
      assert.ok(next.ok, `${label} after click ${k}: ${next.ok ? '' : next.error}`)
      check(next.tree, `${label} after click ${k}`)
      tree = next.tree
    }
    card.fireTimers(Date.now() + 5000)
    const third = card.render()
    assert.ok(third.ok, `${label} after timers: ${third.ok ? '' : third.error}`)
    check(third.tree, `${label} after timers`)
    assert.deepEqual(host.calls.filter(c => c.startsWith('error')), [], `${label}: no uncaught errors`)
  } finally {
    card.dispose()
  }
}

const examples = (await readdir(new URL('../skill/examples/', import.meta.url))).filter(f => f.endsWith('.tsx'))

test('the checks reject what the skill says is not allowed', async () => {
  // Unknown elements and invalid attribute values are type errors: the card is refused before it runs.
  for (const source of [
    'export default () => <message><input /><button onClick={() => {}}>x</button></message>',
    'export default () => <message><form name="f"><input name="a" type="date" /></form></message>',
    'export default () => <message><button variant="big" onClick={() => {}}>x</button></message>',
  ]) {
    await assert.rejects(bundleCard({ inline: source, cwd: '/w' }, files, LIMITS), /does not type-check/, source)
  }
  // Nesting rules (a block inside a paragraph) are checked when the tree is validated.
  const nested = 'export default () => <message><p><small>x</small></p><button onClick={() => {}}>x</button></message>'
  const bundle = await bundleCard({ inline: nested, cwd: '/w' }, files, LIMITS)
  await assert.rejects(exercise(bundle, 'bad'), undefined, nested)
})

test('the skill ships the documented examples', () => {
  for (const name of ['poll', 'checklist', 'wizard', 'pager', 'countdown', 'tabs']) assert.ok(examples.includes(`${name}.tsx`), name)
})

for (const name of examples) {
  test(`example ${name}`, async () => {
    const bundle = await bundleCard({ path: normalizePath(`${SKILL_DIR}examples/${name}`) }, files, LIMITS)
    await exercise(bundle, name)
  })
}

const skill = await readFile(new URL('../skill/SKILL.md', import.meta.url), 'utf8')

/** Top-level fenced blocks of a markdown text (a fence inside a longer fence is content), with their start line. */
function fences(text: string): { lang: string; source: string; line: number }[] {
  const out: { lang: string; source: string; line: number }[] = []
  let open: { ticks: number; lang: string; line: number; body: string[] } | undefined
  text.split(/\r?\n/).forEach((line, index) => {
    const m = /^(`{3,})(.*)$/.exec(line)
    if (open === undefined) {
      if (m) open = { ticks: m[1]!.length, lang: m[2]!.trim(), line: index + 1, body: [] }
    } else if (m && m[1]!.length >= open.ticks && !m[2]!.trim()) {
      out.push({ lang: open.lang, source: open.body.join('\n'), line: open.line })
      open = undefined
    } else {
      open.body.push(line)
    }
  })
  return out
}

const blocks = fences(skill).filter(b => b.lang === 'tsx' || b.lang === 'satori-tsx')

test('SKILL.md has frontmatter and card blocks', () => {
  assert.match(skill, /^---\nname: im-card\ndescription: .+\n---\n/)
  assert.ok(blocks.length >= 3, `found ${blocks.length} card blocks`)
  const lines = skill.split('\n').length
  assert.ok(lines >= 250 && lines <= 520, `SKILL.md has ${lines} lines`)
})

for (const { source, line } of blocks) {
  test(`SKILL.md card block at line ${line}`, async () => {
    const bundle = await bundleCard({ inline: source, cwd: normalizePath(SKILL_DIR) }, files, LIMITS)
    await exercise(bundle, `SKILL.md:${line}`)
  })
}
