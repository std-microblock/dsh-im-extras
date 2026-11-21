/**
 * Structural views of the harness services this plugin reads.
 *
 * The plugin is loaded into a harness profile and talks to live services, so it
 * declares the slice of each service it uses instead of importing harness
 * packages: a newer harness that adds members to these services still satisfies
 * these declarations, and the plugin keeps compiling against the profile it is
 * installed into.
 *
 * The shapes mirror the v4 IM contracts: `ImChat`, `ImMessage`,
 * `ImSessionRecord`, `ImBinding`, `ImActivity`, `ImSendResult` of
 * `@deepseek-ai/dsh-im` (§10.2–§10.6), and `Bot` / `MessageRef` of
 * `@deepseek-ai/cordis-plugin-im-core`. The dispatch strategy additionally reads
 * the wider `ImApi` (sessions, history, format, the `im/message` waterfall),
 * `ImTasks` of `@deepseek-ai/dsh-im-session-tasks`, the domain facility of
 * `@deepseek-ai/dsh-storage-domain`, the tool registry of `@deepseek-ai/dsh-tools`
 * and the prompt assembler of `@deepseek-ai/dsh-system-prompt`.
 *
 * @module dsh-im-dispatch/types
 */

/** The slice of the harness logger this plugin uses. */
export interface Logger {
  info(format: string, ...args: unknown[]): void
  warn(format: string, ...args: unknown[]): void
  error(format: string, ...args: unknown[]): void
}

/** Platform chat identity (`ChatRef`): the id the platform itself uses. */
export interface ChatRefLike {
  id: string
  type: string
}

/** Platform message identity (`MessageRef`): a message of one chat. */
export interface MessageRefLike {
  id: string
  chat: ChatRefLike
}

/** One chat of the IM plane (`ImChat`), keyed globally as `${botId}|${chatId}`. */
export interface ImChatLike {
  /** Global chat key. */
  key: string
  /** Bot id owning the chat, e.g. `lark:app-id`. */
  bot: string
  ref: ChatRefLike
  /** Id of the admission source that admitted the chat. */
  source: string
}

/** One message the IM plane stored (`ImMessage`), as far as this plugin reads it. */
export interface ImMessageLike {
  /** Global message key `${botId}|${messageId}`. */
  key: string
  /** Per-chat sequence number assigned at store time. */
  seq: number
  chat: ImChatLike
  /** Platform thread the message belongs to, when it has one. */
  thread?: { id: string; root?: string }
  sender: { id: string; name?: string; self: boolean }
}

/** One chat a hosted session may use (`ImBinding`). */
export interface ImBindingLike {
  /** Global chat key. */
  chat: string
  /** The session may publish into the chat. */
  writable: boolean
  /** The chat output renderers and tools without an explicit chat use. */
  home?: boolean
  /** Platform thread the session is confined to (task topics). */
  thread?: string
}

/** One hosted session (`ImSessionRecord`), as far as this plugin reads it. */
export interface ImSessionRecordLike {
  /** `im-<sha256(key#generation)[0..32]>`: the session id a page URL carries. */
  sessionId: string
  /** Owner-defined stable key (`dispatch:main`, `task:<id>`, …). */
  key: string
  /** Owning plugin name (`dispatch`, `conversation`, `task`, …). */
  owner: string
  bindings: readonly ImBindingLike[]
  /** Parent session id, when the record was opened for a task or a one-shot. */
  parent?: string
  /** Output renderer id the session publishes through; `none` when unset. */
  output?: string
}

/** Activity status of one turn (`ImActivity['status']`). */
export type ImActivityStatus = 'running' | 'done' | 'cancelled' | 'error'

/** Which part of one turn's activity changed (`ImActivityChange`). */
export type ImActivityChange = 'start' | 'delta' | 'tool' | 'end'

/** One turn of one hosted session (`ImActivity`), as far as this plugin reads it. */
export interface ImActivityLike {
  session: ImSessionRecordLike
  turn: number
  status: ImActivityStatus
  /**
   * The message whose delivery started this turn: the person's own message when
   * a chat message did, and absent for a turn nothing addressed to the bot
   * started (a recovery, an injected notice, a tool-driven continuation).
   */
  trigger?: ImMessageLike
}

/** Outcome of one publication (`ImSendResult`). */
export interface ImSendResultLike {
  status: 'confirmed' | 'failed' | 'uncertain' | 'partial'
  /** The published message of each part, once the platform confirmed one. */
  handle?: unknown
  /** The stored own message (confirmed or partial). */
  message?: ImMessageLike
  error?: string
}

/** Options of one publication (`ImSendOptions`), as far as this plugin sets them. */
export interface ImSendOptionsLike {
  /** The hosted session the publication is attributed to; also its grants check. */
  session?: string
  /** Message the publication answers: a reply envelope, and its adapter referrer. */
  quote?: string
  /** Platform thread to publish in; `true` = the thread of the quote. */
  thread?: string | true
  /** Durable receipt key: a repeated publication of one operation publishes once. */
  operationId?: string
  signal?: AbortSignal
}

/** The slice of `ImSessions` this plugin reads. */
export interface ImSessionsLike {
  /** Record of the nearest hosted session of a calling session (walks the parent chain). */
  of?(sessionId: string): ImSessionRecordLike | undefined
  /** The message whose delivery started the session's current turn. */
  trigger?(sessionId: string): ImMessageLike | undefined
}

/** One platform bot, as far as this plugin reads it. */
export interface BotLike {
  /** Connection status as the core reports it: online, connecting, disconnected, offline. */
  status?: number
  /**
   * Add one emoji reaction to a message (§8.5).
   * @param message - the message to mark.
   * @param emoji - identity of the reaction in the platform's own catalogue.
   */
  createReaction?(message: MessageRefLike, emoji: string): Promise<void>
  /**
   * Withdraw this application's own reaction from a message.
   * @param message - the marked message.
   * @param emoji - identity of the reaction in the platform's own catalogue.
   */
  deleteReaction?(message: MessageRefLike, emoji: string): Promise<void>
  /**
   * Withdraw a message this application published. Never throws: an
   * unsupported or expired message is a logged no-op.
   * @param handle - publication handle, or the message reference itself.
   */
  delete(handle: unknown): Promise<void>
  /**
   * Whether one operation is supported in one chat.
   * @param key - capability key, e.g. `message.delete`.
   * @param target - the chat (and thread) the operation happens in.
   * @returns whether the capability is supported there.
   */
  supports?(key: string, target?: { chat: ChatRefLike; thread?: string }): boolean
}

/** The IM service (`ctx.im`), as this plugin uses it. */
export interface ImService {
  /**
   * Publish one fragment into an admitted chat (§10.5): the only way this plugin
   * writes to a platform, so grants, receipts and the reply envelope are the
   * host's own.
   * @param chat - global chat key.
   * @param content - v4 elements (a fragment; the host wraps it in `<message>`).
   * @param options - session attribution, reply quote, thread and receipt key.
   * @returns the outcome of the publication.
   */
  send(chat: string, content: unknown, options?: ImSendOptionsLike): Promise<ImSendResultLike>
  /**
   * The bot owning one chat.
   * @param chat - global chat key.
   * @returns the bot (throws when it is not mounted).
   */
  bot(chat: string): BotLike
  /**
   * One admitted chat of this process.
   * @param chat - global chat key.
   * @returns the chat, or `undefined` when it was never admitted.
   */
  chat?(chat: string): ImChatLike | undefined
  readonly sessions: ImSessionsLike
  /**
   * The output renderers the host drives, by the id a session names in its
   * `spec.output` (`summary`, `trace`, …).
   */
  readonly outputs?: ImOutputsLike
}

/** One output renderer, as far as this plugin reads it (`ImOutputRenderer`). */
export interface ImOutputRendererLike {
  /** The `spec.output` value that selects this renderer. */
  readonly id: string
  /**
   * Whether the renderer publishes a session's turns as one streamed message
   * of its own, open to this plugin's contributions through
   * `im/streaming-message`, so no separate link message is needed.
   */
  readonly streamsMessage?: boolean
}

/** The renderer registry (`ctx.im.outputs`), as far as this plugin reads it (`ImOutputs`). */
export interface ImOutputsLike {
  /**
   * One registered renderer.
   * @param id - `spec.output` value of the session.
   * @returns the renderer, or `undefined` when no plugin registered that id.
   */
  get(id: string): ImOutputRendererLike | undefined
}

/** Which state of a turn a streamed message shows. */
export type StreamingPart =
  /** The turn runs: progress line, summary or answer so far, the stop control. */
  | 'progress'
  /** The collapsed process message left behind when a streamed turn pushes its result separately. */
  | 'process'
  /** The settled answer with its footer. */
  | 'settled'
  /** The one line a stopped or failed turn closes with. */
  | 'closing'

/** One state of the message a turn streams, as `im/streaming-message` reports it. */
export interface StreamingMessageLike {
  /** The turn whose message is being built. */
  activity: ImActivityLike
  /** Which state of that turn the message shows. */
  part: StreamingPart
  /**
   * On `settled` / `closing`: `true` when the turn already kept a separate collapsed `process`
   * message in the chat, so contributions belonging once per turn are not repeated.
   */
  hasProcessMessage?: boolean
}

/** A button click in an admitted chat (`im/button`). */
export interface ImButtonEventLike {
  id: string
  user: { id: string; name?: string }
  raw?: {
    respond?: (reply: { toast?: { type: 'info' | 'success' | 'warning' | 'error'; content: string } }) => Promise<void>
  }
}

/** A reaction added to or removed from a stored message in an admitted chat (`im/reaction`). */
export interface ImReactionEventLike {
  readonly action: 'added' | 'removed'
  readonly emoji: string
  readonly chat: ImChatLike
  readonly user: { id: string; name?: string; isBot?: boolean }
  readonly bot?: { id?: string; selfId?: string }
  readonly message: ImStoredMessage
  readonly session?: string
  readonly time: number
  readonly id?: string
}

/** One session log event (`session/event`), as far as trigger attribution reads it. */
export interface SessionEventLike {
  type: string
  data?: {
    turn?: number
    source?: { kind?: string }
    content?: readonly { type?: string; text?: string }[]
  }
}


// ---------------------------------------------------------------------------------------------------------------
// The wider IM host surface the dispatch strategy reads (`ImApi`, `ImMessage`, `ImSessionSpec`, `ImDelivery`).

/** One normalized element of a message (`Element` of `@deepseek-ai/cordis-plugin-im-core`). */
export interface ElementLike {
  type: string
  attrs: Record<string, unknown>
  children: ElementLike[]
}

/** One stored message (`ImMessage`) with everything the dispatch strategy reads. */
export interface ImStoredMessage extends ImMessageLike {
  sender: { id: string; name?: string; isBot?: boolean; self: boolean }
  /** Normalized content, `<message>` root. */
  content: ElementLike
  /** `toText(content)`, mentions rendered as `@name`. */
  text: string
  /** The message this one replies to. */
  quote?: { key: string; sender?: { id: string; name?: string; isBot?: boolean; self?: boolean }; text?: string }
  mentions: { self: boolean; all: boolean; users: { id: string; name?: string }[] }
  /** Direct chat, a mention of the bot, or a reply to one of the bot's messages. */
  addressed: boolean
  time: number
}

/** What an agent is made of (`ImComposition`). */
export interface ImCompositionLike {
  agentPreset: string
  cwd: string
  provider: string
  model: string
  /**
   * Tool restriction (`ToolRestriction`) applied to the hosted session's agent: `allow` keeps only those
   * tools visible, `deny` hides the named ones, and both may be given together.
   */
  restrict?: { allow?: string[]; deny?: string[] }
}

/** What an owner asks for when it opens a hosted session (`ImSessionSpec`). */
export interface ImSessionSpecLike {
  key: string
  owner: string
  composition: ImCompositionLike
  bindings: ImBindingLike[]
  output?: string
  parent?: string
  meta?: Record<string, unknown>
}

/** A hosted session record as the dispatch strategy reads it (`ImSessionRecord`). */
export interface ImHostedRecord extends ImSessionRecordLike {
  composition: ImCompositionLike
}

/** One content block of a model message (`ContentBlock` of `@deepseek-ai/dsh-llm`), opaque here. */
export type ContentBlockLike = { type: string } & Record<string, unknown>

/** One durable delivery into a hosted session (`ImDelivery`). */
export interface ImDeliveryLike {
  id: string
  mode: 'steer' | 'followup' | 'inject'
  content: readonly ContentBlockLike[] | readonly ImStoredMessage[]
  trigger?: ImStoredMessage
  media?: boolean
  /** Envelope text placed before the formatted messages (`ImDelivery.header`). */
  header?: string
}

/** Read side of the message store (`ImHistory`), addressed by per-chat sequence numbers. */
export interface ImHistoryLike {
  /**
   * Up to `limit` messages with seq > `seq`, oldest first, keeping only those `keep` accepts. A reader of one
   * conversation passes the test that names it, so the limit counts that conversation's messages.
   */
  after(chat: string, seq: number, limit: number, keep?: (message: ImStoredMessage) => boolean): ImStoredMessage[]
  /** The same walk backwards: up to `limit` messages with seq < `seq`, oldest first. */
  before(chat: string, seq: number, limit: number, keep?: (message: ImStoredMessage) => boolean): ImStoredMessage[]
  get(key: string): ImStoredMessage | undefined
}

/** Structural slice of a live `Session` (`@deepseek-ai/dsh-session`). */
export interface LiveSessionLike {
  readonly id: string
}

/** Structural slice of `SessionTitleSnapshot` (`@deepseek-ai/dsh-session-title`). */
export interface SessionTitleSnapshotLike {
  readonly title: string
  readonly source: { readonly kind: string }
}

/** Structural slice of `ctx.sessionTitle` (`@deepseek-ai/dsh-session-title`). */
export interface SessionTitleServiceLike {
  get(session: LiveSessionLike): SessionTitleSnapshotLike | undefined
  rename(session: LiveSessionLike, title: string): SessionTitleSnapshotLike
}

/** Structural slice of `ctx.sessions` (`@deepseek-ai/dsh-session`). */
export interface SessionStoreLike {
  get(id: string): LiveSessionLike | undefined
  list(): readonly LiveSessionLike[]
  flush?(session: LiveSessionLike): Promise<boolean>
}

/** Structural slice of `ctx.sessionQuery` (`@deepseek-ai/dsh-session-query`). */
export interface SessionQueryLike {
  observeSession(id: string): Promise<{
    readonly events: readonly { readonly type: string; readonly data?: unknown }[]
    [Symbol.dispose](): void
  }>
}

/**
 * The IM host (`ImApi`) as the dispatch strategy uses it. The live `ctx.im` implements all of it; {@link ImService}
 * only declares the slice the link and reaction surfaces read, so the dispatch host views the same service through
 * this wider declaration.
 */
export interface DispatchIm {
  readonly sessions: {
    ensure(spec: ImSessionSpecLike): Promise<ImHostedRecord>
    get(keyOrId: string): ImHostedRecord | undefined
    list?(filter?: { owner?: string; chat?: string }): ImHostedRecord[]
    bind(target: string, bindings: ImBindingLike[]): Promise<void>
    deliver(target: string, delivery: ImDeliveryLike): Promise<void>
    agent?(target: string): Promise<{ session: LiveSessionLike }>
    trigger?(sessionId: string): ImStoredMessage | undefined
  }
  readonly history: ImHistoryLike
  bot?(chat: string): {
    selfId?: string
    getMessage?(chat: ChatRefLike, id: string): Promise<{ sender: { id: string; name?: string; isBot?: boolean } }>
    getChat?(chat: ChatRefLike): Promise<{ name?: string }>
    supports?(key: string, target?: { chat: ChatRefLike; thread?: string }): boolean
    api?: {
      getChat?(chatId: string, query?: Record<string, unknown>, signal?: AbortSignal): Promise<{ name?: string }>
    }
  }
  send?(chat: string, content: unknown, options?: ImSendOptionsLike): Promise<ImSendResultLike>
  format(
    messages: readonly ImStoredMessage[],
    options?: { style?: 'xml' | 'line'; media?: boolean; header?: string },
  ): Promise<ContentBlockLike[]>
}

/** Argument of the `im/message` waterfall (`ImMessageEvent`), as far as the dispatch strategy reads it. */
export interface ImMessageEventLike {
  readonly message: ImStoredMessage
  deliver(target: string, options: {
    id?: string
    mode: 'steer' | 'followup' | 'inject'
    content?: readonly ContentBlockLike[]
    trigger?: ImStoredMessage
    media?: boolean
  }): Promise<void>
}

/** What the `im/message` waterfall settled on (`ImOutcome`). */
export type ImOutcomeLike =
  | { kind: 'handled'; by: string; sessions?: string[] }
  | { kind: 'ignored'; reason?: string }

// ---------------------------------------------------------------------------------------------------------------
// The task service (`ctx.imTasks` of `@deepseek-ai/dsh-im-session-tasks`).

/** One background task (`ImTask`). */
export interface ImTaskLike {
  id: number
  title: string
  note?: string
  description?: string
  wantedTopics?: string[]
  topicScope?: 'chat' | 'all'
  followThread?: boolean
  ownerKind?: string
  /** Worker session serving the task. */
  session: string
  /** Session that started the task. */
  owner: string
  /** Home chat of the worker. */
  chat: string
  meta?: Record<string, unknown>
  createdAt: number
  /** Last recorded change of any kind, Unix milliseconds. */
  updatedAt: number
}

/** Profile fields a worker may update on its task. */
export interface ImTaskDescribeLike {
  description?: string
  wantedTopics?: readonly string[]
  topicScope?: 'chat' | 'all'
  followThread?: boolean
  note?: string
}

/** Where a new worker may speak and which message its first turn answers (`ImTaskPlacement`). */
export interface ImTaskPlacementLike {
  bindings: ImBindingLike[]
  trigger?: ImStoredMessage
}

/** What a caller asks a new task to be (`ImTaskStart`). */
export interface ImTaskStartLike {
  owner: string
  title: string
  brief?: string
  messages?: readonly ImStoredMessage[]
  extraContent?: readonly ContentBlockLike[]
  deliveryMode?: 'steer' | 'inject'
  worker?: ImCompositionLike
  output?: string
  placement?: ImTaskPlacementLike
  id?: string
  meta?: Record<string, unknown>
  signal?: AbortSignal
}

/** The task service (`ImTasks`), as far as the dispatch strategy uses it. */
export interface ImTasksLike {
  start(request: ImTaskStartLike): Promise<ImTaskLike>
  /** Stored tasks matching the filter, newest first. */
  list(filter?: { owner?: string; chat?: string }): ImTaskLike[]
  get(id: number): ImTaskLike | undefined
  of(session: string): ImTaskLike | undefined
  message(owner: string, id: number, text: string, options?: { id?: string }): Promise<ImTaskLike>
  note(worker: string, note: string): Promise<ImTaskLike>
  describe?(worker: string, profile: ImTaskDescribeLike): Promise<ImTaskLike>
  /** Deliver messages to a task's worker as follow-ups, once per message key, with `options.header` read first. */
  deliver(id: number, messages: readonly ImStoredMessage[], options?: { header?: string }): Promise<ImTaskLike>
}

// ---------------------------------------------------------------------------------------------------------------
// Auxiliary LLM calls (`ctx.llm` of `@deepseek-ai/dsh-llm`), read dynamically via `ctx.get('llm')`.

/** Call controls passed to `ctx.llm.prepareCall`. */
export interface LlmCallConfigLike {
  provider: string
  model: string
  reasoningEffort?: string
  temperature?: number
  maxTokens?: number
  stop?: string[]
}

/** One user-role input message in a synthetic/fork LLM request. */
export interface LlmRequestMessageLike {
  readonly role: 'user'
  readonly content: ContentBlockLike[]
}

/** One full `GenerateOptions` payload accepted by `PreparedLlmCallLike.stream`. */
export interface LlmGenerateOptionsLike extends LlmCallConfigLike {
  messages: LlmRequestMessageLike[]
  system?: string
  tools?: undefined
  sessionId?: string
  signal?: AbortSignal
}

/** One chunk from `PreparedLlmCallLike.stream`. */
export type LlmStreamChunkLike =
  | { type: 'text-delta'; text: string }
  | { type: 'finish'; reason: { kind: string; failure?: { message: string } } }
  | { type: string }

/** Result of `ctx.llm.prepareCall`. */
export interface PreparedLlmCallLike {
  readonly config: LlmCallConfigLike
  stream(options: LlmGenerateOptionsLike): AsyncIterable<LlmStreamChunkLike>
}

/** Structural slice of `LlmRuntime` (`@deepseek-ai/dsh-llm`). */
export interface LlmServiceLike {
  prepareCall(config: LlmCallConfigLike, signal?: AbortSignal): Promise<PreparedLlmCallLike>
}

/** Minimal user message shape seen by `agent/pre-step`. */
export interface PreStepMessageLike {
  readonly role: 'user'
  readonly content: ContentBlockLike[]
  readonly id?: string
  readonly source?: unknown
}

/** Decision returned from an `agent/pre-step` waterfall handler. */
export type PreStepDecisionLike =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: PreStepMessageLike[]; startsRequestSeries?: true }

// ---------------------------------------------------------------------------------------------------------------
// Storage domains (`ctx.storageDomain` of `@deepseek-ai/dsh-storage-domain`).

/** Anything with a throwing `parse` (a zod schema): the facility validates stored records through it. */
export interface RecordSchemaLike<V> {
  parse(value: unknown): V
}

/** One domain declaration (`DomainSpec`, what `defineDomain` returns). */
export interface DomainSpecLike {
  readonly name: string
  readonly version: number
  readonly global?: { readonly schema: RecordSchemaLike<unknown>; readonly initial: unknown }
  readonly tables: Readonly<Record<string, { readonly valueSchema: RecordSchemaLike<unknown> }>>
}

/** One table of an open domain (`KvTable`). */
export interface KvTableLike<V> {
  get(key: string): V | undefined
  entries(): IterableIterator<[string, V]>
  readonly size: number
  put(key: string, value: V): Promise<void>
  delete(key: string): Promise<boolean>
}

/** One open domain (`Domain`), untyped: its records already passed the spec's schemas. */
export interface DomainLike {
  readonly global: { get(): unknown; set(value: unknown): Promise<void> }
  table(name: string): KvTableLike<unknown>
  close(): Promise<void>
}

/** The domain facility (`DomainFacility`). */
export interface StorageDomainLike {
  open(spec: DomainSpecLike): Promise<DomainLike>
}

// ---------------------------------------------------------------------------------------------------------------
// Tools and the system prompt (`ctx.tools` of `@deepseek-ai/dsh-tools`, `ctx.systemPrompt` of
// `@deepseek-ai/dsh-system-prompt`).

/** The calling agent of a tool or a prompt assembly, as far as this plugin reads it. */
export interface AgentLike {
  session: { id: string }
}

/** Runtime context of one tool call (`ToolRunContext`). */
export interface ToolRunContextLike {
  readonly callId: string
  readonly agent?: AgentLike
  readonly signal: AbortSignal
}

/** One raw JSON Schema node (the supported subset `ToolOutputDefinition.schema` takes). */
export type JsonSchemaLike = Record<string, unknown>

/** One registered tool (`ToolDefinition`): raw schemas, the renderer and the body. */
export interface ToolDefinitionLike {
  readonly name: string
  readonly description: string
  readonly parameters: JsonSchemaLike
  readonly output: {
    readonly schema: JsonSchemaLike
    render(args: unknown, value: unknown): ContentBlockLike[]
  }
  execute(args: unknown, exec: ToolRunContextLike): Promise<unknown>
  isConcurrencySafe?(args: unknown): boolean
}

/** The tool registry (`ctx.tools`). */
export interface ToolsLike {
  /** Register one tool for the calling scope; the scope's disposal unregisters it. */
  register(definition: ToolDefinitionLike): () => void
}

/** One system-prompt section (`PromptSection`). */
export interface PromptSectionLike {
  readonly name: string
  readonly order: number
  readonly interpolate?: boolean
  readonly text: string | ((context: { agent?: AgentLike }) => string)
}

/** The system-prompt assembler (`ctx.systemPrompt`). */
export interface SystemPromptLike {
  /** Register one section for the calling scope; the scope's disposal removes it. */
  section(section: PromptSectionLike): () => void
}

/** Platform user identity in `dsh-im-session-auth`. */
export interface SessionAuthUserLike {
  id: string
  name?: string
}

/** One capability grant summary in `dsh-im-session-auth`. */
export interface SessionAuthGrantLike {
  capabilityId: string
  title: string
  status: 'pending' | 'active' | 'reauth_required' | 'revoked'
  grantor: SessionAuthUserLike
  statusMessage?: string
  updatedAt: number
}

/** Read-only ACL + capability snapshot of one hosted session (`ctx.imAuth.aclOf`). */
export interface SessionAclLike {
  sessionId: string
  exclusive: boolean
  owner?: SessionAuthUserLike
  allowedUsers: readonly (SessionAuthUserLike & { addedBy?: string; addedAt: number })[]
  grants: readonly SessionAuthGrantLike[]
}

/** Structural slice of `ctx.imAuth` (`dsh-im-session-auth`) read by `dsh-im-dispatch`. */
export interface SessionAuthLike {
  isExclusive(sessionId: string): boolean
  canInteract(sessionId: string, userId: string): boolean
  aclOf(sessionId: string): SessionAclLike | undefined
  listAcls?(): SessionAclLike[]
  operatorUnlock(sessionId: string): Promise<boolean>
  requestCapabilities?(request: {
    sessionId: string
    chat: string
    capabilities: readonly string[]
    reason?: string
    title?: string
    quote?: string
    thread?: string
    operationId?: string
    requester?: { id: string; name?: string }
  }): Promise<
    | {
      ok: true
      alreadyActive?: true
      autoGranted?: { id: string; title: string; grantor: { id: string; name?: string } }[]
      cardId?: string
      message?: string
    }
    | { ok: false; error: string }
  >
}

/** Provider-specific resource base of a skill (`SkillResourceBase` of `@deepseek-ai/dsh-skill`). */
export type SkillResourceBaseLike =
  | { readonly kind: 'directory'; readonly path: string }
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'opaque'; readonly description: string }

/** Invocation controls of a skill (`SkillInvocationPolicy` of `@deepseek-ai/dsh-skill`). */
export interface SkillInvocationPolicyLike {
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
}

/** One skill summary returned by `ctx.skills.list()`. */
export interface SkillSummaryLike {
  readonly path?: string
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly invocation: SkillInvocationPolicyLike
  readonly source: string
  readonly provider: string
  readonly resourceBase?: SkillResourceBaseLike
}

/** Complete skill definition returned by `ctx.skills.get()`. */
export interface SkillDefinitionLike extends SkillSummaryLike {
  readonly content: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** The skill registry (`ctx.skills` of `@deepseek-ai/dsh-skill`), read dynamically via `ctx.get('skills')`. */
export interface SkillRegistryLike {
  list(options?: { cwd?: string; signal?: AbortSignal }): Promise<SkillSummaryLike[]>
  get(name: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<SkillDefinitionLike | undefined>
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A background task was started (emitted by `dsh-im-session-tasks`).
     * @param task - the stored task.
     */
    'im/task/started'(task: ImTaskLike): void
    /**
     * A background task changed (steer, note, profile describe, or delivery).
     * @param task - the stored task after the change.
     */
    'im/task/updated'(task: ImTaskLike): void
  }
}
