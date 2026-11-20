import { test, expect } from "@playwright/test";

test("browser automation scaffold can interact with a page", async ({
  page,
}) => {
  // No external site or AI service needed: deterministic browser smoke test.
  await page.setContent(`
    <main>
      <h1>Demo UI</h1>
      <button type="button" id="start">Start</button>
      <p role="status">Not started</p>
    </main>
    <script>
      document.querySelector('#start').addEventListener('click', () => {
        document.querySelector('[role=status]').textContent = 'Started';
      });
    </script>
  `);

  await expect(page.getByRole("heading", { name: "Demo UI" })).toBeVisible();
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByRole("status")).toHaveText("Started");
});
