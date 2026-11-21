/**
 * `dsh-im-session-auth`: session exclusivity, collaborator delegation, and capability grants (`ctx.imAuth`).
 *
 * @module dsh-im-session-auth
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-im'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {
  CapabilityProvider, ImSessionAuth, RequestCapabilitiesInput, RequestCapabilitiesResult,
  SessionAclView, SessionAuthConfig, SessionGrantRecord,
} from './api.ts'
import { Config } from './config.ts'
import { SessionAuthHost } from './host.ts'

export * from './api.ts'
export { Config } from './config.ts'
export { grantKey, imSessionAuthDomain, type ImSessionAuthDomain } from './domain.ts'
export { SessionAuthHost, type ImCardsLike } from './host.ts'
export { AUTH_TOOLS, applyTools } from './tools.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Session exclusivity, collaborator access control, and capability grant host. */
    imAuth: ImSessionAuthService
  }
}

/** Single-process session auth service provided as `ctx.imAuth`. */
export class ImSessionAuthService extends Service implements ImSessionAuth {
  static inject = ['im', 'storageDomain']
  static Config = Config

  readonly host: SessionAuthHost
  private readonly home: Context

  constructor(ctx: Context, readonly config: SessionAuthConfig) {
    super(ctx, 'imAuth')
    this.home = ctx
    this.host = new SessionAuthHost(ctx, ctx.im, config)
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void>, void> {
    await this.host.open()
    // Register with `prepend: true` after open() so we sit ahead of `im-session-commands` in the waterfall.
    this.home.on('im/message', (event, next) => this.host.handleCommandMessage(event, next), { prepend: true })
    yield async () => { await this.host.dispose() }
  }

  registerProvider(provider: CapabilityProvider): () => void {
    return this.host.registerProvider(provider)
  }

  isExclusive(sessionId: string): boolean {
    return this.host.isExclusive(sessionId)
  }

  canInteract(sessionId: string, userId: string): boolean {
    return this.host.canInteract(sessionId, userId)
  }

  aclOf(sessionId: string): SessionAclView | undefined {
    return this.host.aclOf(sessionId)
  }

  listAcls(): SessionAclView[] {
    return this.host.listAcls()
  }

  grantFor(sessionId: string, capabilityId: string): SessionGrantRecord | undefined {
    return this.host.grantFor(sessionId, capabilityId)
  }

  requestCapabilities(request: RequestCapabilitiesInput): Promise<RequestCapabilitiesResult> {
    return this.host.requestCapabilities(request)
  }

  revokeUserCapability(capabilityId: string, userId: string, reason: string): Promise<number> {
    return this.host.revokeUserCapability(capabilityId, userId, reason)
  }

  notifyUserReauthenticated(capabilityId: string, userId: string): Promise<number> {
    return this.host.notifyUserReauthenticated(capabilityId, userId)
  }

  operatorUnlock(sessionId: string): Promise<boolean> {
    return this.host.operatorUnlock(sessionId)
  }
}

export default ImSessionAuthService
