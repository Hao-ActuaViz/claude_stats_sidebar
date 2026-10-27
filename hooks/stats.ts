import type { DailyActivity, StatsRange, UsageStats } from '../types'

const DAY_MS = 86_400_000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export type Level = 0 | 1 | 2 | 3 | 4

export type CalendarDay = {
  date: string
  messages: number
  sessions: number
  toolCalls: number
  level: Level
  /** After the last day the cache has counted: today, usually. */
  isPending: boolean
}

export type Calendar = {
  /** One column per week, Sunday first; days after today are null. */
  weeks: (CalendarDay | null)[][]
  months: { week: number; label: string }[]
  computedThrough: string
}

export type Summary = {
  messages: number
  sessions: number
  toolCalls: number
  tokens: number
  models: { name: string; tokens: number }[]
  activeDays: number
  spanDays: number
  currentStreak: number
  longestStreak: number
  busiest: { date: string; messages: number } | null
}

// Days are counted as UTC midnights, so stepping one never meets a clock change.
export function dayNumber(date: string): number {
  const [year = 1970, month = 1, day = 1] = date.split('-').map(Number)
  return Date.UTC(year, month - 1, day) / DAY_MS
}

export function dateOf(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10)
}

export function localToday(nowMs: number): string {
  const now = new Date(nowMs)
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const isDate = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)

export function parseStatsCache(text: string): UsageStats {
  const raw = JSON.parse(text) as Record<string, unknown>
  if (!Array.isArray(raw.dailyActivity)) {
    throw new Error('the file has no dailyActivity list')
  }

  const daily: DailyActivity[] = (raw.dailyActivity as Record<string, unknown>[])
    .filter(row => isDate(row?.date))
    .map(row => ({
      date: row.date as string,
      messageCount: count(row.messageCount),
      sessionCount: count(row.sessionCount),
      toolCallCount: count(row.toolCallCount),
    }))
    .sort((a, b) => a.date.localeCompare(b.date))

  const dailyTokens = (Array.isArray(raw.dailyModelTokens) ? raw.dailyModelTokens : [])
    .filter((row: Record<string, unknown>) => isDate(row?.date))
    .map((row: Record<string, unknown>) => {
      const byModel = (row.tokensByModel ?? {}) as Record<string, unknown>
      const tokensByModel: Record<string, number> = {}
      for (const [model, tokens] of Object.entries(byModel)) tokensByModel[model] = count(tokens)

      return { date: row.date as string, tokensByModel }
    })

  const hours = (raw.hourCounts ?? {}) as Record<string, unknown>
  const hourCounts: Record<string, number> = {}
  for (const [hour, n] of Object.entries(hours)) hourCounts[hour] = count(n)

  const first = typeof raw.firstSessionDate === 'string' ? raw.firstSessionDate.slice(0, 10) : null

  return {
    computedThrough: isDate(raw.lastComputedDate)
      ? raw.lastComputedDate
      : (daily.at(-1)?.date ?? '1970-01-01'),
    updatedAt: null,
    firstDay: isDate(first) ? first : (daily[0]?.date ?? null),
    hourCounts,
    daily,
    dailyTokens,
  }
}

export type TranscriptDay = {
  messages: number
  sessions: number
  toolCalls: number
  tokens: Record<string, number>
}

/** What scripts/scan_transcripts.py prints: counts per local day. */
export type TranscriptScan = {
  days: Record<string, TranscriptDay>
  sessionHours: Record<string, Record<string, number>>
}

export function parseTranscriptScan(text: string): TranscriptScan {
  const raw = JSON.parse(text) as Record<string, unknown>
  const days: Record<string, TranscriptDay> = {}
  for (const [date, value] of Object.entries((raw.days ?? {}) as Record<string, Record<string, unknown>>)) {
    if (!isDate(date)) continue
    const tokens: Record<string, number> = {}
    for (const [model, n] of Object.entries((value.tokens ?? {}) as Record<string, unknown>)) tokens[model] = count(n)
    days[date] = {
      messages: count(value.messages),
      sessions: count(value.sessions),
      toolCalls: count(value.toolCalls),
      tokens,
    }
  }
  const sessionHours: Record<string, Record<string, number>> = {}
  for (const [date, hours] of Object.entries((raw.sessionHours ?? {}) as Record<string, Record<string, unknown>>)) {
    if (!isDate(date)) continue
    sessionHours[date] = {}
    for (const [hour, n] of Object.entries(hours)) sessionHours[date][hour] = count(n)
  }

  return { days, sessionHours }
}

/**
 * The cache's activity through its last day, the transcripts' after it.
 *
 * Tokens come from the transcripts wherever they have the day, since they
 * count a reply once and the cache counts it once per line of the reply.
 */
export function mergeStats(
  cache: UsageStats | null,
  scan: TranscriptScan,
  today: string,
  updatedAt: number,
): UsageStats {
  const through = cache?.computedThrough ?? ''
  const daily = new Map<string, DailyActivity>()
  for (const row of cache?.daily ?? []) if (row.date <= through) daily.set(row.date, row)
  for (const [date, day] of Object.entries(scan.days)) {
    if (date <= through || date > today) continue
    daily.set(date, {
      date,
      messageCount: day.messages,
      sessionCount: day.sessions,
      toolCallCount: day.toolCalls,
    })
  }

  const tokens = new Map<string, Record<string, number>>()
  for (const row of cache?.dailyTokens ?? []) tokens.set(row.date, row.tokensByModel)
  for (const [date, day] of Object.entries(scan.days)) {
    if (date <= today && Object.keys(day.tokens).length > 0) tokens.set(date, day.tokens)
  }

  const hourCounts = { ...cache?.hourCounts }
  for (const [date, hours] of Object.entries(scan.sessionHours)) {
    if (date <= through) continue
    for (const [hour, n] of Object.entries(hours)) hourCounts[hour] = (hourCounts[hour] ?? 0) + n
  }

  const firsts = [cache?.firstDay, ...Object.keys(scan.days)].filter(
    (date): date is string => typeof date === 'string',
  )

  return {
    computedThrough: today,
    updatedAt,
    firstDay: firsts.sort()[0] ?? null,
    hourCounts,
    daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
    dailyTokens: [...tokens]
      .map(([date, tokensByModel]) => ({ date, tokensByModel }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  }
}

function rangeStart(stats: UsageStats, range: StatsRange, today: string): string {
  if (range === '7d') return dateOf(dayNumber(today) - 6)
  if (range === '30d') return dateOf(dayNumber(today) - 29)

  return stats.firstDay ?? today
}

function streaks(dates: string[]): number[] {
  const runs: number[] = []
  let previous = Number.NaN
  for (const day of dates.map(dayNumber)) {
    if (day === previous + 1) runs[runs.length - 1]! += 1
    else runs.push(1)
    previous = day
  }

  return runs
}

export function summarize(stats: UsageStats, range: StatsRange, today: string): Summary {
  const from = rangeStart(stats, range, today)
  const days = stats.daily.filter(d => d.date >= from && d.date <= today)
  const active = days.filter(d => d.messageCount > 0)

  const byModel = new Map<string, number>()
  for (const row of stats.dailyTokens) {
    if (row.date < from || row.date > today) continue
    for (const [model, tokens] of Object.entries(row.tokensByModel)) {
      byModel.set(model, (byModel.get(model) ?? 0) + tokens)
    }
  }
  const models = [...byModel]
    .map(([name, tokens]) => ({ name, tokens }))
    .filter(m => m.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)

  // The current streak runs back from the last counted day, whatever the range;
  // counted through today, a streak that reached yesterday is still alive.
  const allActive = stats.daily.filter(d => d.messageCount > 0).map(d => d.date)
  const lastRun = streaks(allActive).at(-1) ?? 0
  const lastActive = allActive.at(-1)
  const isAlive =
    lastActive === stats.computedThrough ||
    (stats.computedThrough === today && lastActive === dateOf(dayNumber(today) - 1))
  const currentStreak = isAlive ? lastRun : 0

  const busiest = active.reduce<DailyActivity | null>(
    (best, d) => (best === null || d.messageCount > best.messageCount ? d : best),
    null,
  )

  return {
    messages: days.reduce((n, d) => n + d.messageCount, 0),
    sessions: days.reduce((n, d) => n + d.sessionCount, 0),
    toolCalls: days.reduce((n, d) => n + d.toolCallCount, 0),
    tokens: models.reduce((n, m) => n + m.tokens, 0),
    models,
    activeDays: active.length,
    spanDays: Math.max(1, dayNumber(today) - dayNumber(from) + 1),
    currentStreak,
    longestStreak: Math.max(0, ...streaks(active.map(d => d.date))),
    busiest: busiest && { date: busiest.date, messages: busiest.messageCount },
  }
}

/** Quartiles of the active days' message counts, so a level means the same at any width. */
export function levelThresholds(daily: DailyActivity[]): [number, number, number] {
  const counts = daily
    .map(d => d.messageCount)
    .filter(n => n > 0)
    .sort((a, b) => a - b)
  const at = (q: number) => counts[Math.max(0, Math.ceil(q * counts.length) - 1)] ?? 0

  return [at(0.25), at(0.5), at(0.75)]
}

export function levelOf(messages: number, [q1, q2, q3]: [number, number, number]): Level {
  if (messages <= 0) return 0
  if (messages <= q1) return 1
  if (messages <= q2) return 2
  if (messages <= q3) return 3

  return 4
}

/** `weekCount` weeks of days, the last of them `weeksBack` weeks before this one. */
export function buildCalendar(
  stats: UsageStats,
  today: string,
  weekCount: number,
  weeksBack = 0,
): Calendar {
  const end = dayNumber(today)
  const start = end - new Date(end * DAY_MS).getUTCDay() - (weeksBack + weekCount - 1) * 7
  const through = dayNumber(stats.computedThrough)
  const byDate = new Map(stats.daily.map(d => [d.date, d]))
  const thresholds = levelThresholds(stats.daily)

  const weeks: (CalendarDay | null)[][] = []
  const months: { week: number; label: string }[] = []
  for (let week = 0; week < weekCount; week += 1) {
    const column: (CalendarDay | null)[] = []
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const day = start + week * 7 + weekday
      if (day > end) {
        column.push(null)
        continue
      }
      const date = dateOf(day)
      const row = byDate.get(date)
      const messages = row?.messageCount ?? 0
      column.push({
        date,
        messages,
        sessions: row?.sessionCount ?? 0,
        toolCalls: row?.toolCallCount ?? 0,
        level: levelOf(messages, thresholds),
        isPending: day > through,
      })
    }
    weeks.push(column)

    // A month is named over the first week that starts in it; each drawing
    // leaves out those it has no room for.
    const month = new Date((start + week * 7) * DAY_MS).getUTCMonth()
    const previous = week === 0 ? -1 : new Date((start + (week - 1) * 7) * DAY_MS).getUTCMonth()
    if (month !== previous) months.push({ week, label: MONTHS[month]! })
  }

  return { weeks, months, computedThrough: stats.computedThrough }
}

export function withCommas(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export function compact(n: number): string {
  const steps: [number, string][] = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'k'],
  ]
  for (const [size, suffix] of steps) {
    if (n >= size) return `${(n / size).toFixed(n / size >= 100 ? 0 : 1).replace(/\.0$/, '')}${suffix}`
  }

  return withCommas(n)
}

export function plural(n: number, word: string): string {
  return `${withCommas(n)} ${word}${n === 1 ? '' : 's'}`
}

export function clockTime(ms: number): string {
  const at = new Date(ms)

  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

export function shortDate(date: string): string {
  const day = new Date(dayNumber(date) * DAY_MS)

  return `${MONTHS[day.getUTCMonth()]} ${day.getUTCDate()}`
}

export function longDate(date: string): string {
  const day = new Date(dayNumber(date) * DAY_MS)

  return `${WEEKDAYS[day.getUTCDay()]}, ${shortDate(date)}, ${day.getUTCFullYear()}`
}

export function peakHour(hourCounts: Record<string, number>): string | null {
  const [hour] = Object.entries(hourCounts).sort((a, b) => b[1] - a[1])[0] ?? []
  if (hour === undefined) return null
  const h = Number(hour)

  return `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'AM' : 'PM'}`
}

// Rough token counts, at about 4 tokens to 3 words, smallest first.
const BOOKS: [string, number][] = [
  ['The Great Gatsby', 63_000],
  ['Moby-Dick', 270_000],
  ['War and Peace', 780_000],
  ['the whole Harry Potter series', 1_440_000],
  ['the Encyclopaedia Britannica', 53_000_000],
]

/** The biggest book used at least ten times over, or the smallest if none is. */
export function funFact(tokens: number): string | null {
  const [book, size] = [...BOOKS].reverse().find(([, size]) => tokens / size >= 10) ?? BOOKS[0]!
  const times = Math.round(tokens / size)
  if (times < 2) return null

  return `You've used ~${withCommas(times)}× more tokens than ${book}.`
}

/** `claude-opus-5-5` reads `Opus 5.5`, `claude-haiku-4-5-20251001` `Haiku 4.5`. */
export function modelLabel(id: string): string {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id)
  if (!match) return id
  const [, family = '', major, minor] = match

  return `${family[0]!.toUpperCase()}${family.slice(1)} ${major}${minor ? `.${minor}` : ''}`
}

/** A year of weeks, as the CLI's /stats draws it: how far back the heatmap goes. */
export const YEAR_WEEKS = 53

/** Month names spaced so that no two labels run into each other. */
function spacedMonths(months: Calendar['months'], minWeeks: number): Calendar['months'] {
  return months.filter((month, i) => {
    const next = months[i + 1]
    return next === undefined || next.week - month.week >= minWeeks
  })
}

/** `Jun 1 – Oct 27, 2026`, with both years when the span crosses one. */
function spanOf(first: string, last: string): string {
  const year = (date: string) => date.slice(0, 4)

  return year(first) === year(last)
    ? `${shortDate(first)} – ${shortDate(last)}, ${year(last)}`
    : `${shortDate(first)}, ${year(first)} – ${shortDate(last)}, ${year(last)}`
}

/** The calendar's first and last day, `Jun 1 – Oct 27, 2026`. */
export function calendarSpan(calendar: Calendar): string {
  const days = calendar.weeks.flat().filter((day): day is CalendarDay => day !== null)
  const first = days[0]?.date
  const last = days.at(-1)?.date

  return first === undefined || last === undefined ? '' : spanOf(first, last)
}

// Claude's own colors. The ramp holds the app's clay (#d97757) and its
// emphasized step (#c6613f), each theme's steps validated as an ordinal ramp
// on the app's surface (#faf9f5 light, #262624 dark). Ink, gridlines and the
// tooltips take the app's muted text, borders and near-black/near-white.
const SVG_CELL = 11
const SVG_STEP = 13
const SVG_LEFT = 30
const SVG_TOP = 16
const SVG_LEGEND = 24
const SVG_FONT = 'text{font:10px system-ui,-apple-system,"Segoe UI",sans-serif;fill:#73726c}'
// A tooltip is a `.t` group, hidden until its mark is hovered.
const SVG_TIPS =
  '.t{display:none;pointer-events:none}.t .b{fill:#141413;opacity:.94}' +
  '.t text{font-size:11px;fill:#faf9f5}.t tspan:first-child{font-weight:600}'
const SVG_DARK = '@media (prefers-color-scheme:dark){text{fill:#9c9a92}.t .b{fill:#faf9f5}.t text{fill:#141413}'
const HEATMAP_STYLE = [
  SVG_FONT,
  SVG_TIPS,
  '.l0{fill:#e8e6dc}.l1{fill:#ef9a7e}.l2{fill:#d97757}.l3{fill:#c6613f}.l4{fill:#9f4323}',
  '.p{fill:none;stroke:#73726c;stroke-dasharray:2 2}',
  'rect.d:hover{stroke:#141413;stroke-width:1.5}',
  SVG_DARK,
  '.l0{fill:#3d3d3a}.l1{fill:#953a19}.l2{fill:#b65839}.l3{fill:#d97757}.l4{fill:#f8a78c}',
  '.p{stroke:#9c9a92}rect.d:hover{stroke:#faf9f5}}',
].join('')
const TIP_PAD = 8
const TIP_SWATCH = 12

/** How many weeks fit a pane `columns` cells wide, at about 7.6px a cell. */
export function svgWeeks(columns: number): number {
  return Math.max(8, Math.min(YEAR_WEEKS, Math.floor((columns * 7.6 - SVG_LEFT) / SVG_STEP)))
}

/** A tooltip line; a model's starts with its color. */
type TipLine = { text: string; swatch?: string }

const xml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const r1 = (n: number) => Math.round(n * 10) / 10

function tipSize(lines: TipLine[]): { width: number; height: number } {
  const longest = Math.max(...lines.map(line => line.text.length * 6.2 + (line.swatch ? TIP_SWATCH : 0)))

  return { width: Math.ceil(longest) + TIP_PAD * 2, height: 8 + 14 * lines.length }
}

/**
 * A tooltip drawn by the SVG itself, since the frame shows no native one:
 * CSS shows it while its mark is hovered. The first line is bold.
 */
function tipAt(lines: TipLine[], x: number, y: number, width: number, height: number): string {
  const swatches: string[] = []
  const spans = lines.map((line, i) => {
    if (line.swatch) {
      swatches.push(
        `<rect fill="${line.swatch}" x="${r1(x + TIP_PAD)}" y="${r1(y + 7 + i * 14)}" width="8" height="8" rx="2"/>`,
      )
    }
    const lineX = r1(x + TIP_PAD + (line.swatch ? TIP_SWATCH : 0))

    return i === 0 ? `<tspan>${xml(line.text)}</tspan>` : `<tspan x="${lineX}" dy="14">${xml(line.text)}</tspan>`
  })

  return (
    `<rect class="b" x="${r1(x)}" y="${r1(y)}" width="${width}" height="${height}" rx="4"/>${swatches.join('')}` +
    `<text x="${r1(x + TIP_PAD)}" y="${r1(y + 15)}">${spans.join('')}</text>`
  )
}

function dayTip(day: CalendarDay, computedThrough: string): TipLine[] {
  const when = { text: longDate(day.date) }
  if (day.isPending) return [when, { text: `Not counted yet (counted through ${shortDate(computedThrough)})` }]
  if (day.messages === 0) return [when, { text: 'No activity' }]

  return [
    when,
    {
      text: `${plural(day.messages, 'message')} · ${plural(day.sessions, 'session')} · ${plural(day.toolCalls, 'tool call')}`,
    },
  ]
}

/** A square's tooltip: above it, or below it on the top rows, inside the drawing. */
function squareTip(lines: TipLine[], cellX: number, cellY: number, width: number): string {
  const size = tipSize(lines)
  const boxWidth = Math.min(width, size.width)
  const x = Math.max(0, Math.min(width - boxWidth, cellX + SVG_CELL / 2 - boxWidth / 2))
  const above = cellY - size.height - 4

  return tipAt(lines, x, above >= 0 ? above : cellY + SVG_CELL + 4, boxWidth, size.height)
}

export function heatmapSvg(calendar: Calendar): { source: string; width: number; height: number } {
  const width = SVG_LEFT + calendar.weeks.length * SVG_STEP
  const height = SVG_TOP + 7 * SVG_STEP + SVG_LEGEND
  const parts: string[] = []

  for (const { week, label } of spacedMonths(calendar.months, 3)) {
    parts.push(`<text x="${SVG_LEFT + week * SVG_STEP}" y="${SVG_TOP - 5}">${label}</text>`)
  }
  for (const [weekday, label] of [[1, 'Mon'], [3, 'Wed'], [5, 'Fri']] as const) {
    parts.push(`<text x="0" y="${SVG_TOP + weekday * SVG_STEP + 9}">${label}</text>`)
  }
  // Each tooltip follows every square, so it paints over them, and `#cN:hover ~ #tN`
  // reaches it as a later sibling: CSS alone, as the frame runs no scripts.
  const tips: string[] = []
  const tipRules: string[] = []
  calendar.weeks.forEach((column, week) => {
    column.forEach((day, weekday) => {
      if (day === null) return
      const x = SVG_LEFT + week * SVG_STEP
      const y = SVG_TOP + weekday * SVG_STEP
      const id = tips.length
      parts.push(
        day.isPending
          ? `<rect id="c${id}" class="d p" x="${x + 0.5}" y="${y + 0.5}" width="${SVG_CELL - 1}" height="${SVG_CELL - 1}" rx="2"/>`
          : `<rect id="c${id}" class="d l${day.level}" x="${x}" y="${y}" width="${SVG_CELL}" height="${SVG_CELL}" rx="2"/>`,
      )
      tips.push(`<g class="t" id="t${id}">${squareTip(dayTip(day, calendar.computedThrough), x, y, width)}</g>`)
      tipRules.push(`#c${id}:hover~#t${id}{display:inline}`)
    })
  })

  // Less ▢▢▢▢▢ More, flush right under the grid.
  const legendY = SVG_TOP + 7 * SVG_STEP + 8
  const swatches = width - 36 - 5 * SVG_STEP
  parts.push(`<text x="${swatches - 26}" y="${legendY + 9}">Less</text>`)
  for (let level = 0; level <= 4; level += 1) {
    parts.push(
      `<rect class="l${level}" x="${swatches + level * SVG_STEP}" y="${legendY}" width="${SVG_CELL}" height="${SVG_CELL}" rx="2"/>`,
    )
  }
  parts.push(`<text x="${swatches + 5 * SVG_STEP + 3}" y="${legendY + 9}">More</text>`)

  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<style>${HEATMAP_STYLE}${tipRules.join('')}</style>${parts.join('')}${tips.join('')}</svg>`

  return { source, width, height }
}

// A model's color, the same in both themes: the CLI's Claude orange, then hues
// validated beside it as a stack's neighbors. The rest share one gray.
const MODEL_COLORS = ['#d77757', '#3987e5', '#199e70', '#9085e9', '#d55181']
const OTHER_COLOR = '#898781'

export type TokenDay = {
  date: string
  total: number
  /** The bar, bottom first: the models with a color of their own, then the rest as one. */
  segments: { color: string; tokens: number }[]
  /** The day's models, most tokens first, for its tooltip. */
  models: { name: string; tokens: number; color: string }[]
  isPending: boolean
}

export type TokenChart = {
  days: TokenDay[]
  /** The range's busiest day, so every page of it has one scale. */
  max: number
  computedThrough: string
}

const sum = (byModel: Record<string, number>) => Object.values(byModel).reduce((n, tokens) => n + tokens, 0)

/** Each model's color, by its tokens over all time, so no range or page repaints a model. */
export function modelColors(stats: UsageStats): Map<string, string> {
  const totals = new Map<string, number>()
  for (const row of stats.dailyTokens) {
    for (const [model, tokens] of Object.entries(row.tokensByModel)) totals.set(model, (totals.get(model) ?? 0) + tokens)
  }
  const ranked = [...totals].filter(([, tokens]) => tokens > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))

  return new Map(ranked.slice(0, MODEL_COLORS.length).map(([model], i) => [model, MODEL_COLORS[i]!]))
}

export function colorOf(colors: Map<string, string>, model: string): string {
  return colors.get(model) ?? OTHER_COLOR
}

/** `dayCount` days of the range's tokens, the last of them `daysBack` days before today. */
export function buildTokenChart(
  stats: UsageStats,
  range: StatsRange,
  today: string,
  dayCount: number,
  daysBack = 0,
): TokenChart {
  const colors = modelColors(stats)
  const slots = [...colors.values(), OTHER_COLOR]
  const byDate = new Map(stats.dailyTokens.map(row => [row.date, row.tokensByModel]))
  const from = rangeStart(stats, range, today)
  const through = dayNumber(stats.computedThrough)

  const dayOf = (day: number): TokenDay => {
    const date = dateOf(day)
    const models = Object.entries(byDate.get(date) ?? {})
      .filter(([, tokens]) => tokens > 0)
      .map(([name, tokens]) => ({ name, tokens, color: colorOf(colors, name) }))
      .sort((a, b) => b.tokens - a.tokens)
    const segments = slots
      .map(color => ({ color, tokens: models.filter(m => m.color === color).reduce((n, m) => n + m.tokens, 0) }))
      .filter(segment => segment.tokens > 0)

    return { date, total: models.reduce((n, m) => n + m.tokens, 0), segments, models, isPending: day > through }
  }

  const max = Math.max(
    0,
    ...stats.dailyTokens.filter(row => row.date >= from && row.date <= today).map(row => sum(row.tokensByModel)),
  )
  const last = dayNumber(today) - daysBack
  const days: TokenDay[] = []
  for (let day = Math.max(dayNumber(from), last - dayCount + 1); day <= last; day += 1) days.push(dayOf(day))

  return { days, max, computedThrough: stats.computedThrough }
}

/** The chart's first and last day, `Oct 1 – Oct 27, 2026`. */
export function tokenSpan(chart: TokenChart): string {
  const first = chart.days[0]?.date
  const last = chart.days.at(-1)?.date

  return first === undefined || last === undefined ? '' : spanOf(first, last)
}

/** The axis top: 1, 2, 2.5 or 5 times a power of ten, at or over `n`. */
function niceCeiling(n: number): number {
  if (n <= 0) return 1
  const power = 10 ** Math.floor(Math.log10(n))

  return ([1, 2, 2.5, 5, 10].find(step => step * power >= n) ?? 10) * power
}

// Columns at least 7px a day, a bar at most 24px, 2px of surface between
// stacked segments; past 62 days, a page's tooltips could pass the size a
// drawing may have.
const BAR_LEFT = 34
const BAR_TOP = 8
const BAR_PLOT = 120
const BAR_BOTTOM = 18
const BAR_MIN_STEP = 7
const BAR_WIDEST = 24
const BAR_GAP = 2
const BAR_MOST_DAYS = 62
const BARS_STYLE = [
  SVG_FONT,
  SVG_TIPS,
  '.g{stroke:#e8e6dc}.base{stroke:#c9c7bc}.x{text-anchor:middle}.y{text-anchor:end}',
  '.w{fill:transparent}.c:hover .w{fill:#141413;fill-opacity:.05}',
  SVG_DARK,
  '.g{stroke:#3d3d3a}.base{stroke:#5c5b56}.c:hover .w{fill:#faf9f5;fill-opacity:.07}}',
].join('')

const barsWidth = (columns: number) => Math.max(200, Math.floor(columns * 7.6))

/** How many days fit a pane `columns` cells wide. */
export function svgDays(columns: number): number {
  return Math.max(7, Math.min(BAR_MOST_DAYS, Math.floor((barsWidth(columns) - BAR_LEFT) / BAR_MIN_STEP)))
}

function tokenTip(day: TokenDay, computedThrough: string): TipLine[] {
  const when = { text: longDate(day.date) }
  if (day.isPending) return [when, { text: `Not counted yet (counted through ${shortDate(computedThrough)})` }]
  if (day.total === 0) return [when, { text: 'No tokens' }]

  return [
    when,
    { text: `${compact(day.total)} tokens` },
    ...day.models.map(model => ({ text: `${modelLabel(model.name)} · ${compact(model.tokens)}`, swatch: model.color })),
  ]
}

/** A bar's top segment: its data end rounded, square at the bottom. */
function barTop(x: number, width: number, top: number, bottom: number, color: string): string {
  const r = Math.min(4, width / 2, bottom - top)

  return (
    `<path fill="${color}" d="M${r1(x)} ${r1(bottom)}V${r1(top + r)}Q${r1(x)} ${r1(top)} ${r1(x + r)} ${r1(top)}` +
    `H${r1(x + width - r)}Q${r1(x + width)} ${r1(top)} ${r1(x + width)} ${r1(top + r)}V${r1(bottom)}Z"/>`
  )
}

export function tokenBarsSvg(chart: TokenChart, columns: number): { source: string; width: number; height: number } {
  const width = barsWidth(columns)
  const height = BAR_TOP + BAR_PLOT + BAR_BOTTOM
  const step = (width - BAR_LEFT) / Math.max(1, chart.days.length)
  const barWidth = Math.max(2, Math.min(BAR_WIDEST, step - BAR_GAP))
  const top = niceCeiling(chart.max)
  const baseline = BAR_TOP + BAR_PLOT
  const parts: string[] = []

  for (const share of [0, 0.5, 1]) {
    const y = Math.round(baseline - share * BAR_PLOT) + 0.5
    parts.push(`<line class="${share === 0 ? 'base' : 'g'}" x1="${BAR_LEFT}" x2="${width}" y1="${y}" y2="${y}"/>`)
    parts.push(`<text class="y" x="${BAR_LEFT - 6}" y="${y + 3}">${share === 0 ? '0' : compact(top * share)}</text>`)
  }
  // A date under every few bars, counted back from the last so it is named.
  const every = Math.ceil(44 / step)
  chart.days.forEach((day, i) => {
    if ((chart.days.length - 1 - i) % every !== 0) return
    const x = Math.min(width - 16, Math.max(BAR_LEFT + 16, BAR_LEFT + (i + 0.5) * step))
    parts.push(`<text class="x" x="${r1(x)}" y="${baseline + 14}">${shortDate(day.date)}</text>`)
  })

  // A day is a hover column the plot's height, its wash under the bar; its
  // tooltip sits beside the column, right of it unless that runs off the drawing.
  const tips: string[] = []
  const tipRules: string[] = []
  chart.days.forEach((day, i) => {
    const columnX = BAR_LEFT + i * step
    const barX = columnX + (step - barWidth) / 2
    const bars: string[] = []
    let y = baseline
    day.segments.forEach((segment, k) => {
      const h = (segment.tokens / top) * BAR_PLOT
      if (k === day.segments.length - 1) {
        bars.push(barTop(barX, barWidth, y - Math.max(1, h), y, segment.color))
      } else {
        const drawn = Math.max(1, h - BAR_GAP)
        bars.push(
          `<rect fill="${segment.color}" x="${r1(barX)}" y="${r1(y - drawn)}" width="${r1(barWidth)}" height="${r1(drawn)}"/>`,
        )
      }
      y -= h
    })
    parts.push(
      `<g class="c" id="c${i}"><rect class="w" x="${r1(columnX)}" y="${BAR_TOP}" width="${r1(step)}" height="${BAR_PLOT}"/>` +
        `${bars.join('')}</g>`,
    )

    const lines = tokenTip(day, chart.computedThrough)
    const size = tipSize(lines)
    const boxWidth = Math.min(width, size.width)
    const right = columnX + step + 4
    const x = right + boxWidth <= width ? right : Math.max(0, columnX - 4 - boxWidth)
    tips.push(`<g class="t" id="t${i}">${tipAt(lines, x, BAR_TOP, boxWidth, size.height)}</g>`)
    tipRules.push(`#c${i}:hover~#t${i}{display:inline}`)
  })

  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<style>${BARS_STYLE}${tipRules.join('')}</style>${parts.join('')}${tips.join('')}</svg>`

  return { source, width, height }
}

// The terminal draws the heatmap as a Raster, a week two columns, the day's
// square and a gap. Terminals are mostly dark, so it takes the dark ramp, with
// the CLI's own Claude orange, rgb(215,119,87), where the app has its clay.
const TERMINAL_DEFAULT = 0x01000000
const TERMINAL_MUTED = 0x898781
const TERMINAL_LEVELS = [0x3a3a37, 0x953a19, 0xb65839, 0xd77757, 0xf8a78c]
const SQUARE = 0x25a0
const HOLLOW = 0x25a1
const TERMINAL_LEFT = 4

export function terminalWeeks(columns: number): number {
  return Math.max(4, Math.min(YEAR_WEEKS, Math.floor((columns - TERMINAL_LEFT) / 2)))
}

/** A blank Raster to draw on: each cell a code point, a foreground and the terminal's own background. */
function raster(columns: number, rows: number) {
  const words = new Uint32Array(columns * rows * 3)
  const put = (row: number, column: number, codePoint: number, foreground: number) => {
    if (column >= columns) return
    const at = (row * columns + column) * 3
    words[at] = codePoint
    words[at + 1] = foreground
    words[at + 2] = TERMINAL_DEFAULT
  }
  const write = (row: number, column: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) put(row, column + i, text.charCodeAt(i), TERMINAL_MUTED)
  }
  for (let row = 0; row < rows; row += 1) write(row, 0, ' '.repeat(columns))

  return { put, write, cells: () => base64(new Uint8Array(words.buffer)) }
}

export function heatmapCells(calendar: Calendar): { columns: number; rows: number; cells: string } {
  const columns = TERMINAL_LEFT + calendar.weeks.length * 2
  const rows = 8
  const { put, write, cells } = raster(columns, rows)

  for (const { week, label } of spacedMonths(calendar.months, 2)) write(0, TERMINAL_LEFT + week * 2, label)
  write(2, 0, 'Mon')
  write(4, 0, 'Wed')
  write(6, 0, 'Fri')
  calendar.weeks.forEach((column, week) => {
    column.forEach((day, weekday) => {
      if (day === null) return
      put(
        weekday + 1,
        TERMINAL_LEFT + week * 2,
        day.isPending ? HOLLOW : SQUARE,
        day.isPending ? TERMINAL_MUTED : TERMINAL_LEVELS[day.level]!,
      )
    })
  })

  return { columns, rows, cells: cells() }
}

// The terminal's bars: a day two columns, the bar and a gap, drawn in eighths
// of a cell (U+2581 is one eighth, U+2588 the whole cell), the axis at the left.
const TERMINAL_AXIS = 6
const BAR_ROWS = 8
const EIGHTHS = 0x2580

export function terminalDays(columns: number): number {
  return Math.max(7, Math.floor((columns - TERMINAL_AXIS) / 2))
}

export function tokenCells(chart: TokenChart): { columns: number; rows: number; cells: string } {
  const columns = TERMINAL_AXIS + chart.days.length * 2
  const rows = BAR_ROWS + 1
  const { put, write, cells } = raster(columns, rows)
  const top = niceCeiling(chart.max)

  write(0, 0, compact(top).padStart(TERMINAL_AXIS - 1))
  write(BAR_ROWS - 1, 0, '0'.padStart(TERMINAL_AXIS - 1))
  chart.days.forEach((day, i) => {
    // Each segment's top, in eighths of a cell above the baseline; a cell
    // takes the color of the segment at its middle.
    let reach = 0
    const tops = day.segments.map(segment => ({
      color: segment.color,
      top: (reach += (segment.tokens / top) * BAR_ROWS * 8),
    }))
    const height = day.total > 0 ? Math.max(1, Math.round(reach)) : 0
    for (let row = 0; row * 8 < height; row += 1) {
      const filled = Math.min(8, height - row * 8)
      const color = (tops.find(segment => segment.top >= row * 8 + filled / 2) ?? tops.at(-1))!.color
      put(BAR_ROWS - 1 - row, TERMINAL_AXIS + i * 2, EIGHTHS + filled, parseInt(color.slice(1), 16))
    }
  })
  // Dates under the bars, left to right, wherever the last leaves room.
  let free = TERMINAL_AXIS
  chart.days.forEach((day, i) => {
    const column = TERMINAL_AXIS + i * 2
    const label = shortDate(day.date)
    if (column < free || column + label.length > columns) return
    write(BAR_ROWS, column, label)
    free = column + label.length + 2
  })

  return { columns, rows, cells: cells() }
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += BASE64[(n >> 18) & 63]! + BASE64[(n >> 12) & 63]!
    out += b === undefined ? '=' : BASE64[(n >> 6) & 63]!
    out += c === undefined ? '=' : BASE64[n & 63]!
  }

  return out
}
