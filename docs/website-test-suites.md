# Website test suites and saved test scripts

In this prototype, **test suite** refers to a collection of approved scripts for one website. For example, `https://www.saucedemo.com` is a suite, while `Add user` and `Remove user` are individual **test scripts** belonging to that website.

An **execution run** is a historical attempt to execute a single test script or selected scripts from a website suite. This is distinct from the saved suite itself.

## Save and organize

When you generate, review and approve a test, the server saves the exact application URL you entered as `sourceUrl` in the approved JSON. It groups scripts by the normalized **origin**—scheme, hostname and optional port. For example, both `https://www.saucedemo.com/` and `https://www.saucedemo.com/inventory.html` belong to the same website suite.

Newly approved files are placed under:

```text
generated/
  sites/
    https__www.saucedemo.com__<short-hash>/
      reviewed-<timestamp>-<id>.json
      reviewed-<timestamp>-<id>.json
    http__127.0.0.1_3000__<short-hash>/
      reviewed-<timestamp>-<id>.json
```

The hostname is readable, while the short hash prevents collisions between similar hosts, schemes and ports. Path segments and user-provided URLs cannot escape this directory. A hostname-based folder is only a storage key: the original `sourceUrl`, including its path, is retained in each script.

Older saved files in `generated/reviewed-*.json` are **not moved or deleted automatically**. They remain visible under **Older / unassigned scripts** because the original application URL was not recorded for those scripts. Select one, enter its correct application URL and click **Assign older script to website URL** to move it into the appropriate folder without changing its test steps or filename. This requires an explicit confirmation and same-origin navigation validation.

## Run a website suite

Under **3. Execute and diagnose → Run a test suite**:

1. Choose a **Test suite (website URL)** from the dropdown. All saved scripts for that website are displayed.
2. Select which scripts to execute, or use **Select first 10** for the current prototype's maximum of 10 scripts per execution batch.
3. Click **Run selected suite**. Scripts execute sequentially in isolated Chromium contexts and keep their own pass/fail reports.
4. Historical executions remain under **Execution history** and are not themselves new saved test suites.

Changing the suite dropdown updates the application URL field to the selected website origin. Choosing an individual approved script also restores its full saved `sourceUrl` into the field. The backend verifies that website-associated scripts in one execution batch all share the selected site's origin; a mixture of sites is rejected.

## Delete scripts or website suites

- **Delete selected test script** deletes exactly one approved script definition. A confirmation dialog is required.
- **Delete this website test suite** deletes every approved script for the chosen website origin. It does not delete scripts belonging to another website. A separate confirmation shows the website and script count.
- **Older / unassigned scripts** can be deleted individually; they cannot be deleted as an unidentified website suite.
- Deletion is blocked while a test run, suite execution, selector preflight, or another deletion is active. Server endpoints require `confirmed: true` and validated identifiers.
- **Historical execution reports, screenshots and traces are preserved**. Deleting a saved test suite does not rewrite the outcomes of previous test executions.

This is deliberately a simple local folder-based implementation, without a database, multi-user permissions, custom suite names or nested suites. Reloading the UI or restarting the review server reconstructs the website groupings by scanning valid saved files.

## Compatibility and current limits

- Saved JSON scripts retain the existing filename and action/step structure, with an optional `sourceUrl` field. Existing CLI execution and Playwright export remain supported.
- The group key is the website's HTTP(S) **origin**, not a specific path, account, organization or test category.
- A website with more than 10 approved scripts is still visible; select up to 10 per execution batch. Multiple batches can run sequentially.
- The URL is **captured at approval time** and is not automatically inferred by AI from test steps. Past execution results have their own recorded execution URL where available, but older saved scripts require explicit assignment to a website.
- Changing a website suite's URL requires resaving its test scripts under the desired origin. A generic rename/move feature is outside the first prototype.
