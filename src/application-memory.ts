import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestDefinition, RunReport } from "./domain.js";
import { websiteOrigin } from "./site-storage.js";

/**
 * Deliberately minimal, privacy-preserving app memory:
 * only one generic capability signal is retained, NEVER test step data,
 * credentials, form values, query strings, model responses or DOM snapshots.
 * No cross-origin sharing, and no AI-authored "facts" are persisted.
 */
export interface ApplicationMemory {
  schemaVersion: 1;
  siteOrigin: string;
  observations: {
    authenticationBeforeShopping: {
      successfulRuns: number;
      lastObservedAt: string;
    } | null;
  };
}
export interface MemorySuggestion {
  kind: "authentication-before-shopping";
  evidence: "successful-execution";
  successfulRuns: number;
  text: string;
}
const SHOPPING = /\b(basket|cart|checkout|products?|items?|shop|shopping|purchas(?:e|ing))\b/i;
const LOGIN = /\b(log\s?in|sign\s?in|authenticate|authentication)\b/i;
const PASSWORD = /\b(password|passcode)\b/i;
const fileName = (origin: string) =>
  createHash("sha256").update(origin).digest("hex") + ".json";
function memoryFile(dataDir: string, origin: string) {
  return join(dataDir, "application-memory", fileName(origin));
}
function describe(step: TestDefinition["steps"][number]) {
  // Check only semantic descriptions and operation names, NEVER fill values.
  const target = "target" in step.action ? step.action.target : undefined;
  const label = target
    ? ("value" in target ? target.value : ("name" in target ? target.name : "")) ?? ""
    : "";
  return step.description + " " + label;
}
function observesAuthBeforeShopping(definition: TestDefinition, report: RunReport): boolean {
  if (report.status !== "passed" ||
      report.steps.some(step => step.status !== "passed") ||
      report.steps.length !== definition.steps.length) return false;
  const actions = definition.steps.map(step => ({ action: step.action.kind, text: describe(step) }));
  const loginAt = actions.findIndex(item =>
    (item.action === "click" || item.action === "press") && LOGIN.test(item.text));
  const passwordBeforeLogin = actions.some((item, index) =>
    index < loginAt && item.action === "fill" && PASSWORD.test(item.text));
  // Require credible authentication completion plus subsequent shopping
  // activity in the SAME successful execution. This isn't proof that login
  // will always be necessary; it is only positive historical evidence.
  if (loginAt < 1 || !passwordBeforeLogin) return false;
  return actions.some((item, index) =>
    index > loginAt && SHOPPING.test(item.text) &&
    (item.action === "click" || item.action === "assert-visible" ||
      item.action === "assert-text" || item.action === "assert-count"));
}
function validMemory(data: unknown, origin: string): ApplicationMemory | null {
  if (!data || typeof data !== "object") return null;
  const value = data as ApplicationMemory;
  if (value.schemaVersion !== 1 || value.siteOrigin !== origin) return null;
  const observation = value.observations?.authenticationBeforeShopping;
  if (observation === null) return value;
  if (!observation || !Number.isInteger(observation.successfulRuns) ||
      observation.successfulRuns < 1 || observation.successfulRuns > 1_000_000 ||
      Number.isNaN(Date.parse(observation.lastObservedAt))) return null;
  return value;
}
export async function getApplicationMemory(dataDir: string, siteURL: string):
  Promise<ApplicationMemory | null> {
  const origin = websiteOrigin(siteURL);
  try {
    const input = JSON.parse(await readFile(memoryFile(dataDir, origin), "utf8"));
    return validMemory(input, origin);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    // Invalid/missing local knowledge must never block normal generation.
    return null;
  }
}
export async function observeSuccessfulRun(
  dataDir: string, siteURL: string, definition: TestDefinition, report: RunReport,
): Promise<boolean> {
  if (!observesAuthBeforeShopping(definition, report)) return false;
  const origin = websiteOrigin(siteURL);
  const previous = await getApplicationMemory(dataDir, origin);
  const last = previous?.observations.authenticationBeforeShopping;
  const data: ApplicationMemory = {
    schemaVersion: 1, siteOrigin: origin,
    observations: {
      authenticationBeforeShopping: {
        successfulRuns: Math.min(1_000_000, (last?.successfulRuns ?? 0) + 1),
        lastObservedAt: new Date().toISOString(),
      },
    },
  };
  await mkdir(join(dataDir, "application-memory"), { recursive: true });
  await writeFile(memoryFile(dataDir, origin), JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  return true;
}
export function getMemorySuggestions(
  memory: ApplicationMemory | null,
  instructions: string,
): MemorySuggestion[] {
  const observation = memory?.observations.authenticationBeforeShopping;
  if (!observation || !SHOPPING.test(instructions) || LOGIN.test(instructions)) return [];
  return [{
    kind: "authentication-before-shopping",
    evidence: "successful-execution",
    successfulRuns: observation.successfulRuns,
    text: "A previous passing shopping test for this website logged in first. Authentication may be a prerequisite. Review any proposed login steps before approving the test.",
  }];
}
