import type { TestDefinition } from "./domain.js";

/**
 * Models sometimes describe typing a search query but emit only a Playwright
 * "press Enter" action. Pressing Enter does NOT type the query. For an
 * unambiguous quoted search phrase and an identifiable search input, insert
 * the missing fill step before submission. All steps still require human
 * review, and no ungrounded locator or typed value is invented.
 */
function quotedSearchTerm(requirements: string): string | null {
  const matches = [...requirements.matchAll(
    /\bsearch(?:\s+(?:on|for))?\s*['"“‘]([^'"”’\n]{1,200})['"”’]/gi,
  )].map(match => match[1].trim()).filter(Boolean);
  const unique = [...new Set(matches.map(term => term.toLocaleLowerCase()))];
  return unique.length === 1 ? matches[0] : null;
}

function searchInputTarget(target: Extract<TestDefinition["steps"][number]["action"], {kind:"press"}>["target"]): boolean {
  if (target.by === "role") {
    return (target.role === "textbox" || target.role === "combobox") &&
      /\b(?:search|query|find|keyword)\b/i.test(target.name ?? "");
  }
  if (target.by === "intent") {
    return (!target.role || target.role === "textbox" || target.role === "combobox") &&
      /\b(?:search|query|find|keyword)\b/i.test(target.value);
  }
  return (target.by === "placeholder" || target.by === "label") &&
    /\b(?:search|query|find|keyword)\b/i.test(target.value);
}

export function restoreMissingSearchFill(
  definition: TestDefinition,
  requirements: string,
): boolean {
  const query = quotedSearchTerm(requirements);
  if (!query) return false;
  const existingIds = new Set(definition.steps.map(step => step.id));
  for (let i = 1; i < definition.steps.length; i++) {
    const step = definition.steps[i];
    if (step.action.kind !== "press" ||
        step.action.key !== "Enter" ||
        !searchInputTarget(step.action.target)) continue;

    // A model may already have correctly populated the input in a previous
    // step, possibly using a different but equivalent locator strategy.
    const hasFill = definition.steps.slice(0, i).some(prior =>
      prior.action.kind === "fill" &&
      prior.action.value.trim().toLocaleLowerCase() === query.toLocaleLowerCase(),
    );
    if (hasFill) return false;
    if (definition.steps.length >= 100) return false;

    const baseId = step.id + "-fill";
    let id = baseId;
    for (let suffix = 2; existingIds.has(id); suffix++) {
      id = baseId + "-" + suffix;
    }
    const target = structuredClone(step.action.target);
    definition.steps.splice(i, 0, {
      id,
      description: "Enter " + JSON.stringify(query) + " into the search field",
      action: { kind: "fill", target, value: query },
    });
    return true;
  }
  return false;
}
