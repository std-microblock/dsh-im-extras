/**
 * Public contract of `@deepseek-ai/dsh-im-session-tasks`: task workers and the `task_*` tools over `ctx.im.sessions`.
 * The service is `ctx.imTasks`; strategies (such as `session-conversations`) start tasks here, decide where a worker
 * may speak through a placement, and may hand further messages to a worker with {@link ImTasks.deliver}. The service
 * routes no inbound message by itself.
 */
import type { ImBinding, ImChatKey, ImComposition, ImMessage, ImSessionRecord } from '@deepseek-ai/dsh-im'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Owner name task-worker sessions are hosted under (`ImSessionRecord.owner`). */
export const TASKS_OWNER = 'session-tasks'

/**
 * One background task: a worker session started by an owner session.
 *
 * A task carries no lifecycle state: anything that would read it is a guess about work the service cannot see, and a
 * stalled `done` flag only ever blocks the next message from reaching the task that should answer it. What the record
 * says instead is when it last changed — {@link ImTask.updatedAt} — and what the worker last reported.
 */
export interface ImTask {
  /** Number shown to both sides (`task #3`); unique across the deployment and never reused. */
  id: number
  title: string
  /** Latest progress or result note of the worker. */
  note?: string
  /** Detailed self-profile of what this task owns, scope, and current progress. */
  description?: string
  /** Topics or subjects this task wants routed to it. */
  wantedTopics?: string[]
  /** Scope of `wantedTopics`: `'chat'` (this task's home chat) or `'all'` (cross-chat). */
  topicScope?: 'chat' | 'all'
  /** Whether unaddressed follow-up messages inside this task's thread auto-deliver to the worker (default `true`). */
  followThread?: boolean
  /** Worker session serving the task. */
  session: SessionId
  /** Session that started the task (the task's owner). */
  owner: SessionId
  /** Home chat of the worker (the `home` binding of its placement). */
  chat: ImChatKey
  /** Caller-owned data stored with the task; the service never reads it. */
  meta?: Record<string, unknown>
  createdAt: number
  /** Last recorded change of any kind: a start, a steer, a note, a profile update, or a delivery. */
  updatedAt: number
}

/** Profile fields a task worker updates with {@link ImTasks.describe} / `task_describe`. */
export interface ImTaskDescribe {
  /** Detailed description of what this task is doing, scope, files/docs/topics owned, and status. */
  description?: string
  /** Topics or patterns this worker wants routed to it; pass `[]` to clear. */
  wantedTopics?: readonly string[]
  /** Scope of `wantedTopics`: `'chat'` (home chat only) or `'all'` (cross-chat). */
  topicScope?: 'chat' | 'all'
  /** Whether unaddressed follow-ups in this task's thread auto-deliver to the worker. */
  followThread?: boolean
  /** Optional brief status note (stored without injecting into the owner session). */
  note?: string
}

/** Where a new worker may speak and which message its first turn answers. */
export interface ImTaskPlacement {
  /** Chats the worker may use, each optionally confined to a `thread`; exactly one should be `home`. */
  bindings: ImBinding[]
  /** Message the worker's first turn answers; its renderer quotes it and replies in its thread. */
  trigger?: ImMessage
}

/** What a caller asks a new task to be. */
export interface ImTaskStart {
  /** Owner session that starts the task; must be hosted. */
  owner: SessionId | string
  /** Short title shown in every notice. */
  title: string
  /** What the worker reads first: the owner's brief. Exactly one of `brief` / `messages`. */
  brief?: string
  /** What the worker reads first: messages the owner hands over, formatted with `ctx.im.format`. */
  messages?: readonly ImMessage[]
  /** Optional extra content blocks appended to the worker's initial input (e.g. injected `<skill_content>`). */
  extraContent?: UserMessage['content']
  /** Initial delivery mode into the worker session; defaults to `'steer'`. Use `'inject'` to defer waking until a later `steer`. */
  deliveryMode?: 'steer' | 'inject'
  /** Composition of the worker; default: the owner's composition. */
  worker?: ImComposition
  /** Output renderer of the worker; default: none (the worker publishes with its IM tools). */
  output?: string
  /**
   * Bindings and trigger of the worker. Omitted: the placer registered for the owner record's `owner` name decides,
   * else the default placement (the owner's current trigger chat and thread, else a copy of its home binding).
   */
  placement?: ImTaskPlacement
  /** Idempotency key of the start (a tool call id); a replay returns the same task. */
  id?: string
  /** Caller-owned data stored on the task record. */
  meta?: Record<string, unknown>
  signal?: AbortSignal
}

/** Narrows {@link ImTasks.list}; every absent field matches anything. */
export interface ImTaskFilter {
  /** Owner session id or key. */
  owner?: SessionId | string
  /** Home chat of the worker. */
  chat?: ImChatKey
}

/**
 * Decides the placement of a task its request leaves open, for the owners registered under one owner name.
 * @param request - the start request without a placement.
 * @param owner - the hosted record of the owner session.
 * @returns the bindings and trigger of the new worker.
 */
export type ImTaskPlacer = (request: ImTaskStart, owner: ImSessionRecord) => Promise<ImTaskPlacement> | ImTaskPlacement

/** Which side of a task a session is: the owner that started it, or its worker. */
export type ImTaskRole = 'owner' | 'worker'

/** How handed-over messages are presented to a worker (see {@link ImTasks.deliver}). */
export interface ImTaskDelivery {
  /**
   * One model-facing line placed before the formatted messages: why they arrived, when the arrival itself does not
   * say it (the dispatch strategy marks an unaddressed thread follow-up the worker only overhears).
   */
  header?: string
}

/** The task service (`ctx.imTasks`). */
export interface ImTasks {
  /** Start (or, for a known `id`, return) one task: place it and hand the input to a new worker session. */
  start(request: ImTaskStart): Promise<ImTask>
  /** Stored tasks matching the filter, newest first. */
  list(filter?: ImTaskFilter): ImTask[]
  /** One task by number. */
  get(id: number): ImTask | undefined
  /** The task whose worker is this session, when it is one. */
  of(session: SessionId): ImTask | undefined
  /** Steer text into the worker of a task the caller owns. */
  message(owner: SessionId | string, id: number, text: string, options?: { id?: string }): Promise<ImTask>
  /** Record the worker's latest note; the owner session reads it in a notice. */
  note(worker: SessionId | string, note: string): Promise<ImTask>
  /** Update the worker's self-profile without injecting a notice into owner sessions. */
  describe(worker: SessionId | string, profile: ImTaskDescribe): Promise<ImTask>
  /** Deliver messages to a task's worker as follow-ups, once per message key, presented with `options.header`. */
  deliver(id: number, messages: readonly ImMessage[], options?: ImTaskDelivery): Promise<ImTask>
  /** Register the placer of one owner name; returns its disposer. */
  placement(owner: string, place: ImTaskPlacer): () => void
}

/** Operator configuration of the task plugin. */
export interface SessionTasksConfig {
  /** Session owners that may start tasks with the tools (the strategy names, e.g. `conversation`). */
  owners: string[]
  /**
   * Session owner names that form a shared router fleet (e.g. `dispatch`, `dispatcher`): any hosted session under
   * one of these owners may steer tasks started by any session of the same fleet, including across chats and resets.
   */
  sharedOwners?: string[]
  /** Tool names registered for each role (`task_note` / `task_describe` belong to workers, the rest to owners). */
  tools: {
    /** Tools an owner session may call (`task_start`, `task_list`, `task_message`). */
    owner: string[]
    /** Tools a task worker may call (`task_note`, `task_describe`). */
    worker: string[]
  }
  /** Bound of one task title, brief, message, note, or description, in characters. */
  maxTextChars: number
  /** Wording of the texts the worker and the owner read; `zh` by default. */
  locale: 'zh' | 'en'
}

/** The stored record of one task (the storage domain's payload): the public task plus its bookkeeping. */
export interface TaskRecord extends ImTask {
  /** Start key of the call that created the task (idempotency). */
  key?: string
  /** Strategy owner name (`ImSessionRecord.owner`) that created the task (used for shared-fleet steering). */
  ownerKind?: string
  /** Deliveries made so far (steers and notices pick their id from it). */
  seq: number
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A task was started and its worker received its input; a replayed start emits nothing.
     * @param task - the stored task.
     * @mode emit
     */
    'im/task/started'(task: ImTask): void
    /**
     * A stored task changed: a steer, a note, or a delivery to its worker.
     * @param task - the task after the change.
     * @mode emit
     */
    'im/task/updated'(task: ImTask): void
  }
}
