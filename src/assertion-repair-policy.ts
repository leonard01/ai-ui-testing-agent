import type { TestDefinition, TestStep } from "./domain.js";

/** Conservative lexical guard for quick repair, not a natural-language proof. */
export function requiresExactText(definition: TestDefinition, step: TestStep): boolean {
  if (step.action.kind !== "assert-text") return false;
  const linked = (definition.requirements ?? []).filter(r => r.stepIds.includes(step.id)).map(r => r.text);
  const texts = [step.description, ...linked, definition.sourceInstructions ?? "", definition.workingInstructions ?? ""];
  return texts.some(text => /\b(?:exact(?:ly)?|equals?|equal\s+to|identical|verbatim|strict\s+equality|full\s+text)\b/i.test(text));
}
