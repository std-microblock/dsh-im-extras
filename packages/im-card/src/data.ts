/**
 * The card data folder: the one directory a card may read and write through its `fs` API.
 *
 * The folder is fixed when the card is published (`cards.dataDir` under the publishing session's working directory,
 * or an absolute operator setting) and stored with the card, so every later click, timer or restart resolves the same
 * paths. A path is always relative to that folder: absolute paths, `..` segments and links that point outside are
 * refused, so a card can never reach the rest of the disk, and one card's files stay where its author put them.
 *
 * The operations are synchronous: the VM bridge is synchronous (`__host(op, payload)`), and every bound here (`maxBytes`)
 * keeps one call cheap enough to run on the event loop.
 *
 * @module dsh-im-card/data
 */
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { CardFilesReply, CardFilesRequest } from './engine.ts'

/** Default folder of the card data directory, relative to the publishing session's working directory. */
export const DEFAULT_DATA_DIR = '.dsh/im-card/data'

/** Longest path a card may ask for, entry names included. */
const MAX_PATH = 512

/** Entries one `listFiles` call returns. */
const MAX_ENTRIES = 500

/**
 * Run one file operation of a card.
 * @param root - absolute path of the card's data folder, or `undefined` when the card has none.
 * @param request - the operation and its path relative to that folder.
 * @param maxBytes - largest file the card may read, write or append.
 * @returns the value of the operation, or the reason it was refused.
 */
export function cardFiles(root: string | undefined, request: CardFilesRequest, maxBytes: number): CardFilesReply {
  if (root === undefined) return { ok: false, error: 'this card has no data folder (the deployment gave it none)' }
  try {
    return { ok: true, value: run(root, request, maxBytes) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** The operation itself; throws the message the card reads. */
function run(root: string, request: CardFilesRequest, maxBytes: number): unknown {
  const target = inside(root, request.path)
  switch (request.op) {
    case 'read': {
      if (!existsSync(target) || !statSync(target).isFile()) return undefined
      const size = statSync(target).size
      if (size > maxBytes) throw new Error(`${request.path} is ${size} bytes; a card may read at most ${maxBytes}`)
      return readFileSync(target, 'utf8')
    }
    case 'write': {
      const text = String(request.text ?? '')
      if (Buffer.byteLength(text) > maxBytes) throw new Error(`${request.path} would exceed ${maxBytes} bytes`)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, text, 'utf8')
      return undefined
    }
    case 'append': {
      const text = String(request.text ?? '')
      const size = existsSync(target) && statSync(target).isFile() ? statSync(target).size : 0
      if (size + Buffer.byteLength(text) > maxBytes) throw new Error(`${request.path} would exceed ${maxBytes} bytes`)
      mkdirSync(dirname(target), { recursive: true })
      appendFileSync(target, text, 'utf8')
      return undefined
    }
    case 'remove':
      rmSync(target, { force: true })
      return undefined
    case 'stat':
      return existsSync(target)
    case 'list': {
      if (!existsSync(target)) return []
      if (!statSync(target).isDirectory()) throw new Error(`${request.path} is not a directory`)
      const out: { name: string; dir: boolean; size: number }[] = []
      for (const entry of readdirSync(target, { withFileTypes: true }).slice(0, MAX_ENTRIES)) {
        const dir = entry.isDirectory()
        out.push({ name: entry.name, dir, size: dir ? 0 : statSync(join(target, entry.name)).size })
      }
      return out
    }
    default:
      throw new Error(`unknown file operation ${String(request.op)}`)
  }
}

/**
 * The absolute path a card's relative path names, once it is proven to stay inside the data folder.
 * @param root - the data folder.
 * @param path - what the card asked for.
 * @returns the absolute path inside `root`.
 * @throws Error when the path is absolute, too long, or leaves the folder lexically or through a link.
 */
function inside(root: string, path: string): string {
  const raw = String(path ?? '')
  if (raw.length > MAX_PATH) throw new Error(`path is longer than ${MAX_PATH} characters`)
  if (raw.includes('\0')) throw new Error('path contains a NUL byte')
  if (isAbsolute(raw) || raw.startsWith('\\') || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
    throw new Error(`path must be relative to the card folder: ${raw}`)
  }
  const base = resolve(root)
  const target = resolve(base, raw)
  if (!contains(base, target)) throw new Error(`path escapes the card folder: ${raw}`)
  // A link inside the folder may point anywhere: the real paths must stay inside as well.
  if (!contains(realpathLoose(base), realpathLoose(target))) {
    throw new Error(`path escapes the card folder through a link: ${raw}`)
  }
  return target
}

/** Whether `target` is `root` or below it. */
function contains(root: string, target: string): boolean {
  const rest = relative(root, target)
  return rest === '' || (!rest.startsWith('..') && !isAbsolute(rest))
}

/** `path` with every existing component resolved through links; the missing tail is kept as written. */
function realpathLoose(path: string): string {
  let current = path
  const tail: string[] = []
  for (;;) {
    try {
      const real = realpathSync(current)
      return tail.length === 0 ? real : join(real, ...tail.reverse())
    } catch {
      // Not there yet: resolve the nearest existing ancestor and keep walking up.
      const parent = dirname(current)
      if (parent === current) return path
      tail.push(basename(current))
      current = parent
    }
  }
}
