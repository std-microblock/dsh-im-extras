/**
 * Tests for direct `/skill` (and alias) invocation in `DispatchHost` and automatic capability authorization requests.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DispatchHost, extractSkillExtensions, parseSlashInvocation,
} from '../src/index.ts'
import { DispatchConfig as DispatchConfigSchema } from '../src/config.ts'
import type {
  ImOutcomeLike, SessionAuthLike, SkillDefinitionLike, SkillRegistryLike,
} from '../src/types.ts'
import {
  CHAT_KEY, COMPOSITION, FakeIm, FakeLogger, FakeStorage, FakeTasks,
} from './dispatch-fakes.ts'

function createFakeSkills(defs: SkillDefinitionLike[]): SkillRegistryLike {
  const byName = new Map(defs.map(d => [d.name, d]))
  return {
    async list() {
      return defs.map(({ content: _c, metadata: _m, ...summary }) => summary)
    },
    async get(name) {
      return byName.get(name)
    },
  }
}

const PRODUCT_SKILL: SkillDefinitionLike = {
  name: 'ticket-intake',
  description: '产品侧需求建单规范',
  invocation: { modelInvocable: false, userInvocable: true },
  source: 'custom',
  provider: 'filesystem',
  resourceBase: { kind: 'directory', path: '/skills/ticket-intake' },
  content: '# 产品需求建单流程\n按步骤查重并建单。',
  metadata: {
    commands: ['产品需求'],
    capabilities: ['issue-tracker'],
    authReason: '用于查询工单系统元数据、查重并创建工作项',
  },
}

const BACKEND_SKILL: SkillDefinitionLike = {
  name: 'backend-task',
  description: '后端工单处理入口',
  invocation: { modelInvocable: false, userInvocable: true },
  source: 'custom',
  provider: 'filesystem',
  content: '# 后端工单\n使用工单 CLI 处理后端任务。',
  metadata: {
    commands: ['后端任务'],
    capabilities: ['issue-tracker'],
    authReason: '用于访问工单系统查询或操作后端任务',
  },
}

const PLAIN_SKILL: SkillDefinitionLike = {
  name: 'quick-note',
  description: '普通技能，不需要额外权限',
  invocation: { modelInvocable: true, userInvocable: true },
  source: 'custom',
  provider: 'filesystem',
  content: '# Quick Note\nSummarize concisely.',
  metadata: { aliases: ['笔记'] },
}

const MODEL_ONLY_SKILL: SkillDefinitionLike = {
  name: 'internal-only',
  description: '仅模型可调用',
  invocation: { modelInvocable: true, userInvocable: false },
  source: 'custom',
  provider: 'filesystem',
  content: 'hidden',
  metadata: { commands: ['内部'] },
}

function setup(auth?: SessionAuthLike) {
  const im = new FakeIm()
  const tasks = new FakeTasks(im)
  const storage = new FakeStorage()
  const logger = new FakeLogger()
  const config = DispatchConfigSchema.parse({ main: COMPOSITION, worker: COMPOSITION })
  const skills = createFakeSkills([PRODUCT_SKILL, BACKEND_SKILL, PLAIN_SKILL, MODEL_ONLY_SKILL])
  const host = new DispatchHost({
    im,
    tasks,
    storage,
    logger,
    config,
    auth: () => auth,
    skills: () => skills,
  })
  const receive = async (text: string, patch?: Parameters<FakeIm['store']>[1]): Promise<{ message: ReturnType<FakeIm['store']>; outcome: ImOutcomeLike }> => {
    const message = im.store(text, patch)
    const outcome = await host.handle({
      message,
      deliver: (target, options) => im.sessions.deliver(target, {
        ...options,
        id: options.id ?? message.key,
        content: options.content ?? [message],
        trigger: options.trigger ?? message,
      }),
    }, () => Promise.resolve({ kind: 'ignored' }))
    return { message, outcome }
  }
  return { im, tasks, host, receive }
}

test('parseSlashInvocation handles direct /cmd and group @bot /cmd with or without <at> nodes', () => {
  const im = new FakeIm()
  const m1 = im.store('@小助手 /产品需求 帮我建个单', {
    content: {
      type: 'message',
      attrs: {},
      children: [{
        type: 'p',
        attrs: {},
        children: [
          { type: 'at', attrs: { type: 'user', id: 'bot', name: '小助手' }, children: [] },
          { type: 'text', attrs: { content: ' /产品需求 帮我建个单' }, children: [] },
        ],
      }],
    },
  })
  assert.deepEqual(parseSlashInvocation(m1), { token: '产品需求', args: '帮我建个单' })

  const m2 = im.store('/后端任务')
  assert.deepEqual(parseSlashInvocation(m2), { token: '后端任务', args: '' })

  const m3 = im.store('@小助手 帮我查一下 /产品需求 不是开头')
  assert.equal(parseSlashInvocation(m3), undefined)

  assert.deepEqual(extractSkillExtensions(PRODUCT_SKILL), {
    commands: ['产品需求'],
    capabilities: ['issue-tracker'],
    authReason: '用于查询工单系统元数据、查重并创建工作项',
  })
})

test('@小助手 /产品需求 opens a new worker directly, injects skill content, and auto-requests issue-tracker auth', async () => {
  const authRequests: Array<Record<string, unknown>> = []
  const auth: SessionAuthLike = {
    isExclusive: () => false,
    canInteract: () => true,
    aclOf: () => undefined,
    operatorUnlock: async () => false,
    async requestCapabilities(req) {
      authRequests.push(req as unknown as Record<string, unknown>)
      return { ok: true, cardId: 'card_auth_1', message: 'lark:test|om_auth_1' }
    },
  }
  const { im, tasks, host, receive } = setup(auth)

  const { message, outcome } = await receive('@小助手 /产品需求 帮我把这个 bug 建个单', {
    sender: { id: 'ou_user_a', name: '用户A', self: false },
    content: {
      type: 'message',
      attrs: {},
      children: [{
        type: 'p',
        attrs: {},
        children: [
          { type: 'at', attrs: { type: 'user', id: 'bot', name: '小助手' }, children: [] },
          { type: 'text', attrs: { content: ' /产品需求 帮我把这个 bug 建个单' }, children: [] },
        ],
      }],
    },
  })

  // Directly spawned a worker and bypassed Router.
  assert.equal(tasks.list().length, 1)
  const task = tasks.list()[0]!
  assert.deepEqual(outcome, { kind: 'handled', by: 'dispatch', sessions: [task.session] })
  assert.equal(task.title, '/产品需求 帮我把这个 bug 建个单')
  assert.equal(im.texts(host.routerFor(CHAT_KEY)!.sessionId).length, 0, 'router was not woken')

  // Worker received the skill content + pending auto-auth notice with deliveryMode="inject" so it waits without burning a turn.
  const deliveries = im.logs.get(task.session)!
  assert.equal(deliveries.length, 2)
  assert.equal(deliveries[0]!.delivery.mode, 'inject')
  assert.match(deliveries[0]!.text, /<skill_content name="ticket-intake">/)
  assert.match(deliveries[0]!.text, /Base directory for this skill: \/skills\/ticket-intake/)
  assert.equal(deliveries[1]!.delivery.mode, 'inject')
  assert.match(deliveries[1]!.text, /<im-auth-auto capabilities="issue-tracker" \/>/)

  // Auto-auth card was requested with the skill's capabilities and authReason.
  assert.equal(authRequests.length, 1)
  assert.equal(authRequests[0]!.sessionId, task.session)
  assert.deepEqual(authRequests[0]!.capabilities, ['issue-tracker'])
  assert.equal(authRequests[0]!.reason, '用于查询工单系统元数据、查重并创建工作项')
  assert.equal(authRequests[0]!.quote, message.key)

  await host.dispose()
})

test('/后端任务 works without args, plain skills start immediately, and user-invocable:false or unknown commands fall through to router', async () => {
  const authRequests: Array<Record<string, unknown>> = []
  const auth: SessionAuthLike = {
    isExclusive: () => false,
    canInteract: () => true,
    aclOf: () => undefined,
    operatorUnlock: async () => false,
    async requestCapabilities(req) {
      authRequests.push(req as unknown as Record<string, unknown>)
      return { ok: true, cardId: 'card_auth_2' }
    },
  }
  const { im, tasks, host, receive } = setup(auth)

  // 1. /后端任务 with no trailing args
  const r1 = await receive('/后端任务')
  assert.equal(tasks.list().length, 1)
  assert.equal(tasks.list()[0]!.title, '/后端任务')
  assert.deepEqual(r1.outcome, { kind: 'handled', by: 'dispatch', sessions: [tasks.list()[0]!.session] })
  assert.equal(authRequests.length, 1)
  assert.deepEqual(authRequests[0]!.capabilities, ['issue-tracker'])

  // 2. Plain skill without capabilities starts immediately with steer
  const r2 = await receive('/笔记 记一下这个结论')
  assert.equal(tasks.list().length, 2)
  const plainTask = tasks.list()[0]!
  assert.deepEqual(r2.outcome, { kind: 'handled', by: 'dispatch', sessions: [plainTask.session] })
  assert.equal(im.logs.get(plainTask.session)![0]!.delivery.mode, 'steer')
  assert.match(im.logs.get(plainTask.session)![0]!.text, /<skill_content name="quick-note">/)
  assert.equal(authRequests.length, 1, 'no auth card for plain skill')

  // 3. user-invocable: false skill falls through to router
  const r3 = await receive('/内部 test')
  assert.equal(tasks.list().length, 2)
  assert.deepEqual(r3.outcome, { kind: 'handled', by: 'dispatch', sessions: [host.routerFor(CHAT_KEY)!.sessionId] })

  // 4. Unknown slash command falls through to router
  const r4 = await receive('/未知命令 test')
  assert.equal(tasks.list().length, 2)
  assert.deepEqual(r4.outcome, { kind: 'handled', by: 'dispatch', sessions: [host.routerFor(CHAT_KEY)!.sessionId] })

  await host.dispose()
})

test('when auto-auth card sending fails, worker is woken via steer fallback so the task does not stall', async () => {
  const auth: SessionAuthLike = {
    isExclusive: () => false,
    canInteract: () => true,
    aclOf: () => undefined,
    operatorUnlock: async () => false,
    async requestCapabilities() {
      return { ok: false, error: 'card service offline' }
    },
  }
  const { im, tasks, host, receive } = setup(auth)

  await receive('/后端任务 查我的单')
  const task = tasks.list()[0]!
  const deliveries = im.logs.get(task.session)!
  assert.equal(deliveries.length, 2)
  assert.equal(deliveries[0]!.delivery.mode, 'inject')
  assert.equal(deliveries[1]!.delivery.mode, 'steer')
  assert.match(deliveries[1]!.text, /card service offline/)

  await host.dispose()
})

test('when requester already has credentials, requestCapabilities auto-grants silently and wakes worker immediately', async () => {
  const auth: SessionAuthLike = {
    isExclusive: () => false,
    canInteract: () => true,
    aclOf: () => undefined,
    operatorUnlock: async () => false,
    async requestCapabilities() {
      return {
        ok: true,
        alreadyActive: true,
        autoGranted: [{ id: 'issue-tracker', title: '工单系统', grantor: { id: 'ou_a', name: '张三' } }],
      }
    },
  }
  const { im, tasks, host, receive } = setup(auth)

  await receive('/后端任务 查一下我负责的任务', { sender: { id: 'ou_a', name: '张三', self: false } })
  const task = tasks.list()[0]!
  const deliveries = im.logs.get(task.session)!
  assert.equal(deliveries.length, 2)
  assert.equal(deliveries[0]!.delivery.mode, 'inject')
  assert.match(deliveries[0]!.text, /<skill_content name="backend-task">/)
  assert.equal(deliveries[1]!.delivery.mode, 'steer')
  assert.match(deliveries[1]!.text, /<im-auth status="auto-granted" capabilities="issue-tracker" \/>/)
  assert.match(deliveries[1]!.text, /已自动授权「工单系统」/)

  await host.dispose()
})

test('slashSkills lists user-invocable skills with the aliases that resolve to them', async () => {
  const { host } = setup()
  const skills = await host.slashSkills()
  assert.deepEqual(skills.map(skill => skill.name), ['ticket-intake', 'backend-task', 'quick-note'])
  assert.deepEqual(skills.find(skill => skill.name === 'ticket-intake'), {
    name: 'ticket-intake', description: '产品侧需求建单规范', commands: ['产品需求'],
  })
  assert.deepEqual(skills.find(skill => skill.name === 'quick-note')?.commands, ['笔记'])
})
