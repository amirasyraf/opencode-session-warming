# OpenCode session warming

A local plugin for **OpenCode v1.18.30** that makes best-effort cache-warming
requests for your root OpenAI/Codex OAuth sessions. It works while you're idle
and while the parent session is blocked waiting for foreground subagents or
long-running tools.

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

Add it to the existing `plugin` array in `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugin": [
    // Keep your existing plugin entries here.
    [
      "file:///absolute/path/to/opencode-session-warming/plugin.ts",
      {
        "enabled": true,
        "intervalMs": 240000,
        "durationMs": 3600000
      }
    ]
  ]
}
```

Replace the file URL with your checkout's absolute path. Do not add v2's native
`warming` field to v1's configuration. Quit and restart OpenCode after changing
the plugin or its settings. Installing this checkout does not automatically
modify your global OpenCode configuration.

## Settings and timing

| Setting | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Enable the installed plugin. |
| `intervalMs` | `240000` (4 minutes) | Initial idle delay and minimum delay between completed warm attempts. |
| `durationMs` | `3600000` (1 hour) | Maximum warming window after the latest ordinary root-model request starts. |

The one-hour default covers long subagent waits. Both time settings must be
positive safe integers, at most `2147483647` milliseconds, with `intervalMs`
strictly less than `durationMs`. Unknown settings or invalid values disable
warming and emit a diagnostic. Milliseconds keep configuration dependency-free.

Example: warm every three minutes for up to 45 minutes:

```jsonc
["file:///absolute/path/to/opencode-session-warming/plugin.ts", {
  "intervalMs": 180000,
  "durationMs": 2700000
}]
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
- **Stream failures:** incomplete/error warming streams count as failures.
  Metadata parsing is bounded to 1 MiB per SSE frame and 8 MiB per response.
- **Session changes:** cancellation/errors, deletion, compaction, revert changes,
  disposal, and new ordinary model activity invalidate the snapshot. Title and
  summary generation do not replace it.
- **Transport completion:** HTTP success and EOF are not proof of semantic model
  success. OpenCode session-error events invalidate captures when reported.

Captured bodies and authenticated headers stay in memory only. Diagnostics never
include their content. Invalidation also detaches pending capture callbacks,
releasing their request data without cancelling ordinary traffic. The plugin uses
OpenCode's `session-warming` log service
for capture, warming, skip, stop, and usage events. Missing usage is unknown,
not zero. Existing ordinary-message token metadata is logged when available.

To disable, set `enabled: false` or remove the entry, then restart OpenCode.

## Development and verification

Use Node >=22.18; `mise.toml` pins the development version. OpenCode runtime
typings are pinned to 1.18.30 and imported only as types. No Bun CLI is required.

```sh
mise install
npm ci
npm run check
npm run test:runtime
```

`check` runs TypeScript static checks and Node tests with mock transports and
fake clocks. The separate runtime test requires the installed `opencode`
**1.18.30** binary. It creates isolated HOME/XDG directories, synthetic OAuth
credentials, and a local mock provider; it never uses your accounts. It proves
parent warming during a foreground child, absence of history/tool/notification
side effects, normal continuation, and cancellation cleanup. Temporary processes
and files are cleaned up afterward.

No automated test contacts a live model provider. To establish actual benefit,
perform an explicitly enabled, limited control-versus-warmed experiment on your
provider and count all warming usage, not just the next request's cache hit.

AI agents should read [AGENTS.md](AGENTS.md) before making changes.
