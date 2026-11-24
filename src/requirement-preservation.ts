import { z } from "zod";
import type { TestDefinition } from "./domain.js";

// Keep the tester's exact text independent of any model interpretation.
// Splitting is deliberately syntax-only; compound requirements remain visible
// in their original wording and must be reviewed as a whole.
export function sourceRequirements(instructions: string) {
  const lines = instructions.split(/\r?\n/).flatMap(line =>
    line.trim().split(/(?<!\d\.)(?<=[.!?])\s+(?=[A-Z])/).map(text => text.trim()).filter(Boolean));
  if (lines.length > 40 || lines.some(line => line.length > 12000)) {
    throw new Error("Too many instruction statements. Split the test into smaller workflows.");
  }
  return lines.map((text,index) => ({id:"R"+(index+1),text}));
}
const proposalSchema = z.object({
  entries: z.array(z.object({
    id:z.string(),
    interpretation:z.string().max(2000),
    stepIds:z.array(z.string()).max(100),
    issue:z.string().max(1000).optional(),
    availability:z.enum(["identified","later-state","selector-uncertain","functional-mismatch","uncertain"]).optional(),
  }).strict()).max(40),
  prerequisiteStepIds:z.array(z.string()).max(100).optional(),
}).strict();

export function proposedCoverage(instructions:string, definition:TestDefinition, proposal:unknown, hasMemoryHints:boolean) {
  const source=sourceRequirements(instructions);
  const parsed=proposalSchema.safeParse(proposal);
  const entries=parsed.success ? parsed.data.entries : [];
  const steps=new Set(definition.steps.map(step=>step.id));
  const ids=new Set(source.map(entry=>entry.id));
  const malformed=entries.some(entry=>!ids.has(entry.id));
  const result=source.map(row=>{
    const matches=entries.filter(entry=>entry.id===row.id);
    const entry=matches[0];
    const valid=!!entry && matches.length===1 && !malformed &&
      entry.stepIds.length>0 && new Set(entry.stepIds).size===entry.stepIds.length &&
      entry.stepIds.every(id=>steps.has(id));
    return {...row,interpretation:entry?.interpretation||"",
      stepIds:valid?entry.stepIds:[],
      issue:entry?.issue?.trim() || (entry?.availability==="functional-mismatch"?"Requested functionality could not be confidently identified.":valid?"":"No valid proposed step mapping. Review or regenerate."),
      availability:entry?.availability ?? "uncertain",
      confirmed:false};
  });
  // A memory hint is advisory. Label only valid, unmapped prerequisite IDs
  // proposed by the model, never a step claimed to fulfill an explicit request.
  const linked=new Set(result.flatMap(entry=>entry.stepIds));
  const prerequisiteStepIds=hasMemoryHints && parsed.success
    ? [...new Set(parsed.data.prerequisiteStepIds??[])].filter(id=>steps.has(id)&&!linked.has(id))
    : [];
  for(const step of definition.steps) {
    if(prerequisiteStepIds.includes(step.id))
      step.description=("[Suggested prerequisite] "+step.description).slice(0,2000);
  }
  return {source:instructions,entries:result,prerequisiteStepIds};
}

export function instructionCoverageProblems(definition:TestDefinition):string[] {
  const coverage=definition.instructionCoverage;
  if(!coverage) return []; // legacy/manual/fixture scripts have no generated coverage metadata
  const original=sourceRequirements(coverage.source);
  const available=new Set(definition.steps.map(step=>step.id));
  if(coverage.entries.length!==original.length ||
      original.some((row,index)=>coverage.entries[index]?.id!==row.id || coverage.entries[index]?.text!==row.text))
    return ["Original instruction statements changed or are missing. Regenerate from the intended instructions."];
  return coverage.entries.flatMap(row=>
    (!coverage.proceedAccepted && (row.availability === "functional-mismatch" || (row.issue && row.availability !== "later-state" && row.availability !== "selector-uncertain"))) || !row.stepIds.length || new Set(row.stepIds).size!==row.stepIds.length ||
      row.stepIds.some(id=>!available.has(id))
      ? [row.id+": "+(row.issue||"No valid executable step mapping.")] : []);
}
export function assertInstructionCoverageReviewed(definition:TestDefinition):void {
  const problems=instructionCoverageProblems(definition);
  if(problems.length) throw new Error("Unresolved instruction coverage: "+problems.join("; "));
}

/** Only likely functional mismatches or missing coverage interrupt generation.
 * Locator uncertainty and later-state controls are handled by ordinary review.
 */
export function generationExceptions(definition:TestDefinition) {
  const coverage=definition.instructionCoverage;
  if(!coverage) return [];
  return coverage.entries.filter(row=>!row.stepIds.length ||
    row.availability==="functional-mismatch" || (row.issue && row.availability!=="later-state" && row.availability!=="selector-uncertain"));
}

/** Reconcile only requirements affected by the editing range. Unaffected
 * statements and mappings are copied from the previous revision, not rewritten
 * by the model. Proposed semantic coverage still requires ordinary draft review.
 */
export function reconcileAmendment(
  previous: NonNullable<TestDefinition["instructionCoverage"]>,
  amendment: string,
  retainedIds: Set<string>,
  definition: TestDefinition,
  proposal: unknown,
) {
  const schema = z.object({
    changes: z.array(z.object({
      id: z.string(),
      operation: z.enum(["keep","replace","remove"]),
      text: z.string().min(1).max(12000).optional(),
      evidence: z.string().min(1).optional(),
    }).strict()).max(40),
    additions: z.array(z.string().min(1).max(12000)).max(40),
    coverage: proposalSchema,
  }).strict();
  const parsed = schema.parse(proposal);
  const changes = new Map(parsed.changes.map(change => [change.id, change]));
  if (changes.size !== parsed.changes.length ||
      [...changes.keys()].some(id => !previous.entries.some(row => row.id === id))) {
    throw new Error("Invalid amendment requirement IDs");
  }
  const rows: {text:string; old?:typeof previous.entries[number]}[] = [];
  for (const old of previous.entries) {
    const change = changes.get(old.id);
    const affected = old.stepIds.some(id => !retainedIds.has(id));
    if (change && change.operation !== "keep") {
      if (!affected || !change.evidence || !amendment.includes(change.evidence)) {
        throw new Error("An amendment cannot silently change an unrelated requirement: " + old.id);
      }
      if (change.operation === "replace") {
        if (!change.text) throw new Error("Replacement requirement text is missing");
        rows.push({text:change.text});
      }
    } else {
      rows.push({text:old.text, old:affected ? undefined : old});
    }
  }
  for (const text of parsed.additions) rows.push({text});
  const source = rows.map(row=>row.text).join("\n");
  if (!source || source.length > 12000 || sourceRequirements(source).length !== rows.length) {
    throw new Error("Reconciled instructions must contain one statement per row");
  }
  const coverage: NonNullable<TestDefinition["instructionCoverage"]> = proposedCoverage(source, definition, parsed.coverage, false);
  coverage.entries = coverage.entries.map((entry,index) => {
    const old = rows[index].old;
    return old ? {...old,id:entry.id} : entry;
  });
  const linked = new Set(coverage.entries.flatMap(row=>row.stepIds));
  coverage.prerequisiteStepIds = previous.prerequisiteStepIds.filter(id=>retainedIds.has(id)&&!linked.has(id));
  return coverage;
}
