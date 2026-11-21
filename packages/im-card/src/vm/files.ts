/**
 * The card's data folder, and `useStoredState` on top of it.
 *
 * A card may read and write files, but only inside the folder its deployment gave it: a path is relative to that
 * folder (`state.json`, `polls/week.json`), and the host refuses anything that would leave it — an absolute path, a
 * `..`, a link pointing out. The calls are synchronous because the bridge is, and one card file is small by
 * definition; the host enforces the size bound.
 *
 * @module dsh-im-card/vm/files
 */
import { g } from './globals.ts'
import { useCallback, useState, type SetState } from './hooks.ts'
import { host } from './host.ts'

/** One file operation, as the host names it. */
type FileOp = 'read' | 'write' | 'append' | 'remove' | 'stat' | 'list'

/** One entry of the card's data folder. */
export interface FileEntry {
  name: string
  dir: boolean
  size: number
}

/** The card's data folder, as a card sees it (`fs`). */
export interface CardFs {
  /** The text of a file, or `undefined` when there is no such file. */
  readFile(path: string): string | undefined
  /** Write a file, creating its folders and replacing what it held. */
  writeFile(path: string, text: string): void
  /** Add to the end of a file, creating it when needed. */
  appendFile(path: string, text: string): void
  /** Delete a file; deleting what is not there does nothing. */
  removeFile(path: string): void
  /** Whether something exists at that path. */
  exists(path: string): boolean
  /** The entries of a folder (`''` is the data folder itself). */
  listFiles(path?: string): FileEntry[]
  /** A file parsed as JSON, or `fallback` when there is no file; a corrupt file throws. */
  readJson<T>(path: string, fallback: T): T
  /** A value stored as JSON, indented so the file stays readable. */
  writeJson(path: string, value: unknown): void
}

/** The request shape of the `fs` op. */
interface FilesRequest {
  op: FileOp
  path: string
  text?: string
}

/** What the host may answer to {@link FilesRequest}: the value, or why it refused. */
interface FilesReply {
  ok?: unknown
  value?: unknown
  error?: unknown
}

/**
 * The message of a thrown value, for a warning that has nowhere else to go.
 * @param e - the thrown value.
 */
function messageOf(e: unknown): string {
  if (e instanceof Error) return String(e.message)
  try {
    return typeof e === 'string' ? e : JSON.stringify(e) ?? String(e)
  } catch {
    return String(e)
  }
}

/**
 * One file operation.
 * @param op - the operation.
 * @param path - path inside the card's folder.
 * @param text - the text of a `write` or `append`.
 * @returns what the host sent back: the value the operation has, `undefined` for a write and for an absent file.
 * @throws Error with the host's reason when the operation was refused.
 */
function fileOp(op: FileOp, path: unknown, text?: unknown): unknown {
  const request: FilesRequest = { op, path: path === undefined || path === null ? '' : String(path) }
  if (text !== undefined) request.text = String(text)
  let reply: unknown
  try {
    reply = JSON.parse(host('fs', JSON.stringify(request)))
  } catch {
    throw new Error('the host sent an unreadable reply to ' + op)
  }
  const answer = reply !== null && typeof reply === 'object' ? (reply as FilesReply) : null
  if (answer === null || answer.ok !== true) {
    throw new Error(answer !== null && typeof answer.error === 'string' ? answer.error : op + ' failed')
  }
  return answer.value
}

/** The card's data folder (`fs` as a global). */
export const cardFs: CardFs = {
  readFile(path) {
    const value = fileOp('read', path)
    return value === undefined || value === null ? undefined : String(value)
  },
  writeFile(path, text) {
    fileOp('write', path, text === undefined || text === null ? '' : text)
  },
  appendFile(path, text) {
    fileOp('append', path, text === undefined || text === null ? '' : text)
  },
  removeFile(path) {
    fileOp('remove', path)
  },
  exists(path) {
    return fileOp('stat', path) === true
  },
  listFiles(path) {
    const value = fileOp('list', path === undefined ? '' : path)
    return Array.isArray(value) ? (value as FileEntry[]) : []
  },
  readJson<T>(path: string, fallback: T): T {
    const text = cardFs.readFile(path)
    return text === undefined ? fallback : (JSON.parse(text) as T)
  },
  writeJson(path, value) {
    cardFs.writeFile(path, JSON.stringify(value, null, 2))
  },
}

/**
 * State like `useState`, kept as JSON in the card's data folder: it starts from what the file holds (or from
 * `initial`), and every set writes the new value. The VM snapshot also carries it, so the file is what lets a second
 * card — or a re-run after an upgrade — read the same value.
 * @param path - file inside the card's folder.
 * @param initial - the value used when there is no file (a function is called once), or no readable one.
 * @returns the value and its setter, which writes the file.
 */
export function useStoredState<S>(path: string, initial: S | (() => S)): [S, SetState<S>] {
  const file = String(path)
  const [value, setValue] = useState<S>(function () {
    let stored: S | undefined
    try {
      stored = cardFs.readJson<S | undefined>(file, undefined)
    } catch (e) {
      // A corrupt file falls back to `initial` instead of failing the whole render.
      g.console.warn('useStoredState(' + file + '): ' + messageOf(e))
      stored = undefined
    }
    if (stored !== undefined) return stored
    return typeof initial === 'function' ? (initial as () => S)() : initial
  })
  const save = useCallback(
    function (next: S | ((previous: S) => S)) {
      setValue(function (previous) {
        const resolved = typeof next === 'function' ? (next as (previous: S) => S)(previous) : next
        try {
          cardFs.writeJson(file, resolved)
        } catch (e) {
          // The snapshot still carries the value; only the copy a later card would read is missing.
          g.console.warn('useStoredState(' + file + ') was not saved: ' + messageOf(e))
        }
        return resolved
      })
    },
    [file],
  )
  return [value, save]
}
