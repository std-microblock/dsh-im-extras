# dsh-im-polish

Send-time wording polish for the [dsh-im](https://github.com/deepseek-ai/deepseek-harness) IM host, and the ceiling
on one plain text bubble.

A session's text message is rewritten in a configured style right before it goes out — one fixed **main style**
plus a few **sub-styles** drawn at random for every send — so successive messages do not all sound alike. The
rewrite sees the chat it lands in: the last few messages (the bot's own included) and, listed apart, the bot's own
last messages with the instruction not to sound like them. A message that only repeats what the bot just said is
held back, and one that would go out as a plain text bubble longer than `limits.maxTextChars` (120 by default) is
refused: it belongs in a markdown message or in an image.

## How it works

The plugin listens to the `im/before-send` waterfall of dsh-im (`ctx.im.send` only — streams and replayed operation
ids are never rewritten):

0. **Text bubble ceiling** (`limits.maxTextChars`, default 120). A message the platform will draw as one plain text
   bubble may not be longer than that, whatever this chat's polish switch says: over the ceiling the send is
   **dropped** with a reason the agent can act on — write it as markdown (headings, lists, code, tables, links; the
   platform renders those), render it with typst and publish the picture with `im_send_file`, or cut it down. A message
   that really is markdown is not measured (see `src/markdown.ts` for what counts as markdown: the constructs a
   text-only renderer has no handler for), and neither is an image, a card or a file.
1. **Eligibility.** For the polish, only plain text and markdown are touched: a string, `<text>`, `<br>`, `<markdown>`,
   optionally in one `<message>` root next to a `<quote>`. Messages with images, files, cards, buttons or mention
   elements, code blocks, tables, more than `limits.maxLines` lines or `limits.maxInputChars` characters go out as
   written.
2. **Rewrite.** One short model call (system prompt + one user message holding `<recent-chat>`, `<bot-recent>` and
   `<draft>`). The route is `model.provider`/`model.model`, or the sending session's own route when those are unset.
   No output-token cap is set: the route's own budget applies, so a reasoning model that thinks first still has room
   for the sentence.
3. **Safety check** (`checkStyled`): a rewrite that loses a link, a markdown target, a mention, inline code or a
   number, or adds a line, is discarded and the original goes out. Length is not checked here; a rewrite that outgrows
   the text bubble ceiling is discarded instead and the draft goes out.
4. **Repeat guard**, two layers:
   - *prompt*: the model may answer with the skip marker (`<no-send/>`) when the draft's substance repeats one of the
     bot's recent messages. The marker is honoured only when the draft really is close to one of them
     (`repeat.modelDropMinSimilarity`), so a confused model cannot silence new content;
   - *hard check*: the outgoing text is compared with the bot's recent messages (character-bigram Sørensen–Dice on a
     normalized key: no mentions, media labels, whitespace or punctuation). At or above `repeat.threshold` (0.82) the
     rewrite is retried once with feedback naming the message it resembles; still too close, the original goes out if
     it is not a repeat itself, otherwise the send is **dropped**. The caller then gets
     `{ status: 'failed', dropped: true, error: '…' }` with a reason the agent can act on ("this repeats what you said
     a moment ago … do not resend").
5. **Log.** Every decision (original, result, action, reason, similarity, model answers) is stored in the `im_polish`
   storage domain, bounded by `maxRecords`.

One chat's sends are decided one at a time, so the second of two quick messages is compared with the first even before
the first is stored. A failed or timed-out model call sends the original (still subject to the repeat check); a
listener error never costs the agent its message.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Global switch; rules and panel switches refine it per chat |
| `style.main` | neutral IM style | The style every rewrite follows |
| `style.subs` | six neutral hints | Pool drawn from per send; phrase each as optional ("如有需要，…") |
| `style.pickMin` / `pickMax` | `1` / `2` | Sub-styles drawn per send |
| `rules[]` | `[]` | Per-chat rules: `chats` (key or bare id), `sources`, `bots`, `presets`, `owners`; `enabled`, `style`, `note`. All matching rules apply in order |
| `model.provider` / `model.model` | the session's route | Route of the rewrite call |
| `model.reasoningEffort` | cheapest offered (`off`, else `low`) | Reasoning effort |
| `model.temperature` / `timeoutMs` | `1` / `20000` | Sampling and deadline (no output-token cap: the route decides) |
| `context.messages` | `12` | Recent chat messages shown |
| `context.botMessages` | `5` | The bot's own messages listed and compared |
| `context.maxChars` | `200` | Characters of one context message shown |
| `repeat.threshold` | `0.82` | Similarity counted as a repeat |
| `repeat.minChars` | `8` | Shorter normalized texts are never compared |
| `repeat.windowMs` | 30 min | How far back the bot's messages count |
| `repeat.retry` / `drop` | `true` / `true` | Retry with feedback; drop a remaining repeat |
| `repeat.modelDrop` / `modelDropMinSimilarity` | `true` / `0.45` | Honour the skip marker, and when |
| `limits.maxInputChars` / `maxLines` / `minChars` | `400` / `6` / `1` | Polish eligibility bounds |
| `limits.maxTextChars` | `120` | Longest plain text bubble; longer content must be markdown or an image |
| `skipMarker` | `<no-send/>` | The do-not-send answer |
| `maxRecords` | `1000` | Records kept for the panel |

### Example: a playful group-chat persona

```yaml
- dsh-im-polish:
    style:
      main: IM 交流风：每句话尽可能简短，可以用空格代替逗号、句号等，避免使用冗余专有名词，可以用「」作为引用，避免使用「不是…而是…」这类句式
      subs:
        - 如有需要，可以用「瓦/呀/哇/哈？」等来软化语气
        - 如有需要，可以用「~」来表示拖长
        - 如有需要，可以用（）来更贴近网络用语
        - 如有需要，可以用颜文字（不是 emoji）来更贴近网络用语
        - 如有需要，可以省掉主语、只留关键词（「版本？」「截图看看」）
        - 如有需要，可以用「欸/哦哦/嗯」这类短促的词开头
        - 如有需要，可以把一句话拆成两口气，中间用空格断开
        - 如有需要，可以用反问代替陈述（「不是这样？」「真的假的」）
        - 如有需要，可以用「emmm/呃/啊这」表示犹豫或者接不上话
      pickMin: 1
      pickMax: 3
    model: { provider: deepseek, model: deepseek-chat, temperature: 1 }
    rules:
      - sources: [work-lark]     # a work chat keeps the agent's own wording
        enabled: false
```

## Panel tab

With [dsh-im-panel](../im-panel/README.md) mounted, the plugin adds the **润色** tab (id `polish`, order 50): every decision with the text before and after side by side, the dropped sends with the reason the agent read and the message they resembled, the drawn sub-styles and raw model answers, filters by chat / action / text, counts per reason, a per-chat on/off switch, and a preview box that shows what a sentence would become without sending it. The host half (`src/panel.ts`) answers `GET`/`POST /api/im-panel/tab?id=polish`; the browser half is `src/client/index.tsx`, bundled to `client/client.js` by `pnpm run build:client` (served as the package's `./client` export). Neither half depends on the panel package: both describe its API structurally.

## API

`ctx.imPolish` (`ImPolishService`):

- `records({ chat?, action?, query?, before?, limit? })` — decisions, newest first; `record(id)`; `stats({ chat?, since? })`;
  `clear({ chat? })`.
- `overrides()` / `setChat(chat, enabled | undefined)` — the panel's per-chat switch (overrides the rules).
- `chatState(chat)` — the effective switch, style and note of a chat.
- `preview(chat, text, session?)` — what the polish would do, without sending or recording.
- Event `im-polish/record` — emitted for every recorded decision.

The pure parts are exported for reuse and tests: `decide`, `checkStyled` / `acceptStyled`, `pickSubStyles`,
`readAnswer`, `similarityKey`, `diceSimilarity`, `mostSimilar`, `textContent`, `polishSystem`, `polishUser`.

## Limitations

- Bigram Dice measures wording, not meaning: a repeat in entirely different words passes the hard check (the prompt
  layer is what catches those), and two different short answers on one narrow topic can score high — raise
  `repeat.minChars` or `repeat.threshold` if legitimate messages get dropped.
- Each polished send waits for one model call (two when it is retried); a slow route delays every text message by
  that much, bounded by `model.timeoutMs`.
- Streams (`ctx.im.stream`, the summary renderer's live card) are never polished.
