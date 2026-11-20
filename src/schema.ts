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
        "heading",
        "status",
        "listitem",
      ]),
      name: text.optional(),
    })
    .strict(),
  z.object({ by: z.literal("label"), value: text }).strict(),
  z.object({ by: z.literal("text"), value: text }).strict(),
]);
const provenance = z.enum(["requirements", "human-confirmed", "inferred"]);
const action = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("navigate"), url: text }).strict(),
  z.object({ kind: z.literal("click"), target }).strict(),
  z
    .object({ kind: z.literal("fill"), target, value: z.string().max(10000) })
    .strict(),
  z
    .object({
      kind: z.literal("assert-text"),
      target,
      expected: z.string().max(10000),
      provenance,
    })
    .strict(),
  z.object({ kind: z.literal("assert-visible"), target, provenance }).strict(),
]);

export const testDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: text,
    title: text,
    version: z.number().int().positive(),
    steps: z
      .array(z.object({ id: text, description: text, action }).strict())
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
