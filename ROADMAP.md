# Product roadmap

**AI UI Testing Agent → AI-native test automation platform**

Updated 25 November 2026 · Directional milestones, not fixed delivery dates.

## Vision

A unified environment for designing, reviewing, executing and maintaining tests across application layers, with AI assistance and human-controlled expectations. The platform should remain useful without an AI connection: approved tests, manual editing, deterministic execution, reporting and CI/CD must not depend on model availability.

The current focus is browser-based UI testing. We intend to reach a stable, useful UI milestone at v0.5 before shifting the main development focus to REST API testing. UI testing will continue to evolve; individual testing disciplines do not need to reach v1.0 before we develop another.

## Release roadmap

| Milestone | Focus | Status |
| --- | --- | --- |
| v0.1–v0.2 | Natural-language browser tests, human review, Playwright execution, incremental editing, early site memory | Existing prototype |
| v0.3 | Reliability, safe assertions, token efficiency, test workflow and failure repair | In development |
| v0.4 | Persistent system memory, reusable workflows and requirements intelligence | Planned |
| v0.5 | Professional test workspace, reporting, CI/CD and multi-module foundations | Planned — UI milestone |
| v0.6 | Initial REST API testing and shared platform integration | Planned |
| Beyond v0.6 | Mixed-protocol execution, repository intelligence, broader integration and testing disciplines | Exploratory |

### v0.3 — Reliable UI test lifecycle
- Optimise model context and completion budgets; expose measured token consumption and rate-limit diagnostics.
- Preserve explicit requirements and negative constraints; review mappings and unresolved functionality.
- Separate actionability assertions from actions (clickable without clicking, enabled, disabled, editable and not visible); protect against unintended actions.
- Improve locator and text-assertion repair, navigation, test organisation and execution results.
- Complete applicable deterministic and live-model acceptance before release. General AND/NOT and independent multi-term checks remain tracked in the backlog; exact release scope is subject to acceptance and prioritisation.

### v0.4 — Memory and requirements intelligence
- Expand site memory beyond login prerequisites: verified locators, approved repairs, known navigation, reusable workflows, failure evidence and human-confirmed expectations.
- Review, edit, disable, delete, import and export memory. Scope by application/environment; track evidence, provenance and freshness. Never silently learn bugs as expected behaviour or store secrets in memory.
- Add a persistent requirements repository independent of individual scripts, with stable IDs, test/step links, coverage gaps and impact when requirements change.
- Suggest tests and reusable workflows from known requirements and application context. Retrieve relevant knowledge rather than resending all historical context.
- Retain human approval of expectations and distinguish observed behaviour, AI inference and confirmed requirements.

### v0.5 — Professional test workspace and platform foundations
- Consistent design system, dark/light themes, optional alternative dark theme and system preference; persist selection and validate accessibility contrast.
- Refine test explorer, editor, test organisation, evidence and failure investigation. Consider visual element inspection and scoped DOM assertions based on backlog priority.
- Improve reporting, version-aware history, requirement coverage, AI usage, failure trends and reproducibility.
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
| Quality analytics | Flakiness, failure clustering, traceability, change impact and test effectiveness; measure accepted suggestions, correction rates and costs. |
| Framework interoperability | Import/orchestrate/export existing suites and collect common results; avoid requiring migration to a proprietary runner. |
| Additional disciplines | Contract, accessibility, performance, security-oriented checks and controlled chaos testing, subject to appropriate adapters, safety boundaries and validation. Unit testing is not a target discipline. |

## Architectural principles

- AI for interpretation and recommendations; deterministic code for execution, validation and reporting wherever practical.
- Human-controlled expectations; explicit authorization for state-changing or destructive actions.
- Provider independence and measurable AI cost/quality.
- Persistent, reviewable, evidence-backed knowledge; scoped credentials and least-privilege access.
- Modular monorepo as the initial direction, with optional/selective builds and tests as modules mature.
- Existing frameworks and CI/CD should remain interoperable. No need to reach v1.0 in any module before moving to another.

## Tracking and contributions

This roadmap describes direction, not a promise that a feature already exists. Priorities can change with testing feedback. See [GitHub Issues](https://github.com/leonard01/ai-ui-testing-agent/issues) for detailed backlog and [GitHub Releases](https://github.com/leonard01/ai-ui-testing-agent/releases) for published functionality. Feedback and reproducible use cases are welcome.
