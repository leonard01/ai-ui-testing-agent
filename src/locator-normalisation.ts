/**
 * Narrow, review-only structural recovery for model-authored click targets.
 * Never apply to saved tests or discard unknown extra fields.
 */
export function normaliseMixedLocators(value: unknown): {value: unknown; repairs: string[]} {
  const record = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  if (!record(value) || !Array.isArray(value.steps)) return {value, repairs: []};
  const repairs: string[] = [];
  const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter(w => !["the","a","an"].includes(w)) ?? [];
  const steps = value.steps.map((step: unknown, index: number) => {
    if (!record(step) || !record(step.action) || step.action.kind !== "click") return step;
    const target = step.action.target;
    if (!record(target) || target.by !== "role" || target.role !== "button" ||
        Object.keys(target).length !== 4 ||
        !Object.keys(target).every(k => ["by","role","name","intent"].includes(k)) ||
        typeof target.name !== "string" || typeof target.intent !== "string" ||
        !target.name.trim() || !target.intent.trim() ||
        target.name.length > 2000 || target.intent.length > 2000) return step;
    // Require the accessible name's significant words in order within the
    // intent. This is a conservative lexical compatibility check, not proof
    // of semantic equivalence. Human review and runtime resolution still apply.
    const name = words(target.name);
    const intent = words(target.intent);
    if (!name.length || !intent.length) return step;
    let cursor = 0;
    for (const word of intent) if (word === name[cursor]) cursor++;
    if (cursor !== name.length) return step;
    repairs.push("mixed-role-intent:steps[" + index + "].action.target");
    return {...step, action:{...step.action, target:{
      by:"intent", role:target.role, value:target.intent,
    }}};
  });
  return {value: repairs.length ? {...value,steps} : value, repairs};
}
