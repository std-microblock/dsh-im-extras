/**
 * The rules view: every route rule of every task, with the create and edit form
 * an operator uses instead of asking the 群路由 to run a tool.
 *
 * A rule is one JavaScript expression evaluated per admitted message; a match
 * delivers the message to its task, and `cut` also withholds it from the
 * dispatcher. The host validates and serializes the write exactly as it does for
 * the agents' `add_route_rule` / `update_route_rule` / `remove_route_rule` calls.
 *
 * @module dsh-im-agent-plugin/client/pages/Rules
 */

import { useState, type ReactNode } from 'react'
import { Button, Input, SegmentedControl, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ImPanelRule } from '../../protocol.ts'
import { copy } from '../copy.ts'
import { Card, Field, Table, usePage } from '../ui.tsx'

/** One rule being written: a new rule has no `id` yet. */
interface Draft {
  /** The rule this draft replaces, absent for a new one. */
  readonly id?: number
  /** Task the rule delivers to. */
  readonly task: number
  /** Expression evaluated against each admitted message. */
  readonly match: string
  /** What a match does with the message. */
  readonly mode: 'copy' | 'cut'
  /** Note the worker reads, `''` for none. */
  readonly note: string
}

/**
 * The rules view.
 * @returns the rule list, with its form while one is open.
 */
export function Rules(): ReactNode {
  const { state, busy, run } = usePage()
  const [draft, setDraft] = useState<Draft | undefined>(undefined)
  const first = state.tasks[0]
  const limit = state.dispatch?.limits.maxRulesPerTask
  const maxPerTask = typeof limit === 'number' ? limit : 10

  const open = (rule?: ImPanelRule): void => {
    setDraft(rule === undefined
      ? { task: first?.id ?? 0, match: 'true', mode: 'copy', note: '' }
      : { id: rule.id, task: rule.task, match: rule.match, mode: rule.mode, note: rule.note ?? '' })
  }
  const save = (): void => {
    if (draft === undefined) return
    const note = { note: draft.note.trim() === '' ? '' : draft.note }
    if (draft.id === undefined) run({ action: 'rule-add', task: draft.task, match: draft.match, mode: draft.mode, ...note })
    else run({ action: 'rule-update', id: draft.id, task: draft.task, match: draft.match, mode: draft.mode, ...note })
    setDraft(undefined)
  }

  return (
    <>
      {draft === undefined ? null : (
        <Card
          title={draft.id === undefined ? copy.newRule : `${copy.editRule} #${String(draft.id)}`}
          actions={(
            <div className="im-row-actions">
              <Button size="sm" variant="ghost" onClick={() => { setDraft(undefined) }}>{copy.cancel}</Button>
              <Button size="sm" variant="primary" disabled={busy} onClick={save}>{copy.save}</Button>
            </div>
          )}
        >
          <div className="im-form">
            <Field label={copy.task}>
              <select
                className="im-select"
                value={String(draft.task)}
                onChange={event => { setDraft({ ...draft, task: Number(event.target.value) }) }}
              >
                {state.tasks.map(task => (
                  <option key={task.id} value={String(task.id)}>{`#${String(task.id)} ${task.title}`}</option>
                ))}
              </select>
            </Field>
            <Field label={copy.mode}>
              <SegmentedControl
                id="im-rule-mode"
                value={draft.mode}
                label={copy.mode}
                options={[{ value: 'copy', label: copy.modeCopy }, { value: 'cut', label: copy.modeCut }]}
                onChange={mode => { setDraft({ ...draft, mode }) }}
              />
            </Field>
            <Field label={copy.match}>
              <Input
                className="im-mono"
                value={draft.match}
                spellCheck={false}
                onChange={event => { setDraft({ ...draft, match: event.target.value }) }}
              />
            </Field>
            <Field label={copy.note}>
              <Input value={draft.note} onChange={event => { setDraft({ ...draft, note: event.target.value }) }} />
            </Field>
          </div>
        </Card>
      )}

      <Card
        hint={state.tasks.length === 0
          ? copy.noTasks
          : `共 ${String(state.rules.length)} 条规则；每个任务最多 ${String(maxPerTask)} 条`}
        actions={(
          <Button
            size="sm"
            variant="primary"
            disabled={busy || state.tasks.length === 0}
            onClick={() => { open() }}
          >
            {copy.newRule}
          </Button>
        )}
      >
        <Table
          head={['#', copy.colTask, copy.colMode, copy.colMatch, copy.colNote, copy.colErrors, copy.colActions]}
          count={state.rules.length}
          empty={copy.emptyRules}
        >
          {state.rules.map(rule => (
            <tr key={rule.id}>
              <td className="im-mono im-nowrap">{`#${String(rule.id)}`}</td>
              <td>
                <div className="im-cell-title im-nowrap">{`任务 #${String(rule.task)}`}</div>
                <div className="im-cell-sub">{state.tasks.find(task => task.id === rule.task)?.title ?? ''}</div>
              </td>
              <td>
                <Tag tone={rule.mode === 'cut' ? 'warning' : 'info'}>
                  {rule.mode === 'cut' ? copy.modeCut : copy.modeCopy}
                </Tag>
              </td>
              <td className="im-mono im-wrap">{rule.match}</td>
              <td className="im-col-note">
                {rule.note === undefined ? <span className="im-note">—</span> : rule.note}
                {rule.lastError === undefined
                  ? null
                  : <div className="im-cell-sub im-error-text">{`上次求值失败：${rule.lastError}`}</div>}
              </td>
              <td className="im-nowrap">{rule.errors === 0 ? <span className="im-note">—</span> : <Tag tone="danger">{String(rule.errors)}</Tag>}</td>
              <td>
                <div className="im-row-actions">
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => { open(rule) }}>{copy.edit}</Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => { run({ action: 'rule-remove', id: rule.id }) }}
                  >
                    {copy.remove}
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  )
}
