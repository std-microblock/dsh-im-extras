# dsh-im-card

Interactive IM cards written as React-like TSX, for Lark and QQ. An agent publishes a card; people click its buttons;
the card updates itself and keeps its state across restarts. A card is written once in the platform-neutral satori
element vocabulary; the IM adapter renders it (a Lark card, or QQ markdown with a keyboard).

## How it works

- **Source.** A card is a TSX module whose default export is a component (or an element). It may import
  `dsh:card` (the hooks) and relative `.tsx`/`.ts`/`.js` files; nothing else. JSX is transpiled on the host by
  `src/jsx.ts`, which follows the semantics of quickjspp's `quickjs-jsx.h` (`__jsx__(tag, attrs, kids)`, three
  arguments always, upper-case tags are references); TypeScript types are stripped by Node's
  `stripTypeScriptTypes`. The entry and every import are compiled once when the card is published and stored with
  it (`src/bundle.ts`), so a card never changes when its files do.
- **Runtime.** Each card runs in its own QuickJS VM (`quickjs-wasi`) with the in-VM runtime built from `src/vm/`:
  `useState`, `useReducer`, `useEffect`, `useLayoutEffect`, `useMemo`, `useCallback`, `useRef`, `useId`, `useCard`
  (`toast`, `close`, `send`), `useStoredState`, `fs`, `fetch`, timers, `console`, `agent.send`. There is no virtual DOM:
  a state change re-renders the whole tree and the host republishes the whole card message (an in-place edit paced by
  `editIntervalMs` where the platform edits messages; see *Platforms* for the others).
- **Buttons and controls.** A `<button onClick>` gets a random token per element position; its id on the platform is
  `dsh:card:<cardId>:<token>`. A click reaches `ctx.im`'s `im/button` event, the service runs the handler in the VM,
  answers the platform callback where it has one (with the toast the handler showed) and then edits the message. A `<select onSelect>` and a
  checkbox `<input type="checkbox" onChange>` get a token the same way and arrive as `im/select` / `im/check`; a
  `<button type="submit">` inside a `<form>` is an ordinary routed button whose event also carries the form's values.
- **Persistence.** All state is VM memory. After a change the service snapshots the whole VM: the memory is XORed
  with a pristine VM's memory (same wasm + runtime build) and zstd-compressed — 20–40 KB per card — and stored in
  the `im_cards` storage domain (`per-record`). Beyond `maxLive` VMs the least recently used card is snapshotted and
  freed, and **only a click revives it** (`wakeOnTimer` off by default). A revived card is snapshotted again, so what
  is stored describes the VM that is actually running. A snapshot of another build cannot be restored: the card re-runs
  its bundle from its initial state, that one click is dropped and the card is republished with fresh buttons.
- **Timers.** `setTimeout` / `setInterval` are the card's own: they tick while its VM is loaded and stop when the VM is
  freed or the process ends. They never revive a card, so a card cannot do anything unattended — a countdown that has to
  keep ticking, or a poll, keeps its schedule on the agent's side and the agent publishes or updates the card when it is
  due. `wakeOnTimer` turns the old behaviour back on (a due timer revives the card); it stays off unless a deployment
  really wants cards that hold a VM for their own timers.
- **Talking to the agent.** `agent.send(text)` / `useCard().send(text)` delivers a `steer` message to the session
  that published the card, prefixed with `<im-card id user user-id />`; rate-limited (`agentPerMinute`).
- **Files and network.** A card reaches the outside world through two host doors, both bounded. `fs` reads and writes
  files under one folder — `dataDir` relative to the publishing session's working directory — and refuses absolute
  paths, `..` and links that leave it (`src/data.ts`); `useStoredState(path, initial)` keeps one JSON value there, so
  it outlives the VM snapshot. `fetch` sends one HTTP(S) request, settled back into the VM when it answers: hosts and
  private addresses are checked on every redirect hop, and the timeout, response size, per-minute and in-flight counts
  are the operator's (`src/http.ts`). A request still in flight when its card is evicted is dropped with the VM.

## Quick replies (presets)

Six components belong to the card vocabulary — no import, no definition: `PromptButton`, `PromptChoices`,
`PromptForm`, `Switch`, `Segmented`, `Stepper`. They live in the VM runtime (`src/vm/presets/`, written in TSX) and are
declared in `types/dsh-card.d.ts` as globals (and as `dsh:card` exports), so a card writes

```tsx
export default <PromptChoices options={[{ label: '确认发布', prompt: '确认发布 v1.2.3' }, '先不']} />
```

and a click arrives at the agent as an `agent.send` message. A used control is replaced by a line naming who answered
(`✅ 已选择「确认发布」 · 张三`) unless `once={false}`; a form sends its filled template (`提交`) and then shows the
answer it sent.

`sender` defaults to `"requester"`: the host tells each card who it answers — the trigger sender of a `satori-tsx`
card's turn, or the newest message a person wrote in the target chat for `im_send_card` — and stores it with the card in
`im_cards`, so the card can restrict its buttons to that person and name them without an extra API call. A bot is never
that person: a turn an alert webhook (or any other bot) started leaves the card naming nobody, so its buttons answer
whoever is reading the chat — a bot cannot press one, and naming it would leave the card unanswerable in the whole chat.
`sender="anyone"` opens a card to the whole chat, `sender="<platform user id>"` names one person.

`<PromptForm>` draws its button fields (`switch`, `radio`, `number`) above the platform `<form>`, because a Lark
form holds form components only; the submit click carries the native controls' values and the button fields come from
the component's own state.

The guidance the model reads from the start of a session is `src/guidance.ts` (prompt section
`im-card:quick-replies`), replaceable through the `guidance` config field. `im-card` skill + `im_card_types` carry the
full reference.

## Platforms

What a platform can do with a card is probed from its adapter (`src/platform.ts`), handed to the card as
`useCard().platform` (`edit`, `buttons`, `forms`, `toast`) and reported to the model in `im_send_card`'s `notes`,
together with what the dry render dropped (`INTERACTION_DROPPED`, degraded elements, shortened labels).

| | Lark | QQ (markdown + keyboard) |
| --- | --- | --- |
| republish after a change | in-place edit (`PATCH`), paced | recall the old message (within the platform's 2-minute window) and answer the click with a new one through `ctx.im.send` (stored and attributed like the first publication; a passive reply through the click's `referrer`), at most `replaceLimit` per card per 5 minutes |
| refresh without a click (timer, `fetch`, host event) | yes | no: the change shows with the next click; `wakeOnTimer` never revives such a card |
| clicks on an older copy | — | refused: the card lives in the newest message |
| toast | yes (`ButtonEvent.respond`) | no; `toastFallback: text` turns it into a one-line reply |
| `<form>` / `<input>` / `<select>` | native | `<PromptForm>` uses buttons: select → option row, checkbox → switch, text → a chat reply (with an input-filling keyboard button) |
| buttons | card buttons | keyboard: 5 rows × 5, labels ≤ 10 characters, data encoded `id:data` |

A QQ client sometimes reports a click without the button id; the card id is then read from the button data. Without
keyboard permission (QQ `keyboard: false`) buttons render as text: the quick replies then name what to reply, and a
form becomes a reply template.

## Two ways to publish

1. **`im_send_card({ path, props?, chat?, quote? })`** — a standalone card message from a file in the session's
   working directory (registered where `tools`, `fs` and `workingDirectory` exist).
2. **A ```` ```satori-tsx ```` block inside a streamed answer** (`dsh-im-output-summary`): the block becomes a card in
   the turn's own message, where the block stands. The card appears once its closing fence arrives and shows only
   while the answer does (not while a progress summary replaces it). After the turn ends the card service owns the
   message and republishes it — text, cards and footer — on every card change.

The `im-card` skill (`skill/SKILL.md`, registered as a runtime skill) teaches the model the vocabulary, button-based
layouts (segmented choices, steppers, tabs, pagination, confirmations) and the limits.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `maxLive` | 32 | VMs kept in memory |
| `memoryBytes` | 16 MiB | heap of one VM |
| `cpuMs` | 1000 | CPU time of one entry into a VM (render, click, timer) |
| `editIntervalMs` | 1000 | minimum interval between two edits of one message |
| `snapshotDelayMs` | 1500 | debounce of the snapshot after a change |
| `wakeOnTimer` | false | let a due timer revive a card that is not in memory; off means only a click revives it |
| `maxModules` / `maxSourceBytes` | 16 / 256 KiB | bundle bounds |
| `agentPerMinute` / `agentMaxChars` | 6 / 2000 | `agent.send` bounds |
| `maxSlotsPerTurn` | 4 | inline cards per streamed message |
| `dataDir` | `.dsh/im-card/data` | folder cards read and write, relative to the publishing session's working directory (or absolute); `''` takes file access away |
| `filesMaxBytes` | 1 MiB | largest file one `fs` call reads, writes or appends |
| `fetchTimeoutMs` / `fetchMaxBytes` | 10 s / 512 KiB | budget of one `fetch`, redirects included, and its response cap |
| `fetchPerMinute` / `fetchConcurrent` | 20 / 3 | `fetch` bounds per card |
| `fetchHosts` | `[]` (any) | host names a card may reach, `*` matching any span |
| `fetchAllowPrivate` | false | allow loopback, private and link-local addresses |
| `replaceLimit` | 5 | resends per card per 5 minutes where the platform cannot edit (QQ) |
| `toastFallback` | `ignore` | where clicks cannot be answered with a toast (QQ): `ignore` it, or send it as a one-line `text` reply |
| `guidance` | shipped text | system-prompt guidance on the quick replies (`src/guidance.ts`); `''` leaves the section out |

## Development

```sh
pnpm install
pnpm run build     # tsc (host) + tsc (the VM project) + esbuild → dist/vm/runtime.js
pnpm test          # transpiler, runtime (in real QuickJS), engine, service lifecycle, every skill example
```

### The VM runtime

`src/vm/` is a TypeScript project of its own, not part of the host build:

- **One script, not modules.** The VM has no module system, so the runtime must arrive as a single script whose
  top-level code installs the globals a card uses. `scripts/build-vm.mjs` bundles `src/vm/index.ts` with esbuild
  (`format: 'iife'`) into `dist/vm/runtime.js`; `src/engine.ts` evaluates that file. The output is deterministic —
  the engine fingerprints it, and a snapshot taken against another build cannot be restored, so the card re-runs its
  bundle instead.
- **No host types.** `src/vm/tsconfig.json` sets `lib: ES2023` and `types: []`: inside the VM there is no `process`, no
  `fs` and no DOM, and a host API that slipped in fails the type-check instead of failing at click time. The VM's own
  globals are declared in `src/vm/globals.ts`, and `globalThis.__host` is the only way out.
- **Layout.** `host.ts` (the bridge, `console`), `timers.ts`, `jsx.ts` (vnodes, `__jsx__` / `__h__`), `context.ts` +
  `hooks.ts` + `render.ts` (instances, hooks, the walk, interaction tokens), `actions.ts` (`agent.send`, `useCard`),
  `files.ts` (`fs`, `useStoredState`), `http.ts` (`fetch`), `presets/` (the six preset components, in TSX).
- **TSX.** The presets compile with esbuild's classic factory to `h(tag, props, …children)` — the same shape a card
  bundle compiles to (`__h__`), so a preset is written exactly like the cards it serves. Their props mirror
  `types/dsh-card.d.ts`, the declarations a card is type-checked against; keep the two in step.

The harness features this relies on: the click answer (`ButtonEvent.respond` / `defer`), the Lark button attributes,
`Bot.handleOf` (edit a message after a restart), `Bot.render` reports (capability probes and `notes`), and the
`form` / `input` / `select` vocabulary with its `interaction/select` and `interaction/check` events plus
`ButtonEvent.values`.

## Known limitations

- A `<select onSelect>` reports every pick (a `multiple` one included) and a checkbox reports every toggle; a text
  `<input>` never reports itself — its value reaches the card only when the `<form>`'s submit button is clicked
  (`event.values`). A card cannot re-read a field afterwards, so a control outside a `<form>` needs a callback of its
  own; without one the render reports the interaction as dropped.
- Lark and QQ give a card callback only the clicker's platform user id, so `event.user.name` is absent; show people
  with `<at type="user" id={event.user.id} />`.
- A Lark card is editable for 14 days; after that clicks still run but the message no longer changes.
- On QQ `im_update_card` shows the new code only by answering the card's last click, else with the next click.
- On QQ a card inside a streamed answer (`satori-tsx`) is republished with the whole answer message around it: a
  click that changes it resends the answer too.
- Per-viewer cards (Lark exclusive cards / ephemeral messages) are not implemented.
- A card's files live in one folder per working directory, shared by every card published from it: there is no
  per-card namespace, so a card that must not collide takes its path from `props`. File calls are synchronous, so a
  large read or write delays that card's own entry (bounded by `filesMaxBytes`).
- A `fetch` still in flight when its card is evicted, closed or reloaded never settles — the VM that waited for it is
  gone, and a snapshot restored afterwards keeps the promise pending. A card that must not lose an answer reports it
  with `agent.send` instead of keeping it in the promise.
