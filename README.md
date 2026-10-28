# claude_stats_sidebar

Claude keeps removing official stats dashboard this really annoys me, so this brings it back: a
Claude Code mod that keeps a **Stats** panel beside the chat, with a year-long activity heatmap and
your tokens per day by model. It updates as you work.

## What it shows

**Overview**

- Sessions, messages, total tokens, active days, current and longest streak, peak hour (or most
  active day) and favorite model.
- A calendar heatmap of messages per day, in Claude's own orange. Hover a square for that day's
  messages, sessions and tool calls. **‹ Earlier** and **Later ›** page back through the year.

**Models**

- A bar a day of tokens, stacked by model. Hover a bar for the day's total and each model's share.
  Earlier and Later page through the range when it doesn't fit the pane.
- Every model's tokens and share of the total. The list doubles as the chart's legend.

**All / 30d / 7d** set the range for both tabs. The desktop app draws the charts as SVG. The
terminal draws them in block characters.

## Install

1. Clone the repo where you keep mods:

   ```bash
   git clone https://github.com/KobyashiMaru/claude_stats_sidebar.git ~/.claude/mods/usage-stats
   ```

2. Point Claude Code at it in `~/.claude/settings.json`:

   ```json
   {
     "env": {
       "CLAUDE_CODE_PLUGIN_DIRS": "/Users/you/.claude/mods/usage-stats",
       "CLAUDE_CODE_PLUGIN_DIR_WATCH": "1"
     }
   }
   ```

   `CLAUDE_CODE_PLUGIN_DIR_WATCH` reloads the mod when its files change, so a `git pull` takes
   effect without a restart.

3. Copy the `/stats-panel` command file into your own commands:

   ```bash
   mkdir -p ~/.claude/commands && cp ~/.claude/mods/usage-stats/extras/stats-panel.md ~/.claude/commands/
   ```

   The desktop app stops a session's Claude Code when the session sits idle, and the mod only
   registers `/stats-panel` once Claude Code runs again. Without this file, the app answers
   "/stats-panel isn't a command here" until you send something else first. With it, the app
   knows the command all along: the session starts, the mod answers it, and Claude never reads
   the file. If the mod isn't loaded, the file has Claude tell you so.

4. Restart Claude Code, or quit and reopen the desktop app. The panel opens on its own. If you
   close it, it stays closed in later sessions until you run `/stats-panel`.

You need a Claude Code with mod support (built against 2.1.311) and `python3` on your `PATH`.

## How it counts

- Days up to the last one in `~/.claude/stats-cache.json` come from that file. Claude Code no
  longer updates it.
- Later days come from your transcripts in `~/.claude/projects`, counted by
  `scripts/scan_transcripts.py`. The script keeps per-file counts in
  `~/.cache/claude-usage-stats/scan-state.json`, so it only rereads files that changed.
- It counts when a session starts, every 2 minutes, and 2 seconds after each turn.
- A message is a user, assistant, attachment or system line. A reply's tokens count once, and
  include prompt-cache reads. A session counts on the day it started.
- `CLAUDE_CONFIG_DIR` is respected in place of `~/.claude`.

Everything stays on your machine: the mod reads local files and runs a local script, nothing more.

## Colors

The heatmap's orange ramp holds the desktop app's clay `#D97757` and its darker clay `#C6613F`,
with steps for light and dark checked for contrast and color-blind separation. The terminal uses
the CLI's own Claude orange, `rgb(215,119,87)`. Models take that orange first, then blue, aqua,
violet and pink, by tokens over all time, so a range never repaints a model. Any further models
share a gray.

## Development

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

| Path | What it holds |
|---|---|
| `.claude-plugin/plugin.json` | The mod's manifest |
| `hooks/register.tsx` | The panel, the `/stats-panel` command and the refresh schedule |
| `hooks/stats.ts` | Counting, merging, and drawing the charts |
| `scripts/scan_transcripts.py` | The transcript counter |
| `types/index.d.ts` | The mod's state |
| `tests/usage-stats.test.tsx` | Tests |
| `extras/stats-panel.md` | The `/stats-panel` command file to copy into `~/.claude/commands` |

Claude Code writes `.claude-plugin/types/` itself, and it stays out of git. The command file sits
in `extras/`, not `commands/`, so Claude Code doesn't also load it as one of the mod's own commands.
