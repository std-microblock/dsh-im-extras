import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { h } from '@deepseek-ai/cordis-plugin-im-core'
import {
  acceptStyled, checkStyled, diceSimilarity, mostSimilar, pickSubStyles, readAnswer, similarityKey, textContent,
} from '../src/index.ts'

describe('similarity', () => {
  it('normalizes mentions, labels, punctuation and case away', () => {
    assert.equal(similarityKey('@小明 好的~ 我看看！[图片 #12.1]'), '好的我看看')
    assert.equal(similarityKey('<at user_id="ou_1">张三</at> OK, Done.'), 'okdone')
  })

  it('scores bigram Dice', () => {
    assert.equal(diceSimilarity('abc', 'abc'), 1)
    assert.equal(diceSimilarity('abcd', 'wxyz'), 0)
    assert.equal(diceSimilarity('', 'abc'), 0)
    const a = similarityKey('扩展列表就在 profile 的 extensions.json 里（jq 一行就能导出）')
    const b = similarityKey('扩展列表在 profile 的 extensions.json 里~ jq 一行就能导出来')
    assert.ok(diceSimilarity(a, b) >= 0.82, `rewordings should be close: ${diceSimilarity(a, b)}`)
    const c = similarityKey('这个版本的崩溃是显卡驱动导致的，更新一下驱动就好')
    assert.ok(diceSimilarity(a, c) < 0.3)
  })

  it('finds the most similar earlier message above the length floor', () => {
    const previous = ['好的', '扩展列表就在 profile 的 extensions.json 里', '明天再说吧']
    const match = mostSimilar('扩展列表在 profile 里的 extensions.json', previous, 8)
    assert.equal(match?.index, 1)
    assert.ok((match?.score ?? 0) > 0.6)
    assert.equal(mostSimilar('好的', previous, 8), undefined, 'short messages are never compared')
  })
})

describe('style guards', () => {
  it('draws sub-styles within bounds, deterministically for a fixed die', () => {
    const subs = ['a', 'b', 'c', 'd']
    const zero = pickSubStyles(subs, 1, 3, () => 0)
    assert.deepEqual(zero, ['a'])
    const high = pickSubStyles(subs, 1, 3, () => 0.99)
    assert.equal(high.length, 3)
    assert.equal(new Set(high).size, 3)
    assert.deepEqual(pickSubStyles([], 1, 3), [])
    assert.equal(pickSubStyles(subs, 10, 20, () => 0).length, 4, 'clamped to the pool')
  })

  it('accepts a faithful rewrite and strips labels and quotes', () => {
    assert.equal(acceptStyled('改写：「好 我看看」', '好的，我看一下', 100), '好 我看看')
    assert.equal(acceptStyled('```\n嗯 收到\n```', '收到了', 100), '嗯 收到')
  })

  it('refuses rewrites that lose links, mentions, numbers or code, or grow', () => {
    const original = '版本 1.2.3 修了，见 https://example.com/x 和 `npm run build` @小明'
    assert.equal(checkStyled('修了 去看 @小明', original, 200).reason?.split(' ')[0], 'lost-link')
    assert.equal(checkStyled('1.2.3 修了 https://example.com/x `npm run build`', original, 200).reason?.split(' ')[0], 'lost-mention')
    assert.equal(checkStyled('修了 https://example.com/x `npm run build` @小明', original, 200).reason?.split(' ')[0], 'lost-number')
    assert.equal(checkStyled('1.2.3 修了 https://example.com/x @小明', original, 200).reason?.split(' ')[0], 'lost-code')
    assert.ok(acceptStyled('1.2.3 修好啦 见 https://example.com/x 跑 npm run build @小明', original, 200))
    assert.equal(checkStyled('好的好的好的好的好的好的好的好的', '好的', 200).reason, 'grew')
    assert.equal(checkStyled('一\n二', '一二', 200).reason, 'extra-lines')
    assert.equal(checkStyled('abc', 'abcd', 2).reason, 'too-long')
    assert.equal(checkStyled('   ', 'abc', 200).reason, 'empty')
    assert.equal(checkStyled('看 [文档](https://a.b/c)', '看看[文档](https://a.b/c)', 200).text, '看 [文档](https://a.b/c)')
    assert.equal(checkStyled('<at user_id="u1">甲</at> 好', '<at user_id="u1">甲</at> 好的', 200).text, '<at user_id="u1">甲</at> 好')
    assert.equal(checkStyled('好', '<at user_id="u1">甲</at> 好的', 200).reason?.split(' ')[0], 'lost-mention')
  })

  it('reads the skip marker, fenced or quoted', () => {
    assert.deepEqual(readAnswer('<no-send/>', '<no-send/>'), { kind: 'skip' })
    assert.deepEqual(readAnswer(' "<no-send/>" ', '<no-send/>'), { kind: 'skip' })
    assert.deepEqual(readAnswer('```\n<no-send/>\n```', '<no-send/>'), { kind: 'skip' })
    assert.deepEqual(readAnswer('好 <no-send/>', '<no-send/>'), { kind: 'text', text: '好 <no-send/>' })
  })
})

describe('content', () => {
  it('reads plain strings, text, markdown and message roots', () => {
    assert.equal(textContent('hello')?.text, 'hello')
    assert.equal(textContent(h.text('hi'))?.markdown, false)
    const md = textContent(h.markdown('**bold** text'))
    assert.equal(md?.markdown, true)
    const rebuilt = md?.rebuild('new') as { type: string; attrs: { content: string } }
    assert.equal(rebuilt.type, 'markdown')
    assert.equal(rebuilt.attrs.content, 'new')
    const wrapped = textContent(h('message', h('quote', { id: 'm1' }), 'a', h('br'), 'b'))
    assert.equal(wrapped?.text, 'a\nb')
    const out = wrapped?.rebuild('c') as { type: string; children: { type: string }[] }
    assert.equal(out.type, 'message')
    assert.equal(out.children[0]?.type, 'quote')
  })

  it('refuses anything with images, cards or other elements', () => {
    assert.equal(textContent(h('message', 'look', h('img', { src: 'https://x/y.png' }))), undefined)
    assert.equal(textContent(h('img', { src: 'https://x/y.png' })), undefined)
    assert.equal(textContent(['a', h('button', { id: 'b' }, 'x')]), undefined)
    assert.equal(textContent('   '), undefined)
  })
})
