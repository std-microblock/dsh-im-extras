import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { polishTab } from '../src/index.ts'

describe('polish panel tab', () => {
  function service() {
    const calls: unknown[] = []
    const record = { id: 'r1', at: 1, chat: 'c', action: 'dropped', original: 'a', result: 'a', subs: [], attempts: [], durationMs: 1 }
    return {
      calls,
      service: {
        records: (filter: unknown) => { calls.push(['records', filter]); return [record] },
        stats: (filter: unknown) => { calls.push(['stats', filter]); return { total: 1, rewritten: 0, kept: 0, dropped: 1, reasons: {} } },
        overrides: () => [],
        setChat: async (chat: string, enabled: boolean | undefined) => { calls.push(['setChat', chat, enabled]); return undefined },
        clear: async () => 3,
        preview: async (chat: string, text: string) => ({ action: 'kept', text, chat }),
        chatState: (chat: string) => ({ enabled: true, chat }),
      } as never,
    }
  }

  it('reads records with filters and stats', async () => {
    const { service: s, calls } = service()
    const tab = polishTab(s)
    assert.equal(tab.id, 'polish')
    assert.equal(tab.badge?.(), 1)
    const out = await tab.read!({ path: '', query: new URLSearchParams('chat=c&action=dropped&q=hi&limit=5') }) as { records: unknown[] }
    assert.equal(out.records.length, 1)
    assert.deepEqual(calls.find(call => (call as unknown[])[0] === 'records'), ['records', { chat: 'c', action: 'dropped', query: 'hi', limit: 5 }])
    assert.deepEqual(await tab.read!({ path: 'chat', query: new URLSearchParams('chat=c') }), { enabled: true, chat: 'c' })
    await assert.rejects(tab.read!({ path: 'nope', query: new URLSearchParams() }), /unknown path/)
  })

  it('switches chats, clears and previews', async () => {
    const { service: s, calls } = service()
    const tab = polishTab(s)
    assert.deepEqual(await tab.command!({ path: '', body: { action: 'set-chat', chat: 'c', enabled: false } }), { ok: true, text: '已关闭润色' })
    assert.deepEqual(calls.at(-1), ['setChat', 'c', false])
    await tab.command!({ path: '', body: { action: 'set-chat', chat: 'c', enabled: null } })
    assert.deepEqual(calls.at(-1), ['setChat', 'c', undefined])
    assert.deepEqual(await tab.command!({ path: '', body: { action: 'clear' } }), { ok: true, text: '已删除 3 条记录' })
    assert.deepEqual(await tab.command!({ path: '', body: { action: 'preview', chat: 'c', text: 't' } }), { action: 'kept', text: 't', chat: 'c' })
    await assert.rejects(tab.command!({ path: '', body: { action: 'bogus' } }), /unknown action/)
  })
})
