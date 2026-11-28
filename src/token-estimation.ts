import { encode } from "gpt-tokenizer/encoding/o200k_harmony";
import type { ModelRequest } from "./generation.js";

export const TOKEN_ESTIMATOR_VERSION = "harmony-content-v1";
const supported = new Set(["openai/gpt-oss-20b","openai/gpt-oss-120b"]);

/** Count ordinary text, not special-token instructions embedded in untrusted page data. */
export function countHarmonyText(text: string): number {
  return encode(text, { disallowedSpecial: new Set<string>() }).length;
}

export function estimateModelTokens(request: ModelRequest, representativeOutput?: string, provider?: string) {
  if (!supported.has(request.model)) {
    return {
      estimator: "characters-v1",
      estimatedInputTokens: Math.ceil((request.system.length+request.prompt.length)/4),
    };
  }
  const systemTokens = countHarmonyText(request.system);
  const promptTokens = countHarmonyText(request.prompt);
  // Provisional calibration from the 40-case GroqCloud GPT-OSS 20B experiment.
  // Other providers/models retain the uncalibrated content estimate.
  const calibrated = provider === "groqcloud" && request.model === "openai/gpt-oss-20b" && request.responseMode !== undefined;
  const providerOverheadTokens = calibrated ? (request.responseMode === "json" ? 102 : 74) : 0;
  return {
    estimator: calibrated ? "harmony-groq-20b-calibrated-v1" : TOKEN_ESTIMATOR_VERSION,
    systemTokens, promptTokens,
    estimatedInputTokens: systemTokens+promptTokens+providerOverheadTokens,
    ...(calibrated ? {providerOverheadTokens} : {}),
    ...(representativeOutput===undefined ? {} : {representativeOutputTokens:countHarmonyText(representativeOutput)}),
  };
}
