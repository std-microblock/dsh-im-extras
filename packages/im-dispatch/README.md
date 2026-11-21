# dsh-im-dispatch

The session strategy of a group-chat bot on the DeepSeek Harness IM host (`dsh-im`):

- **one router per chat** (one per topic on topic-mode chats): a read-only session that receives everything said in
  the chat since it last woke and decides — answer in one line (`router_reply`), start a background **task worker**,
  hand messages or instructions to a running one, change how the chat wakes it, or stay silent. It never does the
  work itself and is held to a small step budget (`maxRouterSteps`);
- **task workers** started through `ctx.imTasks` ([`dsh-im-session-tasks`](../im-session-tasks/README.md)): each works
  one request in its own session and answers in a reply thread of the triggering message (`autoThread`);
- **route rules**: JavaScript expressions over the message (evaluated in QuickJS, bounded in time and memory) that a
  worker attaches to its task so matching messages reach it directly — `copy` (the router still sees them) or `cut`;
- **thread follow-up**: a worker that opts in (`followThread`) receives unaddressed messages of its thread;
- **per-chat wake/reply modes** (`configure_chat`): `mention` (default — only @bot, replies and direct chats wake the
  router), `watch` (unaddressed messages wake it when they may hit the chat's watch topics or a task's wanted topics),
  `auto` (every message, debounced); `mention_only` (default) or `proactive` (the router may speak unprompted, at most
  `maxAutoRepliesPerHour`);
- **`/skill` commands**: `@bot /<skill or alias> …` opens a worker with that skill already loaded; a skill whose
  metadata declares `capabilities` gets them requested through `ctx.imAuth`
  ([`dsh-im-session-auth`](../im-session-auth/README.md)) when that plugin is mounted;
- **the chronicle**: every task start, hand-off and bot reply compacted into one line by a small model; routers and
  workers ask it (`query_chronicle`) about work done in other chats;
- reactions to the bot's messages are batched into the next wake of the router (or of the opted-in worker).

The shipped guidance (system-prompt sections) is in Chinese, for a Chinese-speaking bot; replace either text with
`prompts.main` / `prompts.worker`, or append to it with `ctx.imDispatch.prompt(...)`.

## Install

Requires `dsh-im`, `dsh-im-session-tasks`, and the harness's `storageDomain`, `tools` and `systemPrompt` services.
Optional: `llm` (chronicle), `imAuth` (exclusive tasks, capability requests), `skills` (`/skill` commands),
`sessions` + `sessionTitle` + `sessionQuery` (readable session titles in the GUI).

```yaml
plugins:
  - name: dsh-im-session-tasks
  - name: dsh-im-dispatch
    config:
      main:   { agentPreset: router, provider: my-provider, model: my-fast-model, cwd: /srv/bot/router }
      worker: { agentPreset: worker, provider: my-provider, model: my-strong-model, cwd: /srv/bot/work }
      workerOutput: summary          # the output renderer workers stream through (e.g. dsh-im-output-summary)
      chatNames: { 'lark:app|oc_xxx': '研发群' }   # optional display-name overrides
```

The router preset should contain the router tools below plus the read-only IM tools; `tools.main` restricts the
router to exactly that list.

### Config

| key | default | |
|-----|---------|-|
| `main`, `worker` | required | `{ agentPreset, provider, model, cwd }` of routers and of workers (`cwd` absolute) |
| `workerOutput` | `none` | output renderer of workers (`none`: they publish only with IM tools) |
| `prompts.main` / `prompts.worker` | shipped text | replace the guidance of either role |
| `tools.main` / `tools.worker` | see `DISPATCHER_TOOLS` / `WORKER_TOOLS` | tools each role keeps |
| `autoThread` | `true` | confine a new task started on a main-timeline group message to a reply thread |
| `threadlessPlatforms` | `['qq', 'onebot', 'chronocat']` | platforms (bot id prefix) without reply threads; a bot answering `supports('message.thread') === false` counts too |
| `maxRouterSteps` | `5` | warn at this step, force a wrap-up one step later, reject beyond |
| `maxRouterDeltaMessages` | `200` | unread messages one wake carries at most |
| `freshContextMessages` | `20` | backlog a router reads when it wakes for the first time (or after `/clear`) |
| `ambientDebounceMs` | `3000` | debounce of unaddressed wakes and reaction batches |
| `maxAutoRepliesPerHour` | `6` | proactive `router_reply` budget per chat |
| `ruleTimeoutMs`, `ruleMemoryBytes`, `maxRuleChars`, `maxRulesPerTask` | `50`, 16 MiB, `2000`, `10` | route-rule bounds |
| `maxTaskMessages`, `contextMessages` | `20`, `5` | messages one task start hands over, and the context read around them |
| `maxSearchPages`, `searchPageSize` | `10`, `20` | `im_search` bounds |
| `chatNames` | `{}` | display names by chat key or platform chat id |
| `chronicle` | enabled | `{ enabled, provider?, model?, reasoningEffort: 'off', compactMaxTokens, queryMaxTokens, chunkSize, maxEntries, timeoutMs }`; provider/model default to `main`'s |

## Tools

| tool | role | |
|------|------|-|
| `router_reply` | router | one direct markdown answer in the chat |
| `create_task` | router | start a worker on `#seq` messages or a `{from,to}` range |
| `route_messages_to_task` | router | hand messages (any chat) to a running task |
| `steer_task` | router | send synthesized instructions to a running task |
| `list_tasks` | router | the dispatch tasks with their notes and self-descriptions |
| `configure_chat` | router | wake/reply mode, watch topics, watch note, reply policy |
| `task_describe` | worker | description, wanted topics (+ scope), `followThread` |
| `add_route_rule` / `update_route_rule` | worker | the task's route rules |
| `list_route_rules` / `remove_route_rule` | both | oversight |
| `query_chronicle` | both | ask the cross-chat log |
| `im_search` | both | search history with a rule expression |

## Service: `ctx.imDispatch`

For operator tools (e.g. [`dsh-im-panel`](../im-panel/README.md)) and plugins that extend the strategy:

```ts
ctx.inject(['imDispatch'], (ctx) => {
  ctx.imDispatch.deliveryCause(sessionId, messageKey) // why a message reached a worker: rule / dispatch / thread
  await ctx.imDispatch.chats()                     // every chat: name, type, wake/reply configuration
  await ctx.imDispatch.configureChat(chat, { wakeMode: 'watch', watchTopics: ['发版'] })
  await ctx.imDispatch.rules()                     // all route rules, with error counts
  await ctx.imDispatch.addRule(task, { match: 'im.thread_id === "…"', mode: 'copy' })
  await ctx.imDispatch.updateRule(task, id, { mode: 'cut' })
  await ctx.imDispatch.removeRule(id, { user })    // with `user`: refused when imAuth locks the task to others
  ctx.imDispatch.tasks(); ctx.imDispatch.routers(); ctx.imDispatch.sessionTitle(sessionId)
  await ctx.imDispatch.chronicleStatus(); await ctx.imDispatch.chronicleEntries({ chat, before, query, limit })

  // extension points — removed automatically when the calling plugin unloads
  ctx.imDispatch.prompt('worker', '需要回调时调用 my_tool。')    // append guidance to every worker (or 'router')
  ctx.imDispatch.ephemeral(text => text.startsWith('🔗 '))      // own status lines routers and the chronicle skip
  ctx.imDispatch.markEphemeral(receipt.message?.key)           // one such message, by key
  ctx.imDispatch.ruleButton(ruleId)                            // a "delete rule #id" button element; clicks handled here
})
```

Events:

| event | arguments |
|-------|-----------|
| `im-dispatch/delivered` | `(sessionId, messageKey, cause: DeliveryCause)` — a message was delivered to a worker |
| `im-dispatch/rule` | `(change: 'added' \| 'changed' \| 'removed', rule: RouteRuleView)` |
| `im-dispatch/chat` | `(view: ChatConfigView)` — a chat's configuration changed |

`DeliveryCause` is `{ kind: 'rule', rules: [{ id, mode, match, note?, taskId }] } | { kind: 'dispatch', taskId } |
{ kind: 'thread', taskId }`.

## Storage

Two storage domains: `im_rules` (chats, their router cursors and configuration, route rules) and `im_chronicle`. Router
session keys are `dispatch:chat:<chat key>` and `dispatch:topic:<chat key>:<thread id>`, owner `dispatch`.

## Development

`pnpm run typecheck`, `pnpm test` (from the repository root, after `pnpm run harness`).
