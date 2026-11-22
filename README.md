# dsh-im-extras

Plugins for the IM host of [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) (`dsh-im`): what a
chat bot built on the harness needs beyond receiving and sending messages — per-chat sessions that hand real work to
task workers, a live progress message, interactive cards that render on Lark and on QQ, capability grants, a polish
pass over what the bot says, a sticker library and an operator panel to see all of it.

Every package is a standalone Cordis plugin. They couple only through the harness interfaces and each other's public
services, so a bot mounts the ones it wants.

| package | npm name | what it is |
| --- | --- | --- |
| [`im-dispatch`](packages/im-dispatch/README.md) | `dsh-im-dispatch` | One read-only router session per chat (or topic) with full incremental context; it answers small things itself and hands everything else to task workers. QuickJS route rules, per-chat wake/reply modes, thread follow-up, `/skill` commands and a cross-chat chronicle. Service: `ctx.imDispatch`. |
| [`im-session-tasks`](packages/im-session-tasks/README.md) | `dsh-im-session-tasks` | The task registry behind dispatch: a task per topic with its own session, its material and its tools. Service: `ctx.imTasks`. |
| [`im-output-summary`](packages/im-output-summary/README.md) | `dsh-im-output-summary` | Output renderer: one update-in-place message per turn with a live status line, a model-written progress summary, the answer so far and a stop button. |
| [`im-card`](packages/im-card/README.md) | `dsh-im-card` | Interactive cards written as TSX: a QuickJS VM per card, hooks, click handlers, snapshots that survive restarts, the `im_send_card` tool. Renders as Lark cards, and as QQ markdown + keyboard (resent instead of edited, with button-based forms). |
| [`im-session-auth`](packages/im-session-auth/README.md) | `dsh-im-session-auth` | Session exclusivity, collaborator access and an extensible capability grant system for task sessions. |
| [`im-polish`](packages/im-polish/README.md) | `dsh-im-polish` | Send-time wording polish on `im/before-send`: rewrites a text message in a configured style with the chat's recent messages in view, and holds back a message that repeats what the bot just said. |
| [`im-stickers`](packages/im-stickers/README.md) | `dsh-im-stickers` | Sticker library: upload or collect chat images, vision tagging, weighted pick with recent-use decay, `send_sticker` / `sticker_search`, and an optional sticker after the bot finishes talking. |
| [`im-qq-panel`](packages/im-qq-panel/README.md) | `dsh-im-qq-panel` | QQ official bot custom menu and command panels: configured sync (read first, write only differences, rate-limit stop), panels generated from the session commands and `/skill` commands, admin commands, the group-owner authorization command `/授权全消息`, and a panel tab. Service: `ctx.qqPanel`. |
| [`im-panel`](packages/im-panel/README.md) | `dsh-im-panel` | Operator panel inside the harness web GUI: overview, sessions, tasks, route rules, chat modes, chronicle — plus a tab API (`ctx.imPanel.tab(...)`) the other plugins use for their own tabs. |

## Status

`dsh-im` is not released yet. It lives on the harness's `feat/im-automation` branch, and these plugins track it. This
repository contains no harness source: the `@deepseek-ai/*` packages are optional peer dependencies, resolved from a
built harness checkout during development and from the harness's own `node_modules` when a profile mounts them.

## Working in it

Requirements: Node ≥ 24.9, pnpm 11, and a **built** harness checkout of the IM branch.

```sh
pnpm install
pnpm build       # every package, host and browser halves
pnpm typecheck
pnpm test
```

`scripts/harness-tsconfig.mjs` (run by `build` and `typecheck`) writes `tsconfig.harness.json`, which maps every
`@deepseek-ai/*` import to the declarations of that checkout. It uses `DSH_HARNESS_ROOT` when set, otherwise the first
path in an untracked `.harness-root` file, otherwise the first built checkout among `../deepseek-harness`,
`../dsh` and `./dsh`. Tests resolve the same checkout through
`scripts/test-resolve.mjs`.

## Mounting

A profile adds the packages it uses as dependencies (a tarball from `pnpm pack`, or a `link:` / `file:` path to a
built checkout of this repository) and a row per plugin in its `cordis.patch.yml`; each package README lists its
config. A typical group bot mounts `dsh-im-session-tasks`, `dsh-im-dispatch`, `dsh-im-output-summary` and
`dsh-im-panel`, then adds `dsh-im-card`, `dsh-im-polish` or `dsh-im-stickers` as it needs them.

## License

MIT
