import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRun, writeMetadata, publishLatest } from "../../scripts/regression-history.mjs";

test("separate runs preserve evidence and replace only latest convenience copies", () => {
  const root = mkdtempSync(join(tmpdir(), "regression-history-"));
  try {
    const history = join(root,"history"), latest = join(root,"latest"), html = join(root,"html");
    const now = new Date("2026-11-27T05:42:00Z");
    const a = createRun(history,"standard",now), b = createRun(history,"standard",now);
    assert.notEqual(a.runId,b.runId);
    for (const [run, verdict] of [[a,"failed"],[b,"passed"]]) {
      writeMetadata(run.directory,{runId:run.runId,status:verdict});
      writeFileSync(join(run.directory,"junit.xml"),verdict);
      mkdirSync(join(run.directory,"regression-evidence"),{recursive:true});
      writeFileSync(join(run.directory,"regression-evidence","trace.txt"),verdict);
      mkdirSync(join(run.directory,"playwright-report"));
      writeFileSync(join(run.directory,"playwright-report","index.html"),verdict);
      publishLatest(run.directory,latest,html);
    }
    assert.equal(readFileSync(join(a.directory,"junit.xml"),"utf8"),"failed");
    assert.equal(readFileSync(join(a.directory,"regression-evidence","trace.txt"),"utf8"),"failed");
    assert.equal(readFileSync(join(a.directory,"playwright-report","index.html"),"utf8"),"failed");
    assert.equal(readFileSync(join(latest,"junit.xml"),"utf8"),"passed");
    assert.equal(JSON.parse(readFileSync(join(latest,"environment.json"),"utf8")).runId,b.runId);
    assert.equal(readFileSync(join(html,"index.html"),"utf8"),"passed");
    const c = createRun(history,"low-spec",now);
    writeMetadata(c.directory,{runId:c.runId,status:"failed"});
    mkdirSync(join(latest,"token-benchmarks"));
    publishLatest(c.directory,latest,html);
    assert.equal(existsSync(join(latest,"junit.xml")),false);
    assert.equal(existsSync(join(latest,"regression-evidence")),false);
    assert.equal(existsSync(html),false);
    assert.equal(existsSync(join(latest,"token-benchmarks")),true);
    assert.equal(readFileSync(join(b.directory,"junit.xml"),"utf8"),"passed");
  } finally { rmSync(root,{recursive:true,force:true}); }
});
