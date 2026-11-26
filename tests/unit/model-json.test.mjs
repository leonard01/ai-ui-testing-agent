import { test } from "node:test";
import assert from "node:assert/strict";
import { parseModelJSON } from "../../dist/model-json.js";
import { requestGroq, isGroqJSONModeFailure } from "../../dist/hosted-providers.js";

test("valid JSON retains values and needs no repairs", () => {
  const sample = { steps: [{ id: "one", action: { value: "a,} [ and \"quotes\"" }}] };
  assert.deepEqual(parseModelJSON(JSON.stringify(sample)), { value: sample, repairs: [] });
});
test("recovers fenced JSON, trailing commas and unquoted keys without changing strings", () => {
  const raw = '```json\n{steps:[{"id":"one","value":"a,} [",},],}\n```';
  const result = parseModelJSON(raw);
  assert.deepEqual(result.value, { steps: [{ id: "one", value: "a,} [" }] });
  assert.deepEqual(new Set(result.repairs), new Set(["code-fence", "trailing-comma", "unquoted-key"]));
});
test("rejects duplicate keys, incomplete values, multiple objects and commentary", () => {
  for (const raw of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"a":1,a:2}',
    '{"steps":[{"id":"a"}', '{"a":}', '{"a":1} {"b":2}', 'Here: {"a":1}',
    '{"a":"unterminated}', '[{"a":1}]', '{"a":01}', '{"a":1e999}', '{"a":undefined}',
    '{"a":"x","b":', ' '.repeat(128001)]) {
    assert.throws(() => parseModelJSON(raw), SyntaxError);
  }
});
test("Groq response mode controls wire format and is recorded without extra HTTP retries", async () => {
  const old = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = "fixture-key";
  try {
    const requests = [], records = [];
    const req = { model: "fixture", system: "return JSON", prompt: "test" };
    const fetchMock = async (_url, options) => {
      requests.push(JSON.parse(options.body));
      if (requests.length === 1) return new Response(JSON.stringify({error:{code:"json_validate_failed",message:"Failed to generate valid JSON"}}),{status:400});
      return new Response(JSON.stringify({choices:[{message:{content:'{steps:[],}'}}],usage:{prompt_tokens:12,completion_tokens:8,total_tokens:20}}));
    };
    await assert.rejects(requestGroq(req, fetchMock, row => records.push(row)), isGroqJSONModeFailure);
    const text = await requestGroq({...req, responseMode:"text"}, fetchMock, row => records.push(row));
    assert.equal(text, '{steps:[],}');
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].response_format, {type:"json_object"});
    assert.equal(requests[1].response_format, undefined);
    assert.deepEqual(requests[0].messages, requests[1].messages);
    assert.equal(requests[0].max_completion_tokens, requests[1].max_completion_tokens);
    assert.deepEqual(records.map(r=>r.responseMode), ["json","text"]);
    assert.equal(records[0].totalTokens, undefined);
    assert.equal(records[1].totalTokens,20);
    assert.doesNotMatch(JSON.stringify(records), /fixture-key|return JSON/);
  } finally {
    if (old === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = old;
  }
});
