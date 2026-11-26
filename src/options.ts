// Detects the numbered selector of a coding-agent TUI (Claude Code's question and permission
// prompts: `❯ 1. Yes / 2. No / 3. Type something`). Pure, linear: every regex is anchored on a
// trimmed line of at most 1000 characters.
import { prepare } from './excerpt.ts'
import type { Line } from './excerpt.ts'

export interface ScreenOption {
  n: number
  label: string
}

const ITEM = /^([❯›>]) ?([1-9])[.)] +(\S.*)$|^([1-9])[.)] +(\S.*)$/
const HINT = /^(?:Enter to select|Esc to cancel|Press enter to confirm|Press Enter to confirm|Do you want to |Would you like to )/i
const MARKER = /^ ?[●⏺•] /
const MAX_LABEL = 120
const WINDOW = 60
const MAX_GAP = 6

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g

interface Item {
  at: number
  n: number
  label: string
  cursor: boolean
}

function parseItem(text: string, at: number): Item | null {
  const m = ITEM.exec(text.trim())
  if (!m) return null
  const label = (m[3] ?? m[5] ?? '').replace(CONTROL, ' ').trim().slice(0, MAX_LABEL)
  return label ? { at, n: Number(m[2] ?? m[4]), label, cursor: m[1] !== undefined } : null
}

/**
 * The options of the selector the screen ends in, or [] if it does not end in one. A selector is a
 * run of items numbered 1, 2, 3... (up to 9; a few description lines may sit between them) that has
 * the cursor on an item or is followed by a selection hint, and after which the agent printed
 * nothing. A plain numbered list inside an answer is not a selector.
 */
export function detectOptions(raw: readonly string[]): ScreenOption[] {
  const lines: Line[] = prepare(raw).filter((l) => l.text.trim() !== '').slice(-WINDOW)
  const runs: Item[][] = []
  let run: Item[] = []
  lines.forEach((l, at) => {
    const item = parseItem(l.text, at)
    if (item?.n === 1) {
      run = [item]
      runs.push(run)
    } else if (item && run.length > 0 && item.n === run.at(-1)!.n + 1 && item.at - run.at(-1)!.at <= MAX_GAP) {
      run.push(item)
    }
  })
  const last = runs.at(-1)
  if (!last || last.length < 2) return []
  const end = last.at(-1)!.at
  const after = lines.slice(end + 1)
  if (after.some((l) => MARKER.test(l.text))) return []
  const hint = after.some((l) => HINT.test(l.text.trim())) || lines.slice(last[0]!.at, end + 1).some((l) => HINT.test(l.text.trim()))
  if (!last.some((x) => x.cursor) && !hint) return []
  return last.map((x) => ({ n: x.n, label: x.label }))
}
