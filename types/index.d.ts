export type DailyActivity = {
  date: string
  messageCount: number
  sessionCount: number
  toolCallCount: number
}

export type DailyModelTokens = {
  date: string
  tokensByModel: Record<string, number>
  /** Some of the day's sessions were deleted: their tokens come from the cache, scaled to one count a reply. */
  isEstimated?: boolean
  /** Requests only Headroom logged, which no transcript holds: auto mode's safety checks, compaction, titles. */
  hiddenCalls?: number
}

/** Claude Code's own `stats-cache.json`, merged with the transcripts' later days. */
export type UsageStats = {
  /** The last day counted, `YYYY-MM-DD`: today once merged, else the cache's last day. */
  computedThrough: string
  /** When the transcripts were last counted, in ms; null for the cache alone. */
  updatedAt: number | null
  firstDay: string | null
  hourCounts: Record<string, number>
  daily: DailyActivity[]
  dailyTokens: DailyModelTokens[]
}

export type StatsRange = 'all' | '30d' | '7d'

export type StatsTab = 'overview' | 'models'

declare module 'claude-code' {
  interface PluginState {
    'usage-stats': {
      stats: UsageStats | null
      failure: string | null
      /** Why the transcripts could not be counted, while the cache alone shows. */
      scanProblem: string | null
      range: StatsRange
      tab: StatsTab
      /** How many weeks the heatmap is scrolled back from this one. */
      weeksBack: number
      /** How many days the token chart is scrolled back from today. */
      daysBack: number
    }
  }
}
