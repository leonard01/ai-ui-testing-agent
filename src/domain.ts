import type { z } from "zod";
import type { testDefinitionSchema } from "./schema.js";

import type { AmbiguousResolution, DiscoveryEvidence, MissingLocatorChoices, MissingAssertionChoices } from "./discovery.js";

export type TestDefinition = z.infer<typeof testDefinitionSchema>;
export type TestStep = TestDefinition["steps"][number];
export type TestAction = TestStep["action"];
export type ExpectationProvenance =
  | "requirements"
  | "human-confirmed"
  | "inferred";
export type RunStatus = "passed" | "assertion-failed" | "execution-error";
export interface StepResult {
  id: string;
  description: string;
  /** Action that produced this run step; enables reliable repair UI fallbacks. */
  actionKind?: TestAction["kind"];
  /** Advisory: this DOM assertion uses a page-root locator, not a named container. */
  domWideAssertion?: boolean;
  status: RunStatus | "skipped";
  durationMs: number;
  expected?: string;
  observed?: string;
  textMatch?: "exact" | "contains";
  error?: string;
  resolution?: DiscoveryEvidence;
  ambiguity?: AmbiguousResolution;
  locatorAlternatives?: MissingLocatorChoices;
  /** A unique submit button was found but an overlay blocked the click. */
  blockedClick?: {
    reason: "pointer-interception";
    /** Human approval is required before converting click to Enter. */
    submitWithEnter?: {
      sourceStepId: string;
      target: Extract<TestAction, { kind: "press" }>["target"];
    };
  };
  assertionAlternatives?: MissingAssertionChoices;
  assertionSearchAvailable?: boolean;
}
export interface RunReport {
  schemaVersion: 1;
  testId: string | null;
  title: string | null;
  status: RunStatus;
  startedAt: string;
  durationMs: number;
  steps: StepResult[];
  error?: string;
  artifacts: { screenshot?: string; trace?: string };
  evidenceErrors: string[];
}

export type BrowserController = "human" | "ai";

export interface SessionState {
  sessionId: string;
  owner: BrowserController;
  status: "running" | "paused" | "stopped";
  activeStepId?: string;
}
