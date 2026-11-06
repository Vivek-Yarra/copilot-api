import type { ModelsResponse } from "~/services/copilot/get-models"

export interface State {
  githubToken?: string
  copilotToken?: string

  accountType: string
  models?: ModelsResponse
  vsCodeVersion?: string

  manualApprove: boolean
  rateLimitWait: boolean
  showToken: boolean

  // Rate limiting configuration
  rateLimitSeconds?: number
  lastRequestTimestamp?: number

  // Model family (opus/sonnet/haiku) -> Copilot model used when a requested
  // Claude model ID has no exact Copilot match
  modelFallback: Record<string, string>
}

export const DEFAULT_MODEL_FALLBACK: Record<string, string> = {
  opus: "claude-opus-5.5",
  sonnet: "claude-sonnet-5.5",
  haiku: "claude-haiku-5.5",
}

export const state: State = {
  accountType: "individual",
  manualApprove: false,
  rateLimitWait: false,
  showToken: false,
  modelFallback: { ...DEFAULT_MODEL_FALLBACK },
}

// Parse "opus=claude-opus-5.5,haiku=claude-haiku-4.5" over the defaults
export function parseModelFallback(
  spec: string | undefined,
): Record<string, string> {
  const result = { ...DEFAULT_MODEL_FALLBACK }
  if (!spec) return result

  for (const pair of spec.split(",")) {
    const [family, model] = pair.split("=").map((s) => s.trim())
    if (!family || !model) {
      throw new Error(
        `Invalid model fallback "${pair}", expected family=model (e.g. opus=claude-opus-5.5)`,
      )
    }
    result[family] = model
  }
  return result
}
