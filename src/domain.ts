import type { z } from "zod";
import type { testDefinitionSchema } from "./schema.js";

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
  status: RunStatus | "skipped";
  durationMs: number;
  expected?: string;
  observed?: string;
  error?: string;
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
