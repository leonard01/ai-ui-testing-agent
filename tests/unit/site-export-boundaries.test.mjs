import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { websiteOrigin, websiteFolder, websiteDirectory, listSavedFiles, findSavedFile } from "../../dist/site-storage.js";
import { generatePlaywrightSpec } from "../../dist/export.js";

const site="https://example.test";
test("website identity normalizes casing, default ports, paths and queries",()=>{
  assert.equal(websiteOrigin("https://EXAMPLE.test:443/path?q=private#fragment"),site);
  assert.equal(websiteFolder(site),websiteFolder(site+"/other?x=1"));
});
test("website directories distinguish schemes, non-default ports and lookalike hosts",()=>{
  const urls=[site,"http://example.test",site+":444","https://example-test","https://example.test.evil.test"];
  assert.equal(new Set(urls.map(websiteFolder)).size,urls.length);
});
test("website directory is path safe and does not include query data",()=>{
  const folder=websiteFolder("https://[::1]:8443/../../path?token=secret");
  assert.match(folder,/^https__[a-z0-9._-]+__[a-f0-9]{10}$/);
  assert.ok(!folder.includes("secret"));
});
for(const url of ["file:///tmp/file","ftp://example.test","https://user:pass@example.test","/relative"]){
  test("website storage rejects "+url,()=>assert.throws(()=>websiteFolder(url)));
}
test("saved file discovery ignores unrelated and nested files and locates legacy and site scripts",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"site-discovery-"));
  try{
    const legacy="reviewed-1700000000000-deadbeef.json";
    const current="reviewed-1700000000001-12345678.json";
    const folder=websiteDirectory(dir,site);
    await mkdir(folder,{recursive:true});
    await mkdir(join(folder,"nested"),{recursive:true});
    await mkdir(join(dir,"sites","unrecognized"),{recursive:true});
    await writeFile(join(dir,legacy),"{}");
    await writeFile(join(folder,current),"{}");
    await writeFile(join(folder,"unrelated.json"),"{}");
    await writeFile(join(folder,"nested",legacy),"{}");
    await writeFile(join(dir,"sites","unrecognized",legacy),"{}");
    assert.deepEqual((await listSavedFiles(dir)).map(x=>x.id),[current,legacy]);
    assert.equal(await findSavedFile(dir,current),join(folder,current));
    assert.equal(await findSavedFile(dir,legacy),join(dir,legacy));
    await assert.rejects(findSavedFile(dir,"../outside.json"),/Invalid approved test filename/);
    await assert.rejects(findSavedFile(dir,"reviewed-1700000000002-deadbeef.json"),/not found/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test("missing storage directory yields an empty catalog",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"site-empty-"));
  try{assert.deepEqual(await listSavedFiles(join(dir,"missing")),[]);}
  finally{await rm(dir,{recursive:true,force:true});}
});

const definition=()=>({schemaVersion:1,id:"export",title:"Export boundary",version:1,steps:[
  {id:"open",description:"Open",action:{kind:"navigate",url:"/"}},
  {id:"check",description:"Check",action:{kind:"assert-count",target:{by:"text",value:"Item"},expected:0,provenance:"requirements"}},
]});
for(const timeoutMs of [100,60000]){
  test("export accepts timeout boundary "+timeoutMs,()=>{
    const source=generatePlaywrightSpec(definition(),{baseURL:site,timeoutMs});
    assert.ok(source.includes("const STEP_TIMEOUT = "+timeoutMs+";"));
  });
}
for(const timeoutMs of [99,60001,100.5,NaN,Infinity]){
  test("export rejects invalid timeout "+timeoutMs,()=>{
    assert.throws(()=>generatePlaywrightSpec(definition(),{baseURL:site,timeoutMs}),/timeout/);
  });
}
test("export retains the source definition without modifying user data",()=>{
  const input=definition();
  const before=structuredClone(input);
  const first=generatePlaywrightSpec(input,{baseURL:site});
  const second=generatePlaywrightSpec(input,{baseURL:site});
  assert.equal(first,second);
  assert.deepEqual(input,before);
});
