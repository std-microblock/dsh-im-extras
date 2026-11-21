/**
 * Task host: the durable task registry and task lifecycle over `ctx.im.sessions`.
 *
 * Contract:
 * - **Workers.** A task's worker is an ordinary hosted session `{ key: 'task:<id>', owner: 'session-tasks', parent:
 *   the owner record, bindings: <placement bindings>, output }`; its composition defaults to the owner's. Everything
 *   the worker does goes through the IM tools and `ctx.im.send`/`stream`, so no worker-specific plumbing lives here
 *   beyond the input delivery.
 * - **Placement.** A start names its placement, or the placer registered for the owner record's `owner` name decides
 *   it, or the default applies: the chat of the owner's current trigger (writable as the owner's binding of that chat,
 *   confined to the trigger's thread) with that message as the trigger, else a copy of the owner's home binding and no
 *   trigger. The service publishes nothing itself and routes no inbound message.
 * - **Delivery.** The brief reaches the worker as a `steer` whose `trigger` is the placement's trigger, so the
 *   worker's renderer quotes and threads its first answer from it; `deliver` hands messages over as `steer`s
 *   deduped by message key; an owner steer arrives as `steer`; the worker's note reaches the owner as `inject`,
 *   which never wakes it.
 * - **Idempotency.** `start` with a known `key` returns the recorded task; every delivery carries a durable id, so a
 *   replayed tool call or a redelivered message never reaches an inbox twice.
 * - **Events.** `im/task/started` follows a new task's input delivery; `im/task/updated` follows every later stored
 *   change.
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  ImError, type ImApi, type ImBinding, type ImChatKey, type ImDelivery, type ImMessage, type ImSessionRecord,
  type ImSessionSpec,
} from '@deepseek-ai/dsh-im'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  TASKS_OWNER, type ImTask, type ImTaskDelivery, type ImTaskDescribe, type ImTaskFilter, type ImTaskPlacement,
  type ImTaskPlacer, type ImTaskStart, type ImTasks, type SessionTasksConfig, type TaskRecord,
} from './api.ts'
import { imTasksDomain, type ImTasksDomain } from './domain.ts'
import { fill, stringsOf, type SessionTaskStrings } from './locale.ts'

/** Delivery of one handed-over message: once per worker and message key. */
function deliveryOf(message: ImMessage): ImDelivery {
  return { id: `message:${message.key}`, mode: 'steer', content: [message], trigger: message, media: true }
}

/**
 * The placement of a task whose request names none and whose owner name has no placer.
 * @param sessions - the IM session host (its `trigger` names the owner's current message).
 * @param owner - the owner record.
 * @returns the trigger's chat and thread with that trigger, else a copy of the owner's home binding.
 * @throws ImError `access` for an owner without a trigger and without any binding.
 */
export function defaultPlacement(sessions: ImApi['sessions'], owner: ImSessionRecord): ImTaskPlacement {
  const trigger = sessions.trigger?.(owner.sessionId)
  if (trigger !== undefined) {
    const chat = trigger.chat.key
    const writable = owner.bindings.find(entry => entry.chat === chat)?.writable ?? false
    const thread = trigger.thread?.id
    return { bindings: [{ chat, writable, home: true, ...thread === undefined ? {} : { thread } }], trigger }
  }
  const home = owner.bindings.find(entry => entry.home === true) ?? owner.bindings[0]
  if (home === undefined) {
    throw new ImError('access', 'This session is bound to no chat; give the task a placement.')
  }
  return { bindings: [{ ...home, home: true }] }
}

/** Single-process owner of the task registry and of task lifecycle. */
export class ImTaskHost implements ImTasks {
  private domain: ImTasksDomain | undefined
  /** Current record per worker session. */
  private readonly records = new Map<SessionId, TaskRecord>()
  /** Placer per owner name. */
  private readonly placers = new Map<string, ImTaskPlacer>()
  /** Serializes starts (one task table, one id sequence). */
  private chain: Promise<unknown> = Promise.resolve()
  private readonly strings: SessionTaskStrings

  constructor(readonly ctx: Context, readonly im: ImApi, readonly config: SessionTasksConfig) {
    this.strings = stringsOf(config.locale)
  }

  /** Open the `im_tasks` domain and load what an earlier process recorded. */
  async open(): Promise<void> {
    const domain = await this.ctx.storageDomain.open(imTasksDomain)
    this.domain = domain
    for (const [, record] of domain.table('tasks').entries()) this.records.set(record.session, record)
  }

  /** Finish the in-flight task operations and close the domain. */
  async dispose(): Promise<void> {
    await this.chain
    const domain = this.domain
    this.domain = undefined
    this.records.clear()
    await domain?.close()
  }

  // ---------------------------------------------------------------------------------------------------------------
  // ImTasks

  async start(request: ImTaskStart): Promise<ImTask> {
    const owner = this.resolve(request.owner)
    const title = this.text(request.title, 'title')
    return await this.serial(async (): Promise<TaskRecord> => {
      const previous = request.id === undefined ? undefined : this.started(owner.sessionId, request.id)
      if (previous !== undefined) return previous
      request.signal?.throwIfAborted()
      const id = this.nextId()
      const input = await this.brief(id, title, request)
      const { placement, chat } = await this.place(request, owner)
      const record = await this.im.sessions.ensure(workerSpec(placement.bindings, request, owner, id))
      const now = Date.now()
      const task: TaskRecord = {
        session: record.sessionId,
        id,
        owner: owner.sessionId,
        ownerKind: owner.owner,
        title,
        chat,
        ...request.meta === undefined ? {} : { meta: request.meta },
        ...request.id === undefined ? {} : { key: request.id },
        seq: 0,
        createdAt: now,
        updatedAt: now,
      }
      await this.save(task)
      await this.im.sessions.deliver(record.sessionId, {
        id: `task:${id}:input`, mode: request.deliveryMode ?? 'steer', content: input,
        ...placement.trigger === undefined ? {} : { trigger: placement.trigger },
      })
      this.ctx.emit('im/task/started', task)
      return task
    })
  }

  list(filter: ImTaskFilter = {}): ImTask[] {
    const owner = filter.owner === undefined ? undefined : this.resolve(filter.owner).sessionId
    return [...this.records.values()]
      .filter(record => (owner === undefined || record.owner === owner)
        && (filter.chat === undefined || record.chat === filter.chat))
      .sort((left, right) => right.id - left.id)
  }

  get(id: number): ImTask | undefined {
    return this.task(id)
  }

  of(session: SessionId): ImTask | undefined {
    return this.records.get(session)
  }

  async message(
    owner: SessionId | string, id: number, text: string, options: { id?: string } = {},
  ): Promise<ImTask> {
    const task = this.ownedTask(owner, id)
    const body = this.text(text, 'message')
    const seq = task.seq + 1
    const updated: TaskRecord = {
      ...task,
      seq,
      updatedAt: Date.now(),
    }
    await this.save(updated)
    await this.im.sessions.deliver(task.session, {
      id: options.id ?? `task:${task.id}:msg:${seq}`,
      mode: 'steer',
      content: [{ type: 'text', text: fill(this.strings.steer, { id: task.id, text: body }) }],
    })
    this.ctx.emit('im/task/updated', updated)
    return updated
  }

  /**
   * Record the worker's latest note and leave it in the owner session.
   * @param worker - the worker session id or key.
   * @param note - progress, or the result in brief.
   * @returns the stored task.
   */
  async note(worker: SessionId | string, note: string): Promise<ImTask> {
    const task = this.workerTask(worker, 'Only a task worker can record a task note.')
    const text = this.text(note, 'note')
    const seq = task.seq + 1
    const updated: TaskRecord = { ...task, note: text, seq, updatedAt: Date.now() }
    await this.save(updated)
    if (this.im.sessions.get(task.owner) !== undefined) {
      await this.im.sessions.deliver(task.owner, {
        id: `task:${task.id}:note:${seq}`,
        mode: 'inject',
        content: [{ type: 'text', text: fill(this.strings.note, { id: task.id, title: task.title, note: text }) }],
      })
    }
    this.ctx.emit('im/task/updated', updated)
    return updated
  }

  /**
   * Update a worker's self-profile (`description`, `wantedTopics`, `topicScope`, `followThread`, optional `note`).
   * Unlike {@link note}, this never injects messages into owner sessions.
   */
  async describe(worker: SessionId | string, profile: ImTaskDescribe): Promise<ImTask> {
    return await this.serial(async () => {
      const task = this.workerTask(worker, 'Only a task worker can describe a task.')
      if (
        profile.description === undefined
        && profile.wantedTopics === undefined
        && profile.topicScope === undefined
        && profile.followThread === undefined
        && profile.note === undefined
      ) {
        throw new ImError('capacity', 'Provide at least one profile field to update.')
      }
      const description = profile.description === undefined ? task.description : this.text(profile.description, 'description')
      const note = profile.note === undefined ? task.note : this.text(profile.note, 'note')
      const wantedTopics = profile.wantedTopics === undefined ? task.wantedTopics : this.topics(profile.wantedTopics)
      const topicScope = profile.topicScope ?? task.topicScope
      const followThread = profile.followThread ?? task.followThread
      const updated: TaskRecord = {
        ...task,
        ...description === undefined ? {} : { description },
        ...note === undefined ? {} : { note },
        ...wantedTopics === undefined ? {} : { wantedTopics },
        ...topicScope === undefined ? {} : { topicScope },
        ...followThread === undefined ? {} : { followThread },
        updatedAt: Date.now(),
      }
      await this.save(updated)
      this.ctx.emit('im/task/updated', updated)
      return updated
    })
  }

  /**
   * Hand messages over to a task's worker, once per message key.
   * @param id - the task number.
   * @param messages - the messages to hand over.
   * @param options - presentation of the batch; its `header` precedes the formatted messages.
   * @returns the updated task record.
   */
  async deliver(id: number, messages: readonly ImMessage[], options?: ImTaskDelivery): Promise<ImTask> {
    const task = this.task(id)
    if (task === undefined) throw new ImError('access', `There is no task #${id}.`)
    if (messages.length === 0) throw new ImError('capacity', 'Deliver at least one message to a task.')
    for (const message of messages) {
      await this.im.sessions.deliver(task.session, {
        ...deliveryOf(message),
        ...options?.header === undefined ? {} : { header: options.header },
      })
    }
    return await this.serial(async () => {
      const current = this.task(id) ?? task
      const updated: TaskRecord = {
        ...current,
        updatedAt: Date.now(),
      }
      await this.save(updated)
      this.ctx.emit('im/task/updated', updated)
      return updated
    })
  }

  placement(owner: string, place: ImTaskPlacer): () => void {
    if (this.placers.has(owner)) {
      throw new ImError('configuration', `Owner ${owner} already has a task placer.`)
    }
    this.placers.set(owner, place)
    return () => {
      if (this.placers.get(owner) === place) this.placers.delete(owner)
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Placement and input

  /**
   * The placement of a new task — the request's own, else its owner name's placer, else the default — with the
   * worker's home chat: its `home` binding, else its first.
   */
  private async place(
    request: ImTaskStart, owner: ImSessionRecord,
  ): Promise<{ placement: ImTaskPlacement; chat: ImChatKey }> {
    const placer = this.placers.get(owner.owner)
    const placement = request.placement
      ?? (placer === undefined ? defaultPlacement(this.im.sessions, owner) : await placer(request, owner))
    const home = placement.bindings.find(entry => entry.home === true) ?? placement.bindings[0]
    if (home === undefined) {
      throw new ImError('configuration', 'A task placement must bind the worker to at least one chat.')
    }
    return { placement, chat: home.chat }
  }

  /** The input the worker of a new task reads first. */
  private async brief(id: number, title: string, request: ImTaskStart): Promise<UserMessage['content']> {
    const header = fill(this.strings.brief, { id, title })
    const { brief, messages, extraContent } = request
    let base: UserMessage['content']
    if (brief !== undefined) base = [{ type: 'text', text: `${header}\n\n${this.text(brief, 'brief')}` }]
    else if (messages !== undefined) base = await this.im.format(messages, { media: true, header })
    else throw new ImError('capacity', 'A task starts from a brief or from messages.')
    return extraContent !== undefined && extraContent.length > 0 ? [...base, ...extraContent] : base
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Records

  private save(record: TaskRecord): Promise<void> {
    return this.domainOf().table('tasks').put(record.session, record)
      .then(() => { this.records.set(record.session, record) })
  }

  private task(id: number): TaskRecord | undefined {
    return [...this.records.values()].find(record => record.id === id)
  }

  private started(owner: SessionId, key: string): TaskRecord | undefined {
    return [...this.records.values()].find(record => record.owner === owner && record.key === key)
  }

  private nextId(): number {
    return [...this.records.values()].reduce((max, record) => Math.max(max, record.id), 0) + 1
  }

  /** The task of one caller, which the caller (or a shared router fleet) must own. */
  private ownedTask(caller: SessionId | string, id: number): TaskRecord {
    const callerRecord = this.resolve(caller)
    const task = this.task(id)
    if (task === undefined) throw new ImError('access', `This session has no task #${id}.`)
    if (task.owner === callerRecord.sessionId) return task
    const shared = this.config.sharedOwners ?? ['dispatch', 'dispatcher']
    if (shared.includes(callerRecord.owner)) {
      const ownerKind = task.ownerKind ?? this.im.sessions.get(task.owner)?.owner
      if (ownerKind === undefined || shared.includes(ownerKind)) return task
    }
    throw new ImError('access', `This session has no task #${id}.`)
  }

  /** The task one worker session serves. */
  private workerTask(caller: SessionId | string, denyMessage: string): TaskRecord {
    const record = this.records.get(this.resolve(caller).sessionId)
    if (record === undefined) throw new ImError('access', denyMessage)
    return record
  }

  private resolve(caller: SessionId | string): ImSessionRecord {
    const record = this.im.sessions.get(caller)
    if (record === undefined) throw new ImError('access', `No IM session ${caller} is hosted.`)
    return record
  }

  /** Validate and bound one task text. */
  private text(value: string, what: string): string {
    if (!value.trim()) throw new ImError('capacity', `The task ${what} must not be empty.`)
    if (value.length > this.config.maxTextChars) {
      throw new ImError('capacity', `The task ${what} exceeds ${this.config.maxTextChars} characters.`)
    }
    return value
  }

  /** Validate and bound one list of wanted topics (`[]` clears). */
  private topics(values: readonly string[]): string[] {
    const normalized: string[] = []
    let chars = 0
    for (const raw of values) {
      const trimmed = raw.trim()
      if (!trimmed) throw new ImError('capacity', 'Each wanted topic must be non-empty.')
      chars += trimmed.length
      if (chars > this.config.maxTextChars) {
        throw new ImError('capacity', `The task wantedTopics exceed ${this.config.maxTextChars} characters.`)
      }
      normalized.push(trimmed)
    }
    return normalized
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(operation)
    this.chain = result.then(() => {}, () => {})
    return result
  }

  private domainOf(): ImTasksDomain {
    if (this.domain === undefined) throw new ImError('unavailable', 'The IM task store is not open.')
    return this.domain
  }
}


/** Session spec of one task's worker. */
function workerSpec(
  bindings: ImBinding[], request: ImTaskStart, owner: ImSessionRecord, id: number,
): ImSessionSpec {
  return {
    key: `task:${id}`,
    owner: TASKS_OWNER,
    composition: request.worker ?? owner.composition,
    parent: owner.sessionId,
    ...request.output === undefined ? {} : { output: request.output },
    bindings,
    meta: { task: id },
  }
}
