# Agent instructions

## Read first

The main branch is one OpenCode V2 (stable 2.1.x and 2.2.x) local plugin directory;
V1 support is retired. Do not maintain a separate V1 compatibility path:

- `server.ts` is the server plugin (`{ id: "session-warming", setup }`, Promise API).
- `tui.tsx` is the CLI plugin (`{ id: "session-warming.tui", setup }`).
- `rpc.ts` is the shared JSON-Schema plugin RPC contract between them.

OpenCode resolves these entrypoints from the configured directory (`plugins`
entries must name the directory, not a file). The CLI auto-loads `tui.tsx` for a
server-configured directory; an explicit `cli.json` entry for the same directory
only supplies options. V1 (1.18.x) is unsupported on this branch; do not add V1
`server()` exports. Runtime imports of `@opencode/plugin` or `effect` are
forbidden (the host refuses them from plugin `node_modules`); use type-only
imports. `README.md` is for humans: keep it short, task-oriented, and free of
internal implementation contracts. `opencode.jsonc.example` and
`cli.json.example` are the versioned configuration references; update them when
the supported config surface changes.
This file is for coding agents: put precise invariants and verification rules
here instead of expanding the README.

## Scope

The plugin warms root-session OpenAI API/Codex OAuth and GitHub Copilot HTTP
requests. Supported paths are API/Copilot GPT-5.6+ (including GPT-6.x)
Responses, Copilot Sonnet / Opus 5+ and Haiku 5.5+ Messages, and legacy Codex. Other
providers, Chat Completions, enterprise/custom endpoints, WebSockets,
provider-hosted tools, and stateful provider conversations are unsupported. Do
not silently enable or force a transport, and never change user credentials or
provider settings: OpenAI warming requires the user's own
`providers.openai.settings.transport: "http"`; WebSocket use is only observed
(`experimental.ws.handshake`, no mutation) and reported as
`websocket-transport`.

Claude eligibility uses numeric family floors: Sonnet/Opus 5+ and Haiku 5.5+,
including dotted and dashed minor versions. Older Haiku stays unsupported;
eligible Haiku uses the same bounded Messages replay and cache-marker policy
as Sonnet/Opus without relaxing request validation.

Never depend on, enable, or run alongside OpenCode's native warming
(`opencode.warming`, config key `warming`). Never call `session.generate`. The
server cannot read config, so the CLI checks `config.get` for the session's
location (`Config.latest` semantics) and reports it through the `native` RPC;
the server then suspends all warming in that instance (`native-warming`) until
told otherwise. Without a CLI attached this check cannot run; document, do not
guess from `generate` traffic (`/btw` uses it too).

Keep responsibilities in their current modules:

- `transport.ts`: hook-side request decoding (zstd/gzip), response-body observation, capture registrations, late-bound replay fetch. No global fetch shim.
- `protocol.ts`: bounded request validation and Responses/Messages parsing.
- `adapters.ts`: explicit provider endpoints and replay policy.
- `cache-policy.ts`: model floors, defaults, overrides, and precedence.
- `engine.ts`: scheduling, invalidation, retries, and warm lifecycle.
- `server.ts`: V2 hook registration, root/model resolution, session events, RPC handlers.
- `resident.ts`: the process-scoped, per-location resident pool that lets live windows outlive a plugin scope.
- `status.ts`, `indicator.ts`, `tui.tsx`: in-memory status registry, observational rendering, and explicit CLI command handling.
- `controls.ts`, `rpc.ts`: bounded, metadata-only control requests and the RPC contract.
- `journal-schema.ts`, `journal.ts`, `journal-reader.ts`, `journal-cli.ts`:
  allowlisted metadata persistence and read-only inspection.
- `ordinary-observer.ts`: live root usage attribution from `session.step.*` events without history reads.

Do not replace this with a generic provider framework, persistent conversation
store, background daemon, task counter, or conversation reconstruction layer.

## Location lifetime invariants

- OpenCode 2.1.x invalidates a location's service graph (and every plugin scope)
  after a fixed 60 minutes without durable `SessionEvent`s. In 2.2.0 the default
  remains 60 minutes, `experimental.location_idle_timeout` can override/disable
  eviction, and active executions/background jobs prevent eviction
  (`packages/core/src/location-activity.ts`). It reloads on the next request,
  such as the CLI's two-second status poll. Warming, plugin RPC, and status
  polling are not durable activity. Never fabricate session activity to keep a
  location alive.
- The engine, its transport registrations, the journal, the resident's
  diagnostics, root/model/recovery caches, and the native flag belong to a
  per-location resident on `globalThis` (`resident.ts`). Hooks, RPC handlers,
  controls, the ordinary observer, preparations, and the status registry stay
  per scope. Scope disposal detaches; it must not dispose live windows.
- The last detaching scope parks a resident that still has live windows
  (including manually stopped ones). A parked engine keeps warming and expiring
  under the normal rules and releases itself (engine and journal disposal) when
  its last window ends. Only the process exiting ends it otherwise.
- A new scope re-attaches only to a resident with the same fingerprint
  (`RESIDENT_VERSION` plus the raw plugin options) and republishes its live
  windows to the new status registry. A mismatch, a disabled plugin, or an
  unsupported host disposes the parked resident with reason `disposed`.
  Residents from older plugin code persist across reloads, so keep the pool
  contract (`fingerprint`, `scopes`, `idle`, `watchIdle`, `dispose`) fixed and
  bump `RESIDENT_VERSION` whenever anything else an attaching scope uses
  changes.
- Removing the plugin from config cannot be observed: a parked window then runs
  until its expiry. Document this rather than capping parked lifetime.

## Transport and session invariants

- Ordinary requests keep their authentication, routing, bytes, cancellation,
  response status/headers, and body backpressure. The `http.request` hook only
  reads a bounded clone of the body and never reassigns `event.request`; the
  `http.response` hook replaces only the body stream with a pull-through
  observer.
- Capture only `kind: "primary"` requests of a root session with a live
  preparation from the `context` hook (or the recovery path below), scoped to
  the `openai` and `github-copilot` providers. Correlate request and response
  by session ID, not object identity: later plugins may replace the request.
- Decode `content-encoding: zstd|gzip` with bounded output (16 MiB); replays
  re-apply the same encoding (the ChatGPT backend rejects large plain bodies).
- Capture failures must fail open and never break an ordinary request; hook
  callbacks must not throw.
- Warming uses independent HTTP calls. Never use `session.prompt`, session
  history writes, agent/tool execution, or OAuth refresh.
- Only root sessions warm. New ordinary root-model activity invalidates old
  warming even when the new provider, model, or request is unsupported.
  Child activity is independent.
- Every `context` hook (each agent-loop model request, any provider) is
  ordinary activity: invalidate first, then resolve root status
  (`session.get`, cached) and the provider API model ID (`model.list`
  `modelID`, cached; catalog aliases such as `gpt-6.1-sol-fast` map to
  `gpt-6.1-sol`) within the 5 s metadata deadline. `compaction`, `title`, and
  `generate` kinds never capture; `compaction` invalidates.
- If a primary root request reaches `http.request` without a live preparation
  (retry after expiry, HTTP fallback after a WebSocket handshake), it may
  re-prepare from the cached root/model resolution of the same session and
  catalog model. Never use this path for children or unsupported models.
- Raw transport completion (the observed response body), not session status,
  decides when the parent is still generating.
- Agent cancellation (`session.execution.interrupted`) does not invalidate
  warming; a pending ordinary capture completes as `ordinary-aborted` and stays
  replayable without proving response completion or extending the deadline.
  `session.execution.failed` invalidates (`session-error`).
- Revert (`session.revert.*`), compaction (`session.compaction.started|ended`),
  and deletion events invalidate; only roots this instance classified are
  affected.
- Reject conversation-state references, provider-hosted tools, unimplemented
  input types, unsupported media, and request bodies over 16 MiB. V2 Responses
  `compaction` items (opaque `encrypted_content`), `namespace` tool groups of
  plain function tools, and `function_call.namespace` are admitted and
  replayed verbatim.
- Preserve the complete provider input chain, including file attachments, in
  the replay. Do not strip, reconstruct, or relocate attachment content.
  Support embedded base64 PNG, JPEG, WebP, and GIF images in user messages and
  function results without changing the replay prefix. Image and attachment
  bytes count toward the body limit. Attachment blocks are opaque to the
  plugin; it does not resolve, upload, or locally validate their sources.
- Detect SSE from field prefixes even when the media type is missing or wrong.
  Require semantic stream completion; HTTP 200 and EOF alone are insufficient.
- Keep snapshots and authenticated headers in RAM. Never log their content.

## Replay and policy invariants

- Keep provider endpoint and replay policy in the explicit adapter registry.
  Numeric model floors never authorize unknown request features.
- Preserve the complete captured input chain for every adapter. Native API
  prewarm and bounded Copilot replay must not strip or reconstruct it.
- Claude replay retains tool selection, thinking, effort, signatures, cache
  controls, and cache markers. Discard generated local function calls; never
  dispatch them.
- Claude Messages admits inline `role: "system"` updates with text-block arrays
  and optional `output_config: { effort: string }`, as emitted by OpenCode's
  Anthropic serializer. Preserve their position, content, effort, and cache
  markers verbatim; include their markers in TTL selection. Reject other
  message-level fields, non-text system blocks, and malformed effort updates.
- Changes to resident-owned engine/transport behavior (including request
  validation and adapter eligibility) require a `RESIDENT_VERSION` bump, even
  without a type change, so reload cannot re-adopt stale closures.
- Skip incompatible explicit thinking budgets instead of changing them.
- Keep Codex's legacy keepalive isolated: preserve the captured input as a
  prefix and append only its transient keepalive message. Do not invent a Codex
  output cap or a gateway prewarm mode.
- Default GPT-5.6+ refresh is 28 minutes. Claude uses 4 minutes, or 58 minutes
  for exclusively one-hour markers. Mixed TTLs use the shortest selected marker.
- Resolve settings as model, provider, explicit global, then automatic policy.
- TTLs are upstream assumptions or requested values, not expiry evidence.
- Separate success refresh targets, based on request start, from bounded failure
  retries. A successful response or usage value does not prove a cache refresh.
- Only an explicit output-limit terminal result qualifies as a bounded
  completion. Do not accept arbitrary truncated output.
- Fence retries, late callbacks, expiry, disposal, and cancellation. None may
  resurrect state or extend the ordinary activity window.
- Treat substantially late timers as sleep/resume or clock-gap events. Discard
  stale warming before sending or retrying. Do not send catch-up bursts. The
  only exception is a late scheduler wakeup of a waiting snapshot (no warm or
  ordinary request in flight) whose selected `ttlMs` has not elapsed since the
  last request start assumed to refresh the cache (ordinary capture or
  successful warm): it sends at most one immediate warm (`resume-within-ttl`).
  Unknown TTLs and in-flight work stay strict.
- Every warm attempt emits one terminal outcome, including invalidation,
  replacement, and late-response paths. This is not exactly-once persistence
  and does not guarantee remote cancellation.

## Session control invariants

- `/warming start`, `/warming stop`, `/warming extend [duration]`, and bare `/warming` are one V2 keymap command with `slash: { name: "warming", arguments: true }`; the host clears the prompt and passes only the argument text, so invalid arguments show usage (they cannot stay editable). Palette entries exist for the menu, start, stop, and extend.
- Rendering remains observational. Only explicit user commands change the engine. Child views target their root parent (`data.session.root`) and label it; the server independently checks root metadata. Never route controls through `session.command`, `session.prompt`, `session.generate`, an agent, or a tool.
- The control and status bridge is the `session-warming` plugin RPC (`status`, `control`, `native` methods; `status` event), called with the root session's `location`. RPC registrations are per location instance. Inputs allow only session ID, request ID, action, an optional bounded `durationMs` (accepted only for `extend`), and the native flag. Never send editor contents or authenticated snapshots.
- The RPC response is the correlated acknowledgement. Client calls expire after five seconds; the server assigns its own deadline, rechecks liveness after asynchronous metadata lookups and before mutation, orders actions per session, bounds pending work and deduplication, and fences deletion/disposal. Duplicate request IDs cannot apply an action twice.
- Manual stop is separate from snapshot validity. Stop aborts warming, retains the snapshot only until its existing expiry, and persists across new ordinary activity while the location's resident lives. Fresh ordinary captures remain admissible while stopped. Deletion and resident disposal clear the stopped preference; do not silently evict it to enable a session.
- A manual start of a stopped, live state explicitly opens a new configured-duration window with new window identity and zeroed current-window statistics. Its first warm target is one interval later. Wait for ongoing ordinary transport completion. Starting an already enabled window is a no-op; absent or invalidated captures become enabled/awaiting activity, never reconstructed from history.
- `/warming extend [duration]` lengthens the existing live window (including a manually stopped one) without resetting its window identity, snapshot, statistics, or next warm target; status `durationMs` is the extended window length. Bare `extend` adds one configured duration; explicit ASCII durations may combine strictly descending `d`/`h`/`m`/`s` units such as `1h30m`. Extensions are bounded by the safe timer limit (`duration-limit`), do not resurrect expired or invalidated state, and preserve manual-stop state. A fresh window (ordinary capture or manual start) resets the length to the configured duration.
- Expiry, clock gaps, authentication failure, incompatible input, compaction, revert, and other invalidations still release snapshots and pending capture callbacks while manually stopped. Start must not resurrect them or bypass configured policy. Fence warm continuations by controller identity as well as state identity.
- Status allowlists include manual-stop state and an idle/awaiting-activity phase. Keep stopped progress frozen and next-request timers absent. Record allowlisted user-control events and fresh-window replacements in the journal without deleting historical records.

## Metadata and journal invariants

- The journal is enabled by default, retains 365 days by default, and has no
  default disk cap. A configured disk target pauses recording; it never permits
  deletion of inside-retention history.
- Persist reconstructed allowlisted metadata only. Never serialize SDK/request
  objects, prompts, response text, images, tool payloads, snapshots, headers,
  credentials, titles, paths, or raw exception text.
- Writes are buffered, bounded, asynchronous, and independent of warming.
  Uncertain writes are not replayed. Reader and CLI operations are read-only.
- The newest supported journal-enabled startup controls shared retention and
  disk policy, even if an older instance flushes later. Policy records carry a
  startup timestamp; same-time records use generation order. Preserve
  corrupt/unknown policy files and live open segments.
- Recovery reuses the original startup registration. It must not allocate a new
  policy generation or replace a newer startup's policy.
- Journal cleanup is segment-granular and must preserve damaged, unknown, and
  potentially live files. Do not treat a missing record as permission to delete.
- Ordinary accounting uses live root OpenAI/Copilot `session.step.ended` /
  `session.step.failed` token snapshots, attributed to exactly one unconsumed
  ordinary call of the same session and catalog model; otherwise unattributed.
- Exclude copied history, synthetic/internal activity, children, title/summary,
  compaction, and unknown eligibility. Preserve outcome amendments and ambiguous
  attribution rather than guessing.
- Missing usage is unknown. OpenCode-normalized zero is not proof of upstream
  usage. Reported cost has unspecified units, never presumed USD.
- The status bridge publishes only allowed times, counters, provider/model, policy identifiers, outcome marks, and manual-stop state (`safeStatus` on both sides). Status publication never changes warming, history, or provider requests; explicit controls use the separate `control` RPC method.
- The journal keeps the V1 location (`$XDG_STATE_HOME/opencode/session-warming/events/`) and schema 1; new reason codes are additive. Do not change the record format without a migration plan for existing history.

## Diagnostics and UI invariants

- Diagnostics identify failure and retry decisions without raw messages, stacks,
  prompts, headers, or credentials. V2 has no plugin logger and the service's
  stdout is not a log (stdio mode uses it for the handshake), so never use
  `console.*`: the sink is a private, size-bounded, rotating file
  (`session-warming/plugin.log`, 2 MiB plus one generation). Calls are bounded,
  non-blocking, and safe if the sink stalls; failure output goes to the bounded
  fallback file, never the TUI terminal.
- Metadata hooks have deadlines. Failed diagnostics must not become session
  errors or unhandled promise rejections.
- Status is an in-memory registry (64 sessions, inactive entries expire after
  an hour), emitted as coalesced RPC events and polled every two seconds by the
  CLI. RPC failure renders as unavailable. Publication failure must not affect
  the engine.
- The bar is a native background fill with no glyphs inside it. Adjacent text
  shows state, request counts, failures, and timers. Preserve the cool-left /
  red-right palette, readable monochrome mode, frozen stopped progress, and both
  timers enabled by default.
- The sidebar may show cumulative provider-reported warm and admitted ordinary
  root-step input, output, cache read/write, and cache-read ratio values for the
  current window. Keep supported stat rows stable while status is available;
  render unavailable values as N/A and omit unsupported metrics. Never turn
  normalized zero into proof of upstream usage, and do not present the ratio or
  token values as proof of cache refresh or as a dollar-cost estimate.
- Prefer the `sidebar.content` slot. Use `prompt.footer.status` when the sidebar
  is hidden, and `session.composer.top` when neither is mounted (child,
  permission, and form views). Never display duplicate indicators. A
  native-warming location renders **Disabled**.
- Bar width follows available space and does not change with band count.
  Bands follow `ceil(duration / interval)` and group only to fit the terminal or
  an explicit segment cap. Preserve a shorter final interval and fractional
  time-derived frontier shading. Show completed and failed totals, not attempts
  counted as successes.

## Development and verification

Use the Node version in `mise.toml`:

```sh
mise install
npm ci
npm run check
```

Complete coherent code, test, and documentation edits before running the
combined suite. Do not run tests after every small edit. Finish with one review
of `git status`, `git diff`, and the staged diff.

The unit suite uses fake clocks, mock transports, and a fake V2 plugin context.
Do not add live provider calls to automated tests. `npm run test:runtime` and
`npm run test:tui` require `OPENCODE_BIN` pointing at a private 2.1.x or 2.2.x binary
(for example from `npm pack @opencode/cli-darwin-arm64@2.2.0` into a temp
directory); never install it globally or into `~/.opencode`. They run a private
`opencode serve` with isolated HOME/XDG, `OPENCODE_CONFIG_DIR`, `OPENCODE_DB`,
a fake ChatGPT credential created through the isolated API, and a local mock
reached only through a fixture plugin (listed after this plugin) plus a dead
`HTTPS_PROXY`. They must never use user accounts, the shared background
service, or global OpenCode configuration. `npm run test:tui` requires Python 3
and a PTY; it may submit locally consumed warming commands, but must not submit
model prompts or contact a live provider. Control fixtures must verify
unchanged conversation history and acknowledged start/stop behavior.

Keep development SDK/theme types pinned to the 2.1.0 API baseline, independently
of runtime support. Admit stable patches within supported minors automatically;
the shared `compatibility.ts` guard controls server and TUI loading. New minors
require passing host contract tests and a small range/test/documentation update;
major versions and prereleases require explicit review. Do not repeat upstream
source archaeology unless a concrete contract test fails.

`.github/workflows/compatibility.yml` owns the full multi-version, Linux/macOS
matrix on push/PR and daily. It discovers exact published stable V2 versions
from npm (not GitHub's latest release, which may belong to V1), selects 2.1.0,
the latest patch of each supported minor, and the newest V2 candidate, with
duplicates removed. CI uses read-only permissions and never changes the support
range automatically. Results and mock-only logs are retained in Actions.

For local implementation run `npm run check` once after the full edit batch;
run `npm run test:compatibility -- <version>` only for a targeted host-facing
change or a reported contract failure. Do not mandate a repeated local matrix:
use CI evidence for the remaining versions. The compatibility runner packs a
private platform binary into a temporary directory, verifies its exact version,
and runs runtime/TUI tests concurrently. `OPENCODE_BIN` may reuse an explicitly
supplied private binary. Unadmitted stable V2 candidates are exercised only in
a disposable source copy whose guard admits that exact candidate; never add a
production environment-variable bypass or alter the installed plugin's guard.
Test our contracts (request/encoding preservation, isolation, root eligibility,
controls, events, and UI loading), not incidental host implementation choices.

When behavior, configuration, support, privacy, or workflow contracts change,
update both documentation files: explain the user-facing result in `README.md`
and put the agent-facing constraint in this file. Keep the README readable.

For authorized implementation work, stage only intended files, inspect the
full staged diff, commit in the repository's style, push the current working
branch, and leave a clean worktree by default. A user's global instruction not
to push without a separate request takes precedence. An explicit user request not
to commit or push overrides this default for that task. Do not amend,
force-push, deploy, create pull requests, change credentials, or mutate
unrelated remote state. Never revert unrelated work.
