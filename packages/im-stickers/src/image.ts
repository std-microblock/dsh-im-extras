/**
 * Image plumbing: format sniffing, intrinsic size, previews, and the frames handed to the vision model.
 *
 * Previews, frame extraction and contact sheets shell out to ImageMagick. It is optional: when the executable cannot
 * run, the size comes from the file header (PNG, GIF, JPEG, WebP), no preview is made (the panel shows the original),
 * and the classifier receives the original bytes when the attachment store accepts their format.
 *
 * @module dsh-im-stickers/image
 */
import { spawn } from 'node:child_process'

/** One encoded picture. */
export interface EncodedImage {
  data: Buffer
  mime: string
}

/** Media types the attachment service stores for images. */
export const MODEL_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

const MIME_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp',
}

/**
 * The format of an image from its first bytes.
 * @param data - the file bytes.
 * @returns the media type, or undefined for anything that is not a known raster format.
 */
export function sniffMime(data: Uint8Array): string | undefined {
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return 'image/gif'
  if (data[0] === 0x52 && data[1] === 0x49 && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return 'image/webp'
  if (data[0] === 0x42 && data[1] === 0x4d) return 'image/bmp'
  return undefined
}

/**
 * File extension of a media type.
 * @param mime - the media type.
 * @returns the extension without a dot.
 */
export function extensionOf(mime: string): string {
  return MIME_EXT[mime] ?? 'bin'
}

/**
 * Width and height from the file header, without decoding.
 * @param data - the file bytes.
 * @returns the size, or undefined when the header is not understood.
 */
export function headerSize(data: Uint8Array): { width: number; height: number } | undefined {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const mime = sniffMime(data)
  try {
    if (mime === 'image/png' && data.byteLength >= 24) return { width: view.getUint32(16), height: view.getUint32(20) }
    if (mime === 'image/gif' && data.byteLength >= 10) return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
    if (mime === 'image/bmp' && data.byteLength >= 26) return { width: view.getInt32(18, true), height: Math.abs(view.getInt32(22, true)) }
    if (mime === 'image/webp' && data.byteLength >= 30) {
      const chunk = String.fromCharCode(data[12]!, data[13]!, data[14]!, data[15]!)
      if (chunk === 'VP8 ') return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
      if (chunk === 'VP8L') {
        const bits = view.getUint32(21, true)
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
      }
      if (chunk === 'VP8X') {
        const w = data[24]! | (data[25]! << 8) | (data[26]! << 16)
        const h = data[27]! | (data[28]! << 8) | (data[29]! << 16)
        return { width: w + 1, height: h + 1 }
      }
    }
    if (mime === 'image/jpeg') {
      let offset = 2
      while (offset + 9 < data.byteLength) {
        if (data[offset] !== 0xff) { offset++; continue }
        const marker = data[offset + 1]!
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) }
        }
        offset += 2 + view.getUint16(offset + 2)
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

/**
 * Whether a file is animated, from its header: a GIF with more than one image descriptor, or an animated WebP.
 * @param data - the file bytes.
 * @returns true for an animation.
 */
export function isAnimated(data: Uint8Array): boolean {
  const mime = sniffMime(data)
  if (mime === 'image/webp') {
    return data.byteLength > 20 && String.fromCharCode(data[12]!, data[13]!, data[14]!, data[15]!) === 'VP8X' && (data[20]! & 0x02) !== 0
  }
  if (mime !== 'image/gif') return false
  // Count graphic control extensions (0x21 0xF9 0x04): one per frame in practice.
  let frames = 0
  for (let i = 13; i + 2 < data.byteLength && frames < 2; i++) {
    if (data[i] === 0x21 && data[i + 1] === 0xf9 && data[i + 2] === 0x04) frames++
  }
  return frames > 1
}

/**
 * Up to `count` frame indices spread evenly across `[0, frames-1]`, both ends included.
 * @param frames - frames of the animation.
 * @param count - frames wanted.
 * @returns ascending, unique indices.
 */
export function sampleIndices(frames: number, count: number): number[] {
  if (frames <= 1) return [0]
  const wanted = Math.min(frames, Math.max(2, count))
  const picked = new Set<number>()
  for (let i = 0; i < wanted; i++) picked.add(Math.round((i * (frames - 1)) / (wanted - 1)))
  return [...picked].sort((a, b) => a - b)
}

/** Outcome of one process run. */
export interface RunResult { code: number; stdout: Buffer; stderr: string }

/** Runs one executable; tests pass a stub. */
export type Runner = (bin: string, args: string[], timeoutMs?: number) => Promise<RunResult>

/**
 * Run a binary and collect stdout. Never throws: callers treat failure as "no tool".
 * @param bin - the executable.
 * @param args - its arguments.
 * @param timeoutMs - kill it after this long.
 * @returns exit code, stdout and the head of stderr.
 */
export const run: Runner = (bin, args, timeoutMs = 60_000) => new Promise((resolve) => {
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  } catch (error) {
    resolve({ code: -1, stdout: Buffer.alloc(0), stderr: String((error as Error).message) })
    return
  }
  const chunks: Buffer[] = []
  let size = 0
  let stderr = ''
  const timer = setTimeout(() => { child.kill('SIGKILL') }, timeoutMs)
  child.stdout?.on('data', (chunk: Buffer) => { size += chunk.length; if (size <= 32 * 1024 * 1024) chunks.push(chunk) })
  child.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < 2000) stderr += chunk.toString() })
  child.on('error', (error) => { clearTimeout(timer); resolve({ code: -1, stdout: Buffer.alloc(0), stderr: error.message }) })
  child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout: Buffer.concat(chunks), stderr }) })
})

/**
 * ImageMagick operations, each degrading to "nothing" when the executable is missing. Whether it runs is probed once
 * and remembered.
 */
export class ImageTools {
  private probed: Promise<boolean> | undefined

  constructor(readonly bin: string, private readonly runner: Runner = run) {}

  /** Whether ImageMagick runs here. */
  available(): Promise<boolean> {
    this.probed ??= this.runner(this.bin, ['-version'], 15_000).then(out => out.code === 0, () => false)
    return this.probed
  }

  /**
   * A first-frame PNG preview, at most 240×240.
   * @param path - the image file.
   * @returns the preview bytes, or undefined without ImageMagick.
   */
  async thumbnail(path: string): Promise<Buffer | undefined> {
    if (!await this.available()) return undefined
    const out = await this.runner(this.bin, [`${path}[0]`, '-resize', '240x240>', '-strip', 'png:-'])
    return out.code === 0 && out.stdout.length > 0 ? out.stdout : undefined
  }

  /**
   * Frames in an image file (1 for a still image).
   * @param path - the image file.
   * @returns the frame count, or 0 when unknown.
   */
  async frameCount(path: string): Promise<number> {
    if (!await this.available()) return 0
    const out = await this.runner(this.bin, ['identify', '-format', '%s\n', path])
    if (out.code !== 0) return 0
    return out.stdout.toString('utf8').split('\n').filter(line => line.trim() !== '').length
  }

  /**
   * One frame (or a whole still image) as a downscaled opaque JPEG for the model.
   * @param selector - `path` or `path[index]`.
   * @param size - longest side.
   * @returns the JPEG, or undefined.
   */
  async still(selector: string, size = 512): Promise<EncodedImage | undefined> {
    if (!await this.available()) return undefined
    const out = await this.runner(this.bin, [selector, '-resize', `${size}x${size}>`, '-background', 'white', '-alpha', 'remove',
      '-alpha', 'off', '-strip', '-quality', '80', 'jpeg:-'])
    return out.code === 0 && out.stdout.length > 0 ? { data: out.stdout, mime: 'image/jpeg' } : undefined
  }

  /**
   * Sampled frames tiled six to a row, in time order: what lets the model describe a motion.
   * @param path - the animation.
   * @param frames - frame indices.
   * @returns the sheet, or undefined.
   */
  async contactSheet(path: string, frames: number[], columns = 6): Promise<EncodedImage | undefined> {
    if (frames.length < 2 || !await this.available()) return undefined
    const out = await this.runner(this.bin, ['montage', ...frames.map(index => `${path}[${index}]`), '-tile', `${columns}x`,
      '-geometry', '96x96+2+2', '-background', 'white', '-strip', '-quality', '78', 'jpeg:-'])
    return out.code === 0 && out.stdout.length > 0 ? { data: out.stdout, mime: 'image/jpeg' } : undefined
  }

  /**
   * The pictures the vision model sees for one sticker: a still image downscaled; an animation as its first, middle
   * and last frame plus a contact sheet of up to 30 sampled frames. Without ImageMagick: the original bytes when the
   * model can take their format and they are small enough.
   * @param path - the sticker file.
   * @param original - its bytes and media type.
   * @returns zero or more pictures.
   */
  async visionFrames(path: string, original: EncodedImage): Promise<EncodedImage[]> {
    const frames = await this.frameCount(path)
    if (frames > 1) {
      const images: EncodedImage[] = []
      for (const index of [0, Math.floor((frames - 1) / 2), frames - 1]) {
        const frame = await this.still(`${path}[${index}]`)
        if (frame) images.push(frame)
      }
      const sheet = await this.contactSheet(path, sampleIndices(frames, 30))
      if (sheet) images.push(sheet)
      if (images.length >= 2) return images
    } else if (frames === 1) {
      const single = await this.still(path)
      if (single) return [single]
    }
    const accepted = (MODEL_IMAGE_TYPES as readonly string[]).includes(original.mime)
    return accepted && original.data.byteLength <= 3_000_000 ? [original] : []
  }
}
