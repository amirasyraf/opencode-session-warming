# OpenCode session warming

An OpenCode v1.18.x plugin that keeps supported root-session prompt prefixes
warm while OpenCode is waiting on a foreground subagent or long-running tool.
It also adds a warming indicator and session controls to the TUI.

Warming sends extra provider requests. They use quota and may cost money.
Cache retention and savings are not guaranteed. OpenCode must stay running and
the computer must stay awake and connected.

## Supported setup

- OpenCode 1.18.x stable releases
- OpenAI ChatGPT/Codex OAuth over the built-in `openai` provider
- OpenAI API GPT-5.6+ Responses at `api.openai.com/v1/responses`
- GitHub Copilot GPT-5.6+ Responses
- GitHub Copilot Claude Sonnet/Opus 5+ Messages with adaptive or disabled thinking
- Text, ordinary function tools, and the complete provider input chain, including file attachments and embedded base64 PNG/JPEG/WebP/GIF images
- Root sessions only

The plugin skips other providers, Copilot enterprise/custom endpoints, Chat
Completions, WebSockets, native LLM execution, provider-managed conversations,
hosted tools, audio, remote images, and unsupported request shapes.
Child activity does not reset the root session's timer.

The plugin does not change ordinary authentication, routing, request bytes,
response metadata, cancellation, or backpressure. It never refreshes OAuth,
writes session history, runs tools, or calls `session.prompt` for warming.

## Install

The plugin runs directly from the checkout. There is no build step and no
runtime npm dependency. Use Node 22.18 or newer for the development commands.

1. Clone the repository or use an existing checkout.
2. Use `opencode.jsonc.example` as a reference, replace the example file URL
   with the checkout path, and merge its `plugin` entry into
   `~/.config/opencode/opencode.jsonc`. Keep your existing entries.

3. To enable the TUI indicator, use `tui.json.example` as a reference, replace
   the example file URL with the checkout path, and merge its `plugin` entry
   into `~/.config/opencode/tui.json`.

4. Check the version with `opencode --version`, then fully quit and restart
   OpenCode.

The public repository does not include a project-level `opencode.json`. Your
local ignored copy can remain in place if you use it for troubleshooting.

The committed `opencode.jsonc.example` and `tui.json.example` files are the
configuration templates. Compare them after pulling changes; if either file
changes, review the corresponding local OpenCode config. Do not overwrite your
local config because it may contain other plugins.

## Configuration

The defaults enable warming for a one-hour window and enable the metadata
journal for 365 days.

```jsonc
{
  "enabled": true,
  "durationMs": 3600000,
  "debug": false,
  "journal": {
    "enabled": true,
    "retentionDays": 365
    // Optional: "maxBytes": 134217728
  }
}
```

| Setting | Default | Purpose |
| --- | --- | --- |
| `enabled` | `true` | Enable the server plugin. |
| `durationMs` | `3600000` | Warming window after ordinary activity or a manual start. |
| `intervalMs` | automatic | Global refresh interval override. |
| `providers` | none | Provider and exact model overrides. |
| `debug` | `false` | Add scheduling details to OpenCode logs. |
| `journal.enabled` | `true` | Enable local metadata history. |
| `journal.retentionDays` | `365` | Retention period for journal segments. |
| `journal.maxBytes` | none | Soft disk threshold that pauses new recording. |

Intervals and durations must be positive safe integers no larger than
`2147483647` milliseconds. Unknown or invalid options disable the plugin rather
than being silently ignored.

Overrides resolve independently as model, provider, explicit global, then
automatic policy. Model names are exact API IDs; wildcard matching is not used.

Example provider overrides:

```jsonc
{
  "providers": {
    "openai": {
      "models": {
        "gpt-5.6-luna": { "intervalMs": 1680000 }
      }
    },
    "github-copilot": {
      "models": {
        "gpt-5.6-luna": { "intervalMs": 1680000 },
        "claude-sonnet-5": { "intervalMs": 240000 },
        "claude-opus-5": { "intervalMs": 240000 }
      }
    }
  }
}
```

## Automatic refresh

| Request | Refresh interval | Evidence |
| --- | --- | --- |
| OpenAI API GPT-5.6+ | 28 minutes | OpenAI documents a 30-minute minimum. |
| Codex OAuth and Copilot GPT-5.6+ | 28 minutes | Upstream behavior is assumed. |
| Copilot Sonnet/Opus 5+ | 4 minutes | Default or mixed cache markers. |
| Copilot Sonnet/Opus 5+ with only `1h` markers | 58 minutes | Requested one-hour marker. |
| Older supported Codex models | 4 minutes | Retention is unknown. |

These are scheduling policies, not cache-expiry measurements. The plugin does
not claim a cache hit or a cost saving after a request completes.

## What happens

1. An ordinary root-model request replaces the previous warming snapshot,
   including when the new request is unsupported.
2. The plugin captures the outgoing request after OpenCode authentication and
   routing finish.
3. It waits for the ordinary response body to finish or be cancelled before
   scheduling warming. Stopping the agent keeps warming the captured input
   until the original window expires; it does not restart the timer.
4. A supported request is replayed directly to its provider at the selected
   interval, until the fixed window expires.
5. New ordinary activity, compaction, revert, deletion, non-cancellation errors,
   disposal, sleep/resume gaps, and incompatible responses stop the snapshot.
   A resumed root-model request can establish a fresh window after expiry.

The plugin never sends catch-up bursts after sleep. Once a snapshot expires or is invalidated, a fresh ordinary request is required to capture a replayable input again.

## Session controls

With both plugins enabled, use these commands in a session:

| Command | Effect |
| --- | --- |
| `/warming stop` | Abort the current warm request and keep warming stopped until you start it. |
| `/warming start` | Start a fresh window using the latest valid snapshot, or wait for supported model activity. |
| `/warming` | Open the warming action menu. |

The command palette also has **Start warming** and **Stop warming** actions. In a child view, they control its root parent and label the feedback accordingly. Commands execute directly without creating an assistant turn or writing session history.

Ordinary requests continue while warming is stopped and can supply a newer snapshot. The retained snapshot stays in RAM only until its existing expiry. Starting resets current-window statistics and progress, then schedules the first warm request one interval later. It waits for any ongoing ordinary response to finish. Starting an already enabled window does nothing.

Start cannot recover an expired or invalidated snapshot, bypass configuration, or refresh credentials. When no valid snapshot remains, the indicator shows **Awaiting activity** until a supported ordinary request arrives. Stop lasts for the running server instance; restarting OpenCode clears it. Resetting window statistics does not delete journal history.

Success feedback requires a server acknowledgement. If the result is not confirmed, check the indicator before retrying. Fully quit and restart OpenCode after updating the plugin to load the commands.

## Replay behavior and limits

- OpenAI API GPT-5.6+ uses the captured input with native `prewarm: true`,
  `store: false`, and no requested output.
- Codex preserves the complete captured input as a prefix, then appends its
  legacy transient `OK` instruction. It has no verified output cap on this path.
- Copilot GPT replays the captured input with a maximum of 128 output tokens,
  or the smaller captured limit.
- Copilot Claude retains messages, system content, tools, cache markers,
  thinking, effort, signatures, and tool selection. Its replay is capped at
  128 output tokens, or the smaller captured limit.
- Every supported replay preserves the complete captured provider input chain,
  including file attachments and their placement. Warming controls may change
  the surrounding request envelope, but the input is not stripped or rebuilt.

Generated local function calls are discarded and never executed. Explicit
thinking budgets that cannot fit the bounded replay are skipped rather than
changed. Captured bodies and authenticated headers stay in memory only.

Requests over 16 MiB, stateful conversation references, provider-hosted tools,
unsupported media, and malformed request structures are skipped. Attachment
blocks are preserved opaquely: the plugin does not inspect, resolve, upload, or
rewrite their sources, and the provider may reject a later replay if a
referenced attachment is unavailable. Attachment bytes count toward the 16 MiB
limit.

OAuth tokens are captured in memory and are not refreshed. A `401` or `403`
stops that snapshot until a new ordinary request supplies fresh credentials.
Aborting locally does not guarantee immediate remote cancellation.

## TUI indicator

When enabled, the indicator appears after LSP in the sidebar. If the sidebar is
hidden, it moves to the prompt row. Child sessions show their root parent's status. Rendering only observes warming; the session commands explicitly control it.

The bar shows elapsed time in the current warming window. Adjacent text shows
state, next request, remaining time, completed requests, failures, and, after a
provider reports usage, warm-request input/output and cache token statistics.
The sidebar keeps supported stat rows stable while status is available. It shows
cache reads, cache writes, a reported cache-read ratio, and output tokens from
admitted ordinary root steps and warm requests. Values appear as soon as an
admitted ordinary step reports usage; unavailable values remain `N/A`, while
unsupported metrics are omitted. Values are cumulative for the current warming
window. A filled bar or a completed response does not prove that a cache refresh
succeeded.

TUI options:

| Setting | Default | Purpose |
| --- | --- | --- |
| `enabled` | `true` | Enable the indicator and session commands. |
| `color` | `true` | Use the cool-to-red palette. `NO_COLOR` disables it. |
| `maxSegments` | automatic | Limit visible colour bands. |
| `showNextTimer` | `true` | Show the next-request countdown. |
| `showRemainingTimer` | `true` | Show the window countdown. |

The server and TUI plugins load separately. If the `Warming` section is missing,
check both config files and restart OpenCode.

## Journal and privacy

The journal is metadata only. It records warming outcomes, safe diagnostics,
provider/model IDs, opaque local IDs, timestamps, usage snapshots, and storage
health. It does not record prompts, response text, images, tool payloads,
snapshots, credentials, headers, titles, paths, or raw exception messages.

Files are stored under:

```text
~/.local/state/opencode/session-warming/events/
```

The path follows `$XDG_STATE_HOME` when set. Journal files are private, rotate
at 4 MiB or UTC date boundaries, and retain 365 days by default. There is no
default disk cap. `maxBytes` pauses new recording instead of deleting retained
history. Keep exported data private because its IDs still identify local work.

Inspect the journal without modifying it:

```sh
npm run --silent journal -- validate
npm run --silent journal -- export --from 2026-10-01 --to 2026-11-01 --provider openai
```

Set `journal.enabled` to `false` to disable persistence without disabling
warming. Restart OpenCode after changing the setting.

## Troubleshooting

Search the OpenCode log for the plugin prefix:

```sh
rg '\[session-warming\]' ~/.local/share/opencode/log/opencode.log
```

- `ready` means the server plugin initialized.
- `ui-ready` means the TUI plugin registered its slots.
- `captured` means the latest ordinary request can be replayed.
- `skipped` explains why a request shape, provider, model, or session was not supported.
- `warm-completed` means the response passed the protocol completion checks. It
  does not prove a cache refresh.
- `warm-failed` includes a safe failure category and retry decision.

If there is no `ready` event, check the configured server file URL and
OpenCode's plugin-loader errors. If there is no `ui-ready` event, check the TUI
file URL and the installed OpenCode version. Enable both plugin `debug` logging
and OpenCode debug logging when investigating scheduling:

```sh
opencode --log-level DEBUG
```

## Development

```sh
mise install
npm ci
npm run check
npm run test:runtime
npm run test:tui
```

The unit suite uses fake clocks and mock transports. Runtime and TUI tests use
isolated HOME/XDG directories and local mock providers. No automated test calls
a live model provider.

The project is MIT licensed. See `LICENSE`.
