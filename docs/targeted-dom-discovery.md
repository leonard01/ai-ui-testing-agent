# Targeted Live DOM Discovery — first milestone

## Why this exists

The first AI drafts often chose invalid locators (`getByLabel("Add")` for a button, or a named `listitem` without an accessible name). One static webpage snapshot cannot predict dynamic elements, and a syntactically valid test is not necessarily executable.

The deterministic runner now accepts an **intent target** as an alternative to the original role/label/text locators:

```json
{
  "kind": "fill",
  "target": { "by": "intent", "value": "Username", "role": "textbox" },
  "value": "Bob"
}
```

Or:

```json
{
  "kind": "click",
  "target": { "by": "intent", "value": "Save user", "role": "button" }
}
```

The optional `role` is one of `button`, `textbox`, `checkbox`, `heading`, `status`, `listitem`.

## How it runs

1. At **each step**, the runner asks Playwright to inspect the **current** DOM, not just the initial page.
2. Discovery looks at a limited, action-appropriate set of visible elements (up to 250), recording tag, role, accessible cues (aria labels, associated labels, placeholders, title), visible text, immediate parent context, IDs and test IDs. It deliberately does not read text-field values or send the entire DOM to a model.
3. A deterministic relevance algorithm checks the important words of the intent against each candidate's name, role and nearby text.
4. All meaningful intent words must have supporting evidence. Optional role is a hard filter. If multiple candidates have the same best score, execution **stops with an ambiguity error** rather than guessing.
5. A uniquely supported candidate is verified using Playwright's match count and visibility, preferring its unique `data-testid` or ID, otherwise a **current-page-only positional locator**. These locators are *not* persisted in the test JSON.
6. The runner executes the step and records `resolution` evidence in `report.json`: intent, DOM tag, role, name, nearby text, selected locator and how many candidates were inspected.
7. On a dynamic page, discovery repeats for the next step against the updated DOM; newly created forms/rows can now be found.

There is **no per-step model call** and no browser action is performed by the language model. AI writes an *intent*, and the deterministic Playwright layer grounds that intent in live page evidence.

## Quick demo

```bash
npm run build
npm run demo
# Separate terminal:
npm run agent -- run examples/task-intent.json
```

The saved example shows a complete task lifecycle with runtime DOM discovery, including a task row that did not exist at initial inspection. Existing JSON cases with explicit locators continue to run unchanged.

The **review UI** (`npm run review`) displays these intent targets in human-readable form and lets the tester choose **Live DOM intent** when editing a proposed step.

## Limits and safety

- This is **deterministic, heuristic candidate matching**, not arbitrary natural-language understanding. Complex semantics, synonyms and vague intentions may not match. For example, if the task says "Submit form" but the page says "Save", a human clarification or future model disambiguation may be necessary.
- It searches the main document, not nested iframes. Shadow DOM, canvas controls, inaccessible custom widgets, advanced composite controls, and scrolling/virtualized elements require more work.
- It looks at a bounded number of likely elements to keep browser overhead low. It is not an exhaustive scan of every CSS or XPath possibility.
- If two Add buttons genuinely appear equivalent, it deliberately fails. The human can supply a more specific intent or an explicit locator. **No arbitrary first-match fallback** is allowed.
- A uniquely matched element is evidence that the element was locatable, not that the selected element is semantically the correct one. The tester still reviews the draft.
- This does not correct an AI-generated wrong expected value (for example "1 tasks" instead of "1 task"). Assertions remain tied to supplied requirements or marked as inferred.
- Intent-based steps can use a temporary positional locator **within that one execution step**. Persisting brittle selectors is avoided, but DOM churn during an action can still affect this first implementation.
- Diagnostic evidence may contain short excerpts of nearby DOM text. Avoid testing sensitive production pages until explicit data minimization and redaction controls are added.

The next milestone is **targeted candidate disambiguation** (model-assisted or human-assisted when deterministic evidence is insufficient), and richer visual/DOM context for unusual applications—not blind automatic assertion repair.
