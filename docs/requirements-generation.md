# Requirements-to-test generation (first AI milestone)

This feature generates **review-only JSON test drafts** using Markdown/plain-text acceptance criteria and a bounded live webpage snapshot. It supports four explicit providers. The hosted GroqCloud option uses your free-tier allowance without running an AI model locally:

| Provider | Uses a real AI model? | OpenAI API credits? | Requirements |
| --- | --- | --- | --- |
| `fixture` | No; replays a prewritten JSON definition | **No** | Project and Chromium only |
| `ollama` | **Yes; local model on your computer** | **No** | Ollama installed and a model downloaded; adequate RAM/CPU/GPU |
| `groq` | **Yes; hosted on GroqCloud** | **No OpenAI credits**; Groq free-tier usage limits apply | Valid `GROQ_API_KEY` and internet access; default `openai/gpt-oss-20b` |
| `openai` | Yes; hosted model | Yes, billed by usage | Valid `OPENAI_API_KEY` with available API credits |

All four share the same page inspector, strict Zod schema validation, draft output file and deterministic runner. The provider only changes **where the draft comes from**.

## Setup (all modes)

Requirements: Node.js 22+, npm and Chromium.

```bash
npm ci
npx playwright install chromium
npm run build
```

Start the local task-list demo in terminal 1:

```bash
npm run demo
```

Leave it running. Use a second terminal for generation and test execution.

## Mode 1: FREE fixture mode — test the entire pipeline

```bash
npm run generate -- generate --provider fixture \
  --requirements examples/requirements-task-list.md \
  --output generated/fixture-draft.json

# Review the draft, then execute it:
npm run agent -- run generated/fixture-draft.json --headed
```

This uses `examples/add-task.json` as the **prewritten model response**; it does *not* synthesize new steps from the input requirements or call any AI service. It checks the inspector, generation CLI, schema/provenance validation, draft-writing and Playwright runner. For another prewritten case, use `--fixture examples/my-case.json`.

## Mode 2: FREE local AI generation using Ollama

1. Install **Ollama for Windows** from https://ollama.com/download/windows and start it. The local API normally listens on `127.0.0.1:11434`.
2. Download an appropriate model. For a modest computer, start with the smaller coder model:

   ```bash
   ollama pull qwen2.5-coder:3b
   ```

   For more capable machines, `qwen2.5-coder:7b` is another option. Larger models need more memory and may run more slowly.
3. In Git Bash, while the demo is running:

   ```bash
   npm run generate -- generate --provider ollama \
     --model qwen2.5-coder:3b \
     --requirements examples/requirements-task-list.md \
     --output generated/ollama-draft.json
   ```

4. Review `generated/ollama-draft.json`. If it is structurally valid and its expectations match the requirements, run:

   ```bash
   npm run agent -- run generated/ollama-draft.json --headed
   ```

No OpenAI API key or paid credits are needed. The project only contacts the local Ollama server for the model call. **Real-model quality is not guaranteed**: small local models may produce unsupported locators, omit assertions, hallucinate steps, or time out. The tool rejects invalid schema or disallowed navigation rather than silently executing it. Local inference still incurs hardware/electricity costs.

The Ollama provider calls a fixed loopback endpoint; it does not accept external server URLs or expose the local model to the internet.

## Mode 3: FREE-TIER hosted AI using GroqCloud (recommended for low-powered laptops)

GroqCloud runs the model remotely: **no Ollama installation, GPU or model download is required**. This feature is currently on the generation feature branch.

1. Create a **GroqCloud** API key at https://console.groq.com/keys. This is **Groq**, not **Grok/xAI**.
2. In the project root, add this line to the existing, ignored `.env` file:

   ```dotenv
   GROQ_API_KEY="gsk_your-actual-key"
   ```

   Use **`GROQ_API_KEY`**, not `GROK_API_KEY` or `OPENAI_API_KEY`. Never commit your `.env` file. The Node.js 22+ generator **automatically reads `.env`** when the file is present in your current working directory; you do not need to `source` it in Git Bash.
3. Start the demo in one terminal with `npm run demo`. In a second terminal:

   ```bash
   npm run generate -- generate --provider groq \
     --model openai/gpt-oss-20b \
     --requirements examples/requirements-task-list.md \
     --output generated/groq-draft.json
   ```

4. Inspect `generated/groq-draft.json` and verify actions/expected results. Only after review:

   ```bash
   npm run agent -- run generated/groq-draft.json --headed
   ```

The generator uses GroqCloud's Chat Completions endpoint and JSON object output mode, then applies the same strict Zod validation and safe-navigation checks as other providers. JSON mode alone does **not** guarantee schema correctness or sensible test steps. Errors such as HTTP 401 (bad key) and HTTP 429 (rate/token limit) include practical guidance, without exposing credentials. No cloud key is required to replay approved tests.

Groq's published free plan limits depend on the selected model and your account. Check https://console.groq.com/docs/rate-limits before running many generations. Requirements and bounded webpage details are sent to the remote provider. Avoid secrets and production data.

**CI tests mock GroqCloud:** no automated run calls the live provider. A real request using your Groq account remains the final integration check.

## Mode 4: OpenAI cloud AI (optional, paid)


Set `OPENAI_API_KEY` in the local `.env` file or shell. The generator automatically loads the root `.env` file on Node.js 22+.

```bash
npm run generate -- generate --provider openai \
  --requirements examples/requirements-task-list.md \
  --output generated/cloud-draft.json

# After reviewing:
npm run agent -- run generated/cloud-draft.json --headed
```

You can override the default cloud models using `--model MODEL`, `GROQ_MODEL` or `OPENAI_MODEL`; the local model can be set with `OLLAMA_MODEL`. The `--provider` flag is **required**: no hosted inference is selected implicitly. GroqCloud remains subject to account free-tier limits; OpenAI is billed by API usage.

## Generate without written requirements

For any actual model, omit the `--requirements` flag and request a conservative first-page exploratory smoke draft:

```bash
npm run generate -- generate --provider ollama --output generated/exploratory-draft.json
```

The `fixture` provider ignores the requirements contents because it only returns an existing recorded case.

## Safety and limitations

- No provider executes a generated draft. A human must review actions, locators and expected results before running with `npm run agent`.
- Inspecting a page is limited to a bounded snapshot; there is no autonomous exploration or AI browser interaction yet.
- The runner and inspector restrict navigation/requests to the configured application origin.
- Model output is untrusted data. JSON validation and same-origin controls cannot establish test coverage or expectation correctness.
- Assertions cannot be falsely marked `human-confirmed` by an AI model. The fixture provider downgrades such labels to `inferred`.
- Unit and browser tests use stubs/fixed fixtures, never paid cloud inference. Passing CI proves the integration and defect fixture, not live model quality.
- Keep cloud API keys in the local environment; never commit secrets. The `generated/` directory is ignored by Git.

## Verify the project locally without API credits

```bash
npm run typecheck
npm run build
npm run test:unit
npm test
```

For a deployed product: use a provider-independent interface, select local/self-hosted models or paid cloud models according to quality, and replay approved JSON without model calls. Add budgets, prompt/result caching, small/large model routing and usage reporting before introducing autonomous repeated model calls.
