/**
 * Shared plugin RPC contract between the server plugin (`server.ts`) and the CLI plugin (`tui.tsx`).
 * JSON Schema keeps it dependency-free. Every value is reconstructed metadata: no prompts, editor text,
 * request bodies, headers, or credentials ever cross this boundary.
 */
// OpenCode's RPC validator disables JSON Schema `pattern`; handlers re-validate identifiers themselves.
const id = { type: "string", minLength: 1, maxLength: 128 } as const

export const WarmingRpc = {
  id: "session-warming",
  methods: {
    status: {
      input: { type: "object", properties: { sessionID: id }, required: ["sessionID"], additionalProperties: false },
      output: { type: "object", properties: { status: { type: "object" }, native: { type: "boolean" } }, additionalProperties: false },
    },
    control: {
      input: {
        type: "object",
        properties: { requestID: id, sessionID: id, action: { enum: ["start", "stop"] } },
        required: ["requestID", "sessionID", "action"],
        additionalProperties: false,
      },
      output: { type: "object", properties: { result: { type: "string" } }, required: ["result"], additionalProperties: false },
    },
    native: {
      input: { type: "object", properties: { enabled: { type: "boolean" } }, required: ["enabled"], additionalProperties: false },
      output: { type: "object", additionalProperties: false },
    },
  },
  events: {
    status: {
      schema: { type: "object", properties: { sessionID: id, status: { type: "object" } }, required: ["sessionID", "status"], additionalProperties: false },
    },
  },
} as const

export default WarmingRpc
