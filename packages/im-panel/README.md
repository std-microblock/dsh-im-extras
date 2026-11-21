# dsh-im-panel

An operator panel for the DeepSeek Harness IM host (`dsh-im`), drawn as a page of the harness's own web GUI: an
overview of the deployment, every hosted session, the task workers with a stop button, the route rules of
[`dsh-im-dispatch`](../im-dispatch/README.md) (add / change / remove), each chat's wake and reply mode, and the
chronicle (the cross-chat log the dispatch routers read).

Other plugins add their own tabs to the same page through the **tab extension API** below (a host half that answers
the tab's data, a browser half that draws it). The polish and sticker plugins of this repository use it.

Everything the panel reads is optional: without `dsh-im-dispatch` the rule, chat and chronicle tabs say so and stay
empty; without `dsh-im-session-tasks` the task tab does; without the IM host only extension tabs work.

## Install

```yaml
plugins:
  - name: dsh-im-panel        # host half; the browser half is the package's `./client`
    config: {}
```

The plugin needs the harness's `connection` service (the authenticated `/api` channel of the GUI listener) and does
nothing in a profile without a browser surface. All routes sit below `/api/im-panel`, so the GUI's own admission
(launch token, trusted Host, owner principal) decides who reaches them. A deployment that serves a reduced, read-only
surface on another origin must refuse `/api/im-panel*` there.

Open it from the left sidebar's panel list, or with the hash `#im` / `#im/<tab>` (`#im/rules`, `#im/polish`, …).

## Tab extension API

A tab is two registrations that share one **tab id** (`/^[a-z][a-z0-9-]{0,31}$/`; the built-in ids `overview`,
`sessions`, `tasks`, `rules`, `chats` and `chronicle` are reserved):

| half    | service                    | what it registers                                                           |
|---------|----------------------------|-----------------------------------------------------------------------------|
| host    | `ctx.imPanel` (cordis service of this plugin) | title, order, an optional badge, and the HTTP handler of the tab's data |
| browser | `ctx.imPanel` (client service of this plugin's `./client`) | the React component that draws the tab              |

Either half alone works: a host tab without a browser half shows a "no component" placeholder (useful while
developing), a browser tab without a host half is a pure client view (it can still call any harness API).

### Host half

```ts
import type {} from 'dsh-im-panel'          // types only: augments Context with `imPanel`

export const name = 'dsh-im-stickers'
export const inject = { required: ['im'], optional: ['imPanel'] }

export function apply(ctx: Context) {
  ctx.inject(['imPanel'], (ctx) => {
    ctx.imPanel.tab({
      id: 'stickers',
      title: '表情库',
      order: 60,                               // built-ins use 10..60 step 10; default 100
      badge: () => service.stats().total,      // optional number on the nav entry, read with every snapshot

      // Option A: JSON handlers (the common case). Each receives the sub path ('' for none) and the query.
      read: async ({ path, query }) => {       // GET  /api/im-panel/tab?id=stickers&path=<path>&<query…>
        if (path === 'stats') return service.stats()
        return service.list({ query: query.get('q') ?? undefined, limit: Number(query.get('limit') ?? 50) })
      },
      command: async ({ path, body }) => {     // POST /api/im-panel/tab?id=stickers&path=<path>, JSON body
        const { action, ids } = body as { action: string; ids: number[] }
        if (action === 'remove') { await service.remove(ids); return { ok: true, text: `已删除 ${ids.length} 个` } }
        throw new Error(`未知命令 ${action}`)  // → 200 { ok: false, text }
      },

      // Option B: a raw Fetch handler, for images, downloads and uploads. When present it answers every request of
      // the tab (read/command are then ignored).
      fetch: async (request, { path, query }) => {
        if (path === 'file') {
          const { data, mime } = await service.file(Number(query.get('sticker')), query.has('thumb'))
          return new Response(data, { headers: { 'content-type': mime, 'cache-control': 'private, max-age=3600' } })
        }
        if (path === 'upload' && request.method === 'POST') {
          const form = await request.formData()
          const files = await Promise.all(form.getAll('file').filter(f => f instanceof File)
            .map(async f => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })))
          return Response.json(await service.upload(files))
        }
        return Response.json({ ok: false, text: 'not found' }, { status: 404 })
      },
    })
  })
}
```

- `ctx.imPanel.tab(definition)` returns a disposer and is also removed automatically when the calling plugin (the
  fiber that called it) unloads. Registering an id twice throws.
- The route is one exact path, `/api/im-panel/tab`, methods `GET`, `HEAD` and `POST`, with a **streaming** request
  body (no buffering limit; `request.json()` / `request.formData()` / `request.arrayBuffer()` all work). The tab is
  selected by `id`, the sub path by `path`; every other query parameter is passed through.
- `read` answers `GET`; `command` answers `POST` with a JSON body. Their return value is serialized as JSON (status
  200). A thrown error becomes `{ ok: false, text: <message> }` (400 for `read`, 200 for `command`, so the browser
  shows it as a toast). `undefined` serializes as `null`.
- Convention for commands: return `ImPanelResult` (`{ ok: boolean, text: string }`) when the operator only needs a
  one-line outcome, anything else when the tab needs data back.
- Other host-side reads: `ctx.imPanel.snapshot()` (the same `ImPanelState` the overview draws: chats with names,
  sessions, tasks…), `ctx.imPanel.tabs()` (registered host tabs), and the event `im-panel/command`
  (`(tab: string, path: string, body: unknown) => void`) emitted after every successful tab command, for audit logs.

### Browser half

The browser half is a separate bundle of your package, served by the harness as its `./client` export:

```jsonc
// package.json of the extension package
{
  "exports": { ".": "./dist/index.js", "./client": "./client/client.js" },
  "files": ["dist", "client"],
  "dsh": { "client": { "platform": "web" } },
  "scripts": { "build:client": "node ../im-panel/scripts/build-client.mjs ." }
}
```

`packages/im-panel/scripts/build-client.mjs <package dir>` bundles `<package dir>/src/client/index.tsx` into
`<package dir>/client/client.js` in the artifact shape the harness loader expects (CommonJS factory, React and the
`@deepseek-ai/dsh-client-*` platform modules external, `.css` imported as text). Copy it if you prefer; it has no
dependency on this package. `client/` is build output and is not committed.

```tsx
// src/client/index.tsx
import type { ImPanelClient, ImPanelTabProps } from 'dsh-im-panel'   // types only
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState } from 'react'

function Stickers({ read, command, url, upload, toast, chats }: ImPanelTabProps) {
  const [items, setItems] = useState<{ id: number; desc: string }[]>([])
  useEffect(() => { void read<{ items: typeof items }>('', { limit: 60 }).then(r => setItems(r.items)) }, [read])
  return (
    <div className="im-grid">
      {items.map(item => (
        <figure key={item.id}>
          <img src={url('file', { sticker: item.id, thumb: 1 })} alt={item.desc} />
          <Button size="sm" onClick={async () => { toast((await command({ action: 'remove', ids: [item.id] })).text) }}>
            删除
          </Button>
        </figure>
      ))}
      <input type="file" multiple onChange={async e => { await upload('upload', [...e.target.files ?? []]) }} />
    </div>
  )
}

export const name = 'dsh-im-stickers'
export function apply(ctx: { inject: Function; effect: Function; get(name: string): unknown }) {
  ctx.inject(['imPanel'], (scoped: typeof ctx) => {
    const panel = scoped.get('imPanel') as ImPanelClient
    scoped.effect(() => panel.tab({ id: 'stickers', title: '表情库', order: 60, component: Stickers }), 'stickers tab')
  })
}
```

`panel.tab({ id, title, order?, icon?, component })` returns a disposer (wrap it in `ctx.effect` as above so it goes
away with your plugin; the `inject` callback also unloads when the panel does). `icon` is an optional component taking
`{ size?: number; className?: string }` — any `Icon…` of `@deepseek-ai/dsh-client-ui-primitives`. When both halves
register a title/order, the browser half's wins.

The component receives `ImPanelTabProps`:

| prop | type | |
|------|------|-|
| `id` | `string` | the tab id |
| `url(path?, query?)` | `string` | same-origin URL of `/api/im-panel/tab?id=<id>&path=<path>&…` — for `<img src>`, `<a href download>` |
| `fetch(path?, init?)` | `Promise<Response>` | raw request against your tab route (`init.query` adds parameters) |
| `read<T>(path?, query?)` | `Promise<T>` | `GET`, JSON; throws `Error(text)` on a failure answer |
| `command<T = ImPanelResult>(body, path?)` | `Promise<T>` | `POST` JSON |
| `upload<T>(path, files, fields?)` | `Promise<T>` | `POST` `multipart/form-data`, every file under the field `file` |
| `toast(text)` | `void` | the panel's toast |
| `openSession(sessionId)` | `void` | show a session in the GUI's conversation column |
| `refresh()` | `void` | re-read the panel snapshot (badges, chats) |
| `chats` | `readonly ImPanelChat[]` | known chats `{ chat, name?, platform }` from the last snapshot, for chat pickers |
| `snapshot` | `ImPanelState \| undefined` | the whole last snapshot |

`query` values may be `string | number | boolean | undefined` (`undefined` is dropped). The panel's stylesheet
defines a few classes extension tabs may reuse: `im-card`, `im-table`, `im-row`, `im-empty`, `im-muted`, `im-chip`,
`im-toolbar`, `im-grid`.

## Built-in tabs

| id | shows | writes |
|----|-------|--------|
| `overview` | bots, counts, notices, dispatch composition, recent chronicle | — |
| `sessions` | hosted sessions with bindings and auth state | stop a turn, unlock an exclusive session |
| `tasks` | task workers (`ctx.imTasks`) | stop a task |
| `rules` | route rules with error counts | add, change, remove |
| `chats` | per-chat wake/reply mode, watch topics, reply policy | change any of them |
| `chronicle` | the chronicle, newest first, filterable by chat | — |

The core snapshot is `GET /api/im-panel`, commands are `POST /api/im-panel` (`{ action: … }`, see
`src/protocol.ts`).

## Development

`pnpm run build` (host `tsc` + browser bundle), `pnpm run typecheck`, `pnpm run typecheck:client`, `pnpm test`.
