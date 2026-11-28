import { randomUUID } from "node:crypto";
import type { Browser } from "playwright";
import { generateDraft, GeneratedDraftValidationError, type ModelProvider } from "./generation.js";
import { ensureAllowedNavigation } from "./inspect.js";
import { parseTestDefinition } from "./schema.js";
import { sourceRequirements, instructionCoverageProblems } from "./requirement-preservation.js";
import type { TestDefinition, TestStep } from "./domain.js";
import type { ResponseDiagnosticObserver } from "./response-diagnostics.js";

export interface IncrementalOptions {
  definition: TestDefinition;
  baseURL: string;
  stepId: string;
  mode: "step" | "from";
  instructions: string;
  approvedStepIds: string[];
  model: string;
  retryMalformedOutput?: boolean;
  observeResponse?: ResponseDiagnosticObserver;
}
export interface IncrementalProposal {
  definition: TestDefinition;
  replacement: TestStep[];
  fromIndex: number;
  removed: TestStep[];
  preservedApprovedStepIds: string[];
  generationAttempts: number;
  warnings: string[];
}

/** Bounded structural context, not a transcript of human-entered form values.
 * The tester can name relevant record data in the new instructions explicitly.
 * Never replay steps to discover state and never send old fill values or descriptions.
 */
function stepContext(step: TestStep) {
  const action = step.action;
  if (action.kind === "navigate") return {kind:action.kind};
  if (action.kind === "assert-url") return {kind:action.kind};
  const target = "target" in action ? action.target : undefined;
  // Technical locators can contain private values; only report their strategy.
  const safeTarget = target && ["id","testid","css","xpath"].includes(target.by)
    ? {by:target.by} : target;
  return {kind:action.kind,target:safeTarget,
    ...(action.kind === "press" ? {key:action.key} : {}),
    ...(action.kind === "fill" ? {value:"[previously entered value withheld]"} : {})};
}

function contextFor(prefix: TestStep[], removed: TestStep[], suffix: TestStep[]) {
  // Limit each section separately so a long prefix cannot erase the edit point.
  return JSON.stringify({
    precedingStepCount:prefix.length, preceding:prefix.slice(-12).map(stepContext),
    replacedStepCount:removed.length, replaced:removed.slice(0,5).map(stepContext),
    followingStepCount:suffix.length, following:suffix.slice(0,5).map(stepContext),
  }).slice(0,6500);
}

type Coverage = NonNullable<TestDefinition["instructionCoverage"]>;
function mergeCoverage(original: TestDefinition, fragment: TestDefinition, retained: Set<string>,
  ids: Map<string,string>, instructions: string): Coverage | undefined {
  const old = original.instructionCoverage;
  if (!old) return undefined;
  const source = old.source + "\n" + instructions.trim();
  const statements = sourceRequirements(source);
  const oldStatements = sourceRequirements(old.source);
  if (oldStatements.length !== old.entries.length ||
      oldStatements.some((s,i)=>old.entries[i].id!==s.id || old.entries[i].text!==s.text))
    throw new Error("Original instruction statements changed or are missing. Review the existing draft first.");
  const prior = old.entries.map(row=>{
    const missing = row.stepIds.filter(id=>!retained.has(id));
    if (!missing.length) return row;
    return {...row,stepIds:row.stepIds.filter(id=>retained.has(id)),confirmed:false,
      availability:"uncertain" as const,
      issue:("Previous mapping referenced replaced step ID(s): "+missing.join(", ")+
        ". Link the revised executable step(s) after review. "+row.issue).trim().slice(0,1000)};
  });
  // New instructions use the ordinary compact mapping format, independently
  // numbered by generation. Remap those IDs to the combined source in order.
  const fresh = sourceRequirements(instructions);
  const additions = fresh.map((row,i)=>{
    const proposed=fragment.instructionCoverage?.entries.find(entry=>entry.id===row.id);
    const links=[...new Set((proposed?.stepIds??[]).flatMap(id=>ids.has(id)?[ids.get(id)!]:[]))];
    const issue = !links.length
      ? ("New amendment requires explicit coverage review. "+(proposed?.issue??"")).trim().slice(0,1000)
      : proposed?.issue??"";
    return {id:statements[prior.length+i].id,text:row.text,interpretation:proposed?.interpretation??"",
      stepIds:links,confirmed:false,availability:links.length?(proposed?.availability??"uncertain" as const):"uncertain" as const,
      issue};
  });
  return {source,entries:[...prior,...additions],prerequisiteStepIds:old.prerequisiteStepIds.filter(id=>retained.has(id)),
    proceedAccepted:false};
}

/** Generate via the ordinary draft pipeline, then deterministically splice.
 * The original definition is never mutated or executed. The initial envelope
 * is discarded; all actual replacement actions remain visible for approval.
 */
export async function generateIncrementalProposal(options: IncrementalOptions, provider: ModelProvider,
  browser?: Browser): Promise<IncrementalProposal> {
  const original=parseTestDefinition(options.definition);
  const instructions=options.instructions.trim();
  if (!instructions || options.instructions.length>12000) throw new Error("Enter 1–12,000 characters of replacement step instructions");
  if (!options.model.trim()) throw new Error("Model is required");
  if (options.mode!=="step" && options.mode!=="from") throw new Error("Choose a supported regeneration mode");
  const index=original.steps.findIndex(step=>step.id===options.stepId);
  if (index<0) throw new Error("Selected step is not in the test");
  if (index===0) throw new Error("The initial navigation cannot be regenerated incrementally; regenerate the complete test instead");
  const base=new URL(options.baseURL);
  ensureAllowedNavigation(base.href,base);
  if (original.sourceUrl && new URL(original.sourceUrl).origin!==base.origin)
    throw new Error("Regeneration must stay within the original test website");
  for(const step of original.steps) {
    if(step.action.kind==="navigate") ensureAllowedNavigation(step.action.url,base);
    if(step.action.kind==="assert-url") ensureAllowedNavigation(step.action.expected,base);
  }
  const known=new Set(original.steps.map(step=>step.id));
  if(!Array.isArray(options.approvedStepIds) || options.approvedStepIds.some(id=>!known.has(id)))
    throw new Error("Approved step IDs must reference this test");
  const prefix=original.steps.slice(0,index);
  const removed=options.mode==="step"?[original.steps[index]]:original.steps.slice(index);
  const suffix=options.mode==="step"?original.steps.slice(index+1):[];
  const retainedSteps=[...prefix,...suffix];
  const retained=new Set(retainedSteps.map(step=>step.id));
  if(original.instructionCoverage) {
    const source=original.instructionCoverage.source+"\n"+instructions;
    if(source.length>12000) throw new Error("Combined instructions exceed 12,000 characters");
    sourceRequirements(source);
  }
  let generated;
  // Do not record acceptance until the complete combined definition validates.
  let accepted: Parameters<NonNullable<IncrementalOptions["observeResponse"]>> | undefined;
  try {
    generated=await generateDraft({
      baseURL:base.href,requirements:instructions,model:options.model,
      retryMalformedOutput:options.retryMalformedOutput,
      observeResponse:(attempt,event)=>{
        if(event.accepted) accepted=[attempt,event];
        else options.observeResponse?.(attempt,event);
      },
      instructionCoverage:!!original.instructionCoverage,
      continuation:{mode:options.mode,precedingContext:contextFor(prefix,removed,suffix),
        retainedStepCount:retainedSteps.length,retainedHasAssertion:retainedSteps.some(s=>s.action.kind.startsWith("assert-"))},
    },provider,browser);
  } catch(error) {
    if(error instanceof GeneratedDraftValidationError)
      throw new Error("The AI could not produce valid replacement test steps after "+error.attempts+
        " attempts. Your existing steps were not changed. Technical detail: "+error.problems.join("; "));
    throw error;
  }
  const fragment=generated.definition;
  const ids=new Map<string,string>();
  const replacement=fragment.steps.slice(1).map(step=>{
    let id:string;
    do {id="regen-"+randomUUID();} while(known.has(id));
    known.add(id); ids.set(step.id,id);
    return {...step,id};
  });
  const requirements=original.requirements?.map(row=>({...row,stepIds:row.stepIds.filter(id=>retained.has(id))}));
  const coverage=mergeCoverage(original,fragment,retained,ids,instructions);
  const definition=parseTestDefinition({...original,steps:[...prefix,...replacement,...suffix],
    ...(requirements?{requirements}:{}),
    ...(coverage?{instructionCoverage:coverage,sourceInstructions:original.sourceInstructions??original.instructionCoverage?.source,
      workingInstructions:coverage.source}:{})});
  const approved=new Set(options.approvedStepIds);
  const warnings=[
    "AI saw the initial application page, not the live state after preserved steps.",
    "Review all replacement actions and expectations before approving.",
  ];
  if(original.requirements?.some(row=>row.stepIds.some(id=>!retained.has(id))))
    warnings.push("Requirement links to replaced steps were cleared; remap coverage after review.");
  if(instructionCoverageProblems(definition).length)
    warnings.push("Instruction-to-step mappings need review or explicit acknowledgement before saving or running.");
  if(suffix.length) warnings.push("Later steps are unchanged but may depend on the replaced step; review dependencies.");
  if(accepted) options.observeResponse?.(...accepted);
  return {definition,replacement,fromIndex:index,removed,preservedApprovedStepIds:retainedSteps.filter(step=>approved.has(step.id)).map(step=>step.id),
    generationAttempts:generated.generationAttempts,warnings};
}
