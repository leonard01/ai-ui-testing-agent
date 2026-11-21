export { runTest } from "./runner.js";
export type { RunOptions } from "./runner.js";
export { parseTestDefinition, testDefinitionSchema } from "./schema.js";
export type {
  BrowserController,
  ExpectationProvenance,
  SessionState,
  TestAction,
  TestDefinition,
  TestStep,
  RunReport,
  RunStatus,
  StepResult,
} from "./domain.js";

export { generateDraft, makeGenerationPrompt } from "./generation.js";
export type { DraftOptions, GeneratedDraft, ModelProvider } from "./generation.js";

export { generatePlaywrightSpec } from "./export.js";
export type { PlaywrightExportOptions } from "./export.js";

export { buildTraceabilityReport } from "./traceability.js";
export type { TraceabilityReport, TraceabilityRequirement, TraceabilityStatus } from "./traceability.js";
