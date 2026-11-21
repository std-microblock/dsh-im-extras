/**
 * Structural views of the client services this browser half uses.
 *
 * The plugin is installed into a harness profile and runs against live client
 * services, so — as the Host half does with its own services — it declares the
 * slice it reads instead of importing harness packages at runtime. The shapes
 * mirror `@deepseek-ai/dsh-client-ui-slots` (the slot registry), the `main` page
 * seat and the left sidebar's `sidebar.panellist` list, the layout service that
 * selects a main panel, and the workspace navigation service `uiWorkspace`.
 *
 * @module dsh-im-panel/client/context
 */

import type { ReactNode } from 'react'

/** One registration into any slot the page contributes to. */
export interface SlotRegistration<P extends object> {
  /** The declared slot's key: `main` or `sidebar.panellist`. */
  readonly name: string
  /** Keyed seat key (the main panel's id); absent for a list seat. */
  readonly key?: string
  /** List seat id (the sidebar entry's id); absent for a keyed seat. */
  readonly id?: string
  /** List seat row order; ties keep registration order. */
  readonly order?: number
  /** The row title the list's owner draws, in the current language. */
  readonly label?: () => string
  /** The business face the component receives as props. */
  readonly inject?: () => P
}

/** The slot registry (`ctx.slots`), as far as this half registers into it. */
export interface SlotsLike {
  /**
   * Contribute into a slot another plugin declares, re-running after a redeclaration.
   * @param name - the declared slot key.
   * @param contribution - factory returning the registration's disposer.
   * @returns the disposer removing the contribution.
   */
  inject(name: string, contribution: () => () => void): () => void
  /**
   * Register one occupant of a slot.
   * @param options - seat key and business face factory.
   * @param component - the component the owner renders.
   * @returns the disposer removing the registration.
   */
  register<P extends object>(options: SlotRegistration<P>, component: (props: P) => ReactNode): () => void
}

/** The layout service (`ctx.layout`), as far as this half drives it. */
export interface LayoutLike {
  /**
   * Select one main panel in the centre column.
   * @param panelId - a registered main panel key.
   */
  selectPanel(panelId: string): void
}

/** Workspace navigation, as far as the page uses it (`ctx.uiWorkspace`). */
export interface WorkspaceLike {
  /**
   * Show one session in the conversation column.
   * @param sessionId - the session to show.
   */
  openSession(sessionId: string): void
}

/** The client root Context, as far as this half reads it. */
export interface ClientContext {
  readonly uiWorkspace: WorkspaceLike
  readonly layout: LayoutLike
  readonly slots: SlotsLike
  /**
   * Run one contribution while this plugin is loaded.
   * @param disposer - body returning its own disposer.
   * @param label - what the contribution is, for diagnostics.
   */
  effect(disposer: () => (() => void) | void, label: string): void
  /**
   * Provide one service to the other browser plugins (cordis `ctx.provide`).
   * @returns the disposer.
   */
  provide(name: string, value: unknown): () => void
}
