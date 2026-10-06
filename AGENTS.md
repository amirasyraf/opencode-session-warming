# Agent instructions

## Scope

This project is a local OpenCode **v1.18.30** plugin for best-effort warming of
root-session OpenAI/Codex OAuth HTTP Responses requests. Read `README.md` before
changing behavior. Other providers, native LLM execution, and WebSockets are
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

## Development

Use the Node version in `mise.toml`, `npm ci`, and `npm run check`. Type-only
OpenCode dependencies are pinned to the supported version. Export only the plugin
entry point from `plugin.ts`; OpenCode can interpret function exports as plugins.

Complete coherent implementation, tests, and documentation edits before running
the combined check suite and final Git review. Do not add live provider calls to
automated tests. The runtime integration test isolates HOME/XDG directories and
uses a local mock provider; it must never use the user's accounts or global
OpenCode config. Run `npm run test:runtime` when `opencode` 1.18.30 is available.

Keep changes small. Avoid a generic provider framework, persistent storage,
background daemon, task counters, or conversation reconstruction. Update both
documentation files when their contracts change.
