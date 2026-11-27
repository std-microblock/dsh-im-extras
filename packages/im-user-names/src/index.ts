/**
 * `dsh-im-user-names`: standalone Cordis plugin that resolves and caches IM user display names (for example Feishu
 * `open_id` → `Name(open_id)`) across inbound messages, quotes, reactions, and card interactions without modifying
 * `dsh-im` or platform adapters.
 *
 * Exposes `ctx.imUserNames` so sibling plugins can query cached or live-resolved display names when needed.
 *
 * @module dsh-im-user-names
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/cordis-plugin-im-core'
import type { ImMessage, ImMessageEvent, ImOutcome } from '@deepseek-ai/dsh-im'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { Config } from './config.ts'
import { imUserNamesDomain, userCacheKey, type ImUserNamesDomain, type StoredUserName, type UserNameSource } from './domain.ts'
import { formatUserName, isPermissionError, isUsableName, stripIdSuffix } from './format.ts'
import { ImUserNamesHost, type ImHostLike, type ResolveUserOptions } from './service.ts'

export { Config }
export { imUserNamesDomain, userCacheKey, type ImUserNamesDomain, type StoredUserName, type UserNameSource }
export { formatUserName, isPermissionError, isUsableName, stripIdSuffix }
export { ImUserNamesHost, type ImHostLike, type ResolveUserOptions }

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** IM user display-name resolver and durable cache (`dsh-im-user-names`). */
    imUserNames: ImUserNamesService
  }
}

/** Single-process user-name resolution and enrichment service provided as `ctx.imUserNames`. */
export class ImUserNamesService extends Service {
  static inject = ['im', 'storageDomain']
  static Config = Config

  readonly host: ImUserNamesHost
  private readonly home: Context

  constructor(ctx: Context, readonly config: Config) {
    super(ctx, 'imUserNames')
    this.home = ctx
    this.host = new ImUserNamesHost({
      im: ctx.im,
      storage: ctx.storageDomain,
      logger: ctx.logger('im-user-names'),
      config,
    })
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void>, void> {
    await this.host.open()
    if (this.config.enabled) {
      // Register with `prepend: true` after open() so enrichment runs ahead of `im-session-commands`,
      // `im-session-auth`, and `im-dispatch` on `im/message`, and ahead of downstream observers on `im/stored`
      // and `satori/receive`.
      this.home.on(
        'im/message',
        (event: ImMessageEvent, next: () => Promise<ImOutcome>) => this.host.handleMessage(event, next),
        { prepend: true },
      )
      this.home.on(
        'im/stored',
        (message: ImMessage) => { this.host.onStored(message) },
        { prepend: true },
      )
      this.home.on(
        'satori/receive',
        (session: Session) => this.host.onReceive(session),
        { prepend: true },
      )
    }
    yield async () => { await this.host.dispose() }
  }

  /** Synchronous pure display-name lookup (`Name`), or `undefined` when unknown. */
  lookup(botId: string, userId: string): string | undefined {
    return this.host.lookup(botId, userId)
  }

  /** Synchronous formatted display label (`Name(userId)` or `Name`), or `undefined` when unknown. */
  format(botId: string, userId: string): string | undefined {
    return this.host.format(botId, userId)
  }

  /** Record a display name into the memory and durable caches. */
  remember(botId: string, userId: string, name: string, source: UserNameSource = 'sender'): void {
    this.host.remember(botId, userId, name, source)
  }

  /** Resolve a user's pure display name (aliases → cache → chat roster sync → optional contact lookup). */
  resolve(botId: string, userId: string, options?: ResolveUserOptions): Promise<string | undefined> {
    return this.host.resolve(botId, userId, options)
  }
}

export default ImUserNamesService
