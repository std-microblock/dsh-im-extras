import assert from 'node:assert/strict'
import test from 'node:test'
import type { ImChatKey, ImMessage, ImMessageKey } from '@deepseek-ai/dsh-im'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { Config, ImAutoResumeService, wasInterrupted, type AutoResumeExhaustedEvent } from '../src/index.ts'

const SESSION = 'im-test-session-1' as SessionId
const CHAT = 'lark:app|oc_chat_1' as ImChatKey
const TRIGGER_KEY = 'lark:app|om_trigger_1' as ImMessageKey

function fakeTrigger(): ImMessage {
  return {
    key: TRIGGER_KEY,
    id: 'om_trigger_1',
    chat: { key: CHAT, ref: { id: 'oc_chat_1', type: 'group' }, source: 'team' },
  } as unknown as ImMessage
}

function makeMemoryStorage() {
  const tables = new Map<string, Map<string, any>>()
  const tableOf = (name: string) => {
    let t = tables.get(name)
    if (!t) {
      t = new Map()
      tables.set(name, t)
    }
    return t
  }
  return {
    tables,
    storageDomain: {
      open: async () => ({
        table: (name: string) => {
          const map = tableOf(name)
          return {
            get: (k: string) => map.get(k),
            put: async (k: string, v: any) => { map.set(k, v) },
            delete: async (k: string) => { map.delete(k) },
            entries: () => map.entries(),
          }
        },
        close: async () => {},
      }),
    },
  }
}

function makeHarness(options: {
  storage?: ReturnType<typeof makeMemoryStorage>
  events?: any[]
  sessionExists?: boolean
  triggerPresent?: boolean
  now?: () => number
  config?: Partial<Config>
} = {}) {
  const storage = options.storage ?? makeMemoryStorage()
  const listeners = new Map<string, ((...args: any[]) => any)[]>()
  const delivered: { sessionId: string; delivery: any }[] = []
  const exhausted: AutoResumeExhaustedEvent[] = []
  const trigger = fakeTrigger()
  const ctx: any = {
    logger: { info() {}, warn() {}, error() {} },
    storageDomain: storage.storageDomain,
    agents: { get: () => undefined },
    sessionQuery: {
      readSession: async () => ({
        session: { origin: 'user' },
        events: options.events ?? [{ type: 'turn/start', data: { turn: 1 } }],
      }),
    },
    im: {
      sessions: {
        get: (id: string) => (options.sessionExists ?? true) && id === SESSION
          ? { sessionId: SESSION, bindings: [{ chat: CHAT, home: true, writable: true }] }
          : undefined,
        deliver: async (sessionId: string, delivery: any) => {
          delivered.push({ sessionId, delivery })
        },
      },
      history: {
        get: (key: string) => (options.triggerPresent ?? true) && key === TRIGGER_KEY ? trigger : undefined,
      },
    },
    on: (name: string, fn: any) => {
      listeners.set(name, [...listeners.get(name) ?? [], fn])
      return () => {}
    },
    emit: (name: string, payload: any) => {
      if (name === 'im/auto-resume-exhausted') exhausted.push(payload)
      for (const fn of listeners.get(name) ?? []) fn(payload)
    },
  }
  const resolvedConfig = Config({ startupDelayMs: 0, ...options.config })
  const service = new ImAutoResumeService(ctx, resolvedConfig, options.now)
  const emitActivity = (activity: any, change: 'start' | 'end') => {
    for (const fn of listeners.get('im/activity') ?? []) fn(activity, change)
  }
  return { storage, ctx, service, delivered, exhausted, emitActivity, trigger }
}

const settled = () => new Promise(resolve => setTimeout(resolve, 15))

test('wasInterrupted classifies open turns, interrupted turns, and disposed aborts', () => {
  assert.equal(wasInterrupted([{ type: 'turn/start', data: { turn: 1 } }]), true)
  assert.equal(wasInterrupted([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } } },
  ]), true)
  assert.equal(wasInterrupted([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } } },
  ]), true)
  assert.equal(wasInterrupted([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } },
  ]), false)
  assert.equal(wasInterrupted([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]), false)
})

test('keeps marker across graceful disposal and resumes with original trigger on next start', async () => {
  let clock = 100_000
  const storage = makeMemoryStorage()

  // Process 1: turn starts, then ends due to graceful disposal.
  const first = makeHarness({ storage, now: () => clock })
  await first.service.start()
  first.emitActivity({
    session: { sessionId: SESSION, bindings: [{ chat: CHAT, home: true, writable: true }] },
    turn: 3,
    status: 'running',
    segments: [],
    trigger: first.trigger,
    startedAt: clock,
    updatedAt: clock,
  }, 'start')
  first.emitActivity({
    session: { sessionId: SESSION, bindings: [{ chat: CHAT, home: true, writable: true }] },
    turn: 3,
    status: 'cancelled',
    disposed: true,
    segments: [],
    trigger: first.trigger,
    startedAt: clock,
    updatedAt: clock + 500,
  }, 'end')
  await first.service.dispose()
  assert.equal(storage.tables.get('running')?.has(SESSION), true)

  // Process 2: boots 5s later, verifies log, and delivers followup with the original trigger.
  clock += 5_000
  const second = makeHarness({
    storage,
    now: () => clock,
    events: [
      { type: 'turn/start', data: { turn: 3 } },
      { type: 'turn/end', data: { turn: 3, reason: { kind: 'aborted', reason: { kind: 'disposed' } } } },
    ],
  })
  await second.service.start()
  await settled()
  assert.equal(second.delivered.length, 1)
  assert.equal(second.delivered[0]!.sessionId, SESSION)
  assert.equal(second.delivered[0]!.delivery.mode, 'followup')
  assert.equal(second.delivered[0]!.delivery.trigger?.key, TRIGGER_KEY)
  await second.service.dispose()
})

test('clears marker on normal completion and does not resume on next start', async () => {
  const storage = makeMemoryStorage()
  const first = makeHarness({ storage })
  await first.service.start()
  first.emitActivity({
    session: { sessionId: SESSION, bindings: [{ chat: CHAT, home: true, writable: true }] },
    turn: 1, status: 'running', segments: [], startedAt: Date.now(), updatedAt: Date.now(),
  }, 'start')
  first.emitActivity({
    session: { sessionId: SESSION, bindings: [{ chat: CHAT, home: true, writable: true }] },
    turn: 1, status: 'done', segments: [], startedAt: Date.now(), updatedAt: Date.now(),
  }, 'end')
  await first.service.dispose()
  assert.equal(storage.tables.get('running')?.has(SESSION), false)
})

test('emits im/auto-resume-exhausted and stops resuming after maxRetries in retryWindowMs', async () => {
  let clock = 500_000
  const storage = makeMemoryStorage()
  storage.tables.set('running', new Map([[SESSION, {
    sessionId: SESSION, chat: CHAT, triggerKey: TRIGGER_KEY, turn: 1, startedAt: clock - 1_000,
  }]]))
  storage.tables.set('attempts', new Map([[SESSION, {
    timestamps: [clock - 60_000, clock - 10_000],
  }]]))

  const h = makeHarness({
    storage,
    now: () => clock,
    config: { maxRetries: 2, retryWindowMs: 600_000 },
  })
  await h.service.start()
  await settled()

  assert.equal(h.delivered.length, 0)
  assert.equal(h.exhausted.length, 1)
  assert.deepEqual(h.exhausted[0], { sessionId: SESSION, chat: CHAT, attempts: 2 })
  assert.equal(storage.tables.get('running')?.has(SESSION), false)
  await h.service.dispose()
})

test('skips stale markers older than maxAgeMs', async () => {
  const clock = 10_000_000
  const storage = makeMemoryStorage()
  storage.tables.set('running', new Map([[SESSION, {
    sessionId: SESSION, chat: CHAT, turn: 1, startedAt: clock - 2_000_000,
  }]]))

  const h = makeHarness({ storage, now: () => clock, config: { maxAgeMs: 1_800_000 } })
  await h.service.start()
  await settled()

  assert.equal(h.delivered.length, 0)
  assert.equal(storage.tables.get('running')?.has(SESSION), false)
  await h.service.dispose()
})
