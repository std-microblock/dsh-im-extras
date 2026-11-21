import assert from 'node:assert/strict'
import test from 'node:test'
import { bundleCard, type CardFiles } from '../src/bundle.ts'
import { CardEngine, type CardVmHost } from '../src/engine.ts'

const files = (map: Record<string, string>): CardFiles => ({ read: async path => map[path] })

function recorder(): CardVmHost & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    schedule: () => { calls.push('schedule') },
    timers: due => { calls.push(`timers ${due > 0 ? 'set' : due}`) },
    toast: (content, type) => { calls.push(`toast ${type} ${content}`) },
    agent: text => { calls.push(`agent ${text}`); return { ok: true } },
    files: () => ({ ok: false, error: 'this test gives the card no data folder' }),
    fetch: () => ({ ok: false, error: 'this test lets no request out' }),
    close: () => { calls.push('close') },
    log: (level, text) => { calls.push(`log ${level} ${text}`) },
    error: text => { calls.push(`error ${text.split('\n')[0]}`) },
  }
}

const COUNTER = `
import { useState } from 'dsh:card'
import { Row } from './row.tsx'
type P = { start: number }
export default function Counter({ start }: P) {
  const [n, setN] = useState(start)
  return <message>
    <title theme="info">计数 {n}</title>
    <Row label="+1" onPick={() => setN(n + 1)} />
  </message>
}
`
const ROW = `export const Row = (p: { label: string; onPick: () => void }) => <button-group><button onClick={p.onPick}>{p.label}</button></button-group>`

test('bundle, render, click, snapshot and restore a TSX card', async () => {
  const bundle = await bundleCard({ path: '/w/card.tsx' }, files({ '/w/card.tsx': COUNTER, '/w/row.tsx': ROW }),
    { maxModules: 8, maxBytes: 100_000 })
  assert.deepEqual([...bundle.files].sort(), ['/w/card.tsx', '/w/row.tsx'])
  const engine = await CardEngine.create({ memoryBytes: 16 << 20, cpuMs: 2000 })
  const host = recorder()
  const card = await engine.start(bundle, { start: 5 }, host)
  const first = card.render()
  assert.ok(first.ok)
  const json = JSON.stringify(first.tree)
  assert.match(json, /计数/)
  const token = /"id":"([^"]+)"/.exec(json)?.[1]
  assert.ok(token)
  assert.equal(card.click(token, { user: { id: 'u' } }), true)
  assert.deepEqual(host.calls, ['schedule'])
  const second = card.render()
  assert.ok(second.ok && JSON.stringify(second.tree).includes('6'))

  const snap = engine.snapshot(card)
  console.log('snapshot delta bytes', Buffer.from(snap.delta, 'base64').length)
  card.dispose()
  const back = await engine.restore(snap, recorder())
  assert.ok(back)
  assert.equal(back.click(token, {}), true)
  const third = back.render()
  assert.ok(third.ok && JSON.stringify(third.tree).includes('7'), JSON.stringify(third))
  back.dispose()
})

test('a syntax error names the file and position', async () => {
  await assert.rejects(
    bundleCard({ inline: 'export default () => <message><b>x</i></message>', cwd: '/w' }, files({}), { maxModules: 2, maxBytes: 1e5 }),
    /inline:card\.tsx:1:\d+: Expected corresponding JSX closing tag/,
  )
})

test('type errors name the file and position: unknown elements, wrong attribute values, wrong props', async () => {
  const cases: [string, RegExp][] = [
    ['export default () => <message><video /></message>', /inline:card\.tsx:1:\d+: .*'video' does not exist/],
    ['export default () => <message><input /></message>', /inline:card\.tsx:1:\d+:[\s\S]*'name' is missing/],
    ['export default () => <message><button variant="big">x</button></message>', /inline:card\.tsx:1:\d+: .*ButtonVariant/],
    ['const Row = (p: { n: number }) => <p>{p.n}</p>\nexport default () => <message><Row n="1" /></message>', /inline:card\.tsx:2:\d+: .*string.*number/],
    ["import { useState } from 'dsh:card'\nexport default () => { const [n, setN] = useState(0); setN('x'); return <message /> }", /inline:card\.tsx:2:\d+/],
  ]
  for (const [source, error] of cases) {
    await assert.rejects(bundleCard({ inline: source, cwd: '/w' }, files({}), { maxModules: 2, maxBytes: 1e5 }), error, source)
  }
})

test('an infinite loop is interrupted', async () => {
  const bundle = await bundleCard({ inline: 'export default () => { while (true) {} }', cwd: '/w' }, files({}),
    { maxModules: 2, maxBytes: 1e5 })
  const engine = await CardEngine.create({ memoryBytes: 16 << 20, cpuMs: 200 })
  const card = await engine.start(bundle, {}, recorder())
  const out = card.render()
  assert.equal(out.ok, false)
  card.dispose()
})

const FILES_AND_HTTP = `
import { useState, fs, fetch } from 'dsh:card'
export default function Card() {
  const [line, setLine] = useState(String(fs.readFile('state.json')))
  return <message>
    <p>{line}</p>
    <button onClick={(e) => {
      fs.writeFile('state.json', '{"by":"' + e.user.id + '"}')
      fetch('https://api.test/x', { method: 'POST', body: 'q' })
        .then((r) => r.text())
        .then((text) => setLine(text))
    }}>go</button>
  </message>
}
`

test('fs and fetch cross the bridge: files reach the host and an answer settles into the card', async () => {
  const bundle = await bundleCard({ inline: FILES_AND_HTTP, cwd: '/w' }, files({}), { maxModules: 2, maxBytes: 1e5 })
  const engine = await CardEngine.create({ memoryBytes: 16 << 20, cpuMs: 2000 })
  const store = new Map<string, string>([['state.json', '{"by":"none"}']])
  const seen: string[] = []
  let requests = 0
  const card = await engine.start(bundle, {}, {
    ...recorder(),
    files: (request) => {
      seen.push(`${request.op} ${request.path}`)
      if (request.op === 'read') return { ok: true, value: store.get(request.path) }
      if (request.op === 'write') {
        store.set(request.path, String(request.text ?? ''))
        return { ok: true }
      }
      return { ok: false, error: `unexpected ${request.op}` }
    },
    fetch: (request) => { requests++; seen.push(`fetch ${request.method ?? 'GET'} ${request.url}`); return { ok: true, id: 'req-1' } },
  })
  const first = card.render()
  assert.ok(first.ok)
  assert.match(JSON.stringify(first.tree), /none/)
  const token = /"id":"([^"]+)"/.exec(JSON.stringify(first.tree))?.[1]
  assert.ok(token)

  assert.equal(card.click(token, { user: { id: 'ou_a' } }), true)
  assert.equal(store.get('state.json'), '{"by":"ou_a"}')
  assert.equal(requests, 1)
  assert.deepEqual(seen, ['read state.json', 'write state.json', 'fetch POST https://api.test/x'])

  assert.equal(card.settleFetch('req-1', {
    ok: true, url: 'https://api.test/x', status: 200, statusText: 'OK', headers: {}, body: 'answer',
  }), true)
  const second = card.render()
  assert.ok(second.ok && JSON.stringify(second.tree).includes('answer'))
  assert.equal(card.settleFetch('req-1', { ok: false, error: 'late' }), false)
  card.dispose()
})

test('a module without a default export reports no default export cleanly', async () => {
  const bundle = await bundleCard({ inline: 'const x = 1', cwd: '/w' }, files({}), { maxModules: 2, maxBytes: 1e5 })
  const engine = await CardEngine.create({ memoryBytes: 16 << 20, cpuMs: 2000 })
  await assert.rejects(engine.start(bundle, {}, recorder()), /no default export/)
})
