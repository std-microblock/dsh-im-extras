/**
 * Task workers and `task_*` tools over `ctx.im.sessions`.
 *
 * The plugin provides `ctx.imTasks` and opens the durable `im_tasks` registry. A strategy starts a task with
 * `ctx.imTasks.start({ owner, brief | messages, placement, worker, output })`: the worker becomes a hosted session
 * parented by the owner and bound to the chats of its placement. The plugin listens to no inbound message; a strategy
 * hands further messages to a worker through `ctx.imTasks.deliver(...)`.
 *
 * @module @deepseek-ai/dsh-im-session-tasks
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type { ImApi, ImMessage } from '@deepseek-ai/dsh-im'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  ImTask, ImTaskDelivery, ImTaskDescribe, ImTaskFilter, ImTaskPlacer, ImTaskStart, ImTasks, SessionTasksConfig,
} from './api.ts'
import { Config } from './config.ts'
import { ImTaskHost } from './tasks.ts'
import { applyTools } from './tools.ts'

export * from './api.ts'
export { Config } from './config.ts'
export { imTasksDomain } from './domain.ts'
export { fill, stringsOf } from './locale.ts'
export type { SessionTaskStrings, SessionTasksLocale } from './locale.ts'
export { ImTaskHost, defaultPlacement } from './tasks.ts'
export { TASK_TOOLS, errorValue, taskListOutput, taskOutput, taskValue } from './tools.ts'
export type { ImTaskToolName, TaskToolError } from './tools.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Task workers and the `task_*` tools. */
    imTasks: ImTasksService
  }
}

/** Single-process task service; the behaviours live in {@link ImTaskHost}. */
export class ImTasksService extends Service implements ImTasks {
  static inject = ['im', 'storageDomain']
  static Config = Config

  /** The behaviour behind this service: task workers and the `task_*` tools. */
  readonly host: ImTaskHost
  private readonly home: Context
  private readonly im: ImApi

  constructor(ctx: Context, readonly config: SessionTasksConfig) {
    super(ctx, 'imTasks')
    this.home = ctx
    this.im = ctx.im
    this.host = new ImTaskHost(ctx, this.im, config)
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void>, void> {
    const ctx = this.home
    await this.host.open()
    yield async () => { await this.host.dispose() }
    // `ctx.inject` names `tools` itself: nested injections do not inherit the caller's.
    ctx.inject(['tools'], (scoped) => { applyTools(scoped, this.im, this.host, this.config) })
  }

  /**
   * Start a background task: place it and compose its worker session.
   * @param request - the owner, title, brief or messages, and an optional placement.
   * @returns the stored task.
   */
  start(request: ImTaskStart): Promise<ImTask> {
    return this.host.start(request)
  }

  /**
   * The stored tasks matching one filter, newest first.
   * @param filter - owner session id or key and worker home chat; absent fields match anything.
   * @returns the stored tasks with their latest note and last activity.
   */
  list(filter?: ImTaskFilter): ImTask[] {
    return this.host.list(filter)
  }

  /**
   * One stored task by its number.
   * @param id - the task number shown to the model.
   * @returns the task, or undefined when no task carries that number.
   */
  get(id: number): ImTask | undefined {
    return this.host.get(id)
  }

  /**
   * Deliver new instructions to one task; its worker resumes and receives them.
   * @param owner - the owner session id or key the task belongs to.
   * @param id - the task number.
   * @param text - the instruction the worker receives.
   * @param options - an optional delivery id for idempotent retries.
   * @returns the task after the delivery was recorded.
   */
  message(owner: SessionId | string, id: number, text: string, options?: { id?: string }): Promise<ImTask> {
    return this.host.message(owner, id, text, options)
  }

  /**
   * Record the latest note of one task's worker.
   * @param worker - the worker session id or key.
   * @param note - progress, or the result in brief.
   * @returns the stored task.
   */
  note(worker: SessionId | string, note: string): Promise<ImTask> {
    return this.host.note(worker, note)
  }

  /**
   * Update a worker's self-profile (`description`, `wantedTopics`, `topicScope`, `followThread`, optional `note`).
   * @param worker - the worker session id or key.
   * @param profile - the profile fields to update.
   * @returns the stored task.
   */
  describe(worker: SessionId | string, profile: ImTaskDescribe): Promise<ImTask> {
    return this.host.describe(worker, profile)
  }

  /**
   * Hand further admitted messages to one task's worker, each as a follow-up delivered once per message key.
   * @param id - the task number.
   * @param messages - the messages to deliver, in chat order.
   * @returns the task after the messages were recorded.
   */
  deliver(id: number, messages: readonly ImMessage[], options?: ImTaskDelivery): Promise<ImTask> {
    return this.host.deliver(id, messages, options)
  }

  /**
   * Register the placer that decides the placement of tasks whose request names none, for one owner name.
   * @param owner - the `owner` name of the hosted records the placer serves (e.g. `dispatcher`).
   * @param place - the placer.
   * @returns the disposer of the registration.
   */
  placement(owner: string, place: ImTaskPlacer): () => void {
    return this.host.placement(owner, place)
  }

  /**
   * The task a session works, when that session is a task worker.
   * @param session - the candidate session id.
   * @returns the task, or undefined when the session is not a worker.
   */
  of(session: SessionId): ImTask | undefined {
    return this.host.of(session)
  }
}

export default ImTasksService
