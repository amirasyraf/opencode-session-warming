# OpenCode session warming

A local plugin for **OpenCode v1.18.x** that makes best-effort cache-warming
requests for your root OpenAI and GitHub Copilot sessions. It works while you're idle
and while the parent session is blocked waiting for foreground subagents or
long-running tools.

The same project also includes a sidebar status section with a continuous,
colour-segmented warming indicator and a compact fallback. The engine and UI use separate entry files because
OpenCode v1 loads server and TUI plugins separately.

Warming runs inside the OpenCode process. OpenCode must remain running, and your
computer must be awake and connected. Requests use provider quota and can incur
costs. Cache retention and savings are not guaranteed.

## Supported setup

- OpenCode **1.18.x stable releases**. Patch versions within the 1.18 minor
  release are supported; pre-release builds and other minor versions are not.
- The built-in `openai` provider using ChatGPT/Codex OAuth HTTP Responses,
  including existing supported older Codex models.
- OpenAI API-key GPT-5.6+ HTTP Responses at `https://api.openai.com/v1/responses`.
- GitHub Copilot GPT-5.6+ HTTP Responses at `https://api.githubcopilot.com/responses`.
- GitHub Copilot Claude Sonnet/Opus 5+ Anthropic Messages at
  `https://api.githubcopilot.com/v1/messages`, with adaptive/disabled thinking.
- Self-contained text and embedded-image conversation input, including image
  function results, and ordinary function-tool definitions.
- Root sessions only. Child/subagent requests do not reset their parent's timer.

Other providers, Copilot enterprise/custom endpoints, Chat Completions, WebSockets, native LLM execution,
provider-managed conversations, server-side background jobs, hosted tools, and
audio, file inputs, and remotely referenced images are skipped. Embedded PNG,
JPEG, WebP, and GIF images use base64 data URLs and are retained unchanged in RAM.
The plugin never changes your ordinary transport or credentials. Model versions
are compared numerically using the actual API model ID, not display aliases.
Newer model names qualify only when their requests match the implemented protocol
contract; new input features and hosted tools remain unsupported.
Explicit native/WebSocket flags disable it. Pre-release builds are unsupported;
some enable WebSockets implicitly. A conservative session-version check also
skips sessions whose recorded version is not in `1.18.x`; this is not a substitute
for checking your installed binary with `opencode --version`.

## Install

Clone this repository using its SSH URL, or use the existing local checkout. The
plugin is TypeScript and runs directly inside OpenCode; no build step or runtime
npm dependencies are required.

From the checkout directory, print a ready-to-paste entry containing the **actual
file URL** (do not use a placeholder path):

```sh
node --input-type=module -e 'import {existsSync} from "node:fs"; import {resolve} from "node:path"; import {pathToFileURL} from "node:url"; const path=resolve("plugin.ts"); if(!existsSync(path)) throw new Error("Run this from the plugin checkout"); console.log(JSON.stringify([pathToFileURL(path).href,{enabled:true,durationMs:3600000}],null,2))'
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

The Warming section appears directly after LSP and before Todos/modified files in
the sidebar. It scrolls with the other sections. When the sidebar is hidden, a
compact indicator appears on the right of the agent/model row inside the prompt.
Child sessions show their root parent's status; child and permission/question
views without a prompt use a compact fallback with one blank row below it. Only
one indicator is displayed at a time. The UI never changes sidebar visibility.

The bar uses native TUI backgrounds with no gaps or visible glyphs. Its overall
width follows available space, independently of the warming interval. It is a
terminal-grid widget, not a pixel image with rounded corners. The sidebar
section uses separate aligned label/value rows; this schematic represents the
bar's placement, not literal rendered characters:

```text
Warming                    Waiting

[continuous coloured track       ]

Next request                 03:42
Window left                  44:00
Requests Sent                    4
```

- The bar is fill-only, with no ticks, dots, or other symbols. Background fill
  shows elapsed time in the warming window; the unfilled track is muted.
  Fill by itself never means a request was sent. Adjacent text shows request
  counts, failures, sending state, and stop reasons.
- Colours run cool on the left to red on the right. Set `"color": false` for
  monochrome; `NO_COLOR` also disables the gradient. Status text remains readable
  without colour.
- **Requests Sent** counts warming responses that passed completion checks in the
  current window. **Failed** appears separately when nonzero. Started, in-flight,
  and aborted requests do not count as completed. The compact layout uses `sent`
  for completed responses. These totals do not establish cache hits or savings.
  New ordinary activity resets the counts. Remaining time uses the engine's actual
  deadline. Elapsed fill does not imply a completed request.
  Progress freezes and dims when warming is stopped; expiry is also muted.
- The track has `ceil(duration / interval)` adjoining colour bands, with no gaps.
  Its overall width stays the same regardless of band count; more bands are
  narrower. Each band represents a nominal interval/request opportunity, not a
  guaranteed actual request. A one-hour/four-minute window has 15 bands and up to
  14 warming requests, since nothing starts at expiry. Response time, generation,
  and retries can delay requests. A shorter final interval gets proportionally
  less space where the terminal grid permits it. Dense windows group adjacent
  intervals when there are more bands than available columns or `maxSegments`.
- Each band has a distinct, constant colour along the cool-to-red palette.
  Upcoming bands retain muted colours; elapsed portions become brighter. Subtle
  alternating intensity separates bands even in monochrome. Fill advances with
  fractional background shading on the leading cell. Very early progress may be subtle,
  especially on limited-colour terminals. No decorative animation or blinking is used.
- Timers use `mm:ss`, or `h:mm:ss` at an hour or more (`4:59:07`, not `299:07`).
  The compact layout reserves timer space across hour/minute boundaries. It
  prioritizes state and failures, then completed responses, remaining time, and next time;
  optional fields and the bar are omitted when they do not fit beside the model.
- The UI shows model activity, next request, sending, expiry, and stop reasons.
  It refreshes twice per second; extremely brief sending states may finish between
  refreshes. The last 128 attempt markers are retained; totals are not truncated.

UI options:

| Setting | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Show the indicator. |
| `color` | `true` | Use the cool-to-red gradient; `false` uses theme monochrome. |
| `maxSegments` | automatic | Optional positive integer cap on visible colour bands; excess intervals are grouped. The track width is unchanged (compact bars cap at 16 columns). |
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
| `intervalMs` | automatic | Optional global refresh interval; omit to select the provider/model/request profile below. |
| `durationMs` | `3600000` (1 hour) | Maximum warming window after the latest ordinary root-model request starts. |
| `debug` | `false` | Include routine scheduling, attempt-start, and ordinary-usage events at debug level. |
| `providers` | none | Exact provider-ID overrides for `intervalMs`, `enabled`, and nested model overrides. |
| `journal` | enabled, 365 days | Local metadata history; see [Observability](#observability). |

The one-hour default covers long subagent waits. Supplied time settings must be
positive safe integers, at most `2147483647` milliseconds, with `intervalMs`
strictly less than `durationMs` at global scope. An automatic or per-provider/model
interval longer than the activity window schedules no request before expiry.
Unknown settings or invalid values disable
warming and emit a diagnostic. Milliseconds keep configuration dependency-free.

### Automatic cache profiles

| Transport/model | Retention used for scheduling | Refresh interval |
| --- | --- | --- |
| OpenAI API GPT-5.6+ | Documented 30-minute minimum | **28 minutes** |
| Codex OAuth or Copilot GPT-5.6+ | Assumed upstream 30-minute minimum | **28 minutes** |
| Copilot Sonnet/Opus 5+, default or mixed TTLs | Upstream/default or requested 5 minutes | **4 minutes** |
| Copilot Sonnet/Opus 5+, exclusively `1h` cache markers | Requested 1 hour | **58 minutes** |
| Older supported Codex models | Retention unknown | **4 minutes** |

[OpenAI documents](https://developers.openai.com/api/docs/guides/prompt-caching)
a 30-minute minimum after cache writes/reuse for GPT-5.6+.
[Claude documents](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
5-minute/default and 1-hour cache markers. Gateway profiles assume the underlying
provider's behavior; Codex/Copilot retention and real cache benefit have not been
verified by live tests. The shortest captured Claude marker controls mixed-TTL
scheduling. Retention metadata is not a measured cache-expiry countdown.

Overrides are nested under their provider and resolved independently for each setting: **model → provider →
explicit global → automatic**. An explicit existing `intervalMs: 240000` retains
its four-minute cadence; remove it to use automatic defaults. Models use actual
API IDs, including any version suffix; no wildcard matching is performed. At most
128 providers and 128 models per provider are accepted.
The global `enabled: false` always disables the plugin. A model can re-enable
warming disabled by its provider override. Intervals at or above the profile TTL emit `policy-warning` rather
than silently clamping the configured value. Overrides never change provider TTLs.

Fully explicit defaults for the currently targeted models look like this:

```jsonc
{
  "enabled": true,
  "durationMs": 3600000,
  "debug": false,
  "providers": {
    "openai": {
      "enabled": true,
      "models": {
        "gpt-5.6-luna": { "enabled": true, "intervalMs": 1680000 }
      }
    },
    "github-copilot": {
      "enabled": true,
      "models": {
        "gpt-5.6-luna": { "enabled": true, "intervalMs": 1680000 },
        "claude-sonnet-5": { "enabled": true, "intervalMs": 240000 },
        "claude-opus-5": { "enabled": true, "intervalMs": 240000 }
      }
    }
  }
}
```

There is intentionally no global or provider `intervalMs`: GPT and Claude have
different automatic defaults. Claude's 58-minute interval for an exclusively
one-hour cache boundary is derived from captured `cache_control` markers and
cannot be represented by one static model value. Unknown future model IDs still
use the automatic profile when no exact override is present.

The sidebar shows provider/model and a documented, assumed, or requested TTL.
The next-request timer and bar use the effective interval; the window timer
continues to use the fixed ordinary-activity deadline.

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
   already elapsed, the first warming attempt is immediately eligible. A timer
   that wakes substantially late is treated as a sleep/resume or clock-gap
   event; the stale warming window is stopped before any request is sent.
4. After successful warming, the next target is the request start plus its
   effective refresh interval, with at least the smaller of one second or one
   interval after completion. Failed attempts retry after the smaller of 30 seconds
   or one interval, increased by `Retry-After` when supplied. Retries never extend
   the activity window or establish a cache refresh. A normally long response
   crossing its refresh target is distinct from a timer waking late after sleep.
5. Warming never extends the window. At expiry it aborts locally and releases its
   state. Resume after sleep never sends catch-up bursts or retries from the old
   snapshot; a new ordinary root-model request is required to start warming again.

The parent's raw HTTP response can end while OpenCode still waits for a task.
That is why the plugin can warm a busy parent without entering its message queue.
It does not track task counts or use session `busy` as a generation signal.
Multiple active root sessions each have their own timers and usage.

## What is replayed

The plugin captures the latest completed outgoing request **after** OpenCode's
authentication and routing. Replays retain its instructions, conversation
prefix, model, reasoning configuration, function-tool schemas, and cache keys.
Adapters select the replay strategy:

- **OpenAI API GPT-5.6+:** unchanged input, native
  `prompt_cache_options.prewarm: true`, non-streaming, and `store: false`. No output
  is requested. Existing cache policy and breakpoints are preserved. Explicit-only
  caching without a recognized breakpoint is skipped.
- **Codex OAuth:** the existing transient `OK` instruction, disabled tool selection,
  and `store: false`. Native prewarm and output caps are not inferred from the
  public API contract. Appending the instruction can move implicit cache-write
  boundaries; completed requests do not prove refresh of the original boundary.
- **Copilot GPT:** unchanged input with an output ceiling of 128 tokens (or a
  smaller captured ceiling), retained tool definitions, disabled tool selection,
  and `store: false`.
- **Copilot Claude:** unchanged messages/system/tools/cache markers, original tool
  selection, thinking, effort and signed reasoning blocks; output is capped at
  128 tokens or the smaller captured limit. Changing Claude tool selection can
  invalidate message caching, so generated local function calls are discarded
  without execution. Explicit thinking budgets incompatible with the small ceiling
  are skipped instead of being changed. Native zero-output gateway prewarm is
  not enabled without an endpoint-specific contract.

Copilot replays retain captured authentication, version, intent, interaction, and
image headers, and mark their initiation as `agent`. Output-limit fields follow
the upstream protocol; real gateway acceptance is unverified. A rejection stops
that snapshot; the plugin never escalates to a larger or unbounded budget.

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
Screenshots in user messages or function results do not disable warming when
their image bytes are embedded in the request. They remain in the replay prefix,
including on later text-only turns; the plugin never drops or rewrites them.

## Limits and failures

- **OAuth expiry:** replays use captured authorization in RAM. They do not refresh
  OAuth. A `401`/`403` stops that session until a new ordinary request supplies a
  fresh capture. The configured duration is a maximum, not a guarantee.
- **Codex has no hard output-token cap:** Codex does not have a verified output-cap field
  for this path. The `OK` instruction and 30-second local timeout are not billing
  ceilings, and aborting does not guarantee instantaneous remote cancellation.
- **Request failures:** `400`/`422` stop an incompatible snapshot. `429` respects
  `Retry-After` and the active window. Other failures use the separate bounded
  retry delay described above.
- **Response failures:** incomplete/error SSE streams, invalid warm JSON, and
  oversized responses count as failures. The legacy Codex parser accepts valid
  JSON or empty HTTP 200 responses; new adapters require a recognized terminal
  Responses or Messages result. A bounded replay reaching its output ceiling is
  accepted only with the explicit protocol terminal reason and recorded as
  `outputLimitReached`; arbitrary incomplete responses still fail. SSE is also recognized from its field prefixes when
  the HTTP media type is missing or misleading; completion and failure checks
  still apply. Metadata parsing is bounded to 1 MiB per SSE frame and
  8 MiB per response.
- **Session changes:** cancellation/errors, deletion, compaction, revert changes,
  disposal, and new ordinary model activity invalidate the snapshot. Title and
  summary generation do not replace it.
- **Sleep/resume:** substantially late timers are treated as a clock gap. The
  plugin stops warming and discards the snapshot rather than spending tokens on
  a potentially expired cache; ordinary model activity must provide a fresh
  snapshot before warming resumes. Queued warm network/body completions check the
  scheduled watchdog wake too, so they cannot replace an overdue timer with a retry.
- **Transport completion:** HTTP success and EOF are not proof of semantic model
  success. OpenCode session-error events invalidate captures when reported.

Captured bodies and authenticated headers stay in memory only. Diagnostics never
include their content. Invalidation also detaches pending capture callbacks,
releasing their request data without cancelling ordinary traffic. The plugin uses
OpenCode's `session-warming` log service for capture, warming, skip, stop, and
usage events. Missing usage is unknown,
not zero. Existing ordinary-message token metadata is logged when available.

To disable, set `enabled: false` or remove the entry, then restart OpenCode.

## Observability

A local, metadata-only JSONL journal collects automatically, independently of
`debug` and OpenCode's logging service. No dashboard or background service is
required. The files are a foundation for future analytics, not a complete or
tamper-evident audit ledger.

```jsonc
{
  "journal": {
    "enabled": true,
    "retentionDays": 365
    // Optional: "maxBytes": 134217728
  }
}
```

`journal.enabled: false` turns persistence off without changing warming or log
verbosity. `retentionDays` is a positive whole number; its millisecond product must
fit safe timestamp arithmetic. `maxBytes`, when supplied, is a safe whole number
of at least 8 MiB. Unknown/invalid journal options disable the entire plugin, just
like invalid warming settings. Quit and restart OpenCode after changing settings.
Global `enabled: false` writes no journal. Native/WebSocket/channel guards write
only bounded startup/disabled metadata and do not observe ordinary activity or
change shared retention policy.

### Data and retention

Files live under `~/.local/state/opencode/session-warming/events/`, or the matching
`$XDG_STATE_HOME/opencode/session-warming/events/`. Each plugin instance has a
unique run ID and its own segments, rotating at 4 MiB or the next UTC recording
date. `.open` files are in-progress or unresolved; `.jsonl` files were closed
normally. Directories/files are created privately (`0700`/`0600`). Shutdown keeps
history. Existing live TUI status files remain separate and ephemeral.

**There is no default disk cap.** History is retained for 365 days by default.
Startup/hourly cleanup removes only verifiably expired segments, using recording
time rather than source-message time. Potentially live open files and damaged or
unknown-schema segments are preserved. Retention is segment-granular, so some
older records may remain longer than the configured period.

The most recent journal-enabled, supported startup sets shared retention and
optional disk policy for all instances using that state directory. Policy uses
numbered atomic registrations under `session-warming/policy/`; delayed older
registrations cannot overwrite newer ones. Empty generation reservations are kept
as allocation markers; recovery reuses the original startup registration rather
than publishing a new policy generation. Shortening retention applies retroactively. Longer
retention cannot restore deleted data. Cleanup checks shared policy per file in
bounded batches, so changes affect subsequent deletion decisions.

An optional `maxBytes` is a **soft collection threshold**, measured using regular
files' logical sizes, not physical disk allocation. It pauses new recording rather
than deleting younger history. Shared size is scanned at startup and every 30
seconds; concurrent writers can temporarily exceed the threshold. Raising/removing
the threshold takes effect through another supported journal-enabled startup.

### What the journal records

- Runs, ordinary transport windows, warming attempts, completion/failure/abort
  outcomes, retries, skip/stop reasons, effective policy and safe diagnostics.
- Live ordinary OpenAI/Copilot **root** activity and step usage, including skipped
  shapes/models and provider/model warming-disabled overrides. Other providers
  contribute skip decisions only. Children, title/summary and compaction calls,
  copied fork history and synthetic activity without model-call evidence are excluded.
- Opaque project/session/user/assistant/part IDs, configured and native API model
  IDs, provider request IDs when available, source timestamps and correlation IDs.
- Collection-health snapshots: queue/storage/pressure drops, uncertain writes,
  metadata exclusions, cache evictions and unresolved attribution.

No prompts, response text, images, tool payloads, snapshots, credentials, headers,
raw exception text, session titles or filesystem paths are written. Missing or
ambiguous context is omitted or counted; no message-history API calls are made to
fill gaps. These IDs still identify your local activity; keep exports private.

The first line of each segment is a schema-1 `recordKind: "segment"` header.
Events have `recordKind: "event"`, a fixed event name, `runID`, `seq`, `eventID`,
UTC `recordedAt` and monotonic `runElapsedMs`. Event names include `warm.started`,
`warm.completed`, `warm.failed`, `warm.aborted`, `ordinary.call-started`,
`ordinary.step-usage`, `ordinary.message-completed`, and `journal.health`.
Sequence gaps can indicate dropped events; retention-pruned prefixes are expected.
`ordinary.call-started` is hook intent, not proof that a billable HTTP call happened.

Ordinary usage comes from **per-step source parts**, not assistant accumulated
cost or latest-step message tokens. It records uncached input, cache reads/writes,
non-reasoning output and reasoning separately. `usageSource: "opencode-normalized"`
means upstream availability is unknown: OpenCode can normalize missing usage into
zero. `reportedCost` has `costSource: "opencode-step"` and `costUnit: "unspecified"`;
Copilot values may be quota-derived, so do not interpret them as dollars or billed
cash. Warm usage uses `usageSource: "provider-response"`; missing values stay unknown.

Usage and completed-message records are **keyed snapshots**. Identical re-deliveries
are suppressed while cached; corrections and later error amendments are retained.
Use project/session/assistant/part identity for usage deduplication, and
project/session/assistant identity for outcome snapshots. Do not sum repeated
snapshots or silently resolve conflicting cross-run observations by wall-clock time.
Neither warm completion nor cache reads demonstrate savings.

### Inspect and export

From this checkout, using its pinned Node version:

```sh
npm run --silent journal -- validate
npm run --silent journal -- export --from 2026-10-01 --to 2026-11-01 --provider openai
```

Use `--silent` to keep npm's script banner out of machine-readable output.
`validate` emits JSON integrity/coverage information. `export` streams validated
events as NDJSON on stdout, with a coverage summary on stderr. Both are read-only.
Both accept `--directory`; export additionally accepts exact `--provider`, `--model`
(configured ID), `--api-model`, `--session`, `--run` and `--project` filters.
`--from` is inclusive and `--to` exclusive, based on recording time; dates accept
`YYYY-MM-DD` at UTC midnight or UTC ISO timestamps ending in `Z`. No global ordering
across files is promised. Export preserves ordering within each file.

Exit codes: `0` means structurally readable supported data (known gaps/pending tails
remain warnings); `1` means corruption, unsupported schema or incomplete records;
`2` means invalid arguments or access failure. A missing default directory is an
empty collection. Invalid records are never exported as raw bytes. An active-PID
partial tail is pending; a live PID does not establish that its writer is healthy.

### Failure behavior

Recording never awaits filesystem work in model/event hooks. The queue is bounded
to 1,024 events or 1 MiB, including in-flight data; individual records are capped at
8 KiB. Writes are buffered for up to one second and use no `fsync`. A slow write
marks degradation after two seconds but remains owned until the syscall settles;
it cannot trigger overlapping retries. Failed/uncertain batches are not replayed.
Storage recovery is attempted at most once every 30 seconds. Disposal has a
two-second budget; an already-issued syscall may settle later without restarting
collection. Crashes may lose buffered events and health counters.

`journal-degraded` diagnostics identify storage timeout, unavailable policy or disk
pressure without raw errors. Recovery writes cumulative health counters. If storage
never recovers, durable failure markers cannot be guaranteed. Warming continues
when journal storage fails; a completed warming response is not a confirmed cache
refresh or guaranteed cost saving.

## Troubleshooting

The public checkout intentionally does not include a project-level `opencode.json`.
If you keep an ignored local copy for troubleshooting, it can allow external-directory
access to the local OpenCode config, log, and state directories. Do not copy broad
permissions into a shared or public checkout.

Every normal log message starts with **`[session-warming]`**. On this installation,
OpenCode writes to `~/.local/share/opencode/log/opencode.log` (or the corresponding
XDG data directory). Search for the prefix, not only the logger's service name.

```sh
rg '\[session-warming\]' ~/.local/share/opencode/log/opencode.log
```

- **`ready`** confirms initialization and records automatic/global interval selection,
  duration, request timeout, and metadata timeout. The effective per-request interval
  is recorded by `captured`. No `ready` or `disabled` event means you
  should check the configured file URL and OpenCode's plugin-loader errors first.
- **`captured`** confirms a replayable ordinary request and records its next warm
  time and expiry, adapter/strategy, effective interval/source and TTL evidence.
  **`skipped`** identifies the specific unsupported provider/model,
  session version, endpoint, tools, input, or stateful request shape.
  `unsupported-input-image` identifies an external/file-ID image reference,
  malformed data URL, or unsupported image shape; `unsupported-input-file` and
  `unsupported-input-audio` identify other unsupported media. The 16 MiB request
  limit includes embedded images and reports `request-too-large`.
  `unsupported-thinking-budget`, `unsupported-cache-control`, `cache-disabled`,
  `unsupported-request-field`, and `model-mismatch` distinguish unsupported
  contracts without exposing their content.
- **`warm-completed`** includes attempt ID, model, HTTP status, provider request
  ID when supplied, elapsed time, token usage, and next attempt time.
  Cache reads and writes are separate when available, including Claude's per-TTL
  writes. Claude total input includes uncached, cache-read and cache-write tokens
  only when all three are reported. Missing values remain unknown.
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
typings use the `1.18.x` range and are imported only as types. No Bun CLI is required.

```sh
mise install
npm ci
npm run check
npm run test:runtime
npm run test:tui
```

`check` runs TypeScript static checks and Node tests with mock transports and
fake clocks. The separate runtime test requires the installed `opencode`
**1.18.x** binary. It creates isolated HOME/XDG directories, synthetic OAuth
credentials, and a local mock provider; it never uses your accounts. It proves
parent warming with an attached screenshot during a foreground child and after
tool continuation, preservation of the image-bearing prefix, absence of history/tool/notification
side effects, normal continuation, and cancellation cleanup. Temporary processes
and files are cleaned up afterward.

The additional provider runtime fixture exercises OpenAI API native prewarm and
Copilot GPT/Sonnet/Opus through OpenCode's real auth/routing and attachment
serialization, foreground-child waits, tool continuation, cancellation and status
publication. Claude warming returns mock tool calls to prove they are never
executed. All provider hosts are mapped to a local mock; external network is
blocked. Mock acceptance proves local integration, not live gateway support or
cache savings.

`adapters.ts` contains the small explicit provider registry; `protocol.ts` owns
bounded Responses/Messages validation and parsing; `cache-policy.ts` owns model
floors, settings and precedence. The engine owns scheduling and invalidation,
independently of provider request formats. Add future providers by registering
verified endpoint/request/replay contracts and fixtures, not by accepting every
OpenAI-compatible endpoint. Existing ordinary fetch wrappers are preserved.

`test:tui` additionally requires Python 3 on macOS/Linux. It starts an isolated
local v1 server and attaches a disposable TUI in a pseudo-terminal, checks the
session prompt and working keyboard input, and checks request counts, sending
  state, continuous background fill, sidebar placement, compact fallback and failures using synthetic status records without submitting a model
request. It uses isolated HOME/XDG directories and does not touch running sessions.

No automated test contacts a live model provider. To establish actual benefit,
perform an explicitly enabled, limited control-versus-warmed experiment on your
provider and count all warming usage, not just the next request's cache hit.

AI agents should read [AGENTS.md](AGENTS.md) before making changes.
