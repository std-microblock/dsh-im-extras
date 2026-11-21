import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  admitSource, headerSize, ImageTools, isAnimated, isPublicAddress, parseClassification, sampleIndices, sniffMime,
  StickerLibrary, type Classifier, type LibraryEvent, type RunResult,
} from '../src/index.ts'
import { config, memoryStorage, PNG, png, quiet, tempDir } from './helpers.ts'

const failing = async (): Promise<RunResult> => ({ code: -1, stdout: Buffer.alloc(0), stderr: 'not found' })

describe('image plumbing', () => {
  it('sniffs formats and reads sizes from headers', () => {
    assert.equal(sniffMime(PNG), 'image/png')
    assert.deepEqual(headerSize(PNG), { width: 1, height: 1 })
    const gif = Buffer.from('GIF89a\x02\x00\x03\x00', 'latin1')
    assert.equal(sniffMime(gif), 'image/gif')
    assert.deepEqual(headerSize(gif), { width: 2, height: 3 })
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x40, 0x03])
    assert.equal(sniffMime(jpeg), 'image/jpeg')
    assert.deepEqual(headerSize(jpeg), { width: 64, height: 32 })
    assert.equal(sniffMime(Buffer.from('hello world!')), undefined)
  })

  it('detects animated GIFs by their frame extensions', () => {
    const frame = [0x21, 0xf9, 0x04, 0, 0, 0, 0, 0]
    const one = Buffer.from([...Buffer.from('GIF89a'), ...new Array(7).fill(0), ...frame])
    const two = Buffer.from([...one, ...frame])
    assert.equal(isAnimated(one), false)
    assert.equal(isAnimated(two), true)
    assert.equal(isAnimated(PNG), false)
  })

  it('samples frames evenly with both ends', () => {
    assert.deepEqual(sampleIndices(1, 30), [0])
    assert.deepEqual(sampleIndices(5, 30), [0, 1, 2, 3, 4])
    assert.deepEqual(sampleIndices(100, 3), [0, 50, 99])
  })

  it('degrades without ImageMagick: no preview, the original handed to the model', async () => {
    const tools = new ImageTools('magick', failing)
    assert.equal(await tools.available(), false)
    assert.equal(await tools.thumbnail('x.png'), undefined)
    assert.deepEqual(await tools.visionFrames('x.png', { data: PNG, mime: 'image/png' }), [{ data: PNG, mime: 'image/png' }])
    assert.deepEqual(await tools.visionFrames('x.bmp', { data: PNG, mime: 'image/bmp' }), [], 'a format the model cannot take')
  })

  it('uses ImageMagick frames for an animation when it runs', async () => {
    const calls: string[][] = []
    const runner = async (_bin: string, args: string[]): Promise<RunResult> => {
      calls.push(args)
      if (args[0] === '-version') return { code: 0, stdout: Buffer.from('ok'), stderr: '' }
      if (args[0] === 'identify') return { code: 0, stdout: Buffer.from('1\n1\n1\n1\n'), stderr: '' }
      return { code: 0, stdout: Buffer.from('jpeg'), stderr: '' }
    }
    const frames = await new ImageTools('magick', runner).visionFrames('a.gif', { data: PNG, mime: 'image/gif' })
    assert.equal(frames.length, 4, 'first, middle, last and a contact sheet')
    assert.ok(calls.some(args => args[0] === 'montage'))
  })
})

describe('sources', () => {
  it('classifies addresses', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.20.0.1', '169.254.1.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
      assert.equal(isPublicAddress(address), false, address)
    }
    for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert.equal(isPublicAddress(address), true, address)
  })

  it('refuses file and internal sources, admits platform resources', async () => {
    await admitSource('satori:qq/resource/abc')
    await admitSource('data:image/png;base64,AAAA')
    await admitSource('https://cdn.example.com/a.png', async () => ['93.184.216.34'])
    await assert.rejects(admitSource('file:///etc/passwd'), /refused file:/)
    await assert.rejects(admitSource('http://127.0.0.1/x.png'), /internal/)
    await assert.rejects(admitSource('https://intranet.example/x.png', async () => ['10.0.0.5']), /internal/)
    await assert.rejects(admitSource(''), /no source/)
  })
})

describe('classifier answers', () => {
  it('keeps known tags only and bounds the description', () => {
    const types = [{ id: 'general', name: '通用', desc: '' }, { id: 'wow', name: '惊讶', desc: '' }]
    assert.deepEqual(parseClassification('```json\n{"tags":["wow","nope","general","wow"],"desc":" 瞪大眼睛的猫 "}\n```', types),
      { tags: ['wow', 'general'], desc: '瞪大眼睛的猫' })
    assert.deepEqual(parseClassification('no json here', types), { tags: [], desc: '' })
  })
})

describe('StickerLibrary', () => {
  async function library(classifier?: Classifier) {
    const { dir, cleanup } = await tempDir()
    const { storage, tables } = memoryStorage()
    const events: LibraryEvent[] = []
    const lib = new StickerLibrary({
      storage, dir, image: new ImageTools('magick', failing), logger: quiet,
      classifier: () => classifier, emit: event => { events.push(event) },
    }, config())
    await lib.open()
    return { lib, dir, cleanup, tables, events }
  }

  it('stores a picture once and refuses non-images and oversized files', async () => {
    const { lib, dir, cleanup } = await library()
    try {
      const first = await lib.add({ data: PNG, name: 'cat.png', source: 'upload' })
      assert.equal(first.created, true)
      assert.equal(first.row.id, 1)
      assert.equal(first.row.mime, 'image/png')
      assert.equal(first.row.width, 1)
      assert.equal(first.row.thumb, '', 'no ImageMagick: no preview')
      const again = await lib.add({ data: PNG, source: 'chat' })
      assert.equal(again.created, false)
      assert.equal(again.row.id, 1)
      await assert.rejects(lib.add({ data: Buffer.from('not an image at all'), source: 'upload' }), /not a PNG/)
      await assert.rejects(lib.add({ data: Buffer.alloc(2 * 1024 * 1024, 1), source: 'upload' }), /too large/)
      assert.deepEqual(await readdir(dir), [first.row.file, 'thumbs'].sort())
      assert.deepEqual((await lib.read(1))?.data, PNG)
    } finally { await cleanup() }
  })

  it('classifies a new sticker in the background and records failures on it', async () => {
    let calls = 0
    const { lib, cleanup } = await library(async (frames) => {
      calls++
      assert.equal(frames.length, 1)
      return calls === 1 ? '{"tags":["happy"],"desc":"大笑的熊猫"}' : 'garbage'
    })
    try {
      const { row } = await lib.add({ data: png(1), source: 'upload' })
      await lib.idle()
      assert.deepEqual(lib.get(row.id)?.tags, ['happy'])
      assert.equal(lib.get(row.id)?.desc, '大笑的熊猫')
      const second = await lib.add({ data: png(2), source: 'upload' })
      await lib.idle()
      assert.match(lib.get(second.row.id)?.error ?? '', /no usable answer/)
      assert.equal(lib.stats().failed, 1)
    } finally { await cleanup() }
  })

  it('runs a classification job over undescribed stickers', async () => {
    const { lib, cleanup, events } = await library()
    try {
      for (const variant of [1, 2, 3]) await lib.add({ data: png(variant), source: 'upload' })
      const classifier: Classifier = async () => '{"tags":["general"],"desc":"一张图"}'
      lib.deps.classifier = () => classifier
      const job = lib.beginClassify()
      assert.equal(job.total, 3)
      assert.throws(() => lib.beginClassify(), /already running/)
      await lib.idle()
      const done = lib.jobState()!
      assert.equal(done.running, false)
      assert.equal(done.done, 3)
      assert.equal(done.failed, 0)
      assert.equal(lib.list({ tags: ['general'] }).length, 3)
      assert.ok(events.some(event => event.type === 'job'))
      assert.throws(() => lib.beginClassify(), /nothing to classify/)
    } finally { await cleanup() }
  })

  it('edits, batch-edits and deletes stickers with their files', async () => {
    const { lib, dir, cleanup } = await library()
    try {
      const a = (await lib.add({ data: png(1), source: 'upload' })).row
      const b = (await lib.add({ data: png(2), source: 'upload' })).row
      const updated = await lib.update(a.id, { weight: 250, tags: ['general', 'bogus'], desc: '  捂脸 的猫 ' })
      assert.equal(updated?.weight, 100)
      assert.deepEqual(updated?.tags, ['general'])
      assert.equal(updated?.desc, '捂脸 的猫')
      assert.equal(await lib.updateMany([a.id, b.id, 99], { enabled: false, addTags: ['wow'] }), 2)
      assert.deepEqual(lib.get(a.id)?.tags, ['general', 'wow'])
      assert.equal(await lib.updateMany([a.id], { removeTags: ['general'] }), 1)
      assert.deepEqual(lib.get(a.id)?.tags, ['wow'])
      assert.equal(lib.enabledCount(), 0)
      await lib.recordUse(b.id)
      assert.equal(lib.get(b.id)?.uses, 1)
      assert.equal(await lib.remove([a.id]), 1)
      assert.equal(lib.get(a.id), undefined)
      assert.ok(!(await readdir(dir)).includes(a.file))
      assert.ok((await readdir(join(dir))).includes(b.file))
    } finally { await cleanup() }
  })

  it('stores per-chat automatic sticker switches', async () => {
    const { lib, cleanup } = await library()
    try {
      await lib.setChat('qq:1|g', { enabled: false })
      assert.equal(lib.override('qq:1|g')?.enabled, false)
      await lib.setChat('qq:1|g', { percent: 300 })
      assert.equal(lib.override('qq:1|g')?.percent, 100)
      await lib.setChat('qq:1|g', undefined)
      assert.equal(lib.overrides().length, 0)
    } finally { await cleanup() }
  })
})
