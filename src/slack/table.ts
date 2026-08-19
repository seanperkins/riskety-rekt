import { MAX_SECTION_CHARS, MAX_SECTION_LINES } from "./config.js"
import type { Block } from "./recap.js"

export type TableRow = string[]

export type TableLayout = {
  rows: TableRow[]
  dropped: number
}

const wideCodePoint = (codePoint: number): boolean =>
  (codePoint >= 0x1100 && codePoint <= 0x115f) ||
  (codePoint >= 0x2329 && codePoint <= 0x232a) ||
  (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
  (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
  (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
  (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
  (codePoint >= 0xff00 && codePoint <= 0xff60) ||
  (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
  (codePoint >= 0x1f000 && codePoint <= 0x1faff) ||
  (codePoint >= 0x20000 && codePoint <= 0x3fffd) ||
  (codePoint >= 0x2600 && codePoint <= 0x27ff) ||
  codePoint === 0xfe0f ||
  codePoint === 0x20e3 ||
  (codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff)

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

function graphemes(value: string): string[] {
  return [...graphemeSegmenter.segment(value)].map((part) => part.segment)
}

function displayWidth(value: string): number {
  return graphemes(value).reduce(
    (width, grapheme) =>
      width + ([...grapheme].some((char) => wideCodePoint(char.codePointAt(0)!)) ? 2 : 1),
    0,
  )
}

function cleanCell(value: string): string {
  return value.replace(/`{3,}/g, "`")
}

export function truncateCell(value: string, maxWidth = 200): string {
  const cleaned = cleanCell(value)
  if (displayWidth(cleaned) <= maxWidth) return cleaned
  let result = ""
  let width = 0
  for (const grapheme of graphemes(cleaned)) {
    const nextWidth = displayWidth(grapheme)
    if (width + nextWidth > maxWidth - 1) break
    result += grapheme
    width += nextWidth
  }
  return `${result}…`
}

function tableText(title: string, headers: string[], layout: TableLayout): string {
  const shown = layout.rows.map((row) => row.map((cell) => truncateCell(cell)))
  const allRows = [headers.map((cell) => truncateCell(cell)), ...shown]
  if (layout.dropped > 0) {
    allRows.push([`…and ${layout.dropped} more`, ...headers.slice(1).map(() => "")])
  }
  const widths = headers.map((_, column) =>
    Math.max(...allRows.map((row) => displayWidth(row[column] ?? ""))),
  )
  const lines = allRows.map((row) =>
    row
      .map((cell, column) => {
        const value = cell ?? ""
        return value + " ".repeat(Math.max(0, (widths[column] ?? 0) - displayWidth(value)))
      })
      .join("  ")
      .trimEnd(),
  )
  return `*${title}*\n\`\`\`\n${lines.join("\n")}\n\`\`\``
}

export function tableLayout(title: string, headers: string[], rows: TableRow[]): TableLayout {
  let shown = rows
  let dropped = 0
  // MAX_SECTION_LINES counts header + data + the optional marker inside the fence.
  const dataCapacity = Math.max(0, MAX_SECTION_LINES - 1)
  const markerRows = rows.length > dataCapacity ? 1 : 0
  const visibleCapacity = Math.max(0, dataCapacity - markerRows)
  if (shown.length > visibleCapacity) {
    shown = shown.slice(0, visibleCapacity)
    dropped = rows.length - shown.length
  }
  let layout: TableLayout = { rows: shown, dropped }
  while (tableText(title, headers, layout).length > MAX_SECTION_CHARS && layout.rows.length > 0) {
    layout = { rows: layout.rows.slice(0, -1), dropped: layout.dropped + 1 }
  }
  return layout
}

export function table(title: string, headers: string[], layout: TableLayout): Block {
  return { type: "section", text: { type: "mrkdwn", text: tableText(title, headers, layout) } }
}

export function fallbackTable(title: string, headers: string[], layout: TableLayout): string {
  const rows = layout.rows.map((row) => row.map(cleanCell))
  if (layout.dropped > 0) rows.push([`…and ${layout.dropped} more`, ...headers.slice(1).map(() => "")])
  const plain = [title, headers.join("  "), ...rows.map((row) => row.join("  "))].join("\n")
  return plain.replace(/:\/\//g, ": / ")
}
