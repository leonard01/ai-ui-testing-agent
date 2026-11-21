import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseTestDefinition, runTest } from "../../dist/index.js";

const valid = JSON.parse(
  await readFile(
    new URL("../../examples/add-task.json", import.meta.url),
    "utf8",
  ),
);
test("accepts the complete example", () =>
  assert.equal(parseTestDefinition(valid).steps.length, 9));
test("rejects unsupported actions, missing provenance, extra fields and empty cases", () => {
  for (const mutate of [
    (c) => {
      c.steps[1].action.kind = "execute-code";
    },
    (c) => {
      delete c.steps[1].action.provenance;
    },
    (c) => {
      c.unexpected = true;
    },
    (c) => {
      c.steps = [];
    },
  ]) {
    const c = structuredClone(valid);
    mutate(c);
    assert.throws(() => parseTestDefinition(c));
  }
});
test("accepts intent targets and rejects unsupported or empty intent", () => {
  const draft = structuredClone(valid);
  draft.steps[2].action.target = { by: "intent", value: "Task", role: "textbox" };
  draft.steps[3].action.target = { by: "intent", value: "Add task", role: "button" };
  assert.equal(parseTestDefinition(draft).steps[2].action.target.by, "intent");
  draft.steps[3].action.target = { by: "intent", value: "", role: "button" };
  assert.throws(() => parseTestDefinition(draft));
  draft.steps[3].action.target = { by: "intent", value: "Add", role: "invalid" };
  assert.throws(() => parseTestDefinition(draft));
});
test("accepts expanded actions and strictly rejects unsafe keys, invalid counts, and intent counts", () => {
  const c = structuredClone(valid);
  const first = c.steps[0];
  const assertion = { id: "verify", description: "Verify", action: {
    kind: "assert-url", expected: "/receipt?ok=1", provenance: "requirements",
  } };
  const cases = [
    { kind: "select-option", target: { by: "role", role: "combobox", name: "Shipping" }, value: "fast" },
    { kind: "check", target: { by: "role", role: "checkbox", name: "Accept" } },
    { kind: "uncheck", target: { by: "role", role: "checkbox", name: "Accept" } },
    { kind: "check", target: { by: "role", role: "radio", name: "Option B" } },
    { kind: "press", target: { by: "role", role: "textbox", name: "Search" }, key: "Enter" },
    { kind: "assert-count", target: { by: "role", role: "button", name: "Duplicate" },
      expected: 0, provenance: "inferred" },
  ];
  for (const action of cases) {
    const d = { ...c, steps: [first, { id: "new", description: "New action", action }, assertion] };
    assert.equal(parseTestDefinition(d).steps[1].action.kind, action.kind);
  }
  for (const action of [
    { kind: "press", target: { by: "role", role: "textbox" }, key: "Control+Alt+Delete" },
    { kind: "assert-count", target: { by: "text", value: "Item" }, expected: -1, provenance: "requirements" },
    { kind: "assert-count", target: { by: "text", value: "Item" }, expected: 1.5, provenance: "requirements" },
    { kind: "assert-count", target: { by: "intent", value: "Item" }, expected: 1, provenance: "requirements" },
    { kind: "assert-url", expected: "/", provenance: "human-confirmed", surprise: true },
  ]) {
    assert.throws(() => parseTestDefinition({ ...c,
      steps: [first, { id: "bad", description: "Invalid", action }, assertion] }));
  }
});
test("rejects duplicate step IDs", () => {
  const c = structuredClone(valid);
  c.steps[1].id = c.steps[0].id;
  assert.throws(() => parseTestDefinition(c), /unique/);
});
test("requires an initial navigation and at least one assertion", () => {
  assert.throws(
    () => parseTestDefinition({ ...valid, steps: valid.steps.slice(1) }),
    /First step/,
  );
  assert.throws(
    () => parseTestDefinition({ ...valid, steps: [valid.steps[0]] }),
    /at least one assertion/,
  );
});
test("rejects malformed cases before browser launch and writes an error report", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-invalid-"));
  try {
    const report = await runTest(
      {},
      { baseURL: "http://127.0.0.1:3000", outputDir: dir },
    );
    assert.equal(report.status, "execution-error");
    assert.deepEqual(report.steps, []);
    assert.match(report.error, /Required/);
    assert.equal(
      JSON.parse(await readFile(join(dir, "report.json"), "utf8")).status,
      "execution-error",
    );
    await assert.rejects(stat(join(dir, "trace.zip")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("rejects cross-origin and non-HTTP navigation before browser launch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-origin-"));
  try {
    for (const url of [
      "https://example.org/",
      "javascript:alert(1)",
      "//example.org/",
    ]) {
      const c = structuredClone(valid);
      c.steps[0].action.url = url;
      const result = await runTest(c, {
        baseURL: "http://127.0.0.1:3000",
        outputDir: dir,
      });
      assert.equal(result.status, "execution-error");
      assert.match(result.error, /Navigation must stay/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("CLI returns exit 2 and a report for unreadable files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-cli-"));
  try {
    const result = spawnSync(
      process.execPath,
      ["dist/cli.js", "run", join(dir, "missing.json"), "--output", dir],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /execution-error/);
    assert.equal(
      JSON.parse(await readFile(join(dir, "report.json"), "utf8")).steps.length,
      0,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
