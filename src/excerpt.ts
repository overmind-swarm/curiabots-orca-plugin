// Turns a raw terminal read of a coding-agent TUI (Claude Code, Codex) into the text worth sending
// to the cloud: the agent's last relevant answer, without banner, prompt echo or status chrome.
// Pure functions, no Orca. Every regex here is linear: anchored, with bounded repetitions, and it
// only ever runs on lines already cut to MAX_LINE characters.
import { sanitizeLine, truncateTailBytes } from './util.ts'

const MAX_LINE = 1000
const FRAME_ONLY = /^[\s─-╿▀-▟=_-]{3,}$/

/** Lines that are interface, never content: spinners, timers, hints, banners, composer chrome. */
const CHROME: readonly RegExp[] = [
  // Claude Code spinner / turn summary: `✻ Cooked for 9s`, `✶ Churning… (45s · ↓ 1.2k tokens · esc to interrupt)`
  /^[✻✶✳✢✽✺·] \p{Lu}[\p{L}-]{0,30}(?:…|\.\.\.)(?: \([^)]{0,120}\))?$/u,
  /^[✻✶✳✢✽✺·] \p{Lu}[\p{L}-]{0,30} for (?:\d+h )?(?:\d+m )?\d+s$/u,
  /^[✻✶✳✢✽✺·*] .{0,80}\(esc to interrupt.{0,80}$/,
  /^∴ Thought for /,
  // Claude Code footer and hints
  /^(?:⏵⏵|⏸)/,
  /^\? for shortcuts/i,
  /shift\+tab to cycle/i,
  /^(?:esc|ctrl\+c|ctrl-c)\b.{0,60}\b(?:to interrupt|to exit|to cancel)/i,
  /^(?:Esc|Enter|Tab)\b.{0,80}\bto (?:cancel|select|navigate|confirm)\b/i,
  /^Press (?:enter|Enter|Esc|esc|Ctrl-C)\b.{0,60}\b(?:to confirm|to cancel|to continue|again to exit)/,
  /\(ctrl\+o to expand\)$/,
  /^Context (?:left|low)\b/i,
  /^[✗⚠] Auto-update/,
  // Banners
  /[▐▛▜▌▝▘▙▟]/,
  /Welcome to Claude Code/,
  /^\/help for help/,
  /^cwd: /,
  /^(?:※ )?Tip: /,
  /^Try "/,
  /^>_ .{0,40}Codex/,
  /^To get started, describe a task/,
  /^\/(?:init|status|approvals|model|review|new|compact|diff|mention|mcp|logout|quit) - /,
  // Codex status line, composer hints and exit summary
  /^(?:[•◦] )?Working \(.{0,100}\)$/,
  /^[•◦] (?:Working|Thinking)\b.{0,60}(?:esc to interrupt|\d+s)/,
  /\b\d{1,3}% context left\b/,
  /^⏎ send/,
  /^[⌃^]J newline/,
  /^Token usage: /,
  /^To continue this session, run codex resume/,
  // Empty composer
  /^[❯>›]$/
]
/** Settings printed inside a box (the Codex banner). */
const BOXED_CHROME = /^(?:model|directory|approval|sandbox|reasoning effort|reasoning summaries|session id|workspace|account):/i

const MARKER = /^ ?[●⏺•] +(.*)$/
const PROMPT = /^ ?[❯›>](?: (.*))?$/
const MENU_ITEM = /^ ?[❯›>] ?\d+[.)]/
const DIALOG_CUES: readonly RegExp[] = [
  /\b(?:Do you want to|Would you like to)\b/,
  /^[❯›]?\s*1\.\s+(?:Yes|Allow|Approve)\b/,
  /^Allow .{1,100}\?$/
]
const CODEX_TOOL = /^(?:Explor(?:ed|ing)\b|Updated Plan\b|Waited\b|Waiting\b|(?:Edited|Added|Deleted) \S.{0,200} \(\+\d+ -\d+\)$)/
const CLAUDE_TOOL = /^[A-Z][A-Za-z0-9_.:-]{0,40}\(.*\)$|\(MCP\)/

interface Line {
  text: string
  boxed: boolean
}

function prepare(raw: readonly string[]): Line[] {
  const out: Line[] = []
  for (const r of raw) {
    let text = sanitizeLine(r.length > MAX_LINE * 2 ? r.slice(0, MAX_LINE * 2) : r)
    if (text.length > MAX_LINE) text = text.slice(0, MAX_LINE)
    text = text.replace(/\t/g, '  ')
    let boxed = false
    const lead = text.length - text.trimStart().length
    const first = text[lead]
    if (lead <= 3 && (first === '│' || first === '┃')) {
      boxed = true
      text = text.slice(lead + 1)
      if (text.startsWith(' ')) text = text.slice(1)
      const t = text.trimEnd()
      if (t.endsWith('│') || t.endsWith('┃')) text = t.slice(0, -1)
      text = text.trimEnd()
    }
    out.push({ text, boxed })
  }
  return out
}

function isChrome(l: Line): boolean {
  const t = l.text.trim()
  if (t === '') return false // blank lines are kept for paragraphs
  if (FRAME_ONLY.test(t)) return true
  if (l.boxed && BOXED_CHROME.test(t)) return true
  return CHROME.some((re) => re.test(t))
}

const nonBlank = (l: Line) => l.text.trim() !== ''

function isToolBlock(block: Line[]): boolean {
  const head = MARKER.exec(block[0]!.text)?.[1]?.trim() ?? ''
  const next = block.slice(1).find(nonBlank)?.text.trim() ?? ''
  if (/^[⎿└]/.test(next)) return true
  return CLAUDE_TOOL.test(head) || CODEX_TOOL.test(head)
}

/**
 * The agent's last relevant output from the raw lines of a terminal read:
 * - control sequences, banner, status/spinner/hint lines and box borders are removed;
 * - everything up to the last prompt echo (what we typed) is cut, and so is the prompt box at the end;
 * - of the agent's output blocks (`●` Claude Code, `•` Codex) the last text block is kept, tool calls
 *   and their results dropped; if the screen ends in a question or a permission dialog the last block
 *   is kept whole so the dialog and its options are visible;
 * - at most `maxLines` lines and `maxBytes` bytes, keeping the end.
 */
export function buildExcerpt(raw: readonly string[], maxLines = 40, maxBytes = 4096): string {
  const kept = prepare(raw).filter((l) => !isChrome(l))

  // Last prompt echo. A trailing prompt line with nothing after it is the composer (it may show a
  // placeholder), unless there is nothing but chrome between it and the echo before it.
  const prompts: number[] = []
  kept.forEach((l, i) => {
    if (PROMPT.test(l.text) && !MENU_ITEM.test(l.text)) prompts.push(i)
  })
  let echo = -1
  const last = prompts.at(-1)
  if (last !== undefined) {
    echo = last
    if (!kept.slice(last + 1).some(nonBlank)) {
      const prev = prompts.at(-2)
      if (prev !== undefined && kept.slice(prev + 1, last).some(nonBlank)) echo = prev
    }
  }
  let body = kept.slice(echo + 1)
  // The composer left at the end, if the echo found is the one before it.
  if (echo >= 0 && last !== undefined && echo !== last) body = kept.slice(echo + 1, last)

  const starts: number[] = []
  body.forEach((l, i) => {
    if (MARKER.test(l.text)) starts.push(i)
  })
  let chosen: Line[]
  if (starts.length === 0) {
    // No output blocks: the echo's wrapped continuation (indented, up to the first blank line) goes too.
    let from = 0
    if (echo >= 0) while (from < body.length && /^ {2}\S/.test(body[from]!.text)) from++
    chosen = body.slice(from)
  } else {
    const blocks = starts.map((s, k) => body.slice(s, starts[k + 1] ?? body.length))
    const tail = body.filter(nonBlank).slice(-20)
    const dialog = tail.some((l) => DIALOG_CUES.some((re) => re.test(l.text.trim())))
    if (dialog) {
      chosen = blocks.at(-1)!
    } else {
      chosen = [...blocks].reverse().find((b) => !isToolBlock(b)) ?? blocks.at(-1)!
    }
  }

  const lines = chosen.map((l, i) => {
    const t = i === 0 ? (MARKER.exec(l.text)?.[1] ?? l.text) : l.text
    return i === 0 ? t.trim() : t.replace(/^ {1,2}/, '').trimEnd()
  })
  const text: string[] = []
  for (const l of lines) {
    if (l.trim() === '') {
      if (text.length > 0 && text.at(-1) !== '') text.push('')
    } else text.push(l)
  }
  while (text.at(-1) === '') text.pop()
  return truncateTailBytes(text.slice(-maxLines).join('\n'), maxBytes)
}

/**
 * The excerpt without what changes by itself between two reads of the same screen: durations,
 * token counters, clock times, spinner glyphs and spacing. Two reports with the same normalized
 * excerpt tell the user nothing new.
 */
export function normalizeExcerpt(excerpt: string): string {
  return excerpt
    .replace(/[✻✶✳✢✽✺∴]/g, '')
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|sec|secs|seconds|min|mins|minutes|hrs?|h|s|m)\b/gi, '#')
    .replace(/\b\d[\d.,]{0,12}\s?[kKmM]?\s?tokens?\b/gi, '#')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
}
