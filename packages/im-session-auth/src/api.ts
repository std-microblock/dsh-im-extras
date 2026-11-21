/**
 * Public contract of `dsh-im-session-auth`: session exclusivity, collaborator delegation,
 * and extensible capability grants (`ctx.imAuth`).
 *
 * @module dsh-im-session-auth/api
 */
import type { ImChatKey, ImMessageKey } from '@deepseek-ai/dsh-im'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/** Platform user identity as stored and displayed by session auth. */
export interface SessionUser {
  id: string
  name?: string
}

/** One entry in an exclusive session's allowlist. */
export interface AllowedUser extends SessionUser {
  addedBy?: string
  addedAt: number
}

/** Lifecycle status of one capability grant on a session. */
export type GrantStatus = 'pending' | 'active' | 'reauth_required' | 'revoked'

/** Durable exclusivity record of one hosted session. */
export interface SessionAuthRecord {
  sessionId: SessionId
  exclusive: boolean
  owner?: SessionUser
  allowedUsers: AllowedUser[]
  createdAt: number
  updatedAt: number
}

/** Durable capability grant record keyed by `${sessionId}\u0000${capabilityId}`. */
export interface SessionGrantRecord {
  key: string
  sessionId: SessionId
  capabilityId: string
  status: GrantStatus
  grantor: SessionUser
  chat?: ImChatKey
  cardId?: string
  cardMessage?: ImMessageKey
  statusMessage?: string
  meta?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

/** Read-only grant summary returned by {@link SessionAclView}. */
export interface SessionGrantView {
  capabilityId: string
  title: string
  status: GrantStatus
  grantor: SessionUser
  statusMessage?: string
  updatedAt: number
}

/** Read-only ACL + capability snapshot of one hosted session. */
export interface SessionAclView {
  sessionId: SessionId
  exclusive: boolean
  owner?: SessionUser
  allowedUsers: readonly AllowedUser[]
  grants: readonly SessionGrantView[]
}

/** Context handed to {@link CapabilityProvider.acquire}. */
export interface CapabilityAcquireContext {
  sessionId: SessionId
  grantor: SessionUser
  chat: ImChatKey
  cardId: string
  reason?: string
  /** Settle an asynchronous acquisition (e.g., DM login completion or expiry). */
  complete(result: { ok: true; message?: string; meta?: Record<string, unknown> } | { ok: false; error: string }): Promise<void>
}

/** Initial result returned by {@link CapabilityProvider.acquire}. */
export type AcquireOutcome =
  | { status: 'granted'; message?: string; meta?: Record<string, unknown> }
  | { status: 'pending'; message?: string; meta?: Record<string, unknown> }
  | { status: 'failed'; error: string }

/** Result of {@link CapabilityProvider.ensureReady} before a model step runs. */
export type EnsureReadyOutcome =
  | { status: 'ready'; meta?: Record<string, unknown> }
  | { status: 'reauth_required'; message: string }
  | { status: 'revoked'; message: string }

/** Environment variables a capability injects into commands of an authorized session. */
export interface CapabilityExecEnv {
  readonly variables: Readonly<Record<string, { description: string }>>
  /** Resolve environment variable values synchronously from cached capability state. */
  resolve(grant: SessionGrantRecord, agent: unknown): Readonly<Record<string, string | undefined>>
}

/** Context handed to {@link CapabilityProvider.tryAutoAcquire} for silent non-interactive authorization. */
export interface CapabilityAutoAcquireContext {
  sessionId: SessionId
  grantor: SessionUser
  chat: ImChatKey
  reason?: string
}

/** One capability that was silently auto-granted without prompting the user. */
export interface AutoGrantedCapability {
  id: string
  title: string
  grantor: SessionUser
}

/** Extension interface implemented by capability plugins (credentials, approvals, resource leases, etc.). */
export interface CapabilityProvider {
  readonly id: string
  readonly title: string
  readonly description: string
  /** Guidance added to task worker system prompt before this capability is granted. */
  readonly requestGuidance?: string
  /** Guidance added to task worker system prompt while this capability is active on the session. */
  readonly activeGuidance?: string
  /** Optional command environment contribution active while the grant is `'active'`. */
  readonly execEnv?: CapabilityExecEnv
  /** Optional global tools gated to sessions holding an `'active'` grant of this capability. */
  readonly tools?: readonly ToolDefinition[]
  /** Acquire or initiate acquisition of this capability for a session on behalf of `grantor`. */
  acquire(context: CapabilityAcquireContext): AcquireOutcome | Promise<AcquireOutcome>
  /**
   * Optional silent acquisition when a user explicitly invokes a `/skill` that declares this capability.
   * Must NOT send interactive login prompts/DMs; return `{ status: 'granted' }` only when valid (or silently
   * refreshable) credentials already exist for `grantor`, otherwise return `undefined`.
   */
  tryAutoAcquire?(
    context: CapabilityAutoAcquireContext,
  ): { status: 'granted'; message?: string; meta?: Record<string, unknown> } | undefined
    | Promise<{ status: 'granted'; message?: string; meta?: Record<string, unknown> } | undefined>
  /** Optional step-time readiness check / silent token refresh (`agent/pre-step`). */
  ensureReady?(grant: SessionGrantRecord, signal: AbortSignal): EnsureReadyOutcome | Promise<EnsureReadyOutcome>
  /** Optional hook called when a grant is revoked or unlocked. */
  onRevoke?(grant: SessionGrantRecord, reason: string): void | Promise<void>
}

/** Operator configuration of `dsh-im-session-auth`. */
export interface SessionAuthConfig {
  /** Throttle window in milliseconds for refusal notices on repeated unauthorized `@bot` pings. */
  refusalThrottleMs: number
}

/** Input to {@link ImSessionAuth.requestCapabilities} for proactively posting an `<AuthRequest />` card. */
export interface RequestCapabilitiesInput {
  sessionId: string
  chat: ImChatKey
  capabilities: readonly string[]
  reason?: string
  title?: string
  quote?: ImMessageKey
  thread?: string
  operationId?: string
  requester?: SessionUser
}

/** Outcome of {@link ImSessionAuth.requestCapabilities}. */
export type RequestCapabilitiesResult =
  | {
    ok: true
    alreadyActive?: true
    autoGranted?: AutoGrantedCapability[]
    cardId?: string
    message?: ImMessageKey
  }
  | { ok: false; error: string }

/** Public surface of `ctx.imAuth`. */
export interface ImSessionAuth {
  registerProvider(provider: CapabilityProvider): () => void
  isExclusive(sessionId: string): boolean
  canInteract(sessionId: string, userId: string): boolean
  aclOf(sessionId: string): SessionAclView | undefined
  listAcls(): SessionAclView[]
  grantFor(sessionId: string, capabilityId: string): SessionGrantRecord | undefined
  requestCapabilities(request: RequestCapabilitiesInput): Promise<RequestCapabilitiesResult>
  revokeUserCapability(capabilityId: string, userId: string, reason: string): Promise<number>
  notifyUserReauthenticated(capabilityId: string, userId: string): Promise<number>
  operatorUnlock(sessionId: string): Promise<boolean>
}
