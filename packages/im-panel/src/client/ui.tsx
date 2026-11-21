/**
 * The pieces every view of the management page shares: the page context, the
 * card and table shells, and the small status vocabulary.
 *
 * @module dsh-im-agent-plugin/client/ui
 */

import { createContext, useContext, type ReactNode } from 'react'
import type { ImPanelCommand, ImPanelState } from '../protocol.ts'

/** What one view is given: the snapshot, the two actions, and the result channel. */
export interface PageContextValue {
  /** The deployment as the host last reported it. */
  readonly state: ImPanelState
  /** Whether a command is in flight. */
  readonly busy: boolean
  /** Run one command; the shell reports its outcome. */
  readonly run: (command: ImPanelCommand) => void
  /** Show one session in the conversation column. */
  readonly openSession: (sessionId: string) => void
  /** Report one line to the operator. */
  readonly toast: (text: string) => void
}

const PageContext = createContext<PageContextValue | undefined>(undefined)

/** The provider the shell wraps the page in. */
export const PageProvider = PageContext.Provider

/**
 * Read the page context.
 * @returns the context value; throws outside the page.
 */
export function usePage(): PageContextValue {
  const value = useContext(PageContext)
  if (value === undefined) throw new Error('im-agent: a page view rendered outside the management page')
  return value
}

/**
 * One titled card.
 * @param props.title - the card's heading.
 * @param props.hint - an optional line under the heading.
 * @param props.actions - controls at the heading's trailing edge.
 * @param props.children - the card's body.
 * @returns the card.
 */
export function Card({ title, hint, actions, children }: {
  readonly title?: string
  readonly hint?: string
  readonly actions?: ReactNode
  readonly children: ReactNode
}): ReactNode {
  const head = title !== undefined || hint !== undefined || actions !== undefined
  return (
    <section className="im-card">
      {head ? (
        <header className="im-card-head">
          <div>
            {title === undefined ? null : <h2 className="im-card-title">{title}</h2>}
            {hint === undefined ? null : <p className="im-card-hint">{hint}</p>}
          </div>
          {actions === undefined ? null : <div className="im-card-actions">{actions}</div>}
        </header>
      ) : null}
      {children}
    </section>
  )
}

/**
 * One headline number with its label.
 * @param props.label - what the number counts.
 * @param props.value - the number, already formatted.
 * @param props.hint - an optional line under it.
 * @returns the tile.
 */
export function Stat({ label, value, hint }: {
  readonly label: string
  readonly value: ReactNode
  readonly hint?: string
}): ReactNode {
  return (
    <div className="im-stat">
      <span className="im-stat-label">{label}</span>
      <span className="im-stat-value">{value}</span>
      {hint === undefined ? null : <span className="im-stat-hint">{hint}</span>}
    </div>
  )
}

/**
 * A definition list of key/value rows.
 * @param props.rows - one entry per row: label and value.
 * @returns the list.
 */
export function KeyValues({ rows }: { readonly rows: readonly (readonly [string, ReactNode])[] }): ReactNode {
  return (
    <dl className="im-kv">
      {rows.map(([label, value]) => (
        <div className="im-kv-row" key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * A table whose rows the caller builds.
 * @param props.head - column headings, in order.
 * @param props.children - the body rows.
 * @param props.empty - the line to show instead of rows when there are none.
 * @param props.count - how many rows the caller rendered, so `empty` can apply.
 * @returns the table, or the empty line.
 */
export function Table({ head, count, empty, children }: {
  readonly head: readonly string[]
  readonly count: number
  readonly empty: string
  readonly children: ReactNode
}): ReactNode {
  if (count === 0) return <p className="im-empty">{empty}</p>
  return (
    <div className="im-table-wrap">
      <table className="im-table">
        <thead>
          <tr>
            {head.map(column => <th key={column}>{column}</th>)}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

/**
 * The line a view shows when it has nothing to draw.
 * @param props.text - what the operator should read.
 * @returns the line.
 */
export function Empty({ text }: { readonly text: string }): ReactNode {
  return <p className="im-empty">{text}</p>
}

/**
 * A labelled form field.
 * @param props.label - the field's name.
 * @param props.children - the control.
 * @returns the field.
 */
export function Field({ label, children }: { readonly label: string, readonly children: ReactNode }): ReactNode {
  return (
    <label className="im-field">
      <span className="im-field-label">{label}</span>
      {children}
    </label>
  )
}
