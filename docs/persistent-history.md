# Website suite execution history

In the Review UI, **test suite** means the website URL (origin) containing approved test scripts, such as `https://www.saucedemo.com`. A **suite execution** is a dated run of one or more scripts from that website.

Execution history is **collapsed by default** and is the **last section** of the page, below the most recent individual test and suite results. Click **Show History** to view it, or **Hide History** to collapse it.

## Browsing previous executions

1. Choose a **Test suite (website URL)** from the history dropdown.
2. Review that website's executions, newest first. Each line shows the **website suite name**, outcome, date/time, number of scripts and passed/failed/runner-error totals.
3. Use **Previous** and **Next** to navigate **10 executions per page**. Each website has its own filtered pages.
4. Click **Open results** to reopen the original report without rerunning the test or contacting an AI model.
   - For a batch, the suite details show each member script and allow opening its per-step diagnostics, screenshot and trace when available.
   - For a single-script execution, the one-script result is opened directly.
5. Click **Refresh history** when needed. A running test does not automatically expand the history section.

There is **no separate Individual runs history list**. Every new single-script run and multi-script batch appears as an execution under its website test suite. Batch-member reports are **not double-counted**. Older completed single-run reports from before this UI change are also shown in the corresponding website's history using their recorded `baseURL`.

Previously recorded runs without a valid website URL remain accessible under **Older / unknown website**. Website history remains visible even if the approved test scripts were subsequently deleted.

## Delete All History

**Delete All History** (inside the expanded history section) permanently deletes **all website suites' execution histories**, including run reports, screenshots, traces and saved batch summaries. This is global, **not limited to the selected website**. The browser asks for explicit confirmation; the server also requires an exact deletion confirmation token.

Deletion:
- Does **not** delete approved test scripts in `generated/` or website-specific script folders
- Does **not** run any tests or make AI calls
- Is refused while an individual test, a suite batch, a selector preflight or another deletion is active
- Removes only recognized run-ID directories inside `run-results/` and the run-ID subdirectories under `run-results/suites/` (not unrelated local files or folders)
- Immediately invalidates the deleted execution reports and their old links; they remain absent after server restart

The operation cannot be undone. If a history artifact cannot be removed because of filesystem permissions, the endpoint returns an error; manually inspect the local output folder before retrying.

## Local storage and restart

The default review server stores approved scripts in `generated/` and execution artifacts in `run-results/`. A custom `outputDir` keeps both beneath that directory. Each completed run has `run-results/<run-id>/report.json`, optional `failure.png` / `trace.zip`, and a small `run-metadata.json` recording the originating website URL. Completed batch snapshots are in `run-results/suites/<suite-run-id>/report.json`.

The server recovers completed historical reports on startup, including prehistory reports without metadata and legacy URLs where possible. For bounded local memory use it loads the **latest 1,000 individual reports and 1,000 batch reports**; pagination displays 10 per website at a time. Files older than the loaded window stay on disk until explicitly deleted or manually cleaned.

An interrupted test is not treated as passed. Corrupted or invalid report JSON is skipped. Previously approved corrections can remove superseded run evidence as part of their existing replacement workflow, so this operational history is not a tamper-proof audit log.

## Verification

Integration tests cover complete server restarts; website-filtered and ordered pagination over more than ten executions; site names and one-script/batch representation; absence of duplicate member rows; legacy unassigned history; direct result drilldown; rejected delete without confirmation; global delete with retention of approved test scripts and unrelated files; blocked deletion during execution; and empty history after restarting.
