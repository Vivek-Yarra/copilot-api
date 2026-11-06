import consola from "consola"

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

export interface RetryOptions {
  retries?: number
  baseDelayMs?: number
  maxDelayMs?: number
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

// Retry-After is either seconds or an HTTP date
function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after")
  if (!header) return undefined

  const seconds = Number(header)
  if (Number.isFinite(seconds)) return seconds * 1000

  const date = Date.parse(header)
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now())
}

// fetch that retries transient upstream failures (429 and 5xx, plus network
// errors) with exponential backoff, honouring Retry-After when present.
// Non-retryable responses are returned as-is for the caller to handle.
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  { retries = 3, baseDelayMs = 1000, maxDelayMs = 30_000 }: RetryOptions = {},
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let response: Response | undefined
    try {
      response = await fetch(url, init)
    } catch (error) {
      if (attempt >= retries) throw error
    }

    if (response && (response.ok || !RETRYABLE_STATUS.has(response.status))) {
      return response
    }
    if (response && attempt >= retries) return response

    const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt)
    const delay = Math.min(
      maxDelayMs,
      (response && retryAfterMs(response)) ?? backoff,
    )
    consola.warn(
      `Upstream ${response ? `returned ${response.status}` : "request failed"}, retrying in ${Math.round(delay / 1000)}s (${attempt + 1}/${retries})`,
    )
    await sleep(delay)
  }
}
