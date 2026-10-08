# Agent instructions

## Scope

This project is a local OpenCode **v1.18.x** plugin for best-effort warming of
root-session OpenAI API/Codex OAuth and GitHub Copilot HTTP requests. Read `README.md` before
changing behavior. Its TUI indicator lives in this same project (`tui.tsx`), with
a separate entry in `tui.json`. API/Copilot GPT-5.6+ Responses and Copilot
Sonnet/Opus 5+ Messages are supported, along with legacy Codex. Other providers,
Chat Completions, enterprise/custom endpoints, native LLM execution, and WebSockets are
unsupported. Do not silently enable transports or change user credentials.

## Invariants

- Ordinary requests retain their authentication, routing, bytes, cancellation,
  response metadata, and backpressure. Capture failures must not break them.
- Capture only explicitly marked requests. Strip the reserved marker before
  transmission, including late requests after disposal.
- Warming uses independent HTTP calls: never `session.prompt`, session-history
  writes, agent/tool execution, or OAuth refresh.
- Only root sessions warm. New ordinary root-model activity invalidates old
  warming even when the new request is unsupported. Child activity is independent.
- Raw transport completion, not session `busy` or processed stream completion,
  determines whether the parent is still generating.
- Keep snapshots and authenticated headers in RAM only. Never log their content.
- The optional metadata journal is automatic by default, independent of debug logs.
  Persist only reconstructed allowlisted metadata, never SDK/request objects,
  paths, titles, credentials or raw errors. Keep writes buffered, bounded and
  independent of warming; uncertain writes are never replayed.
- Default journal retention to 365 days with no disk cap. The latest supported,
  journal-enabled startup sets shared policy retroactively. An optional disk target
  pauses recording; it never authorizes deleting inside-retention history. Preserve
  unknown/corrupt files and potentially live open segments. Readers/CLI are read-only.
- Ordinary accounting uses live root OpenAI/Copilot step-finish snapshots, not
  accumulated assistant cost or latest-step message tokens. Exclude copied history,
  synthetic/internal/child activity and unknown eligibility. Preserve outcome
  amendments and ambiguous attribution. OpenCode-normalized zero is not proof of
  reported upstream usage; reported cost has unspecified units, never presumed USD.
- Warm attempts have one terminal emission even on invalidation/replacement/late
  responses. This is not exactly-once persistence or guaranteed remote cancellation.
- Fence retries and late callbacks. Expiry/disposal/cancellation cannot resurrect
  state. Warm requests never extend the ordinary activity window.
- Treat substantially late wall-clock timers as sleep/resume or clock-gap events:
  invalidate stale warming before sending or retrying a warm request.
- Reject unimplemented/stateful request shapes and provider-hosted tools.
- Keep provider endpoint/replay policy in the explicit adapter registry, protocol
  validation/parsing in `protocol.ts`, and model/request cache policy in
  `cache-policy.ts`. Numeric model floors never authorize unknown request features.
- Default GPT-5.6+ refresh to 28 minutes, Claude to 4 minutes or 58 minutes for
  exclusively one-hour markers. Preserve mixed TTLs and use the shortest selected
  marker. Gateway TTLs are upstream assumptions/requested values, not guarantees.
  Resolve model → provider → explicit global → automatic overrides per setting.
- Preserve unchanged input for native API prewarm and bounded Copilot replay.
  Claude replay must retain tool selection, thinking, effort, signatures and cache
  controls. Discard generated local function calls; never dispatch them. Skip
  incompatible explicit thinking budgets instead of changing them. Codex's legacy
  keepalive remains isolated; never invent a Codex output cap or gateway prewarm.
- Separate success refresh targets (request start) from bounded failure retries.
  Timer lateness is measured against the actual scheduled wake, not an overdue
  refresh target. Only explicit output-limit terminal outcomes qualify as bounded
  completions; neither completion nor usage guarantees a cache refresh.
- Support embedded base64 PNG/JPEG/WebP/GIF images in user messages and function
  results without changing their replay prefix. Reject remote/file-ID image
  references, files and audio; the 16 MiB body limit includes image bytes.
- Treat missing usage as unknown. Do not claim guaranteed caching or cost savings.
- Detect warm SSE bodies even with missing/misleading media types; retain bounded
  parsing and require actual stream completion rather than accepting HTTP 200 alone.
- Diagnostics must identify failures and retry/abort decisions without raw error
  messages, stacks, prompts, or headers. Keep log calls bounded and non-blocking;
  fallback output goes to a bounded file, never the TUI's terminal.
- Metadata hooks have deadlines. Do not await logging or let failed diagnostics
  turn into session errors or unhandled promise rejections.
- The UI is a read-only observer. Its metadata channel must not change warming
  timers, conversation history, or provider requests. Publish only allowed times,
  counters, provider/model/policy identifiers and outcome marks; never snapshots,
  prompt content, or credentials. TTL evidence must not become a fake expiry timer.
- Keep status writes atomic, coalesced and bounded. Treat missing/stale/dead-owner
  records as unavailable. A failed UI or publication must not break the engine.
- Native bar background fill represents elapsed window time, with no glyphs
  inside the bar. Show request counts, failures and state in adjacent text.
  Maintain the cool-left/red-right palette, freeze stopped progress, retain
  readable monochrome status, and default both independently configurable timers on.
- Prefer the sidebar section after LSP; use a compact prompt-row fallback when
  hidden, and a bottom-padded fallback for child/permission/question views without
  a prompt. Never duplicate visible indicators. Bar geometry follows available
  width. Adjoining colour bands follow `ceil(duration / interval)`, grouping only
  to fit the terminal or an explicit segment cap; never resize the track based on
  band count. Preserve a shorter final interval and time-derived fractional frontier
  shading. Show actual completed/failed totals, not attempted totals as successes.

## Development

Use the Node version in `mise.toml`, `npm ci`, and `npm run check`. Server
dependencies use the OpenCode 1.18.x range; TUI peer packages are pinned to the
matching OpenTUI release for type checking. `plugin.ts` is the server entry point
and `tui.tsx` is the TUI entry point; OpenCode loads them from separate config
files.

Complete coherent implementation, tests, and documentation edits before running
the combined check suite and final Git review. Do not add live provider calls to
automated tests. The runtime integration test isolates HOME/XDG directories and
uses a local mock provider; it must never use the user's accounts or global
OpenCode config. Run `npm run test:runtime` when an `opencode` 1.18.x stable release is available.
Run `npm run test:tui` for startup changes; it also requires Python 3 and a PTY.
It must not submit prompts or contact a live model provider.

Keep changes small. Avoid a generic provider framework, persistent conversation storage,
background daemon, task counters, or conversation reconstruction. Update both
documentation files when their contracts change.
