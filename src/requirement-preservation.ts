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
      issue:entry?.issue?.trim() || (valid?"":"No valid proposed step mapping. Review or regenerate."),
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
    row.issue || !row.stepIds.length || new Set(row.stepIds).size!==row.stepIds.length ||
      row.stepIds.some(id=>!available.has(id)) || !row.confirmed
      ? [row.id+": "+(row.issue||"Review and confirm valid step coverage.")] : []);
}
export function assertInstructionCoverageReviewed(definition:TestDefinition):void {
  const problems=instructionCoverageProblems(definition);
  if(problems.length) throw new Error("Unresolved instruction coverage: "+problems.join("; "));
}
