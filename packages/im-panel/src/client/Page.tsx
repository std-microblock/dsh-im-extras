/**
 * The panel page: the left navigation (built-in tabs, then every extension tab), the routed view, and the polling that
 * keeps the snapshot fresh (on mount, every {@link REFRESH_MS}, and after every command).
 *
 * @module dsh-im-panel/client/Page
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  Button, Toast, IconBranchOutlineRegular, IconChecklistOutlineRegular, IconDataOutlineRegular,
  IconNewChatOutlineRegular, IconRefreshOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  ImPanelClientTab, ImPanelCommand, ImPanelQuery, ImPanelState, ImPanelTabProps,
} from '../protocol.ts'
import { ago, bodyOf, formatTime, readState, reason, send, tabUrl } from './api.ts'
import { copy } from './copy.ts'
import type { TabRegistry } from './registry.ts'
import { useRoute } from './route.ts'
import { Chats } from './tabs/Chats.tsx'
import { Chronicle } from './tabs/Chronicle.tsx'
import { Overview } from './tabs/Overview.tsx'
import { Rules } from './tabs/Rules.tsx'
import { Sessions } from './tabs/Sessions.tsx'
import { Tasks } from './tabs/Tasks.tsx'
import { PageProvider } from './ui.tsx'

const REFRESH_MS = 10_000

type Icon = (props: { size?: number; className?: string }) => ReactNode

interface NavEntry {
  readonly id: string
  readonly label: string
  readonly order: number
  readonly icon?: Icon | undefined
  readonly title: string
  readonly description: string
  readonly count?: (state: ImPanelState) => number | undefined
  readonly builtin?: () => ReactNode
  readonly extension?: ImPanelClientTab | undefined
}

const BUILTIN: readonly NavEntry[] = [
  { id: 'overview', label: copy.navOverview, order: 10, icon: IconDataOutlineRegular, title: copy.titleOverview, description: copy.descOverview, builtin: () => <Overview /> },
  { id: 'sessions', label: copy.navSessions, order: 20, icon: IconNewChatOutlineRegular, title: copy.titleSessions, description: copy.descSessions, count: state => state.sessions.length, builtin: () => <Sessions /> },
  { id: 'tasks', label: copy.navTasks, order: 30, icon: IconChecklistOutlineRegular, title: copy.titleTasks, description: copy.descTasks, count: state => state.tasks.length, builtin: () => <Tasks /> },
  { id: 'rules', label: copy.navRules, order: 40, icon: IconBranchOutlineRegular, title: copy.titleRules, description: copy.descRules, count: state => state.rules.length, builtin: () => <Rules /> },
  { id: 'chats', label: copy.navChats, order: 50, icon: IconNewChatOutlineRegular, title: copy.titleChats, description: copy.descChats, count: state => state.chats.filter(chat => chat.wakeMode !== undefined).length, builtin: () => <Chats /> },
  { id: 'chronicle', label: copy.navChronicle, order: 60, icon: IconDataOutlineRegular, title: copy.titleChronicle, description: copy.descChronicle, count: state => state.chronicle?.entries, builtin: () => <Chronicle /> },
]

/** What the page is given by its registrant. */
export interface PageProps {
  readonly openSession: (sessionId: string) => void
  readonly registry: TabRegistry
}

/** The props one extension tab receives, built once per tab and snapshot. */
function tabProps(
  id: string,
  state: ImPanelState | undefined,
  actions: { toast: (text: string) => void; openSession: (sessionId: string) => void; refresh: () => void },
): ImPanelTabProps {
  const request = async (path = '', init: RequestInit & { query?: ImPanelQuery } = {}): Promise<Response> => {
    const { query, ...rest } = init
    return await fetch(tabUrl(id, path, query), rest)
  }
  return {
    id,
    url: (path, query) => tabUrl(id, path, query),
    fetch: request,
    read: async <T,>(path?: string, query?: ImPanelQuery): Promise<T> => await bodyOf<T>(await request(path, {
      ...query === undefined ? {} : { query }, headers: { accept: 'application/json' },
    })),
    command: async <T,>(body: unknown, path?: string): Promise<T> => await bodyOf<T>(await request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    })),
    upload: async <T,>(path: string, files: readonly Blob[], fields?: Readonly<Record<string, string>>): Promise<T> => {
      const form = new FormData()
      for (const [key, value] of Object.entries(fields ?? {})) form.append(key, value)
      for (const file of files) form.append('file', file)
      return await bodyOf<T>(await request(path, { method: 'POST', body: form, headers: { accept: 'application/json' } }))
    },
    toast: actions.toast,
    openSession: actions.openSession,
    refresh: actions.refresh,
    chats: state?.chats ?? [],
    snapshot: state,
  }
}

/** The extension tab body, with its own props object. */
function Extension({ entry, state, actions }: {
  readonly entry: NavEntry
  readonly state: ImPanelState | undefined
  readonly actions: { toast: (text: string) => void; openSession: (sessionId: string) => void; refresh: () => void }
}): ReactNode {
  const props = useMemo(() => tabProps(entry.id, state, actions), [entry.id, state, actions])
  const Component = entry.extension?.component as ((props: ImPanelTabProps) => ReactNode) | undefined
  if (Component === undefined) return <p className="im-placeholder">{copy.noComponent}</p>
  return <Component {...props} />
}

/** The panel body. */
export function PanelPage({ openSession, registry }: PageProps): ReactNode {
  const [route, go] = useRoute()
  const [state, setState] = useState<ImPanelState | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [toast, setToast] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(new Set<AbortController>())
  const clientTabs = useSyncExternalStore(registry.subscribe, registry.snapshot)

  const load = useCallback(async (quiet = false): Promise<void> => {
    const controller = new AbortController()
    inFlight.current.add(controller)
    try {
      const next = await readState(controller.signal)
      if (controller.signal.aborted) return
      setState(next)
      setFailure(undefined)
    } catch (error: unknown) {
      if (!controller.signal.aborted && !quiet) setFailure(reason(error))
    } finally {
      inFlight.current.delete(controller)
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => { void load(true) }, REFRESH_MS)
    return () => {
      window.clearInterval(timer)
      for (const controller of inFlight.current) controller.abort()
      inFlight.current.clear()
    }
  }, [load])

  const run = useCallback((command: ImPanelCommand): void => {
    setBusy(true)
    void (async () => {
      try {
        const result = await send(command)
        setToast(result.text)
        await load(true)
      } catch (error: unknown) {
        setToast(reason(error))
      } finally {
        setBusy(false)
      }
    })()
  }, [load])

  const actions = useMemo(() => ({
    toast: (text: string) => { setToast(text) },
    openSession,
    refresh: () => { void load(true) },
  }), [openSession, load])

  const nav = useMemo((): NavEntry[] => {
    const extensions = new Map<string, NavEntry>()
    for (const tab of state?.tabs ?? []) {
      extensions.set(tab.id, {
        id: tab.id, label: tab.title, order: tab.order, title: tab.title, description: '',
        count: current => current.tabs.find(item => item.id === tab.id)?.badge,
      })
    }
    for (const tab of clientTabs) {
      const host = extensions.get(tab.id)
      extensions.set(tab.id, {
        id: tab.id,
        label: tab.title,
        order: tab.order ?? host?.order ?? 100,
        icon: tab.icon as Icon | undefined,
        title: tab.title,
        description: '',
        ...host?.count === undefined ? {} : { count: host.count },
        extension: tab,
      })
    }
    return [...BUILTIN, ...[...extensions.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))]
  }, [state?.tabs, clientTabs])

  const entry = nav.find(candidate => candidate.id === route) ?? (nav[0] as NavEntry)
  const body = state === undefined && entry.builtin !== undefined
    ? <p className="im-empty">{copy.loading}</p>
    : entry.builtin !== undefined && state !== undefined
      ? entry.builtin()
      : <Extension entry={entry} state={state} actions={actions} />

  return (
    <div className="im-page">
      <nav className="im-nav">
        <div className="im-brand">
          <span className="im-brand-mark">IM</span>
          <div>
            <div className="im-brand-name">{copy.brand}</div>
            <div className="im-brand-tag">{copy.tagline}</div>
          </div>
        </div>
        <div className="im-nav-items">
          {nav.map(({ id, label, icon: NavIcon, count }) => {
            const value = state === undefined ? undefined : count?.(state)
            return (
              <button type="button" key={id} className="im-nav-item" data-on={String(entry.id === id)} onClick={() => { go(id) }}>
                {NavIcon === undefined ? <span className="im-nav-icon" style={{ width: 16 }} /> : <NavIcon size={16} className="im-nav-icon" />}
                <span className="im-nav-label">{label}</span>
                {value === undefined ? null : <span className="im-nav-count">{value}</span>}
              </button>
            )
          })}
        </div>
        <div className="im-nav-foot">
          {state?.transport === undefined ? null : (
            <div className="im-bots">
              {state.transport.bots.map(bot => (
                <div className="im-bot" key={bot.id}>
                  <span className="im-dot" data-on={String(bot.status === 1)} />
                  <span className="im-bot-name">{bot.platform}</span>
                  <span className="im-bot-state">{bot.status === 1 ? copy.online : copy.offline}</span>
                </div>
              ))}
            </div>
          )}
          <div className="im-nav-meta">
            {state === undefined ? '—' : `${copy.updatedAt} ${formatTime(state.now, false)}`}
            {state === undefined ? null : <span className="im-nav-ago">{`（${ago(state.now, Date.now())}）`}</span>}
          </div>
        </div>
      </nav>

      <main className="im-main">
        <header className="im-head">
          <div className="im-head-text">
            <h1 className="im-title">{entry.title}</h1>
            {entry.description === '' ? null : <p className="im-desc">{entry.description}</p>}
          </div>
          <div className="im-head-actions">
            <Button size="sm" variant="outline" icon={<IconRefreshOutlineRegular size={14} />} disabled={busy} onClick={() => { void load() }}>
              {copy.refresh}
            </Button>
          </div>
        </header>
        {failure === undefined ? null : (
          <div className="im-error">
            <span>{`${copy.failed}：${failure}`}</span>
            <Button size="sm" variant="outline" onClick={() => { void load() }}>{copy.retry}</Button>
          </div>
        )}
        <div className="im-body">
          {state === undefined
            ? body
            : <PageProvider value={{ state, busy, run, openSession, toast: actions.toast }}>{body}</PageProvider>}
        </div>
      </main>

      {toast === undefined ? null : <Toast text={toast} onDone={() => { setToast(undefined) }} />}
    </div>
  )
}
