/**
 * `dsh-im-panel` — an operator panel for the DeepSeek Harness IM host, drawn as a page of the harness web GUI, with a
 * tab API other plugins extend.
 *
 * The host half provides `ctx.imPanel` ({@link ImPanelService}) and answers the panel's routes on the GUI's
 * authenticated `/api` channel (the `connection` service): the snapshot and commands of the built-in tabs, the
 * chronicle browser, and one route that dispatches to every extension tab. The browser half (`./client`) draws the
 * page and provides the client `imPanel` service extension tabs register their components with.
 *
 * @module dsh-im-panel
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import {
  chroniclePage, commandOf, run, snapshot, type PanelAuth, type PanelDispatch, type PanelIm, type PanelServices,
  type PanelTasks,
} from './core.ts'
import {
  BUILTIN_TABS, CHRONICLE_PATH, PANEL_PATH, TAB_ID, TAB_PATH, type ImPanelResult, type ImPanelState,
  type ImPanelTabDefinition, type ImPanelTabInfo,
} from './protocol.ts'

export * from './protocol.ts'
export { chroniclePage, commandOf, run, snapshot } from './core.ts'
export type { PanelAuth, PanelDispatch, PanelIm, PanelServices, PanelTaskLike, PanelTasks } from './core.ts'

/** Plugin identity. */
export const name = 'im-panel'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The IM operator panel: register extension tabs, read the deployment snapshot. */
    imPanel: ImPanelService
  }
  interface Events {
    /**
     * An extension tab's `command` handler (or a `POST` through its `fetch` handler that answered 2xx) ran.
     * @param tab - the tab id.
     * @param path - the sub path.
     * @param body - the parsed JSON body, `undefined` for a non-JSON request.
     */
    'im-panel/command'(tab: string, path: string, body: unknown): void
  }
}

/** The slice of the Connection carrier the panel registers its routes on. */
interface PanelConnection {
  readonly fetch?: {
    register(route: {
      readonly path: string
      readonly methods: readonly ('GET' | 'HEAD' | 'POST')[]
      readonly requestBody: 'buffered' | 'streaming'
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

/**
 * One JSON answer.
 * @param status - HTTP status.
 * @param body - value to serialize (`undefined` becomes `null`).
 */
function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body ?? null), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The panel as a service (`ctx.imPanel`). */
export class ImPanelService extends Service {
  private readonly home: Context
  private readonly registry = new Map<string, ImPanelTabDefinition>()

  constructor(ctx: Context) {
    super(ctx, 'imPanel')
    this.home = ctx
    ctx.inject(['connection'], (scoped) => { this.mount(scoped) })
  }

  /**
   * Register one extension tab's host half. Removed when the calling plugin unloads, or with the returned disposer.
   * @param definition - id, title, order, badge and the data handlers.
   * @returns the disposer.
   * @throws {Error} for an invalid, reserved or already registered id.
   */
  tab(definition: ImPanelTabDefinition): () => void {
    const { id } = definition
    if (!TAB_ID.test(id)) throw new Error(`im-panel: tab id ${JSON.stringify(id)} must match ${String(TAB_ID)}`)
    if ((BUILTIN_TABS as readonly string[]).includes(id)) throw new Error(`im-panel: tab id ${id} is reserved`)
    if (this.registry.has(id)) throw new Error(`im-panel: tab ${id} is already registered`)
    this.registry.set(id, definition)
    let done = false
    const dispose = (): void => {
      if (done) return
      done = true
      if (this.registry.get(id) === definition) this.registry.delete(id)
    }
    // Service methods run with `this.ctx` bound to the calling plugin's context, so the tab leaves with it.
    try {
      this.ctx.effect(() => dispose, `im-panel: tab ${id}`)
    } catch { /* a caller without a fiber keeps the explicit disposer */ }
    return dispose
  }

  /** The registered host tabs, in navigation order. */
  tabs(): ImPanelTabInfo[] {
    return [...this.registry.values()].map((tab) => {
      let badge: number | undefined
      try {
        badge = tab.badge?.()
      } catch { /* a failing badge shows none */ }
      return {
        id: tab.id,
        title: tab.title,
        order: tab.order ?? 100,
        ...typeof badge === 'number' && Number.isFinite(badge) ? { badge } : {},
      }
    }).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  }

  /** The same snapshot the overview draws. */
  snapshot(): Promise<ImPanelState> {
    return snapshot(this.services(), this.tabs())
  }

  /**
   * Answer one request of the panel API (exposed for tests and for hosts that route it themselves).
   * @param request - an admitted request below {@link PANEL_PATH}.
   */
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const logger = this.home.logger('im-panel')
    try {
      if (url.pathname === TAB_PATH) return await this.handleTab(request, url)
      if (url.pathname === CHRONICLE_PATH) {
        return request.method === 'GET'
          ? answer(200, await chroniclePage(this.services(), url.searchParams))
          : answer(405, { ok: false, text: '跨群日志只读' })
      }
      if (request.method === 'GET' || request.method === 'HEAD') return answer(200, await this.snapshot())
      if (request.method !== 'POST') return answer(405, { ok: false, text: '不支持的请求方法' })
      const body: unknown = await request.json().catch(() => { throw new Error('请求体不是 JSON') })
      const command = commandOf(body)
      try {
        return answer(200, await run(this.services(), command))
      } catch (error: unknown) {
        logger.warn('im-panel: command %s failed: %s', command.action, reason(error))
        return answer(200, { ok: false, text: reason(error) } satisfies ImPanelResult)
      }
    } catch (error: unknown) {
      logger.warn('im-panel: a request failed: %s', reason(error))
      return answer(400, { ok: false, text: reason(error) })
    }
  }

  private async handleTab(request: Request, url: URL): Promise<Response> {
    const id = url.searchParams.get('id') ?? ''
    const tab = this.registry.get(id)
    if (tab === undefined) return answer(404, { ok: false, text: `没有 ${id} 这个面板页` })
    const path = url.searchParams.get('path') ?? ''
    const query = new URLSearchParams(url.searchParams)
    query.delete('id')
    query.delete('path')
    if (tab.fetch !== undefined) {
      const response = await tab.fetch(request, { path, query })
      if (request.method === 'POST' && response.ok) this.home.emit('im-panel/command', id, path, undefined)
      return response
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      if (tab.read === undefined) return answer(405, { ok: false, text: `面板页 ${id} 不提供读取` })
      try {
        return answer(200, await tab.read({ path, query, request }))
      } catch (error: unknown) {
        return answer(400, { ok: false, text: reason(error) })
      }
    }
    if (request.method !== 'POST' || tab.command === undefined) {
      return answer(405, { ok: false, text: `面板页 ${id} 不接受这个请求` })
    }
    const body: unknown = await request.json().catch(() => { throw new Error('请求体不是 JSON') })
    try {
      const result = await tab.command({ path, query, request, body })
      this.home.emit('im-panel/command', id, path, body)
      return answer(200, result)
    } catch (error: unknown) {
      this.home.logger('im-panel').warn('im-panel: tab %s command failed: %s', id, reason(error))
      return answer(200, { ok: false, text: reason(error) } satisfies ImPanelResult)
    }
  }

  private services(): PanelServices {
    const ctx = this.home
    return {
      im: ctx.get('im') as PanelIm | undefined,
      tasks: ctx.get('imTasks') as PanelTasks | undefined,
      auth: ctx.get('imAuth') as PanelAuth | undefined,
      dispatch: ctx.get('imDispatch') as PanelDispatch | undefined,
    }
  }

  private mount(scoped: Context): void {
    const logger = this.home.logger('im-panel')
    const registry = (scoped.get('connection') as PanelConnection | undefined)?.fetch
    if (registry === undefined) {
      logger.info('im-panel: this harness registers no exact Fetch routes; the panel API stays off')
      return
    }
    const fetch = (request: Request): Promise<Response> => this.handle(request)
    scoped.effect(() => registry.register({ path: PANEL_PATH, methods: ['GET', 'HEAD', 'POST'], requestBody: 'buffered', fetch }),
      'im-panel: snapshot and commands')
    scoped.effect(() => registry.register({ path: CHRONICLE_PATH, methods: ['GET'], requestBody: 'buffered', fetch }),
      'im-panel: chronicle')
    scoped.effect(() => registry.register({ path: TAB_PATH, methods: ['GET', 'HEAD', 'POST'], requestBody: 'streaming', fetch }),
      'im-panel: extension tabs')
    logger.info('im-panel: the panel answers on %s of the GUI', PANEL_PATH)
  }
}

export default ImPanelService
