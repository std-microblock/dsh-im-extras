/**
 * The JSON the panel exchanges with the host that serves it, and the shapes of the tab extension API.
 *
 * Both halves share these declarations: the host builds the values and the browser renders them. Types only, so a
 * browser bundle carries no copy of this module.
 *
 * Routes (all below the harness's authenticated `/api` channel):
 *
 * - `GET  /api/im-panel` — one {@link ImPanelState} snapshot;
 * - `POST /api/im-panel` — one {@link ImPanelCommand}, answered with {@link ImPanelResult};
 * - `GET  /api/im-panel/chronicle?chat&before&query&limit` — one {@link ImPanelChroniclePage};
 * - `GET|HEAD|POST /api/im-panel/tab?id=<tab>&path=<sub path>&…` — an extension tab's own data.
 *
 * @module dsh-im-panel/protocol
 */

/** Where the panel API lives. */
export const PANEL_PATH = '/api/im-panel'
/** The chronicle browser. */
export const CHRONICLE_PATH = `${PANEL_PATH}/chronicle`
/** The route every extension tab is answered on. */
export const TAB_PATH = `${PANEL_PATH}/tab`
/** Tab ids the panel itself uses. */
export const BUILTIN_TABS = ['overview', 'sessions', 'tasks', 'rules', 'chats', 'chronicle'] as const
/** What an extension tab id must look like. */
export const TAB_ID = /^[a-z][a-z0-9-]{0,31}$/

/** One agent composition a dispatch session runs with. */
export interface ImPanelComposition {
  agentPreset: string
  provider: string
  model: string
  cwd: string
}

/** The dispatch configuration, as the overview shows it. */
export interface ImPanelDispatch {
  main: ImPanelComposition
  worker: ImPanelComposition
  workerOutput: string
  tools: { readonly main: readonly string[]; readonly worker: readonly string[] }
  limits: Readonly<Record<string, number | boolean>>
}

/** One mounted platform bot. */
export interface ImPanelBot {
  id: string
  platform: string
  /** Connection status: 0 offline, 1 online, 2 connecting, 3 disconnected, 4 reconnecting. */
  status: number
}

/** The chat transport as the IM host reports it. */
export interface ImPanelTransport {
  bots: readonly ImPanelBot[]
  /** Chats any hosted session is bound to. */
  chats: number
  sources: number
  pendingDeliveries: number
  pendingMessages: number
}

/** Session exclusivity and capability grants (`ctx.imAuth`), when present. */
export interface ImPanelSessionAuth {
  exclusive: boolean
  owner?: { id: string; name?: string }
  collaborators: readonly { id: string; name?: string }[]
  grants: readonly { capabilityId: string; title: string; status: 'pending' | 'active' | 'reauth_required' | 'revoked' }[]
}

/** One task worker (`ctx.imTasks`). */
export interface ImPanelTask {
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
  /** Display name of the home chat, when known. */
  chatName?: string
  createdAt: number
  updatedAt: number
  /** Whether a router of `dsh-im-dispatch` started it. */
  dispatch: boolean
  auth?: ImPanelSessionAuth
}

/** One route rule. */
export interface ImPanelRule {
  id: number
  task: number
  match: string
  mode: 'copy' | 'cut'
  note?: string
  errors: number
  lastError?: string
}

/** One chat a hosted session may use. */
export interface ImPanelBinding {
  chat: string
  writable: boolean
  home: boolean
  thread?: string
}

/** One hosted session. */
export interface ImPanelSession {
  sessionId: string
  key: string
  title?: string
  owner: string
  /** `router` for a dispatch router, `task` for a task worker, `other` otherwise. */
  role: 'router' | 'task' | 'other'
  parent?: string
  output?: string
  generation: number
  createdAt: number
  lastActiveAt: number
  bindings: readonly ImPanelBinding[]
  auth?: ImPanelSessionAuth
}

/** One known chat: names for pickers, and the dispatch wake/reply configuration when dispatch runs. */
export interface ImPanelChat {
  chat: string
  name?: string
  /** The platform segment of the bot id (`lark`, `qq`, …). */
  platform: string
  type?: string
  wakeMode?: 'mention' | 'watch' | 'auto'
  replyMode?: 'mention_only' | 'proactive'
  watchTopics?: readonly string[]
  watchNote?: string
  replyPolicy?: string
  firstSeenAt?: number
}

/** One chronicle entry. */
export interface ImPanelChronicleEntry {
  id: number
  time: number
  kind: string
  chat: string
  taskId?: number
  subject: string
  summary: string
}

/** Chronicle size and the newest entries. */
export interface ImPanelChronicle {
  entries: number
  chunks: number
  latestId: number
  recent: readonly ImPanelChronicleEntry[]
}

/** One page of the chronicle browser. */
export interface ImPanelChroniclePage {
  entries: readonly ImPanelChronicleEntry[]
  total: number
  next?: number
}

/** A line explaining why a view is empty. */
export interface ImPanelNotice {
  text: string
  level?: 'info' | 'warning'
}

/** A host-registered extension tab, as the snapshot lists it. */
export interface ImPanelTabInfo {
  id: string
  title: string
  order: number
  badge?: number
}

/** Everything one snapshot carries. */
export interface ImPanelState {
  now: number
  dispatch?: ImPanelDispatch
  transport?: ImPanelTransport
  tasks: readonly ImPanelTask[]
  rules: readonly ImPanelRule[]
  sessions: readonly ImPanelSession[]
  chats: readonly ImPanelChat[]
  chronicle?: ImPanelChronicle
  tabs: readonly ImPanelTabInfo[]
  notices: readonly ImPanelNotice[]
}

/** Per-chat configuration fields a command may change. */
export interface ImPanelChatPatch {
  wakeMode?: 'mention' | 'watch' | 'auto'
  replyMode?: 'mention_only' | 'proactive'
  watchTopics?: readonly string[]
  watchNote?: string
  replyPolicy?: string
}

/** One command. */
export type ImPanelCommand =
  | { readonly action: 'task-stop'; readonly id: number }
  | { readonly action: 'session-stop'; readonly sessionId: string }
  | { readonly action: 'session-unlock'; readonly sessionId: string }
  | { readonly action: 'rule-add'; readonly task: number; readonly match: string; readonly mode: 'copy' | 'cut'; readonly note?: string }
  | { readonly action: 'rule-update'; readonly id: number; readonly task: number; readonly match?: string; readonly mode?: 'copy' | 'cut'; readonly note?: string }
  | { readonly action: 'rule-remove'; readonly id: number }
  | { readonly action: 'chat-configure'; readonly chat: string; readonly patch: ImPanelChatPatch }

/** What a command answers. */
export interface ImPanelResult {
  ok: boolean
  text: string
}

// ---------------------------------------------------------------------------------------------------------------
// Tab extension API — host half

/** What a tab's JSON handlers receive. */
export interface ImPanelTabRequest {
  /** The `path` query parameter, `''` when absent. */
  path: string
  /** Every query parameter except `id` and `path`. */
  query: URLSearchParams
  /** The underlying request. */
  request: Request
}

/** One tab a host plugin registers with `ctx.imPanel.tab(...)`. */
export interface ImPanelTabDefinition {
  /** `/^[a-z][a-z0-9-]{0,31}$/`, not a built-in id. */
  id: string
  /** Navigation label. */
  title: string
  /** Navigation position; built-ins use 10–60, default 100. */
  order?: number
  /** A number on the navigation entry, read with every snapshot. */
  badge?: () => number | undefined
  /** Answers `GET`; the value is serialized as JSON. */
  read?: (request: ImPanelTabRequest) => unknown
  /** Answers `POST` with a JSON body; the value is serialized as JSON. */
  command?: (request: ImPanelTabRequest & { body: unknown }) => unknown
  /** Answers every request of the tab (images, downloads, uploads); `read`/`command` are then ignored. */
  fetch?: (request: Request, context: { path: string; query: URLSearchParams }) => Response | Promise<Response>
}

// ---------------------------------------------------------------------------------------------------------------
// Tab extension API — browser half

/** Query values a tab helper accepts; `undefined` is dropped. */
export type ImPanelQuery = Readonly<Record<string, string | number | boolean | undefined>>

/** The props an extension tab component receives. */
export interface ImPanelTabProps {
  id: string
  /** Same-origin URL of the tab route, for `<img src>` and downloads. */
  url(path?: string, query?: ImPanelQuery): string
  /** Raw request against the tab route. */
  fetch(path?: string, init?: RequestInit & { query?: ImPanelQuery }): Promise<Response>
  /** `GET` JSON; throws `Error(text)` on a failure answer. */
  read<T = unknown>(path?: string, query?: ImPanelQuery): Promise<T>
  /** `POST` JSON. */
  command<T = ImPanelResult>(body: unknown, path?: string): Promise<T>
  /** `POST` multipart; every file under the field `file`. */
  upload<T = unknown>(path: string, files: readonly Blob[], fields?: Readonly<Record<string, string>>): Promise<T>
  toast(text: string): void
  openSession(sessionId: string): void
  /** Re-read the panel snapshot. */
  refresh(): void
  /** Known chats of the last snapshot. */
  chats: readonly ImPanelChat[]
  snapshot: ImPanelState | undefined
}

/** One tab a browser plugin registers with the client `imPanel` service. */
export interface ImPanelClientTab {
  id: string
  title: string
  order?: number
  icon?: (props: { size?: number; className?: string }) => unknown
  component: (props: ImPanelTabProps) => unknown
}

/** The client `imPanel` service (`ctx.get('imPanel')` inside the browser). */
export interface ImPanelClient {
  /**
   * Register one tab component.
   * @returns the disposer.
   */
  tab(tab: ImPanelClientTab): () => void
  /** Select a tab (opens the panel when it is not on screen). */
  open(id?: string): void
}
