import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { ImChatKey, ImMessageKey } from '@deepseek-ai/dsh-im'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { Config, ImCardsService } from '../src/index.ts'
import type { PublishRequest, PublishedCard, RehearseRequest } from '../src/service.ts'

function createService(extraServices: Record<string, unknown> = {}): {
  api: ImCardsService
  published: PublishRequest[]
  rehearsed: RehearseRequest[]
} {
  const ctx = new Context()
  const im = {
    sessions: {
      agent: async () => ({ id: 'agent-1' }),
    },
  }
  ctx.provide('im', im as never)
  for (const [name, value] of Object.entries(extraServices)) {
    ctx.provide(name as never, value as never)
  }
  const api = new ImCardsService(ctx, Config({}))
  const published: PublishRequest[] = []
  const rehearsed: RehearseRequest[] = []
  api.cards.rehearse = async (req: RehearseRequest) => { rehearsed.push(req) }
  api.cards.publish = async (req: PublishRequest): Promise<PublishedCard> => {
    published.push(req)
    return {
      id: 'card-1',
      status: 'confirmed',
      message: 'lark:bot|om_99' as ImMessageKey,
      seq: 7,
      thread: req.thread === true ? 'omt_99' : (typeof req.thread === 'string' ? req.thread : undefined),
    }
  }
  return { api, published, rehearsed }
}

test('ImCardsService.publishInline supports thread: true, typecheck, rehearse, and returns seq/thread', async () => {
  const { api, published, rehearsed } = createService()

  const result = await api.publishInline({
    source: 'export default () => <message><title>Hi</title></message>',
    session: 's1' as SessionId,
    chat: 'lark:bot|oc_1' as ImChatKey,
    quote: 'lark:bot|om_1' as ImMessageKey,
    thread: true,
    grant: false,
    typecheck: true,
    rehearse: true,
  })

  assert.equal(result.id, 'card-1')
  assert.equal(result.seq, 7)
  assert.equal(result.thread, 'omt_99')
  assert.equal(rehearsed.length, 1)
  assert.equal(published.length, 1)
  assert.equal(published[0]!.thread, true)
  assert.equal(published[0]!.quote, 'lark:bot|om_1')
  assert.equal(published[0]!.grant, false)

  await assert.rejects(
    api.publishInline({
      source: 'export default () => <message><video /></message>',
      session: 's1' as SessionId,
      chat: 'lark:bot|oc_1' as ImChatKey,
      typecheck: true,
    }),
    /video/,
  )
})

test('ImCardsService.publishFile loads a workspace .tsx card, rehearses it, and forwards thread/grant', async () => {
  const files: Record<string, string> = {
    '/work/cards/alert.tsx': 'import { Title } from "./title.tsx"\nexport default ({ label }: { label: string }) => <message><Title text={label} /></message>',
    '/work/cards/title.tsx': 'export const Title = ({ text }: { text: string }) => <title>{text}</title>',
  }
  const fakeFs = {
    resolve: async (path: string, opts?: { cwd?: string }) => {
      if (path.startsWith('/')) return path
      const base = opts?.cwd ?? '/work'
      if (path === '.') return base
      return `${base}/${path.replace(/^\.\//, '')}`
    },
    stat: async (path: string) => (path in files ? { type: 'file' } : undefined),
    readText: async (path: string) => files[path]!,
    processPath: (path: string) => path,
  }
  const fakeWd = { ensure: async () => '/work' }
  const { api, published, rehearsed } = createService({ fs: fakeFs, workingDirectory: fakeWd })

  const result = await api.publishFile({
    path: 'cards/alert.tsx',
    props: { label: 'P1' },
    session: 's1' as SessionId,
    chat: 'lark:bot|oc_1' as ImChatKey,
    thread: 'omt_42',
    grant: false,
  })

  assert.equal(result.id, 'card-1')
  assert.equal(result.seq, 7)
  assert.equal(result.thread, 'omt_42')
  assert.equal(rehearsed.length, 1)
  assert.equal(published.length, 1)
  assert.equal(published[0]!.cwd, '/work')
  assert.equal(published[0]!.thread, 'omt_42')
  assert.equal(published[0]!.grant, false)
  assert.deepEqual(published[0]!.props, { label: 'P1' })
})
