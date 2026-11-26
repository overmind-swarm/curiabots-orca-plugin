// Invented but realistic screens of Claude Code and Codex, as `terminal.read` returns them.
const R = '─'.repeat(78)
const CLAUDE_BANNER = [
  '\u001b[38;5;209m ▐▛███▜▌\u001b[0m   Claude Code v2.0.31',
  '▝▜█████▛▘  Opus 4.5 · Claude Max',
  '  ▘▘ ▝▝    ~/projects/demo-app',
  ''
]
const CLAUDE_FOOTER = [R, '❯ ', R, '  ⏵⏵ bypass permissions on (shift+tab to cycle)']
const PROMPT_ECHO = [
  '❯ Fix the failing date parser test in src/date.ts and explain the root cause.',
  '  Do not touch the public API. Run the test suite when done.',
  ''
]

/** Finished turn: banner, echo, tool calls, final answer, turn summary, footer. */
export const claudeDone = (secs: number) => [
  ...CLAUDE_BANNER,
  ...PROMPT_ECHO,
  '● Read(src/date.ts)',
  '  ⎿  Read 84 lines',
  '',
  '● Update(src/date.ts)',
  '  ⎿  Updated src/date.ts with 2 additions and 1 removal',
  '',
  '● Bash(npm test)',
  '  ⎿  Tests: 12 passed, 12 total',
  '',
  '● The parser failed because it read the month as zero-based. I fixed the offset in',
  '  `parseMonth` and all 12 tests pass now.',
  '',
  '  Root cause: the ISO month was compared against `getMonth()` without adding 1.',
  '',
  `\u001b[2m✻ Cooked for ${secs}s\u001b[0m`,
  '',
  ...CLAUDE_FOOTER
]
export const CLAUDE_DONE_ANSWER =
  'The parser failed because it read the month as zero-based. I fixed the offset in\n' +
  '`parseMonth` and all 12 tests pass now.\n\n' +
  'Root cause: the ISO month was compared against `getMonth()` without adding 1.'

/** The agent asks the user something in plain text. */
export const claudeQuestion = (secs: number) => [
  ...PROMPT_ECHO,
  '● Glob(src/**/*.ts)',
  '  ⎿  Found 31 files',
  '',
  '● I can fix this in two ways. Which one do you prefer?',
  '',
  '  1. Patch parseMonth only (small, safe).',
  '  2. Replace the parser with the date library already in package.json.',
  '',
  `✻ Brewed for ${secs}s`,
  '',
  ...CLAUDE_FOOTER
]
export const CLAUDE_QUESTION_TEXT =
  'I can fix this in two ways. Which one do you prefer?\n\n' +
  '1. Patch parseMonth only (small, safe).\n' +
  '2. Replace the parser with the date library already in package.json.'

/** Still working: spinner with counters; no answer yet. */
export const claudeWorking = (secs: number, tokens: string) => [
  ...CLAUDE_BANNER,
  ...PROMPT_ECHO,
  '● Read(src/date.ts)',
  '  ⎿  Read 84 lines',
  '',
  `✶ Churning… (${secs}s · ↓ ${tokens} tokens · esc to interrupt)`,
  '',
  ...CLAUDE_FOOTER
]

/** Permission dialog (an AskUserQuestion-less, classic tool permission). */
export const claudePermission = [
  ...CLAUDE_BANNER,
  ...PROMPT_ECHO,
  '● I will remove the stale build output first.',
  '',
  '● Bash(rm -rf dist)',
  '',
  ' Bash command',
  '',
  '   rm -rf dist',
  '   Remove the build directory',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  "   2. Yes, and don't ask again for rm commands in /home/dev/demo-app",
  '   3. No, and tell Claude what to do differently (esc)',
  ''
]

/** Only the banner and our own echo, nothing from the agent yet. */
export const claudeBannerAndEcho = [...CLAUDE_BANNER, ...PROMPT_ECHO, '✢ Pondering… (1s · esc to interrupt)', '', ...CLAUDE_FOOTER]

/** Two turns: the answer to the first one must not leak into the second one. */
export const claudeSecondTurn = [
  ...CLAUDE_BANNER,
  ...PROMPT_ECHO,
  '● First answer that is now history.',
  '',
  '❯ Thanks. Now add a regression test for February 29th.',
  '',
  '● Write(test/date.test.ts)',
  '  ⎿  Wrote 18 lines to test/date.test.ts',
  '',
  '● Added the leap-day regression test; it fails without the fix and passes with it.',
  '',
  '✻ Sautéed for 1m 4s',
  '',
  ...CLAUDE_FOOTER
]

/** Composer showing a placeholder suggestion after the answer. */
export const claudeWithPlaceholder = [
  ...PROMPT_ECHO,
  '● Done: the config now loads from the environment first.',
  '',
  '╭' + '─'.repeat(76) + '╮',
  '│ > Try "refactor src/config.ts"' + ' '.repeat(45) + '│',
  '╰' + '─'.repeat(76) + '╯',
  '  ? for shortcuts'
]

const CODEX_BANNER = [
  '╭' + '─'.repeat(48) + '╮',
  '│ >_ OpenAI Codex (v0.46.0)' + ' '.repeat(22) + '│',
  '│' + ' '.repeat(48) + '│',
  '│ model:     gpt-5-codex medium   /model to change │',
  '│ directory: ~/projects/demo-app' + ' '.repeat(17) + '│',
  '╰' + '─'.repeat(48) + '╯',
  '',
  '  To get started, describe a task or try one of these commands:',
  '',
  '  /init - create an AGENTS.md file with instructions for Codex',
  '  /status - show current session configuration',
  '  /model - choose what model and reasoning effort to use',
  ''
]
const CODEX_ECHO = [
  '› Fix the failing date parser test in src/date.ts and explain the root cause.',
  '  Do not touch the public API. Run the test suite when done.',
  ''
]
const CODEX_FOOTER = ['', '› Improve documentation in @filename', '', '  100% context left · ? for shortcuts']

export const codexDone = [
  ...CODEX_BANNER,
  ...CODEX_ECHO,
  '• Explored',
  '  └ Read date.ts',
  '',
  '• Edited src/date.ts (+2 -1)',
  '    41 -  const m = d.getMonth()',
  '    41 +  const m = d.getMonth() + 1',
  '',
  '• Ran npm test',
  '  └ Tests: 12 passed, 12 total',
  '',
  '• The failing test came from a zero-based month in `parseMonth`. I added the missing',
  '  +1 and the whole suite passes (12/12).',
  '',
  '  Token usage: total=18,204 input=15,311 (+ 90,112 cached) output=2,893',
  ...CODEX_FOOTER
]
export const CODEX_DONE_ANSWER =
  'The failing test came from a zero-based month in `parseMonth`. I added the missing\n' +
  '+1 and the whole suite passes (12/12).'

export const codexWorking = (secs: number) => [
  ...CODEX_BANNER,
  ...CODEX_ECHO,
  '• Explored',
  '  └ Read date.ts',
  '',
  `• Working (${secs}s • esc to interrupt)`,
  '',
  '› Improve documentation in @filename',
  '',
  '  100% context left · ? for shortcuts'
]

export const codexApproval = [
  ...CODEX_BANNER,
  ...CODEX_ECHO,
  "• I'll run the test suite to confirm the fix.",
  '',
  '  Would you like to run the following command?',
  '',
  '  $ npm test -- --runInBand',
  '',
  '› 1. Yes, proceed (y)',
  "  2. Yes, and don't ask again for this command (a)",
  '  3. No, and tell Codex what to do differently (esc)',
  '',
  '  Press enter to confirm or esc to cancel'
]
