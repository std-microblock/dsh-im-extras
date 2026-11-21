/**
 * `dsh-im-dispatch` — the session strategy of a chat bot on the DeepSeek Harness IM host: one read-only **router**
 * session per chat (one per topic on topic-mode chats) that reads every message and decides — answer in one line,
 * start a background **task worker** (`ctx.imTasks`), hand messages to a running one, change how the chat wakes it,
 * or stay silent — plus JavaScript **route rules** (QuickJS) that deliver matching messages straight to a worker,
 * opt-in thread follow-up, `/skill` commands that open a worker with the skill loaded, and the **chronicle**: a
 * compacted cross-chat log every router and worker can query.
 *
 * The plugin provides `ctx.imDispatch` ({@link ImDispatchService}) for operator tools and for plugins that extend
 * the strategy (the operator panel, page links, reactions …), and emits `im-dispatch/delivered`, `im-dispatch/rule`
 * and `im-dispatch/chat`.
 *
 * @module dsh-im-dispatch
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-im'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {
  ChatConfigView, ConfigureChatRequest, DispatchConfig, RouteRuleRequest, RouteRuleView,
} from './api.ts'
import { isRouterKey } from './api.ts'
import type {
  ChronicleEntry, ChronicleQueryRequest, ChronicleQueryResult, ChronicleStatus,
} from './chronicle/index.ts'
import { ChronicleService } from './chronicle/index.ts'
import { Config } from './config.ts'
import { DispatchHost, type DeliveryCause } from './host.ts'
import { ImError, isImError } from './im.ts'
import { SessionTitleSynchronizer } from './titles.ts'
import { applyTools } from './tools.ts'
import type {
  AgentLike, DispatchIm, ImButtonEventLike, ImHostedRecord, ImMessageEventLike, ImOutcomeLike, ImReactionEventLike,
  ImStoredMessage, ImTaskLike, ImTasksLike, LiveSessionLike, LlmServiceLike, PreStepDecisionLike, PreStepMessageLike,
  SessionAuthLike, SessionQueryLike, SessionStoreLike, SessionTitleServiceLike, SkillRegistryLike,
  StorageDomainLike, SystemPromptLike, ToolsLike,
} from './types.ts'

export * from './api.ts'
export { Config, DispatchConfig } from './config.ts'
export * from './chronicle/index.ts'
export { DispatchHost, messageView } from './host.ts'
export type { DeliveryCause, DispatchHostHooks, DispatchHostOptions } from './host.ts'
export { ImError, isImError, messageKey, operationId, splitKey } from './im.ts'
export { DEFAULT_DISPATCHER_PROMPT, workerPrompt } from './prompt.ts'
export { RULE_FIELDS, RuleEngine, messageType, ruleInput } from './rules.ts'
export type { RuleInput, RuleOutcome } from './rules.ts'
export { compileParameters, defineTool, validate } from './schema.ts'
export {
  SkillCommandResolver, extractSkillExtensions, parseSlashInvocation, renderSkillContentBlock,
} from './skills.ts'
export type { ResolvedSlashSkill, SkillExtensions, SlashInvocation } from './skills.ts'
export { TOOL_NAMES, applyTools, errorValue, taskView } from './tools.ts'
export {
  SessionTitleSynchronizer, cleanTitleText, formatRouterSessionTitle, formatTaskSessionTitle, shortPlatformId,
  shouldApplyAutoTitle,
} from './titles.ts'
export type { ChatTitleInfo, SessionTitleSynchronizerOptions, TitleSyncHost } from './titles.ts'
export type * from './types.ts'

/** Plugin identity. */
export const name = 'im-dispatch'

/** Prefix of the action button {@link ImDispatchService.ruleButton} renders. */
export const DELETE_RULE_BUTTON_PREFIX = 'im-dispatch:delete-rule:'

/** One chat as {@link ImDispatchService.chats} lists it. */
export interface DispatchChatView extends ChatConfigView {
  /** Platform chat type (`direct`, `group`, `topic`, …). */
  type: string
  /** Admission source of the first message seen in the chat. */
  source: string
  /** When the first message of the chat reached dispatch, Unix milliseconds. */
  firstSeenAt: number
}

/** The role a guidance contribution is shown to. */
export type DispatchRole = 'router' | 'worker'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The dispatch strategy: routers, task routing, route rules, per-chat configuration and the chronicle. */
    imDispatch: ImDispatchService
  }
  interface Events {
    /**
     * One message was delivered to a task worker by the strategy.
     * @param sessionId - the worker session.
     * @param messageKey - the delivered message.
     * @param cause - a matched route rule, a router hand-off, or thread follow-up.
     */
    'im-dispatch/delivered'(sessionId: string, messageKey: string, cause: DeliveryCause): void
    /**
     * A route rule was added, changed or removed.
     * @param change - what happened.
     * @param rule - the rule after the change (as it was, for a removal).
     */
    'im-dispatch/rule'(change: 'added' | 'changed' | 'removed', rule: RouteRuleView): void
    /**
     * A chat's wake/reply configuration changed.
     * @param view - the effective configuration after the change.
     */
    'im-dispatch/chat'(view: ChatConfigView): void
  }
}

/**
 * The element of a "delete this route rule" button, for a plugin that shows why a turn ran (e.g. a page-link panel
 * inside a streamed card). A click is handled by this plugin: the clicking user must be allowed to interact with the
 * rule's task (`ctx.imAuth`, when mounted). Platforms without buttons fall back to the hint line.
 * @param id - the rule id.
 * @returns the v4 element subtree.
 */
function deleteRuleControl(id: number): unknown {
  const text = (content: string): unknown => ({ type: 'text', attrs: { content }, children: [] })
  return {
    type: 'fallback',
    attrs: {},
    children: [
      {
        type: 'button',
        attrs: {
          type: 'action',
          id: `${DELETE_RULE_BUTTON_PREFIX}${String(id)}`,
          theme: 'danger',
          size: 'small',
          confirm: { title: '删除路由规则', text: `确定删除规则 #${String(id)} 吗？删除后该规则将不再投递后续消息。` },
        },
        children: [text(`删除规则 #${String(id)}`)],
      },
      { type: 'small', attrs: {}, children: [text(`如需删除规则 #${String(id)}，请在运维面板中操作`)] },
    ],
  }
}

/** The dispatch strategy as a service (`ctx.imDispatch`). */
export class ImDispatchService extends Service {
  static inject = ['im', 'imTasks', 'storageDomain', 'tools', 'systemPrompt']
  static Config = Config

  /** The behaviour behind this service; an escape hatch for tests and diagnostics — prefer the methods below. */
  readonly host: DispatchHost
  /** The chronicle this deployment records into. */
  readonly chronicle: ChronicleService
  private readonly home: Context
  private readonly titles: SessionTitleSynchronizer
  private readonly prompts = { router: new Set<() => string>(), worker: new Set<() => string>() }

  constructor(ctx: Context, readonly config: DispatchConfig) {
    super(ctx, 'imDispatch')
    this.home = ctx
    const logger = ctx.logger('im-dispatch')
    const im = ctx.im as unknown as DispatchIm
    const storage = ctx.storageDomain as unknown as StorageDomainLike
    this.chronicle = new ChronicleService({
      storage,
      llm: () => ctx.get('llm') as LlmServiceLike | undefined,
      defaultProvider: config.main.provider,
      defaultModel: config.main.model,
      config: config.chronicle,
      logger,
    })
    let titles: SessionTitleSynchronizer | undefined
    this.host = new DispatchHost({
      im,
      tasks: ctx.get('imTasks') as ImTasksLike,
      storage,
      logger,
      config,
      auth: () => ctx.get('imAuth') as SessionAuthLike | undefined,
      skills: () => ctx.get('skills') as SkillRegistryLike | undefined,
      chronicle: this.chronicle,
      ephemeral: this.chronicle.ephemeral,
      onChatUpdated: (chatKey) => { void titles?.syncChat(chatKey) },
      hooks: {
        delivered: (sessionId, key, cause) => { ctx.emit('im-dispatch/delivered', sessionId, key, cause) },
        ruleChanged: (change, rule) => { ctx.emit('im-dispatch/rule', change, rule) },
        chatConfigured: (view) => { ctx.emit('im-dispatch/chat', view) },
        prompts: role => [...this.prompts[role]].map(text => text()),
      },
    })
    titles = new SessionTitleSynchronizer({
      host: this.host,
      im,
      sessions: () => ctx.get('sessions') as SessionStoreLike | undefined,
      sessionTitle: () => ctx.get('sessionTitle') as SessionTitleServiceLike | undefined,
      sessionQuery: () => ctx.get('sessionQuery') as SessionQueryLike | undefined,
      logger,
    })
    this.titles = titles
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void>, void> {
    const ctx = this.home
    const host = this.host
    const logger = ctx.logger('im-dispatch')
    await host.whenReady()
    yield async () => {
      this.titles.dispose()
      await host.dispose()
    }
    ctx.on('im/message', (event, next) => host.handle(
      event as unknown as ImMessageEventLike,
      next as unknown as () => Promise<ImOutcomeLike>,
    ) as never)
    ctx.on('im/reaction', (event) => {
      void host.onReaction(event as unknown as ImReactionEventLike).catch((error: unknown) => {
        logger.warn('im-dispatch: reaction handling failed: %s', String(error))
      })
    })
    ctx.on('im/stored', (message) => {
      host.onStored(message as unknown as ImStoredMessage)
      this.chronicle.onStored(message as unknown as ImStoredMessage)
    })
    ctx.on('im/button', (event) => { void this.onButton(event as unknown as ImButtonEventLike) })
    ctx.on('session/created', (session) => { this.titles.onSessionCreated(session as unknown as LiveSessionLike) })
    ctx.on('im/task/started', (task) => {
      this.chronicle.onTaskStarted(task)
      void this.titles.syncSession(task.session)
    })
    ctx.on('im/task/updated', (task) => { void this.titles.syncSession(task.session) })
    ctx.on('im/session/reset', (record) => { void host.onSessionReset(record as unknown as ImHostedRecord) })
    ctx.on('skills/change', () => { host.invalidateSkillCache() })
    ctx.on('agent/pre-step', (payload, next) => host.beforeStep(
      payload as unknown as {
        agent: AgentLike; messages: PreStepMessageLike[]; turn: number; step: number; signal: AbortSignal
      },
      next as unknown as () => Promise<PreStepDecisionLike>,
    ) as never)
    applyTools(ctx.tools as unknown as ToolsLike, host, this.config)
    ;(ctx.systemPrompt as unknown as SystemPromptLike).section({
      name: 'tool:im-dispatch',
      order: 81,
      interpolate: false,
      text: ({ agent }) => host.prompt(agent),
    })
    void this.titles.backfill()
    logger.info('im-dispatch: mounted (router preset %s, worker preset %s, chronicle=%s)',
      this.config.main.agentPreset, this.config.worker.agentPreset, String(this.config.chronicle.enabled))
  }

  /** Resolves once the stores are open and every known router is registered. */
  ready(): Promise<void> {
    return this.host.whenReady()
  }

  // -------------------------------------------------------------------------------------------------------------
  // Reads

  /**
   * Why the strategy delivered one message to one session, while this process remembers it (the latest 2000).
   * @param sessionId - the receiving session.
   * @param messageKey - the delivered message.
   * @returns a matched route rule, a router hand-off, thread follow-up — or undefined (not delivered by dispatch).
   */
  deliveryCause(sessionId: string, messageKey: string): DeliveryCause | undefined {
    return this.host.deliveryCause(sessionId, messageKey)
  }

  /** Every chat that reached dispatch, with name, type and effective wake/reply configuration. */
  chats(): Promise<DispatchChatView[]> {
    return this.host.panelChats()
  }

  /**
   * Display name and platform type of one chat, when known (configured `chatNames` first, then the platform).
   * @param chat - chat key.
   */
  chatInfo(chat: string): { name?: string; type?: string } | undefined {
    return this.host.chatInfo(chat)
  }

  /** Every route rule of every dispatch task, in id order, with the failures observed since start. */
  rules(): Promise<RouteRuleView[]> {
    return this.host.panelRules()
  }

  /** Every router session this host created or saw. */
  routers(): ImHostedRecord[] {
    return this.host.routers()
  }

  /**
   * Whether a hosted session is a dispatch router.
   * @param key - the session record's key.
   */
  isRouter(key: string): boolean {
    return isRouterKey(key)
  }

  /**
   * The automatic title of a router or dispatch worker session (`[群路由] …`, `#12 …`).
   * @param sessionId - the session.
   * @param record - its record, when the caller already holds it.
   */
  sessionTitle(sessionId: string, record?: { key: string }): string | undefined {
    return this.host.desiredSessionTitle(sessionId, record)
  }

  /** Dispatch tasks (tasks a router started), newest first. */
  tasks(): ImTaskLike[] {
    return this.host.tasks.list().filter(task => this.isDispatchTask(task))
  }

  /** Size and recent entries of the chronicle. */
  chronicleStatus(): Promise<ChronicleStatus> {
    return this.chronicle.status()
  }

  /**
   * Browse the chronicle, newest first.
   * @param filter - chat key, id cursor (`before`), text match and page size.
   */
  chronicleEntries(filter?: { chat?: string; before?: number; query?: string; limit?: number }): Promise<{
    entries: ChronicleEntry[]; total: number; next?: number
  }> {
    return this.chronicle.entries(filter)
  }

  /**
   * Ask the chronicle a question (a model call over the stored log).
   * @param request - the question and an optional chat focus.
   * @param signal - cancellation.
   */
  queryChronicle(request: ChronicleQueryRequest, signal?: AbortSignal): Promise<ChronicleQueryResult> {
    return this.chronicle.query(request, signal)
  }

  // -------------------------------------------------------------------------------------------------------------
  // Operator writes

  /**
   * Add a route rule to a task, as the operator.
   * @param task - the task number.
   * @param request - expression, mode and note.
   */
  addRule(task: number, request: RouteRuleRequest): Promise<RouteRuleView> {
    return this.host.panelAddRule(task, request)
  }

  /**
   * Change a route rule of a task, as the operator.
   * @param task - the task number the rule belongs to.
   * @param id - the rule id.
   * @param patch - the fields to change.
   */
  updateRule(task: number, id: number, patch: Partial<RouteRuleRequest>): Promise<RouteRuleView> {
    return this.host.panelUpdateRule(task, id, patch)
  }

  /**
   * Remove a route rule. With `user`, the removal happens on that chat user's behalf and is refused (an `ImError`
   * with code `access`) when `ctx.imAuth` locks the rule's task to other people.
   * @param id - the rule id.
   * @param options - the acting platform user, if any.
   */
  async removeRule(id: number, options: { user?: string } = {}): Promise<RouteRuleView> {
    const auth = this.home.get('imAuth') as SessionAuthLike | undefined
    if (options.user !== undefined && auth !== undefined) {
      const task = await this.host.taskOfRule(id)
      if (task !== undefined && !auth.canInteract(task.session, options.user)) {
        throw new ImError('access', '当前任务已被独占，仅独占者及已授权协作者可删除该规则')
      }
    }
    return await this.host.panelRemoveRule(id)
  }

  /**
   * Change one chat's wake/reply configuration, as the operator.
   * @param chat - chat key or bare platform chat id.
   * @param request - the fields to change.
   */
  configureChat(chat: string, request: Omit<ConfigureChatRequest, 'chat'>): Promise<ChatConfigView> {
    return this.host.panelConfigureChat(chat, request)
  }

  // -------------------------------------------------------------------------------------------------------------
  // Extension points

  /**
   * Keep one own message out of the router context and the chronicle (a status line, a link, a refusal…).
   * @param messageKey - the stored key of the message, as the send receipt reports it.
   */
  markEphemeral(messageKey: string | undefined): void {
    this.chronicle.markEphemeral(messageKey)
  }

  /**
   * Keep every own message whose whitespace-collapsed text satisfies `matcher` out of the router context and the
   * chronicle. Needed for messages stored before their send receipt returns. Removed with the calling plugin.
   * @param matcher - test over the normalized text.
   * @returns the disposer.
   */
  ephemeral(matcher: (text: string) => boolean): () => void {
    return this.track(this.chronicle.ephemeral.match(matcher), 'im-dispatch: ephemeral matcher')
  }

  /**
   * Append guidance to the system prompt of every router or every worker. Removed with the calling plugin.
   * @param role - `router` or `worker`.
   * @param text - the text, or a function read at every prompt assembly.
   * @returns the disposer.
   */
  prompt(role: DispatchRole, text: string | (() => string)): () => void {
    const read = typeof text === 'string' ? () => text : text
    this.prompts[role].add(read)
    return this.track(() => { this.prompts[role].delete(read) }, 'im-dispatch: prompt contribution')
  }

  /**
   * The "delete route rule #id" button (with a text fallback), for a plugin that explains a turn's trigger. Clicks
   * are handled here.
   * @param id - the rule id.
   * @returns the element subtree.
   */
  ruleButton(id: number): unknown {
    return deleteRuleControl(id)
  }

  private track(dispose: () => void, label: string): () => void {
    let done = false
    const once = (): void => {
      if (done) return
      done = true
      dispose()
    }
    // Service methods run with `this.ctx` bound to the calling plugin's context, so the contribution leaves with it.
    try {
      this.ctx.effect(() => once, label)
    } catch { /* a caller without a fiber keeps the explicit disposer */ }
    return once
  }

  private isDispatchTask(task: ImTaskLike): boolean {
    if (task.ownerKind === 'dispatch' || task.meta?.by === 'dispatch') return true
    const owner = this.host.im.sessions.get(task.owner)
    if (owner !== undefined) return isRouterKey(owner.key) || owner.owner === 'dispatch'
    return task.ownerKind === undefined
  }

  private async onButton(event: ImButtonEventLike): Promise<void> {
    if (!event.id.startsWith(DELETE_RULE_BUTTON_PREFIX)) return
    const id = Number(event.id.slice(DELETE_RULE_BUTTON_PREFIX.length))
    const respond = async (type: 'info' | 'success' | 'error', content: string): Promise<void> => {
      await event.raw?.respond?.({ toast: { type, content } }).catch(() => {})
    }
    if (!Number.isInteger(id) || id <= 0) {
      await respond('error', '当前无法删除该规则')
      return
    }
    try {
      await this.removeRule(id, { user: event.user.id })
      await respond('success', `已删除规则 #${String(id)}`)
    } catch (error: unknown) {
      if (isImError(error) && error.code === 'access') {
        await respond('info', error.message.startsWith('No route rule') ? `规则 #${String(id)} 已不存在` : error.message)
        return
      }
      this.home.logger('im-dispatch').warn('im-dispatch: deleting rule #%d from a button failed: %s', id, String(error))
      await respond('error', `删除规则 #${String(id)} 失败`)
    }
  }
}

export default ImDispatchService
