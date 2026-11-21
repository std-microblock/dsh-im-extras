/**
 * Core host for session exclusivity, collaborator delegation, and capability grants.
 *
 * @module dsh-im-session-auth/host
 */
import type { Context } from '@deepseek-ai/cordis'
import { h } from '@deepseek-ai/cordis-plugin-im-core'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  ImError, type ImActivity, type ImActivityChange, type ImApi, type ImButtonEvent, type ImChatKey,
  type ImCheckEvent, type ImMessageEvent, type ImMessageKey, type ImOutcome, type ImSelectEvent, type ImSessionRecord,
} from '@deepseek-ai/dsh-im'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolActivationContext } from '@deepseek-ai/dsh-tools'
import type {
  AcquireOutcome, AllowedUser, AutoGrantedCapability, CapabilityAcquireContext, CapabilityProvider, GrantStatus,
  ImSessionAuth, RequestCapabilitiesInput, RequestCapabilitiesResult, SessionAclView,
  SessionAuthConfig, SessionAuthRecord, SessionGrantRecord, SessionGrantView, SessionUser,
} from './api.ts'
import { grantKey, imSessionAuthDomain, type ImSessionAuthDomain } from './domain.ts'
import { applyTools } from './tools.ts'

/** Minimal structural slice of `dsh-im-card` (`ctx.imCards`). */
export interface ImCardsLike {
  registerAction(name: string, handler: (context: CardActionContextLike) => unknown): () => void
  registerGuard(guard: (context: CardGuardContextLike) => { ok: true } | { ok: false; toast: string }): () => void
  pushEvent(cardId: string, channel: string, data: unknown): Promise<boolean>
  publishInline?(request: {
    source: string
    props?: unknown
    session: SessionId
    chat: ImChatKey
    quote?: ImMessageKey
    thread?: string
    operationId?: string
    requester?: SessionUser
    grant?: boolean
  }): Promise<{ id: string; status: string; message?: string; error?: string }>
}

interface CardActionContextLike {
  cardId: string
  session: SessionId
  chat: ImChatKey
  message?: ImMessageKey
  requester?: SessionUser
  user?: SessionUser
  preview: boolean
  payload: unknown
}

interface CardGuardContextLike {
  cardId: string
  session: SessionId
  chat: ImChatKey
  user: SessionUser
  kind: 'button' | 'select' | 'check'
}

interface ExecEnvContributorLike {
  name: string
  variables: Readonly<Record<string, { description: string }>>
  resolve(agent: unknown): Readonly<Record<string, string | undefined>>
}

interface ExecEnvRegistryLike {
  register(contributor: ExecEnvContributorLike): () => void
}

interface SessionEventLike {
  type?: string
  data?: {
    source?: { kind?: unknown }
  }
}

interface CardBatch {
  id: string
  cardId: string
  sessionId: SessionId
  message?: ImMessageKey
  owner: SessionUser
  actor: SessionUser
  requestedIds: string[]
  outcomes: Map<string, { status: 'active' | 'pending' | 'reauth_required' | 'revoked' | 'failed'; message?: string }>
  settled: boolean
}

const MAX_RECENT_ACTORS = 2000

function cleanUser(user: SessionUser): SessionUser {
  const id = user.id.trim()
  const name = user.name?.trim()
  return name ? { id, name } : { id }
}

function userLabel(user: SessionUser | undefined): string {
  if (user === undefined) return '未知成员'
  return user.name ? `${user.name} (${user.id})` : user.id
}

function sessionIdOfAgent(agent: unknown): SessionId | undefined {
  if (typeof agent !== 'object' || agent === null) return undefined
  const id = (agent as { session?: { id?: unknown } }).session?.id
  return typeof id === 'string' && id.length > 0 ? (id as SessionId) : undefined
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return value !== null && typeof value === 'object' && typeof (value as { then?: unknown }).then === 'function'
}

/** Single-process owner of session ACLs and capability grants. */
export class SessionAuthHost implements ImSessionAuth {
  readonly im: ImApi
  readonly config: SessionAuthConfig
  private readonly ctx: Context
  private domain: ImSessionAuthDomain | undefined
  private readonly opened: Promise<void>
  private resolveOpened!: () => void
  private rejectOpened!: (error: unknown) => void
  private writeChain: Promise<void> = Promise.resolve()
  private disposed = false

  private readonly providers = new Map<string, CapabilityProvider>()
  private readonly sessions = new Map<string, SessionAuthRecord>()
  private readonly grants = new Map<string, SessionGrantRecord>()
  private readonly batches = new Map<string, CardBatch>()

  private readonly pendingSources = new Map<string, string>()
  private readonly turnActors = new Map<string, SessionUser | undefined>()
  private readonly lastCardActors = new Map<string, { user: SessionUser; at: number }>()
  private readonly refusalCooldowns = new Map<string, number>()
  private readonly autoGrantNotices = new Map<string, { text: string; turn?: number }>()

  private cards: ImCardsLike | undefined
  private execEnv: ExecEnvRegistryLike | undefined
  private toolsRegistry: Context['tools'] | undefined
  private readonly execEnvDisposers = new Map<string, () => void>()
  private readonly toolDisposers = new Map<string, () => void>()

  constructor(ctx: Context, im: ImApi, config: SessionAuthConfig) {
    this.ctx = ctx
    this.im = im
    this.config = config
    this.opened = new Promise<void>((resolve, reject) => {
      this.resolveOpened = resolve
      this.rejectOpened = reject
    })
    this.opened.catch(() => {})
  }

  /** Open the durable store, settle interrupted pending grants, and wire host hooks. */
  async open(): Promise<void> {
    try {
      const domain = await this.ctx.storageDomain.open(imSessionAuthDomain)
      this.domain = domain
      const now = Date.now()
      for (const [, rec] of domain.table('sessions').entries()) {
        this.sessions.set(rec.sessionId, rec)
      }
      const resetPending: SessionGrantRecord[] = []
      for (const [, grant] of domain.table('grants').entries()) {
        if (grant.status === 'pending') {
          const settled: SessionGrantRecord = {
            ...grant,
            status: 'revoked',
            statusMessage: '服务重启，原授权请求已中断',
            updatedAt: now,
          }
          this.grants.set(settled.key, settled)
          resetPending.push(settled)
        } else {
          this.grants.set(grant.key, grant)
        }
      }
      if (resetPending.length > 0) {
        await Promise.all(resetPending.map(record => domain.table('grants').put(record.key, record)))
      }
      this.wireRuntime()
      this.resolveOpened()
    } catch (error) {
      this.rejectOpened(error)
      throw error
    }
  }

  /** Drain writes and release all resources. */
  async dispose(): Promise<void> {
    this.disposed = true
    for (const dispose of this.execEnvDisposers.values()) dispose()
    this.execEnvDisposers.clear()
    for (const dispose of this.toolDisposers.values()) dispose()
    this.toolDisposers.clear()
    await this.writeChain
    const domain = this.domain
    this.domain = undefined
    this.batches.clear()
    this.pendingSources.clear()
    this.turnActors.clear()
    this.lastCardActors.clear()
    this.refusalCooldowns.clear()
    this.autoGrantNotices.clear()
    await domain?.close()
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Public API

  registerProvider(provider: CapabilityProvider): () => void {
    const id = provider.id.trim()
    if (!id) throw new ImError('configuration', 'CapabilityProvider id must be non-empty.')
    if (this.providers.has(id)) {
      throw new ImError('conflict', `CapabilityProvider "${id}" is already registered.`)
    }
    this.providers.set(id, provider)
    if (this.execEnv !== undefined) this.mountProviderExecEnv(provider)
    if (this.toolsRegistry !== undefined) this.mountProviderTools(provider)
    return () => {
      if (this.providers.get(id) !== provider) return
      this.providers.delete(id)
      this.execEnvDisposers.get(id)?.()
      this.execEnvDisposers.delete(id)
      this.toolDisposers.get(id)?.()
      this.toolDisposers.delete(id)
    }
  }

  isExclusive(sessionId: string): boolean {
    const sid = this.resolveSessionId(sessionId)
    return this.sessions.get(sid)?.exclusive === true
  }

  canInteract(sessionId: string, userId: string): boolean {
    const sid = this.resolveSessionId(sessionId)
    const record = this.sessions.get(sid)
    if (record === undefined || !record.exclusive) return true
    return record.allowedUsers.some(user => user.id === userId)
  }

  aclOf(sessionId: string): SessionAclView | undefined {
    const sid = this.resolveSessionId(sessionId)
    const record = this.sessions.get(sid)
    const grants = this.grantsOfSession(sid)
    if (record === undefined && grants.length === 0) return undefined
    return this.projectAcl(sid, record, grants)
  }

  listAcls(): SessionAclView[] {
    const ids = new Set<SessionId>()
    for (const record of this.sessions.values()) ids.add(record.sessionId)
    for (const grant of this.grants.values()) ids.add(grant.sessionId)
    return [...ids].map(sid => this.projectAcl(sid, this.sessions.get(sid), this.grantsOfSession(sid)))
  }

  grantFor(sessionId: string, capabilityId: string): SessionGrantRecord | undefined {
    const sid = this.resolveSessionId(sessionId)
    return this.grants.get(grantKey(sid, capabilityId))
  }

  async requestCapabilities(request: RequestCapabilitiesInput): Promise<RequestCapabilitiesResult> {
    await this.opened
    const sid = this.resolveSessionId(request.sessionId)
    const unique = [...new Set(request.capabilities.map(id => id.trim()).filter(Boolean))]
    const needed = unique.filter(capId => this.grants.get(grantKey(sid, capId))?.status !== 'active')
    if (needed.length === 0) {
      return { ok: true, alreadyActive: true }
    }

    const requester = request.requester !== undefined && request.requester.id.trim().length > 0
      ? cleanUser(request.requester)
      : undefined
    const autoGranted: AutoGrantedCapability[] = []
    const remaining: string[] = []

    if (requester !== undefined && (!this.isExclusive(sid) || this.canInteract(sid, requester.id))) {
      const now = Date.now()
      let claimedSession = false
      for (const capId of needed) {
        const provider = this.providers.get(capId)
        if (provider?.tryAutoAcquire === undefined) {
          remaining.push(capId)
          continue
        }
        let outcome: { status: 'granted'; message?: string; meta?: Record<string, unknown> } | undefined
        try {
          outcome = await provider.tryAutoAcquire({
            sessionId: sid,
            grantor: requester,
            chat: request.chat,
            ...(request.reason === undefined ? {} : { reason: request.reason }),
          })
        } catch (error) {
          this.ctx.logger.warn('im-session-auth: tryAutoAcquire(%s) failed: %s', capId, String(error))
          outcome = undefined
        }
        if (outcome?.status !== 'granted') {
          remaining.push(capId)
          continue
        }
        if (!claimedSession) {
          const auth = this.claimExclusiveSync(sid, requester, now)
          await this.persistSession(auth)
          claimedSession = true
        }
        const grant: SessionGrantRecord = {
          key: grantKey(sid, capId),
          sessionId: sid,
          capabilityId: capId,
          status: 'active',
          grantor: requester,
          chat: request.chat,
          ...(outcome.message === undefined ? {} : { statusMessage: outcome.message }),
          meta: { ...(outcome.meta ?? {}), autoGranted: true },
          createdAt: this.grants.get(grantKey(sid, capId))?.createdAt ?? now,
          updatedAt: now,
        }
        this.grants.set(grant.key, grant)
        await this.persistGrant(grant)
        autoGranted.push({ id: capId, title: provider.title, grantor: requester })
      }
    } else {
      remaining.push(...needed)
    }

    if (autoGranted.length > 0) {
      const titles = autoGranted.map(item => item.title).join('、')
      const who = requester?.name ? `（${requester.name}）` : ''
      this.setBounded(this.autoGrantNotices, sid, { text: `🔐 已自动授权：${titles}${who}` })
    }

    if (remaining.length === 0) {
      return {
        ok: true,
        alreadyActive: true,
        ...(autoGranted.length > 0 ? { autoGranted } : {}),
      }
    }

    if (this.cards?.publishInline === undefined) {
      return { ok: false, error: '当前环境未挂载交互卡片服务，无法自动发送授权卡片' }
    }
    try {
      const published = await this.cards.publishInline({
        source: 'export default (props: { capabilities: string[]; reason?: string; title?: string }) => <AuthRequest capabilities={props.capabilities} reason={props.reason} title={props.title} />',
        props: {
          capabilities: remaining,
          ...(request.reason === undefined ? {} : { reason: request.reason }),
          ...(request.title === undefined ? {} : { title: request.title }),
        },
        session: sid,
        chat: request.chat,
        ...(request.quote === undefined ? {} : { quote: request.quote }),
        ...(request.thread === undefined ? {} : { thread: request.thread }),
        ...(request.operationId === undefined ? {} : { operationId: request.operationId }),
        ...(requester === undefined ? {} : { requester }),
      })
      if (published.status === 'failed') {
        return { ok: false, error: published.error ?? '授权卡片发送失败' }
      }
      return {
        ok: true,
        cardId: published.id,
        ...(published.message === undefined ? {} : { message: published.message as ImMessageKey }),
        ...(autoGranted.length > 0 ? { autoGranted } : {}),
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  isTaskAgent(agent: Agent | undefined): boolean {
    if (agent === undefined) return false
    const record = this.im.sessions.of(agent.session.id)
    return record !== undefined && record.parent !== undefined
  }

  hasActiveGrant(agent: Agent | undefined, capabilityId: string): boolean {
    if (agent === undefined) return false
    const record = this.im.sessions.of(agent.session.id)
    if (record === undefined) return false
    return this.grants.get(grantKey(record.sessionId, capabilityId))?.status === 'active'
  }

  sessionAccessOf(agent: Agent | undefined): SessionAclView {
    const record = this.requireTaskRecord(agent)
    return this.projectAcl(record.sessionId, this.sessions.get(record.sessionId), this.grantsOfSession(record.sessionId))
  }

  async grantUsers(agent: Agent | undefined, users: readonly SessionUser[]): Promise<SessionAclView> {
    await this.opened
    const record = this.requireTaskRecord(agent)
    const normalized = users.map(cleanUser).filter(u => u.id.length > 0)
    if (normalized.length === 0) {
      throw new ImError('capacity', 'Provide at least one valid platform user id to grant session access.')
    }
    const actor = this.requireHumanActor(record.sessionId)
    const now = Date.now()
    const auth = this.claimExclusiveSync(record.sessionId, actor, now)
    let changed = false
    for (const candidate of normalized) {
      const existing = auth.allowedUsers.find(u => u.id === candidate.id)
      if (existing === undefined) {
        auth.allowedUsers.push({
          ...candidate,
          addedBy: actor.id,
          addedAt: now,
        })
        changed = true
      } else if (existing.name === undefined && candidate.name !== undefined) {
        existing.name = candidate.name
        changed = true
      }
    }
    if (changed) {
      auth.updatedAt = now
      await this.persistSession(auth)
    } else {
      await this.writeChain
    }
    return this.projectAcl(record.sessionId, auth, this.grantsOfSession(record.sessionId))
  }

  async revokeUsers(agent: Agent | undefined, userIds: readonly string[]): Promise<SessionAclView> {
    await this.opened
    const record = this.requireTaskRecord(agent)
    const targets = new Set(userIds.map(id => id.trim()).filter(Boolean))
    if (targets.size === 0) {
      throw new ImError('capacity', 'Provide at least one platform user id to revoke.')
    }
    const actor = this.requireHumanActor(record.sessionId)
    const auth = this.sessions.get(record.sessionId)
    if (auth === undefined || !auth.exclusive) {
      throw new ImError('access', '当前会话尚未进入独占状态，无需移出协作者。')
    }
    if (!this.canInteract(record.sessionId, actor.id)) {
      throw new ImError('access', '当前操作者没有权限修改此独占会话的协作者名单。')
    }
    if (auth.owner !== undefined && targets.has(auth.owner.id)) {
      throw new ImError('access', '不能移出当前会话的独占者（Owner）。')
    }
    const before = auth.allowedUsers.length
    auth.allowedUsers = auth.allowedUsers.filter(user => !targets.has(user.id))
    if (auth.allowedUsers.length !== before) {
      auth.updatedAt = Date.now()
      await this.persistSession(auth)
    }
    return this.projectAcl(record.sessionId, auth, this.grantsOfSession(record.sessionId))
  }

  async revokeUserCapability(capabilityId: string, userId: string, reason: string): Promise<number> {
    await this.opened
    const affectedCards = new Set<string>()
    const affectedSessions = new Set<SessionId>()
    const provider = this.providers.get(capabilityId)
    const now = Date.now()
    let count = 0

    for (const grant of this.grants.values()) {
      if (grant.capabilityId !== capabilityId || grant.grantor.id !== userId || grant.status === 'revoked') continue
      grant.status = 'revoked'
      grant.statusMessage = reason
      grant.updatedAt = now
      count++
      affectedSessions.add(grant.sessionId)
      if (grant.cardId !== undefined) affectedCards.add(grant.cardId)
      await this.persistGrant(grant)
      if (provider?.onRevoke !== undefined) {
        try {
          await provider.onRevoke(grant, reason)
        } catch (error) {
          this.ctx.logger.warn('im-session-auth: onRevoke(%s) failed: %s', capabilityId, String(error))
        }
      }
    }

    for (const cardId of affectedCards) {
      await this.pushCardSummary(cardId, true)
    }
    const title = provider?.title ?? capabilityId
    for (const sid of affectedSessions) {
      await this.deliverNotice(
        sid,
        `auth-user-revoke:${capabilityId}:${userId}:${now}`,
        'inject',
        `<im-auth capability="${capabilityId}" user="${userId}" status="revoked" />\n用户已清除/撤销「${title}」授权：${reason}（当前会话仍保持独占）。`,
      )
    }
    return count
  }

  async notifyUserReauthenticated(capabilityId: string, userId: string): Promise<number> {
    await this.opened
    const provider = this.providers.get(capabilityId)
    const title = provider?.title ?? capabilityId
    const now = Date.now()
    const affectedCards = new Set<string>()
    const restoredSessions: SessionId[] = []
    const sessionMessages = new Map<SessionId, ImMessageKey | undefined>()

    for (const grant of this.grants.values()) {
      if (grant.capabilityId !== capabilityId || grant.grantor.id !== userId) continue
      if (grant.status !== 'reauth_required') continue
      grant.status = 'active'
      delete grant.statusMessage
      grant.updatedAt = now
      await this.persistGrant(grant)
      restoredSessions.push(grant.sessionId)
      if (!sessionMessages.has(grant.sessionId) || grant.cardMessage !== undefined) {
        sessionMessages.set(grant.sessionId, grant.cardMessage)
      }
      if (grant.cardId !== undefined) affectedCards.add(grant.cardId)
    }

    for (const cardId of affectedCards) {
      await this.pushCardSummary(cardId, false)
    }
    for (const sid of restoredSessions) {
      await this.deliverNotice(
        sid,
        `auth-reauth:${capabilityId}:${userId}:${now}`,
        'steer',
        `<im-auth capability="${capabilityId}" user="${userId}" status="reauthenticated" />\n用户已在私聊中重新完成「${title}」登录，授权已恢复，可继续执行之前的任务。`,
        sessionMessages.get(sid),
      )
    }
    return restoredSessions.length
  }

  async operatorUnlock(sessionId: string): Promise<boolean> {
    await this.opened
    const sid = this.resolveSessionId(sessionId)
    const auth = this.sessions.get(sid)
    const grants = this.grantsOfSession(sid).filter(grant => grant.status !== 'revoked')
    if ((auth === undefined || !auth.exclusive) && grants.length === 0) return false

    const now = Date.now()
    const affectedCards = new Set<string>()
    for (const grant of grants) {
      grant.status = 'revoked'
      grant.statusMessage = '运维在管理面板中解除了会话独占'
      grant.updatedAt = now
      if (grant.cardId !== undefined) affectedCards.add(grant.cardId)
      await this.persistGrant(grant)
      const provider = this.providers.get(grant.capabilityId)
      if (provider?.onRevoke !== undefined) {
        try {
          await provider.onRevoke(grant, 'operator-unlock')
        } catch (error) {
          this.ctx.logger.warn('im-session-auth: operatorUnlock onRevoke(%s) failed: %s', grant.capabilityId, String(error))
        }
      }
    }

    if (auth !== undefined && auth.exclusive) {
      auth.exclusive = false
      delete auth.owner
      auth.allowedUsers = []
      auth.updatedAt = now
      await this.persistSession(auth)
    }

    for (const cardId of affectedCards) {
      await this.pushCardSummary(cardId, true)
    }
    if (grants.length > 0) {
      await this.deliverNotice(
        sid,
        `auth-op-unlock:${sid}:${now}`,
        'inject',
        `<im-auth session="${sid}" status="unlocked" />\n运维已在管理面板解除了本会话的独占状态，并同步收回了已授予的会话能力。`,
      )
    }
    return true
  }

  /** System prompt section injected into task worker sessions (`order: 82`). */
  prompt(agent?: Agent): string {
    if (!this.isTaskAgent(agent)) return ''
    const record = this.im.sessions.of(agent!.session.id)!
    const acl = this.sessions.get(record.sessionId)
    const grants = this.grantsOfSession(record.sessionId)
    const grantByCap = new Map(grants.map(g => [g.capabilityId, g]))

    const lines: string[] = [
      '# 会话独占与能力授权 (im-session-auth)',
      '',
      '你可以在回复中使用 ```satori-tsx 内联卡片或 `im_send_card` 发送预制组件 `<AuthRequest />` 来向用户申请会话独占或能力授权：',
      '- 纯独占申请：`export default <AuthRequest reason="…" />`',
      '- 申请一项或多项能力：`export default <AuthRequest capabilities={["feishu-project"]} reason="…" />`',
      '- 一旦会话被独占，仅独占者及被显式授权的协作者可与该会话交互；当独占者或协作者在群里显式要求把权限分享给某人（例如 `@bot 给 @张三 我这个session的权限`）时，从消息提及或 `im_members` 取得其平台用户 id 并调用 `grant_session_access`；移出协作者用 `revoke_session_access`（不可移出独占者本人）；查看当前状态用 `get_session_access`。',
    ]

    if (acl?.exclusive) {
      const names = acl.allowedUsers.map(u => userLabel(u)).join('、')
      lines.push(`- 当前会话独占状态：已由 ${userLabel(acl.owner)} 独占，已授权交互成员：${names || userLabel(acl.owner)}。`)
    } else {
      lines.push('- 当前会话独占状态：未独占。')
    }

    if (this.providers.size > 0) {
      lines.push('', '## 已注册能力状态与指引')
      for (const provider of this.providers.values()) {
        const grant = grantByCap.get(provider.id)
        if (grant?.status === 'active') {
          lines.push(`- ✅ **${provider.title}** (\`${provider.id}\`)：已授权（授权人：${userLabel(grant.grantor)}）。${provider.activeGuidance ?? ''}`.trim())
        } else if (grant?.status === 'reauth_required') {
          lines.push(`- ⚠️ **${provider.title}** (\`${provider.id}\`)：凭据需要重新登录（${grant.statusMessage ?? '等待用户私聊重登'}）。请暂停调用相关操作并提示用户前往私聊完成登录。`)
        } else if (grant?.status === 'pending') {
          lines.push(`- ⏳ **${provider.title}** (\`${provider.id}\`)：授权处理中（${grant.statusMessage ?? '等待用户完成授权'}）。`)
        } else {
          lines.push(`- 🔒 **${provider.title}** (\`${provider.id}\`)：未授权 — ${provider.description} ${provider.requestGuidance ?? ''}`.trim())
        }
      }
    }

    return lines.join('\n')
  }

  /**
   * Intercept addressed slash commands inside exclusive sessions from unauthorized users (`prepend: true`).
   * Registered after `await open()` so `unshift` places it ahead of `im-session-commands`.
   */
  async handleCommandMessage(event: ImMessageEvent, next: () => Promise<ImOutcome>): Promise<ImOutcome> {
    const { message } = event
    if (message.command === undefined || !message.addressed || message.sender.self) return await next()
    await this.opened
    const chat = message.chat.key
    const records = this.im.sessions.forChat(chat)
    const thread = message.thread?.id
    const targeted = thread !== undefined
      ? records.filter(record => record.bindings.some(binding => binding.chat === chat && binding.thread === thread))
      : records.filter(record => record.bindings.some(binding => binding.chat === chat && binding.home === true && binding.thread === undefined))

    const blocked = targeted.find(record => this.isExclusive(record.sessionId) && !this.canInteract(record.sessionId, message.sender.id))
    if (blocked === undefined) return await next()

    const throttleKey = `cmd\0${chat}\0${thread ?? ''}\0${message.sender.id}`
    if (this.shouldReplyRefusal(throttleKey)) {
      const owner = this.sessions.get(blocked.sessionId)?.owner
      const ownerFragment = owner !== undefined
        ? h('at', { type: 'user', id: owner.id, ...(owner.name ? { name: owner.name } : {}) })
        : '独占者'
      await event.reply(
        ['当前会话由 ', ownerFragment, ' 独占，你无权执行该指令。'],
        { operationId: `im-session-auth:cmd:${message.key}` },
      ).catch((error) => {
        this.ctx.logger.warn('im-session-auth: command refusal reply failed: %s', String(error))
      })
    }
    return { kind: 'handled', by: 'im-session-auth' }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Runtime wiring

  private wireRuntime(): void {
    this.ctx.on('im/button', (event: ImButtonEvent) => {
      if (event.session !== undefined && !event.user.isBot) {
        this.recordCardActor(event.session, cleanUser({ id: event.user.id, name: event.user.name }))
      }
    })
    this.ctx.on('im/select', (event: ImSelectEvent) => {
      if (event.session !== undefined && !event.user.isBot) {
        this.recordCardActor(event.session, cleanUser({ id: event.user.id, name: event.user.name }))
      }
    })
    this.ctx.on('im/check', (event: ImCheckEvent) => {
      if (event.session !== undefined && !event.user.isBot) {
        this.recordCardActor(event.session, cleanUser({ id: event.user.id, name: event.user.name }))
      }
    })

    this.ctx.on('session/event', (session, event) => {
      const ev = event as SessionEventLike
      if (ev.type === 'user/message') {
        const kind = ev.data?.source?.kind
        if (typeof kind === 'string' && kind.length > 0) {
          this.setBounded(this.pendingSources, session.id, kind)
        }
      }
    })

    this.ctx.on('im/activity', (activity: ImActivity, change: ImActivityChange) => {
      const sid = activity.session.sessionId
      if (change === 'start') {
        const src = this.pendingSources.get(sid)
        this.pendingSources.delete(sid)
        if (activity.trigger !== undefined && !activity.trigger.sender.self) {
          this.turnActors.set(sid, cleanUser({ id: activity.trigger.sender.id, name: activity.trigger.sender.name }))
        } else if (src === 'im') {
          const recent = this.lastCardActors.get(sid)
          this.turnActors.set(sid, recent !== undefined && Date.now() - recent.at < 30_000 ? recent.user : undefined)
        } else {
          this.turnActors.set(sid, undefined)
        }
      } else if (change === 'end') {
        this.turnActors.delete(sid)
        const notice = this.autoGrantNotices.get(sid)
        if (notice !== undefined && notice.turn === activity.turn) {
          this.autoGrantNotices.delete(sid)
        }
      }
    })

    // Append a one-line auto-authorization notice into the streamed summary card of the first turn.
    ;(this.ctx as unknown as {
      on(
        name: 'im/streaming-message',
        fn: (
          message: {
            activity: { session: { sessionId: string }; turn: number }
            part: string
            hasProcessMessage?: boolean
          },
          next: () => unknown[],
        ) => unknown[],
      ): () => void
    }).on('im/streaming-message', (message, next) => {
      const content = next()
      if (message.hasProcessMessage) return content
      const notice = this.autoGrantNoticeForTurn(message.activity.session.sessionId, message.activity.turn)
      if (notice === undefined) return content
      return [...content, h('small', h.text(notice))]
    })

    this.ctx.on('agent/pre-step', async (payload, next) => {
      await this.beforeStep(payload.agent, payload.signal)
      return await next()
    })

    this.ctx.inject(['tools'], (scoped) => {
      const tools = scoped.tools
      this.toolsRegistry = tools
      const disposeCore = applyTools(tools, this)
      for (const provider of this.providers.values()) this.mountProviderTools(provider)
      scoped.effect(() => () => {
        disposeCore()
        for (const dispose of this.toolDisposers.values()) dispose()
        this.toolDisposers.clear()
        if (this.toolsRegistry === tools) this.toolsRegistry = undefined
      }, 'im-session-auth: tools')
    })

    this.ctx.inject(['systemPrompt'], (scoped) => {
      scoped.effect(() => scoped.systemPrompt.section({
        name: 'im-session-auth',
        order: 82,
        interpolate: false,
        text: ({ agent }) => this.prompt(agent),
      }), 'im-session-auth: system prompt')
    })

    this.ctx.inject(['execEnv'], (scoped) => {
      const registry = scoped.get('execEnv') as ExecEnvRegistryLike | undefined
      if (registry === undefined) return
      this.execEnv = registry
      for (const provider of this.providers.values()) this.mountProviderExecEnv(provider)
      scoped.effect(() => () => {
        for (const dispose of this.execEnvDisposers.values()) dispose()
        this.execEnvDisposers.clear()
        if (this.execEnv === registry) this.execEnv = undefined
      }, 'im-session-auth: execEnv')
    })

    this.ctx.inject(['imCards'], (scoped) => {
      const cards = scoped.get('imCards') as ImCardsLike | undefined
      if (cards === undefined) return
      this.cards = cards
      const disposers = [
        cards.registerGuard(({ session, user }) => {
          if (this.canInteract(session, user.id)) return { ok: true }
          const owner = this.sessions.get(this.resolveSessionId(session))?.owner
          const label = owner?.name || '独占者'
          return { ok: false, toast: `当前会话由 ${label} 独占，仅独占者及已授权协作者可操作` }
        }),
        cards.registerAction('auth:describe', ctx => this.handleDescribeAction(ctx)),
        cards.registerAction('auth:grant', ctx => this.handleGrantAction(ctx)),
        cards.registerAction('auth:decline', ctx => this.handleDeclineAction(ctx)),
        cards.registerAction('auth:revoke', ctx => this.handleRevokeAction(ctx)),
      ]
      scoped.effect(() => () => {
        for (const dispose of disposers) dispose()
        if (this.cards === cards) this.cards = undefined
      }, 'im-session-auth: imCards bridge')
    })
  }

  private mountProviderExecEnv(provider: CapabilityProvider): void {
    const registry = this.execEnv
    const contrib = provider.execEnv
    if (registry === undefined || contrib === undefined || this.execEnvDisposers.has(provider.id)) return
    const dispose = registry.register({
      name: `im-session-auth:${provider.id}`,
      variables: contrib.variables,
      resolve: (agent: unknown) => {
        const agentSid = sessionIdOfAgent(agent)
        if (agentSid === undefined) return {}
        const sid = this.im.sessions.of(agentSid)?.sessionId ?? agentSid
        const grant = this.grants.get(grantKey(sid, provider.id))
        if (grant === undefined || grant.status !== 'active') return {}
        return contrib.resolve(grant, agent)
      },
    })
    this.execEnvDisposers.set(provider.id, dispose)
  }

  private mountProviderTools(provider: CapabilityProvider): void {
    const tools = this.toolsRegistry
    if (tools === undefined || provider.tools === undefined || provider.tools.length === 0) return
    if (this.toolDisposers.has(provider.id)) return
    const list = provider.tools.map(definition =>
      tools.register(definition, { when: ({ agent }: ToolActivationContext) => this.hasActiveGrant(agent, provider.id) }),
    )
    this.toolDisposers.set(provider.id, () => {
      for (const dispose of list) dispose()
    })
  }

  private async beforeStep(agent: Agent, signal: AbortSignal): Promise<void> {
    const record = this.im.sessions.of(agent.session.id)
    if (record === undefined) return
    const activeGrants = this.grantsOfSession(record.sessionId).filter(grant => grant.status === 'active')
    for (const grant of activeGrants) {
      const provider = this.providers.get(grant.capabilityId)
      if (provider?.ensureReady === undefined) continue
      let outcome
      try {
        outcome = await provider.ensureReady(grant, signal)
      } catch (error) {
        this.ctx.logger.warn('im-session-auth: ensureReady(%s) threw: %s', grant.capabilityId, String(error))
        continue
      }
      if (outcome.status === 'ready') {
        if (outcome.meta !== undefined) {
          grant.meta = outcome.meta
          grant.updatedAt = Date.now()
          await this.persistGrant(grant)
        }
        continue
      }
      const nextStatus: GrantStatus = outcome.status === 'reauth_required' ? 'reauth_required' : 'revoked'
      grant.status = nextStatus
      grant.statusMessage = outcome.message
      grant.updatedAt = Date.now()
      await this.persistGrant(grant)
      if (grant.cardId !== undefined) {
        await this.pushCardSummary(grant.cardId, false)
      }
      if (nextStatus === 'reauth_required') {
        await this.deliverNotice(
          record.sessionId,
          `auth-prestep-reauth:${grant.capabilityId}:${grant.updatedAt}`,
          'inject',
          `<im-auth capability="${grant.capabilityId}" status="reauth_required" />\n「${provider.title}」凭据已失效：${outcome.message}。请向用户说明等待私聊重登完成，不要尝试在终端执行登录命令。`,
        )
      }
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Card action handlers

  private handleDescribeAction(ctx: CardActionContextLike): unknown {
    const payload = (ctx.payload !== null && typeof ctx.payload === 'object' ? ctx.payload : {}) as Record<string, unknown>
    const ids = Array.isArray(payload.capabilities)
      ? payload.capabilities.filter((item): item is string => typeof item === 'string')
      : []
    return {
      ok: true,
      capabilities: ids.map((id) => {
        const provider = this.providers.get(id)
        return provider === undefined
          ? { id, title: id, available: false }
          : { id: provider.id, title: provider.title, description: provider.description, available: true }
      }),
    }
  }

  private handleGrantAction(ctx: CardActionContextLike): unknown {
    const gate = this.verifyCardActionActor(ctx)
    if (!gate.ok) return gate
    const actor = gate.user
    const payload = (ctx.payload !== null && typeof ctx.payload === 'object' ? ctx.payload : {}) as Record<string, unknown>
    const requestedIds = Array.isArray(payload.capabilities)
      ? [...new Set(payload.capabilities.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map(v => v.trim()))]
      : []
    const reason = typeof payload.reason === 'string' && payload.reason.trim() !== '' ? payload.reason.trim() : undefined

    const sid = this.resolveSessionId(ctx.session)
    if (this.isExclusive(sid) && !this.canInteract(sid, actor.id)) {
      return { ok: false, error: '当前会话已被其他成员独占' }
    }

    this.recordCardActor(sid, actor)
    const now = Date.now()
    const auth = this.claimExclusiveSync(sid, actor, now)
    void this.persistSession(auth)

    if (requestedIds.length === 0) {
      const state = {
        status: 'granted' as const,
        ...(auth.owner === undefined ? {} : { owner: auth.owner }),
        actor,
        items: [],
      }
      void this.deliverNotice(
        sid,
        `auth-claim:${ctx.cardId}:${now}`,
        'steer',
        `<im-auth card="${ctx.cardId}" user="${actor.id}" status="claimed" />\n用户 ${userLabel(actor)} 已通过卡片认领并独占当前会话。`,
        ctx.message,
      )
      return { ok: true, toast: '已认领并独占会话', state }
    }

    const prevBatch = this.batches.get(ctx.cardId)
    const carriedIds = prevBatch !== undefined && !prevBatch.settled
      ? prevBatch.requestedIds.filter(id => !requestedIds.includes(id) && prevBatch.outcomes.get(id)?.status === 'active')
      : []
    const batch: CardBatch = {
      id: `${ctx.cardId}:${now}`,
      cardId: ctx.cardId,
      sessionId: sid,
      ...(ctx.message === undefined ? {} : { message: ctx.message }),
      owner: auth.owner ?? actor,
      actor,
      requestedIds: [...carriedIds, ...requestedIds],
      outcomes: new Map(),
      settled: false,
    }
    for (const carriedId of carriedIds) {
      const carried = prevBatch!.outcomes.get(carriedId)
      if (carried !== undefined) batch.outcomes.set(carriedId, carried)
    }
    this.batches.set(ctx.cardId, batch)

    const settledCaps = new Set<string>()
    for (const capId of requestedIds) {
      const provider = this.providers.get(capId)
      if (provider === undefined) {
        batch.outcomes.set(capId, { status: 'failed', message: '未找到对应的能力插件' })
        continue
      }

      const grant: SessionGrantRecord = {
        key: grantKey(sid, capId),
        sessionId: sid,
        capabilityId: capId,
        status: 'pending',
        grantor: actor,
        chat: ctx.chat,
        cardId: ctx.cardId,
        ...(ctx.message === undefined ? {} : { cardMessage: ctx.message }),
        createdAt: this.grants.get(grantKey(sid, capId))?.createdAt ?? now,
        updatedAt: now,
      }
      this.grants.set(grant.key, grant)

      const complete: CapabilityAcquireContext['complete'] = async (result) => {
        if (settledCaps.has(capId)) return
        settledCaps.add(capId)
        await this.finishCapabilityAcquire(batch, grant, provider, result)
      }

      let outcomeOrPromise: AcquireOutcome | Promise<AcquireOutcome>
      try {
        outcomeOrPromise = provider.acquire({
          sessionId: sid,
          grantor: actor,
          chat: ctx.chat,
          cardId: ctx.cardId,
          ...(reason === undefined ? {} : { reason }),
          complete,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        grant.status = 'revoked'
        grant.statusMessage = message
        grant.updatedAt = Date.now()
        void this.persistGrant(grant)
        batch.outcomes.set(capId, { status: 'failed', message })
        continue
      }

      if (isPromiseLike(outcomeOrPromise)) {
        batch.outcomes.set(capId, { status: 'pending', message: '正在发起授权…' })
        void this.persistGrant(grant)
        void outcomeOrPromise.then(
          async (outcome) => {
            if (outcome.status === 'granted') {
              await complete({
                ok: true,
                ...(outcome.message === undefined ? {} : { message: outcome.message }),
                ...(outcome.meta === undefined ? {} : { meta: outcome.meta }),
              })
            } else if (outcome.status === 'failed') {
              await complete({ ok: false, error: outcome.error })
            } else if (outcome.message !== undefined) {
              grant.statusMessage = outcome.message
              grant.updatedAt = Date.now()
              await this.persistGrant(grant)
              if (this.batches.get(ctx.cardId) === batch && !batch.settled) {
                batch.outcomes.set(capId, { status: 'pending', message: outcome.message })
                await this.cards?.pushEvent(ctx.cardId, 'auth', this.buildBatchState(batch))
              }
            }
          },
          async (error: unknown) => {
            await complete({ ok: false, error: error instanceof Error ? error.message : String(error) })
          },
        )
      } else {
        this.applySyncOutcome(batch, grant, outcomeOrPromise, settledCaps)
        void this.persistGrant(grant)
      }
    }

    const state = this.buildBatchState(batch)
    if (state.status !== 'pending') {
      batch.settled = true
      this.deliverBatchWakeup(batch, state)
      return {
        ok: true,
        toast: state.status === 'granted' ? '授权成功，会话已独占' : '授权未完成',
        state,
      }
    }
    return {
      ok: true,
      toast: '请在私聊中完成登录后自动继续',
      state,
    }
  }

  private handleDeclineAction(ctx: CardActionContextLike): unknown {
    const gate = this.verifyCardActionActor(ctx)
    if (!gate.ok) return gate
    const sid = this.resolveSessionId(ctx.session)
    if (this.isExclusive(sid) && !this.canInteract(sid, gate.user.id)) {
      return { ok: false, error: '当前会话已被其他成员独占' }
    }
    this.recordCardActor(sid, gate.user)
    void this.deliverNotice(
      sid,
      `auth-decline:${ctx.cardId}:${Date.now()}`,
      'steer',
      `<im-auth card="${ctx.cardId}" user="${gate.user.id}" status="declined" />\n用户 ${userLabel(gate.user)} 拒绝了本次能力/独占授权请求。`,
      ctx.message,
    )
    return {
      ok: true,
      toast: '已拒绝授权',
      state: { status: 'declined', actor: gate.user, items: [] },
    }
  }

  private handleRevokeAction(ctx: CardActionContextLike): unknown {
    if (ctx.preview || ctx.user === undefined || !ctx.user.id) {
      return { ok: false, error: '无法识别操作者身份' }
    }
    const actor = cleanUser(ctx.user)
    const sid = this.resolveSessionId(ctx.session)
    const acl = this.sessions.get(sid)
    const payload = (ctx.payload !== null && typeof ctx.payload === 'object' ? ctx.payload : {}) as Record<string, unknown>
    const requestedIds = Array.isArray(payload.capabilities)
      ? payload.capabilities.filter((v): v is string => typeof v === 'string')
      : []
    const targets = requestedIds.length > 0
      ? requestedIds.map(id => this.grants.get(grantKey(sid, id))).filter((g): g is SessionGrantRecord => g !== undefined)
      : this.grantsOfSession(sid).filter(g => g.cardId === ctx.cardId)

    for (const grant of targets) {
      const canRevoke = grant.grantor.id === actor.id || acl?.owner?.id === actor.id
      if (!canRevoke) {
        return { ok: false, error: '只有授权人或会话独占者可以撤销授权' }
      }
    }

    const now = Date.now()
    const revokedTitles: string[] = []
    for (const grant of targets) {
      if (grant.status === 'revoked') continue
      grant.status = 'revoked'
      grant.statusMessage = '用户在卡片上撤销了授权'
      grant.updatedAt = now
      void this.persistGrant(grant)
      const provider = this.providers.get(grant.capabilityId)
      revokedTitles.push(provider?.title ?? grant.capabilityId)
      if (provider?.onRevoke !== undefined) {
        void Promise.resolve(provider.onRevoke(grant, 'card-revoke')).catch((error) => {
          this.ctx.logger.warn('im-session-auth: onRevoke(%s) failed: %s', grant.capabilityId, String(error))
        })
      }
    }

    this.recordCardActor(sid, actor)
    if (revokedTitles.length > 0) {
      void this.deliverNotice(
        sid,
        `auth-revoke:${ctx.cardId}:${now}`,
        'inject',
        `<im-auth card="${ctx.cardId}" user="${actor.id}" status="revoked" />\n用户 ${userLabel(actor)} 已撤销以下能力授权：${revokedTitles.join('、')}（当前会话仍保持独占）。`,
        ctx.message,
      )
    }

    const items = targets.map(grant => ({
      id: grant.capabilityId,
      title: this.providers.get(grant.capabilityId)?.title ?? grant.capabilityId,
      status: 'revoked' as const,
      ...(grant.statusMessage === undefined ? {} : { message: grant.statusMessage }),
    }))
    return {
      ok: true,
      toast: '已撤销授权（会话仍保持独占）',
      state: {
        status: 'revoked',
        ...(acl?.owner === undefined ? {} : { owner: acl.owner }),
        actor,
        items,
      },
    }
  }

  private verifyCardActionActor(ctx: CardActionContextLike): { ok: true; user: SessionUser } | { ok: false; error: string } {
    if (ctx.preview || ctx.user === undefined || !ctx.user.id) {
      return { ok: false, error: '当前环境不支持交互操作' }
    }
    const actor = cleanUser(ctx.user)
    const payload = (ctx.payload !== null && typeof ctx.payload === 'object' ? ctx.payload : {}) as Record<string, unknown>
    const sender = typeof payload.sender === 'string' ? payload.sender : 'anyone'
    const senderName = typeof payload.senderName === 'string' && payload.senderName.trim() !== ''
      ? payload.senderName.trim()
      : undefined
    if (sender !== 'anyone') {
      if (sender === 'requester') {
        if (ctx.requester !== undefined && actor.id !== ctx.requester.id) {
          return { ok: false, error: `只有 ${senderName ?? ctx.requester.name ?? '发起人'} 可以操作` }
        }
      } else if (actor.id !== sender) {
        return { ok: false, error: `只有 ${senderName ?? '指定成员'} 可以操作` }
      }
    }
    return { ok: true, user: actor }
  }

  private applySyncOutcome(
    batch: CardBatch,
    grant: SessionGrantRecord,
    outcome: AcquireOutcome,
    settledCaps: Set<string>,
  ): void {
    const now = Date.now()
    if (outcome.status === 'granted') {
      settledCaps.add(grant.capabilityId)
      grant.status = 'active'
      if (outcome.meta !== undefined) grant.meta = outcome.meta
      if (outcome.message !== undefined) grant.statusMessage = outcome.message
      else delete grant.statusMessage
      grant.updatedAt = now
      batch.outcomes.set(grant.capabilityId, {
        status: 'active',
        ...(outcome.message === undefined ? {} : { message: outcome.message }),
      })
      return
    }
    if (outcome.status === 'pending') {
      if (outcome.meta !== undefined) grant.meta = outcome.meta
      grant.statusMessage = outcome.message ?? '等待完成登录授权'
      grant.updatedAt = now
      batch.outcomes.set(grant.capabilityId, {
        status: 'pending',
        message: grant.statusMessage,
      })
      return
    }
    settledCaps.add(grant.capabilityId)
    grant.status = 'revoked'
    grant.statusMessage = outcome.error
    grant.updatedAt = now
    batch.outcomes.set(grant.capabilityId, {
      status: 'failed',
      message: outcome.error,
    })
  }

  private async finishCapabilityAcquire(
    batch: CardBatch,
    grant: SessionGrantRecord,
    provider: CapabilityProvider,
    result: { ok: true; message?: string; meta?: Record<string, unknown> } | { ok: false; error: string },
  ): Promise<void> {
    if (this.disposed) return
    const now = Date.now()
    const current = this.grants.get(grant.key)
    // Ignore stale completion if the session was explicitly unlocked/revoked in the meantime.
    if (current !== grant || (grant.status === 'revoked' && batch.settled)) return

    if (result.ok) {
      grant.status = 'active'
      if (result.meta !== undefined) grant.meta = result.meta
      if (result.message !== undefined) grant.statusMessage = result.message
      else delete grant.statusMessage
      grant.updatedAt = now
      batch.outcomes.set(provider.id, {
        status: 'active',
        ...(result.message === undefined ? {} : { message: result.message }),
      })
    } else {
      grant.status = 'revoked'
      grant.statusMessage = result.error
      grant.updatedAt = now
      batch.outcomes.set(provider.id, { status: 'failed', message: result.error })
    }
    await this.persistGrant(grant)

    if (this.batches.get(batch.cardId) !== batch) return
    const state = this.buildBatchState(batch)
    await this.cards?.pushEvent(batch.cardId, 'auth', state)
    if (state.status !== 'pending' && !batch.settled) {
      batch.settled = true
      this.deliverBatchWakeup(batch, state)
    }
  }

  private buildBatchState(batch: CardBatch): {
    status: 'pending' | 'granted' | 'error'
    owner: SessionUser
    actor: SessionUser
    items: { id: string; title: string; status: 'active' | 'pending' | 'reauth_required' | 'revoked' | 'failed'; message?: string }[]
    message?: string
  } {
    const items = batch.requestedIds.map((id) => {
      const outcome = batch.outcomes.get(id) ?? { status: 'pending' as const }
      const title = this.providers.get(id)?.title ?? id
      return {
        id,
        title,
        status: outcome.status,
        ...(outcome.message === undefined ? {} : { message: outcome.message }),
      }
    })
    const hasPending = items.some(item => item.status === 'pending')
    const hasActive = items.some(item => item.status === 'active')
    const status = hasPending ? 'pending' : hasActive ? 'granted' : 'error'
    return {
      status,
      owner: batch.owner,
      actor: batch.actor,
      items,
      ...(status === 'error' ? { message: items.find(i => i.message)?.message ?? '能力授权失败' } : {}),
    }
  }

  private deliverBatchWakeup(
    batch: CardBatch,
    state: ReturnType<SessionAuthHost['buildBatchState']>,
  ): void {
    const summary = state.items.map(item =>
      `${item.title} (${item.id}): ${item.status}${item.message ? ` (${item.message})` : ''}`,
    ).join('；')
    const statusAttr = state.status === 'granted' ? 'granted' : 'failed'
    const text = state.status === 'granted'
      ? `<im-auth card="${batch.cardId}" user="${batch.actor.id}" status="${statusAttr}" />\n用户 ${userLabel(batch.actor)} 已完成授权并独占当前会话：${summary}。你现在可以使用已授权能力继续处理用户任务。`
      : `<im-auth card="${batch.cardId}" user="${batch.actor.id}" status="${statusAttr}" />\n能力授权未成功：${summary}。`
    this.recordCardActor(batch.sessionId, batch.actor)
    const deliveryMode = state.status === 'granted' ? 'steer' : 'inject'
    void this.deliverNotice(batch.sessionId, `auth-settled:${batch.id}`, deliveryMode, text, batch.message)
  }

  private async pushCardSummary(cardId: string, allFlag: boolean): Promise<void> {
    if (this.cards === undefined) return
    const cardGrants = [...this.grants.values()].filter(g => g.cardId === cardId)
    if (cardGrants.length === 0) return
    const sid = cardGrants[0]!.sessionId
    const acl = this.sessions.get(sid)
    const items = cardGrants.map(g => ({
      id: g.capabilityId,
      title: this.providers.get(g.capabilityId)?.title ?? g.capabilityId,
      status: g.status,
      ...(g.statusMessage === undefined ? {} : { message: g.statusMessage }),
    }))
    const hasPending = items.some(i => i.status === 'pending')
    const hasActiveOrReauth = items.some(i => i.status === 'active' || i.status === 'reauth_required')
    const status = hasPending ? 'pending' : hasActiveOrReauth ? 'granted' : 'revoked'
    await this.cards.pushEvent(cardId, 'auth', {
      ...(allFlag ? { all: true } : {}),
      status,
      ...(acl?.owner === undefined ? {} : { owner: acl.owner }),
      actor: cardGrants[0]!.grantor,
      items,
    }).catch((error) => {
      this.ctx.logger.warn('im-session-auth: pushEvent(%s) failed: %s', cardId, String(error))
    })
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Internals

  private resolveSessionId(sessionId: string): SessionId {
    return this.im.sessions.of(sessionId as SessionId)?.sessionId
      ?? this.im.sessions.get(sessionId)?.sessionId
      ?? (sessionId as SessionId)
  }

  private requireTaskRecord(agent: Agent | undefined): ImSessionRecord {
    if (agent === undefined) {
      throw new ImError('ownership', 'Session access tools require a running IM session.')
    }
    const record = this.im.sessions.of(agent.session.id)
    if (record === undefined) {
      throw new ImError('ownership', 'Session access tools require an IM-hosted session.')
    }
    if (record.parent === undefined) {
      throw new ImError('access', 'Only task worker sessions manage session exclusivity and collaborators.')
    }
    return record
  }

  private requireHumanActor(sessionId: SessionId): SessionUser {
    let actor: SessionUser | undefined
    if (this.turnActors.has(sessionId)) {
      actor = this.turnActors.get(sessionId)
    } else {
      const trigger = this.im.sessions.trigger?.(sessionId)
      if (trigger !== undefined && !trigger.sender.self) {
        actor = cleanUser({ id: trigger.sender.id, name: trigger.sender.name })
      }
    }
    if (actor === undefined || !actor.id) {
      throw new ImError('access', '当前轮次并非由已鉴权的用户消息或卡片交互触发，拒绝修改会话访问权限。')
    }
    if (this.isExclusive(sessionId) && !this.canInteract(sessionId, actor.id)) {
      throw new ImError('access', '当前操作者没有权限修改此独占会话的协作者名单。')
    }
    return actor
  }

  private claimExclusiveSync(sessionId: SessionId, actor: SessionUser, now: number): SessionAuthRecord {
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined && existing.exclusive) {
      if (existing.owner?.id === actor.id && existing.owner.name === undefined && actor.name !== undefined) {
        existing.owner.name = actor.name
      }
      const allowed = existing.allowedUsers.find(u => u.id === actor.id)
      if (allowed !== undefined && allowed.name === undefined && actor.name !== undefined) {
        allowed.name = actor.name
      }
      return existing
    }
    const record: SessionAuthRecord = {
      sessionId,
      exclusive: true,
      owner: actor,
      allowedUsers: [{ ...actor, addedAt: now }],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    this.sessions.set(sessionId, record)
    return record
  }

  private grantsOfSession(sessionId: SessionId): SessionGrantRecord[] {
    const out: SessionGrantRecord[] = []
    for (const grant of this.grants.values()) {
      if (grant.sessionId === sessionId) out.push(grant)
    }
    return out
  }

  private projectAcl(
    sessionId: SessionId,
    record: SessionAuthRecord | undefined,
    grants: readonly SessionGrantRecord[],
  ): SessionAclView {
    const grantViews: SessionGrantView[] = grants.map(grant => ({
      capabilityId: grant.capabilityId,
      title: this.providers.get(grant.capabilityId)?.title ?? grant.capabilityId,
      status: grant.status,
      grantor: grant.grantor,
      ...(grant.statusMessage === undefined ? {} : { statusMessage: grant.statusMessage }),
      updatedAt: grant.updatedAt,
    }))
    return {
      sessionId,
      exclusive: record?.exclusive === true,
      ...(record?.owner === undefined ? {} : { owner: record.owner }),
      allowedUsers: record === undefined ? [] : [...record.allowedUsers],
      grants: grantViews,
    }
  }

  private async deliverNotice(
    sessionId: SessionId,
    id: string,
    mode: 'steer' | 'inject',
    text: string,
    messageKey?: ImMessageKey,
  ): Promise<void> {
    const trigger = messageKey === undefined ? undefined : this.im.history?.get?.(messageKey)
    try {
      await this.im.sessions.deliver(sessionId, {
        id,
        mode,
        content: [{ type: 'text', text }],
        ...(trigger === undefined ? {} : { trigger }),
      })
    } catch (error) {
      this.ctx.logger.warn('im-session-auth: failed to deliver notice to %s: %s', sessionId, String(error))
    }
  }

  private persistSession(record: SessionAuthRecord): Promise<void> {
    const snapshot = structuredClone(record)
    return this.queueWrite(async () => {
      await this.domain?.table('sessions').put(snapshot.sessionId, snapshot)
    })
  }

  private persistGrant(record: SessionGrantRecord): Promise<void> {
    const snapshot = structuredClone(record)
    return this.queueWrite(async () => {
      await this.domain?.table('grants').put(snapshot.key, snapshot)
    })
  }

  private queueWrite(fn: () => Promise<void>): Promise<void> {
    const next = this.writeChain.then(fn)
    this.writeChain = next.catch((error) => {
      this.ctx.logger.warn('im-session-auth: persistence failed: %s', String(error))
    })
    return next
  }

  private autoGrantNoticeForTurn(sessionId: string, turn: number): string | undefined {
    const sid = this.resolveSessionId(sessionId)
    const entry = this.autoGrantNotices.get(sid)
    if (entry === undefined) return undefined
    if (entry.turn === undefined) {
      entry.turn = turn
      return entry.text
    }
    return entry.turn === turn ? entry.text : undefined
  }

  private recordCardActor(sessionId: string, user: SessionUser): void {
    this.setBounded(this.lastCardActors, sessionId, { user, at: Date.now() })
  }

  private setBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
    map.delete(key)
    if (map.size >= MAX_RECENT_ACTORS) {
      const oldest = map.keys().next().value
      if (oldest !== undefined) map.delete(oldest)
    }
    map.set(key, value)
  }

  private shouldReplyRefusal(key: string): boolean {
    const now = Date.now()
    const prev = this.refusalCooldowns.get(key)
    if (prev !== undefined && now - prev < this.config.refusalThrottleMs) return false
    this.setBounded(this.refusalCooldowns, key, now)
    return true
  }
}
