import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveDraft, readDraft, deleteDraft, listDraftsWithDiagnostics, draftSchema } from "../../dist/draft-storage.js";

const base = () => ({
  draftVersion:1, baseURL:"https://example.test/path",
  definition:{schemaVersion:1,id:"example",title:"Example",version:1,
    sourceUrl:"https://example.test/old",
    steps:[
      {id:"open",description:"Open",action:{kind:"navigate",url:"/"}},
      {id:"check",description:"Check",action:{kind:"assert-visible",target:{by:"text",value:"Item"},provenance:"requirements"}},
    ]},
  sourceInstructions:"Original",workingInstructions:"Working",
  approvedStepIds:["open"],updatedAt:"2026-01-01T00:00:00.000Z",
});
async function isolated(fn) {
  const dir = await mkdtemp(join(tmpdir(),"draft-integrity-"));
  try { await fn(dir); } finally { await rm(dir,{recursive:true,force:true}); }
}
for(const [label,ids,valid] of [
  ["none",[],true],["partial",["open"],true],["all",["open","check"],true],
  ["duplicate",["open","open"],false],["unknown",["missing"],false],
  ["empty ID",[""],false],["non-string",[1],false],
]) {
  test("draft approvals: "+label,()=>{
    const input=base();input.approvedStepIds=ids;
    assert.equal(draftSchema.safeParse(input).success,valid);
  });
}
for(const [label,url,valid] of [
  ["same origin, different path","https://example.test/new",true],
  ["different scheme","http://example.test",false],
  ["different port","https://example.test:444",false],
  ["different host","https://other.example.test",false],
  ["embedded credentials","https://a:b@example.test",false],
  ["relative URL","/path",false],
]) {
  test("draft website: "+label,()=>{
    const input=base();input.baseURL=url;
    assert.equal(draftSchema.safeParse(input).success,valid);
  });
}
test("empty storage returns an empty list with no diagnostics",()=>isolated(async dir=>{
  assert.deepEqual(await listDraftsWithDiagnostics(dir),{drafts:[],skippedInvalid:0,skippedOverflow:0});
}));
test("repeated saves update the same draft without duplicating it",()=>isolated(async dir=>{
  const first=await saveDraft(dir,base());
  const edited=base();edited.workingInstructions="Amended";edited.approvedStepIds=["open","check"];
  edited.updatedAt="2026-01-02T00:00:00.000Z";
  const second=await saveDraft(dir,edited,first.id);
  assert.equal(second.id,first.id);
  assert.deepEqual(await readDraft(dir,first.id),edited);
  const result=await listDraftsWithDiagnostics(dir);
  assert.equal(result.drafts.length,1);
  assert.equal(result.drafts[0].approved,2);
}));
test("invalid update preserves the last valid draft",()=>isolated(async dir=>{
  const saved=await saveDraft(dir,base());
  const bad=base();bad.approvedStepIds=["missing"];
  await assert.rejects(saveDraft(dir,bad,saved.id),/distinct existing steps/);
  assert.deepEqual(await readDraft(dir,saved.id),base());
}));
test("draft listing sorts by most recently updated timestamp",()=>isolated(async dir=>{
  const first=await saveDraft(dir,base());
  const later=base();later.updatedAt="2026-01-03T00:00:00.000Z";
  const second=await saveDraft(dir,later);
  assert.deepEqual((await listDraftsWithDiagnostics(dir)).drafts.map(d=>d.id),[second.id,first.id]);
}));
test("corrupt draft is counted and does not hide healthy drafts",()=>isolated(async dir=>{
  const good=await saveDraft(dir,base());
  await writeFile(join(dir,"drafts","draft-00000000-0000-4000-8000-000000000001.json"),"{broken");
  await writeFile(join(dir,"drafts","unrelated.json"),"{}");
  const result=await listDraftsWithDiagnostics(dir);
  assert.deepEqual(result.drafts.map(d=>d.id),[good.id]);
  assert.equal(result.skippedInvalid,1);
  assert.equal(result.skippedOverflow,0);
}));
test("schema-invalid persisted draft is reported rather than silently indexed",()=>isolated(async dir=>{
  await mkdir(join(dir,"drafts"));
  await writeFile(join(dir,"drafts","draft-00000000-0000-4000-8000-000000000001.json"),JSON.stringify({draftVersion:99}));
  assert.deepEqual(await listDraftsWithDiagnostics(dir),{drafts:[],skippedInvalid:1,skippedOverflow:0});
}));
test("deleting one draft leaves other drafts intact",()=>isolated(async dir=>{
  const a=await saveDraft(dir,base()),b=await saveDraft(dir,base());
  await deleteDraft(dir,a.id);
  await assert.rejects(readDraft(dir,a.id),{code:"ENOENT"});
  assert.deepEqual(await readDraft(dir,b.id),base());
  assert.deepEqual((await listDraftsWithDiagnostics(dir)).drafts.map(d=>d.id),[b.id]);
}));
test("missing draft cannot be recreated by an update",()=>isolated(async dir=>{
  await assert.rejects(saveDraft(dir,base(),"draft-00000000-0000-4000-8000-000000000001.json"),{code:"ENOENT"});
  assert.equal((await listDraftsWithDiagnostics(dir)).drafts.length,0);
}));
test("invalid draft identifiers are rejected for read, write and delete",()=>isolated(async dir=>{
  for(const id of ["../outside.json","unrelated.json","draft-bad.json"]){
    await assert.rejects(readDraft(dir,id),/Invalid working draft ID/);
    await assert.rejects(saveDraft(dir,base(),id),/Invalid working draft ID/);
    await assert.rejects(deleteDraft(dir,id),/Invalid working draft ID/);
  }
}));
