import { readFile } from "node:fs/promises";
import type { ModelProvider, ModelRequest } from "./generation.js";
import { parseTestDefinition } from "./schema.js";

/**
 * A deterministic stand-in that lets developers exercise the entire
 * inspection -> draft validation -> review -> runner pipeline without a model.
 *
 * THIS IS NOT AI GENERATION: the fixture is a prewritten case. We mark any
 * assertion previously labelled human-confirmed as inferred to avoid claiming
 * the simulated provider independently verified human approval.
 */
export function fixtureProvider(path = "examples/add-task.json"): ModelProvider {
  return async () => {
    const data = JSON.parse(await readFile(path, "utf8")) as unknown;
    const definition = parseTestDefinition(data);
    const steps = definition.steps.map((step) =>
      (step.action.kind === "assert-text" || step.action.kind === "assert-visible") &&
      step.action.provenance === "human-confirmed"
        ? { ...step, action: { ...step.action, provenance: "inferred" as const } }
        : step,
    );
    return JSON.stringify({ ...definition, steps });
  };
}

/**
 * Local inference via Ollama running on the developer's computer.
 * Fixed loopback address: no cloud API credentials and no user-supplied
 * server URLs. Ollama's JSON mode improves syntax, not semantic accuracy.
 */
export async function ollamaProvider(
  { model, system, prompt }: ModelRequest,
  requester: typeof fetch = fetch,
): Promise<string> {
  let response: Response;
  try {
    response = await requester("http://127.0.0.1:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model, system, prompt, stream: false, format: "json",
        options: { temperature: 0.1, num_predict: 5000 },
      }),
      signal: AbortSignal.timeout(300_000),
    });
  } catch (error) {
    throw new Error(
      "Cannot connect to local Ollama at http://127.0.0.1:11434. " +
      "Install/start Ollama and pull your model. " +
      (error instanceof Error ? error.message : String(error)),
    );
  }
  if (!response.ok) {
    throw new Error(
      `Local Ollama request failed (HTTP ${response.status}); ` +
      "check that the selected model has been pulled locally",
    );
  }
  const json: unknown = await response.json();
  const result = json as { response?: unknown; done?: unknown };
  if (!result || typeof result.response !== "string" || !result.response.trim()) {
    throw new Error("Local Ollama did not return generated JSON text");
  }
  return result.response;
}
