/**
 * The `task_*` tools, registered per role: `task_start`, `task_list` and `task_message` belong to a task owner (the
 * session that starts tasks), `task_note` to a task worker. Which of them a preset registers is `config.tools`; the
 * role of one call is resolved from the IM session hosting the calling agent, so a preset that registers everything
 * still cannot act across roles.
 *
 * Every tool declares `oneOf: [<its payload>, errorValue]`: a refused task operation is a declared value the model
 * can act on, not an opaque failure.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { ImError, operationId, type ImApi, type ImSessionRecord } from '@deepseek-ai/dsh-im'
import {
  defineTool, type ParameterSchemaSpec, type ToolRunContext, type ValueSchemaSpec,
} from '@deepseek-ai/dsh-tools'
import type { ImTask, ImTaskRole, SessionTasksConfig } from './api.ts'
import type { ImTaskHost } from './tasks.ts'

/** Every task tool, in prompt order. */
export const TASK_TOOLS = ['task_start', 'task_list', 'task_message', 'task_note', 'task_describe'] as const
/** Name of one task tool, as its prompt and the operator configuration spell it. */
export type ImTaskToolName = typeof TASK_TOOLS[number]

/** A refused operation: typed code plus the operator-facing reason. */
export const errorValue = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', const: 'error', required: true },
    code: {
      type: 'string', required: true,
      description: 'ImError code: configuration, ownership, access, unavailable, capacity, persistence or conflict.',
    },
    message: { type: 'string', required: true },
  },
} as const satisfies ValueSchemaSpec

/** One task as the tools show it. */
export const taskValue = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'integer', required: true, description: 'Task number, used by task_message, task_note, and task_describe.' },
    title: { type: 'string', required: true },
    note: { type: 'string', description: 'Latest note the worker recorded.' },
    description: { type: 'string', description: 'Detailed description of what this task owns and is doing.' },
    wantedTopics: {
      type: 'array',
      items: { type: 'string' },
      description: 'Topics or patterns this worker wants routed to it.',
    },
    topicScope: {
      type: 'string',
      enum: ['chat', 'all'],
      description: "Whether wantedTopics applies only within the task's home chat ('chat') or across all chats ('all').",
    },
    followThread: {
      type: 'boolean',
      description: 'Whether unaddressed replies in the task thread auto-route to the worker (default false).',
    },
    chat: { type: 'string', required: true, description: 'Chat the worker answers in.' },
    updatedAt: {
      type: 'integer', required: true,
      description: 'Last recorded change of this task, Unix milliseconds: a start, a steer, a note, a profile update, or a delivery.',
    },
  },
} as const satisfies ValueSchemaSpec

/** `task_start`, `task_message` and `task_note` result. */
export const taskOutput = { oneOf: [taskValue, errorValue] } as const satisfies ValueSchemaSpec

/** `task_list` result. */
export const taskListOutput = {
  oneOf: [{
    type: 'object',
    additionalProperties: false,
    properties: { tasks: { type: 'array', items: taskValue, required: true } },
  }, errorValue],
} as const satisfies ValueSchemaSpec

/** A declared operation error, as every task tool reports it. */
export interface TaskToolError {
  status: 'error'
  code: string
  message: string
}

/**
 * Register the task tools on a context that has the `tools` service.
 * @param ctx - the plugin scope owning the registrations.
 * @param im - the IM host (session records and their roles).
 * @param tasks - the task host.
 * @param config - operator configuration (`tools` role lists).
 */
export function applyTools(ctx: Context, im: ImApi, tasks: ImTaskHost, config: SessionTasksConfig): void {
  const render = (_args: unknown, value: unknown): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value) }]
  const owner = (exec: ToolRunContext): ImSessionRecord => {
    const found = caller(im, tasks, config, exec)
    if (found.role !== 'owner') throw new ImError('access', 'Only a session that owns tasks can do this.')
    return found.record
  }
  const worker = (exec: ToolRunContext, denyMessage: string): ImSessionRecord => {
    const found = caller(im, tasks, config, exec)
    if (found.role !== 'worker') throw new ImError('access', denyMessage)
    return found.record
  }

  if (enabled(config, 'task_start')) {
    ctx.tools.register(defineTool({
      name: 'task_start',
      description: 'Start a background task for work that needs many steps. A new worker session receives the brief '
        + 'and answers in the chat of the message you are handling. Returns the task number.',
      parameters: {
        title: { type: 'string', required: true, description: 'Short task title shown in every task notice.' },
        brief: {
          type: 'string', required: true,
          description: 'Everything the worker needs: the request in the user\'s words, links, message numbers, '
            + 'constraints, and what to deliver.',
        },
      } satisfies ParameterSchemaSpec,
      output: { schema: taskOutput, render },
      execute: (args, exec) => run(async () => {
        const record = owner(exec)
        return viewOf(await tasks.start({
          owner: record.sessionId, title: args.title, brief: args.brief,
          id: operationId(record.sessionId, exec.callId), signal: exec.signal,
        }))
      }),
    }))
  }

  if (enabled(config, 'task_list')) {
    ctx.tools.register(defineTool({
      name: 'task_list',
      description: 'List the background tasks of this conversation, newest first, with their last note and activity.',
      parameters: {} satisfies ParameterSchemaSpec,
      output: { schema: taskListOutput, render },
      isConcurrencySafe: () => true,
      execute: (_args, exec) => run(() => {
        const record = owner(exec)
        return Promise.resolve({ tasks: tasks.list({ owner: record.sessionId }).map(viewOf) })
      }),
    }))
  }

  if (enabled(config, 'task_message')) {
    ctx.tools.register(defineTool({
      name: 'task_message',
      description: 'Send new instructions or information to an existing task of this conversation; its worker '
        + 'receives them at its next step.',
      parameters: {
        id: { type: 'integer', required: true, description: 'Task number from task_start or task_list.' },
        text: { type: 'string', required: true, description: 'Instructions for the worker.' },
      } satisfies ParameterSchemaSpec,
      output: { schema: taskOutput, render },
      execute: (args, exec) => run(async () => {
        const record = owner(exec)
        return viewOf(await tasks.message(record.sessionId, args.id, args.text, {
          id: operationId(record.sessionId, exec.callId),
        }))
      }),
    }))
  }

  if (enabled(config, 'task_note')) {
    ctx.tools.register(defineTool({
      name: 'task_note',
      description: 'Task workers only: record what your task has done, in one or two sentences. The session that owns '
        + 'the task reads the note, and anyone reading the task list sees it as the latest result.',
      parameters: {
        note: { type: 'string', required: true, description: 'Progress, or the result in brief.' },
      } satisfies ParameterSchemaSpec,
      output: { schema: taskOutput, render },
      execute: (args, exec) => run(async () => {
        const record = worker(exec, 'Only a task worker can record a task note.')
        return viewOf(await tasks.note(record.sessionId, args.note))
      }),
    }))
  }

  if (enabled(config, 'task_describe')) {
    ctx.tools.register(defineTool({
      name: 'task_describe',
      description: 'Task workers only: describe what this task owns (`description`, `wantedTopics`, `topicScope`, '
        + '`followThread`, optional `note`) without notifying owner sessions. Do NOT put generic category tags in '
        + '`wantedTopics` — reserve `wantedTopics` strictly for ongoing watchers waiting on specific alerts/tickets/releases.',
      parameters: {
        description: {
          type: 'string',
          description: 'Detailed summary of what this task is handling, files/PRs/topics owned, and current status.',
        },
        wantedTopics: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific ongoing watch targets (e.g. an alert name, ticket/MR id, or release version) that '
            + 'should route future unaddressed or cross-chat messages here; pass [] to clear. MUST be [] for ordinary '
            + 'one-off tasks (games, cards, scripts, Q&A) — never put generic category tags like "像素游戏" or "网页小游戏".',
        },
        topicScope: {
          type: 'string',
          enum: ['chat', 'all'] as const,
          description: "Scope of wantedTopics: 'chat' (current group only, default) or 'all' (across all groups).",
        },
        followThread: {
          type: 'boolean',
          description: 'Whether unaddressed follow-up replies in your thread auto-deliver to you (default true; set false when finished).',
        },
        note: {
          type: 'string',
          description: 'Optional brief one-line status note.',
        },
      } satisfies ParameterSchemaSpec,
      output: { schema: taskOutput, render },
      execute: (args, exec) => run(async () => {
        const record = worker(exec, 'Only a task worker can describe a task.')
        if (args.topicScope !== undefined && args.topicScope !== 'chat' && args.topicScope !== 'all') {
          throw new ImError('capacity', "topicScope must be 'chat' or 'all'.")
        }
        return viewOf(await tasks.describe(record.sessionId, {
          ...args,
          topicScope: args.topicScope,
        }))
      }),
    }))
  }
}

/** Whether the operator asked for one tool in either role. */
function enabled(config: SessionTasksConfig, name: ImTaskToolName): boolean {
  return config.tools.owner.includes(name) || config.tools.worker.includes(name)
}

/**
 * Resolve the role of one call from the IM session hosting the calling agent.
 * @returns the caller's hosted record and its role.
 * @throws ImError `ownership` outside an IM session, `access` for an owner the operator did not enable.
 */
function caller(
  im: ImApi, tasks: ImTaskHost, config: SessionTasksConfig, exec: ToolRunContext,
): { record: ImSessionRecord; role: ImTaskRole } {
  const agent = exec.agent
  const record = agent === undefined ? undefined : im.sessions.of(agent.session.id)
  if (record === undefined) throw new ImError('ownership', 'Task tools require a session that the IM host serves.')
  if (tasks.of(record.sessionId) !== undefined) return { record, role: 'worker' }
  if (!config.owners.includes(record.owner)) throw new ImError('access', `Sessions of ${record.owner} start no tasks.`)
  return { record, role: 'owner' }
}

/** One task as the tools show it. */
export interface TaskView {
  id: number
  title: string
  note?: string
  description?: string
  wantedTopics?: string[]
  topicScope?: 'chat' | 'all'
  followThread?: boolean
  chat: string
  updatedAt: number
}

/** One task as the tools show it. */
function viewOf(task: ImTask): TaskView {
  return {
    id: task.id,
    title: task.title,
    ...task.note === undefined ? {} : { note: task.note },
    ...task.description === undefined ? {} : { description: task.description },
    ...task.wantedTopics === undefined ? {} : { wantedTopics: task.wantedTopics },
    ...task.topicScope === undefined ? {} : { topicScope: task.topicScope },
    ...task.followThread === undefined ? {} : { followThread: task.followThread },
    chat: task.chat,
    updatedAt: task.updatedAt,
  }
}

/** Run one tool operation, reporting a declared `ImError` as the value the output schema describes. */
async function run<T extends object>(operation: () => Promise<T>): Promise<T | TaskToolError> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof ImError) return { status: 'error', code: error.code, message: error.message }
    throw error
  }
}
