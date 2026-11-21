/**
 * The chronicle tab: the compacted cross-chat log, newest first, filterable by chat and text, paged by id.
 *
 * @module dsh-im-panel/client/tabs/Chronicle
 */

import { useEffect, useState, type ReactNode } from 'react'
import { Button, Input, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ImPanelChronicleEntry } from '../../protocol.ts'
import { formatTime, readChronicle, reason } from '../api.ts'
import { copy } from '../copy.ts'
import { Card, Table, usePage } from '../ui.tsx'

const KIND_LABEL: Readonly<Record<string, string>> = { task_created: '建任务', task_routed: '转交', bot_reply: '回复' }

/** The chronicle tab. */
export function Chronicle(): ReactNode {
  const { state } = usePage()
  const [chat, setChat] = useState('')
  const [text, setText] = useState('')
  const [query, setQuery] = useState('')
  const [entries, setEntries] = useState<readonly ImPanelChronicleEntry[]>([])
  const [total, setTotal] = useState(0)
  const [next, setNext] = useState<number | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(false)

  const load = async (before?: number, signal?: AbortSignal): Promise<void> => {
    setLoading(true)
    setError(undefined)
    try {
      const page = await readChronicle({ chat: chat || undefined, query: query || undefined, before, limit: 50 }, signal)
      if (signal?.aborted === true) return
      setEntries(previous => (before === undefined ? page.entries : [...previous, ...page.entries]))
      setTotal(page.total)
      setNext(page.next)
    } catch (failure: unknown) {
      if (signal?.aborted !== true) setError(reason(failure))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    void load(undefined, controller.signal)
    return () => { controller.abort() }
  }, [chat, query])

  const names = new Map(state.chats.map(item => [item.chat, item.name ?? item.chat]))
  return (
    <Card hint={state.chronicle === undefined ? '没有挂载 dsh-im-dispatch，没有跨群日志' : `共 ${String(total)} 条匹配`}>
      <div className="im-toolbar">
        <select className="im-select" style={{ width: 'auto' }} value={chat} onChange={event => { setChat(event.target.value) }}>
          <option value="">{copy.allChats}</option>
          {state.chats.map(item => <option key={item.chat} value={item.chat}>{item.name ?? item.chat}</option>)}
        </select>
        <Input value={text} placeholder={copy.search} onChange={event => { setText(event.target.value) }} />
        <Button size="sm" variant="outline" onClick={() => { setQuery(text.trim()) }}>{copy.search}</Button>
      </div>
      {error === undefined ? null : <p className="im-note im-error-text">{error}</p>}
      <Table head={['#', copy.colTime, copy.colKind, copy.colChat, copy.colSummary]} count={entries.length} empty={loading ? copy.loading : copy.emptyChronicle}>
        {entries.map(entry => (
          <tr key={entry.id}>
            <td className="im-mono im-nowrap">{`#${String(entry.id)}`}</td>
            <td className="im-nowrap">{formatTime(entry.time)}</td>
            <td className="im-nowrap">
              <Tag tone="quiet">{KIND_LABEL[entry.kind] ?? entry.kind}</Tag>
              {entry.taskId === undefined ? null : <span className="im-cell-sub">{` 任务 #${String(entry.taskId)}`}</span>}
            </td>
            <td title={entry.chat}>{names.get(entry.chat) ?? entry.chat}</td>
            <td className="im-wrap">
              <div className="im-cell-title">{entry.subject}</div>
              <div className="im-cell-sub">{entry.summary}</div>
            </td>
          </tr>
        ))}
      </Table>
      {next === undefined ? null : (
        <div className="im-row" style={{ margin: '10px 12px' }}>
          <Button size="sm" variant="outline" disabled={loading} onClick={() => { void load(next) }}>{copy.more}</Button>
        </div>
      )}
    </Card>
  )
}
