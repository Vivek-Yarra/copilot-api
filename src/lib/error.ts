import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import consola from "consola"

export class HTTPError extends Error {
  response: Response

  constructor(message: string, response: Response) {
    super(message)
    this.response = response
  }
}

export async function forwardError(c: Context, error: unknown) {
  consola.error("Error occurred:", error)

  if (error instanceof HTTPError) {
    const errorText = await error.response.text()
    let errorJson: unknown
    try {
      errorJson = JSON.parse(errorText)
    } catch {
      errorJson = errorText
    }
    consola.error("HTTP error:", errorJson)
    return c.json(
      {
        error: {
          message: errorText,
          type: "error",
        },
      },
      error.response.status as ContentfulStatusCode,
    )
  }

  return c.json(
    {
      error: {
        message: (error as Error).message,
        type: "error",
      },
    },
    500,
  )
}

const ANTHROPIC_ERROR_TYPES: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  413: "request_too_large",
  429: "rate_limit_error",
  529: "overloaded_error",
}

// Same as forwardError, but in the Anthropic error shape so clients like
// Claude Code show the real cause instead of a generic failure
export async function forwardAnthropicError(c: Context, error: unknown) {
  consola.error("Error occurred:", error)

  let status = 500
  let message = (error as Error).message

  if (error instanceof HTTPError) {
    status = error.response.status
    const errorText = await error.response.text()
    message = errorText
    try {
      const errorJson = JSON.parse(errorText) as {
        error?: { message?: string }
      }
      message = errorJson.error?.message ?? errorText
    } catch {
      // upstream returned plain text
    }
    consola.error("HTTP error:", message)
  }

  return c.json(
    {
      type: "error",
      error: {
        type: ANTHROPIC_ERROR_TYPES[status] ?? "api_error",
        message,
      },
    },
    status as ContentfulStatusCode,
  )
}
