/**
 * Collecting a picture someone posted in a chat: resolve a media id (`#12.1`, as the transcript labels it) or a
 * message to its image element, check the source, and fetch the bytes.
 *
 * The bytes are fetched through im-core's resource fetcher, the same one publication uses: a `satori:` resource is
 * downloaded by the adapter of the bot that received it (official QQ and Lark bots name their media this way), `data:`
 * and `base64:` carry their own bytes, and `http(s)` is fetched without following redirects. Because the source was
 * written by a chat member, a `file:` source and an `http(s)` host that is, or resolves to, a loopback, private,
 * link-local or multicast address are refused before any I/O.
 *
 * @module dsh-im-stickers/collect
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { isElement, type Element } from '@deepseek-ai/cordis-plugin-im-core'

/** Media tags that are numbered by the transcript labels, in content order. */
const MEDIA_TAGS = new Set(['img', 'file', 'audio', 'video'])

/** One media element of a message. */
export interface MediaElement {
  /** 1-based position among the message's media elements (the `.1` of `#12.1`). */
  index: number
  type: string
  src: string
  /** `alt` of an image, `name` of the other kinds. */
  name?: string
}

/**
 * The media elements of one message, numbered the way the transcript labels them.
 * @param content - the stored message content.
 * @returns every `img` / `file` / `audio` / `video` element in content order.
 */
export function mediaElements(content: Element): MediaElement[] {
  const out: MediaElement[] = []
  const visit = (node: unknown): void => {
    if (!isElement(node)) return
    if (MEDIA_TAGS.has(node.type)) {
      const attrs = node.attrs as Record<string, unknown>
      const name = node.type === 'img' ? attrs.alt : attrs.name
      out.push({
        index: out.length + 1,
        type: node.type,
        src: typeof attrs.src === 'string' ? attrs.src : '',
        ...typeof name === 'string' && name.trim() ? { name: name.trim() } : {},
      })
    }
    for (const child of node.children) visit(child)
  }
  for (const child of content.children) visit(child)
  return out
}

/**
 * Parse `#12.1`, `12.1` or `12` (the first media element of message 12).
 * @param id - the media id.
 * @returns seq and 1-based index, or undefined.
 */
export function parseMediaId(id: string): { seq: number; index: number } | undefined {
  const match = /^#?(\d+)(?:\.(\d+))?$/.exec(String(id).trim())
  if (!match) return undefined
  const index = match[2] === undefined ? 1 : Number(match[2])
  return index >= 1 ? { seq: Number(match[1]), index } : undefined
}

/**
 * Whether an IP address is public (not loopback, private, link-local, carrier-grade NAT, multicast or unspecified).
 * @param address - an IPv4 or IPv6 literal.
 * @returns true for a public address.
 */
export function isPublicAddress(address: string): boolean {
  const kind = isIP(address)
  if (kind === 4) {
    const [a, b] = address.split('.').map(Number) as [number, number]
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false
    if (a === 169 && b === 254) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a === 100 && b >= 64 && b <= 127) return false
    return true
  }
  if (kind === 6) {
    const lower = address.toLowerCase()
    if (lower === '::' || lower === '::1') return false
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
    if (mapped) return isPublicAddress(mapped[1]!)
    if (/^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith('ff')) return false
    return true
  }
  return false
}

/** Resolves a host name to its addresses; tests pass a stub. */
export type HostResolver = (host: string) => Promise<readonly string[]>

const systemResolver: HostResolver = async host => (await lookup(host, { all: true })).map(entry => entry.address)

/**
 * Refuse a source a chat member may not make this host fetch.
 * @param src - the element's `src`.
 * @param resolve - host lookup.
 * @throws Error naming why the source is refused.
 */
export async function admitSource(src: string, resolve: HostResolver = systemResolver): Promise<void> {
  const value = src.trim()
  if (value === '') throw new Error('the image has no source')
  if (/^(satori|data|base64):/i.test(value)) return
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`unsupported image source: ${value.slice(0, 60)}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`refused ${url.protocol} source`)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = isIP(host) ? [host] : await resolve(host).catch(() => [] as string[])
  if (addresses.length === 0) throw new Error(`cannot resolve ${host}`)
  if (!addresses.every(isPublicAddress)) throw new Error(`refused internal address for ${host}`)
}
