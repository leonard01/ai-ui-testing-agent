import type { TestDefinition, TestStep } from "./domain.js";

// Deliberately bounded checks, not a general natural-language coverage oracle.
// Recognise explicit authentication commands rather than references to login
// in assertions, descriptions of page state, or arbitrary field values.
const AUTH = /\b(?:log[ -]?in|sign[ -]?in|authenticate)\b/i;
const NEGATIVE = /\b(?:do not|don't|never|without|no need to|must not|should not|skip)\s+(?:ever\s+)?(?:log[ -]?in|sign[ -]?in|authenticate|logging in|signing in|authentication)\b/i;
const POSITIVE = /(?:^|[\n.!?;]|\bthen\b|\band\b)\s*(?:\d+[.)]\s*)?(?:please\s+)?(?:log[ -]?in|sign[ -]?in|authenticate)\b/i;

function targetLabel(step: TestStep): string {
  if (!("target" in step.action)) return "";
  const target = step.action.target;
  return "value" in target ? target.value : target.name ?? "";
}
function isAuthenticationSubmit(step: TestStep): boolean {
  // Never accept a description claiming login on an unrelated click.
  return (step.action.kind === "click" && AUTH.test(targetLabel(step))) ||
    (step.action.kind === "press" && step.action.key === "Enter" &&
      /\b(?:password|passcode|pwd)\b/i.test(targetLabel(step)));
}
export function explicitAuthenticationIntent(instructions: string): "required" | "forbidden" | "conflict" | "unspecified" {
  const negative = NEGATIVE.test(instructions);
  const positive = POSITIVE.test(instructions);
  return positive && negative ? "conflict" : negative ? "forbidden" : positive ? "required" : "unspecified";
}
export function authenticationRequirementProblems(instructions: string, definition: TestDefinition): string[] {
  const intent = explicitAuthenticationIntent(instructions);
  const submit = definition.steps.findIndex(isAuthenticationSubmit);
  if (intent === "conflict") return ["Instructions contain conflicting login requirements. Clarify whether authentication is required."];
  if (intent === "required" && submit === -1) return ["Explicit login instruction is not represented by an identifiable executable login step. The initial page may not expose the login controls; clarify the workflow or regenerate. Do not replace it with an unrelated test."];
  if (intent === "forbidden" && submit !== -1) return ["The draft includes a login action despite an explicit instruction not to log in. Remove the conflicting action or clarify the instruction."];
  return [];
}
/** Mark identifiable authentication actions from a memory-assisted proposal.
 * This identifies suggestions, not proof that memory caused the model output. */
export function markSuggestedAuthentication(definition: TestDefinition): void {
  const submit = definition.steps.findIndex(isAuthenticationSubmit);
  if (submit < 0) return;
  for (const [index,step] of definition.steps.entries()) {
    if (index !== submit && !(index < submit && step.action.kind === "fill" &&
      /\b(?:user[ _-]?name|user|email|password|passcode|pwd|login[ _-]?id)\b/i.test(targetLabel(step)))) continue;
    if (!step.description.startsWith("[Suggested prerequisite] ")) {
      step.description = ("[Suggested prerequisite] " + step.description).slice(0,2000);
    }
  }
}
