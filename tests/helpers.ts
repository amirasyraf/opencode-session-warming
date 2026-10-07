import { setImmediate } from "node:timers/promises"
import type { Clock } from "../engine.ts"
import { CODEX_ENDPOINT } from "../protocol.ts"

export const imageURL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII="

export const requestBody = {
  model: "gpt-test",
  instructions: "Stable system instructions",
  input: [{ role: "user", content: [{ type: "input_text", text: "Delegate a task" }] }],
  tools: [{ type: "function", name: "task", parameters: { type: "object", properties: {} }, strict: false }],
  reasoning: { effort: "high" },
  prompt_cache_key: "root-session",
  stream: true,
  store: false,
}

export function ordinary(body: unknown = requestBody): [string, RequestInit] {
  return [CODEX_ENDPOINT, {
    method: "POST",
    headers: { authorization: "Bearer test-only", "content-type": "application/json", "session-id": "parent" },
    body: JSON.stringify(body),
  }]
}

export function completedResponse(usage: unknown = { input_tokens: 100, input_tokens_details: { cached_tokens: 90 }, output_tokens: 1 }) {
  return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { usage } })}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  })
}

export class FakeClock implements Clock {
  time = 0
  timers = new Map<symbol, { at: number; callback: () => void }>()
  now = () => this.time
  set = (callback: () => void, delay: number) => {
    const id = Symbol()
    this.timers.set(id, { at: this.time + delay, callback })
    return id
  }
  clear = (id: unknown) => { this.timers.delete(id as symbol) }
  async advance(ms: number) {
    const end = this.time + ms
    while (true) {
      const next = [...this.timers.entries()].filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      this.time = next[1].at
      this.timers.delete(next[0])
      next[1].callback()
      await setImmediate()
    }
    this.time = end
    await setImmediate()
  }
}
