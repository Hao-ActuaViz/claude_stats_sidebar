import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { StatsRange, StatsTab, UsageStats } from '../types'
import {
  buildCalendar,
  buildTokenChart,
  calendarSpan,
  clockTime,
  colorOf,
  compact,
  funFact,
  heatmapCells,
  heatmapSvg,
  localToday,
  mergeStats,
  modelColors,
  modelLabel,
  parseStatsCache,
  parseTranscriptScan,
  peakHour,
  plural,
  shortDate,
  summarize,
  svgDays,
  svgWeeks,
  terminalDays,
  terminalWeeks,
  tokenBarsSvg,
  tokenCells,
  tokenSpan,
  withCommas,
  YEAR_WEEKS,
} from './stats'
import type { TranscriptScan } from './stats'

const PANE = 'usage-stats'
const TITLE = 'Stats'
// Other sessions' turns show within this; this session's, after each turn.
const REFRESH_MS = 2 * 60_000
const AFTER_TURN_MS = 2_000
const TABS: { id: StatsTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'models', label: 'Models' },
]
const RANGES: { id: StatsRange; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: '30d', label: '30d' },
  { id: '7d', label: '7d' },
]

const stats = atom({ plugin: 'usage-stats', key: 'stats' } as const, null)
const failure = atom({ plugin: 'usage-stats', key: 'failure' } as const, null)
const range = atom({ plugin: 'usage-stats', key: 'range' } as const, 'all')
const tab = atom({ plugin: 'usage-stats', key: 'tab' } as const, 'overview')
const scanProblem = atom({ plugin: 'usage-stats', key: 'scanProblem' } as const, null)
const weeksBack = atom({ plugin: 'usage-stats', key: 'weeksBack' } as const, 0)
const daysBack = atom({ plugin: 'usage-stats', key: 'daysBack' } as const, 0)

/** One press of Earlier (1) or Later (-1): `step` more or less, kept within 0 and `maxBack`. */
function paged(back: number, direction: 1 | -1, step: number, maxBack: number): number {
  return Math.max(0, Math.min(maxBack, Math.min(back, maxBack) + direction * step))
}

// Claude Code's config folder holds the old stats cache and the transcripts.
async function configDir($: EngineInterface): Promise<string> {
  return (await $.env.get('CLAUDE_CONFIG_DIR')) || `${(await $.env.get('HOME')) ?? ''}/.claude`
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Claude Code stopped updating this file, so it is read once per load.
async function readCache($: EngineInterface): Promise<UsageStats | null> {
  const path = `${await configDir($)}/stats-cache.json`

  return (await $.fs.exists(path)) ? parseStatsCache(await $.fs.read(path)) : null
}

// Transcripts can pass the 4 MiB a mod reads at once, so a script counts them.
async function scanTranscripts($: EngineInterface): Promise<TranscriptScan> {
  const home = (await $.env.get('HOME')) ?? ''
  const { exitCode, stdout, stderr } = await $.process.run(
    [
      'python3',
      '-I',
      `${$.plugin.root}/scripts/scan_transcripts.py`,
      `${await configDir($)}/projects`,
      `${home}/.cache/claude-usage-stats/scan-state.json`,
    ],
    { timeoutMs: 120_000 },
  )
  if (exitCode !== 0) throw new Error(stderr.trim().split('\n').at(-1) || `the scan exited with ${exitCode}`)

  return parseTranscriptScan(stdout)
}

// A reload starts these over: one more read of the cache, one more scan.
let cache: UsageStats | null | undefined
let inFlight: Promise<void> | null = null
let pendingRefresh: { cancel: () => void } | null = null

// One refresh at a time: a caller that comes while one runs waits for that one.
function refresh($: EngineInterface): Promise<void> {
  inFlight ??= runRefresh($).finally(() => {
    inFlight = null
  })

  return inFlight
}

async function runRefresh($: EngineInterface) {
  if (cache === undefined) {
    try {
      cache = await readCache($)
    } catch {
      cache = null
    }
    // The cache shows at once; the scan's counts replace it when they come.
    if (cache && (await read($, stats)) === null) await update($, stats, () => cache ?? null)
  }
  try {
    const scan = await scanTranscripts($)
    const now = await $.clock.now()
    const merged = mergeStats(cache, scan, localToday(now), now)
    await update($, stats, () => merged)
    await update($, scanProblem, () => null)
    await update($, failure, () => null)
  } catch (error) {
    if (cache) await update($, scanProblem, () => reasonOf(error))
    else await update($, failure, () => `Couldn't count your transcripts: ${reasonOf(error)}`)
  }
}

// After a turn, give the transcript a moment to land, and fold a burst of turns into one scan.
function refreshSoon($: EngineInterface) {
  if (pendingRefresh) return
  pendingRefresh = $.clock.after(AFTER_TURN_MS, () => {
    pendingRefresh = null
    void refresh($).catch(() => undefined)
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'stats-panel',
      description: 'Open the Stats panel: your activity heatmap, streaks and tokens by model',
    })
    // A background refresh cut short by a reload has nobody left to tell.
    refresh($).catch(() => undefined)
    $.clock.every(REFRESH_MS, () => void refresh($).catch(() => undefined))
    if ((await $.store.get('isClosed')) !== true) {
      void $.ui.open({ id: PANE, title: TITLE })
    }

    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    refreshSoon($)

    return next(e)
  })

  on('command.run', { command: 'stats-panel' }, async $ => {
    await $.store.delete('isClosed')
    await refresh($)
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Stats panel opened.' }
  })

  // Closed by the person, it stays closed in later sessions until /stats-panel.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await $.store.set('isClosed', true)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const current = await read($, stats)
    const problem = await read($, failure)
    const chosenRange = await read($, range)
    const chosenTab = await read($, tab)
    const columns = e.props.bodyColumns

    if (current === null) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>{problem ?? 'Loading your usage stats…'}</Text>
          {problem !== null && <Button key="retry" label="Try again" onPress={() => refresh($)} />}
        </Box>
      )
    }
    if (current.daily.length === 0) {
      return <Text dimColor>No usage recorded yet.</Text>
    }
    const scanTrouble = await read($, scanProblem)

    const today = localToday(await $.clock.now())
    const summary = summarize(current, chosenRange, today)

    const header = (
      <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap" gap={1}>
        <Box flexDirection="row" gap="xs">
          {TABS.map(option => (
            <Button
              key={`tab-${option.id}`}
              label={option.label}
              variant={option.id === chosenTab ? 'primary' : 'secondary'}
              onPress={() => update($, tab, () => option.id)}
            />
          ))}
        </Box>
        <Box flexDirection="row" gap="xs">
          {RANGES.map(option => (
            <Button
              key={`range-${option.id}`}
              label={option.label}
              variant={option.id === chosenRange ? 'primary' : 'secondary'}
              onPress={() => update($, range, () => option.id)}
            />
          ))}
        </Box>
      </Box>
    )

    const isTerminal = e.surface === 'terminal'
    const freshness =
      current.updatedAt === null
        ? `counted through ${shortDate(current.computedThrough)}`
        : `updated ${clockTime(current.updatedAt)}`
    // A chart holds more than the pane shows: Earlier and Later page through it.
    const pager = (name: string, back: number, maxBack: number, span: string, move: (direction: 1 | -1) => unknown) =>
      maxBack > 0 && (
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Button key={`${name}-earlier`} label="‹ Earlier" dimColor={back >= maxBack} onPress={() => move(1)} />
          <Text dimColor size="caption">
            {span}
          </Text>
          <Button key={`${name}-later`} label="Later ›" dimColor={back === 0} onPress={() => move(-1)} />
        </Box>
      )

    if (chosenTab === 'models') {
      // A bar a day, stacked by model, over the whole range; the list under it
      // is the legend, each model in its color.
      const colors = modelColors(current)
      const shownDays = Math.min(summary.spanDays, isTerminal ? terminalDays(columns) : svgDays(columns))
      const maxDaysBack = summary.spanDays - shownDays
      const back = Math.min(await read($, daysBack), maxDaysBack)
      const step = Math.max(7, Math.floor(shownDays / 2))
      const tokens = buildTokenChart(current, chosenRange, today, shownDays, back)
      const span = tokenSpan(tokens)
      let bars: RenderElement
      if (e.surface === 'terminal') {
        const { Raster } = $.ui.resolve(e)
        bars = <Raster key="tokens" {...tokenCells(tokens)} />
      } else if (e.surface === 'desktop' || e.surface === 'vscode' || e.surface === 'mobile') {
        const { Svg } = $.ui.resolve(e)
        const busiest = tokens.days.reduce((best, day) => (day.total > best.total ? day : best))
        const { source, width, height } = tokenBarsSvg(tokens, columns)
        bars = (
          <Svg
            source={source}
            width={width}
            height={height}
            isInteractive
            alt={`Tokens per day by model, ${span}: the most, ${compact(busiest.total)}, on ${shortDate(busiest.date)}.`}
          />
        )
      } else {
        bars = <Text dimColor>This surface can't draw the chart.</Text>
      }

      return (
        <Box flexDirection="column" gap={1}>
          {header}
          {summary.models.length === 0 ? (
            <Text dimColor>No tokens recorded in this range.</Text>
          ) : (
            <Box flexDirection="column">
              {bars}
              {pager('tokens', back, maxDaysBack, span, direction =>
                update($, daysBack, n => paged(n, direction, step, maxDaysBack)),
              )}
              <Text dimColor size="caption">
                Tokens per day{maxDaysBack > 0 ? '' : `, ${span}`}, {freshness}. Tokens include prompt-cache reads.
              </Text>
            </Box>
          )}
          <Box flexDirection="column">
            {summary.models.map(model => (
              <Box flexDirection="row" justifyContent="space-between">
                <Box flexDirection="row" gap="xs">
                  <Text color={colorOf(colors, model.name)}>■</Text>
                  <Text>{modelLabel(model.name)}</Text>
                </Box>
                <Text dimColor tabular>
                  {compact(model.tokens)} · {Math.round((model.tokens / summary.tokens) * 100)}%
                </Text>
              </Box>
            ))}
          </Box>
        </Box>
      )
    }

    // The heatmap reaches back a year, as the CLI's /stats does. The pane shows
    // as many full-size weeks as fit, and Earlier and Later move them through it.
    const visible = isTerminal ? terminalWeeks(columns) : svgWeeks(columns)
    const maxBack = YEAR_WEEKS - visible
    const back = Math.min(await read($, weeksBack), maxBack)
    const step = Math.max(4, Math.floor(visible / 2))
    const calendar = buildCalendar(current, today, visible, back)
    let chart: RenderElement
    if (e.surface === 'terminal') {
      const { Raster } = $.ui.resolve(e)
      chart = <Raster key="heatmap" {...heatmapCells(calendar)} />
    } else if (e.surface === 'desktop' || e.surface === 'vscode' || e.surface === 'mobile') {
      const { Svg } = $.ui.resolve(e)
      const shown = calendar.weeks.flat().filter(day => day !== null && day.messages > 0).length
      const { source, width, height } = heatmapSvg(calendar)
      chart = (
        <Svg
          source={source}
          width={width}
          height={height}
          isInteractive
          alt={`Messages per day, ${calendarSpan(calendar)}: ${plural(shown, 'active day')}.`}
        />
      )
    } else {
      chart = <Text dimColor>This surface can't draw the heatmap.</Text>
    }
    const scroller = pager('heatmap', back, maxBack, calendarSpan(calendar), direction =>
      update($, weeksBack, n => paged(n, direction, step, maxBack)),
    )

    const hour = peakHour(current.hourCounts)
    const tiles: [string, string][] = [
      ['Sessions', withCommas(summary.sessions)],
      ['Messages', withCommas(summary.messages)],
      ['Total tokens', compact(summary.tokens)],
      ['Active days', `${summary.activeDays} of ${summary.spanDays}`],
      ['Current streak', plural(summary.currentStreak, 'day')],
      ['Longest streak', plural(summary.longestStreak, 'day')],
      chosenRange === 'all' && hour
        ? ['Peak hour', hour]
        : ['Most active day', summary.busiest ? shortDate(summary.busiest.date) : '—'],
      ['Favorite model', summary.models[0] ? modelLabel(summary.models[0].name) : '—'],
    ]
    const tileWidth = columns >= 72 ? '25%' : columns >= 36 ? '50%' : '100%'
    const fact = funFact(summary.tokens)

    return (
      <Box flexDirection="column" gap={1}>
        {header}
        <Box flexDirection="row" flexWrap="wrap" rowGap={1}>
          {tiles.map(([label, value]) => (
            <Box flexDirection="column" width={tileWidth}>
              <Text dimColor size="caption">
                {label}
              </Text>
              <Text weight="semibold">{value}</Text>
            </Box>
          ))}
        </Box>
        <Box flexDirection="column">
          {chart}
          {scroller}
          <Text dimColor size="caption">
            Messages per day{maxBack > 0 ? '' : `, ${calendarSpan(calendar)}`}, {freshness}. {fact ?? ''}
          </Text>
          {scanTrouble !== null && (
            <Text dimColor size="caption">
              Couldn't count your recent activity: {scanTrouble}
            </Text>
          )}
        </Box>
      </Box>
    )
  })
}
