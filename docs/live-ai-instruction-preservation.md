# Live AI evaluation catalogue — instruction preservation (v0.2.1)
Supplement to AI-01–AI-12. Issue #78. These cases are required in the same change as the guard. Status: not run on the new implementation. AI-13 reproduced before the fix.

## Common procedure
Start the app using npm run start:demo. Open http://127.0.0.1:3100. Select GroqCloud. For each case set the URL and memory checkbox exactly as specified, enter a unique test name and paste the instructions verbatim. Generate a fresh draft three times (not three executions of one script). Review actual actions, not descriptions alone. Replace credential placeholders with authorized public demo test data only, where necessary. Do not manually fix a generated omission and count it as first-attempt success. Save and run only an appropriate reviewed draft. Record date, commit, model, attempt, generation verdict, execution verdict, evidence and any recovery. A safe rejection is a pass only where explicitly expected. Provider/site outage is blocked, not pass.

## AI-13 — incompatible requirements (P0)
URL: http://127.0.0.1:3000/; memory off.
Instructions:
> Log in using the standard user account.  
> Add Sauce Labs Backpack to cart.  
> Open the shopping cart.  
> Verify that Sauce Labs Backpack is displayed in the cart.  
> Verify that the cart contains exactly one item.

Expected: generation blocks the draft and shows problematic requirements with a count and three resolution options. No steps are exposed before a decision. Do not claim the initial snapshot proves later pages unavailable. Fail if unrelated task-list steps replace the workflow or the issue is silently omitted.

## AI-14 — explicit login overrides memory setting (P0)
URL: https://www.saucedemo.com/; memory off. Repeat with memory on as a separate configuration.
Instructions:
> Log in using the standard user account.  
> Verify that Products is visible.

Expected: explicit executable login steps are present; supply standard_user and secret_sauce if placeholders occur. Run and verify Products after login. Explicit login is not labelled as a memory suggestion. Fail if login is omitted or hidden.

## AI-15 — explicit negative instruction overrides memory (P0)
URL: https://www.saucedemo.com/; memory on. First seed site memory with a passing reviewed login and shopping test (AI-07 prerequisite).
Instructions:
> Do not log in. Verify that the Login button is visible.

Expected: no credential entry or login submission, even when memory exists; login button visibility check executes on initial page. Fail if any login is inserted. A clear conflict rejection is safe but not first-attempt functional success for this feasible request.

## AI-16 — memory-suggested steps remain visible (P1)
URL: https://www.saucedemo.com/; memory on; seed memory as AI-15.
Instructions:
> Add Sauce Labs Backpack to cart. Open the shopping cart. Verify that Sauce Labs Backpack is displayed in the cart.

Expected: suggested login actions are explicit in draft, labelled suggested prerequisite, reviewed with approved demo credentials and displayed with labels in execution results. Verify correct product after login. Fail if prerequisite is hidden or necessary login omitted. The memory observation itself is not proof of authentication requirement.

## AI-17 — ordinary task workflow remains unaffected (P1)
URL: http://127.0.0.1:3000/; memory off.
Instructions:
> Add a task called Review report. Verify Review report is visible.

Expected: fill Task, add, verify named task; no login or unrelated substitutions. Save/run and pass.

## AI-18 — later-page authentication is not rejected from initial DOM alone (P1)
URL: a controlled authorized multi-page fixture with a public landing page and a Sign in link leading to a login form; fixture must be supplied before running. Until available, mark blocked, not passed.
Instructions: Open the Sign in page. Log in using the demo account. Verify the account page is visible.
Expected: preserve navigation and authentication actions even though credential inputs are not on the landing page. Never infer their absence means the user is mistaken. Review and use fixture credentials. Verify actual account page.

## AI-19 — resolve by editing the complete description (P0)
URL: local task demo; use AI-13 instructions. After the exception, choose Edit test description and replace text with "Verify that the status reads 0 tasks, 0 completed." Validate. Expected: normal editable draft, original description retained, revised working instructions recorded, no separate mapping approval.

## AI-20 — edit/delete only problem requirements (P0)
URL: local task demo. Enter these separate lines:
> Open the task list.
> Log in using the standard user account.
> Add Sauce Labs Backpack to cart.
> Verify that the status reads 0 tasks, 0 completed.

Choose Edit or delete problematic requirements. Delete the login requirement and edit the cart requirement to "Verify that the Task field is visible." Validate. Expected: unchanged statements retained; revised instructions revalidated; normal editable draft. Original instructions remain visible for traceability. No automatic deletion.

## AI-21 — proceed without changes (P0)
Use AI-13 instructions and URL. Choose Proceed without changes. Expected: critical-failure warning; Generate test anyway disabled until acknowledged. Retry with unchanged instructions. Either all original requirements have executable mappings and a draft warning remains, or generation remains blocked with explanation. Never accept omitted instructions. If a draft is available, review and execute only with authorized data; missing controls should fail safely. Record generation and execution separately.

## AI-22 — selector naming is not a functional mismatch (P1)
URL: local task demo. Instructions: "Enter a task called Review report. Click the button to submit the task. Verify Review report is visible." Expected: ordinary draft using the actual Add control or executable intent, no functional mismatch merely because the user described the control differently.

## Results
| Case | Attempt 1 | Attempt 2 | Attempt 3 | Evidence / notes |
|---|---|---|---|---|
| AI-13 | Not run | Not run | Not run | Pre-fix failure reproduced |
| AI-14 memory off | Not run | Not run | Not run | |
| AI-14 memory on | Not run | Not run | Not run | |
| AI-15 | Not run | Not run | Not run | |
| AI-16 | Not run | Not run | Not run | |
| AI-17 | Not run | Not run | Not run | |
| AI-18 | Blocked | Blocked | Blocked | Controlled fixture required |
| AI-19 | Not run | Not run | Not run | |
| AI-20 | Not run | Not run | Not run | |
| AI-21 | Not run | Not run | Not run | |
| AI-22 | Not run | Not run | Not run | |
