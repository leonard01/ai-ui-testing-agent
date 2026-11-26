import { encode } from "gpt-tokenizer/encoding/o200k_harmony";
import type { ModelRequest } from "./generation.js";

export const TOKEN_ESTIMATOR_VERSION = "harmony-content-v1";
const supported = new Set(["openai/gpt-oss-20b","openai/gpt-oss-120b"]);

/** Count ordinary text, not special-token instructions embedded in untrusted page data. */
export function countHarmonyText(text: string): number {
  return encode(text, { disallowedSpecial: new Set<string>() }).length;
}

export function estimateModelTokens(request: ModelRequest, representativeOutput?: string) {
  if (!supported.has(request.model)) {
    return {
      estimator: "characters-v1",
      estimatedInputTokens: Math.ceil((request.system.length+request.prompt.length)/4),
    };
  }
  const systemTokens = countHarmonyText(request.system);
  const promptTokens = countHarmonyText(request.prompt);
  // Provider-specific chat templates, injected instructions and response-mode
  // overhead are not visible to the application. Do not claim exact billing.
  return {
    estimator: TOKEN_ESTIMATOR_VERSION,
    systemTokens, promptTokens,
    estimatedInputTokens: systemTokens+promptTokens,
    ...(representativeOutput===undefined ? {} : {representativeOutputTokens:countHarmonyText(representativeOutput)}),
  };
}
