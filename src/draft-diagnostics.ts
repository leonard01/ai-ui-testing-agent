import type { TestDefinition } from "./domain.js";
import type { PageSnapshot } from "./inspect.js";

/** Advisory quality checks; never treat syntactic validity as requirement coverage. */
export function draftQualityWarnings(
  requirements: string,
  definition: TestDefinition,
  snapshot: PageSnapshot,
): string[] {
  const warnings: string[] = [];
  const observed = [
    snapshot.title, ...snapshot.headings, ...snapshot.statusText, ...snapshot.sampleText,
  ].join(" ");
  const errorPattern =
    /\b(?:something went wrong|access denied|internal server error|service unavailable|temporarily unavailable|technical difficulties|request blocked|verify you are human|captcha)\b/i;
  const inspection = snapshot.inspection;
  if (inspection?.mainDocumentStatus != null && inspection.mainDocumentStatus >= 400) {
    warnings.push("The inspected page returned HTTP " + inspection.mainDocumentStatus +
      ". The model may have seen an error page rather than the requested application.");
  }
  if (errorPattern.test(observed)) {
    warnings.push("The inspected page contains an error/block message. Check whether the intended controls loaded before approving this draft.");
  }
  if (inspection && inspection.blockedCrossOriginRequests > 0) {
    warnings.push("The safety-limited inspector blocked " +
      inspection.blockedCrossOriginRequests + " cross-origin resource request(s). " +
      "Some sites rely on those resources; this may affect what the model saw.");
  }
  if (inspection && inspection.pageErrors > 0) {
    warnings.push("The website raised " + inspection.pageErrors +
      " JavaScript exception(s) while loading. This does NOT mean a test step or selector has failed. " +
      "Open Generation diagnostics for the redacted error summary, then use Check selectors (read-only) " +
      "to inspect starting-page targets before approving.");
  }
  const normalizedSteps = JSON.stringify(definition.steps).toLowerCase().replace(/\s+/g, " ");
  const quoted = [...requirements.matchAll(/(['"])([^'"\n]{3,90})\1/g)]
    .map((match) => match[2].trim()).filter(Boolean);
  const missing = [...new Set(quoted)]
    .filter((phrase) => !normalizedSteps.includes(phrase.toLowerCase().replace(/\s+/g, " ")))
    .slice(0, 4);
  if (missing.length) {
    warnings.push("The generated steps do not mention quoted requirement value(s): " +
      missing.map((phrase) => JSON.stringify(phrase)).join(", ") +
      ". Check whether the model changed the test's purpose.");
  }
  for (const step of definition.steps) {
    if (step.action.kind !== "assert-text") continue;
    const expected = step.action.expected;
    if (step.action.provenance === "inferred" &&
        errorPattern.test(expected) &&
        !requirements.toLowerCase().includes(expected.toLowerCase())) {
      warnings.push("Step \"" + step.description.slice(0, 80) +
        "\" asserts an unexpected error message as success. This could create a false pass.");
      break;
    }
  }
  return warnings;
}
