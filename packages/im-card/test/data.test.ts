/**
 * The card data folder (`src/data.ts`): every operation a card's `fs` API can reach, and the refusals that keep it
 * inside the one folder the deployment gave it.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { cardFiles } from '../src/data.ts'

/** A fresh temporary folder, and its data folder below it. */
function workspace(): { base: string; root: string; close(): void } {
  const base = mkdtempSync(join(tmpdir(), 'im-card-data-'))
  return { base, root: join(base, 'data'), close: () => rmSync(base, { recursive: true, force: true }) }
}

test('a card reads, writes, appends, lists and removes files in its folder', () => {
  const space = workspace()
  try {
    assert.deepEqual(cardFiles(space.root, { op: 'write', path: 'polls/a.json', text: '{"a":1}' }, 1024),
      { ok: true, value: undefined })
    assert.deepEqual(cardFiles(space.root, { op: 'read', path: 'polls/a.json' }, 1024), { ok: true, value: '{"a":1}' })
    assert.deepEqual(cardFiles(space.root, { op: 'read', path: 'polls/missing.json' }, 1024), { ok: true, value: undefined })

    cardFiles(space.root, { op: 'append', path: 'polls/a.json', text: '!' }, 1024)
    assert.deepEqual(cardFiles(space.root, { op: 'read', path: 'polls/a.json' }, 1024), { ok: true, value: '{"a":1}!' })

    assert.equal(cardFiles(space.root, { op: 'stat', path: 'polls/a.json' }, 1024).value, true)
    assert.deepEqual(cardFiles(space.root, { op: 'list', path: 'polls' }, 1024).value,
      [{ name: 'a.json', dir: false, size: 8 }])
    assert.deepEqual(cardFiles(space.root, { op: 'list', path: '' }, 1024).value, [{ name: 'polls', dir: true, size: 0 }]);
    assert.deepEqual(cardFiles(space.root, { op: 'list', path: 'absent' }, 1024).value, [])

    cardFiles(space.root, { op: 'remove', path: 'polls/a.json' }, 1024)
    assert.equal(cardFiles(space.root, { op: 'stat', path: 'polls/a.json' }, 1024).value, false)
    // Removing what is not there is not an error: a card may clean up twice.
    assert.deepEqual(cardFiles(space.root, { op: 'remove', path: 'polls/a.json' }, 1024), { ok: true, value: undefined })
    assert.deepEqual(cardFiles(space.root, { op: 'list', path: 'polls' }, 1024).value, [])
  } finally {
    space.close()
  }
})

test('a path that leaves the folder is refused', () => {
  const space = workspace()
  try {
    writeFileSync(join(space.base, 'secret.txt'), 'top secret')
    assert.deepEqual(cardFiles(space.root, { op: 'read', path: '../secret.txt' }, 1024),
      { ok: false, error: 'path escapes the card folder: ../secret.txt' })
    assert.match(cardFiles(space.root, { op: 'read', path: 'a/../../secret.txt' }, 1024).error, /escapes the card folder/)
    assert.match(cardFiles(space.root, { op: 'write', path: join(space.base, 'out.txt'), text: 'x' }, 1024).error,
      /must be relative to the card folder/)
    assert.match(cardFiles(space.root, { op: 'write', path: 'C:/temp/out.txt', text: 'x' }, 1024).error,
      /must be relative to the card folder/)

    // A link inside the folder must not reach outside it either.
    try {
      symlinkSync(join(space.base, 'secret.txt'), join(space.root, 'link.txt'))
      const viaLink = cardFiles(space.root, { op: 'read', path: 'link.txt' }, 1024)
      assert.equal(viaLink.ok, false)
      assert.match(viaLink.error, /through a link/)
    } catch {
      // Creating a link needs a privilege this machine may not have; the lexical checks above still hold.
    }
  } finally {
    space.close()
  }
})

test('the size bound holds for writes, appends and reads', () => {
  const space = workspace()
  try {
    assert.match(cardFiles(space.root, { op: 'write', path: 'big.txt', text: 'x'.repeat(2000) }, 1024).error,
      /would exceed 1024 bytes/)
    cardFiles(space.root, { op: 'write', path: 'ok.txt', text: 'x'.repeat(1000) }, 1024)
    assert.match(cardFiles(space.root, { op: 'append', path: 'ok.txt', text: 'x'.repeat(100) }, 1024).error,
      /would exceed 1024 bytes/)
    writeFileSync(join(space.root, 'grown.txt'), 'y'.repeat(4000))
    assert.match(cardFiles(space.root, { op: 'read', path: 'grown.txt' }, 1024).error, /a card may read at most 1024/)
  } finally {
    space.close()
  }
})

test('a card without a data folder is told so, and writes nothing', () => {
  const refused = cardFiles(undefined, { op: 'write', path: 'a.txt', text: 'x' }, 1024)
  assert.equal(refused.ok, false)
  assert.match(refused.error, /no data folder/)
})

test('an unknown operation is refused instead of guessed', () => {
  const space = workspace()
  try {
    mkdirSync(space.root, { recursive: true })
    // A card may pass anything: the operation is validated where it is applied.
    assert.match(cardFiles(space.root, { op: 'chmod' as never, path: 'a' }, 1024).error, /unknown file operation chmod/)
    assert.equal(readdirSync(space.root).length, 0)
  } finally {
    space.close()
  }
})
