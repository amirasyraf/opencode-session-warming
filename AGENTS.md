# Agent instructions

## Scope

This project is a local OpenCode **v1.18.30** plugin for best-effort warming of
root-session OpenAI/Codex OAuth HTTP Responses requests. Read `README.md` before
changing behavior. Its TUI indicator lives in this same project (`tui.tsx`), with
a separate entry in `tui.json`. Other providers, native LLM execution, and WebSockets are
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
- Fence retries and late callbacks. Expiry/disposal/cancellation cannot resurrect
  state. Warm requests never extend the ordinary activity window.
- Reject unimplemented/stateful request shapes and provider-hosted tools.
- Treat missing usage as unknown. Do not claim guaranteed caching or cost savings.
- Diagnostics must identify failures and retry/abort decisions without raw error
  messages, stacks, prompts, or headers. Keep log calls bounded and non-blocking;
  fallback output goes to a bounded file, never the TUI's terminal.
- Metadata hooks have deadlines. Do not await logging or let failed diagnostics
  turn into session errors or unhandled promise rejections.
- The UI is a read-only observer. Its metadata channel must not change warming
  timers, conversation history, or provider requests. Publish only allowed times,
  counters and outcome marks; never snapshots, prompt content, or credentials.
- Keep status writes atomic, coalesced and bounded. Treat missing/stale/dead-owner
  records as unavailable. A failed UI or publication must not break the engine.
- Native bar background fill represents elapsed window time. Request markers
  represent actual attempt outcomes; never invent a completed marker from time.
  Maintain the cool-left/red-right palette, freeze stopped progress, distinguish
  outcomes in monochrome, and default both independently configurable timers on.

## Development

Use the Node version in `mise.toml`, `npm ci`, and `npm run check`. Server
dependencies are pinned to OpenCode 1.18.30; TUI peer packages are pinned to the
matching OpenTUI release for type checking. `plugin.ts` is the server entry point
and `tui.tsx` is the TUI entry point; OpenCode loads them from separate config
files.

Complete coherent implementation, tests, and documentation edits before running
the combined check suite and final Git review. Do not add live provider calls to
automated tests. The runtime integration test isolates HOME/XDG directories and
uses a local mock provider; it must never use the user's accounts or global
OpenCode config. Run `npm run test:runtime` when `opencode` 1.18.30 is available.
Run `npm run test:tui` for startup changes; it also requires Python 3 and a PTY.
It must not submit prompts or contact a live model provider.

Keep changes small. Avoid a generic provider framework, persistent conversation storage,
background daemon, task counters, or conversation reconstruction. Update both
documentation files when their contracts change.
