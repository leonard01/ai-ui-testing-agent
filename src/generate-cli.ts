import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { loadEnvFile } from "node:process";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { generateDraft, readRequirements, openAIProvider } from "./generation.js";
import type { ModelProvider } from "./generation.js";
import { fixtureProvider, ollamaProvider } from "./local-providers.js";
import { groqProvider } from "./hosted-providers.js";

async function main() {
  // Local Node.js 22+ convenience: load .env from the project root if present.
  // Shell-provided variables retain precedence over variables in .env.
  if (existsSync(".env")) loadEnvFile(".env");
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      requirements: { type: "string" },
      "base-url": { type: "string", default: "http://127.0.0.1:3000" },
      output: { type: "string", default: "generated/draft.json" },
      model: { type: "string" },
      provider: { type: "string" },
      fixture: { type: "string", default: "examples/add-task.json" },
    },
  });
  if (positionals.length !== 1 || positionals[0] !== "generate") {
    throw new Error(
      "Usage: npm run generate -- generate [--requirements requirements.md] " +
      "[--base-url URL] [--output generated/draft.json] [--provider groq|openai|ollama|fixture] [--model MODEL]",
    );
  }
  const kind = values.provider;
  if (!kind) {
    throw new Error(
      "Please specify --provider fixture|ollama|groq|openai. " +
      "Cloud inference is never selected implicitly to avoid surprise charges.",
    );
  }
  let provider: ModelProvider;
  let model: string;
  switch (kind) {
    case "fixture":
      provider = fixtureProvider(values.fixture);
      model = "deterministic-fixture";
      break;
    case "ollama":
      provider = ollamaProvider;
      model = values.model ?? process.env.OLLAMA_MODEL ?? "qwen2.5-coder:3b";
      break;
    case "groq":
      provider = groqProvider;
      model = values.model ?? process.env.GROQ_MODEL ?? "openai/gpt-oss-20b";
      break;
    case "openai":
      provider = openAIProvider;
      model = values.model ?? process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
      break;
    default:
      throw new Error("Invalid --provider: choose groq, openai, ollama or fixture");
  }
  if (kind === "fixture") {
    console.log("FREE FIXTURE MODE: a prewritten test replaces AI output; no model is consulted.");
  } else if (kind === "ollama") {
    console.log(`LOCAL AI MODE: using Ollama model ${model} (no cloud API billing).`);
  } else if (kind === "groq") {
    console.log(`HOSTED AI MODE: using GroqCloud model ${model} (free tier subject to account limits).`);
  }
  const result = await generateDraft({
    baseURL: values["base-url"]!,
    requirements: await readRequirements(values.requirements),
    model,
  }, provider);
  const file = resolve(values.output!);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(result.definition, null, 2) + "\n");
  console.log(`Draft (NOT EXECUTED): ${file}`);
  console.log(`Test: ${result.definition.title}; ${result.definition.steps.length} steps`);
  console.log("Review/edit the draft and expected outcomes before running it.");
  console.log(`Then: npm run agent -- run ${file} --base-url ${values["base-url"]}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
