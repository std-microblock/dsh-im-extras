# dsh-im-output-summary

The `summary` output renderer: streams each IM turn's progress in place, then delivers the final answer.

A session whose `spec.output` is `summary` publishes a live progress card while the turn runs — the tool being called,
the latest model-written progress summary or the answer so far, a stop control, and the link to the page showing the
work. When the turn ends:

- If a live progress card was opened and another plugin contributes `process` content (such as a page-link plugin's
  `🔗 查看工作过程` collapsible panel), that process card collapses in place to the `process` content alone, and the
  final answer with its footer (elapsed time, tool calls) — or error line — is sent as a **separate new message** so the
  chat notifies natively and displays the answer in the conversation preview.
- A cancelled turn that produced no answer settles in place on the process card (`已取消` / `已由 @名字 取消`).
- A turn that never opened a progress card (for example under `firstOutput: first-tool` with no tool calls) sends one
  result message directly.
- Without `process` contributions, the streamed card settles into the final answer in place as before.

The renderer never names a platform: it builds platform-neutral elements and lets the IM host publish them, so a mode
that cannot rewrite a message shows less instead of lying (`README` of `cordis-plugin-im-core`, "Streaming").

`output: none` (the default) leaves a session untouched: nothing is published unless the agent calls a send tool.

## When the message appears

`firstOutput` decides:

| value | behaviour |
| --- | --- |
| `immediate` (default) | the progress line goes out as the turn starts — the chat sees the work from the first second |
| `first-tool` | the message opens at the turn's **first tool call**, so a turn that only answers arrives as the one message the person reads |

Under `first-tool` a turn that produces no answer and calls no tool publishes nothing at all, and a turn that ends
before its first tool call delivers its answer as a single message.

## Staying silent: `no_output`

The `no_output` tool silences the running turn: what it already published is withdrawn and nothing further goes out —
no progress card, no answer card. It is about ordering, not about the work: a turn that should leave the chat untouched
makes `no_output` its **first tool call** — alone, or in the same batch as the turn's other first calls; never behind
them. The first tool call is what opens the card, so a later call still withdraws it, but the chat saw it appear and
disappear. Anything such a turn must say goes out through `im_send` / `im_send_card`.

The tool is registered when the host has a tool registry, next to a prompt section (`tool:no-output`) telling
the model when to reach for it. A silenced turn still shows the working reaction: the message is not the only signal.

## Contributions: `im/streaming-message`

Every state of a turn's message — the running card (`progress`), the collapsed process card (`process`), the settled
answer (`settled`), and the line a stopped or failed turn closes with (`closing`) — is composed through one waterfall, so
a plugin that knows something about the turn contributes there instead of publishing a separate "working" message:

```ts
ctx.on('im/streaming-message', (message, next) => {
  // `next()` is the message as this renderer built it, in every state of the turn.
  if (message.hasProcessMessage) return next()
  return [...next(), myLine(message.activity)]
})
```

`message.activity` is the turn (its session, its trigger, its segments), `message.part` is `progress`, `process`,
`settled` or `closing`, and `message.hasProcessMessage` is `true` on `settled` / `closing` when the turn already kept a
separate collapsed `process` message in the chat. A listener must call `next()` and keep what it returns; whatever it
adds on `progress` / `process` stays in the process card, and checking `hasProcessMessage` avoids repeating it on the
separate result card.

That is how a page-link plugin can put the session's page link (`🔗 查看工作过程`) in the running card, keeps only
that panel on the collapsed process card when the turn finishes, and puts it on the single card of a turn that never
opened a process card. The renderer advertises `streamsMessage` in the renderer registry so that plugin knows its own
link message would be a duplicate. Nothing in this plugin names the link, the page server, or any other contributor:
without listeners the message is exactly what is built here.

## The stop control

The stop button is this plugin's own: its id is `summary:stop:<sessionId>`, and the plugin answers the click on `im/button`:
when the session is bound to the chat the button lives in, it calls `sessions.stop` (a failure is only logged). Cards
published before the renderer owned the button carry `dsh:stop:<sessionId>` and are handled the same way. With
`dsh-im-session-auth` mounted the button carries `dsh:auth-stop:<sessionId>` instead, and only the session's owner or
authorized collaborators may press it.

The click comes back with the person who clicked it, and the closing footer names
them — `1.2 秒 · 3 次工具调用 · 已由 @张三 取消`. A turn stopped another way (`/stop`, the GUI page) has no click to
attribute and says only `已取消`.

## Configuration

```yaml
- id: im-output-summary
  name: dsh-im-output-summary
  config:
    locale: zh
    maxChars: 4000
    intervalMs: 1200
    firstOutput: first-tool
    showStop: true
    progress: true
    progressFirstDelayMs: 5000
    progressIntervalMs: 20000
    progressMinSteps: 0
    progressMaxTokens: 2000
    progressReasoningEffort: off
```

| key | meaning |
| --- | --- |
| `locale` | reply language of the renderer's own lines (`zh` / `en`) |
| `maxChars` | answer characters shown at most, with a truncation note |
| `intervalMs` | minimum gap between two published states |
| `firstOutput` | `immediate` / `first-tool` (see above) |
| `showStop` | offer the `summary:stop:<sessionId>` control while the turn runs |
| `progress` | model-written progress summaries on platforms that can rewrite the message |
| `progressFirstDelayMs` / `progressIntervalMs` / `progressMinSteps` | cadence of those summaries |
| `progressMaxTokens` / `progressReasoningEffort` | bounds of one summary request (a fork inherits the turn's route otherwise) |
| `progressMaxChars` | characters of one summary |

## Dependencies

- `ctx.im` (required, `inject: ['im', 'llm', 'sessions']`): `outputs.register` for the renderer, `sessions.get` for the
  silencing call, `sessions.stop` and `im/button` for the stop control.
- `ctx.imCards` (optional, `dsh-im-card`): a ```` ```satori-tsx ```` block of the answer becomes a live card in place.
- `ctx.waterfall` (the event system): `im/streaming-message` is dispatched for every state of every streamed message.
- `ctx.tools` / `ctx.systemPrompt` (optional): `no_output` and its guidance.

## Tests

```sh
node --experimental-transform-types --import ./test/resolve.mjs --test "test/**/*.test.ts"
```

`test/resolve.mjs` resolves the harness peers from the checkout named there, so the renderer's timing paths can run
without a profile.
