import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { tooLongMessage, usesMarkdown } from '../src/index.ts'

describe('usesMarkdown', () => {
  it('calls plain prose a plain text bubble', () => {
    assert.equal(usesMarkdown('驱动太旧了 更新一下就好'), false)
    assert.equal(usesMarkdown('好 我看看'), false)
    assert.equal(usesMarkdown('版本 1.2.3 修了，见 example.com'), false)
    assert.equal(usesMarkdown('   '), false)
    assert.equal(usesMarkdown(''), false)
  })

  it('sees the constructs a text-only renderer cannot show', () => {
    const cases = [
      '```\nnpm i\n```',
      '~~~\nnpm i\n~~~',
      '# 标题\n正文',
      '- 一\n- 二',
      '1. 先装依赖\n2. 再跑构建',
      '> 引用一句',
      '| a | b |\n| - | - |',
      '---',
      '跑一下 `npm run build`',
      '这是 **重点**',
      '这是 __重点__',
      '见 [文档](https://a.b/c)',
      '![图](https://a.b/c.png)',
    ]
    for (const text of cases) assert.equal(usesMarkdown(text), true, `should be markdown: ${JSON.stringify(text)}`)
  })

  it('does not mistake ordinary punctuation for markdown', () => {
    assert.equal(usesMarkdown('他说不是 - 而是'), false)
    assert.equal(usesMarkdown('5 * 3 = 15'), false)
    assert.equal(usesMarkdown('答案：a.b-c'), false)
    assert.equal(usesMarkdown('第一个 1. 这样的行中间不算列表'), false)
  })
})

describe('tooLongMessage', () => {
  it('names the length, the limit and the two ways to publish it', () => {
    const message = tooLongMessage(187, 120)
    assert.match(message, /187 个字/)
    assert.match(message, /超过 120 字/)
    assert.match(message, /没有发出/)
    assert.match(message, /markdown/)
    assert.match(message, /typ2img/)
    assert.match(message, /im_send_file/)
  })
})
