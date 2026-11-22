/** Shared fakes: a routed QQ REST transport, the adapter's error shape, QQ bots and `im/message` events. */
import type { QqRequest } from '../src/api.ts'
import type { MessageEventLike, MessageLike, QqBotLike } from '../src/host.ts'

/** One recorded request. */
export interface Call { method: string; path: string; data: unknown }

type Handler = unknown | ((request: { data: unknown; query: URLSearchParams; path: string }) => unknown)

/** The adapter's `QqApiError` shape: status, numeric code and decoded body. */
export class PlatformError extends Error {
  readonly status: number | undefined
  readonly code: number | undefined
  readonly body: unknown
  constructor(message: string, init: { status?: number; code?: number; body?: unknown } = {}) {
    super(message)
    this.status = init.status
    this.code = init.code
    this.body = init.body
  }
}

/**
 * A transport answering from `"<METHOD> <path without query>"` routes; an unknown route answers 404, a handler may
 * throw to simulate a platform failure.
 */
export function fakeRequest(routes: Record<string, Handler>): QqRequest & { calls: Call[]; routes: Record<string, Handler> } {
  const calls: Call[] = []
  const request = (async (method: string, path: string, data?: unknown) => {
    calls.push({ method, path, data })
    const [route = '', search = ''] = path.split('?')
    const key = `${method} ${route}`
    if (!(key in request.routes)) {
      throw new PlatformError(`unexpected ${key}`, { status: 404, body: { err_code: 40400000, message: 'not found' } })
    }
    const handler = request.routes[key]
    return typeof handler === 'function'
      ? (handler as (input: { data: unknown; query: URLSearchParams; path: string }) => unknown)({ data, query: new URLSearchParams(search), path })
      : handler
  }) as QqRequest & { calls: Call[]; routes: Record<string, Handler> }
  request.calls = calls
  request.routes = routes
  return request
}

/** A QQ adapter bot whose `api.request` goes to a fake transport. */
export function fakeBot(request: QqRequest, id = 'qq:app', status = 1): QqBotLike & { status: number } {
  return {
    id,
    platform: 'qq',
    status,
    api: { request: (method, path, options) => request(method, path, options?.data) },
  }
}

/** A minimal `im/message` event recording its replies. */
export function fakeEvent(text: string, patch: Partial<MessageLike> = {}, bot: unknown = undefined, fail: (content: unknown, index: number) => boolean = () => false): MessageEventLike & { replies: unknown[] } {
  const replies: unknown[] = []
  const message: MessageLike = {
    key: 'qq:app|m1',
    text,
    addressed: true,
    chat: { key: 'qq:app|group:GROUP_OPENID', bot: 'qq:app', ref: { id: 'group:GROUP_OPENID', type: 'group' } },
    sender: { id: 'ADMIN_OPENID' },
    ...patch,
  }
  return {
    message,
    bot,
    replies,
    async reply(content) {
      replies.push(content)
      return { status: fail(content, replies.length - 1) ? 'failed' : 'confirmed' }
    },
  }
}

/** The text of an element tree (or string). */
export function textOf(content: unknown): string {
  const out: string[] = []
  const walk = (node: unknown): void => {
    if (node === undefined || node === null) return
    if (typeof node === 'string') { out.push(node); return }
    if (Array.isArray(node)) { node.forEach(walk); return }
    const element = node as { type?: string; attrs?: Record<string, unknown>; children?: unknown[] }
    if (element.type === 'text') out.push(String(element.attrs?.content ?? ''))
    for (const child of element.children ?? []) walk(child)
    if (element.type === 'p') out.push('\n')
  }
  walk(content)
  return out.join('')
}

/** Every element of a tree with the given type. */
export function elements(content: unknown, type: string): { type: string; attrs: Record<string, unknown> }[] {
  const out: { type: string; attrs: Record<string, unknown> }[] = []
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    const element = node as { type: string; attrs: Record<string, unknown>; children?: unknown[] }
    if (element.type === type) out.push(element)
    for (const child of element.children ?? []) walk(child)
  }
  walk(content)
  return out
}

/** A logger recording its lines. */
export function fakeLogger(): { info(...args: unknown[]): void; warn(...args: unknown[]): void; lines: [string, unknown[]][] } {
  const lines: [string, unknown[]][] = []
  return {
    lines,
    info: (...args: unknown[]) => { lines.push(['info', args]) },
    warn: (...args: unknown[]) => { lines.push(['warn', args]) },
  }
}
