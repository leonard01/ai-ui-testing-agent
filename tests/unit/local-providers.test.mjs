import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fixtureProvider, ollamaProvider } from "../../dist/local-providers.js";

test("fixture provider reuses a saved case without cloud inference", async () => {
  const result = JSON.parse(await fixtureProvider("examples/add-task.json")({
    model: "fixture", system: "ignored", prompt: "ignored",
  }));
  assert.equal(result.steps.length, 9);
  assert.ok(result.steps.some((step) => step.action.kind.startsWith("assert-")));
  assert.ok(result.steps.every((step) =>
    !("provenance" in step.action) ||
    step.action.provenance !== "human-confirmed"
  ));
});

test("local Ollama provider uses only the fixed local endpoint and JSON mode", async () => {
  let url;
  let body;
  const mockedFetch = async (target, options) => {
    url = target;
    body = JSON.parse(String(options.body));
    return new Response(JSON.stringify({ response: '{"schemaVersion":1}', done: true }), {
      status: 200,
    });
  };
  const output = await ollamaProvider({
    model: "qwen2.5-coder:3b",
    system: "Generate tests",
    prompt: "Requirements",
  }, mockedFetch);
  assert.equal(url, "http://127.0.0.1:11434/api/generate");
  assert.equal(body.stream, false);
  assert.equal(body.format, "json");
  assert.equal(body.model, "qwen2.5-coder:3b");
  assert.equal(output, '{"schemaVersion":1}');
});

test("Ollama errors make the local dependency clear", async () => {
  await assert.rejects(() => ollamaProvider({
    model: "model", system: "system", prompt: "prompt",
  }, async () => { throw new Error("connection refused"); }), /Cannot connect to local Ollama/);
  await assert.rejects(() => ollamaProvider({
    model: "model", system: "system", prompt: "prompt",
  }, async () => new Response("missing model", { status: 404 })), /HTTP 404/);
});

test("generation CLI requires provider selection rather than making an implicit paid call", () => {
  const run = spawnSync(process.execPath, ["dist/generate-cli.js", "generate"], {
    encoding: "utf8",
    env: { ...process.env, OPENAI_API_KEY: "" },
  });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /Please specify --provider/);
});
