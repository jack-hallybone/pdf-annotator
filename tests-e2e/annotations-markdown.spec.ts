import { expect, test } from "@playwright/test";
import { PDFDocument, PDFName, PDFString } from "pdf-lib";

// The copy is what the Annotations panel shows, filters and all, in its order, read back off the real clipboard.

const HIDDEN_FILE_INPUT = 'input[type="file"].tabbedapp-hidden-input';

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

test("Copy as Markdown puts the filtered list on the clipboard, page by page", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(HIDDEN_FILE_INPUT).setInputFiles({
    name: "Reading notes.pdf",
    mimeType: "application/pdf",
    buffer: await highlightedPdf(),
  });
  await expect(page.locator(".page-jump-control")).toBeVisible();
  await page.getByRole("button", { name: /show sidebar/i }).click();
  await page.getByRole("tab", { name: "Annotations" }).click();
  await expect(page.locator(".annotation-row")).toHaveCount(3);

  // Yellow is the most used colour, so it is the first swatch.
  await page.getByRole("button", { name: "Colour 1, 2 annotations" }).click();
  await expect(page.locator(".annotation-row")).toHaveCount(2);
  await page.getByRole("button", { name: "Copy as Markdown" }).click();

  await expect(page.locator(".tabbedapp-notice")).toHaveText(
    "Copied 2 annotations as Markdown.",
  );
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    [
      "# Reading notes",
      "",
      "## Page 1",
      "",
      "> Alpha claim",
      "",
      "First comment",
      "",
      "## Page 3",
      "",
      "> Gamma result",
      "",
      "Third comment",
      "",
    ].join("\n"),
  );
});

// A highlight over the one line of text on each of three pages: yellow on pages 1 and 3, with comments, and green on page 2.
async function highlightedPdf() {
  const doc = await PDFDocument.create();
  const marks = [
    { color: [1, 0.9, 0.2], comment: "First comment", text: "Alpha claim" },
    { color: [0.2, 0.7, 0.3], comment: "", text: "Beta finding" },
    { color: [1, 0.9, 0.2], comment: "Third comment", text: "Gamma result" },
  ];
  for (const { color, comment, text } of marks) {
    const added = doc.addPage([300, 300]);
    added.drawText(text, { size: 14, x: 30, y: 250 });
    added.node.set(
      PDFName.of("Annots"),
      doc.context.obj([
        doc.context.obj({
          Type: "Annot",
          Subtype: "Highlight",
          Rect: [26, 244, 150, 268],
          QuadPoints: [26, 268, 150, 268, 26, 244, 150, 244],
          C: color,
          CA: 0.4,
          F: 4,
          ...(comment ? { Contents: PDFString.of(comment) } : {}),
        }),
      ]),
    );
  }
  return Buffer.from(await doc.save());
}
