import type { ModelProvider, ModelRequest } from "./generation.js";

const GROQ_CHAT_COMPLETIONS = "https://api.groq.com/openai/v1/chat/completions";

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
  try {
    const raw = (await response.text()).slice(0, 8192);
    const parsed: unknown = JSON.parse(raw);
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
  return new GroqProviderError(response.status, category, code, type, param, suggestion);
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
  { model, system, prompt }: ModelRequest,
): Promise<string> {
  return requestGroq({ model, system, prompt });
};

/** Exported with injectable fetch so unit tests never contact a paid service. */
export async function requestGroq(
  { model, system, prompt }: ModelRequest,
  requester: typeof fetch = fetch,
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

  let response: Response;
  try {
    response = await requester(GROQ_CHAT_COMPLETIONS, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
        stream: false,
        temperature: 0.1,
        max_completion_tokens: 5000,
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch {
    throw new Error(
      "Could not reach GroqCloud. Check your internet connection and try again.",
    );
  }
  if (!response.ok) throw await classifyGroqFailure(response);
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error("GroqCloud returned an unreadable response");
  }
  const parsed = data as {
    choices?: Array<{ message?: { content?: unknown } }>;
  } | null;
  const text = parsed?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("GroqCloud returned no generated JSON text");
  }
  return text;
}
