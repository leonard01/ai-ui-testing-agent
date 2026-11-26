import type { ModelProvider, ModelRequest } from "./generation.js";
import { readTokenUsage, type UsageAttempt } from "./ai-usage.js";

const GROQ_CHAT_COMPLETIONS = "https://api.groq.com/openai/v1/chat/completions";
export function groqCompletionBudget(value = process.env.GROQ_MAX_COMPLETION_TOKENS): number {
  if (value === undefined || !value.trim()) return 2500;
  if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(Number(value)) || Number(value) < 256 || Number(value) > 5000) {
    throw new Error("GROQ_MAX_COMPLETION_TOKENS must be an integer from 256 to 5000. No model request was made.");
  }
  return Number(value);
}
type LimitFigures = Pick<UsageAttempt,"providerRequestedTokens"|"providerTokenLimit"|"providerUsedTokens">;
function tokenLimitFigures(detail:string):LimitFigures {
  // Only extract labelled numbers from a provider rate-limit message, never its raw text.
  const read=(label:string)=>{
    const match=new RegExp("\\b"+label+"\\s*[:=]?\\s*([0-9][0-9,]{0,14})(?![0-9,]|\\.[0-9])","i").exec(detail);
    if (!match) return undefined;
    const n=Number(match[1].replace(/,/g,""));
    return Number.isSafeInteger(n) && n>=0 ? n : undefined;
  };
  if (!/tokens? per minute|tokens? per day|\bTPM\b|\bTPD\b/i.test(detail)) return {};
  return {providerRequestedTokens:read("Requested"),providerTokenLimit:read("Limit"),providerUsedTokens:read("Used")};
}

export type GroqFailureCategory =
  | "json-generation"
  | "request-too-large"
  | "invalid-parameter"
  | "invalid-model"
  | "rate-limit"
  | "authentication"
  | "bad-request"
  | "provider-error";

/**
 * Safe structured provider diagnostic. Never return raw upstream response
 * messages: they may echo requirements, authentication headers or secrets.
 */
export class GroqProviderError extends Error {
  readonly source = "groqcloud";
  constructor(
    readonly httpStatus: number,
    readonly category: GroqFailureCategory,
    readonly providerCode: string | undefined,
    readonly providerType: string | undefined,
    readonly providerParam: string | undefined,
    readonly suggestion: string,
    readonly limitFigures: LimitFigures = {},
    readonly reportedUsage?: unknown,
  ) {
    super(
      "GroqCloud HTTP " + httpStatus + " (" + category + ")." +
      (providerCode ? " Code: " + providerCode + "." : "") +
      (providerParam ? " Parameter: " + providerParam + "." : "") +
      " " + suggestion,
    );
    this.name = "GroqProviderError";
  }
}

/** Only explicit HTTP 400 JSON-generation failures qualify for text fallback. */
export function isGroqJSONModeFailure(error: unknown): boolean {
  return error instanceof GroqProviderError && error.httpStatus === 400 && error.category === "json-generation";
}

/** Request transport failed before an HTTP response was available.
 * This does not mean that the user's test instructions are invalid.
 * Never surface raw errors; URLs/proxy details can contain secrets.
 */
export class GroqTransportError extends Error {
  readonly source = "groqcloud";
  constructor(readonly category: "timeout" | "network" | "transport") {
    const message = category === "timeout"
      ? "GroqCloud did not respond within 90 seconds. The request timed out. Try again, or use a smaller test scenario."
      : category === "network"
        ? "The application could not establish a connection to GroqCloud. Check connectivity, DNS, proxy or firewall settings and try again."
        : "The GroqCloud request failed before an HTTP response was received. Check the server logs and retry; the cause could not be identified.";
    super(message);
    this.name = "GroqTransportError";
  }
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z_][a-zA-Z0-9_.:-]{0,79}$/.test(value)
    ? value : undefined;
}

async function classifyGroqFailure(response: Response): Promise<GroqProviderError> {
  // Bound provider parsing to avoid retaining extremely large/hostile bodies.
  let code: string | undefined;
  let type: string | undefined;
  let param: string | undefined;
  let detail = "";
  let reportedUsage: unknown;
  try {
    const raw = (await response.text()).slice(0, 8192);
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "usage" in parsed) reportedUsage = parsed.usage;
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const error = (parsed as { error?: unknown }).error;
      if (error && typeof error === "object") {
        const fields = error as Record<string, unknown>;
        code = safeIdentifier(fields.code);
        type = safeIdentifier(fields.type);
        param = safeIdentifier(fields.param);
        detail = typeof fields.message === "string" ? fields.message.slice(0, 1024) : "";
      }
    }
  } catch {
    // The HTTP status remains informative even without JSON metadata.
  }
  const clue = [code, type, param, detail].filter(Boolean).join(" ").toLowerCase();
  let category: GroqFailureCategory = "provider-error";
  let suggestion = "Check the selected model and the request settings.";
  if (response.status === 401 || response.status === 403) {
    category = "authentication";
    suggestion = "Check GROQ_API_KEY and your GroqCloud account.";
  } else if (response.status === 429) {
    category = "rate-limit";
    suggestion = "Free-tier rate/token limit reached; retry after your allowance resets.";
  } else if (/json_validate_failed|json.+validat|failed to generate valid json|invalid json/.test(clue)) {
    category = "json-generation";
    suggestion = "Groq could not produce acceptable JSON. Retry the draft once; if it persists, review the prompt/output mode.";
  } else if (/context_length_exceeded|tokens? exceeded|exceeds? (the )?(context|token)|request too large|too many tokens/.test(clue)) {
    category = "request-too-large";
    suggestion = "Provider reports a context/token limit. Try a smaller scenario or reduce page context.";
  } else if (/model_not_found|model_decommissioned|invalid model|model does not exist|model not found/.test(clue)) {
    category = "invalid-model";
    suggestion = "Confirm the GroqCloud model ID and availability.";
  } else if (/unsupported|not supported|unknown parameter|invalid parameter|invalid value|unsupported_value/.test(clue)) {
    category = "invalid-parameter";
    suggestion = "A request parameter is invalid for this model. Check the model's supported options.";
  } else if (response.status === 400) {
    category = "bad-request";
    suggestion = "Groq rejected the request. Inspect its safe error code/type/parameter; the request length is not yet confirmed as the cause.";
  }
  const usage = readTokenUsage(reportedUsage);
  return new GroqProviderError(response.status, category, code, type, param, suggestion,
    category === "rate-limit" ? tokenLimitFigures(detail) : {},
    {prompt_tokens:usage.inputTokens,completion_tokens:usage.outputTokens,total_tokens:usage.totalTokens});
}

/**
 * Hosted inference via GroqCloud. The key is read from the developer's
 * environment; it is never written to a test definition or log.
 *
 * The response uses JSON object mode for syntax, followed by our existing
 * Zod validation and same-origin guards in generateDraft().
 * No extra npm packages or local model installation are required.
 */
export const groqProvider: ModelProvider = async function (
  request: ModelRequest,
): Promise<string> {
  return requestGroq(request);
};

/** Exported with injectable fetch so unit tests never contact a paid service. */
export async function requestGroq(
  { model, system, prompt, responseMode = "json" }: ModelRequest,
  requester: typeof fetch = fetch,
  observe?: (attempt: UsageAttempt) => void | Promise<void>,
): Promise<string> {
  const key = process.env.GROQ_API_KEY?.trim();
  if (!key) {
    if (process.env.GROK_API_KEY) {
      throw new Error(
        "GROK_API_KEY is not a GroqCloud setting. Use GROQ_API_KEY for GroqCloud; " +
        "Grok/xAI is a different service. No model request was made.",
      );
    }
    throw new Error(
      "GROQ_API_KEY is missing. Add GROQ_API_KEY to the project .env file " +
      "or export it in your terminal. No model request was made.",
    );
  }

  // A brief retry helps with transient DNS/TLS/socket failures. Network
  // errors are not proof that the upstream never received the POST, so
  // limit automatic retry to ONE extra attempt to bound potential charges.
  // Timeout/unknown errors and HTTP responses are never retried here.
  const completionBudget=groqCompletionBudget();
  const estimatedInputTokens=Math.ceil((system.length+prompt.length)/4);
  const requestBody = JSON.stringify({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ],
    ...(responseMode === "json" ? { response_format: { type: "json_object" } } : {}),
    stream: false,
    temperature: 0.1,
    max_completion_tokens: completionBudget,
  });
  let response: Response | undefined;
  let started = Date.now();
  let transportAttempt = 1;
  async function record(status: string, response?: Response, usage?: unknown, figures: LimitFigures = {}) {
    const remaining = response?.headers.get("x-ratelimit-remaining-tokens");
    const reset = response?.headers.get("x-ratelimit-reset-tokens");
    const retry = response?.headers.get("retry-after");
    const retryAfter = retry && (/^\d+(?:\.\d+)?$/.test(retry) || /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retry)) ? retry : undefined;
    const remainingTokens = remaining && /^\d+$/.test(remaining) ? Number(remaining) : undefined;
    const resetTokens = reset && /^[0-9a-z.]{1,40}$/i.test(reset) ? reset : undefined;
    try { await observe?.({
      provider:"groqcloud", model, startedAt:new Date(started).toISOString(),
      durationMs:Date.now()-started,status,httpStatus:response?.status,
      ...readTokenUsage(usage), completionBudget, estimatedInputTokens, ...figures, retryAfter,
      systemCharacters:system.length,promptCharacters:prompt.length,
      remainingTokens,resetTokens,transportAttempt,responseMode,
    }); } catch { /* Telemetry must not invalidate or retry an AI request. */ }
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    started=Date.now();
    transportAttempt=attempt+1;
    try {
      response = await requester(GROQ_CHAT_COMPLETIONS, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
        },
        body: requestBody,
        signal: AbortSignal.timeout(90_000),
      });
      break;
    } catch (error) {
      const category = error instanceof Error && error.name === "TimeoutError"
        ? "timeout" : error instanceof TypeError ? "network" : "transport";
      await record(category);
      if (category === "network" && attempt === 0 && responseMode === "json") {
        await new Promise<void>((resolve) => setTimeout(resolve, 300));
        continue;
      }
      throw new GroqTransportError(category);
    }
  }
  if (!response) throw new GroqTransportError("transport");
  if (!response.ok) {
    const failure=await classifyGroqFailure(response);
    await record(failure.category,response,failure.reportedUsage,failure.limitFigures);
    throw failure;
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    await record("unreadable-response",response);
    throw new Error("GroqCloud returned an unreadable response");
  }
  const parsed = data as {
    choices?: Array<{ message?: { content?: unknown } }>;
    usage?: unknown;
  } | null;
  const text = parsed?.choices?.[0]?.message?.content;
  await record(typeof text === "string" && text.trim() ? "response-received" : "empty-response",response,parsed?.usage);
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("GroqCloud returned no generated JSON text");
  }
  return text;
}
