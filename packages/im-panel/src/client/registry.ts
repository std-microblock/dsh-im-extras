/**
 * The client `imPanel` service: the extension tabs browser plugins registered, as a tiny external store React reads.
 *
 * @module dsh-im-panel/client/registry
 */

import type { ImPanelClient, ImPanelClientTab } from '../protocol.ts'
import { BUILTIN_TABS, TAB_ID } from '../protocol.ts'

/** The registry behind the client service. */
export class TabRegistry implements ImPanelClient {
  private tabs: readonly ImPanelClientTab[] = []
  private readonly listeners = new Set<() => void>()

  constructor(private readonly opener: (id?: string) => void) {}

  tab(tab: ImPanelClientTab): () => void {
    if (!TAB_ID.test(tab.id)) throw new Error(`im-panel: tab id ${JSON.stringify(tab.id)} must match ${String(TAB_ID)}`)
    if ((BUILTIN_TABS as readonly string[]).includes(tab.id)) throw new Error(`im-panel: tab id ${tab.id} is reserved`)
    if (this.tabs.some(entry => entry.id === tab.id)) throw new Error(`im-panel: tab ${tab.id} is already registered`)
    this.tabs = [...this.tabs, tab]
    this.notify()
    return () => {
      if (!this.tabs.includes(tab)) return
      this.tabs = this.tabs.filter(entry => entry !== tab)
      this.notify()
    }
  }

  open(id?: string): void {
    this.opener(id)
  }

  /** The registered tabs (a new array after every change). */
  snapshot = (): readonly ImPanelClientTab[] => this.tabs

  /** Subscribe to changes. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
