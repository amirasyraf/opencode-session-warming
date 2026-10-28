# OpenCode session warming

[![Compatibility](https://github.com/amirasyraf/opencode-session-warming/actions/workflows/compatibility.yml/badge.svg?branch=main)](https://github.com/amirasyraf/opencode-session-warming/actions/workflows/compatibility.yml)

An OpenCode V2 (2.1.x and 2.2.x) plugin that keeps supported root-session prompt
prefixes warm while OpenCode is waiting on a foreground subagent or
long-running tool. It also adds a warming indicator and session controls to the
terminal UI. The main branch targets V2 only; OpenCode 1.18.x is no longer
supported.

It replays the session's real captured provider request. It does not use, and
must not run alongside, OpenCode's built-in `warming` setting, which appends a
keep-alive prompt through `session.generate`. Leave `warming` unset.

Warming sends extra provider requests. They use quota and may cost money.
Cache retention and savings are not guaranteed. OpenCode must stay running and
the computer must stay awake and connected.

## Supported setup

- OpenCode 2.1.x and 2.2.x stable releases; other versions remain disabled until verified
- OpenAI ChatGPT/Codex OAuth over the built-in `openai` provider, with the
  provider transport set to HTTP (see below)
- OpenAI API GPT-5.6+ Responses at `api.openai.com/v1/responses`
- GitHub Copilot GPT-5.6+ Responses (unit-tested only on V2)
- GitHub Copilot Claude Sonnet/Opus 5+ and Haiku 5.5+ Messages with adaptive or disabled thinking
  (unit-tested only on V2)
- Text, ordinary function tools, and the complete provider input chain, including file attachments and embedded base64 PNG/JPEG/WebP/GIF images
- Root sessions only

GPT-6.x models such as `gpt-6.1-sol` are eligible: model checks are numeric
(`gpt-5.6` and newer), and catalog aliases such as `gpt-6.1-sol-fast` resolve to
their provider API model first.

The plugin skips other providers, Copilot enterprise/custom endpoints, Chat
Completions, WebSocket traffic, provider-managed conversations, hosted tools,
audio, remote images, and unsupported request shapes. Child activity does not
reset the root session's timer.

### OpenAI needs the HTTP transport

OpenCode V2 sends OpenAI traffic over a per-session WebSocket by default. The
plugin captures ordinary requests through OpenCode's `http.request` /
`http.response` hooks, which cannot see WebSocket traffic, so it needs:

```jsonc
{ "providers": { "openai": { "settings": { "transport": "http" } } } }
```

The plugin does not change the transport itself. Without that setting it
reports **WebSocket transport** in the indicator and does not warm. The
tradeoff: over HTTP every step uploads the complete request (zstd-compressed
for ChatGPT accounts) instead of only the content added since the previous
step, and the WebSocket connection reuse is lost.

The plugin does not change ordinary authentication, routing, request bytes,
response status/headers, cancellation, or backpressure. It never refreshes
OAuth, writes session history, runs tools, or calls `session.prompt` or
`session.generate` for warming.

## Install

The checkout is a local V2 plugin directory: OpenCode loads `server.ts`, the
CLI loads `tui.tsx`, and both share the `rpc.ts` contract. There is no build
step and no runtime npm dependency. Use Node 22.18 or newer for the development
commands.

1. Clone the repository or use an existing checkout.
2. Use `opencode.jsonc.example` as a reference. Merge its `plugins` entry, with
   `package` set to the absolute checkout directory (a directory, not a file),
   and the OpenAI `transport: "http"` setting into
   `~/.config/opencode/opencode.jsonc`. Keep your existing entries.
3. The CLI loads the indicator automatically from the same directory. To change
   TUI options, merge the `cli.json.example` entry, using the same directory,
   into `~/.config/opencode/cli.json`.
4. Check the version with `opencode --version`, then run
   `opencode service restart` (or quit and restart OpenCode).

The public repository does not include a project-level `opencode.json`. Your
local ignored copy can remain in place if you use it for troubleshooting.

The committed `opencode.jsonc.example` and `cli.json.example` files are the
configuration templates. Compare them after pulling changes; if either file
changes, review the corresponding local OpenCode config. Do not overwrite your
local config because it may contain other plugins.

## OpenCode upgrades

Stable patches within 2.1.x and 2.2.x are allowed automatically. SDK dependency
pins are development baselines, not pins on your installed OpenCode.

The [Compatibility workflow](https://github.com/amirasyraf/opencode-session-warming/actions/workflows/compatibility.yml)
runs on pushes, pull requests, and daily. It checks unit/types plus real server
and terminal UI contracts on Linux and macOS against 2.1.0, the newest patch of
each supported minor, and the newest stable V2 release. Results and test logs
are available in Actions; the badge above shows the latest main-branch result.

A new minor is probed in a disposable copy without enabling it in your installed
plugin. After its contracts pass, admitting it should be a small support-range,
test, and documentation update, not a manual source audit. Investigate upstream
implementation only when a contract fails. Major versions and prereleases need
explicit review.

For a targeted check, use **Run workflow** with an exact version, or run
`npm run test:compatibility -- 2.2.0` locally. The command downloads a private
binary, runs both integration suites in parallel against local mocks, then
cleans up. It never changes your OpenCode installation or credentials.

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
automatic policy. Model names are exact provider API IDs (for example
`gpt-6.1-sol`, also for the `gpt-6.1-sol-fast` catalog entry); wildcard
matching is not used.

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
        "claude-opus-5": { "intervalMs": 240000 },
        "claude-haiku-5.5": { "intervalMs": 240000 }
      }
    }
  }
}
```

## Automatic refresh

| Request | Refresh interval | Evidence |
| --- | --- | --- |
| OpenAI API GPT-5.6+ | 28 minutes | OpenAI documents a 30-minute minimum. |
| Codex OAuth and Copilot GPT-5.6+ (including GPT-6.x) | 28 minutes | Upstream behavior is assumed. |
| Copilot Sonnet/Opus 5+ and Haiku 5.5+ | 4 minutes | Default or mixed cache markers. |
| Copilot Sonnet/Opus 5+ and Haiku 5.5+ with only `1h` markers | 58 minutes | Requested one-hour marker. |
| Older supported Codex models | 4 minutes | Retention is unknown. |

These are scheduling policies, not cache-expiry measurements. The plugin does
not claim a cache hit or a cost saving after a request completes.

## What happens

1. An ordinary root-model request replaces the previous warming snapshot,
   including when the new request is unsupported.
2. The plugin captures the outgoing HTTP request from OpenCode's `http.request`
   hook, after authentication, routing, and body compression.
3. It waits for the ordinary response body to finish or be cancelled before
   scheduling warming. Stopping the agent keeps warming the captured input
   until the original window expires; it does not restart the timer.
4. A supported request is replayed directly to its provider at the selected
   interval, until the window expires. You can extend a live window explicitly.
5. New ordinary activity, compaction, revert, deletion, non-cancellation errors,
   long sleep/resume gaps, and incompatible responses stop the snapshot.
   A retried root-model request can establish a fresh window after expiry.

OpenCode unloads idle projects and their plugins after 60 minutes by default
(configurable in 2.2.0, which also keeps active sessions and background jobs loaded).
Warming does not count as activity, but a live window keeps
warming in the background and the plugin picks it up again when the project
reloads, so a multi-hour window lasts its full duration. Restarting OpenCode,
changing the plugin's options, or editing the plugin code still ends it. If you
remove the plugin from your config mid-window, the old window keeps warming
until it expires.

After sleep, the plugin never sends catch-up bursts. If the computer wakes before
the provider's assumed cache lifetime has run out (for example, 30 minutes since
the last GPT request), it sends one warm request and continues. Otherwise the
cache is presumed cold and the snapshot is dropped. Once a snapshot expires or is
invalidated, a fresh ordinary request is required to capture a replayable input
again.

## Session controls

With both plugins enabled, use these commands in a session:

| Command | Effect |
| --- | --- |
| `/warming stop` | Abort the current warm request and keep warming stopped until you start it. |
| `/warming start` | Start a fresh window using the latest valid snapshot, or wait for supported model activity. |
| `/warming extend [duration]` | Add the specified duration to the current window. With no duration, add one configured window duration. |
| `/warming` | Open the warming action menu. |

`/warming` is a V2 argument slash command. OpenCode clears the prompt before
running it, so an invalid argument shows usage instead of staying editable.
The command palette also has **Start warming**, **Stop warming**, and **Extend warming** actions. In a child view, they control its root parent and label the feedback accordingly. Commands execute directly without creating an assistant turn or writing session history.

Ordinary requests continue while warming is stopped and can supply a newer snapshot. The retained snapshot stays in RAM only until its existing expiry. Starting resets current-window statistics and progress, then schedules the first warm request one interval later. It waits for any ongoing ordinary response to finish. Starting an already enabled window does nothing. Durations accept values such as `30m`, `1h`, or `1h30m`; extensions do not reset statistics or replay state.

Start cannot recover an expired or invalidated snapshot, bypass configuration, or refresh credentials. When no valid snapshot remains, the indicator shows **Awaiting activity** until a supported ordinary request arrives. Stop lasts for the running server instance; restarting OpenCode clears it. Resetting window statistics does not delete journal history.

Success feedback requires the server plugin's RPC response. If the result is not confirmed, check the indicator before retrying.

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

When enabled, the indicator appears in the sidebar. If the sidebar is hidden, it
moves to the prompt footer, and in views without a prompt it appears above the
composer. Child sessions show their root parent's status. Rendering only
observes warming; the session commands explicitly control it. If OpenCode's
native `warming` setting is configured, the indicator shows **Disabled** and the
plugin suspends itself for that project.

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

The TUI reads status from the server plugin over plugin RPC, so it also works
against a remote server that has the plugin configured. If the `Warming`
section is missing, check both config files and restart OpenCode.

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

The V2 port keeps the V1 journal location and record format (schema 1), so
existing history stays readable and is retained under the same policy. The V1
`status/` directory is no longer used; status now travels over plugin RPC.

Inspect the journal without modifying it:

```sh
npm run --silent journal -- validate
npm run --silent journal -- export --from 2026-10-01 --to 2026-11-01 --provider openai
```

Set `journal.enabled` to `false` to disable persistence without disabling
warming. Restart OpenCode after changing the setting.

## Troubleshooting

OpenCode V2 has no plugin logger, so the plugin writes its own private,
size-bounded log (current file plus one rotated generation):

```sh
rg '\[session-warming\]' ~/.local/state/opencode/session-warming/plugin.log
```

- `ready` means the server plugin initialized.
- `ui-ready` means the TUI plugin registered its slots.
- `captured` means the latest ordinary request can be replayed.
- `skipped` explains why a request shape, provider, model, or session was not supported.
- `warm-completed` means the response passed the protocol completion checks. It
  does not prove a cache refresh.
- `warm-failed` includes a safe failure category and retry decision.
- `skipped` with `websocket-transport` means OpenAI is still on WebSockets; set
  the provider transport to `http`.

If there is no `ready` event, check that the configured `package` is the
checkout directory, then look for plugin-loader errors in
`~/.local/share/opencode/log/opencode.log`. `opencode api get /api/plugin`
lists active plugins. If there is no `ui-ready` event, check `cli.json` and the
installed OpenCode version. Set the plugin's `debug` option to log scheduling
details.

## Development

```sh
mise install
npm ci
npm run check
OPENCODE_BIN=/path/to/private/opencode-2.2.0 npm run test:runtime
OPENCODE_BIN=/path/to/private/opencode-2.2.0 npm run test:tui
# Or download and test one version automatically:
npm run test:compatibility -- 2.2.0
```

The unit suite uses fake clocks and mock transports. Runtime and TUI tests need
an explicitly supplied 2.1.x or 2.2.x binary (or use the compatibility command
above). CI owns the multi-version matrix; ordinary local edits need
`npm run check`, with a targeted host check when changing host-facing behavior.
Development types stay pinned to 2.1.0 to preserve the older API baseline.
The integration suites run a private `opencode serve` with
isolated HOME, XDG, `OPENCODE_CONFIG_DIR`, and `OPENCODE_DB`, a fake isolated
ChatGPT credential, and a local mock provider behind a fixture plugin and a dead
proxy. No automated test calls a live model provider or touches the shared
background service.

The project is MIT licensed. See `LICENSE`.
