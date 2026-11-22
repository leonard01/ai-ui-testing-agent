import { z } from "zod";
import { mkdir, readFile, readdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { testDefinitionSchema } from "./schema.js";
import { websiteOrigin, SAVED_NAME } from "./site-storage.js";

const instructions = z.string().max(12_000);
const safeURL = z.string().max(2048).refine(value => {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username && !url.password;
  } catch { return false; }
}, "Draft application URL must be HTTP(S) without credentials");

export const draftSchema = z.object({
  draftVersion: z.literal(1),
  definition: testDefinitionSchema,
  baseURL: safeURL,
  sourceInstructions: instructions.optional(),
  workingInstructions: instructions,
  approvedStepIds: z.array(z.string().min(1).max(2000)).max(100),
  sourceApprovedId: z.string().regex(SAVED_NAME).optional(),
  updatedAt: z.string().datetime(),
}).strict().superRefine((draft, ctx) => {
  const available = new Set(draft.definition.steps.map(step => step.id));
  const seen = new Set<string>();
  for (const [index, id] of draft.approvedStepIds.entries()) {
    if (!available.has(id) || seen.has(id)) ctx.addIssue({
      code: "custom", path: ["approvedStepIds", index],
      message: "Draft approvals must reference distinct existing steps",
    });
    seen.add(id);
  }
  if (draft.definition.sourceUrl &&
      websiteOrigin(draft.definition.sourceUrl) !== websiteOrigin(draft.baseURL)) {
    ctx.addIssue({ code: "custom", path: ["baseURL"], message: "Draft must stay on the original website" });
  }
});

export type SavedDraft = z.infer<typeof draftSchema>;
const DRAFT_ID = /^draft-[a-f0-9-]{36}\.json$/;

export async function saveDraft(
  savedDir: string, input: unknown, existingId?: string,
): Promise<{ id: string; draft: SavedDraft }> {
  const draft = draftSchema.parse(input);
  if (existingId !== undefined && !DRAFT_ID.test(existingId)) {
    throw new Error("Invalid working draft ID");
  }
  const id = existingId || "draft-" + randomUUID() + ".json";
  const directory = join(savedDir, "drafts");
  await mkdir(directory, { recursive: true });
  if (existingId) await readDraft(savedDir, id);
  await writeFile(join(directory, id), JSON.stringify(draft, null, 2) + "\n",
    existingId ? undefined : { flag: "wx" });
  return { id, draft };
}

export async function readDraft(savedDir: string, id: string): Promise<SavedDraft> {
  if (!DRAFT_ID.test(id)) throw new Error("Invalid working draft ID");
  return draftSchema.parse(JSON.parse(await readFile(join(savedDir, "drafts", id), "utf8")));
}

export async function listDrafts(savedDir: string) {
  let names: string[];
  try { names = await readdir(join(savedDir, "drafts")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const drafts: Array<{
    id: string; title: string; baseURL: string; siteUrl: string;
    steps: number; approved: number; updatedAt: string;
  }> = [];
  for (const id of names.filter(name => DRAFT_ID.test(name)).slice(0, 1000)) {
    try {
      const draft = await readDraft(savedDir, id);
      drafts.push({
        id, title: draft.definition.title, baseURL: draft.baseURL,
        siteUrl: websiteOrigin(draft.baseURL),
        steps: draft.definition.steps.length,
        approved: draft.approvedStepIds.length, updatedAt: draft.updatedAt,
      });
    } catch { /* Ignore invalid draft files without exposing file contents. */ }
  }
  return drafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function deleteDraft(savedDir: string, id: string) {
  await readDraft(savedDir, id);
  await unlink(join(savedDir, "drafts", id));
}
