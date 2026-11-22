# dsh-im-qq-panel

QQ 官方机器人的「自定义菜单」与「指令面板」，以及群主授权指令 `/授权全消息 <群号>`，作为 DeepSeek Harness IM 宿主
（`dsh-im`）的插件。由 [koishi-plugin-qq-menu-panel](https://github.com/std-microblock/koishi-plugin-qq-menu-panel)
移植而来。

- 平台文档：<https://bot.q.qq.com/wiki/develop/api-v2/server-inter/menu-panel/>
- 接口：`GET/PUT /v2/menu`、`GET/POST /v2/panels`、`GET/PUT/DELETE /v2/panels/{panel_id}`、`PUT /v2/panels/{panel_id}/target`
- 请求全部走 QQ 适配器（`@deepseek-ai/cordis-plugin-im-adapter-qq`）自己的鉴权 REST 客户端 `bot.api.request(method, path, { data })`：
  复用适配器的 endpoint、access token 与 `X-Union-Appid`，本插件不保存任何凭据。

## 功能

1. **配置式同步**：在插件配置里声明菜单项与面板，QQ 机器人上线后（默认延迟 5 秒，等命令来源挂载）自动与平台对齐。
   - 先读平台现状再决定是否下发，内容一致时**不发写请求**（菜单写入限频 5 次/分钟、面板 10 次/分钟）。
   - 平台限频（`err_code 40023001` 或 HTTP 429）时立即停止本次剩余面板写操作并给出提示，下次同步继续。
   - 只管理备注带前缀（默认 `dsh:`）的面板；平台上手工配置的面板不会被修改，`prune` 默认关闭。
   - 菜单配置为空且 `allowEmptyMenu=false` 时不下发空菜单，避免清掉平台已有菜单。
   - 平台不支持修改面板的生效场景（scope）与作用范围（target_type），两者与配置不一致时**先删除再重建**同一个面板。
   - `targetType: specific` 面板的 openid 列表差异用 `PUT /v2/panels/{id}/target` 增删（每次最多 20 个，自动分批）。
2. **按命令生成面板**（`panels[].source: commands`，默认）：从 dsh 侧可得的命令来源生成面板元素——
   - `session`：`dsh-im-session-commands` 的内置命令 `/help /status /new /clear /stop`。该插件不公开命令列表，
     所以在本插件配置 `commands.session` 里声明（默认就是这 5 个，描述与它的中文帮助一致；没挂这个插件时设为 `[]`）；
   - `skills`：`dsh-im-dispatch` 的 `/skill` 命令（`ctx.imDispatch.skills()`：用户可调用的技能及其别名），
     挂了 dispatch 才有；技能目录变化（`skills/change`）后会自动重新同步面板（`resyncOnSkillChange`）；
   - `extra`：配置 `commands.extra` 里声明的其它命令。

   元素名称取「前缀 + 能放进 14 个字符的名字或别名」，中文别名优先；描述截断到 30 个字符（中文按 2 计）。
   每个面板可用 `sources` 选来源、`include`（排在前面，`*` 通配，可按别名命中）、`exclude`、`maxItems`、`extraItems`
   （追加链接等）。放不下的命令会在同步结果和 `/qqpanel` 里给出警告。
3. **管理指令**（只有 `admins` 里的用户可用，在 `im/message` 瀑布最前面处理，其他消息原样放行）：

   | 指令 | 别名 | 作用 |
   | --- | --- | --- |
   | `/qqmenu` | `/qq菜单` | 查看平台菜单与配置差异 |
   | `/qqmenu.sync` | `/qqmenu sync`、`/qq菜单同步` | 按配置下发菜单 |
   | `/qqpanel` | `/qq面板` | 列出平台面板、配置面板（含生成结果）与待处理动作 |
   | `/qqpanel.sync` | `/qqpanel sync`、`/qq面板同步` | 按配置下发面板 |
   | `/qqpanel.group` | `/qqpanel group`、`/面板群号` | 在群里使用：返回本群 openid 及各 group 面板是否覆盖本群 |
   | `/qqpanel.delete <panel_id>` | `/qqpanel delete <id>`、`/qq面板删除 <id>` | 删除指定面板 |
   | `/qqsync` | `/qq同步` | 同时下发菜单与面板 |

   群里要 @机器人。中文指令名不在 dsh-im 核心的命令解析范围内（它只解析 ASCII 名称），本插件自己从消息文本里解析。
4. **群主授权 `/授权全消息 <群号>`**（别名 `/qqauth`，所有人可用）：见下一节。
5. **运维面板 tab**：挂了 [`dsh-im-panel`](../im-panel/README.md) 时多一个「QQ 菜单面板」tab，显示平台菜单、平台面板、
   配置面板（含生成结果）与待处理动作，可一键同步 / 只同步菜单 / 只同步面板 / 演练 / 删除面板。

## 群主授权：`/授权全消息 <群号>`

让官方机器人在某个群「获取群内全部消息」（不用 @ 也能收到）并允许「主动在群聊内发言」。

- **机器人身份由配置提供**：`authorize.botUin`（QQ 号）与 `authorize.botUid`（`u_` 开头的 UID）。插件不内置任何身份。
- **用 link 按钮跳转**：回复里的「群主点此授权」是 `type=link` 按钮，指向
  `https://club.vip.qq.com/transfer?open_kuikly_info=<encodeURIComponent(JSON)>`，
  JSON 为 `{"page_name":"ai_group_service_agreement_pop_page","groupCode":<群号>,"botUin":<QQ号>,"botUid":"<UID>","screen":1}`。
  正文不含链接（官方机器人发裸链接会被拦截）；非 QQ 平台才以纯文本附上地址。
  按钮需要 QQ 适配器开启 `markdown` 与 `keyboard`。
- **参数是群号**：官方机器人只拿得到群 openid，拿不到真实群号，所以由用户填写；每个群授权一次即可。
  支持全角数字与空格，5～12 位；不带参数或格式错误时回复「怎么找到群号」教程图 + 「填写群号」按钮。
- **按钮卡片发送失败时**（`event.reply` 失败或抛错）改发纯文本兜底，只给手动设置路径。先发图片再发按钮卡片。
- 只有群主能完成授权（平台限制），需要手机 QQ 9.2.90 及以上。
- 教程图随包放在 `assets/`，以 `file:` 地址交给适配器上传：

  | 文件 | 何时发送 | 内容 |
  | --- | --- | --- |
  | `assets/authorize-guide.png` | 带群号时 | 发指令 → 群主点按钮 → 授权弹窗选「获取群内全部消息」、打开主动发言、同意授权 |
  | `assets/manual-guide.png` | 带群号时 | 按钮打不开时的手动路径：群成员列表 → 机器人资料页齿轮 → 设置 |
  | `assets/group-code-guide.png` | 缺群号 / 群号无效时 | 群聊设置里找群号，并带上群号重新发送 |

  图片由 `guides/*.html`（仿手机 QQ 界面的示意图，全部是占位内容，不含真实截图）经 `node guides/render.mjs` 生成
  （需要 `puppeteer-core` 与本机 Chrome）；模板里的机器人昵称/头像/QQ 号是占位符，可以用 `BOT_NAME` / `BOT_AVATAR` /
  `BOT_UIN` 环境变量换成自己的。

### 怎么拿到 `botUin` / `botUid`

- **`botUin`（机器人 QQ 号）**：手机 QQ 群里打开机器人资料页（见 `assets/manual-guide.png` 第二格），资料页直接显示 QQ 号。
- **`botUid`（`u_` 开头的 UID）**：拿任意一条已有的群主授权链接（`https://club.vip.qq.com/transfer?open_kuikly_info=...`），
  把 `open_kuikly_info` 的值 `decodeURIComponent` 后就是 JSON，里面有 `botUin` 与 `botUid`；
  也可以用 QQNT / NapCat 一类客户端的本地接口按 QQ 号查询 UID（取值方式之一，本插件不需要）。

两项必须是**同一个**机器人，填错时授权页打不开或授权到别人身上。它们不是机密，但属于部署配置，不要提交到公开仓库。

## 配置

```yaml
plugins:
  - name: dsh-im-qq-panel
    config:
      botId: ''                 # 只管理这个 QQ 机器人（qq:<AppID>）；留空 = 所有 QQ 机器人
      admins: ['<管理员 openid>'] # 管理指令的用户；也可写 '<botId>|<openid>'
      autoSync: true
      panels:
        - key: c2c              # 单聊面板：session 内置命令 + /skill 命令
          scope: c2c
        - key: group
          scope: group
          include: [help, status]
          exclude: [stop, clear]
      menu:
        items:
          - { type: send_message, name: 帮助, sendMessage: /help }
      authorize:
        botUin: '<机器人 QQ 号>'
        botUid: '<机器人 UID，u_ 开头>'
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `botId` | `''` | 限定机器人 id（`qq:<AppID>`），留空对全部 QQ 机器人生效 |
| `autoSync` | `true` | 机器人上线后自动对齐；关闭后只能手动 `/qqsync` 或在面板里同步 |
| `autoSyncDelayMs` | `5000` | 上线后延迟多久同步（等 dispatch 等命令来源挂载） |
| `resyncOnSkillChange` | `true` | 技能目录变化后重新同步用到 `skills` 来源的面板（防抖 ≥ 10 秒） |
| `dryRun` | `false` | 只计算并记录差异，不写平台 |
| `prune` | `false` | 删除备注带前缀但配置已移除的面板 |
| `allowEmptyMenu` | `false` | 菜单配置为空时也下发空菜单（会清空平台菜单） |
| `remarkPrefix` | `dsh:` | 面板备注前缀，也是「本插件管理」的识别依据 |
| `admins` | `[]` | 管理指令的用户：平台用户 id（QQ 群里是成员 openid），或 `botId|userId` |
| `commandPrefix` | `/` | 生成面板元素的命令前缀 |
| `commands.session` | 5 个内置命令 | `dsh-im-session-commands` 的命令 `{ name, aliases, description, onlyAdmin }[]` |
| `commands.skills` | `true` | 读取 `ctx.imDispatch.skills()` |
| `commands.extra` | `[]` | 其它命令 |
| `menu.items[]` | `[]` | `type`：`send_message` / `link` / `switch` / `menu`；名称 ≤ 10 字符（中文算 2）；仅单聊生效 |
| `panels[].key` | 必填 | 本地标识，生成备注 `<remarkPrefix><key>` 并据此匹配平台面板 |
| `panels[].scope` | `c2c` | `c2c` / `group` / `channel` / `dm` |
| `panels[].targetType` | `all` | `all` 或 `specific`（仅 c2c/group，需 `userOpenIds` / `groupOpenIds`） |
| `panels[].panelId` / `remark` | — | 按 ID 绑定已有面板 / 自定义备注 |
| `panels[].source` | `commands` | `commands` 按命令来源生成；`manual` 用 `items` |
| `panels[].sources` | 全部 | `session` / `skills` / `extra` |
| `panels[].include` / `exclude` | `[]` | 命令排序优先 / 排除（`*` 通配，名称或别名） |
| `panels[].maxItems` | `20` | 元素上限（含 `extraItems`） |
| `panels[].prefix` | `commandPrefix` | 本面板的命令前缀 |
| `panels[].extraItems` / `items` | `[]` | 元素：`type` 为 `command`（点击填入输入框）/ `link`；名称 ≤ 14、描述 ≤ 30 字符；`onlyAdmin` |
| `authorize.enabled` | `true` | 注册授权指令 |
| `authorize.command` / `aliases` | `授权全消息` / `[qqauth]` | 指令名与别名 |
| `authorize.botUin` / `botUid` | `''` | 见上一节 |
| `authorize.inputPrefix` | `/` | 「填写群号」「换个群号」按钮预填的前缀 |
| `authorize.sendImages` | `true` | 随回复发送示意图 / 教程图 |

平台限制先在本地校验并给出中文提示：菜单项 ≤ 10、子菜单 ≤ 5、面板 ≤ 20 个、面板元素 ≤ 20 个、`link` 必须 `https://`。

### 不同群用不同的指令面板

`scope: group` + `targetType: specific` + `groupOpenIds`：每个群（或每组群）写一个面板，用 `include` / `exclude` 选命令。
在目标群里发 `/面板群号` 拿到该群 openid。一个机器人最多 20 个面板，一个 specific 面板最多关联 1000 个 openid。
若同时存在 `targetType: all` 的 group 面板，平台会把它和 specific 面板一起生效；想让不同群显示完全不同的内容，就只保留
specific 面板。

## 服务：`ctx.qqPanel`

```ts
import type {} from 'dsh-im-qq-panel'

ctx.qqPanel.bots()                                  // 管理的 QQ 机器人
await ctx.qqPanel.inspect()                         // 只读：菜单/面板现状、差异、待处理动作
await ctx.qqPanel.sync({ resources: ['panels'], dryRun: true })
const client = ctx.qqPanel.client()                 // 绑定某个机器人的接口：getMenu / updateMenu / getPanels /
await client.getAllPanels('group')                  // getAllPanels / createPanel / getPanel / updatePanel /
                                                    // deletePanel / updatePanelTarget
```

## 目录

- `src/api.ts`：接口封装、字段校验与平台形态规整（camelCase / snake_case 均可输入）、错误描述与限频识别
- `src/sync.ts`：差异计算（纯函数）
- `src/commands.ts`：从命令条目生成面板元素（过滤 / 排序 / 长度截断）
- `src/authorize.ts`：授权页地址、群号校验、按钮与教程图
- `src/host.ts`：机器人发现、生成、检查与同步、管理指令与授权指令、自动同步
- `src/panel.ts`、`src/client/`：运维面板 tab 的宿主半与浏览器半
- `assets/`、`guides/`：授权示意图与其 HTML 模板、渲染脚本

## 开发

`pnpm run build`（宿主）、`pnpm run build:client`（浏览器半）、`pnpm run typecheck`、`pnpm test`。

## License

MIT
