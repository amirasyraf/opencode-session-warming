# Agent instructions

## Read first

This repository contains two OpenCode v1.18.x plugins:

- `plugin.ts` is the server plugin.
- `tui.tsx` is the TUI plugin.

They load from separate OpenCode config files. `README.md` is for humans: keep
it short, task-oriented, and free of internal implementation contracts.
This file is for coding agents: put precise invariants and verification rules
here instead of expanding the README.

## Scope

The plugin warms root-session OpenAI API/Codex OAuth and GitHub Copilot HTTP
requests. Supported paths are API/Copilot GPT-5.6+ Responses, Copilot Sonnet /
Opus 5+ Messages, and legacy Codex. Other providers, Chat Completions,
enterprise/custom endpoints, native LLM execution, WebSockets, provider-hosted
tools, and stateful provider conversations are unsupported. Do not silently
enable a transport or change user credentials.

Keep responsibilities in their current modules:

- `transport.ts`: one process-wide fetch shim; ordinary traffic preservation.
- `protocol.ts`: bounded request validation and Responses/Messages parsing.
- `adapters.ts`: explicit provider endpoints and replay policy.
- `cache-policy.ts`: model floors, defaults, overrides, and precedence.
- `engine.ts`: scheduling, invalidation, retries, and warm lifecycle.
- `status.ts`, `indicator.ts`, `tui.tsx`: read-only UI publication and rendering.
- `journal-schema.ts`, `journal.ts`, `journal-reader.ts`, `journal-cli.ts`:
  allowlisted metadata persistence and read-only inspection.
- `ordinary-observer.ts`: live root usage attribution without history reads.

Do not replace this with a generic provider framework, persistent conversation
store, background daemon, task counter, or conversation reconstruction layer.

## Transport and session invariants

- Ordinary requests keep their authentication, routing, bytes, cancellation,
  response metadata, body backpressure, and response identity.
- Capture only requests bearing the plugin's opaque marker. Remove that marker
  before transmission, including late requests after disposal.
- Capture failures must fail open and never break an ordinary request.
- Warming uses independent HTTP calls. Never use `session.prompt`, session
  history writes, agent/tool execution, or OAuth refresh.
- Only root sessions warm. New ordinary root-model activity invalidates old
  warming even when the new provider, model, or request is unsupported.
  Child activity is independent.
- Raw transport completion, not `session.busy` or processed stream completion,
  decides when the parent is still generating.
- Reject stateful references, provider-hosted tools, unimplemented input
  types, unsupported media, and request bodies over 16 MiB.
- Support embedded base64 PNG, JPEG, WebP, and GIF images in user messages and
  function results without changing the replay prefix. Reject remote and file-ID
  images, files, and audio. Image bytes count toward the body limit.
- Detect SSE from field prefixes even when the media type is missing or wrong.
  Require semantic stream completion; HTTP 200 and EOF alone are insufficient.
- Keep snapshots and authenticated headers in RAM. Never log their content.

## Replay and policy invariants

- Keep provider endpoint and replay policy in the explicit adapter registry.
  Numeric model floors never authorize unknown request features.
- Preserve unchanged input for native API prewarm and bounded Copilot replay.
- Claude replay retains tool selection, thinking, effort, signatures, cache
  controls, and cache markers. Discard generated local function calls; never
  dispatch them.
- Skip incompatible explicit thinking budgets instead of changing them.
- Keep Codex's legacy keepalive isolated. Do not invent a Codex output cap or a
  gateway prewarm mode.
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
  stale warming before sending or retrying. Do not send catch-up bursts.
- Every warm attempt emits one terminal outcome, including invalidation,
  replacement, and late-response paths. This is not exactly-once persistence
  and does not guarantee remote cancellation.

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
- Ordinary accounting uses live root OpenAI/Copilot step-finish snapshots, not
  accumulated assistant cost or latest-step message tokens.
- Exclude copied history, synthetic/internal activity, children, title/summary,
  compaction, and unknown eligibility. Preserve outcome amendments and ambiguous
  attribution rather than guessing.
- Missing usage is unknown. OpenCode-normalized zero is not proof of upstream
  usage. Reported cost has unspecified units, never presumed USD.
- The UI metadata bridge publishes only allowed times, counters, provider/model,
  policy identifiers, and outcome marks. It never changes warming, history, or
  provider requests.

## Diagnostics and UI invariants

- Diagnostics identify failure and retry decisions without raw messages, stacks,
  prompts, headers, or credentials. Calls are bounded, non-blocking, and safe if
  the logger rejects or stalls. Fallback output goes to a bounded file, never
  the TUI terminal.
- Metadata hooks have deadlines. Failed diagnostics must not become session
  errors or unhandled promise rejections.
- Status writes are atomic, coalesced, and bounded. Missing, stale, or dead-owner
  status is unavailable. Publication failure must not affect the engine.
- The bar is a native background fill with no glyphs inside it. Adjacent text
  shows state, request counts, failures, and timers. Preserve the cool-left /
  red-right palette, readable monochrome mode, frozen stopped progress, and both
  timers enabled by default.
- The sidebar may show cumulative provider-reported warm and admitted ordinary
  root-step input, output, cache read/write, uncached input, and cache-read ratio
  values for the current window. Omit missing fields, never turn normalized zero
  into proof of upstream usage, and do not present the ratio or token values as
  proof of cache refresh or as a dollar-cost estimate.
- Prefer the sidebar section after LSP. Use the prompt-row fallback when the
  sidebar is hidden, and the bottom-padded fallback for child, permission, and
  question views without a prompt. Never display duplicate indicators.
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

The unit suite uses fake clocks and mock transports. Do not add live provider
calls to automated tests. `npm run test:runtime` requires an installed stable
OpenCode 1.18.x release and isolates HOME/XDG directories with a local mock
provider. It must never use user accounts or global OpenCode configuration.
`npm run test:tui` requires Python 3 and a PTY; it must not submit prompts or
contact a live provider.

When behavior, configuration, support, privacy, or workflow contracts change,
update both documentation files: explain the user-facing result in `README.md`
and put the agent-facing constraint in this file. Keep the README readable.

When the user explicitly authorizes a commit, stage only intended
files, inspect the full staged diff, commit in the repository's style, and
leave a clean worktree. Do not amend, push, deploy, or change credentials
unless each action is separately authorized. Never revert unrelated work.
