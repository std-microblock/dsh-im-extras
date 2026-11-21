/**
 * The browser half of the panel: a `main` page of the harness GUI with its launcher in the left sidebar's panel list,
 * the `#im/<tab>` deep links, and the client `imPanel` service extension tabs register with.
 *
 * Built by `scripts/build-client.mjs` into the `window.__ModuleLoader__.load` artifact the harness serves as
 * `./client`.
 *
 * @module dsh-im-panel/client
 */

import type { ReactNode } from 'react'
import { IconDataOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { PanelPage, type PageProps } from './Page.tsx'
import { copy } from './copy.ts'
import type { ClientContext } from './context.ts'
import sheet from './page.css'
import { TabRegistry } from './registry.ts'
import { hashOf, isPageHash } from './route.ts'

/** The main panel's key, and the id of its entry in the sidebar's panel list. */
const PANEL_ID = 'im-panel'

/** Marker of the stylesheet tag, so a second load of this bundle adds nothing. */
const STYLE_ID = 'dsh-im-panel/page.css'

function ensureSheet(): void {
  if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-im-panel'
  tag.dataset.pluginCss = STYLE_ID
  tag.textContent = sheet
  document.head.appendChild(tag)
}

function PanelIcon(): ReactNode {
  return <IconDataOutlineRegular size={18} />
}

/** Services this half needs: the slot registry, the layout, and session navigation. */
export const inject = ['slots', 'layout', 'uiWorkspace']

/** Plugin identity. */
export const name = 'im-panel'

/**
 * Mount the browser half.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ensureSheet()
  const select = (): void => {
    try {
      ctx.layout.selectPanel(PANEL_ID)
    } catch (error: unknown) {
      console.error('im-panel: the panel could not be selected', error)
    }
  }
  const registry = new TabRegistry((id) => {
    if (id !== undefined && location.hash !== hashOf(id)) {
      history.pushState(null, '', hashOf(id))
      dispatchEvent(new HashChangeEvent('hashchange'))
    }
    select()
  })
  ctx.effect(() => ctx.provide('imPanel', registry), 'im-panel: client service')

  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    inject: (): PageProps => ({
      registry,
      openSession: (sessionId: string) => {
        try {
          ctx.uiWorkspace.openSession(sessionId)
        } catch (error: unknown) {
          console.error('im-panel: could not open session', sessionId, error)
        }
      },
    }),
  }, PanelPage)), 'im-panel: page')

  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 41,
    label: () => copy.brand,
  }, PanelIcon)), 'im-panel: sidebar launcher')

  const reveal = (): void => { if (isPageHash()) select() }
  ctx.effect(() => {
    reveal()
    addEventListener('hashchange', reveal)
    return () => { removeEventListener('hashchange', reveal) }
  }, 'im-panel: deep links')
}
