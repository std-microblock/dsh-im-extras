/**
 * The chats tab: every chat that reached dispatch, its wake/reply mode, watch topics and reply policy, with an editor
 * that writes through `ctx.imDispatch.configureChat` exactly like the routers' `configure_chat` tool.
 *
 * @module dsh-im-panel/client/tabs/Chats
 */

import { useState, type ReactNode } from 'react'
import { Button, Input, SegmentedControl, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ImPanelChat } from '../../protocol.ts'
import { copy } from '../copy.ts'
import { Card, Field, Table, usePage } from '../ui.tsx'

type WakeMode = 'mention' | 'watch' | 'auto'
type ReplyMode = 'mention_only' | 'proactive'

interface Draft {
  readonly chat: string
  readonly label: string
  readonly wakeMode: WakeMode
  readonly replyMode: ReplyMode
  readonly watchTopics: string
  readonly watchNote: string
  readonly replyPolicy: string
}

const WAKE_LABEL: Record<WakeMode, string> = { mention: copy.wakeMention, watch: copy.wakeWatch, auto: copy.wakeAuto }
const REPLY_LABEL: Record<ReplyMode, string> = { mention_only: copy.replyMentionOnly, proactive: copy.replyProactive }

function draftOf(chat: ImPanelChat): Draft {
  return {
    chat: chat.chat,
    label: chat.name ?? chat.chat,
    wakeMode: chat.wakeMode ?? 'mention',
    replyMode: chat.replyMode ?? 'mention_only',
    watchTopics: (chat.watchTopics ?? []).join(', '),
    watchNote: chat.watchNote ?? '',
    replyPolicy: chat.replyPolicy ?? '',
  }
}

/** The chats tab. */
export function Chats(): ReactNode {
  const { state, busy, run } = usePage()
  const [draft, setDraft] = useState<Draft | undefined>(undefined)
  const configurable = state.chats.filter(chat => chat.wakeMode !== undefined)

  const save = (): void => {
    if (draft === undefined) return
    run({
      action: 'chat-configure',
      chat: draft.chat,
      patch: {
        wakeMode: draft.wakeMode,
        replyMode: draft.replyMode,
        watchTopics: draft.watchTopics.split(/[,，、\n]/).map(item => item.trim()).filter(item => item !== ''),
        watchNote: draft.watchNote,
        replyPolicy: draft.replyPolicy,
      },
    })
    setDraft(undefined)
  }

  return (
    <>
      {draft === undefined ? null : (
        <Card
          title={`${copy.edit} · ${draft.label}`}
          actions={(
            <div className="im-row-actions">
              <Button size="sm" variant="ghost" onClick={() => { setDraft(undefined) }}>{copy.cancel}</Button>
              <Button size="sm" variant="primary" disabled={busy} onClick={save}>{copy.save}</Button>
            </div>
          )}
        >
          <div className="im-form">
            <Field label={copy.colWake}>
              <SegmentedControl
                id="im-chat-wake"
                value={draft.wakeMode}
                label={copy.colWake}
                options={(['mention', 'watch', 'auto'] as const).map(value => ({ value, label: WAKE_LABEL[value] }))}
                onChange={wakeMode => { setDraft({ ...draft, wakeMode }) }}
              />
            </Field>
            <Field label={copy.colReply}>
              <SegmentedControl
                id="im-chat-reply"
                value={draft.replyMode}
                label={copy.colReply}
                options={(['mention_only', 'proactive'] as const).map(value => ({ value, label: REPLY_LABEL[value] }))}
                onChange={replyMode => { setDraft({ ...draft, replyMode }) }}
              />
            </Field>
            <Field label={copy.watchTopics}>
              <Input value={draft.watchTopics} onChange={event => { setDraft({ ...draft, watchTopics: event.target.value }) }} />
            </Field>
            <Field label={copy.watchNote}>
              <textarea className="im-textarea" value={draft.watchNote} onChange={event => { setDraft({ ...draft, watchNote: event.target.value }) }} />
            </Field>
            <Field label={copy.replyPolicy}>
              <textarea className="im-textarea" value={draft.replyPolicy} onChange={event => { setDraft({ ...draft, replyPolicy: event.target.value }) }} />
            </Field>
          </div>
        </Card>
      )}

      <Card hint="默认只在被 @、被回复或私聊时唤醒群路由；监听话题模式下未 @ 的消息命中话题才会唤醒它">
        <Table
          head={[copy.colChat, copy.colWake, copy.colReply, copy.colWatch, copy.colActions]}
          count={configurable.length}
          empty={copy.emptyChats}
        >
          {configurable.map(chat => (
            <tr key={chat.chat}>
              <td>
                <div className="im-cell-title">
                  <span>{chat.name ?? chat.chat}</span>
                  <Tag tone="quiet">{chat.platform}</Tag>
                  {chat.type === undefined ? null : <Tag tone="outline">{chat.type}</Tag>}
                </div>
                {chat.name === undefined ? null : <div className="im-mono im-cell-sub">{chat.chat}</div>}
              </td>
              <td className="im-nowrap">
                <Tag tone={chat.wakeMode === 'mention' ? 'quiet' : 'info'}>{WAKE_LABEL[chat.wakeMode ?? 'mention']}</Tag>
              </td>
              <td className="im-nowrap">
                <Tag tone={chat.replyMode === 'proactive' ? 'warning' : 'quiet'}>{REPLY_LABEL[chat.replyMode ?? 'mention_only']}</Tag>
              </td>
              <td className="im-col-note">
                {(chat.watchTopics ?? []).length === 0 ? <span className="im-note">—</span> : (
                  <div className="im-chips">{chat.watchTopics?.map(topic => <span className="im-chip" key={topic}>{topic}</span>)}</div>
                )}
                {chat.watchNote === undefined ? null : <div className="im-cell-sub">{chat.watchNote}</div>}
                {chat.replyPolicy === undefined ? null : <div className="im-cell-sub">{`插话：${chat.replyPolicy}`}</div>}
              </td>
              <td>
                <div className="im-row-actions">
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => { setDraft(draftOf(chat)) }}>{copy.edit}</Button>
                </div>
              </td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  )
}
