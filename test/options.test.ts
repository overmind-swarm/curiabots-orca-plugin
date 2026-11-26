import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectOptions } from '../src/options.ts'
import * as F from './terminal-fixtures.ts'

test('selector with Yes / No / Type something / Chat about this', () => {
  assert.deepEqual(detectOptions(F.claudeSelectorSimple), [
    { n: 1, label: 'Yes' },
    { n: 2, label: 'No' },
    { n: 3, label: 'Type something.' },
    { n: 4, label: 'Chat about this' }
  ])
})

test('selector with descriptions under each option: labels only, cursor anywhere', () => {
  assert.deepEqual(detectOptions(F.claudeSelectorDescriptions), [
    { n: 1, label: 'Patch parseMonth' },
    { n: 2, label: 'Use the date library' },
    { n: 3, label: 'Type something.' }
  ])
})

test('permission selector', () => {
  const o = detectOptions(F.claudeSelectorPermission)
  assert.equal(o.length, 3)
  assert.deepEqual(o[0], { n: 1, label: 'Yes' })
  assert.match(o[1]!.label, /^Yes, and don't ask again/)
  assert.match(o[2]!.label, /^No, and tell Claude/)
})

test('no selector: plain list, finished turn, working, answered selector, Codex approval has its own cursor', () => {
  assert.deepEqual(detectOptions(F.claudePlainList), [], 'a numbered list in the answer is not a selector')
  assert.deepEqual(detectOptions(F.claudeDone(9)), [])
  assert.deepEqual(detectOptions(F.claudeWorking(3, '1k')), [])
  assert.deepEqual(detectOptions(F.claudeSelectorAnswered), [], 'the agent moved on')
  assert.deepEqual(detectOptions([]), [])
  assert.equal(detectOptions(F.codexApproval).length, 3, 'Codex approval: › cursor')
})

test('labels are clean and bounded, at most 9 options, ANSI removed', () => {
  const lines = [
    '\u001b[36m❯ 1. \u001b[1mYes\u001b[0m',
    ...Array.from({ length: 11 }, (_, i) => `  ${i + 2}. ${i === 0 ? 'x'.repeat(500) : 'item'}`),
    'Enter to select · Esc to cancel'
  ]
  const o = detectOptions(lines)
  assert.equal(o.length, 9)
  assert.equal(o[0]!.label, 'Yes')
  assert.equal(o[1]!.label.length, 120)
  assert.ok(o.every((x) => x.n >= 1 && x.n <= 9))
})

test('hostile lines are processed in linear time', () => {
  const t = Date.now()
  detectOptions([' '.repeat(50_000) + '1. ' + 'a'.repeat(50_000), '❯ '.repeat(20_000), '1.'.repeat(30_000), ...Array.from({ length: 500 }, () => '2. x ')])
  assert.ok(Date.now() - t < 1000)
})
