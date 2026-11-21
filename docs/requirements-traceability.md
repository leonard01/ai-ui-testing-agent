# Requirements-to-test traceability (first prototype)

This feature makes traceability **explicit and reviewable**, not a guess derived from matching words in requirements and test descriptions. Existing tests continue to work unchanged when they have no requirements mapping.

## Create a traceability matrix in the review UI

1. Describe a test and generate a draft (GroqCloud or fixture), or reopen an approved saved test for editing.
2. Under **2. Review proposed steps → Requirements traceability**, edit **Requirement statements, one per line**. If the original instructions contain many scenarios, split them into separate statements first; Markdown headings, arbitrary sentences and bullet lists are not automatically classified by an AI.
3. Click **Load requirements for mapping**. This creates stable IDs `R1`, `R2`, etc. Nothing is linked automatically.
4. Expand **Link steps or assertions to R1** (or the appropriate requirement) and tick the relevant action and assertion steps. The reviewer owns these links.
5. Review the counts for missing mappings, action-only mappings, inferred assertions and mapped assertions. Confirm each test step and click **Approve and save JSON test**.
6. With the saved test selected, open **View requirement matrix (JSON)** to inspect a deterministic report via `GET /api/tests/<approved-id>/traceability`.

## Status meanings

| Status | Interpretation |
| --- | --- |
| **Unmapped** | No test steps were explicitly linked to this requirement |
| **Steps only** | At least one action was linked, but no assertion was linked to verify the expected behavior |
| **AI assumption only** | Only assertions with `provenance: "inferred"` were linked; the expected results need human confirmation |
| **Assertion linked** | A linked assertion has provenance `requirements` or `human-confirmed`; this is *design coverage*, not an execution verdict |

The report also lists **assertion steps not mapped to any requirement**, which is useful for discovering unplanned tests and gaps. Each mapping lists step IDs, descriptions, action kinds and assertion provenance. One assertion can serve multiple requirements only if the reviewer chooses those links.

The matrix does **not** assert that the page passed the tests, that an expectation is correct, or that the specification has been fully covered. To establish runtime results, execute the saved test/suite and inspect its step reports and evidence separately.

## JSON representation

A saved test still has `schemaVersion: 1`. The new `requirements` property is optional:

```json
{
  "schemaVersion": 1,
  "id": "task-lifecycle",
  "title": "Task lifecycle",
  "version": 1,
  "requirements": [
    {
      "id": "R1",
      "text": "Adding a named task displays it in the list",
      "stepIds": ["enter", "add", "visible"]
    },
    {
      "id": "R2",
      "text": "Deleting the task removes it from the list",
      "stepIds": ["delete", "cleared"]
    },
    {
      "id": "R3",
      "text": "A user can filter tasks by priority",
      "stepIds": []
    }
  ],
  "steps": [
    {"id": "open", "description": "Open", "action": {"kind": "navigate", "url": "/"}},
    {"id": "enter", "description": "Enter task", "action": {"kind": "fill", "target": {"by": "label", "value": "Task"}, "value": "Prepare interview"}},
    {"id": "add", "description": "Add task", "action": {"kind": "click", "target": {"by": "role", "role": "button", "name": "Add"}}},
    {"id": "visible", "description": "Task appears", "action": {"kind": "assert-visible", "target": {"by": "text", "value": "Prepare interview"}, "provenance": "requirements"}},
    {"id": "delete", "description": "Delete task", "action": {"kind": "click", "target": {"by": "role", "role": "button", "name": "Delete Prepare interview"}}},
    {"id": "cleared", "description": "Task disappears", "action": {"kind": "assert-count", "target": {"by": "text", "value": "Prepare interview"}, "expected": 0, "provenance": "requirements"}}
  ]
}
```

The schema validates **unique requirement IDs, unique step links, existing step IDs, non-empty text**, maximum 40 requirement statements and maximum 100 linked steps per requirement. Unknown properties are rejected. Requirement text edits through **Load requirements** clear the old links for changed statements, avoiding stale mappings.

## Safety and limits

- Generated model output is rejected if it tries to supply `requirements` mappings or claim they were human-approved.
- The feature uses **no additional AI calls** and never edits the expected results.
- The report can be generated offline via the exported `buildTraceabilityReport` library function.
- Requirement capture is line-based and limited to 40 items per test; it does not parse Word/PDF specifications, automatically derive acceptance criteria, combine across suites or generate a full test management system.
- Mappings are design-time metadata embedded in the saved JSON, not an execution result. Execution verification, persistent history and cross-project coverage are separate future milestones.
