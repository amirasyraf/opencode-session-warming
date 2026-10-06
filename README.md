# OpenCode session warming

A local plugin for **OpenCode v1.18.30** that makes best-effort cache-warming
requests for your root OpenAI/Codex OAuth sessions. It works while you're idle
and while the parent session is blocked waiting for foreground subagents or
long-running tools.

The same project also includes a small TUI status row with a segmented,
blue-to-red warming indicator. The engine and UI use separate entry files because
OpenCode v1 loads server and TUI plugins separately.

Warming runs inside the OpenCode process. OpenCode must remain running, and your
computer must be awake and connected. Requests use provider quota and can incur
costs. Cache retention and savings are not guaranteed.

## Supported setup

- OpenCode **1.18.30 stable release**.
- The built-in `openai` provider using ChatGPT/Codex OAuth.
- HTTP streaming requests to `https://chatgpt.com/backend-api/codex/responses`.
- Self-contained text conversation input and ordinary function-tool definitions.
- Root sessions only. Child/subagent requests do not reset their parent's timer.

Other providers, public OpenAI API requests, WebSockets, native LLM execution,
provider-managed conversations, server-side background jobs, hosted tools, and
media inputs are skipped. The plugin never changes your transport or credentials.
Explicit native/WebSocket flags disable it. Pre-release builds are unsupported;
some enable WebSockets implicitly. A conservative session-version check also
skips sessions whose recorded version is not `1.18.30`; this is not a substitute
for checking your installed binary with `opencode --version`.

## Install

Clone this repository using its SSH URL, or use the existing local checkout. The
plugin is TypeScript and runs directly inside OpenCode; no build step or runtime
npm dependencies are required.

From the checkout directory, print a ready-to-paste entry containing the **actual
file URL** (do not use a placeholder path):

```sh
node --input-type=module -e 'import {existsSync} from "node:fs"; import {resolve} from "node:path"; import {pathToFileURL} from "node:url"; const path=resolve("plugin.ts"); if(!existsSync(path)) throw new Error("Run this from the plugin checkout"); console.log(JSON.stringify([pathToFileURL(path).href,{enabled:true,intervalMs:240000,durationMs:3600000}],null,2))'
```

Paste that entry into the existing `plugin` array in
`~/.config/opencode/opencode.jsonc`, preserving your other entries. A missing
plugin path prevents this module from loading, so it cannot emit diagnostics.
Do not add v2's native
`warming` field to v1's configuration. Quit and restart OpenCode after changing
the plugin or its settings. Installing this checkout does not automatically
modify your global OpenCode configuration.

### Enable the indicator

The server entry remains in `opencode.jsonc`. Add the UI entry to the existing
`plugin` array in `~/.config/opencode/tui.json`. From this checkout, print the
correct entry:

```sh
node --input-type=module -e 'import {resolve} from "node:path"; import {pathToFileURL} from "node:url"; console.log(JSON.stringify([pathToFileURL(resolve("tui.tsx")).href,{color:true,showNextTimer:true,showRemainingTimer:true}],null,2))'
```

Both entries belong to this repository. Preserve your existing TUI settings and
quit/restart OpenCode after configuring it. OpenCode supplies the UI runtime;
the OpenTUI development packages are for type checking, not a build step.

The status row appears below the active route, so it remains visible with the
sidebar hidden. A child session shows its root parent's warming status. The bar
uses native TUI boxes with two-column segments, coloured backgrounds and gaps,
rather than outlined square characters. It is a terminal-grid widget, not a
pixel image with a rounded outline.

```text
Warming [✓ ✓ ✓ ▸               ] 4 req · sending… · 44:00 left
```

- Background fill shows elapsed time in the warming window; unfilled segments
  are muted. A `✓` marks a completed response, `▸`/`▹` a request in flight,
  `×` a failure, and `–` an abort. Fill by itself never means a request was sent.
- Colours run cool on the left to red on the right. Set `"color": false` for
  monochrome; `NO_COLOR` also disables the gradient. The symbols still identify
  outcomes without colour.
- The count is **requests attempted in the current window**, not cache hits.
  New ordinary activity resets it. Remaining time uses the engine's actual
  deadline. No completed-request marker is drawn just because time elapsed.
  Progress freezes when warming is stopped.
- Segment count is calculated as `ceil(duration / interval)`. Your four-minute /
  one-hour configuration gives fifteen time segments and up to fourteen warming
  requests (nothing starts at the 60-minute expiry). A shorter last interval gets
  a proportionally shorter time span. Long model responses and retries can skip
  or delay requests. High-frequency or narrow displays group time segments only
  when necessary to fit the terminal while preserving request counts.
- The row shows model activity, next request, sending, expiry, and stop reasons.
  It refreshes twice per second; extremely brief sending states may finish between
  refreshes. The last 128 attempt markers are retained; totals are not truncated.

UI options:

| Setting | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Show the indicator. |
| `color` | `true` | Use the cool-to-red gradient; `false` uses theme monochrome. |
| `maxSegments` | automatic | Optional positive integer display cap; otherwise derived from duration/interval and terminal width. |
| `showNextTimer` | `true` | Show the countdown to the next scheduled request. |
| `showRemainingTimer` | `true` | Show the remaining warming-window duration. |

Either timer can be disabled independently in the UI entry's options. When no
request is scheduled, the state says preparing, model active, or window ending;
it never displays a fake `next --:--` countdown. Warming intervals and duration
still come only from the engine settings in `opencode.jsonc`.

The UI reads private, metadata-only files under
`~/.local/state/opencode/session-warming/status/` (or `$XDG_STATE_HOME/opencode/`).
They contain times, counts and outcome marks—not prompts, snapshots, credentials,
or session-history changes. Writes are asynchronous, coalesced and atomic.
Active writers refresh a five-second heartbeat; readers reject stale data after
fifteen seconds or when its local owner process exits. Publication failures do not
affect warming. At most 64 roots are retained per writer; terminal records expire
after one hour, and shutdown removes owned records.

This bridge targets a local TUI/server sharing the same user's state directory.
Attaching to a remote server does not transport these files; the row reports no
status rather than inventing progress.

## Settings and timing

| Setting | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Enable the installed plugin. |
| `intervalMs` | `240000` (4 minutes) | Initial idle delay and minimum delay between completed warm attempts. |
| `durationMs` | `3600000` (1 hour) | Maximum warming window after the latest ordinary root-model request starts. |
| `debug` | `false` | Include routine scheduling, attempt-start, and ordinary-usage events at debug level. |

The one-hour default covers long subagent waits. Both time settings must be
positive safe integers, at most `2147483647` milliseconds, with `intervalMs`
strictly less than `durationMs`. Unknown settings or invalid values disable
warming and emit a diagnostic. Milliseconds keep configuration dependency-free.

Example settings: warm every three minutes for up to 45 minutes:

```jsonc
{
  "intervalMs": 180000,
  "durationMs": 2700000
}
```

For each recently active root session:

1. An ordinary model call invalidates old warming immediately, even if the new
   provider or request is unsupported.
2. A supported HTTP attempt starts the idle interval and fixed active window.
3. The plugin waits for that HTTP response body to finish. If the interval has
   already elapsed, the first warming attempt is immediately eligible.
4. After each warm attempt finishes, it waits another interval.
5. Warming never extends the window. At expiry it aborts locally and releases its
   state. Resume after sleep never sends catch-up bursts.

The parent's raw HTTP response can end while OpenCode still waits for a task.
That is why the plugin can warm a busy parent without entering its message queue.
It does not track task counts or use session `busy` as a generation signal.
Multiple active root sessions each have their own timers and usage.

## What is replayed

The plugin captures the latest completed outgoing request **after** OpenCode's
OAuth authentication and routing. Replays retain its instructions, conversation
prefix, model, reasoning configuration, function-tool schemas, and cache keys.
They append a transient instruction to do no work and reply `OK`, disable tool
selection, and set `store: false`.

Warming calls go directly to the provider. Their responses are discarded, without
adding chat messages, executing local tools, or emitting normal completion
notifications. The snapshot contains the prefix of the last outgoing request;
it does not reconstruct the final assistant response or in-progress tool results.

A single process-wide `fetch` shim intercepts only requests with the plugin's
opaque temporary marker. It strips the marker before transmission, preserves
ordinary response metadata and backpressure, and delegates other traffic. The
shim remains inert after disposal so late requests still have their markers
removed. All instance-owned registrations, timers, and snapshots are released.

Only recognized requests qualify. Stateful references, provider-hosted tools,
unimplemented input types, and JSON bodies over 16 MiB are skipped. The plugin
does not consume arbitrary request-body streams to classify them.

## Limits and failures

- **OAuth expiry:** replays use captured authorization in RAM. They do not refresh
  OAuth. A `401`/`403` stops that session until a new ordinary request supplies a
  fresh capture. The configured duration is a maximum, not a guarantee.
- **No hard output-token cap:** Codex does not have a verified output-cap field
  for this path. The `OK` instruction and 30-second local timeout are not billing
  ceilings, and aborting does not guarantee instantaneous remote cancellation.
- **Request failures:** `400`/`422` stop an incompatible snapshot. `429` respects
  `Retry-After` and the active window. Other failures wait at least one interval.
- **Response failures:** incomplete/error SSE streams, invalid warm JSON, and
  oversized responses count as failures. Successful JSON or empty HTTP 200
  responses are accepted. Metadata parsing is bounded to 1 MiB per SSE frame and
  8 MiB per response.
- **Session changes:** cancellation/errors, deletion, compaction, revert changes,
  disposal, and new ordinary model activity invalidate the snapshot. Title and
  summary generation do not replace it.
- **Transport completion:** HTTP success and EOF are not proof of semantic model
  success. OpenCode session-error events invalidate captures when reported.

Captured bodies and authenticated headers stay in memory only. Diagnostics never
include their content. Invalidation also detaches pending capture callbacks,
releasing their request data without cancelling ordinary traffic. The plugin uses
OpenCode's `session-warming` log service for capture, warming, skip, stop, and
usage events. Missing usage is unknown,
not zero. Existing ordinary-message token metadata is logged when available.

To disable, set `enabled: false` or remove the entry, then restart OpenCode.

## Troubleshooting

Every normal log message starts with **`[session-warming]`**. On this installation,
OpenCode writes to `~/.local/share/opencode/log/opencode.log` (or the corresponding
XDG data directory). Search for the prefix, not only the logger's service name.

```sh
rg '\[session-warming\]' ~/.local/share/opencode/log/opencode.log
```

- **`ready`** confirms initialization and records effective interval, duration,
  request timeout, and metadata timeout. No `ready` or `disabled` event means you
  should check the configured file URL and OpenCode's plugin-loader errors first.
- **`captured`** confirms a replayable ordinary request and records its next warm
  time and expiry. **`skipped`** identifies the specific unsupported provider,
  session version, endpoint, tools, input, or stateful request shape.
- **`warm-completed`** includes attempt ID, model, HTTP status, provider request
  ID when supplied, elapsed time, token usage, and next attempt time.
- **`warm-failed`** is a warning with correlation ID, status, retry eligibility,
  next attempt time where applicable, and a safe error category/code. Network
  errors, invalid SSE JSON, truncated/incomplete streams, and size limits are
  distinguished. Raw exception messages, stacks, and response bodies are omitted.
- **`warm-aborted`** distinguishes local request timeout, expiry, ordinary
  activity, disposal, and session cancellation/error. Expected aborts are info;
  request timeouts are warnings. Invalid options/internal faults are errors.

Enable `"debug": true` in plugin options **and** OpenCode debug logging
(`opencode --log-level DEBUG`) for scheduling and attempt-start detail.
Metadata reads have a five-second deadline, so a stuck local API call cannot
indefinitely block a model-request hook. Warm fetches settle on their local abort
even if another fetch wrapper ignores cancellation.

Logging is fire-and-forget, with a two-second deadline and at most eight calls in
flight; excess events are dropped and counted on the next accepted event. If the
logging API throws, rejects, or times out, it is retired until restart. A bounded
fallback writes safe JSON lines to
`~/.local/state/opencode/session-warming-fallback.log` (or `$XDG_STATE_HOME/opencode/`),
including a `logging-degraded` event. At most ten fallback entries per plugin
instance are attempted; files at 1 MiB are no longer appended. It never writes to
the terminal or loops recursively if fallback writing fails.

## Development and verification

Use Node >=22.18; `mise.toml` pins the development version. OpenCode runtime
typings are pinned to 1.18.30 and imported only as types. No Bun CLI is required.

```sh
mise install
npm ci
npm run check
npm run test:runtime
npm run test:tui
```

`check` runs TypeScript static checks and Node tests with mock transports and
fake clocks. The separate runtime test requires the installed `opencode`
**1.18.30** binary. It creates isolated HOME/XDG directories, synthetic OAuth
credentials, and a local mock provider; it never uses your accounts. It proves
parent warming during a foreground child, absence of history/tool/notification
side effects, normal continuation, and cancellation cleanup. Temporary processes
and files are cleaned up afterward.

`test:tui` additionally requires Python 3 on macOS/Linux. It starts an isolated
local v1 server and attaches a disposable TUI in a pseudo-terminal, checks the
session prompt and working keyboard input, and checks completed/sending/failed
markers using synthetic status records without submitting a model request. It
uses isolated HOME/XDG directories and does not touch running sessions.

No automated test contacts a live model provider. To establish actual benefit,
perform an explicitly enabled, limited control-versus-warmed experiment on your
provider and count all warming usage, not just the next request's cache hit.

AI agents should read [AGENTS.md](AGENTS.md) before making changes.
