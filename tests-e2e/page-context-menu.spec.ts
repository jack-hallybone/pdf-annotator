import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

// The browser's own menu has nothing to offer on a page, and it came up for a pen's barrel button or a right-drag too short to erase. A box being typed in keeps it, for spelling and paste.

const fixturePath = fileURLToPath(
  new URL("../tests/fixtures/test-annotated.pdf", import.meta.url),
);
const HIDDEN_FILE_INPUT = 'input[type="file"].tabbedapp-hidden-input';

test("a right click on a page brings up no browser menu, and one in a text box still does", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(HIDDEN_FILE_INPUT).setInputFiles(fixturePath);
  await expect(page.locator(".page-jump-control")).toBeVisible();
  // A listener on the window hears each menu after the app has, so it sees whether the app refused it.
  await page.evaluate(() => {
    const shown: boolean[] = [];
    (window as unknown as { __menusShown: boolean[] }).__menusShown = shown;
    window.addEventListener("contextmenu", (event) =>
      shown.push(!event.defaultPrevented),
    );
  });
  const menusShown = () =>
    page.evaluate(
      () => (window as unknown as { __menusShown: boolean[] }).__menusShown,
    );
  const box = await page
    .locator(".pdfdocumenteditor-page")
    .first()
    .boundingBox();
  if (!box) {
    throw new Error("no page to click on");
  }

  await page.mouse.click(box.x + box.width * 0.5, box.y + 120, {
    button: "right",
  });
  // With a pen chosen too, where a right-drag erases.
  await page.getByRole("button", { name: "Pen 1", exact: true }).click();
  await page.mouse.click(box.x + box.width * 0.5, box.y + 160, {
    button: "right",
  });
  await expect.poll(menusShown).toEqual([false, false]);

  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.mouse.click(box.x + box.width * 0.3, box.y + 200);
  const textBox = page.locator(".pdfdocumenteditor-scroll-root textarea");
  await expect(textBox).toBeFocused();
  await textBox.click({ button: "right" });
  await expect.poll(menusShown).toEqual([false, false, true]);
});
