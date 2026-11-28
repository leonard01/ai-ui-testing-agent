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

/** Translate the compact wire contract to the existing review contract.
 * Only actual steps can contribute links; never infer a missing action.
 * Legacy model responses remain reviewable during the transition.
 */
export function decodeEmbeddedCoverage(candidate: Record<string, unknown>, instructions: string) {
  const {coverage, requirementNotes, ...definition} = candidate;
  if (!Array.isArray(definition.steps)) return {candidate: definition, proposal: coverage};
  const embedded = definition.steps.some(step => step && typeof step === "object" && "requirementIds" in step)
    || requirementNotes !== undefined;
  if (!embedded) return {candidate: definition, proposal: coverage};
  const source = sourceRequirements(instructions);
  const known = new Set(source.map(row => row.id));
  const links = new Map<string, string[]>();
  const problems: string[] = [];
  const prerequisites: string[] = [];
  const steps = definition.steps.map(step => {
    if (!step || typeof step !== "object" || Array.isArray(step)) return step;
    const {requirementIds, memoryPrerequisite, ...actionStep} = step as Record<string, unknown>;
    if (!Array.isArray(requirementIds) || requirementIds.some(id => typeof id !== "string")) {
      problems.push("Missing or invalid step requirement IDs.");
    } else if (typeof actionStep.id === "string") {
      if (new Set(requirementIds).size !== requirementIds.length) problems.push("Duplicate requirement IDs on a step.");
      for (const id of new Set<string>(requirementIds)) {
        if (!known.has(id)) problems.push("Unknown requirement ID on a step.");
        else links.set(id, [...(links.get(id) ?? []), actionStep.id]);
      }
      if (memoryPrerequisite === true && !requirementIds.length) prerequisites.push(actionStep.id);
      else if (memoryPrerequisite !== undefined && (memoryPrerequisite !== true || requirementIds.length)) problems.push("Invalid memory prerequisite marker.");
    }
    return actionStep;
  });
  const notesSchema = z.array(z.object({id:z.string(), issue:z.string().max(1000).optional(),
    availability:z.enum(["identified","later-state","selector-uncertain","functional-mismatch","uncertain"]).optional()}).strict()).max(40);
  const notes = notesSchema.safeParse(requirementNotes ?? []);
  const noteMap = new Map<string, {issue?:string; availability?: "identified"|"later-state"|"selector-uncertain"|"functional-mismatch"|"uncertain"}>();
  if (!notes.success) problems.push("Invalid requirement notes.");
  else for (const note of notes.data) {
    if (!known.has(note.id) || noteMap.has(note.id)) problems.push("Unknown or duplicate requirement note ID.");
    else noteMap.set(note.id,note);
  }
  if (coverage !== undefined) problems.push("Mixed embedded and legacy mapping formats.");
  const issue = [...new Set(problems)].join(" ");
  return {candidate:{...definition,steps}, proposal:{
    entries:source.map(row => {
      const note=noteMap.get(row.id);
      return {id:row.id, interpretation:"", stepIds:links.get(row.id) ?? [],
        issue:issue ? (issue+" "+(note?.issue ?? "")).trim().slice(0,1000) : note?.issue,
        availability:issue ? "uncertain" : note?.availability ?? "uncertain"};
    }), prerequisiteStepIds:prerequisites
  }};
}

export function proposedCoverage(instructions:string, definition:TestDefinition, proposal:unknown, hasMemoryHints:boolean) {
  const source=sourceRequirements(instructions);
  const parsed=proposalSchema.safeParse(proposal);
  const entries=parsed.success ? parsed.data.entries : [];
  const steps=new Set(definition.steps.map(step=>step.id));
  const ids=new Set(source.map(entry=>entry.id));
  const unknownRequirementIds=[...new Set(entries.filter(entry=>!ids.has(entry.id)).map(entry=>entry.id))];
  const summarizeIds=(values:string[])=>values.slice(0,5).map(id=>id.slice(0,80)).join(", ")+(values.length>5?", …":"");
  const result=source.map(row=>{
    const matches=entries.filter(entry=>entry.id===row.id);
    const entry=matches[0];
    const reasons:string[]=[];
    if(!parsed.success) {
      if(proposal===undefined || proposal===null) {
        reasons.push("The AI did not return requirement mapping data.");
      } else {
        const fields=parsed.error.issues.slice(0,3).map(issue=>issue.path.join(".")||"mapping").join(", ");
        reasons.push("The AI returned an unsupported mapping structure ("+fields.slice(0,180)+").");
      }
    } else {
      if(unknownRequirementIds.length) reasons.push("The AI referenced unknown requirement IDs: "+summarizeIds(unknownRequirementIds)+".");
      if(!entry) reasons.push("The AI did not return a mapping for this requirement.");
      if(matches.length>1) reasons.push("The AI returned multiple mappings for this requirement.");
      if(entry) {
        if(!entry.stepIds.length) reasons.push("The AI did not associate any executable steps with this requirement.");
        if(new Set(entry.stepIds).size!==entry.stepIds.length) reasons.push("The AI referenced the same executable step more than once.");
        const missing=[...new Set(entry.stepIds.filter(id=>!steps.has(id)))];
        if(missing.length) reasons.push("The AI referenced step IDs not present in the current draft: "+summarizeIds(missing)+".");
      }
    }
    const valid=reasons.length===0 && !!entry;
    const explanation=entry?.issue?.trim() || (entry?.availability==="functional-mismatch"?"Requested functionality could not be confidently identified.":"");
    const issue=valid ? explanation : (reasons.join(" ")+" This is a mapping failure; it does not establish whether the draft fulfils the requirement. Review the actual actions and assertions, then confirm the appropriate steps or regenerate."+(explanation?" AI note: "+explanation:""));
    return {...row,interpretation:entry?.interpretation||"",
      stepIds:[...new Set(matches.flatMap(match=>match.stepIds))].filter(id=>steps.has(id)),
      issue:issue.slice(0,1000),
      availability:valid ? (entry?.availability ?? "uncertain") : "uncertain",
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
  // Acknowledgement allows incomplete coverage, never corrupt references or lost source text.
  return coverage.entries.flatMap(row=>
    new Set(row.stepIds).size!==row.stepIds.length || row.stepIds.some(id=>!available.has(id)) ||
    (!coverage.proceedAccepted && coverageWarnings(definition).some(w=>w.id===row.id))
      ? [row.id+": "+(row.issue||"No valid executable step mapping.")] : []);
}
export function assertInstructionCoverageReviewed(definition:TestDefinition):void {
  const problems=instructionCoverageProblems(definition);
  if(problems.length) throw new Error("Unresolved instruction coverage: "+problems.join("; "));
}

/** Coverage warnings remain visible even after explicit acknowledgement. */
export function coverageWarnings(definition:TestDefinition) {
  const coverage=definition.instructionCoverage;
  if(!coverage) return [];
  const available = new Set(definition.steps.map(step=>step.id));
  return coverage.entries.filter(row=>!row.stepIds.length ||
    new Set(row.stepIds).size!==row.stepIds.length || row.stepIds.some(id=>!available.has(id)) ||
    row.availability==="functional-mismatch" || (row.issue && row.availability!=="later-state" && row.availability!=="selector-uncertain"));
}
// Retained for diagnostics and existing callers; both draft paths now review warnings in the editor.
export const generationExceptions = coverageWarnings;

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
