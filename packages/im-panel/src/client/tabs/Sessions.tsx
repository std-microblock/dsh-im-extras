/**
 * The sessions view: every session the IM host serves in this process, the chats
 * and threads it may speak in, and the two things an operator does with one.
 *
 * @module dsh-im-agent-plugin/client/pages/Sessions
 */

import type { ReactNode } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { ago } from '../api.ts'
import { copy } from '../copy.ts'
import { Card, Table, usePage } from '../ui.tsx'

/**
 * The chat part of one global chat key (`bot|chat`), which is what a reader
 * recognizes; the bot is the same for every binding of one deployment.
 * @param chat - the global chat key.
 * @returns the chat id.
 */
function chatOf(chat: string): string {
  const separator = chat.indexOf('|')
  return separator === -1 ? chat : chat.slice(separator + 1)
}

/**
 * The sessions view.
 * @returns one row per hosted session.
 */
export function Sessions(): ReactNode {
  const { state, busy, run, openSession } = usePage()
  return (
    <Card hint="key 是会话的稳定名字（dispatch:chat:…、task:…），绑定决定它能读哪些 chat、往哪里发">
      <Table
        head={[copy.colSession, copy.colOwner, copy.colBindings, copy.colActive, copy.colActions]}
        count={state.sessions.length}
        empty={copy.emptySessions}
      >
        {state.sessions.map(session => (
          <tr key={session.sessionId}>
            <td>
              <div className="im-cell-title">
                <span>{session.title ?? session.key}</span>
                {session.role === 'router' ? <Tag tone="info">群路由</Tag> : session.role === 'task' ? <Tag tone="quiet">任务</Tag> : null}
                {session.output === undefined ? null : <Tag tone="outline">{session.output}</Tag>}
                {session.auth === undefined ? null : (
                  <>
                    {session.auth.exclusive
                      ? <Tag tone="warning">{`${copy.exclusiveTag}：${session.auth.owner?.name ?? session.auth.owner?.id ?? '?'}`}</Tag>
                      : null}
                    {session.auth.collaborators.length === 0
                      ? null
                      : <Tag tone="quiet">{`协作 ${String(session.auth.collaborators.length)} 人`}</Tag>}
                    {session.auth.grants.map(grant => (
                      <Tag key={grant.capabilityId} tone={grant.status === 'active' ? 'success' : 'warning'}>
                        {grant.title}
                      </Tag>
                    ))}
                  </>
                )}
              </div>
              <div className="im-mono im-cell-sub im-nowrap" title={`${session.key}\n${session.sessionId}`}>
                {`${session.title === undefined ? '' : `${session.key} · `}${session.sessionId.slice(0, 16)}…`}
              </div>
            </td>
            <td>{session.owner}</td>
            <td>
              <div className="im-chips">
                {session.bindings.length === 0 ? <span className="im-note">没有绑定</span> : session.bindings.map(binding => (
                  <span className="im-chip" key={`${binding.chat}/${binding.thread ?? ''}`} title={binding.chat}>
                    {chatOf(binding.chat)}
                    {binding.thread === undefined ? '' : `#${binding.thread}`}
                    {` · ${binding.writable ? copy.writable : copy.readOnly}`}
                    {binding.home ? ` · ${copy.home}` : ''}
                  </span>
                ))}
              </div>
            </td>
            <td className="im-nowrap">{`${ago(session.lastActiveAt, state.now)}（第 ${String(session.generation)} 代）`}</td>
            <td>
              <div className="im-row-actions">
                <Button size="sm" variant="outline" onClick={() => { openSession(session.sessionId) }}>
                  {copy.openSession}
                </Button>
                {session.auth !== undefined && (session.auth.exclusive || session.auth.grants.length > 0) ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => { run({ action: 'session-unlock', sessionId: session.sessionId }) }}
                  >
                    {copy.unlock}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => { run({ action: 'session-stop', sessionId: session.sessionId }) }}
                >
                  {copy.stop}
                </Button>
              </div>
            </td>
          </tr>
        ))}
      </Table>
    </Card>
  )
}
