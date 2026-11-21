import type { ModelProvider, ModelRequest } from "./generation.js";

const GROQ_CHAT_COMPLETIONS = "https://api.groq.com/openai/v1/chat/completions";

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
  if (!response.ok) {
    const advice = response.status === 401 || response.status === 403
      ? "Check GROQ_API_KEY and your GroqCloud account."
      : response.status === 429
        ? "Free-tier rate/token limit reached; retry after your allowance resets."
        : "Check the selected model and your GroqCloud account limits.";
    throw new Error("GroqCloud request failed (HTTP " + response.status + "). " + advice);
  }
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
