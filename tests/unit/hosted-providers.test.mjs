import { test } from "node:test";
import assert from "node:assert/strict";
import { requestGroq, GroqProviderError } from "../../dist/hosted-providers.js";

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
      [400, /GroqCloud HTTP 400 \(bad-request\)/],
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

test("GroqCloud HTTP 400 surfaces safe JSON error category without leaking raw provider text", async () => {
  const old = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = "gsk_test_fake_not_real";
  try {
    for (const [code, category, hint] of [
      ["json_validate_failed", "json-generation", /acceptable JSON/],
      ["context_length_exceeded", "request-too-large", /context\/token limit/],
      ["model_not_found", "invalid-model", /model ID/],
    ]) {
      await assert.rejects(
        requestGroq(request, async () => new Response(JSON.stringify({
          error: {
            code, type: "invalid_request_error", param: "model",
            message: "Raw upstream details secret-data from user requirements gsk_test_fake_not_real",
          },
        }), { status: 400 })),
        (error) => {
          assert.ok(error instanceof GroqProviderError);
          assert.equal(error.source, "groqcloud");
          assert.equal(error.httpStatus, 400);
          assert.equal(error.providerCode, code);
          assert.equal(error.category, category);
          assert.match(error.message, hint);
          assert.ok(!error.message.includes("secret-data"));
          assert.ok(!error.message.includes("gsk_test_fake_not_real"));
          return true;
        },
      );
    }
    await assert.rejects(
      requestGroq(request, async () => new Response(JSON.stringify({
        error: { code: "unrecognized_400", type: "invalid_request_error", message: "secret-data" },
      }), { status: 400 })),
      (error) => {
        assert.equal(error.category, "bad-request");
        assert.match(error.message, /GroqCloud HTTP 400/);
        assert.ok(!error.message.includes("secret-data"));
        return true;
      },
    );
  } finally {
    if (old === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = old;
  }
});
