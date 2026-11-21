import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  autoFor, DEFAULT_STICKER_TYPES, filterStickers, hintScore, MessageSegments, pickSticker, recencyFactor,
  segmentWantsSticker, stickerLabel, weightedPick,
} from '../src/index.ts'
import { config, row, seeded } from './helpers.ts'

const types = DEFAULT_STICKER_TYPES

describe('filter and order', () => {
  const rows = [
    row(1, { weight: 10, tags: ['general'], desc: '盖着被子的小鲸鱼' }),
    row(2, { weight: 90, tags: ['speechless', 'general'], desc: '捂脸的猫', uses: 3 }),
    row(3, { weight: 50, tags: [], desc: '跳舞的企鹅', enabled: false }),
  ]

  it('filters by tags (AND), untagged, enabled and text, and orders by weight', () => {
    assert.deepEqual(filterStickers(rows, {}, types).map(r => r.id), [2, 3, 1])
    assert.deepEqual(filterStickers(rows, { tags: ['general'] }, types).map(r => r.id), [2, 1])
    assert.deepEqual(filterStickers(rows, { tags: ['general', 'speechless'] }, types).map(r => r.id), [2])
    assert.deepEqual(filterStickers(rows, { untagged: true }, types).map(r => r.id), [3])
    assert.deepEqual(filterStickers(rows, { enabled: true, order: 'newest' }, types).map(r => r.id), [2, 1])
    assert.deepEqual(filterStickers(rows, { query: '无语' }, types).map(r => r.id), [2], 'type names are searchable')
    assert.deepEqual(filterStickers(rows, { query: '鲸鱼' }, types).map(r => r.id), [1])
    assert.deepEqual(filterStickers(rows, { order: 'uses', limit: 1 }, types).map(r => r.id), [2])
    assert.deepEqual(filterStickers(rows, { order: 'oldest', offset: 1 }, types).map(r => r.id), [2, 3])
  })

  it('labels a sticker with its id and description', () => {
    assert.equal(stickerLabel(row(7, { desc: '捂脸的猫' })), '#7 捂脸的猫')
    assert.equal(stickerLabel(row(8)), '#8')
  })
})

describe('weighted pick', () => {
  it('softens recently used stickers', () => {
    const now = 10 * 86400_000
    assert.equal(recencyFactor(0, now), 1)
    assert.equal(recencyFactor(now - 60_000, now), 0.25)
    assert.equal(recencyFactor(now - 30 * 60_000, now), 0.6)
    assert.equal(recencyFactor(now - 5 * 3600_000, now), 0.85)
    assert.equal(recencyFactor(now - 2 * 86400_000, now), 1)
  })

  it('favours heavier stickers and avoids the one just used', () => {
    const now = 10 * 86400_000
    const heavy = row(1, { weight: 90 })
    const light = row(2, { weight: 10 })
    const counts = new Map<number, number>()
    const rnd = seeded(7)
    for (let i = 0; i < 2000; i++) {
      const picked = weightedPick([{ row: heavy, weight: 90 }, { row: light, weight: 10 }], now, rnd)!
      counts.set(picked.id, (counts.get(picked.id) ?? 0) + 1)
    }
    assert.ok(counts.get(1)! > counts.get(2)! * 4, `heavy should dominate: ${[...counts]}`)

    const usedNow = row(1, { weight: 50, lastUsed: now - 1000 })
    const fresh = row(2, { weight: 50 })
    counts.clear()
    for (let i = 0; i < 2000; i++) {
      const picked = weightedPick([{ row: usedNow, weight: 50 }, { row: fresh, weight: 50 }], now, rnd)!
      counts.set(picked.id, (counts.get(picked.id) ?? 0) + 1)
    }
    assert.ok(counts.get(2)! > counts.get(1)! * 2.5, `a sticker used a second ago comes back less: ${[...counts]}`)
    assert.equal(weightedPick([], now), undefined)
  })

  it('matches a mood hint through the type meaning and respects exclusions and the weight floor', () => {
    const rows = [
      row(1, { tags: ['speechless'], desc: '翻白眼的狗' }),
      row(2, { tags: ['happy'], desc: '大笑的熊猫' }),
      row(3, { tags: ['general'], desc: '挥手的小人', weight: 5 }),
      row(4, { tags: ['general'], desc: '点头的猫', enabled: false }),
    ]
    assert.ok(hintScore(rows[1]!, '被逗笑了', types) > 0)
    assert.equal(hintScore(rows[0]!, '被逗笑了', types), 0)
    for (let i = 0; i < 20; i++) assert.equal(pickSticker(rows, { hint: '被逗笑了' }, types, 0, seeded(i))?.id, 2)
    assert.equal(pickSticker(rows, { tags: ['general'] }, types, 0, seeded())?.id, 3, 'disabled stickers are never picked')
    assert.equal(pickSticker(rows, { tags: ['general'], minWeight: 10 }, types), undefined)
    assert.equal(pickSticker(rows, { tags: ['speechless'], exclude: [1] }, types), undefined)
  })
})

describe('automatic sticker timing', () => {
  function fakeTimers() {
    let now = 0
    const pending = new Map<number, { at: number; fn: () => void }>()
    let next = 1
    return {
      timers: {
        set: (fn: () => void, ms: number) => { const id = next++; pending.set(id, { at: now + ms, fn }); return id },
        clear: (id: unknown) => { pending.delete(id as number) },
      },
      advance(ms: number) {
        now += ms
        for (const [id, timer] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
          if (timer.at <= now) { pending.delete(id); timer.fn() }
        }
      },
      get pending() { return pending.size },
    }
  }

  it('closes a burst only after the bot has been quiet for the gap', () => {
    const clock = fakeTimers()
    const closed: { chat: string; messages: number; sticker: boolean }[] = []
    const segments = new MessageSegments(() => 7000, (chat, segment) => { closed.push({ chat, ...segment }) }, clock.timers)
    segments.message('a')
    clock.advance(3000)
    segments.message('a')
    clock.advance(5000)
    assert.equal(closed.length, 0, 'the second message restarted the timer')
    clock.advance(2000)
    assert.deepEqual(closed, [{ chat: 'a', messages: 2, sticker: false }])
    segments.sticker('a')
    assert.equal(clock.pending, 0, 'a sticker alone opens no burst')
  })

  it('remembers a sticker the agent sent inside the burst, per chat', () => {
    const clock = fakeTimers()
    const closed: { chat: string; messages: number; sticker: boolean }[] = []
    const segments = new MessageSegments(() => 1000, (chat, segment) => { closed.push({ chat, ...segment }) }, clock.timers)
    segments.message('a')
    segments.message('b')
    segments.sticker('a')
    clock.advance(1000)
    assert.deepEqual(closed.sort((x, y) => x.chat.localeCompare(y.chat)), [
      { chat: 'a', messages: 1, sticker: true },
      { chat: 'b', messages: 1, sticker: false },
    ])
    segments.message('a')
    segments.stop()
    assert.equal(clock.pending, 0)
  })

  it('rolls the chance, never after a sticker or an empty burst', () => {
    assert.equal(segmentWantsSticker({ messages: 2, sticker: false }, 10, 0.05), true)
    assert.equal(segmentWantsSticker({ messages: 2, sticker: false }, 10, 0.2), false)
    assert.equal(segmentWantsSticker({ messages: 2, sticker: true }, 100, 0), false)
    assert.equal(segmentWantsSticker({ messages: 0, sticker: false }, 100, 0), false)
    assert.equal(segmentWantsSticker({ messages: 1, sticker: false }, 0, 0), false)
  })

  it('applies per-chat rules: QQ is rarer by default, and the panel switch wins', () => {
    const base = config({ auto: { enabled: true, percent: 8, gapMs: 7000, tag: 'general' } })
    assert.equal(autoFor(base, { chat: 'qq:1|g', bot: 'qq:1' }).percent, 3)
    assert.equal(autoFor(base, { chat: 'lark:a|c', bot: 'lark:a' }).percent, 8)
    const ruled = config({ rules: [{ sources: ['work'], auto: { enabled: false } }, { chats: ['c2'], auto: { percent: 40 } }] })
    assert.equal(autoFor(ruled, { chat: 'lark:a|c1', source: 'work' }).enabled, false)
    assert.equal(autoFor(ruled, { chat: 'lark:a|c2' }).percent, 40, 'a bare chat id matches')
    assert.equal(autoFor(ruled, { chat: 'lark:a|c1', source: 'work' }, { enabled: true }).enabled, true)
  })
})
