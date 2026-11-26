import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createUsageStore} from "../../dist/ai-usage.js";

test("operation assessment survives store restart and does not overwrite validation",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"experiment-results-"));
 try {
  const store=createUsageStore(dir);
  await store.recordResult({operationId:"fixture",validation:"accepted",raw:"private test data"});
  await store.recordResult({operationId:"fixture",assessment:"correct"});
  const reopened=createUsageStore(dir);
  assert.deepEqual(await reopened.results(),[{operationId:"fixture",validation:"accepted",assessment:"correct"}]);
  await reopened.recordResult({operationId:"fixture",assessment:"incorrect"});
  assert.deepEqual(await store.results(),[{operationId:"fixture",validation:"accepted",assessment:"incorrect"}]);
  await reopened.recordResult({operationId:"fixture",assessment:"unreviewed"});
  assert.deepEqual(await reopened.results(),[{operationId:"fixture",validation:"accepted",assessment:"unreviewed"}]);
  assert.doesNotMatch(await readFile(join(dir,"operation-results.jsonl"),"utf8"),/private test data/);
 } finally {await rm(dir,{recursive:true,force:true});}
});
test("existing usage directories without assessment files remain readable",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"experiment-legacy-"));
 try {assert.deepEqual(await createUsageStore(dir).results(),[]);}
 finally {await rm(dir,{recursive:true,force:true});}
});
