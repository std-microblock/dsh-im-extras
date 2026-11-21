/**
 * The tasks view: every task the 群路由 started, what it is doing, and the
 * two things an operator does about one — read its session, or stop it.
 *
 * @module dsh-im-agent-plugin/client/pages/Tasks
 */

import type { ReactNode } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { ago } from '../api.ts'
import { copy } from '../copy.ts'
import { Card, Table, usePage } from '../ui.tsx'

/**
 * The tasks view.
 * @returns one row per task.
 */
export function Tasks(): ReactNode {
  const { state, busy, run, openSession } = usePage()
  return (
    <Card hint="任务在请求消息所在的 chat/话题里作答；没有任何状态字段，只有最后活动时间，停止会把该轮取消并记一条备注">
      <Table
        head={['#', copy.colTask, copy.colChat, copy.colUpdated, copy.colActions]}
        count={state.tasks.length}
        empty={copy.emptyTasks}
      >
        {state.tasks.map(task => (
          <tr key={task.id}>
            <td className="im-mono im-nowrap">{`#${String(task.id)}`}</td>
            <td>
              <div className="im-cell-title">
                <span>{task.title}</span>
                {task.topicScope === 'all'
                  ? <Tag tone="info">跨群话题</Tag>
                  : null}
                {task.followThread === true
                  ? <Tag tone="info">自动跟贴</Tag>
                  : null}
                {task.wantedTopics?.map(topic => (
                  <Tag key={topic} tone="quiet">{topic}</Tag>
                ))}
                {task.auth === undefined ? null : (
                  <>
                    {task.auth.exclusive
                      ? <Tag tone="warning">{`${copy.exclusiveTag}：${task.auth.owner?.name ?? task.auth.owner?.id ?? '?'}`}</Tag>
                      : null}
                    {task.auth.collaborators.length === 0
                      ? null
                      : <Tag tone="quiet">{`协作 ${String(task.auth.collaborators.length)} 人`}</Tag>}
                    {task.auth.grants.map(grant => (
                      <Tag key={grant.capabilityId} tone={grant.status === 'active' ? 'success' : 'warning'}>
                        {grant.title}
                      </Tag>
                    ))}
                  </>
                )}
              </div>
              {task.description === undefined ? null : <div className="im-cell-sub">{task.description}</div>}
              {task.note === undefined ? null : <div className="im-cell-sub">{task.note}</div>}
              <div className="im-mono im-cell-sub">{task.session}</div>
            </td>
            <td>{task.chatName === undefined ? <span className="im-mono">{task.chat}</span> : <span title={task.chat}>{task.chatName}</span>}</td>
            <td>{ago(task.updatedAt, state.now)}</td>
            <td>
              <div className="im-row-actions">
                <Button size="sm" variant="outline" onClick={() => { openSession(task.session) }}>
                  {copy.openSession}
                </Button>
                {task.auth !== undefined && (task.auth.exclusive || task.auth.grants.length > 0) ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => { run({ action: 'session-unlock', sessionId: task.session }) }}
                  >
                    {copy.unlock}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => { run({ action: 'task-stop', id: task.id }) }}
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
