# dsh-im-stickers

A sticker library for the [dsh-im](https://github.com/deepseek-ai/deepseek-harness) IM host: pictures the bot may
send as a reaction, described and tagged by a vision model, picked by weight with recently used stickers softened,
sent by tool or appended automatically when the bot finishes talking.

Everything uses standard dsh-im capabilities only, so it works with the official QQ bot and Lark adapters alike:
a sticker goes out as an ordinary image element (`<img src="file:…" alt="表情 #12 …">`), and the `alt` names the
sticker, so the chat history the agent reads later says which one it was.

## Getting stickers in

- **Panel upload** — `ctx.imStickers.upload([{ name, data }])`.
- **Collect from a chat** — a picture someone posted (`[图片 #12.1]` in the transcript) is stored with
  `sticker_collect { id: "12.1" }` or `ctx.imStickers.collect(chat, '12.1')`. The bytes are fetched through im-core's
  resource fetcher (`satori:` resources by the receiving bot's adapter, `data:`/`base64:` inline, `http(s)` without
  redirects). Because a chat member wrote the source, `file:` and hosts that are or resolve to loopback, private,
  link-local or multicast addresses are refused.

A picture is stored once (keyed by the SHA-1 of its bytes). New stickers are classified in the background when
`classify.provider`/`classify.model` name a vision-capable route and the `llm` and `attachments` services are
mounted: the model writes a one-line description of *what the picture shows* and picks 1–3 type tags for *what it
means*. A failure is recorded on the sticker (`error`) and never blocks the import; the panel can re-run a job.

## Picking and sending

`send_sticker` sends by id, or picks: with a hint, the eight best matches (description bigrams, type names and type
meanings) are drawn by score; without one, every enabled sticker is drawn by weight. Each candidate's weight is
multiplied by a recency factor (×0.25 within 5 minutes of its last use, ×0.6 within the hour, ×0.85 within the day)
and a ±15 % jitter, and the sticker last sent into that chat is excluded.

## The automatic sticker

The plugin listens to `im/stored`. Every own message of the bot restarts that chat's quiet timer; after `auto.gapMs`
(7 s) of silence the burst is over and, with probability `auto.percent`, one sticker of type `auto.tag` follows. A
burst in which the agent already sent a sticker never gets a second one, and other people's messages do not count.
The default rule makes it rarer on QQ (`bots: ['qq:'] → percent: 3`), whose official bot has a small passive-reply
quota. Per-chat rules and the panel's per-chat switch override it.

## Tools and prompt

| Tool | What it does |
|---|---|
| `send_sticker { id?, tags?, hint?, chat? }` | Send one sticker into the chat being answered (or a named chat the session may publish into) |
| `sticker_search { tags?, query?, limit? }` | List enabled stickers: id, tags, description, weight, uses |
| `sticker_collect { id, chat?, desc?, tags? }` | Store a chat picture as a sticker |

The `im:stickers` system prompt section (order 84, hosted sessions only, empty while the library is empty) lists the
types and the etiquette: a sticker is seasoning, not a reply. It deliberately does not mention the automatic sticker.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `dataDir` | `~/.dsh/im-stickers` | Sticker files and `thumbs/` previews |
| `types[]` | eight neutral types | `{ id, name, desc }`; `desc` is what the model reads |
| `minWeight` | `0` | Stickers below this weight are never picked without an explicit id |
| `auto.enabled` / `percent` / `gapMs` / `tag` | `true` / `8` / `7000` / `general` | The automatic sticker |
| `rules[]` | `[{ bots: ['qq:'], auto: { percent: 3 } }]` | Per chat: `chats`, `sources`, `bots` (exact id, or a `platform:` prefix); `auto` overrides |
| `classify.enabled` / `provider` / `model` | `true` / – / – | The vision classifier route |
| `classify.reasoningEffort` / `maxTokens` / `timeoutMs` / `concurrency` | cheapest / `3000` / `180000` / `3` | Classifier bounds |
| `magick` | `magick` | ImageMagick executable |
| `maxBytes` | 8 MiB | Largest sticker file |
| `tools` | all three | Tools registered |
| `prompt` | `true` | Register the prompt section |

### ImageMagick

With ImageMagick, each sticker gets a 240×240 PNG preview, and an animation is shown to the classifier as its first,
middle and last frame plus a 30-frame contact sheet. Without it, the size is read from the file header, the panel
shows the original, and the classifier receives the original bytes when the attachment store accepts the format
(PNG, JPEG, WebP, GIF) — an animation is then judged from what the model makes of the file.

## Panel tab

With [dsh-im-panel](../im-panel/README.md) mounted, the plugin adds the **表情库** tab (id `stickers`, order 60): a thumbnail grid filtered by type, untagged, enabled state and text, ordered by weight, uses, last use or age; inline editing of description, types, weight and the enabled switch; upload; collecting a chat picture by its media id; classification jobs with progress; batch enable / disable / weight / add or remove type / re-classify / delete; a test send; and the per-chat automatic-sticker switch and chance. The host half (`src/panel.ts`) answers every request of `/api/im-panel/tab?id=stickers` itself (images and multipart uploads included); the browser half is `src/client/index.tsx`, bundled to `client/client.js` by `pnpm run build:client`. Neither half depends on the panel package.

## API

`ctx.imStickers` (`ImStickersService`): `list(filter)`, `get(id)`, `stats()`, `types()`, `file(id, thumb?)`,
`upload(files)`, `collect(chat, mediaId)`, `update(id, patch)`, `updateMany(ids, patch)` (`weight`, `enabled`,
`tags`, `addTags`, `removeTags`, `desc`, `title`), `remove(ids)`, `classify(ids?, { force? })`, `job()`,
`cancelJob()`, `pick(options)`, `send(chat, id)`, `overrides()`, `setChat(chat, { enabled?, percent? } | undefined)`,
`autoOf(chat)`. Event `im-stickers/changed` reports added/changed/removed stickers and job progress.

## Limitations

- The automatic sticker is published without a session and without a quote; on a platform that only accepts passive
  replies (QQ groups without proactive quota) it may be refused, which is logged and otherwise harmless.
- Only `img` elements can be collected; a platform "sticker" that arrives as another element type is not supported.
- The SHA-1 key deduplicates identical bytes only: the same picture re-encoded by a platform is stored again.
