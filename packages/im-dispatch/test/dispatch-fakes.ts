/**
 * Fakes of the harness services the dispatch strategy runs over: an IM host with a message store, hosted session
 * records and a delivery log; a task service with the slim `ImTasks` contract (explicit placement, `deliver`); an
 * in-memory storage-domain facility that re-parses stored records on every open; and a tool registry that checks
 * every returned value against the tool's declared output schema, as the real registry does.
 */
import type {
  AgentLike, ContentBlockLike, DispatchIm, DomainLike, DomainSpecLike, ImBindingLike, ImDeliveryLike, ImHostedRecord,
  ImOutcomeLike, ImSendOptionsLike, ImSendResultLike, ImSessionSpecLike, ImStoredMessage, ImTaskDescribeLike, ImTaskLike,
  ImTaskStartLike, ImTasksLike, KvTableLike, LlmCallConfigLike, LlmGenerateOptionsLike, LlmServiceLike, Logger,
  StorageDomainLike, ToolDefinitionLike, ToolsLike,
} from '../src/types.ts'
import { ChronicleService, EphemeralTracker } from '../src/chronicle/index.ts'
import { DispatchHost, DISPATCHER_CHAT_PREFIX, DISPATCHER_TOPIC_PREFIX, type DispatchConfig } from '../src/index.ts'
import { DispatchConfig as DispatchConfigSchema } from '../src/config.ts'
import { ImError } from '../src/im.ts'
import { applyTools } from '../src/tools.ts'
import { validate } from '../src/schema.ts'

export const BOT = 'fake:bot'
export const CHAT_KEY = `${BOT}|chat`
export const OTHER_KEY = `${BOT}|other`

/** The composition every dispatch session of these tests runs. */
export const COMPOSITION = { agentPreset: 'im', provider: 'fake', model: 'scripted', cwd: process.cwd() }

/** One logged delivery of a fake session. */
export interface Logged {
  delivery: ImDeliveryLike
  text: string
}

/** A logger that records its calls. */
export class FakeLogger implements Logger {
  readonly lines: { level: string; format: string; args: unknown[] }[] = []
  info(format: string, ...args: unknown[]): void { this.lines.push({ level: 'info', format, args }) }
  warn(format: string, ...args: unknown[]): void { this.lines.push({ level: 'warn', format, args }) }
  error(format: string, ...args: unknown[]): void { this.lines.push({ level: 'error', format, args }) }
}

/** The text of one formatted delivery. */
function textOf(content: ImDeliveryLike['content']): string {
  return content.map((entry) => {
    if ('seq' in entry) return (entry as ImStoredMessage).text
    const block = entry as ContentBlockLike
    return block.type === 'text' ? String(block.text) : ''
  }).join('\n')
}

/** The IM host: a message store, hosted records and every session's delivery log. */
export class FakeIm implements DispatchIm {
  readonly messages = new Map<string, ImStoredMessage[]>()
  readonly records = new Map<string, ImHostedRecord>()
  readonly logs = new Map<string, Logged[]>()
  readonly triggers = new Map<string, ImStoredMessage>()
  readonly sent: Array<{ chat: string; content: unknown; options?: ImSendOptionsLike; key: string }> = []
  /** Optional listener invoked whenever a message enters the store (inbound or outbound). */
  onStored?: (message: ImStoredMessage) => void
  /** Replacement of `sessions.deliver`, for failure tests. */
  failDeliver: Error | undefined
  /** Replacement of `format`, for failure tests. */
  failFormat: Error | undefined
  private sequence = 0

  send = async (chat: string, content: unknown, options?: ImSendOptionsLike): Promise<ImSendResultLike> => {
    const rawText = typeof content === 'object' && content !== null && 'type' in content && (content as { type: string }).type === 'markdown'
      ? String((content as { attrs?: { content?: unknown } }).attrs?.content ?? '')
      : JSON.stringify(content)
    const threadId = typeof options?.thread === 'string'
      ? options.thread
      : options?.thread === true && options.quote !== undefined
        ? (this.history.get(options.quote)?.thread?.id ?? `omt-auto-${this.sequence + 1}`)
        : undefined
    const stored = this.store(rawText, {
      chatKey: chat,
      sender: { id: 'bot-user', name: 'Bot', isBot: true, self: true },
      addressed: false,
      mentions: { self: false, all: false, users: [] },
      ...options?.quote === undefined ? {} : { quote: { key: options.quote } },
      ...threadId === undefined ? {} : { thread: { id: threadId, ...options?.quote === undefined ? {} : { root: options.quote.split('|')[1] } } },
    })
    this.sent.push({ chat, content, options, key: stored.key })
    return { status: 'confirmed', handle: { id: stored.key }, message: stored }
  }

  readonly sessions = {
    ensure: (spec: ImSessionSpecLike): Promise<ImHostedRecord> => {
      const known = this.records.get(spec.key)
      const record: ImHostedRecord = {
        ...known, ...spec, sessionId: known?.sessionId ?? `im-${spec.key}`,
      }
      this.records.set(spec.key, record)
      return Promise.resolve(record)
    },
    get: (keyOrId: string): ImHostedRecord | undefined => {
      return this.records.get(keyOrId) ?? [...this.records.values()].find(record => record.sessionId === keyOrId)
    },
    list: (): ImHostedRecord[] => [...this.records.values()],
    bind: (target: string, bindings: ImBindingLike[]): Promise<void> => {
      const record = this.sessions.get(target)
      if (record === undefined) throw new ImError('access', `no session ${target}`)
      this.records.set(record.key, { ...record, bindings })
      return Promise.resolve()
    },
    deliver: async (target: string, delivery: ImDeliveryLike): Promise<void> => {
      if (this.failDeliver !== undefined) throw this.failDeliver
      const record = this.sessions.get(target)
      if (record === undefined) throw new ImError('access', `no session ${target}`)
      const log = this.logs.get(record.sessionId) ?? []
      this.logs.set(record.sessionId, log)
      if (log.some(entry => entry.delivery.id === delivery.id)) return
      const content = delivery.content.length > 0 && 'seq' in delivery.content[0]!
        ? await this.format(
          delivery.content as ImStoredMessage[],
          delivery.header === undefined ? {} : { header: delivery.header },
        )
        : delivery.content
      log.push({ delivery, text: textOf(content) })
      if (delivery.trigger !== undefined) this.triggers.set(record.sessionId, delivery.trigger)
    },
    trigger: (sessionId: string): ImStoredMessage | undefined => this.triggers.get(sessionId),
  }

  readonly history = {
    after: (chat: string, seq: number, limit: number, keep?: (message: ImStoredMessage) => boolean): ImStoredMessage[] => {
      return (this.messages.get(chat) ?? [])
        .filter(message => message.seq > seq && (keep?.(message) ?? true))
        .slice(0, limit)
    },
    before: (chat: string, seq: number, limit: number, keep?: (message: ImStoredMessage) => boolean): ImStoredMessage[] => {
      return (this.messages.get(chat) ?? [])
        .filter(message => message.seq < seq && (keep?.(message) ?? true))
        .slice(-limit)
    },
    get: (key: string): ImStoredMessage | undefined => {
      for (const list of this.messages.values()) {
        const found = list.find(message => message.key === key)
        if (found !== undefined) return found
      }
      return undefined
    },
  }

  format(messages: readonly ImStoredMessage[], options: { header?: string } = {}): Promise<ContentBlockLike[]> {
    if (this.failFormat !== undefined) return Promise.reject(this.failFormat)
    const header = options.header === undefined ? [] : [options.header]
    return Promise.resolve([{ type: 'text', text: [...header, ...messages.map(message => message.text)].join('\n') }])
  }

  /**
   * Store one inbound message as the host would.
   * @param text - message text.
   * @param patch - fields to override (chat key via `chatKey`).
   * @returns the stored message.
   */
  store(text: string, patch: Partial<ImStoredMessage> & { chatKey?: string } = {}): ImStoredMessage {
    const { chatKey = CHAT_KEY, ...rest } = patch
    const list = this.messages.get(chatKey) ?? []
    this.messages.set(chatKey, list)
    const id = `m-${++this.sequence}`
    const message: ImStoredMessage = {
      key: `${BOT}|${id}`,
      seq: list.length + 1,
      chat: { key: chatKey, bot: BOT, ref: { id: chatKey.slice(BOT.length + 1), type: 'group' }, source: 'team' },
      sender: { id: 'user-1', name: 'User', self: false },
      content: { type: 'message', attrs: {}, children: [{ type: 'text', attrs: { content: text }, children: [] }] },
      text,
      mentions: { self: true, all: false, users: [] },
      addressed: true,
      time: 1000,
      ...rest,
    }
    list.push(message)
    this.onStored?.(message)
    return message
  }

  /**
   * The texts one session received, in delivery order.
   * @param session - session id or key.
   * @returns the delivered texts.
   */
  texts(session: string): string[] {
    const record = this.sessions.get(session)
    return record === undefined ? [] : (this.logs.get(record.sessionId) ?? []).map(entry => entry.text)
  }
}

/** The task service with the slim contract: placement decides the worker's bindings, `deliver` hands messages over. */
export class FakeTasks implements ImTasksLike {
  readonly tasks = new Map<number, ImTaskLike & { key?: string }>()
  readonly starts: ImTaskStartLike[] = []
  onTaskStarted?: (task: ImTaskLike) => void
  private next = 1
  private readonly im: FakeIm

  constructor(im: FakeIm) {
    this.im = im
  }

  async start(request: ImTaskStartLike): Promise<ImTaskLike> {
    const owner = this.im.sessions.get(request.owner)
    if (owner === undefined) throw new ImError('access', `No IM session ${request.owner} is hosted.`)
    const previous = [...this.tasks.values()].find(task => task.owner === owner.sessionId && task.key === request.id)
    if (request.id !== undefined && previous !== undefined) return previous
    request.signal?.throwIfAborted()
    this.starts.push(request)
    const id = this.next++
    const header = `Task #${id}: ${request.title}`
    const baseInput = request.brief !== undefined
      ? [{ type: 'text', text: `${header}\n\n${request.brief}` }]
      : await this.im.format(request.messages ?? [], { header })
    const input = request.extraContent !== undefined && request.extraContent.length > 0
      ? [...baseInput, ...request.extraContent]
      : baseInput
    const bindings = request.placement?.bindings ?? owner.bindings.map(binding => ({ ...binding }))
    const home = bindings.find(binding => binding.home === true) ?? bindings[0]
    if (home === undefined) throw new ImError('configuration', 'A task placement must bind the worker to at least one chat.')
    const record = await this.im.sessions.ensure({
      key: `task:${id}`, owner: 'session-tasks', composition: request.worker ?? owner.composition, bindings,
      parent: owner.sessionId, ...request.output === undefined ? {} : { output: request.output },
    })
    const task: ImTaskLike & { key?: string } = {
      id,
      title: request.title,
      session: record.sessionId,
      owner: owner.sessionId,
      ownerKind: owner.owner,
      chat: home.chat,
      createdAt: 1,
      updatedAt: 1,
      ...request.meta === undefined ? {} : { meta: request.meta },
      ...request.id === undefined ? {} : { key: request.id },
    }
    this.tasks.set(id, task)
    await this.im.sessions.deliver(record.sessionId, {
      id: `task:${id}:input`, mode: request.deliveryMode ?? 'steer', content: input,
      ...request.placement?.trigger === undefined ? {} : { trigger: request.placement.trigger },
    })
    this.onTaskStarted?.(task)
    return task
  }

  list(filter: { owner?: string; chat?: string } = {}): ImTaskLike[] {
    const owner = filter.owner === undefined ? undefined : this.im.sessions.get(filter.owner)?.sessionId ?? filter.owner
    return [...this.tasks.values()]
      .filter(task => (owner === undefined || task.owner === owner)
        && (filter.chat === undefined || task.chat === filter.chat))
      .sort((left, right) => right.id - left.id)
  }

  get(id: number): ImTaskLike | undefined {
    return this.tasks.get(id)
  }

  of(session: string): ImTaskLike | undefined {
    return [...this.tasks.values()].find(task => task.session === session)
  }

  async message(owner: string, id: number, text: string, options: { id?: string } = {}): Promise<ImTaskLike> {
    const ownerRecord = this.im.sessions.get(owner)
    const task = this.tasks.get(id)
    if (ownerRecord === undefined || task === undefined) {
      throw new ImError('access', `This session has no task #${id}.`)
    }
    if (task.owner !== ownerRecord.sessionId && ownerRecord.owner !== 'dispatch' && ownerRecord.owner !== 'dispatcher') {
      throw new ImError('access', `This session has no task #${id}.`)
    }
    const updated: ImTaskLike = {
      ...task,
      updatedAt: task.updatedAt + 1,
    }
    this.tasks.set(id, updated)
    await this.im.sessions.deliver(task.session, {
      id: options.id ?? `task:${id}:steer:${updated.updatedAt}`,
      mode: 'steer',
      content: [{ type: 'text', text }],
    })
    return updated
  }

  note(worker: string, note: string): Promise<ImTaskLike> {
    const task = this.of(worker)
    if (task === undefined) throw new ImError('access', 'Only a task worker can record a task note.')
    const updated = { ...task, note, updatedAt: task.updatedAt + 1 }
    this.tasks.set(task.id, updated)
    return Promise.resolve(updated)
  }

  describe(worker: string, profile: ImTaskDescribeLike): Promise<ImTaskLike> {
    const task = this.of(worker)
    if (task === undefined) throw new ImError('access', 'Only a task worker can describe a task.')
    const updated: ImTaskLike = {
      ...task,
      ...profile.description === undefined ? {} : { description: profile.description },
      ...profile.wantedTopics === undefined ? {} : { wantedTopics: [...profile.wantedTopics] },
      ...profile.topicScope === undefined ? {} : { topicScope: profile.topicScope },
      ...profile.followThread === undefined ? {} : { followThread: profile.followThread },
      ...profile.note === undefined ? {} : { note: profile.note },
      updatedAt: task.updatedAt + 1,
    }
    this.tasks.set(task.id, updated)
    return Promise.resolve(updated)
  }

  async deliver(id: number, messages: readonly ImStoredMessage[], options?: { header?: string }): Promise<ImTaskLike> {
    const task = this.tasks.get(id)
    if (task === undefined) throw new ImError('access', `There is no task #${id}.`)
    if (messages.length === 0) throw new ImError('capacity', 'Deliver at least one message to a task.')
    for (const message of messages) {
      await this.im.sessions.deliver(task.session, {
        id: message.key,
        mode: 'steer',
        content: [message],
        trigger: message,
        ...options?.header === undefined ? {} : { header: options.header },
      })
    }
    return task
  }
}

/** The medium of one domain: what survives a restart. */
export interface Medium {
  global: unknown
  tables: Map<string, Map<string, unknown>>
}

/** A storage-domain facility over in-memory media; every open re-parses the stored records. */
export class FakeStorage implements StorageDomainLike {
  readonly media: Map<string, Medium>

  constructor(media = new Map<string, Medium>()) {
    this.media = media
  }

  open(spec: DomainSpecLike): Promise<DomainLike> {
    const medium = this.media.get(spec.name) ?? { global: null, tables: new Map() }
    this.media.set(spec.name, medium)
    for (const [name, table] of Object.entries(spec.tables)) {
      const stored = medium.tables.get(name) ?? new Map<string, unknown>()
      medium.tables.set(name, stored)
      for (const value of stored.values()) table.valueSchema.parse(value)
    }
    if (medium.global !== null) spec.global?.schema.parse(medium.global)
    const table = (name: string): KvTableLike<unknown> => {
      const stored = medium.tables.get(name)!
      return {
        get: key => stored.get(key),
        entries: () => new Map(stored).entries(),
        get size() { return stored.size },
        put: (key, value) => { stored.set(key, value); return Promise.resolve() },
        delete: key => Promise.resolve(stored.delete(key)),
      }
    }
    return Promise.resolve({
      global: {
        get: () => medium.global ?? spec.global?.initial,
        set: (value: unknown) => { medium.global = value; return Promise.resolve() },
      },
      table,
      close: () => Promise.resolve(),
    })
  }
}

/** The outcome of one tool call: its value, or the failure the registry would report. */
export type CallResult = { value: Record<string, unknown> } | { error: Error }

/** A tool registry that enforces each tool's output schema. */
export class FakeTools implements ToolsLike {
  readonly tools = new Map<string, ToolDefinitionLike>()
  private calls = 0

  register(definition: ToolDefinitionLike): () => void {
    if (this.tools.has(definition.name)) throw new Error(`tool ${definition.name} is already registered`)
    this.tools.set(definition.name, definition)
    return () => { this.tools.delete(definition.name) }
  }

  /**
   * Run one tool for one agent.
   * @param name - tool name.
   * @param args - model arguments.
   * @param agent - calling agent.
   * @param callId - tool call id; a fresh one by default.
   * @returns the value, or the error the call failed with.
   */
  async call(name: string, args: unknown, agent: AgentLike | undefined, callId?: string): Promise<CallResult> {
    const tool = this.tools.get(name)
    if (tool === undefined) return { error: new Error(`unknown tool ${name}`) }
    try {
      const value = await tool.execute(args, {
        callId: callId ?? `${name}-${++this.calls}`, signal: new AbortController().signal,
        ...agent === undefined ? {} : { agent },
      })
      const violations = validate(tool.output.schema, value)
      if (violations.length > 0) throw new Error(`output violates its schema: ${violations.join('; ')}`)
      const [block] = tool.output.render(args, value)
      return { value: JSON.parse(String(block?.text)) as Record<string, unknown> }
    } catch (error) {
      return { error: error as Error }
    }
  }

  /**
   * The value of one call that must succeed.
   * @param result - the call result.
   * @returns its value.
   */
  static value(result: CallResult): Record<string, unknown> {
    if ('error' in result) throw result.error
    return result.value
  }
}

/** Scripted fake `ctx.llm` capturing every `prepareCall` / `stream` payload for prefix-cache verification. */
export class FakeLlm implements LlmServiceLike {
  readonly calls: Array<{ prepared: LlmCallConfigLike; options: LlmGenerateOptionsLike }> = []
  responder: (options: LlmGenerateOptionsLike) => string

  constructor(responder?: (options: LlmGenerateOptionsLike) => string) {
    this.responder = responder ?? ((options) => {
      if (options.system?.includes('压缩器')) {
        const raw = String(options.messages[0]?.content[0]?.text ?? '')
        const firstLine = raw.split('\n').pop() ?? raw
        return JSON.stringify({ subject: '测试主体', summary: firstLine.slice(0, 80) })
      }
      return '查询结果：已找到相关日志。'
    })
  }

  async prepareCall(config: LlmCallConfigLike): Promise<{
    readonly config: LlmCallConfigLike
    stream: (options: LlmGenerateOptionsLike) => AsyncIterable<{ type: string; text?: string; reason?: { kind: string } }>
  }> {
    return {
      config: { ...config },
      stream: (options: LlmGenerateOptionsLike) => {
        this.calls.push({ prepared: config, options })
        const reply = this.responder(options)
        return (async function* () {
          yield { type: 'text-delta', text: reply }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    }
  }
}

/** One booted strategy over fresh fakes. */
export interface Harness {
  im: FakeIm
  tasks: FakeTasks
  storage: FakeStorage
  tools: FakeTools
  logger: FakeLogger
  host: DispatchHost
  config: DispatchConfig
  chronicle: ChronicleService
  ephemeral: EphemeralTracker
  outcomes: Map<string, ImOutcomeLike>
  /** Store one message and run it through the strategy's `im/message` listener. */
  receive(text: string, patch?: Partial<ImStoredMessage> & { chatKey?: string }): Promise<ImStoredMessage>
  /** An agent of one session (id or key). */
  agent(session: string): AgentLike
  /** The router record for `chatKey` (or `threadId` in topic chats), defaulting to `CHAT_KEY`. */
  dispatcher(chatKey?: string, threadId?: string): ImHostedRecord
  /** Alias for `dispatcher(chatKey, threadId)`. */
  router(chatKey?: string, threadId?: string): ImHostedRecord
  /** The worker agent of one task. */
  worker(id: number): AgentLike
}

/**
 * Boot the strategy over fresh fakes (or the given medium, for a restart).
 * @param overrides - configuration overrides.
 * @param media - the storage media of an earlier boot.
 * @param llm - optional scripted LLM service for Chronicle compaction and fork queries.
 * @returns the harness.
 */
export function boot(
  overrides: Partial<Record<keyof DispatchConfig, unknown>> = {},
  media?: Map<string, Medium>,
  llm?: LlmServiceLike,
): Harness {
  const im = new FakeIm()
  const tasks = new FakeTasks(im)
  const storage = new FakeStorage(media)
  const tools = new FakeTools()
  const logger = new FakeLogger()
  const config = DispatchConfigSchema.parse({ main: COMPOSITION, worker: COMPOSITION, ...overrides })
  const ephemeral = new EphemeralTracker()
  // What a page-link plugin registers through `ctx.imDispatch.ephemeral(...)` for its own status lines.
  ephemeral.match(text => text.startsWith('🔗 查看工作过程') || text.startsWith('⌨️ 正在工作中'))
  const chronicle = new ChronicleService({
    storage,
    llm: () => llm,
    defaultProvider: config.main.provider,
    defaultModel: config.main.model,
    config: config.chronicle,
    logger,
    ephemeral,
  })
  const host = new DispatchHost({ im, tasks, storage, logger, config, chronicle, ephemeral })
  im.onStored = (message) => {
    host.onStored(message)
    chronicle.onStored(message)
  }
  tasks.onTaskStarted = (task) => {
    chronicle.onTaskStarted(task)
  }
  applyTools(tools, host, config)
  const outcomes = new Map<string, ImOutcomeLike>()
  const routerOf = (chatKey = CHAT_KEY, threadId?: string): ImHostedRecord => {
    const key = threadId === undefined
      ? `${DISPATCHER_CHAT_PREFIX}${chatKey}`
      : `${DISPATCHER_TOPIC_PREFIX}${chatKey}:${threadId}`
    const record = im.sessions.get(key)
    if (record === undefined) throw new Error(`no router session was opened for ${key}`)
    return record
  }
  const harness: Harness = {
    im, tasks, storage, tools, logger, host, config, chronicle, ephemeral, outcomes,
    async receive(text, patch) {
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
      outcomes.set(message.key, outcome)
      return message
    },
    agent: (session) => {
      const record = im.sessions.get(session)
      return { session: { id: record?.sessionId ?? session } }
    },
    dispatcher: routerOf,
    router: routerOf,
    worker: (id) => {
      const task = tasks.get(id)
      if (task === undefined) throw new Error(`no task #${id}`)
      return { session: { id: task.session } }
    },
  }
  return harness
}

/**
 * An unaddressed message patch.
 * @param patch - further fields.
 * @returns the patch.
 */
export function quiet(patch: Partial<ImStoredMessage> & { chatKey?: string } = {}): Partial<ImStoredMessage> & { chatKey?: string } {
  return { addressed: false, mentions: { self: false, all: false, users: [] }, ...patch }
}
