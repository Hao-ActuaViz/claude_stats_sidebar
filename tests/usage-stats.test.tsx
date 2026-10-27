import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  buildCalendar,
  buildTokenChart,
  funFact,
  mergeStats,
  modelLabel,
  parseStatsCache,
  parseTranscriptScan,
  summarize,
} from '../hooks/stats'

const CACHE = {
  version: 5,
  lastComputedDate: '2026-10-21',
  dailyActivity: [
    { date: '2026-10-14', messageCount: 40, sessionCount: 1, toolCallCount: 10 },
    { date: '2026-10-19', messageCount: 100, sessionCount: 2, toolCallCount: 20 },
    { date: '2026-10-20', messageCount: 200, sessionCount: 3, toolCallCount: 30 },
    { date: '2026-10-21', messageCount: 300, sessionCount: 1, toolCallCount: 40 },
  ],
  dailyModelTokens: [
    {
      date: '2026-10-20',
      tokensByModel: { 'claude-opus-5-5': 3000, 'claude-haiku-4-5-20251001': 1000 },
    },
    { date: '2026-10-21', tokensByModel: { 'claude-opus-5-5': 6000 } },
  ],
  totalSessions: 7,
  totalMessages: 640,
  firstSessionDate: '2026-10-14T02:00:00.000Z',
  hourCounts: { '10': 3, '15': 9 },
}

// What scripts/scan_transcripts.py prints: Oct 21 again (the cache keeps its
// activity, the transcripts' tokens win) and Oct 22, which only it has.
const SCAN = {
  days: {
    '2026-10-21': { messages: 290, sessions: 1, toolCalls: 38, tokens: { 'claude-opus-5-5': 2500 } },
    '2026-10-22': { messages: 50, sessions: 1, toolCalls: 5, tokens: { 'claude-opus-5-5': 2000 } },
  },
  sessionHours: { '2026-10-21': { '15': 1 }, '2026-10-22': { '9': 1 } },
}

// Noon UTC on Thursday, Oct 22: the same local date in nearly every zone.
const NOW = Date.UTC(2026, 9, 22, 12)
const TODAY = '2026-10-22'

const PANE = {
  plugin: 'usage-stats',
  component: 'Pane',
  requestId: 'usage-stats',
  props: {
    title: 'Stats',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

type Scan = { exitCode: number; stdout: string; stderr: string }

/** The engine beneath the plugin: the stats cache, the scan script, a store, and the panes it opened. */
function world(on: On, options: { store?: Record<string, unknown>; scan?: Scan } = {}) {
  const scans: string[][] = []
  const opened: string[] = []
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, options.store ?? {})
  mock.env(on, { HOME: '/home/test' })
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: JSON.stringify(CACHE) }))
  on('process.run', (_, e) => {
    scans.push([...e.argv])
    const result = options.scan ?? { exitCode: 0, stdout: JSON.stringify(SCAN), stderr: '' }
    return { value: { ...result, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.register', () => ({ value: { command: 'stats-panel' } }))
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => undefined)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  return { scans, opened, clock }
}

test('the summary adds up each range', async () => {
  const stats = parseStatsCache(JSON.stringify(CACHE))

  const all = summarize(stats, 'all', TODAY)
  expect(all.messages).toBe(640)
  expect(all.sessions).toBe(7)
  expect(all.tokens).toBe(10_000)
  expect(all.models[0]).toEqual({ name: 'claude-opus-5-5', tokens: 9000 })
  expect(all.activeDays).toBe(4)
  expect(all.spanDays).toBe(9)
  expect(all.currentStreak).toBe(3)
  expect(all.longestStreak).toBe(3)
  expect(all.busiest).toEqual({ date: '2026-10-21', messages: 300 })

  const week = summarize(stats, '7d', TODAY)
  expect(week.messages).toBe(600)
  expect(week.activeDays).toBe(3)
  expect(week.spanDays).toBe(7)

  expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5')
  expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  expect(modelLabel('claude-fable-5')).toBe('Fable 5')
  expect(funFact(162_400_000)).toBe("You've used ~113× more tokens than the whole Harry Potter series.")
  expect(funFact(1000)).toBeNull()
})

test('the merge keeps the cache through its last day and counts tokens from the transcripts', async () => {
  const cache = parseStatsCache(JSON.stringify(CACHE))
  const merged = mergeStats(cache, parseTranscriptScan(JSON.stringify(SCAN)), TODAY, NOW)

  expect(merged.computedThrough).toBe(TODAY)
  expect(merged.updatedAt).toBe(NOW)
  expect(merged.daily.map(d => [d.date, d.messageCount])).toEqual([
    ['2026-10-14', 40],
    ['2026-10-19', 100],
    ['2026-10-20', 200],
    ['2026-10-21', 300],
    ['2026-10-22', 50],
  ])
  expect(merged.dailyTokens.find(row => row.date === '2026-10-21')?.tokensByModel).toEqual({
    'claude-opus-5-5': 2500,
  })
  expect(merged.dailyTokens.find(row => row.date === '2026-10-20')?.tokensByModel).toEqual(
    CACHE.dailyModelTokens[0]!.tokensByModel,
  )
  expect(merged.hourCounts).toEqual({ '9': 1, '10': 3, '15': 9 })

  const all = summarize(merged, 'all', TODAY)
  expect(all.messages).toBe(690)
  expect(all.sessions).toBe(8)
  expect(all.currentStreak).toBe(4)

  // Nothing yet today: a streak that reached yesterday is still alive.
  const quiet = mergeStats(cache, { days: {}, sessionHours: {} }, TODAY, NOW)
  expect(summarize(quiet, 'all', TODAY).currentStreak).toBe(3)
  expect(buildCalendar(quiet, TODAY, 1).weeks[0]?.[4]).toMatchObject({ date: TODAY, isPending: false })
})

test('the calendar ends on today, levels by quartile, and marks the uncounted day', async () => {
  const calendar = buildCalendar(parseStatsCache(JSON.stringify(CACHE)), TODAY, 2)
  const [first, last] = calendar.weeks

  expect(calendar.weeks.length).toBe(2)
  expect(first?.[0]?.date).toBe('2026-10-11')
  expect(last?.[0]?.date).toBe('2026-10-18')
  expect(last?.map(day => day?.level ?? null)).toEqual([0, 2, 3, 4, 0, null, null])
  expect(last?.[4]).toMatchObject({ date: TODAY, isPending: true })
  expect(first?.[3]).toMatchObject({ date: '2026-10-14', level: 1, isPending: false })
})

test('the token chart stacks each day by model and pages through the range', async () => {
  const cache = parseStatsCache(JSON.stringify(CACHE))
  const stats = mergeStats(cache, parseTranscriptScan(JSON.stringify(SCAN)), TODAY, NOW)

  const chart = buildTokenChart(stats, 'all', TODAY, 5)
  expect(chart.days.map(day => day.date)).toEqual([
    '2026-10-18',
    '2026-10-19',
    '2026-10-20',
    '2026-10-21',
    '2026-10-22',
  ])
  expect(chart.max).toBe(4000)
  // Opus, with the most tokens of all time, has Claude's orange at the bottom.
  expect(chart.days[2]).toMatchObject({
    total: 4000,
    segments: [
      { color: '#d77757', tokens: 3000 },
      { color: '#3987e5', tokens: 1000 },
    ],
  })
  expect(chart.days[1]).toMatchObject({ total: 0, segments: [], models: [] })

  // Four days back, it stops where the range starts.
  const earlier = buildTokenChart(stats, 'all', TODAY, 5, 4)
  expect(earlier.days.map(day => day.date)).toEqual([
    '2026-10-14',
    '2026-10-15',
    '2026-10-16',
    '2026-10-17',
    '2026-10-18',
  ])
  expect(earlier.max).toBe(4000)

  // Past five models, the rest share one gray segment on top.
  const many = {
    ...stats,
    dailyTokens: [{ date: TODAY, tokensByModel: { a: 6, b: 5, c: 4, d: 3, e: 2, f: 1, g: 1 } }],
  }
  const day = buildTokenChart(many, '7d', TODAY, 7).days.at(-1)
  expect(day?.segments.map(segment => segment.tokens)).toEqual([6, 5, 4, 3, 2, 2])
  expect(day?.segments.at(-1)?.color).toBe('#898781')
  expect(day?.models.at(-1)).toMatchObject({ tokens: 1, color: '#898781' })

  // Counted from the cache alone, today is not counted yet.
  expect(buildTokenChart(cache, '7d', TODAY, 7).days.at(-1)).toMatchObject({ date: TODAY, isPending: true })
})

test('the panel draws live counts on every surface', async ($, on) => {
  const { scans, opened } = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(opened).toEqual(['usage-stats'])
  await $.command.run({ command: 'stats-panel' })
  expect(scans.at(-1)).toEqual([
    'python3',
    '-I',
    expect.stringMatching(/\/scripts\/scan_transcripts\.py$/),
    '/home/test/.claude/projects',
    '/home/test/.cache/claude-usage-stats/scan-state.json',
  ])

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Text', text: /^Favorite model$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^690$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^4 days$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /updated \d\d:\d\d/ })).toBeDefined()

    if (surface === 'terminal') {
      // 48 columns: two a week, 22 weeks beside the weekday labels.
      const raster = await ui.find({ type: 'Raster', key: 'heatmap' })
      expect(raster?.props).toMatchObject({ rows: 8, columns: 48 })
      expect(await ui.find({ type: 'Text', text: /^May 24 – Oct 22, 2026$/ })).toBeDefined()

      await ui.press({ key: 'heatmap-earlier' })
      expect(await ui.find({ type: 'Text', text: /^Mar 8 – Aug 8, 2026$/ })).toBeDefined()
    } else {
      // Full-size squares, 13px a week: 25 weeks fit, the last of them this one.
      const svg = await ui.find({ type: 'Svg' })
      const source = String(svg?.props.source)
      expect(svg?.props.width).toBe(30 + 25 * 13)
      expect(source.match(/<rect id="c\d+" class="d /g)?.length).toBe(24 * 7 + 5)
      // Every square has its own tooltip, shown by CSS while it is hovered.
      expect(source.match(/#c\d+:hover~#t\d+\{display:inline\}/g)?.length).toBe(24 * 7 + 5)
      expect(source).toContain('<tspan>Thu, Oct 22, 2026</tspan>')
      expect(source).toContain('>50 messages · 1 session · 5 tool calls</tspan>')
      expect(source).not.toContain('Not counted yet')
      // Claude's orange: the app's clay and its emphasized step in the ramp.
      expect(source).toContain('.l2{fill:#d97757}.l3{fill:#c6613f}')
      expect(await ui.find({ type: 'Text', text: /^May 3 – Oct 22, 2026$/ })).toBeDefined()

      // Earlier moves half a pane back; it stops a year back, Later comes home.
      await ui.press({ key: 'heatmap-earlier' })
      const earlier = String((await ui.find({ type: 'Svg' }))?.props.source)
      expect(earlier.match(/<rect id="c\d+" class="d /g)?.length).toBe(25 * 7)
      expect(earlier).toContain('<tspan>Sat, Aug 1, 2026</tspan><tspan x="')
      expect(earlier).toContain('>No activity</tspan>')
      expect(await ui.find({ type: 'Text', text: /^Feb 8 – Aug 1, 2026$/ })).toBeDefined()
      await ui.press({ key: 'heatmap-earlier' })
      await ui.press({ key: 'heatmap-earlier' })
      expect(await ui.find({ type: 'Text', text: /^Oct 19, 2025 – Apr 11, 2026$/ })).toBeDefined()
      expect((await ui.find({ key: 'heatmap-earlier' }))?.props.dimColor).toBe(true)
    }
    for (let i = 0; i < 4; i += 1) await ui.press({ key: 'heatmap-later' })
    expect((await ui.find({ key: 'heatmap-later' }))?.props.dimColor).toBe(true)

    await ui.press({ key: 'range-7d' })
    expect(await ui.find({ type: 'Text', text: /^4 of 7$/ })).toBeDefined()
    await ui.press({ key: 'tab-models' })
    expect(await ui.find({ type: 'Text', text: /^Haiku 4\.5$/ })).toBeDefined()
    // The list is the legend: each model's swatch in its bars' color.
    expect((await ui.find({ type: 'Text', text: /^■$/ }))?.props.color).toBe('#d77757')
    expect(
      await ui.find({ type: 'Text', text: /^Tokens per day, Oct 16 – Oct 22, 2026, updated \d\d:\d\d\./ }),
    ).toBeDefined()
    if (surface === 'terminal') {
      // Two columns a day beside the axis, eight rows of bars over the dates.
      const bars = await ui.find({ type: 'Raster', key: 'tokens' })
      expect(bars?.props).toMatchObject({ rows: 9, columns: 6 + 7 * 2 })
    } else {
      const bars = String((await ui.find({ type: 'Svg' }))?.props.source)
      // A hover column a day, each with its tooltip; Oct 20 stacks Haiku on Opus.
      expect(bars.match(/<g class="c" id="c\d+">/g)?.length).toBe(7)
      expect(bars.match(/#c\d+:hover~#t\d+\{display:inline\}/g)?.length).toBe(7)
      expect(bars).toMatch(/<g class="c" id="c4">.*?<rect fill="#d77757"[^>]*\/><path fill="#3987e5"/)
      expect(bars).toContain('<tspan>Thu, Oct 22, 2026</tspan><tspan x="')
      expect(bars).toContain('>2k tokens</tspan>')
      expect(bars).toContain('>Haiku 4.5 · 1k</tspan>')
      expect(bars).toContain('>No tokens</tspan>')
    }
    await ui.press({ key: 'tab-overview' })
    await ui.press({ key: 'range-all' })
    await ui.unmount()
  }
})

test('a turn ends, and the transcripts are counted again', async ($, on) => {
  const { scans, clock } = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const before = scans.length

  const turn = { answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as const
  await $.turn.complete(turn)
  await $.turn.complete({ ...turn, turnId: 'u' })
  await clock.advance(2_000)
  await clock.settle()
  expect(scans.length).toBe(before + 1)
})

test('when the scan fails, the panel shows the cache and says why', async ($, on) => {
  world(on, { scan: { exitCode: 1, stdout: '', stderr: 'env: python3: No such file or directory\n' } })
  await $.command.run({ command: 'stats-panel' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^640$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /counted through Oct 21/ })).toBeDefined()
  expect(
    (await ui.find({ type: 'Text', text: /^Couldn't count your recent activity/ }))?.text,
  ).toBe("Couldn't count your recent activity: env: python3: No such file or directory")
  await ui.unmount()
})

// The kit raises no close of the person's, so this starts from the flag that close stores.
test('closed by the person, the panel stays closed until /stats-panel', async ($, on) => {
  const { opened } = world(on, { store: { isClosed: true } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(opened).toEqual([])

  await $.command.run({ command: 'stats-panel' })
  expect(opened).toEqual(['usage-stats'])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(opened).toEqual(['usage-stats', 'usage-stats'])
})
