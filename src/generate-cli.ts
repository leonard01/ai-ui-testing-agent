import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { generateDraft, readRequirements } from "./generation.js";

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      requirements: { type: "string" },
      "base-url": { type: "string", default: "http://127.0.0.1:3000" },
      output: { type: "string", default: "generated/draft.json" },
      model: { type: "string" },
    },
  });
  if (positionals.length !== 1 || positionals[0] !== "generate") {
    throw new Error(
      "Usage: npm run generate -- generate [--requirements requirements.md] " +
      "[--base-url URL] [--output generated/draft.json] [--model MODEL]",
    );
  }
  const result = await generateDraft({
    baseURL: values["base-url"]!,
    requirements: await readRequirements(values.requirements),
    model: values.model ?? process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
  });
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
