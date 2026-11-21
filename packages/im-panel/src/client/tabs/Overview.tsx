/**
 * The overview tab: headline counts, the chat transport, the dispatch configuration, the newest chronicle entries and
 * the notices explaining empty views.
 *
 * @module dsh-im-panel/client/tabs/Overview
 */

import type { ReactNode } from 'react'
import { copy } from '../copy.ts'
import { formatTime } from '../api.ts'
import { Card, KeyValues, Stat, usePage } from '../ui.tsx'

/** Bot connection states the IM core reports, as its protocol numbers them. */
const STATUS = ['离线', '在线', '连接中', '已断开', '重连中'] as const

const LIMIT_LABELS: Readonly<Record<string, (value: number | boolean) => string>> = {
  maxRulesPerTask: value => `${String(value)} 规则/任务`,
  ruleTimeoutMs: value => `规则 ${String(value)} ms`,
  ruleMemoryBytes: value => `规则 ${String(Number(value) / 1024 / 1024)} MB`,
  maxTaskMessages: value => `${String(value)} 消息/任务`,
  contextMessages: value => `${String(value)} 条上下文`,
  maxRouterSteps: value => `${String(value)} 步路由上限`,
  maxRouterDeltaMessages: value => `${String(value)} 条增量上限`,
  freshContextMessages: value => `${String(value)} 条初始回溯`,
  autoThread: value => (value === true ? '自动话题' : '不自动开话题'),
  ambientDebounceMs: value => `旁听防抖 ${String(value)} ms`,
  maxAutoRepliesPerHour: value => `主动发言 ${String(value)} 次/小时`,
}

/** The overview tab. */
export function Overview(): ReactNode {
  const { state } = usePage()
  const recent = state.tasks.filter(task => state.now - task.updatedAt < 3_600_000).length
  const failing = state.rules.filter(rule => rule.errors > 0).length
  const routers = state.sessions.filter(session => session.role === 'router').length
  return (
    <>
      <div className="im-stats">
        <Stat label={copy.taskCount} value={state.tasks.length} hint={`${String(recent)} 个一小时内活动`} />
        <Stat label={copy.ruleCount} value={state.rules.length} hint={failing === 0 ? '全部求值正常' : `${String(failing)} 条在报错`} />
        <Stat label={copy.sessionCount} value={state.sessions.length} hint={`${String(routers)} 个群路由`} />
        <Stat
          label={copy.pendingCount}
          value={state.transport === undefined ? '—' : state.transport.pendingDeliveries + state.transport.pendingMessages}
          hint={state.transport === undefined ? 'IM 主机未报告' : '投递 + 消息'}
        />
      </div>

      {state.notices.length === 0 ? null : (
        <Card title={copy.notices}>
          {state.notices.map(notice => (
            <p className={notice.level === 'warning' ? 'im-note im-error-text' : 'im-note'} key={notice.text}>{notice.text}</p>
          ))}
        </Card>
      )}

      <Card title={copy.transport} hint={state.transport === undefined ? '这个 harness 的 IM 主机不报告状态' : undefined}>
        {state.transport === undefined ? null : (
          <>
            <KeyValues rows={[
              [copy.bots, state.transport.bots.length === 0
                ? '没有机器人'
                : state.transport.bots.map(bot => `${bot.id}（${bot.platform}）：${STATUS[bot.status] ?? `状态 ${String(bot.status)}`}`).join('、')],
              [copy.chats, String(state.transport.chats)],
              [copy.sources, String(state.transport.sources)],
              [copy.pending, `${String(state.transport.pendingDeliveries)} 投递 / ${String(state.transport.pendingMessages)} 消息`],
            ]}
            />
            <div className="im-chips">
              {state.transport.bots.map(bot => (
                <span className="im-chip" key={bot.id}>
                  <span className="im-dot" data-on={String(bot.status === 1)} />
                  {`${bot.platform} · ${STATUS[bot.status] ?? '未知'}`}
                </span>
              ))}
            </div>
          </>
        )}
      </Card>

      {state.dispatch === undefined ? null : (
        <Card title={copy.dispatch}>
          <KeyValues rows={[
            [copy.router, `${state.dispatch.main.agentPreset} · ${state.dispatch.main.provider} / ${state.dispatch.main.model}`],
            [copy.worker, `${state.dispatch.worker.agentPreset} · ${state.dispatch.worker.provider} / ${state.dispatch.worker.model}`],
            [copy.workerOutput, <span className="im-mono">{state.dispatch.workerOutput}</span>],
            [copy.mainTools, <span className="im-mono">{state.dispatch.tools.main.join(', ')}</span>],
            [copy.workerTools, <span className="im-mono">{state.dispatch.tools.worker.join(', ')}</span>],
            [copy.limits, Object.entries(state.dispatch.limits)
              .map(([key, value]) => LIMIT_LABELS[key]?.(value) ?? `${key}=${String(value)}`)
              .join(' · ')],
          ]}
          />
        </Card>
      )}

      {state.chronicle === undefined ? null : (
        <Card title={copy.chronicle} hint={`${String(state.chronicle.entries)} 条 / ${String(state.chronicle.chunks)} 个封存块 / 最新 #${String(state.chronicle.latestId)}`}>
          <KeyValues rows={state.chronicle.recent.slice(0, 8).map((entry): [string, string] => [
            `#${String(entry.id)} · ${formatTime(entry.time)}`,
            `${entry.subject} — ${entry.summary}`,
          ])}
          />
        </Card>
      )}
    </>
  )
}
