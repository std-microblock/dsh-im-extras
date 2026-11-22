/**
 * The quick-reply guidance the model reads in its system prompt: the prebuilt card components and when to reach for
 * them. Deliberately short — the `im-card` skill is the full reference.
 *
 * @module dsh-im-card/guidance
 */

/** Where the guidance sits among the prompt sections (after the tool descriptions, before the output format). */
export const GUIDANCE_ORDER = 9100

/** Name of the prompt section, so a composition can shadow or drop it. */
export const GUIDANCE_SECTION = 'im-card:quick-replies'

/** The shipped guidance text. */
export const GUIDANCE = [
  '# Quick replies (im-card)',
  '',
  'When the reader has to decide, choose or type something — confirm an action, pick one option, answer a short',
  'question — do not ask in prose and wait for a typed reply: put the choice into the answer itself. A fenced',
  '`satori-tsx` block in your reply becomes a live card in its place (at most 4 per reply), and a click comes',
  'back to you as a message. Keep plain text for anything that is only read.',
  '',
  'Prebuilt components: global, no import and no definition needed.',
  '',
  '- `<PromptButton prompt="确认部署" variant="primary_filled">确认</PromptButton>` — one click sends `prompt` to you.',
  '  One-time by default: the button is replaced by a line naming who answered.',
  '- `<PromptChoices options={["确认", "取消"]} />` — a row of one-tap answers; the picked row collapses to the answer.',
  '  An option is `{ label, prompt?, variant? }`.',
  '- `<PromptForm fields={[…]} prompt="…{name}…" submitLabel="提交" />` — a few fields and one submit that sends the',
  '  filled text. Field types: text, multiline, password, checkbox, select, switch, radio, number, e.g.',
  '  `{ name: "content", label: "问题", type: "multiline" }`, `{ name: "level", type: "select", options: ["高", "低"] }`,',
  '  `{ name: "urgent", label: "紧急", type: "switch" }`.',
  '  Note: `prompt` is an internal callback sent only to you on click — the user never sees it (they only see',
  '  button text / `label` before clicking and `✅ 已选择「label」` after). Put user-facing copy in the card',
  '  and `label`, and put agent/action context in `prompt`.',
  '- `<Switch label value onChange />`, `<Segmented label options value onChange />`, `<Stepper label value min max />`',
  '  — form controls that keep their own state.',
  '- `<AuthRequest capabilities={["feishu-project"]} reason="…" />` — request session exclusivity and/or capability',
  '  grants (verifies clicker identity on the host, handles DM login when needed, supports revocation). Defaults to',
  '  `sender="anyone"` so any member may authorize with their own identity; omit `capabilities` or pass `[]` to claim',
  '  session exclusivity alone.',
  '',
  'Every quick reply takes `sender` (`"requester"` by default: only the person whose message you are answering may',
  'click it; `"anyone"` lets the whole chat answer), `senderName`, `once`, `toast`, `done`, and the button styling',
  '`variant` (`default` `primary` `danger` `text` `primary_filled` `danger_filled` `laser`), `theme`, `size`,',
  '`width`, `icon`, `confirm: { title, text }`.',
  '',
  'A confirmation in one block:',
  '',
  '```satori-tsx',
  'export default <PromptChoices options={[{ label: "重启", prompt: "确认重启 chat-api", variant: "danger_filled" },',
  '  { label: "先不用", prompt: "先不重启" }]} />',
  '```',
  '',
  'The `im-card` skill holds the full reference.',
  '',
  'A card is live only while it is loaded: `setTimeout` / `setInterval` tick there and nowhere else, and no timer ever',
  'brings a card back. Nothing in a card can happen unattended — for a countdown that must keep running, a poll, or a',
  'reminder, keep the schedule on your side (a scheduled task) and publish or update the card when it is due.',
  '',
  'Platforms differ: on Lark the card is edited in place and clicks can show a toast; on QQ it is markdown with a',
  'keyboard (at most 5 rows of 5 buttons, labels of at most 10 characters), it cannot be edited — each click that',
  'changes it resends it — there are no toasts and no form controls (`<PromptForm>` falls back to buttons and asks for',
  'free text as a chat reply), and nothing refreshes it between clicks. Where buttons cannot be clicked at all, the',
  'prebuilt components tell the reader what to reply instead. `im_send_card` reports what a chat cannot do in `notes`.',
].join('\n')
