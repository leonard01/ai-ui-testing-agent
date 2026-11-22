import { z } from "zod";

const text = z.string().trim().min(1).max(2000);
const target = z.discriminatedUnion("by", [
  z
    .object({
      by: z.literal("role"),
      role: z.enum([
        "button",
        "textbox",
        "checkbox",
        "radio",
        "combobox",
        "heading",
        "status",
        "listitem",
      ]),
      name: text.optional(),
      // Explicit zero-based position among elements with this accessible
      // role/name. Only human-confirmed repairs should introduce this field.
      nth: z.number().int().min(0).max(249).optional(),
    })
    .strict(),
  z.object({ by: z.literal("label"), value: text }).strict(),
  z.object({ by: z.literal("placeholder"), value: text }).strict(),
  z.object({ by: z.literal("text"), value: text }).strict(),
  z.object({ by: z.literal("intent"), value: text, role: z.enum(["button", "textbox", "checkbox", "radio", "combobox", "heading", "status", "listitem"]).optional() }).strict(),
]);
// Count assertions require an explicit multi-match locator. Intent discovery
// intentionally resolves exactly one element, so it cannot express counts.
const countTarget = z.discriminatedUnion("by", [
  z.object({
    by: z.literal("role"),
    role: z.enum(["button", "textbox", "checkbox", "radio", "combobox", "heading", "status", "listitem"]),
    name: text.optional(),
  }).strict(),
  z.object({ by: z.literal("label"), value: text }).strict(),
  z.object({ by: z.literal("placeholder"), value: text }).strict(),
  z.object({ by: z.literal("text"), value: text }).strict(),
]);
const key = z.enum(["Enter", "Tab", "Escape", "Backspace", "Delete",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space",
  "Home", "End", "PageUp", "PageDown"]);
const provenance = z.enum(["requirements", "human-confirmed", "inferred"]);
// Traceability references are supplied explicitly by a human reviewer, never
// inferred from an AI-generated description or automatically treated as proof.
const requirement = z.object({
  id: z.string().trim().min(1).max(80),
  text: text,
  stepIds: z.array(z.string().trim().min(1).max(2000)).max(100),
}).strict();
const action = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("navigate"), url: text }).strict(),
  z.object({ kind: z.literal("click"), target }).strict(),
  z.object({ kind: z.literal("check"), target }).strict(),
  z.object({ kind: z.literal("uncheck"), target }).strict(),
  z.object({ kind: z.literal("select-option"), target, value: z.string().max(2000) }).strict(),
  z.object({ kind: z.literal("press"), target, key }).strict(),
  z
    .object({ kind: z.literal("fill"), target, value: z.string().max(10000) })
    .strict(),
  z
    .object({
      kind: z.literal("assert-text"),
      target,
      expected: z.string().max(10000),
      match: z.enum(["exact", "contains"]).optional(),
      provenance,
    })
    .strict(),
  z.object({ kind: z.literal("assert-visible"), target, provenance }).strict(),
  z.object({ kind: z.literal("assert-url"), expected: text, provenance }).strict(),
  z.object({ kind: z.literal("assert-count"), target: countTarget,
    expected: z.number().int().min(0).max(100000), provenance }).strict(),
]);

export const testStepSchema = z.object({ id: text, description: text, action }).strict();

export const testDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: text,
    title: text,
    version: z.number().int().positive(),
    // Captured by the review server at approval time, never AI-authored.
    // Legacy saved tests may omit it and remain "Unassigned".
    sourceUrl: z.string().max(2048).refine((value) => {
      try {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol) &&
          !url.username && !url.password;
      } catch { return false; }
    }, "sourceUrl must be an HTTP(S) URL without credentials").optional(),
    // Original user-provided instructions are preserved independently of generated steps.
    // Legacy scripts may omit these fields.
    sourceInstructions: z.string().max(12_000).optional(),
    workingInstructions: z.string().max(12_000).optional(),
    requirements: z.array(requirement).max(40).optional(),
    steps: z
      .array(testStepSchema)
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((definition, ctx) => {
    const seen = new Set<string>();
    definition.steps.forEach((step, index) => {
      if (seen.has(step.id))
        ctx.addIssue({
          code: "custom",
          path: ["steps", index, "id"],
          message: "Step IDs must be unique",
        });
      seen.add(step.id);
    });
    const seenRequirements = new Set<string>();
    for (const [index, entry] of (definition.requirements ?? []).entries()) {
      if (seenRequirements.has(entry.id)) {
        ctx.addIssue({
          code: "custom", path: ["requirements", index, "id"],
          message: "Requirement IDs must be unique",
        });
      }
      seenRequirements.add(entry.id);
      const linked = new Set<string>();
      for (const [linkIndex, stepId] of entry.stepIds.entries()) {
        if (linked.has(stepId) || !seen.has(stepId)) {
          ctx.addIssue({
            code: "custom", path: ["requirements", index, "stepIds", linkIndex],
            message: linked.has(stepId)
              ? "Requirement step links must be unique"
              : "Requirement links must reference an existing test step",
          });
        }
        linked.add(stepId);
      }
    }
    if (definition.steps[0]?.action.kind !== "navigate")
      ctx.addIssue({
        code: "custom",
        path: ["steps", 0],
        message: "First step must navigate to the application",
      });
    if (
      !definition.steps.some((step) => step.action.kind.startsWith("assert-"))
    )
      ctx.addIssue({
        code: "custom",
        path: ["steps"],
        message: "A test must contain at least one assertion",
      });
  });

export function parseTestDefinition(input: unknown) {
  return testDefinitionSchema.parse(input);
}
