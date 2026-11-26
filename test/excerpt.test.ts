import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildExcerpt, normalizeExcerpt } from '../src/excerpt.ts'
import * as F from './terminal-fixtures.ts'

const NOISE = /▐▛|▝▜|Claude Code v|OpenAI Codex|bypass permissions|Cooked|Brewed|Churning|esc to interrupt|context left|for shortcuts|Do not touch the public API|Fix the failing date|Token usage|model:|directory:/m

test('claude: finished turn is only the final answer', () => {
  const ex = buildExcerpt(F.claudeDone(9))
  assert.equal(ex, F.CLAUDE_DONE_ANSWER)
  assert.doesNotMatch(ex, NOISE)
})

test('claude: a question to the user keeps the whole question with its options', () => {
  const ex = buildExcerpt(F.claudeQuestion(14))
  assert.equal(ex, F.CLAUDE_QUESTION_TEXT)
  assert.doesNotMatch(ex, NOISE)
})

test('claude: a pending permission shows the command and the options, without the banner or echo', () => {
  const ex = buildExcerpt(F.claudePermission)
  assert.match(ex, /^Bash\(rm -rf dist\)/)
  assert.match(ex, /Do you want to proceed\?/)
  assert.match(ex, /1\. Yes/)
  assert.match(ex, /3\. No, and tell Claude/)
  assert.doesNotMatch(ex, NOISE)
  assert.doesNotMatch(ex, /stale build output/)
})

test('claude: working screen leaves no spinner or counters', () => {
  const ex = buildExcerpt(F.claudeWorking(45, '1.2k'))
  assert.doesNotMatch(ex, NOISE)
  assert.doesNotMatch(ex, /Churning|tokens/)
})

test('claude: banner and our own prompt echo alone give an empty excerpt', () => {
  assert.equal(buildExcerpt(F.claudeBannerAndEcho), '')
})

test('claude: only the last turn counts, and a placeholder in the composer is not the echo', () => {
  assert.equal(
    buildExcerpt(F.claudeSecondTurn),
    'Added the leap-day regression test; it fails without the fix and passes with it.'
  )
  assert.equal(buildExcerpt(F.claudeWithPlaceholder), 'Done: the config now loads from the environment first.')
})

test('codex: finished turn is only the final answer, no banner, echo, tools or token usage', () => {
  const ex = buildExcerpt(F.codexDone)
  assert.equal(ex, F.CODEX_DONE_ANSWER)
  assert.doesNotMatch(ex, NOISE)
})

test('codex: working screen is empty of UI, approval keeps the command and the options', () => {
  assert.doesNotMatch(buildExcerpt(F.codexWorking(12)), NOISE)
  const ex = buildExcerpt(F.codexApproval)
  assert.match(ex, /^I'll run the test suite/)
  assert.match(ex, /\$ npm test -- --runInBand/)
  assert.match(ex, /1\. Yes, proceed/)
  assert.doesNotMatch(ex, /Press enter|OpenAI Codex|model:|Fix the failing/)
})

test('long turns whose prompt echo scrolled out of the window still give the answer', () => {
  const cut = (lines: string[], marker: RegExp) => lines.slice(lines.findIndex((l) => marker.test(l)))
  const claude = cut(F.claudeWithPlaceholder, /^● Done/)
  assert.equal(buildExcerpt(claude), 'Done: the config now loads from the environment first.')
  const codex = cut(F.codexDone, /^• Edited/)
  assert.equal(buildExcerpt(codex), F.CODEX_DONE_ANSWER)
  assert.equal(buildExcerpt(cut(F.claudeDone(9), /^● Update/)), F.CLAUDE_DONE_ANSWER)
})

test('a selection panel without the usual dialog wording is still kept', () => {
  const ex = buildExcerpt([
    '● Bash(git status)', '  ⎿  clean', '',
    ' ☐ Colour', '', 'Which colour should the badge be?', '❯ 1. Red', '  2. Blue', '  3. Type something.', '',
    'Enter to select · ↑/↓ to navigate · Esc to cancel'
  ])
  assert.match(ex, /Which colour should the badge be\?/)
  assert.doesNotMatch(ex, /Enter to select/)
})

test('excerpt is bounded in lines and bytes, keeping the end, and never contains control sequences', () => {
  const long = ['● ' + 'start', ...Array.from({ length: 300 }, (_, i) => `  line ${i} \u001b[31mred\u001b[0m ${'x'.repeat(60)}`)]
  const ex = buildExcerpt(long)
  assert.ok(ex.split('\n').length <= 40)
  assert.ok(Buffer.byteLength(ex) <= 4096)
  assert.ok(ex.includes('line 299'))
  assert.equal(ex.includes('\u001b'), false)
  assert.equal(buildExcerpt(['plain text answer', '─'.repeat(40), '❯']), 'plain text answer')
  assert.equal(buildExcerpt([]), '')
})

test('normalization: two reads of the same screen with other timers are the same', () => {
  const a = normalizeExcerpt(buildExcerpt(F.claudeDone(9)))
  const b = normalizeExcerpt(buildExcerpt(F.claudeDone(131)))
  assert.equal(a, b)
  assert.equal(normalizeExcerpt('Built in 9s (↑ 1.2k tokens) at 10:42:07'), normalizeExcerpt('Built in 1m (↑ 14k tokens) at 11:03'))
  assert.notEqual(normalizeExcerpt('error at src/a.ts:41:12'), normalizeExcerpt('error at src/a.ts:88:03'), 'file positions are not clock times')
  assert.notEqual(normalizeExcerpt('3 tests failed'), normalizeExcerpt('5 tests failed'), 'counts of things still matter')
  assert.notEqual(normalizeExcerpt(F.CLAUDE_QUESTION_TEXT), normalizeExcerpt(F.CLAUDE_DONE_ANSWER))
})

test('hostile input is cleaned in linear time', () => {
  const nasty = [
    '✻ A' + ' for 1'.repeat(300) + '!',
    '✻ Thinking… (' + 'x'.repeat(5000),
    ' '.repeat(50_000) + '❯',
    '│' + ' '.repeat(40_000),
    '1'.repeat(40_000) + 'k tokens',
    '● ' + 'Tool('.repeat(5000),
    '\u001b[' + '9;'.repeat(20_000)
  ]
  const t = Date.now()
  buildExcerpt(nasty)
  normalizeExcerpt(nasty.join('\n'))
  assert.ok(Date.now() - t < 1000, `took ${Date.now() - t} ms`)
})
