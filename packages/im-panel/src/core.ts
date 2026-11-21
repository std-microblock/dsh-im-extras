/**
 * The snapshot and the commands of the built-in tabs, over whichever IM services the profile mounts.
 *
 * Every service is optional and structural: the panel reads `ctx.im`, `ctx.imTasks`, `ctx.imAuth` and
 * `ctx.imDispatch` per request, so a profile without one of them gets an empty view and a notice instead of an error.
 *
 * @module dsh-im-panel/core
 */

import type {
  ImPanelChat, ImPanelChatPatch, ImPanelChronicleEntry, ImPanelChroniclePage, ImPanelCommand, ImPanelDispatch, ImPanelNotice, ImPanelResult,
  ImPanelRule, ImPanelSession, ImPanelSessionAuth, ImPanelState, ImPanelTabInfo, ImPanelTask, ImPanelTransport,
} from './protocol.ts'

/** The IM host as far as the panel reads it. */
export interface PanelIm {
  status?(): {
    bots: readonly { id: string; platform: string; status: number }[]
    sources: readonly unknown[]
    sessions: readonly {
      sessionId: string
      key: string
      owner: string
      parent?: string
      output?: string
      generation: number
      createdAt: number
      lastActiveAt: number
      bindings: readonly { chat: string; writable: boolean; home?: boolean; thread?: string }[]
    }[]
    pendingDeliveries: number
    pendingMessages: number
  }
  chat?(key: string): unknown
  readonly sessions: { stop?(target: string): Promise<boolean> }
}

/** One task of `ctx.imTasks`. */
export interface PanelTaskLike {
  id: number
  title: string
  note?: string
  description?: string
  wantedTopics?: readonly string[]
  topicScope?: 'chat' | 'all'
  followThread?: boolean
  session: string
  owner: string
  chat: string
  createdAt: number
  updatedAt: number
}

/** The task service as far as the panel reads it. */
export interface PanelTasks {
  list(): readonly PanelTaskLike[]
  get(id: number): PanelTaskLike | undefined
  note(worker: string, note: string): Promise<unknown>
}

/** The session-auth service as far as the panel reads it. */
export interface PanelAuth {
  aclOf(sessionId: string): {
    exclusive: boolean
    owner?: { id: string; name?: string }
    allowedUsers: readonly { id: string; name?: string }[]
    grants: readonly { capabilityId: string; title: string; status: 'pending' | 'active' | 'reauth_required' | 'revoked' }[]
  } | undefined
  operatorUnlock(sessionId: string): Promise<boolean>
}

/** The dispatch service (`ctx.imDispatch` of `dsh-im-dispatch`) as far as the panel reads it. */
export interface PanelDispatch {
  readonly config: {
    main: { agentPreset: string; provider: string; model: string; cwd: string }
    worker: { agentPreset: string; provider: string; model: string; cwd: string }
    workerOutput: string
    tools: { main: readonly string[]; worker: readonly string[] }
  } & Record<string, unknown>
  chats(): Promise<readonly {
    chat: string; name?: string; type: string; firstSeenAt: number
    wakeMode: 'mention' | 'watch' | 'auto'; replyMode: 'mention_only' | 'proactive'
    watchTopics: readonly string[]; watchNote?: string; replyPolicy?: string
  }[]>
  rules(): Promise<readonly {
    id: number; task: number; match: string; mode: 'copy' | 'cut'; note?: string; errors?: number; lastError?: string
  }[]>
  tasks(): readonly { id: number }[]
  isRouter(key: string): boolean
  sessionTitle(sessionId: string, record?: { key: string }): string | undefined
  chatInfo(chat: string): { name?: string; type?: string } | undefined
  chronicleStatus(): Promise<{ entries: number; chunks: number; latestId: number; recent: readonly ImPanelChronicleEntryLike[] }>
  chronicleEntries(filter?: { chat?: string; before?: number; query?: string; limit?: number }): Promise<{
    entries: readonly ImPanelChronicleEntryLike[]; total: number; next?: number
  }>
  addRule(task: number, request: { match?: string; mode: 'copy' | 'cut'; note?: string }): Promise<{ id: number }>
  updateRule(task: number, id: number, patch: { match?: string; mode?: 'copy' | 'cut'; note?: string }): Promise<{ id: number }>
  removeRule(id: number): Promise<{ id: number }>
  configureChat(chat: string, request: ImPanelChatPatch): Promise<unknown>
}

interface ImPanelChronicleEntryLike {
  id: number; time: number; kind: string; chat: string; taskId?: number; subject: string; summary: string
}

/** The services one request reads, resolved by the caller. */
export interface PanelServices {
  readonly im?: PanelIm | undefined
  readonly tasks?: PanelTasks | undefined
  readonly auth?: PanelAuth | undefined
  readonly dispatch?: PanelDispatch | undefined
}

/** Limit keys of the dispatch configuration the overview shows. */
const LIMIT_KEYS = [
  'ruleTimeoutMs', 'ruleMemoryBytes', 'maxRuleChars', 'maxRulesPerTask', 'maxTaskMessages', 'contextMessages',
  'maxSearchPages', 'searchPageSize', 'autoThread', 'maxRouterSteps', 'maxRouterDeltaMessages', 'freshContextMessages',
  'ambientDebounceMs', 'maxAutoRepliesPerHour',
] as const

function platformOf(chat: string): string {
  const bar = chat.indexOf('|')
  const bot = bar < 0 ? '' : chat.slice(0, bar)
  return bot.split(':')[0] ?? ''
}

function dispatchView(config: PanelDispatch['config']): ImPanelDispatch {
  const limits: Record<string, number | boolean> = {}
  for (const key of LIMIT_KEYS) {
    const value = config[key]
    if (typeof value === 'number' || typeof value === 'boolean') limits[key] = value
  }
  return {
    main: { ...config.main },
    worker: { ...config.worker },
    workerOutput: config.workerOutput,
    tools: { main: [...config.tools.main], worker: [...config.tools.worker] },
    limits,
  }
}

function authView(auth: PanelAuth | undefined, sessionId: string): ImPanelSessionAuth | undefined {
  const acl = auth?.aclOf(sessionId)
  if (acl === undefined) return undefined
  const grants = acl.grants
    .filter(grant => grant.status !== 'revoked')
    .map(grant => ({ capabilityId: grant.capabilityId, title: grant.title, status: grant.status }))
  if (!acl.exclusive && grants.length === 0) return undefined
  const ownerId = acl.owner?.id
  return {
    exclusive: acl.exclusive,
    ...acl.owner === undefined ? {} : { owner: { id: acl.owner.id, ...acl.owner.name === undefined ? {} : { name: acl.owner.name } } },
    collaborators: acl.allowedUsers
      .filter(user => user.id !== ownerId)
      .map(user => ({ id: user.id, ...user.name === undefined ? {} : { name: user.name } })),
    grants,
  }
}

function entryView(entry: ImPanelChronicleEntryLike): ImPanelChronicleEntry {
  return {
    id: entry.id,
    time: entry.time,
    kind: entry.kind,
    chat: entry.chat,
    ...entry.taskId === undefined ? {} : { taskId: entry.taskId },
    subject: entry.subject,
    summary: entry.summary,
  }
}

/**
 * One snapshot of the deployment.
 * @param services - the optional IM services.
 * @param tabs - the host-registered extension tabs.
 * @returns the snapshot the panel renders.
 */
export async function snapshot(services: PanelServices, tabs: readonly ImPanelTabInfo[] = []): Promise<ImPanelState> {
  const notices: ImPanelNotice[] = []
  const { im, tasks, auth, dispatch } = services
  const status = im?.status?.()
  if (im === undefined) notices.push({ text: '没有拿到 IM 服务（dsh-im），会话与传输两栏是空的', level: 'warning' })
  else if (status === undefined) notices.push({ text: '这个 harness 的 IM 主机不报告状态，会话与传输两栏只能留空', level: 'warning' })
  if (tasks === undefined) notices.push({ text: '任务服务（dsh-im-session-tasks）没有挂载，任务一栏是空的', level: 'warning' })
  if (dispatch === undefined) notices.push({ text: '没有挂载 dsh-im-dispatch：没有群路由、规则、群配置和跨群日志' })

  const dispatchTaskIds = new Set(dispatch?.tasks().map(task => task.id) ?? [])
  const knownChats = dispatch === undefined ? [] : await dispatch.chats()
  const names = new Map(knownChats.map(chat => [chat.chat, chat.name]))
  const nameOf = (chat: string): string | undefined => names.get(chat) ?? dispatch?.chatInfo(chat)?.name

  const taskList: ImPanelTask[] = (tasks?.list() ?? []).map((task) => {
    const entryAuth = authView(auth, task.session)
    const chatName = nameOf(task.chat)
    return {
      id: task.id,
      title: task.title,
      ...task.note === undefined ? {} : { note: task.note },
      ...task.description === undefined ? {} : { description: task.description },
      ...task.wantedTopics === undefined ? {} : { wantedTopics: [...task.wantedTopics] },
      ...task.topicScope === undefined ? {} : { topicScope: task.topicScope },
      ...task.followThread === undefined ? {} : { followThread: task.followThread },
      session: task.session,
      owner: task.owner,
      chat: task.chat,
      ...chatName === undefined ? {} : { chatName },
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      dispatch: dispatchTaskIds.has(task.id),
      ...entryAuth === undefined ? {} : { auth: entryAuth },
    }
  })
  const workerSessions = new Set(taskList.map(task => task.session))

  const rules: ImPanelRule[] = dispatch === undefined ? [] : (await dispatch.rules()).map(rule => ({
    id: rule.id,
    task: rule.task,
    match: rule.match,
    mode: rule.mode,
    ...rule.note === undefined ? {} : { note: rule.note },
    errors: rule.errors ?? 0,
    ...rule.lastError === undefined ? {} : { lastError: rule.lastError },
  }))

  const sessions: ImPanelSession[] = (status?.sessions ?? []).map((session) => {
    const entryAuth = authView(auth, session.sessionId)
    const title = dispatch?.sessionTitle(session.sessionId, session)
    const role: ImPanelSession['role'] = dispatch?.isRouter(session.key) === true
      ? 'router'
      : workerSessions.has(session.sessionId) ? 'task' : 'other'
    return {
      sessionId: session.sessionId,
      key: session.key,
      ...title === undefined ? {} : { title },
      owner: session.owner,
      role,
      ...session.parent === undefined ? {} : { parent: session.parent },
      ...session.output === undefined ? {} : { output: session.output },
      generation: session.generation,
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
      bindings: session.bindings.map(binding => ({
        chat: binding.chat,
        writable: binding.writable,
        home: binding.home === true,
        ...binding.thread === undefined ? {} : { thread: binding.thread },
      })),
      ...entryAuth === undefined ? {} : { auth: entryAuth },
    }
  }).sort((left, right) => right.lastActiveAt - left.lastActiveAt)

  const chats = new Map<string, ImPanelChat>()
  for (const chat of knownChats) {
    chats.set(chat.chat, {
      chat: chat.chat,
      ...chat.name === undefined ? {} : { name: chat.name },
      platform: platformOf(chat.chat),
      type: chat.type,
      wakeMode: chat.wakeMode,
      replyMode: chat.replyMode,
      watchTopics: [...chat.watchTopics],
      ...chat.watchNote === undefined ? {} : { watchNote: chat.watchNote },
      ...chat.replyPolicy === undefined ? {} : { replyPolicy: chat.replyPolicy },
      firstSeenAt: chat.firstSeenAt,
    })
  }
  for (const session of sessions) {
    for (const binding of session.bindings) {
      if (!chats.has(binding.chat)) chats.set(binding.chat, { chat: binding.chat, platform: platformOf(binding.chat) })
    }
  }

  const transport: ImPanelTransport | undefined = status === undefined
    ? undefined
    : {
        bots: status.bots.map(bot => ({ id: bot.id, platform: bot.platform, status: bot.status })),
        chats: new Set(status.sessions.flatMap(session => session.bindings.map(binding => binding.chat))).size,
        sources: status.sources.length,
        pendingDeliveries: status.pendingDeliveries,
        pendingMessages: status.pendingMessages,
      }

  let chronicle: ImPanelState['chronicle']
  if (dispatch !== undefined) {
    try {
      const value = await dispatch.chronicleStatus()
      chronicle = { entries: value.entries, chunks: value.chunks, latestId: value.latestId, recent: value.recent.map(entryView) }
    } catch (error: unknown) {
      notices.push({ text: `跨群日志读取失败：${error instanceof Error ? error.message : String(error)}`, level: 'warning' })
    }
  }

  return {
    now: Date.now(),
    ...dispatch === undefined ? {} : { dispatch: dispatchView(dispatch.config) },
    ...transport === undefined ? {} : { transport },
    tasks: taskList,
    rules,
    sessions,
    chats: [...chats.values()].sort((a, b) => (a.name ?? a.chat).localeCompare(b.name ?? b.chat)),
    ...chronicle === undefined ? {} : { chronicle },
    tabs,
    notices,
  }
}

/**
 * One page of the chronicle.
 * @param services - the optional IM services.
 * @param query - `chat`, `before`, `query`, `limit`.
 */
export async function chroniclePage(services: PanelServices, query: URLSearchParams): Promise<ImPanelChroniclePage> {
  if (services.dispatch === undefined) throw new Error('没有挂载 dsh-im-dispatch，没有跨群日志')
  const number = (name: string): number | undefined => {
    const raw = query.get(name)
    if (raw === null || raw.trim() === '') return undefined
    const value = Number(raw)
    if (!Number.isInteger(value)) throw new Error(`${name} 必须是整数`)
    return value
  }
  const chat = query.get('chat')?.trim()
  const text = query.get('query')?.trim()
  const before = number('before')
  const limit = number('limit')
  const page = await services.dispatch.chronicleEntries({
    ...chat ? { chat } : {},
    ...text ? { query: text } : {},
    ...before === undefined ? {} : { before },
    ...limit === undefined ? {} : { limit },
  })
  return { entries: page.entries.map(entryView), total: page.total, ...page.next === undefined ? {} : { next: page.next } }
}

/**
 * The command one request body names.
 * @param value - parsed JSON body.
 * @throws {Error} when the body names no command this API runs.
 */
export function commandOf(value: unknown): ImPanelCommand {
  if (typeof value !== 'object' || value === null) throw new Error('请求体不是一个对象')
  const body = value as Record<string, unknown>
  const action = body.action
  const number = (field: string): number => {
    const raw = body[field]
    if (typeof raw !== 'number' || !Number.isInteger(raw)) throw new Error(`命令 ${String(action)} 需要整数 ${field}`)
    return raw
  }
  const text = (field: string): string => {
    const raw = body[field]
    if (typeof raw !== 'string') throw new Error(`命令 ${String(action)} 需要字符串 ${field}`)
    return raw
  }
  const optionalText = (source: Record<string, unknown>, field: string): string | undefined => {
    const raw = source[field]
    if (raw === undefined) return undefined
    if (typeof raw !== 'string') throw new Error(`命令 ${String(action)} 的 ${field} 必须是字符串`)
    return raw
  }
  const mode = (): 'copy' | 'cut' => {
    const raw = body.mode
    if (raw !== 'copy' && raw !== 'cut') throw new Error(`命令 ${String(action)} 的 mode 只能是 copy 或 cut`)
    return raw
  }
  switch (action) {
    case 'task-stop': return { action, id: number('id') }
    case 'session-stop': return { action, sessionId: text('sessionId') }
    case 'session-unlock': return { action, sessionId: text('sessionId') }
    case 'rule-add': {
      const note = optionalText(body, 'note')
      return { action, task: number('task'), match: text('match'), mode: mode(), ...note === undefined ? {} : { note } }
    }
    case 'rule-update': {
      const match = optionalText(body, 'match')
      const note = optionalText(body, 'note')
      return {
        action,
        id: number('id'),
        task: number('task'),
        ...match === undefined ? {} : { match },
        ...note === undefined ? {} : { note },
        ...body.mode === undefined ? {} : { mode: mode() },
      }
    }
    case 'rule-remove': return { action, id: number('id') }
    case 'chat-configure': {
      const raw = body.patch
      if (typeof raw !== 'object' || raw === null) throw new Error('命令 chat-configure 需要 patch 对象')
      const source = raw as Record<string, unknown>
      const patch: { -readonly [K in keyof ImPanelChatPatch]: ImPanelChatPatch[K] } = {}
      if (source.wakeMode !== undefined) {
        if (source.wakeMode !== 'mention' && source.wakeMode !== 'watch' && source.wakeMode !== 'auto') {
          throw new Error('wakeMode 只能是 mention、watch 或 auto')
        }
        patch.wakeMode = source.wakeMode
      }
      if (source.replyMode !== undefined) {
        if (source.replyMode !== 'mention_only' && source.replyMode !== 'proactive') {
          throw new Error('replyMode 只能是 mention_only 或 proactive')
        }
        patch.replyMode = source.replyMode
      }
      if (source.watchTopics !== undefined) {
        if (!Array.isArray(source.watchTopics) || source.watchTopics.some(item => typeof item !== 'string')) {
          throw new Error('watchTopics 必须是字符串数组')
        }
        patch.watchTopics = source.watchTopics as string[]
      }
      const watchNote = optionalText(source, 'watchNote')
      if (watchNote !== undefined) patch.watchNote = watchNote
      const replyPolicy = optionalText(source, 'replyPolicy')
      if (replyPolicy !== undefined) patch.replyPolicy = replyPolicy
      return { action, chat: text('chat'), patch }
    }
    default: throw new Error(`未知命令 ${String(action)}`)
  }
}

/**
 * Run one command against the live services.
 * @param services - the optional IM services.
 * @param command - what the operator asked for.
 * @returns the outcome line.
 */
export async function run(services: PanelServices, command: ImPanelCommand): Promise<ImPanelResult> {
  const { im, tasks, auth, dispatch } = services
  const needDispatch = (): PanelDispatch => {
    if (dispatch === undefined) throw new Error('没有挂载 dsh-im-dispatch，改不了规则和群配置')
    return dispatch
  }
  switch (command.action) {
    case 'task-stop': {
      if (tasks === undefined) throw new Error('任务服务没有挂载')
      const task = tasks.get(command.id)
      if (task === undefined) throw new Error(`没有 #${String(command.id)} 这个任务`)
      const stopped = (await im?.sessions.stop?.(task.session)) ?? false
      if (!stopped) return { ok: false, text: `任务 #${String(task.id)} 当前没有在跑的轮次` }
      // The worker records its own outcome; a task the operator stopped did not finish, and its owner reads that here.
      await tasks.note(task.session, '运维在管理面板里停止了任务')
      return { ok: true, text: `已停止任务 #${String(task.id)}` }
    }
    case 'session-stop': {
      const stopped = (await im?.sessions.stop?.(command.sessionId)) ?? false
      return stopped
        ? { ok: true, text: `已停止会话 ${command.sessionId}` }
        : { ok: false, text: '这个会话当前没有在跑的轮次' }
    }
    case 'session-unlock': {
      if (auth === undefined) throw new Error('鉴权服务（dsh-im-session-auth）没有挂载')
      return await auth.operatorUnlock(command.sessionId)
        ? { ok: true, text: `已解除会话 ${command.sessionId} 的独占与授权` }
        : { ok: false, text: '该会话当前未处于独占或授权状态' }
    }
    case 'rule-add': {
      const rule = await needDispatch().addRule(command.task, {
        match: command.match, mode: command.mode, ...command.note === undefined ? {} : { note: command.note },
      })
      return { ok: true, text: `已给任务 #${String(command.task)} 加规则 #${String(rule.id)}` }
    }
    case 'rule-update': {
      const rule = await needDispatch().updateRule(command.task, command.id, {
        ...command.match === undefined ? {} : { match: command.match },
        ...command.mode === undefined ? {} : { mode: command.mode },
        ...command.note === undefined ? {} : { note: command.note },
      })
      return { ok: true, text: `已更新规则 #${String(rule.id)}` }
    }
    case 'rule-remove': {
      const rule = await needDispatch().removeRule(command.id)
      return { ok: true, text: `已删除规则 #${String(rule.id)}` }
    }
    case 'chat-configure': {
      await needDispatch().configureChat(command.chat, command.patch)
      return { ok: true, text: `已更新 ${command.chat} 的配置` }
    }
  }
}
