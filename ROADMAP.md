# Product roadmap

**AI UI Testing Agent → AI-native test automation platform**

Updated 27 November 2026 · Directional milestones, not fixed delivery dates.

## Vision

A unified environment for designing, reviewing, executing and maintaining tests across application layers, with AI assistance and human-controlled expectations. The platform should remain useful without an AI connection: approved tests, manual editing, deterministic execution, reporting and CI/CD must not depend on model availability.

The current focus is browser-based UI testing. We intend to reach a stable, useful UI milestone at v0.5 before shifting the main development focus to REST API testing. UI testing will continue to evolve; individual testing disciplines do not need to reach v1.0 before we develop another.

## Release roadmap

| Milestone | Focus | Status |
| --- | --- | --- |
| v0.1–v0.2 | Natural-language browser tests, human review, Playwright execution, incremental editing, early site memory | Existing prototype |
| v0.3 | Reliability, safe assertions, token efficiency, test workflow and failure repair | In development |
| v0.4.0 | Provider abstraction, OpenRouter BYOK and core application memory | Planned |
| v0.4.1 | Advanced memory management and pre-submission token estimation | Planned |
| v0.4.2 | Reusable workflows, model benchmarking and further integrations | Planned — flexible sub-releases |
| v0.5 | Professional test workspace, persistent requirements, reporting, CI/CD and multi-module foundations | Planned — UI milestone |
| v0.6 | Initial REST API testing and shared platform integration | Planned |
| Beyond v0.6 | Mixed-protocol execution, repository intelligence, broader integration and testing disciplines | Exploratory |

### v0.3 — Reliable UI test lifecycle
- Optimise model context and completion budgets; expose measured token consumption and rate-limit diagnostics.
- Preserve explicit requirements and negative constraints; review mappings and unresolved functionality.
- Separate actionability assertions from actions (clickable without clicking, enabled, disabled, editable and not visible); protect against unintended actions.
- Improve locator and text-assertion repair, navigation, test organisation and execution results.
- Complete applicable deterministic and live-model acceptance before release. General AND/NOT and independent multi-term checks remain tracked in the backlog; exact release scope is subject to acceptance and prioritisation.

### v0.4.0 — Provider independence and core application memory
- Extend the existing model-provider interface and shared orchestration: normalized requests/responses, usage, finish reasons, errors, capability registry and secure credential configuration. Retain Groq; introduce OpenRouter with bring-your-own-key (BYOK), explicit model/provider selection, no silent paid fallback. No managed billing in this release. [#128](https://github.com/leonard01/ai-ui-testing-agent/issues/128).
- Core provider-independent persistent memory: verified locators, human-approved locator repairs, application/environment scope, provenance, freshness metadata, basic inspect/disable/delete controls and safe migration. Explicit instructions override memory; never store secrets or learn observed bugs as expectations. [#104](https://github.com/leonard01/ai-ui-testing-agent/issues/104).
- Verify initial and incremental generation against both providers; approved tests, editing, execution and reporting remain usable without AI. Mocked contract tests and small opt-in live comparison.
- Release independently once core provider and memory acceptance is complete. Do not hold v0.4.0 for advanced memory or extra integrations.

### v0.4.1 — Advanced application memory
- Navigation, failure evidence and human-confirmed expectations; conflict/freshness controls, selective retrieval and full review/edit/disable/delete/import/export. Preserve provenance and environment isolation. [#129](https://github.com/leonard01/ai-ui-testing-agent/issues/129).
- Pre-submission token estimation and configurable request budgets, provisionally here after provider abstraction; model-compatible tokenizer with labelled fallback, no additional hosted call. [#124](https://github.com/leonard01/ai-ui-testing-agent/issues/124).

### v0.4.2 — Reusable workflows and further model integrations
- Reusable approved parameterized steps/workflows, selective context, conservative deterministic matching and hybrid AI generation; evaluate correctness, false matches and token savings. [#130](https://github.com/leonard01/ai-ui-testing-agent/issues/130), [#117](https://github.com/leonard01/ai-ui-testing-agent/issues/117).
- Cross-provider benchmarks with pinned model/endpoint where feasible: first-attempt validity, semantic correctness, execution, usage/reasoning, retries, latency and cost per successful test. Consider generic OpenAI-compatible endpoints and further direct providers only where justified. [#131](https://github.com/leonard01/ai-ui-testing-agent/issues/131).
- Further v0.4.x releases may split these capabilities if needed; dates and precise sub-release boundaries are flexible.

### v0.5 — Professional test workspace and platform foundations
- Consistent design system, dark/light themes, optional alternative dark theme and system preference; persist selection and validate accessibility contrast.
- Refine test explorer, editor, test organisation, evidence and failure investigation. Consider visual element inspection and scoped DOM assertions based on backlog priority.
- Improve reporting, version-aware history, requirement coverage, AI usage and cost reporting, polished provider configuration, failure trends and reproducibility.
- Persistent requirements repository with stable IDs, test/step links, review/version status, coverage gaps, change impact and test suggestions. Distinguish mapped, confirmed and executed coverage. [#105](https://github.com/leonard01/ai-ui-testing-agent/issues/105). Split into v0.5.x if needed.
- Strengthen existing CLI/headless execution and CI/CD integration; portable results and framework interoperability.
- Prepare a modular architecture with shared lifecycle, reporting, memory and AI services; extract boundaries through real reuse rather than speculative rewriting.
- Revisit repository and product naming. UI milestone, not completion of all UI features.

### v0.6 — REST API testing prototype
- Deterministic HTTP runner, request/response editor, methods, headers, authentication through secure references, environment variables and assertions.
- OpenAPI import/discovery, natural-language generation and explicit review of expected responses.
- Shared requirements, memory, reporting, test organisation and CI/CD.
- Begin with manually authored and executable API tests without AI, then add AI assistance.
- Establish foundations for mixed UI/API workflows, shared variables, data setup/cleanup and later protocol adapters.

## Longer-term workstreams (not committed to release numbers)

| Workstream | Intended direction |
| --- | --- |
| Cross-layer testing | Combine UI, REST, gRPC, GraphQL, database and messaging actions in one workflow, passing typed values and evidence between steps. |
| Functional/integration testing | Registered execution adapters, existing harnesses and service/domain context rather than arbitrary AI-generated code execution. |
| Change-driven test intelligence | Configurable PR-triggered analysis, from risk overview to test recommendations, impacted regression selection, reviewable scripts and permitted execution in isolated environments. Manual/push triggers opt-in; incremental diff analysis, evidence-backed repository memory and feedback. |
| Hosted demo and optional managed credits | Bounded demo allowance, secure server-side credits/billing, cost caps, abuse prevention and privacy; BYOK first, commercial offering optional. Self-hosted inference remains an option. [#132](https://github.com/leonard01/ai-ui-testing-agent/issues/132). |
| Quality analytics | Flakiness, failure clustering, traceability, change impact and test effectiveness; measure accepted suggestions, correction rates and costs. |
| Framework interoperability | Import/orchestrate/export existing suites and collect common results; avoid requiring migration to a proprietary runner. |
| Additional disciplines | Contract, accessibility, performance, security-oriented checks and controlled chaos testing, subject to appropriate adapters, safety boundaries and validation. Unit testing is not a target discipline. |

## Architectural principles

- AI for interpretation and recommendations; deterministic code for execution, validation and reporting wherever practical.
- Human-controlled expectations; explicit authorization for state-changing or destructive actions.
- Provider independence and measurable AI cost/quality. Exploit model-specific capabilities through a common contract, not a lowest-common-denominator architecture. No silent provider fallback or unapproved paid usage. Memory and test contracts must not depend on any AI provider.
- Persistent, reviewable, evidence-backed knowledge; scoped credentials and least-privilege access.
- Modular monorepo as the initial direction, with optional/selective builds and tests as modules mature.
- Existing frameworks and CI/CD should remain interoperable. No need to reach v1.0 in any module before moving to another.

## Tracking and contributions

This roadmap describes direction, not a promise that a feature already exists. Priorities can change with testing feedback. See [GitHub Issues](https://github.com/leonard01/ai-ui-testing-agent/issues) for detailed backlog and [GitHub Releases](https://github.com/leonard01/ai-ui-testing-agent/releases) for published functionality. Feedback and reproducible use cases are welcome.
