import { afterEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type { Message } from "~/services/copilot/create-chat-completions"
import type { ModelsResponse } from "~/services/copilot/get-models"

import { forwardAnthropicError, HTTPError } from "../src/lib/error"
import { fetchWithRetry } from "../src/lib/retry"
import {
  DEFAULT_MODEL_FALLBACK,
  parseModelFallback,
  state,
} from "../src/lib/state"
import {
  translateModelName,
  translateToOpenAI,
} from "../src/routes/messages/non-stream-translation"
import { getInitiator } from "../src/services/copilot/create-chat-completions"

const COPILOT_MODELS = [
  "claude-opus-5.5",
  "claude-sonnet-5.5",
  "claude-sonnet-5",
  "claude-haiku-5.5",
  "claude-haiku-4.5",
]
state.models = {
  data: COPILOT_MODELS.map((id) => ({ id })),
} as unknown as ModelsResponse

describe("translateModelName", () => {
  afterEach(() => {
    state.modelFallback = { ...DEFAULT_MODEL_FALLBACK }
  })

  test("passes through IDs Copilot already knows", () => {
    expect(translateModelName("claude-sonnet-5")).toBe("claude-sonnet-5")
  })

  test("strips the [1m] suffix and converts dashes to a dotted version", () => {
    expect(translateModelName("claude-opus-5-5[1m]")).toBe("claude-opus-5.5")
  })

  test("strips date suffixes", () => {
    expect(translateModelName("claude-haiku-4-5-20251001")).toBe(
      "claude-haiku-4.5",
    )
  })

  test("falls back to the family model when there is no match", () => {
    expect(translateModelName("claude-opus-9-9")).toBe("claude-opus-5.5")
  })

  test("uses a configured family fallback", () => {
    state.modelFallback = parseModelFallback("opus=claude-sonnet-5")
    expect(translateModelName("claude-opus-9-9")).toBe("claude-sonnet-5")
  })

  test("leaves non-Claude models alone", () => {
    expect(translateModelName("gpt-4.1")).toBe("gpt-4.1")
  })
})

describe("parseModelFallback", () => {
  test("returns the defaults when unset", () => {
    expect(parseModelFallback(undefined)).toEqual(DEFAULT_MODEL_FALLBACK)
  })

  test("overrides only the given families", () => {
    expect(parseModelFallback(" haiku = claude-haiku-4.5 ")).toEqual({
      ...DEFAULT_MODEL_FALLBACK,
      haiku: "claude-haiku-4.5",
    })
  })

  test("rejects malformed entries", () => {
    expect(() => parseModelFallback("opus")).toThrow("Invalid model fallback")
  })
})

describe("assistant prefill", () => {
  const basePayload = {
    model: "claude-opus-5.5",
    max_tokens: 100,
  }

  test("drops a trailing assistant prefill", () => {
    const payload: AnthropicMessagesPayload = {
      ...basePayload,
      messages: [
        { role: "user", content: "Reply with JSON" },
        { role: "assistant", content: "{" },
      ],
    }
    const { messages } = translateToOpenAI(payload)
    expect(messages.at(-1)?.role).toBe("user")
  })

  test("keeps a trailing assistant tool call", () => {
    const payload: AnthropicMessagesPayload = {
      ...basePayload,
      messages: [
        { role: "user", content: "List files" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "ls", input: { path: "." } },
          ],
        },
      ],
    }
    const { messages } = translateToOpenAI(payload)
    expect(messages.at(-1)?.role).toBe("assistant")
    expect(messages.at(-1)?.tool_calls).toHaveLength(1)
  })
})

describe("getInitiator", () => {
  const user: Message = { role: "user", content: "hi" }
  const assistant: Message = { role: "assistant", content: "hello" }
  const tool: Message = { role: "tool", tool_call_id: "t1", content: "ok" }
  const system: Message = { role: "system", content: "sys" }

  test("first prompt is user-initiated", () => {
    expect(getInitiator([system, user])).toBe("user")
  })

  test("a typed follow-up is user-initiated", () => {
    expect(getInitiator([user, assistant, user])).toBe("user")
  })

  test("a tool result is agent-initiated", () => {
    expect(getInitiator([user, assistant, tool])).toBe("agent")
  })

  test("text attached to a tool result is still agent-initiated", () => {
    expect(getInitiator([user, assistant, tool, user])).toBe("agent")
  })

  test("ending on an assistant turn is agent-initiated", () => {
    expect(getInitiator([user, assistant])).toBe("agent")
  })
})

const respond = (status: number, headers: Record<string, string> = {}) =>
  new Response(status === 200 ? "ok" : "err", { status, headers })

describe("fetchWithRetry", () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  const stubFetch = (responses: Array<Response>) => {
    const fn = mock(() => Promise.resolve(responses.shift() ?? respond(200)))
    globalThis.fetch = fn as unknown as typeof fetch
    return fn
  }

  test("retries 429 and 5xx, then returns the success", async () => {
    const fn = stubFetch([respond(429), respond(503), respond(200)])
    const res = await fetchWithRetry("http://x", {}, { baseDelayMs: 1 })
    expect(res.status).toBe(200)
    expect(fn).toHaveBeenCalledTimes(3)
  })

  test("does not retry other client errors", async () => {
    const fn = stubFetch([respond(400)])
    const res = await fetchWithRetry("http://x", {}, { baseDelayMs: 1 })
    expect(res.status).toBe(400)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test("returns the last failure once retries are used up", async () => {
    const fn = stubFetch([respond(500), respond(500), respond(500)])
    const res = await fetchWithRetry(
      "http://x",
      {},
      { retries: 2, baseDelayMs: 1 },
    )
    expect(res.status).toBe(500)
    expect(fn).toHaveBeenCalledTimes(3)
  })

  test("honours Retry-After, capped by maxDelayMs", async () => {
    stubFetch([respond(429, { "retry-after": "60" }), respond(200)])
    const start = Date.now()
    const res = await fetchWithRetry(
      "http://x",
      {},
      { baseDelayMs: 1, maxDelayMs: 20 },
    )
    expect(res.status).toBe(200)
    expect(Date.now() - start).toBeLessThan(1000)
  })
})

describe("forwardAnthropicError", () => {
  const app = new Hono()
  app.post("/upstream", (c) =>
    forwardAnthropicError(
      c,
      new HTTPError(
        "Failed",
        new Response(
          JSON.stringify({
            error: { message: "The requested model is not supported." },
          }),
          { status: 400 },
        ),
      ),
    ),
  )
  app.post("/crash", (c) => forwardAnthropicError(c, new Error("boom")))

  test("returns upstream errors in the Anthropic error shape", async () => {
    const res = await app.request("/upstream", { method: "POST" })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "The requested model is not supported.",
      },
    })
  })

  test("maps unexpected errors to api_error", async () => {
    const res = await app.request("/crash", { method: "POST" })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      type: "error",
      error: { type: "api_error", message: "boom" },
    })
  })
})
