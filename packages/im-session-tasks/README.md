# dsh-im-session-tasks

The task registry behind dispatch: a task per topic, its own worker session, the chats that session may speak in, and
the `task_*` tools both sides use.

The plugin provides `ctx.imTasks` and opens the durable `im_tasks` storage domain. It routes no inbound message by
itself — a strategy (a dispatcher plugin such as `dsh-im-dispatch`) starts tasks and hands further messages to
a worker:

```ts
ctx.imTasks.start({ owner, brief, title, placement, worker, output })   // → ImTask
ctx.imTasks.deliver(id, messages)    // admitted messages the worker should see next
ctx.imTasks.note(worker, note)       // what the worker reports about itself
```

## Tools

| tool | who calls it | what it does |
| --- | --- | --- |
| `task_start` | an owner session | starts a background task: a new worker session receives the brief and answers in the placement's `home` chat/thread |
| `task_list` | an owner session | the tasks of this conversation, newest first, with the last note and last activity |
| `task_message` | an owner session | sends new instructions to an existing task; its worker resumes and receives them |
| `task_note` | a worker | records what the task has done; the owner session reads it in a notice, and it becomes the task's latest note |

Which tools an owner and a worker get is `tools.owner` / `tools.worker` in the config; the task number (`task #3`) is
what both sides name in the chat, and it is never reused.

## No task status

A task carries no lifecycle state. The four-value `running` / `waiting` / `done` / `failed` status this service used to
keep was written by the worker and read by everything else, so it described the model's last self-report rather than
the work: a session woken by a schedule every morning stayed `done` between runs, and every gate that trusted the flag
(routing a follow-up into the task, delivering a matched message to its rules) then refused the work that task should
have answered. What remains is `updatedAt` — the last start, steer, note or delivery — and the worker's `note`; whether
a message belongs to an existing task is the caller's judgment, not a stored string.

`im_tasks` is therefore version 2 and reads version 1 through `compatibleVersions`: old rows still carry `status`, the
schema strips it on read, and the next write stamps version 2. Sessions keep their logs untouched.

## Restarts

A restart still costs every in-flight task its answer: the process is disposed mid-turn, so no note arrives. Nothing is
repaired at mount — there is no stale flag to settle — but the worker's streamed card keeps its last progress line,
because the card handle lived in the dead process. A person reading the topic sees the bot stop mid-sentence. Closing or
editing that card needs the `im-card` handle store (`adoptHost` / `bot.edit(handle, content, { strategy: 'in-place' })`)
keyed by the session's message, which this plugin does not own.

## Config

`owners` (default `['conversation', 'dispatcher']`) names the owner names that may start tasks — the plugin registers no
placer of its own, so a strategy registers one per owner with `ctx.imTasks.placement(owner, place)`. `maxTextChars`
(default 20000) bounds one task's text, and `locale` (`zh` default, `en`) picks the strings the worker and the owner
read.

## Layout

- `src/api.ts` — the public contract (`ImTasks`, `ImTask`, placement, note).
- `src/tasks.ts` — `ImTaskHost`: placement, worker composition, delivery, notes.
- `src/domain.ts` — the `im_tasks` storage domain (version 2) and its zod schema.
- `src/tools.ts` — the four `task_*` tools and their output shapes.
- `src/locale.ts` — the `zh`/`en` strings.
