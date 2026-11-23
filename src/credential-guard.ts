import type { TestDefinition, TestStep } from "./domain.js";

/**
 * The model has no authority to provide authentication data. Generated login
 * values are replaced before a draft reaches the reviewer. Saved approved
 * tests must not retain these unresolved placeholders.
 *
 * This is intentionally a first, conservative iteration: public-demo
 * credential discovery and private environment-backed test data come later.
 */
export const USERNAME_REVIEW_PLACEHOLDER = "REPLACE_WITH_YOUR_USERNAME";
export const PASSWORD_REVIEW_PLACEHOLDER = "REPLACE_WITH_YOUR_PASSWORD";

type CredentialKind = "username" | "password";

function labelFor(step: TestStep): string {
  if (step.action.kind !== "fill") return "";
  const target = step.action.target;
  const label = "value" in target ? target.value
    : "name" in target ? target.name ?? ""
    : "";
  return label + " " + step.description;
}

function credentialKind(step: TestStep, loginFlow: boolean): CredentialKind | null {
  if (step.action.kind !== "fill") return null;
  const label = labelFor(step);
  // Never infer from the entered value: it can be a secret and should not be
  // inspected, compared with memory, or incorporated into diagnostics.
  if (/\b(pass[\s_-]?(?:word|code)|pwd|one[\s_-]?time[\s_-]?(?:password|code)|otp|verification[\s_-]?code|auth[\s_-]?token)\b/i.test(label)) {
    return "password";
  }
  if (/\b(user[\s_-]?name|login[\s_-]?(?:id|name)|account[\s_-]?name)\b/i.test(label)) {
    return "username";
  }
  // On known login flows, sites may label the login identifier "User" or
  // "Email", which should not be confused with arbitrary application data.
  if (loginFlow && /\b(user|email|email[\s_-]?address)\b/i.test(label)) {
    return "username";
  }
  return null;
}

function hasLoginFlow(definition: TestDefinition): boolean {
  return definition.steps.some(step =>
    /\b(log[\s_-]?in|sign[\s_-]?in|authenticate|authentication)\b/i.test(step.description) ||
    (step.action.kind === "fill" &&
      /\b(pass[\s_-]?word|pwd)\b/i.test(labelFor(step))));
}

/**
 * Mutates only the newly AI-authored definition/proposal, never an approved
 * saved test or the human's working edits. Does not persist original values.
 */
export function requireHumanCredentialValues(definition: TestDefinition): number {
  const loginFlow = hasLoginFlow(definition);
  let replaced = 0;
  for (const step of definition.steps) {
    if (step.action.kind !== "fill") continue;
    const kind = credentialKind(step, loginFlow);
    if (!kind) continue;
    const placeholder = kind === "password"
      ? PASSWORD_REVIEW_PLACEHOLDER : USERNAME_REVIEW_PLACEHOLDER;
    if (step.action.value !== placeholder) replaced++;
    step.action.value = placeholder;
  }
  return replaced;
}

export function unresolvedCredentialSteps(definition: TestDefinition): number[] {
  const loginFlow = hasLoginFlow(definition);
  return definition.steps.flatMap((step, index) => {
    if (step.action.kind !== "fill" || !credentialKind(step, loginFlow)) return [];
    const value = step.action.value.trim();
    // Also reject common untrusted model-authored placeholder variations.
    return !value || value === USERNAME_REVIEW_PLACEHOLDER ||
      value === PASSWORD_REVIEW_PLACEHOLDER ||
      /^(?:REPLACE_WITH_|YOUR_(?:USERNAME|PASSWORD)|ENTER_(?:USERNAME|PASSWORD)|<[^>]+>)$/i.test(value)
      ? [index + 1] : [];
  });
}

export function assertCredentialsReviewed(definition: TestDefinition): void {
  const unresolved = unresolvedCredentialSteps(definition);
  if (unresolved.length) {
    throw new Error("Credential values require tester review on step(s) " +
      unresolved.join(", ") +
      ". Edit the login fields with your approved test data before saving an executable script. " +
      "You may save a Working Draft without entering credentials.");
  }
}
