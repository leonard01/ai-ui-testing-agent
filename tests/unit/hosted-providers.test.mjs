import { test } from "node:test";
import assert from "node:assert/strict";
import { requestGroq } from "../../dist/hosted-providers.js";

const request = {
  model: "openai/gpt-oss-20b",
  system: "Generate only JSON",
  prompt: "Propose a test",
};

test("GroqCloud sends chat completion with JSON mode and returns content", async () => {
  const old = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = "gsk_test_fake_not_real";
  try {
    let endpoint;
    let headers;
    let body;
    const result = await requestGroq(request, async (url, init) => {
      endpoint = url;
      headers = init.headers;
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"schemaVersion":1}' } }],
      }), { status: 200 });
    });
    assert.equal(endpoint, "https://api.groq.com/openai/v1/chat/completions");
    assert.equal(headers.Authorization, "Bearer gsk_test_fake_not_real");
    assert.equal(body.model, "openai/gpt-oss-20b");
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.equal(body.messages[0].role, "system");
    assert.equal(body.messages[1].role, "user");
    assert.equal(body.stream, false);
    assert.equal(result, '{"schemaVersion":1}');
  } finally {
    if (old === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = old;
  }
});

test("GroqCloud fails before a network request when no key exists", async () => {
  const old = process.env.GROQ_API_KEY;
  const oldGrok = process.env.GROK_API_KEY;
  delete process.env.GROQ_API_KEY;
  delete process.env.GROK_API_KEY;
  try {
    await assert.rejects(
      requestGroq(request, async () => { throw new Error("should not fetch"); }),
      /GROQ_API_KEY is missing/,
    );
    process.env.GROK_API_KEY = "not-a-groq-key";
    await assert.rejects(
      requestGroq(request, async () => { throw new Error("should not fetch"); }),
      /GROK_API_KEY is not a GroqCloud setting/,
    );
  } finally {
    if (old === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = old;
    if (oldGrok === undefined) delete process.env.GROK_API_KEY;
    else process.env.GROK_API_KEY = oldGrok;
  }
});

test("GroqCloud gives actionable errors without leaking API credentials", async () => {
  const old = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = "gsk_test_fake_not_real";
  try {
    for (const [status, expected] of [
      [401, /Check GROQ_API_KEY/],
      [429, /rate\/token limit/],
      [400, /selected model/],
    ]) {
      await assert.rejects(
        requestGroq(request, async () => new Response("error", { status })),
        (error) => {
          assert.match(error.message, expected);
          assert.ok(!error.message.includes("gsk_test_fake_not_real"));
          return true;
        },
      );
    }
    await assert.rejects(
      requestGroq(request, async () => new Response("bad JSON", { status: 200 })),
      /unreadable response/,
    );
    await assert.rejects(
      requestGroq(request, async () => new Response(JSON.stringify({ choices: [] }))),
      /no generated JSON text/,
    );
  } finally {
    if (old === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = old;
  }
});
