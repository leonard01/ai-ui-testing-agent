import { parseTestDefinition } from "./schema.js";

export type TraceabilityStatus =
  | "unmapped"
  | "steps-only"
  | "inferred-assertion"
  | "assertion-linked";

export interface TraceabilityRequirement {
  id: string;
  text: string;
  status: TraceabilityStatus;
  stepIds: string[];
  steps: Array<{
    id: string;
    description: string;
    kind: string;
  }>;
  assertions: Array<{
    stepId: string;
    description: string;
    kind: string;
    provenance: "requirements" | "human-confirmed" | "inferred";
  }>;
}

export interface TraceabilityReport {
  testId: string;
  title: string;
  reviewOnly: true;
  note: string;
  summary: {
    total: number;
    unmapped: number;
    stepsOnly: number;
    inferredAssertion: number;
    assertionLinked: number;
  };
  requirements: TraceabilityRequirement[];
  unlinkedAssertions: Array<{ stepId: string; description: string }>;
}

/**
 * This is a map of HUMAN-SELECTED requirement links, not AI-guessed semantic
 * coverage or a claim that the product satisfies its requirements.
 * Only an executed test report can establish passing or failing test outcomes.
 */
export function buildTraceabilityReport(input: unknown): TraceabilityReport {
  const definition = parseTestDefinition(input);
  const steps = new Map(definition.steps.map((step) => [step.id, step]));
  const requirements = (definition.requirements ?? []).map((requirement) => {
    const linkedSteps = requirement.stepIds.map((id) => steps.get(id)!);
    const assertions = linkedSteps.flatMap((step) =>
      step.action.kind === "assert-text" ||
      step.action.kind === "assert-visible" ||
      step.action.kind === "assert-url" ||
      step.action.kind === "assert-count"
        ? [{ stepId: step.id, description: step.description,
          kind: step.action.kind, provenance: step.action.provenance }] : []);
    const status: TraceabilityStatus = requirement.stepIds.length === 0
      ? "unmapped"
      : assertions.length === 0
        ? "steps-only"
        : assertions.every((assertion) => assertion.provenance === "inferred")
          ? "inferred-assertion"
          : "assertion-linked";
    return {
      id: requirement.id,
      text: requirement.text,
      status,
      stepIds: [...requirement.stepIds],
      steps: linkedSteps.map((step) => ({
        id: step.id, description: step.description, kind: step.action.kind,
      })),
      assertions,
    };
  });
  const linked = new Set(requirements.flatMap((item) => item.stepIds));
  return {
    testId: definition.id,
    title: definition.title,
    reviewOnly: true,
    note: "Mappings reflect human-selected trace links, not test execution, product conformance or automatically inferred coverage.",
    summary: {
      total: requirements.length,
      unmapped: requirements.filter((x) => x.status === "unmapped").length,
      stepsOnly: requirements.filter((x) => x.status === "steps-only").length,
      inferredAssertion: requirements.filter((x) => x.status === "inferred-assertion").length,
      assertionLinked: requirements.filter((x) => x.status === "assertion-linked").length,
    },
    requirements,
    unlinkedAssertions: definition.steps
      .filter((step) => step.action.kind.startsWith("assert-") && !linked.has(step.id))
      .map((step) => ({ stepId: step.id, description: step.description })),
  };
}
