/**
 * Prompt texts: the sticker section of a hosted session's system prompt, and the classifier's instructions.
 *
 * @module dsh-im-stickers/prompt
 */
import type { StickerType } from './config.ts'

/** Name of the system prompt section. */
export const PROMPT_SECTION = 'im:stickers'
/** Its position: after the IM tool guidance (80). */
export const PROMPT_ORDER = 84

/**
 * The sticker section of a hosted session's prompt: the categories and the etiquette. The concrete library is a
 * `sticker_search` away rather than listed here. The automatic sticker is deliberately not described: the stickers
 * that go out are the bot's own, and explaining a mechanism invites the bot to talk about it in the chat.
 * @param types - the configured categories.
 * @param count - enabled stickers in the library.
 * @param tools - the sticker tools registered.
 * @returns the section text, or `''` when the library is empty or no tool is registered.
 */
export function stickerPrompt(types: readonly StickerType[], count: number, tools: readonly string[]): string {
  if (count === 0 || !tools.includes('send_sticker')) return ''
  const lines = types.map(t => `- ${t.name}（${t.id}）：${t.desc}`).join('\n')
  const search = tools.includes('sticker_search') ? '，或先用 sticker_search 看看有什么再指定 id' : ''
  const collect = tools.includes('sticker_collect')
    ? '\n- 聊天里有人发了好用的表情图、或有人让你收藏某张图当表情时，可以用 sticker_collect 把那张图（[图片 #12.1] 这种编号）收进表情库'
    : ''
  return `## 表情
可以发表情：send_sticker 让系统从表情库里挑一张${search}。表情库现在有 ${count} 张，分成这些类型（括号里是 id，tags 里用的就是它）：
${lines}

用法：
- 表情是调味，不是回复。不要每句话都配表情，更不要连着发；一个话题里偶尔来一张就够了
- 一段话说完时可以补一张收尾；被逗笑、无语、纯表态、接不上话的时候，只发一张表情、一个字都不写也是好回复
- 你发出去的表情都是你自己发的；有人问为什么发这个，就按当时的心情回答${collect}`
}

/**
 * System prompt of the classifier: one vision call per new sticker. `desc` describes only what the picture shows;
 * `tags` carry what it means. Mixing them makes both harder to search.
 * @param types - the configured categories.
 * @returns the system prompt.
 */
export function classifySystem(types: readonly StickerType[]): string {
  return `你在给聊天机器人整理表情库。给你一张表情的画面，写一句话描述它，并判断它表达什么情绪。只输出 JSON。

可选的类型（tags 只能用这些 id）：
${types.map(t => `- ${t.id} ${t.name}：${t.desc}`).join('\n')}

输出格式：
{"tags": ["id", "..."], "desc": "一句话描述"}

desc（只描述画面本身）：
- 写这张表情长什么样：主体是什么、什么表情、什么动作、什么画风。例如「盖着被子躺在床上的小鲸鱼」「黑白线条的猫双手捂脸」
- 不要写它表达什么情绪、适合什么场合——那是 tags 的事；不要出现「表示…」「适合…」「用来…」这类说法
- 不写尺寸、像素、格式、出处、画质；画面里的文字可以照抄
- 不超过 20 个字
- 如果是动图（会给你多张画面和一张网格图），可以描述整个动作过程

tags：
- 从上面的 id 里挑 1~3 个，按主要程度排序。同一张表情在不同语境都能用的话，带上通用类型；实在都不像才用 other

不要输出 JSON 以外的任何内容`
}

/**
 * The text that accompanies the pictures of one sticker.
 * @param frames - how many pictures follow.
 * @returns the user text.
 */
export function classifyUser(frames: number): string {
  const what = frames <= 1
    ? '这是一张静态表情。'
    : `这是一张动图，按顺序给你 ${frames} 张图：前几张依次是第一帧、中间帧、最后一帧，最后一张是把整段动画均匀采样拼成的网格图（从左到右、从上到下是时间顺序）。`
  return `${what}给这张表情打类型标签，并写一句话描述。`
}

/**
 * Extract the first JSON object from a model answer (tolerates fences and prose around it).
 * @param text - the answer.
 * @returns the parsed object, or undefined.
 */
export function parseJsonLoose<T>(text: string): T | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try { return JSON.parse(text.slice(start, end + 1)) as T } catch { return undefined }
}

/**
 * Read one classifier answer.
 * @param text - the model's answer.
 * @param types - the configured categories; unknown tags are dropped.
 * @returns up to three known tags and a one-line description (either may be empty).
 */
export function parseClassification(text: string, types: readonly StickerType[]): { tags: string[]; desc: string } {
  const parsed = parseJsonLoose<{ tags?: unknown; desc?: unknown }>(text)
  const known = new Set(types.map(t => t.id))
  const tags = Array.isArray(parsed?.tags)
    ? [...new Set(parsed.tags.map(t => String(t).trim()).filter(t => known.has(t)))].slice(0, 3)
    : []
  const desc = String(parsed?.desc ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
  return { tags, desc }
}
