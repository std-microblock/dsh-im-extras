/**
 * Collaborator access-control tools for task sessions (`grant_session_access`, `revoke_session_access`, `get_session_access`).
 *
 * Activated exclusively on task worker sessions via `when: ({ agent }) => host.isTaskAgent(agent)`.
 *
 * @module dsh-im-session-auth/tools
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ImError } from '@deepseek-ai/dsh-im'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  defineTool, type ParameterSchemaSpec, type ToolActivationContext, type ValueSchemaSpec,
} from '@deepseek-ai/dsh-tools'
import type { SessionAclView } from './api.ts'
import type { SessionAuthHost } from './host.ts'

const errorValue = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', const: 'error', required: true },
    code: { type: 'string', required: true },
    message: { type: 'string', required: true },
  },
} as const satisfies ValueSchemaSpec

const userValue = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    name: { type: 'string' },
  },
} as const satisfies ValueSchemaSpec

const allowedUserValue = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    name: { type: 'string' },
    addedBy: { type: 'string' },
    addedAt: { type: 'integer', required: true },
  },
} as const satisfies ValueSchemaSpec

const grantViewValue = {
  type: 'object',
  additionalProperties: false,
  properties: {
    capabilityId: { type: 'string', required: true },
    title: { type: 'string', required: true },
    status: { type: 'string', enum: ['pending', 'active', 'reauth_required', 'revoked'], required: true },
    grantor: { ...userValue, required: true },
    statusMessage: { type: 'string' },
    updatedAt: { type: 'integer', required: true },
  },
} as const satisfies ValueSchemaSpec

const aclValue = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sessionId: { type: 'string', required: true },
    exclusive: { type: 'boolean', required: true },
    owner: userValue,
    allowedUsers: { type: 'array', items: allowedUserValue, required: true },
    grants: { type: 'array', items: grantViewValue, required: true },
  },
} as const satisfies ValueSchemaSpec

const aclOutput = { oneOf: [aclValue, errorValue] } as const satisfies ValueSchemaSpec

/** Tool names registered by `dsh-im-session-auth`. */
export const AUTH_TOOLS = ['grant_session_access', 'revoke_session_access', 'get_session_access'] as const

/**
 * Register the session access management tools on `tools`.
 * @param tools - harness tool registry.
 * @param host - session auth host.
 * @returns disposer unregistering all tools.
 */
export function applyTools(tools: Context['tools'], host: SessionAuthHost): () => void {
  const render = (_args: unknown, value: unknown): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value) }]
  const whenTask = ({ agent }: ToolActivationContext): boolean => host.isTaskAgent(agent)
  const disposers: (() => void)[] = []

  disposers.push(tools.register(defineTool({
    name: 'grant_session_access',
    description: 'Grant one or more users interactive access to this exclusive task session (and share its active '
      + 'capabilities with them). Only callable during a turn triggered by an already-authorized human member '
      + '(or the requester if the session is not exclusive yet, which also claims exclusivity for them). '
      + 'Pass each user\'s platform user id (from message mentions or im_members).',
    parameters: {
      users: {
        type: 'array',
        required: true,
        description: 'Users to authorize for this session.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: 'Platform user id, as message mentions and im_members report it.' },
            name: { type: 'string', description: 'Optional display name.' },
          },
        },
      },
    } satisfies ParameterSchemaSpec,
    output: { schema: aclOutput, render },
    execute: (args, exec) => run(() => host.grantUsers(exec.agent, args.users)),
  }), { when: whenTask }))

  disposers.push(tools.register(defineTool({
    name: 'revoke_session_access',
    description: 'Remove one or more collaborators from this exclusive task session. The session owner cannot be removed.',
    parameters: {
      userIds: {
        type: 'array',
        required: true,
        description: 'Platform user ids of the collaborators to remove.',
        items: { type: 'string' },
      },
    } satisfies ParameterSchemaSpec,
    output: { schema: aclOutput, render },
    execute: (args, exec) => run(() => host.revokeUsers(exec.agent, args.userIds)),
  }), { when: whenTask }))

  disposers.push(tools.register(defineTool({
    name: 'get_session_access',
    description: 'Inspect the current exclusivity owner, allowed collaborators, and capability grants of this session.',
    parameters: {} satisfies ParameterSchemaSpec,
    output: { schema: aclOutput, render },
    isConcurrencySafe: () => true,
    execute: (_args, exec) => run(() => Promise.resolve(host.sessionAccessOf(exec.agent as Agent | undefined))),
  }), { when: whenTask }))

  return () => {
    for (const dispose of disposers) dispose()
  }
}

interface ToolSessionAcl {
  sessionId: string
  exclusive: boolean
  owner?: { id: string; name?: string }
  allowedUsers: { id: string; name?: string; addedBy?: string; addedAt: number }[]
  grants: {
    capabilityId: string
    title: string
    status: 'pending' | 'active' | 'reauth_required' | 'revoked'
    grantor: { id: string; name?: string }
    statusMessage?: string
    updatedAt: number
  }[]
}

async function run(
  operation: () => Promise<SessionAclView>,
): Promise<ToolSessionAcl | { status: 'error'; code: string; message: string }> {
  try {
    const acl = await operation()
    return {
      sessionId: acl.sessionId,
      exclusive: acl.exclusive,
      ...(acl.owner === undefined ? {} : { owner: { ...acl.owner } }),
      allowedUsers: acl.allowedUsers.map(user => ({ ...user })),
      grants: acl.grants.map(grant => ({ ...grant, grantor: { ...grant.grantor } })),
    }
  } catch (error) {
    if (error instanceof ImError) return { status: 'error', code: error.code, message: error.message }
    throw error
  }
}
