/**
 * Narrow, review-only structural recovery for model-authored action targets.
 * Never apply to saved tests or discard unknown extra fields.
 */
export function normaliseMixedLocators(value: unknown, requirements = ""): {value: unknown; repairs: string[]} {
  const record = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  if (!record(value) || !Array.isArray(value.steps)) return {value, repairs: []};
  const repairs: string[] = [];
  const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter(w => !["the","a","an"].includes(w)) ?? [];
  const steps = value.steps.map((step: unknown, index: number) => {
    if (!record(step) || !record(step.action)) return step;
    const target = step.action.target;
    // A native textarea has the accessible role textbox. Recover only
    // fill drafts with known locator fields, preserving explicit position.
    if (step.action.kind === "fill" && record(target) && target.role === "textarea" &&
        ((target.by === "role" && Object.keys(target).every(k => ["by","role","name","nth"].includes(k))) ||
         (target.by === "intent" && Object.keys(target).every(k => ["by","role","value","rolePolicy"].includes(k))))) {
      repairs.push("textarea-role-alias:steps[" + index + "].action.target");
      return {...step, action:{...step.action, target:{...target, role:"textbox"}}};
    }
    if (step.action.kind !== "click") return step;
    // Only an exact, standalone role-neutral click instruction licenses
    // this narrow hint. Complex flows and explicit role wording stay strict.
    if (record(target) && target.by === "intent" && target.role === "button" &&
        Object.keys(target).length === 3 && typeof target.value === "string" &&
        /^[\p{L}\p{N}][\p{L}\p{N} _-]{0,79}$/u.test(target.value) &&
        !/\b(?:button|link|label|checkbox|radio|textbox|first|second|third|last)\b/i.test(target.value)) {
      const clean = (v: string) => v.trim().replace(/\s+/g, " ").toLowerCase();
      const instruction = clean(requirements).replace(/[.!]$/, "");
      if (instruction === "click " + clean(target.value) ||
          instruction === "click on " + clean(target.value)) {
        repairs.push("inferred-button-role-hint:steps[" + index + "].action.target");
        return {...step, action:{...step.action,target:{...target,rolePolicy:"hint"}}};
      }
    }
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
