/**
 * The dispatch tools registered per role: routers directly reply, spawn/route/steer tasks, list tasks/rules,
 * oversee rules, and query the cross-chat Chronicle; task workers manage rules, query Chronicle, and search IM.
 * Every refused operation returns a declared `errorValue` so agents recover gracefully.
 *
 * @module dsh-im-dispatch/tools
 */

import type {
  AgentLike, ContentBlockLike, ImTaskLike, SessionAclLike, ToolRunContextLike, ToolsLike,
} from './types.ts'
import { chronicleResultValue } from './chronicle/index.ts'
import type { ConfigureChatRequest, DispatchConfig, RouteRuleMode } from './api.ts'
import { messageView, type DispatchHost } from './host.ts'
import { isImError } from './im.ts'
import { RULE_FIELDS } from './rules.ts'
import { defineTool, type ValueSpec } from './schema.ts'

/** Every dispatch tool declared in this plugin, in prompt order. */
export const TOOL_NAMES = [
  'router_reply',
  'create_task',
  'route_messages_to_task',
  'steer_task',
  'list_tasks',
  'configure_chat',
  'query_chronicle',
  'add_route_rule',
  'update_route_rule',
  'list_route_rules',
  'remove_route_rule',
  'im_search',
] as const

/** Name of one dispatch tool. */
export type ToolName = typeof TOOL_NAMES[number]

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
} as const satisfies ValueSpec

/** One task as the tools show it. */
export const taskValue = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'integer', required: true, description: 'Task number, used by route_messages_to_task and steer_task.' },
    title: { type: 'string', required: true },
    note: { type: 'string', description: 'Latest note the worker recorded.' },
    description: { type: 'string', description: 'Worker self-profile describing scope and current progress.' },
    wantedTopics: {
      type: 'array',
      items: { type: 'string' },
      description: 'Topics the worker wants routed to it.',
    },
    topicScope: {
      type: 'string',
      enum: ['chat', 'all'],
      description: "Scope of wantedTopics: 'chat' (home chat) or 'all' (cross-chat).",
    },
    followThread: {
      type: 'boolean',
      description: 'Whether unaddressed replies in the task thread auto-deliver to the worker (default false).',
    },
    chat: { type: 'string', required: true, description: 'Home chat the worker speaks in.' },
    updatedAt: {
      type: 'integer', required: true,
      description: 'Last recorded change of this task, Unix milliseconds.',
    },
    exclusiveOwner: {
      type: 'string',
      description: 'Present when the session is exclusive; only messages from allowedUsers may route here.',
    },
    allowedUsers: {
      type: 'array',
      items: { type: 'string' },
      description: 'User IDs allowed to interact with this exclusive task.',
    },
  },
} as const satisfies ValueSpec

/** `router_reply` result. */
export const routerReplyOutput = {
  oneOf: [{
    type: 'object',
    additionalProperties: false,
    properties: {
      status: { type: 'string', required: true, description: 'IM send outcome status (confirmed, partial, uncertain, failed).' },
      messageKey: { type: 'string', description: 'Stored platform message key of the sent reply.' },
    },
  }, errorValue],
} as const satisfies ValueSpec

/** `query_chronicle` result. */
export const chronicleOutput = { oneOf: [chronicleResultValue, errorValue] } as const satisfies ValueSpec

/** One rule as the tools show it. */
export const ruleValue = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'integer', required: true, description: 'Rule ID, unique within the deployment.' },
    task: { type: 'integer', required: true, description: 'Task the rule delivers to.' },
    match: { type: 'string', required: true, description: 'JavaScript expression over im.' },
    mode: { type: 'string', enum: ['copy', 'cut'], required: true },
    note: { type: 'string', description: 'Why the task wants these messages.' },
    errors: { type: 'integer', description: 'Failed evaluations since this process started.' },
    lastError: { type: 'string', description: 'The latest of those failures.' },
  },
} as const satisfies ValueSpec

/** One message as the tools show it. */
export const messageValue = {
  type: 'object',
  additionalProperties: false,
  properties: {
    seq: { type: 'integer', required: true, description: 'Transcript number of the message inside its chat.' },
    from: { type: 'string', required: true, description: 'Sender display name, or its platform id.' },
    time: { type: 'integer', required: true, description: 'Creation time in milliseconds since the epoch.' },
    text: { type: 'string', required: true },
  },
} as const satisfies ValueSpec

export const ruleOutput = { oneOf: [ruleValue, errorValue] } as const satisfies ValueSpec

export const ruleListOutput = {
  oneOf: [{
    type: 'object',
    additionalProperties: false,
    properties: { rules: { type: 'array', items: ruleValue, required: true } },
  }, errorValue],
} as const satisfies ValueSpec

export const taskOutput = { oneOf: [taskValue, errorValue] } as const satisfies ValueSpec

/** Updated per-chat configuration snapshot (`configure_chat`). */
export const chatConfigValue = {
  type: 'object',
  additionalProperties: false,
  properties: {
    chat: { type: 'string', required: true, description: 'Chat key this configuration applies to.' },
    name: { type: 'string', description: 'Display name of the chat when known.' },
    wakeMode: {
      type: 'string',
      enum: ['mention', 'watch', 'auto'],
      required: true,
      description: "Router wake policy for unaddressed messages: 'mention', 'watch' (default), or 'auto'.",
    },
    replyMode: {
      type: 'string',
      enum: ['mention_only', 'proactive'],
      required: true,
      description: "Chat reply policy during ambient wakes: 'mention_only' (default) or 'proactive'.",
    },
    watchTopics: {
      type: 'array',
      items: { type: 'string' },
      required: true,
      description: 'Group-level keywords/patterns monitored in watch mode.',
    },
    watchNote: { type: 'string', description: 'Group-level rule explaining when to act on unaddressed messages.' },
    replyPolicy: { type: 'string', description: 'When proactive replies are appropriate.' },
  },
} as const satisfies ValueSpec

export const chatConfigOutput = { oneOf: [chatConfigValue, errorValue] } as const satisfies ValueSpec

export const taskListOutput = {
  oneOf: [{
    type: 'object',
    additionalProperties: false,
    properties: { tasks: { type: 'array', items: taskValue, required: true } },
  }, errorValue],
} as const satisfies ValueSpec

export const routedOutput = {
  oneOf: [{
    type: 'object',
    additionalProperties: false,
    properties: {
      task: { ...taskValue, required: true },
      messages: { type: 'array', items: messageValue, required: true },
    },
  }, errorValue],
} as const satisfies ValueSpec

export const searchOutput = {
  oneOf: [{
    type: 'object',
    additionalProperties: false,
    properties: {
      messages: { type: 'array', items: messageValue, required: true },
      scanned: { type: 'integer', required: true, description: 'Messages whose expression was evaluated.' },
      next: { type: 'string', description: 'Cursor continuing the search further back.' },
      errors: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', required: true },
          first: { type: 'string', required: true },
        },
      },
    },
  }, errorValue],
} as const satisfies ValueSpec

export interface ToolError {
  status: 'error'
  code: string
  message: string
}

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
  exclusiveOwner?: string
  allowedUsers?: string[]
}

/** Project an `ImTaskLike` plus optional ACL into the declared tool payload shape. */
export function taskView(task: ImTaskLike, acl?: SessionAclLike): TaskView {
  const exclusiveOwner = acl?.exclusive && acl.owner !== undefined
    ? (acl.owner.name ? `${acl.owner.name} (${acl.owner.id})` : acl.owner.id)
    : undefined
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
    ...exclusiveOwner === undefined ? {} : { exclusiveOwner },
    ...acl?.exclusive ? { allowedUsers: acl.allowedUsers.map(user => user.id) } : {},
  }
}

function enabled(config: DispatchConfig, name: ToolName): boolean {
  return config.tools.main.includes(name) || config.tools.worker.includes(name)
}

function caller(exec: ToolRunContextLike): AgentLike {
  return exec.agent as AgentLike
}

/** Register enabled dispatch tools on the tool registry. */
export function applyTools(tools: ToolsLike, host: DispatchHost, config: DispatchConfig): void {
  const render = (_args: unknown, value: unknown): ContentBlockLike[] => [{ type: 'text', text: JSON.stringify(value) }]
  const mode = {
    type: 'string', enum: ['copy', 'cut'],
    description: 'copy keeps the router\'s own delivery; cut withholds matching messages from the router.',
  } as const

  if (enabled(config, 'router_reply')) {
    tools.register(defineTool<{ text: string; quote?: string; chat?: string; thread?: boolean }>({
      name: 'router_reply',
      description: 'Router only: send a concise markdown reply directly to the user for simple greetings, '
        + 'clarifications, or answers already known from chat/chronicle context. Never call this together with '
        + 'create_task or route_messages_to_task for the same request.',
      parameters: {
        text: { type: 'string', required: true, description: 'Concise markdown message to send.' },
        quote: {
          type: 'string',
          description: 'Message to reply to (`#seq`, platform id, or message key); defaults to the triggering message.',
        },
        chat: {
          type: 'string',
          description: 'Chat key or bare chat id; defaults to the chat of the router session.',
        },
        thread: {
          type: 'boolean',
          description: 'Set true to reply in thread when supported (defaults to false for main-timeline short answers, or matches the trigger thread if already inside a thread).',
        },
      },
      output: { schema: routerReplyOutput, render },
      execute: (args, exec) => run(async () => await host.routerReply(caller(exec), args, exec.callId, exec.signal)),
    }))
  }

  if (enabled(config, 'create_task')) {
    tools.register(defineTool<{ title: string; chat?: string; messages?: string[]; range?: { from: string; to: string } }>({
      name: 'create_task',
      description: 'Start a background task for the messages that carry a request. A new worker session receives those '
        + 'messages in the sender\'s own words, together with surrounding context. In non-direct group chats, replies '
        + 'open a thread on the first request message where follow-ups stay scoped. Returns the task number.',
      parameters: {
        title: { type: 'string', required: true, description: 'Short title of the work, in the sender\'s language.' },
        chat: {
          type: 'string',
          description: 'Chat key (`bot|chat id`) or bare chat id of the arriving context; omit for the current chat.',
        },
        messages: {
          type: 'array',
          items: { type: 'string' },
          description: 'The messages that carry the request, in chronological order: `#12` or platform message ID.',
        },
        range: {
          type: 'object',
          additionalProperties: false,
          description: 'A contiguous run of that chat, both ends included, instead of listing many references.',
          properties: {
            from: { type: 'string', required: true, description: 'First message of the run.' },
            to: { type: 'string', required: true, description: 'Last message of the run.' },
          },
        },
      },
      output: { schema: taskOutput, render },
      execute: (args, exec) => run(async () => taskView(await host.startTask(caller(exec), {
        title: args.title,
        ...args.chat === undefined ? {} : { chat: args.chat },
        ...args.messages === undefined ? {} : { messages: args.messages },
        ...args.range === undefined ? {} : { range: args.range },
        signal: exec.signal,
      }, exec.callId))),
    }))
  }

  if (enabled(config, 'route_messages_to_task')) {
    tools.register(defineTool<{ id: number; messages: { chat?: string; message: string }[] }>({
      name: 'route_messages_to_task',
      description: 'Deliver messages to an existing task (in this chat or another chat for cross-group continuity). '
        + 'Its worker receives each message and gains read+reply access in that chat/thread. Deduplicated by message key.',
      parameters: {
        id: { type: 'integer', required: true, description: 'Task number from create_task, list_tasks, or <tasks-snapshot>/<tasks-delta>.' },
        messages: {
          type: 'array',
          required: true,
          description: 'Messages to deliver, in order.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              chat: {
                type: 'string',
                description: 'Chat key or bare chat id; omit for the current chat.',
              },
              message: {
                type: 'string', required: true,
                description: '`#12` as the arriving context numbers it, a platform message ID, or a message key.',
              },
            },
          },
        },
      },
      output: { schema: routedOutput, render },
      execute: (args, exec) => run(async () => {
        const routed = await host.routeToTask(caller(exec), args.id, args.messages)
        return { task: taskView(routed.task), messages: routed.messages.map(messageView) }
      }),
    }))
  }

  if (enabled(config, 'steer_task')) {
    tools.register(defineTool<{ id: number; text: string; chat?: string }>({
      name: 'steer_task',
      description: 'Router only: send synthesized instructions or follow-up guidance to an existing task worker '
        + '(local or cross-chat). Optionally grants access to `chat` if steering from another group.',
      parameters: {
        id: { type: 'integer', required: true, description: 'Task number to steer.' },
        text: { type: 'string', required: true, description: 'Synthesized context and instructions for the worker.' },
        chat: { type: 'string', description: 'Optional chat key or bare id to grant the worker access to.' },
      },
      output: { schema: taskOutput, render },
      execute: (args, exec) => run(async () => taskView(
        await host.steerTask(caller(exec), args.id, args.text, args.chat, exec.callId),
        host.aclOfSession(host.tasks.get(args.id)?.session ?? ''),
      )),
    }))
  }

  if (enabled(config, 'list_tasks')) {
    tools.register(defineTool<Record<string, never>>({
      name: 'list_tasks',
      description: 'List background tasks across this deployment, newest first, including descriptions, '
        + 'wantedTopics, latest notes, and thread-follow flags.',
      parameters: {},
      output: { schema: taskListOutput, render },
      isConcurrencySafe: () => true,
      execute: (_args, exec) => run(async () => ({
        tasks: (await host.listTasks(caller(exec))).map(task => taskView(task, host.aclOfSession(task.session))),
      })),
    }))
  }

  if (enabled(config, 'configure_chat')) {
    tools.register(defineTool<ConfigureChatRequest>({
      name: 'configure_chat',
      description: 'Configure how the router wakes and replies on unaddressed messages in the current chat '
        + '(wakeMode controls router wake triggers; replyMode controls whether proactive router_reply is allowed). '
        + 'Always confirm clear policy intent with the user before enabling proactive replies or auto wake.',
      parameters: {
        chat: { type: 'string', description: 'Chat key or bare chat id. Defaults to the current chat.' },
        wakeMode: {
          type: 'string',
          enum: ['mention', 'watch', 'auto'],
          description: "Router wake policy for unaddressed messages: 'mention' (default: only @bot/reply wakes router), "
            + "'watch' (debounced wake when replyMode='proactive', watchTopics/watchNote/replyPolicy exist, "
            + "or a task with wantedTopics applies here), or 'auto' (debounced wake on every unaddressed group message).",
        },
        replyMode: {
          type: 'string',
          enum: ['mention_only', 'proactive'],
          description: "Whether router_reply is permitted during unaddressed ambient wakes: 'mention_only' (default, "
            + "only silent task dispatching allowed) or 'proactive' (allows router_reply within hourly cap).",
        },
        watchTopics: {
          type: 'array',
          items: { type: 'string' },
          description: 'Group-level keywords/alert topics monitored in watch mode; pass [] to clear.',
        },
        watchNote: {
          type: 'string',
          description: 'Group-level rule describing what unaddressed messages should trigger action; pass "" to clear.',
        },
        replyPolicy: {
          type: 'string',
          description: 'When proactive replies should happen (e.g. only on specific technical discussions); pass "" to clear.',
        },
      },
      output: { schema: chatConfigOutput, render },
      isConcurrencySafe: () => false,
      execute: (args, exec) => run(async () => await host.configureChat(caller(exec), args)),
    }))
  }

  if (enabled(config, 'query_chronicle')) {
    tools.register(defineTool<{ question: string; chat?: string }>({
      name: 'query_chronicle',
      description: 'Query the global prefix-cached Chronicle log (past tasks, cross-group discussions, and real bot '
        + 'replies compacted with #id) without adding noise to the Chronicle or your conversation log.',
      parameters: {
        question: {
          type: 'string', required: true,
          description: 'Specific question naming the person, repo, topic, group, or event to recall.',
        },
        chat: {
          type: 'string',
          description: 'Optional chat key hint to prioritize.',
        },
      },
      output: { schema: chronicleOutput, render },
      isConcurrencySafe: () => true,
      execute: (args, exec) => run(async () => await host.queryChronicle(caller(exec), args, exec.signal)),
    }))
  }

  if (enabled(config, 'add_route_rule')) {
    tools.register(defineTool<{ match?: string; mode: RouteRuleMode; note?: string }>({
      name: 'add_route_rule',
      description: 'Subscribe your task to later messages of the chats you read: each admitted message that the '
        + 'expression matches is delivered to you. Unaddressed messages in your own reply thread already auto-deliver '
        + 'when followThread is enabled; use rules for main-timeline streams or `cut` rules. ' + RULE_FIELDS,
      parameters: {
        match: {
          type: 'string',
          description: 'JavaScript expression over im; omit to match every message of your chats. '
            + 'Never match im.at_me across a whole group chat without scoping it to your own im.thread_id/im.root_id.',
        },
        mode: { ...mode, required: true },
        note: { type: 'string', description: 'Why the task needs these messages, shown to the router.' },
      },
      output: { schema: ruleOutput, render },
      execute: (args, exec) => run(async () => await host.addRule(caller(exec), {
        mode: args.mode,
        ...args.match === undefined ? {} : { match: args.match },
        ...args.note === undefined ? {} : { note: args.note },
      })),
    }))
  }

  if (enabled(config, 'update_route_rule')) {
    tools.register(defineTool<{ id: number; match?: string; mode?: RouteRuleMode; note?: string }>({
      name: 'update_route_rule',
      description: 'Replace the expression, mode or note of one route rule of your task.',
      parameters: {
        id: { type: 'integer', required: true, description: 'Rule ID from add_route_rule or list_route_rules.' },
        match: {
          type: 'string',
          description: 'New JavaScript expression over im. Never match im.at_me across a whole group chat without '
            + 'scoping it to your own im.thread_id/im.root_id.',
        },
        mode,
        note: { type: 'string', description: 'Why the task needs these messages, shown to the router.' },
      },
      output: { schema: ruleOutput, render },
      execute: (args, exec) => run(async () => await host.updateRule(caller(exec), args.id, {
        ...args.match === undefined ? {} : { match: args.match },
        ...args.mode === undefined ? {} : { mode: args.mode },
        ...args.note === undefined ? {} : { note: args.note },
      })),
    }))
  }

  if (enabled(config, 'list_route_rules')) {
    tools.register(defineTool<Record<string, never>>({
      name: 'list_route_rules',
      description: 'List route rules: routers see every rule, a task worker sees its own task\'s rules.',
      parameters: {},
      output: { schema: ruleListOutput, render },
      isConcurrencySafe: () => true,
      execute: (_args, exec) => run(async () => ({ rules: await host.listRules(caller(exec)) })),
    }))
  }

  if (enabled(config, 'remove_route_rule')) {
    tools.register(defineTool<{ id: number }>({
      name: 'remove_route_rule',
      description: 'Remove one route rule: a task worker removes a rule of its own task and a router any rule.',
      parameters: {
        id: { type: 'integer', required: true, description: 'Rule ID from list_route_rules.' },
      },
      output: { schema: ruleOutput, render },
      execute: (args, exec) => run(async () => await host.removeRule(caller(exec), args.id)),
    }))
  }

  if (enabled(config, 'im_search')) {
    tools.register(defineTool<{ match: string; pages: number; cursor?: string; chat?: string }>({
      name: 'im_search',
      description: 'Search the history of an IM chat you can read, newest first, for the messages one route-rule '
        + 'expression matches. Pass next as cursor to continue further back. ' + RULE_FIELDS,
      parameters: {
        match: { type: 'string', required: true, description: 'JavaScript expression over im; a truthy result matches.' },
        pages: { type: 'integer', required: true, description: 'History pages to read, from 1 to the operator\'s limit.' },
        cursor: {
          type: 'string',
          description: 'Cursor returned as next by the previous search; omit to start at the newest message.',
        },
        chat: { type: 'string', description: 'Chat key from arriving context; omit to use the chat of the current turn.' },
      },
      output: { schema: searchOutput, render },
      execute: (args, exec) => run(async () => await host.search(caller(exec), {
        match: args.match,
        pages: args.pages,
        ...args.cursor === undefined ? {} : { cursor: args.cursor },
        ...args.chat === undefined ? {} : { chat: args.chat },
      }, exec.signal)),
    }))
  }
}

async function run<T extends object>(operation: () => Promise<T>): Promise<T | ToolError> {
  try {
    return await operation()
  } catch (error) {
    if (isImError(error)) return { status: 'error', code: error.code, message: error.message }
    throw error
  }
}
