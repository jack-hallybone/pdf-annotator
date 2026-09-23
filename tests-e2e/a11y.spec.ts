import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

// Run in both colour schemes and with and without a document open, because the
// dock, sidebar and page controls mount only once a PDF is loaded.

const fixture = (name: string) =>
  fileURLToPath(new URL(`../tests/fixtures/${name}`, import.meta.url));

const fixturePath = fixture("test-annotated.pdf");

const HIDDEN_FILE_INPUT = 'input[type="file"].tabbedapp-hidden-input';

// WCAG 2.2 SC 2.5.8 sets 24x24 CSS px. Its spacing exception needs every
// neighbour's geometry, so exempt targets are listed with their reason.
const TARGET_SIZE_EXEMPT: { selector: string; why: string }[] = [];

// PDF.js's text layer is a transparent copy of the page's text over the canvas,
// so its 1:1 contrast is the point. Skipped wholesale rather than listed,
// because it is one element per text run.
const PDF_DOCUMENT_CONTENT = ".textLayer";

type Finding = { what: string; where: string; detail: string };

async function openHome(page: Page) {
  await page.goto("/");
  await expect(page.locator(".browserapp-home-card")).toBeVisible();
}

// Waits for the tabbedapp chrome, not just for a canvas: a canvas exists well
// before the dock, controls and sidebar toggle mount.
async function openDocument(page: Page, file = fixturePath) {
  await page.goto("/");
  await page.locator(HIDDEN_FILE_INPUT).setInputFiles(file);
  await expect(page.locator("canvas").first()).toBeVisible();
  await expect(page.locator(".zoom-controls")).toBeVisible();
}

// None of these are mounted until something opens them, so a state missing here
// is a state nobody checks. The tab and page menus use role="menuitem", where
// getByRole('button') matches nothing and the step passes by doing nothing.
const DOCUMENT_STATES: { name: string; open: (page: Page) => Promise<void> }[] =
  [
    {
      name: "password prompt",
      open: async (page) => {
        await page.goto("/");
        await page
          .locator(HIDDEN_FILE_INPUT)
          .setInputFiles(fixture("test-password-123456.pdf"));
        await expect(page.locator(".password-unlock-form")).toBeVisible();
      },
    },
    {
      name: "read-only banner (signed)",
      open: async (page) => {
        await page.goto("/");
        await page
          .locator(HIDDEN_FILE_INPUT)
          .setInputFiles(fixture("test-signed.pdf"));
        await expect(page.locator(".banner.warning")).toBeVisible();
      },
    },
    {
      name: "read-only banner (PDF/A)",
      open: async (page) => {
        await page.goto("/");
        await page
          .locator(HIDDEN_FILE_INPUT)
          .setInputFiles(fixture("test-pdfa.pdf"));
        await expect(page.locator(".banner.warning")).toBeVisible();
      },
    },
  ];

const OVERLAY_STATES: { name: string; open: (page: Page) => Promise<void> }[] =
  [
    {
      name: "annotations panel with a comment open",
      open: async (page) => {
        await openDocument(page);
        await page
          .getByRole("button", { name: /show sidebar/i })
          .first()
          .click();
        await page.getByRole("tab", { name: "Annotations" }).click();
        await page.locator(".annotation-row-open").first().click();
        await expect(
          page.getByRole("textbox", { name: "Comment" }),
        ).toBeVisible();
      },
    },
    {
      name: "contents panel",
      open: async (page) => {
        await page.goto("/");
        await page.locator(HIDDEN_FILE_INPUT).setInputFiles({
          name: "outlined.pdf",
          mimeType: "application/pdf",
          buffer: await outlinedPdf(),
        });
        await expect(page.locator(".page-jump-control")).toBeVisible();
        await page
          .getByRole("button", { name: /show sidebar/i })
          .first()
          .click();
        await page.getByRole("tab", { name: "Contents" }).click();
        await expect(page.locator(".outline-entry").first()).toBeVisible();
      },
    },
    {
      name: "page context menu",
      open: async (page) => {
        await openDocument(page);
        await page
          .getByRole("button", { name: /show sidebar/i })
          .first()
          .click();
        await page.locator(".page-thumbnail-menu-toggle").first().click();
        await expect(page.locator(".page-menu")).toBeVisible();
      },
    },
    {
      name: "every tool settings popover",
      open: async (page) => {
        await openDocument(page);
        const buttons = page.locator(".tool-settings-button");
        for (let i = 0; i < (await buttons.count()); i += 1) {
          await buttons.nth(i).click();
          await expect(page.locator(".tool-settings-popover")).toBeVisible();
        }
      },
    },
    {
      name: "tab context menu",
      open: async (page) => {
        await openDocument(page);
        await page
          .locator(".tabbedapp-tab-main")
          .first()
          .click({ button: "right" });
        await expect(page.locator(".tabbedapp-tab-context-menu")).toBeVisible();
      },
    },
    {
      name: "new tab menu",
      open: async (page) => {
        await openDocument(page);
        await page.getByRole("button", { name: "New tab" }).click();
        await expect(page.locator(".tabbedapp-new-tab-menu")).toBeVisible();
      },
    },
    {
      name: "rename dialog",
      open: async (page) => {
        await openDocument(page);
        await page
          .locator(".tabbedapp-tab-main")
          .first()
          .click({ button: "right" });
        await page
          .locator(".tabbedapp-tab-context-menu button", {
            hasText: "Rename file",
          })
          .click();
        await expect(page.locator(".tabbedapp-rename-dialog")).toBeVisible();
      },
    },
    {
      name: "close confirmation dialog",
      open: async (page) => {
        await page.goto("/");
        await page.getByRole("button", { name: /New Blank A4/i }).click();
        await expect(page.locator(".tabbedapp-document-tab")).toBeVisible();
        await page.locator(".tabbedapp-tab-close").first().click();
        await expect(page.locator(".tabbedapp-close-dialog")).toBeVisible();
      },
    },
    {
      name: "external link dialog",
      open: async (page) => {
        await page.goto("/");
        await page.locator(HIDDEN_FILE_INPUT).setInputFiles({
          name: "linked.pdf",
          mimeType: "application/pdf",
          buffer: await linkedPdf(),
        });
        await expect(page.locator("canvas").first()).toBeVisible();
        await page
          .locator(".pdfdocumenteditor-external-link, .annotationLayer a")
          .first()
          .click();
        await expect(page.locator(".external-link-dialog")).toBeVisible();
      },
    },
  ];

let outlinedPdfBytes: Buffer | null = null;
async function outlinedPdf() {
  if (outlinedPdfBytes) return outlinedPdfBytes;
  const { PDFDocument, PDFName, PDFString } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const first = doc.addPage([300, 300]);
  first.drawText("First", { size: 24, x: 40, y: 200 });
  const second = doc.addPage([300, 300]);
  const { context } = doc;
  const outlines = context.obj({ Type: "Outlines", Count: 2 });
  const outlinesRef = context.register(outlines);
  const firstItem = context.obj({
    Title: PDFString.of("Chapter one"),
    Parent: outlinesRef,
    Dest: [first.ref, PDFName.of("Fit")],
  });
  const firstRef = context.register(firstItem);
  const secondItem = context.obj({
    Title: PDFString.of("Chapter two"),
    Parent: outlinesRef,
    Dest: [second.ref, PDFName.of("Fit")],
  });
  const secondRef = context.register(secondItem);
  firstItem.set(PDFName.of("Next"), secondRef);
  secondItem.set(PDFName.of("Prev"), firstRef);
  outlines.set(PDFName.of("First"), firstRef);
  outlines.set(PDFName.of("Last"), secondRef);
  doc.catalog.set(PDFName.of("Outlines"), outlinesRef);
  outlinedPdfBytes = Buffer.from(await doc.save());
  return outlinedPdfBytes;
}

let linkedPdfBytes: Buffer | null = null;
async function linkedPdf() {
  if (linkedPdfBytes) return linkedPdfBytes;
  const { PDFDocument, PDFName, PDFString } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  page.node.set(
    PDFName.of("Annots"),
    doc.context.obj([
      doc.context.obj({
        Type: "Annot",
        Subtype: "Link",
        Rect: [20, 200, 280, 280],
        Border: [0, 0, 0],
        A: {
          Type: "Action",
          S: "URI",
          URI: PDFString.of("https://example.com/a11y-probe"),
        },
      }),
    ]),
  );
  linkedPdfBytes = Buffer.from(await doc.save());
  return linkedPdfBytes;
}

// Everything below runs inside the page: pulling nodes across the boundary one
// at a time is far slower.
async function audit(page: Page, exempt: string[]) {
  return page.evaluate(
    ({ exemptSelectors, documentContent }) => {
      const findings: { what: string; where: string; detail: string }[] = [];
      let interactiveChecked = 0;

      const INTERACTIVE =
        'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"]), [role="button"]';

      const describe = (el: Element) => {
        const id = el.id ? `#${el.id}` : "";
        const cls =
          el.className && typeof el.className === "string"
            ? `.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}`
            : "";
        const text = (el.textContent ?? "").trim().slice(0, 30);
        return `${el.tagName.toLowerCase()}${id}${cls}${text ? ` "${text}"` : ""}`;
      };

      const chrome = (el: Element) => !el.closest(documentContent);

      const visible = (el: Element) => {
        const style = getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none")
          return false;
        if (el.closest("[hidden]") || el.closest('[aria-hidden="true"]'))
          return false;
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      };

      const exemptEls = new Set(
        exemptSelectors.flatMap((selector) => [
          ...document.querySelectorAll(selector),
        ]),
      );
      for (const el of document.querySelectorAll(INTERACTIVE)) {
        if (!visible(el) || !chrome(el) || exemptEls.has(el)) continue;
        if ((el as HTMLInputElement).disabled) continue;
        interactiveChecked += 1;
        if (el.tagName === "A" && el.closest("p, li, span")) continue;
        const box = el.getBoundingClientRect();
        if (box.width < 24 || box.height < 24) {
          findings.push({
            what: "target size",
            where: describe(el),
            detail: `${box.width.toFixed(0)}x${box.height.toFixed(0)}px, under 24x24`,
          });
        }
      }

      // A control covered by something else fails every other criterion at once, and a
      // full-width transparent container is invisible to a check that looks at
      // elements one at a time. While an overlay is open only its own contents are
      // checked: an overlay is meant to cover what is behind it.
      const overlays = [
        ...document.querySelectorAll(
          '[aria-modal="true"], [role="menu"], .menu, .floating-popover',
        ),
      ].filter((el) => visible(el));
      const occlusionTargets = overlays.length
        ? overlays.flatMap((overlay) => [
            ...overlay.querySelectorAll(INTERACTIVE),
          ])
        : [...document.querySelectorAll(INTERACTIVE)];
      for (const el of occlusionTargets) {
        if (!visible(el) || (el as HTMLInputElement).disabled) continue;
        const box = el.getBoundingClientRect();
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
        const hit = document.elementFromPoint(x, y);
        if (!hit || el === hit || el.contains(hit)) continue;
        findings.push({
          what: "occluded",
          where: describe(el),
          detail: `its centre hits ${describe(hit)} instead`,
        });
      }

      if (document.documentElement.scrollWidth > innerWidth + 1) {
        findings.push({
          what: "reflow",
          where: "the page",
          detail: `scrollWidth ${document.documentElement.scrollWidth}px at a ${innerWidth}px viewport`,
        });
      }

      for (const el of document.querySelectorAll(INTERACTIVE)) {
        if (!visible(el) || !chrome(el)) continue;

        const strong =
          (el.textContent ?? "").trim() ||
          el.getAttribute("aria-label") ||
          el.getAttribute("aria-labelledby") ||
          (el.id &&
            document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) ||
          el.closest("label") ||
          (el as HTMLInputElement).labels?.length;
        if (strong) continue;

        const title = el.getAttribute("title");
        findings.push(
          title
            ? {
                what: "name from title only",
                where: describe(el),
                detail: `named "${title}" by tooltip alone; add aria-label`,
              }
            : {
                what: "accessible name",
                where: describe(el),
                detail: "no text, aria-label, title or associated label",
              },
        );
      }

      return { findings, interactiveChecked };
    },
    { exemptSelectors: exempt, documentContent: PDF_DOCUMENT_CONTENT },
  );
}

// Focus has to be moved for real: :focus-visible is a browser heuristic rather
// than something a stylesheet can be read for.
async function auditFocus(page: Page) {
  return page.evaluate(() => {
    const findings: { what: string; where: string; detail: string }[] = [];
    const describe = (el: Element) => {
      const cls =
        typeof el.className === "string" && el.className
          ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}`
          : "";
      return `${el.tagName.toLowerCase()}${cls}`;
    };

    let checked = 0;
    const focusable = [
      ...document.querySelectorAll<HTMLElement>(
        "a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)",
      ),
    ].filter((el) => {
      const box = el.getBoundingClientRect();
      return (
        box.width > 0 &&
        box.height > 0 &&
        getComputedStyle(el).visibility !== "hidden"
      );
    });

    for (const el of focusable) {
      checked += 1;
      const before = getComputedStyle(el);
      const wasOutline =
        before.outlineStyle !== "none" && parseFloat(before.outlineWidth) > 0;
      const wasShadow = before.boxShadow;

      el.focus();
      if (document.activeElement !== el) continue;

      const after = getComputedStyle(el);
      const hasOutline =
        after.outlineStyle !== "none" && parseFloat(after.outlineWidth) > 0;
      const gainedOutline = hasOutline && !wasOutline;
      const gainedShadow =
        after.boxShadow !== wasShadow && after.boxShadow !== "none";

      if (!gainedOutline && !gainedShadow) {
        findings.push({
          what: "focus indicator",
          where: describe(el),
          detail: "nothing visible changes on focus",
        });
      }
      el.blur();
    }

    return { findings, checked };
  });
}

function report(findings: Finding[]) {
  return findings
    .map((f) => `  [${f.what}] ${f.where}\n      ${f.detail}`)
    .join("\n");
}

// Every part of the audit is one edit away from quietly matching nothing, so
// each kind of check is broken on purpose here and required to be caught.
test("the audit catches the things it claims to check", async ({ page }) => {
  await openDocument(page);

  await page.addStyleTag({
    content: `
      .zoom-controls { color: #d8d8d8 !important; }
      .tool-button { height: 16px !important; width: 16px !important; }
      /* A transparent sheet over everything - the shape of the real defect, where a
         notice stack's empty area swallowed clicks on the chrome beneath it. */
      body::after {
        content: ''; position: fixed; inset: 0; z-index: 9999;
      }
    `,
  });
  await page.evaluate(() => {
    for (const button of document.querySelectorAll(
      ".history-controls button",
    )) {
      button.removeAttribute("aria-label");
      button.removeAttribute("title");
      button.textContent = "";
    }
  });

  const { findings } = await audit(page, []);
  const kinds = new Set(findings.map((finding) => finding.what));

  expect([...kinds].sort(), `\n${report(findings)}\n`).toEqual([
    "accessible name",
    "occluded",
    "target size",
  ]);
});

// 1.4.10 names 320 CSS px as the width content has to survive, and the app has
// @media rules there that nothing else exercises. One scheme is enough.
test.describe("at a 320px viewport", () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test("the home screen still passes", async ({ page }) => {
    const findings: Finding[] = [];

    for (const [name, open] of [["home", openHome]] as const) {
      await open(page);
      const result = await audit(
        page,
        TARGET_SIZE_EXEMPT.map((entry) => entry.selector),
      );
      findings.push(
        ...result.findings.map((finding) => ({
          ...finding,
          where: `[${name} @320] ${finding.where}`,
        })),
      );
    }

    expect(findings, `\n${report(findings)}\n`).toEqual([]);
  });

  // Below 700px the notice stack is docked in flow, and at 320px a floating notice
  // lands on the sidebar toggle, the tool dock and the document controls.
  test("the tabbedapp shell still passes, notices included", async ({
    page,
  }) => {
    const findings: Finding[] = [];

    await openDocument(page);
    // Undo/redo and zoom would otherwise collide at this width; page jumping
    // stays reachable through the sidebar and scrolling, so it drops instead.
    await expect(page.locator(".page-jump-control")).toBeHidden();
    const editable = await audit(
      page,
      TARGET_SIZE_EXEMPT.map((entry) => entry.selector),
    );
    findings.push(
      ...editable.findings.map((finding) => ({
        ...finding,
        where: `[editable @320] ${finding.where}`,
      })),
    );

    await openDocument(page, fixture("test-signed.pdf"));
    await expect(page.locator(".tabbedapp-notice")).toBeVisible();
    const withNotice = await audit(
      page,
      TARGET_SIZE_EXEMPT.map((entry) => entry.selector),
    );
    findings.push(
      ...withNotice.findings.map((finding) => ({
        ...finding,
        where: `[read-only + notice @320] ${finding.where}`,
      })),
    );

    expect(await page.locator(".tabbedapp-notice").count()).toBeGreaterThan(0);
    expect(editable.interactiveChecked).toBeGreaterThan(10);
    expect(withNotice.interactiveChecked).toBeGreaterThan(10);
    expect(findings, `\n${report(findings)}\n`).toEqual([]);
  });
});

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`${colorScheme} scheme`, () => {
    test.use({ colorScheme });

    test("the home screen has no naming or target-size failures", async ({
      page,
    }) => {
      await openHome(page);
      const { findings, interactiveChecked } = await audit(
        page,
        TARGET_SIZE_EXEMPT.map((entry) => entry.selector),
      );

      // A green audit that examined nothing looks exactly like one that examined
      // everything, so the counts are asserted too.
      expect(interactiveChecked).toBeGreaterThan(5);
      expect(findings, `\n${report(findings)}\n`).toEqual([]);
    });

    test("the tabbedapp chrome has no naming or target-size failures", async ({
      page,
    }) => {
      await openDocument(page);

      const closed = await audit(
        page,
        TARGET_SIZE_EXEMPT.map((entry) => entry.selector),
      );

      await page
        .getByRole("button", { name: /show sidebar/i })
        .first()
        .click();
      await expect(
        page.locator(".page-thumbnail-menu-toggle").first(),
      ).toBeVisible();
      await page.locator(".tool-settings-button").first().click();
      await expect(page.locator(".tool-settings-popover")).toBeVisible();

      const open = await audit(
        page,
        TARGET_SIZE_EXEMPT.map((entry) => entry.selector),
      );

      const findings = [...closed.findings, ...open.findings];
      expect(closed.interactiveChecked).toBeGreaterThan(10);
      expect(open.interactiveChecked).toBeGreaterThan(30);
      expect(findings, `\n${report(findings)}\n`).toEqual([]);
    });

    test("every document state passes the same checks", async ({ page }) => {
      const findings: Finding[] = [];
      let checked = 0;

      for (const state of DOCUMENT_STATES) {
        await state.open(page);
        const result = await audit(
          page,
          TARGET_SIZE_EXEMPT.map((entry) => entry.selector),
        );
        checked += result.interactiveChecked;
        findings.push(
          ...result.findings.map((finding) => ({
            ...finding,
            where: `[${state.name}] ${finding.where}`,
          })),
        );
      }

      expect(checked).toBeGreaterThan(DOCUMENT_STATES.length * 3);
      expect(findings, `\n${report(findings)}\n`).toEqual([]);
    });

    test("every menu, popover and dialog passes the same checks", async ({
      page,
    }) => {
      const findings: Finding[] = [];
      let checked = 0;

      for (const state of OVERLAY_STATES) {
        await state.open(page);
        const result = await audit(
          page,
          TARGET_SIZE_EXEMPT.map((entry) => entry.selector),
        );
        checked += result.interactiveChecked;
        findings.push(
          ...result.findings.map((finding) => ({
            ...finding,
            where: `[${state.name}] ${finding.where}`,
          })),
        );
      }

      expect(checked).toBeGreaterThan(OVERLAY_STATES.length * 5);
      expect(findings, `\n${report(findings)}\n`).toEqual([]);
    });

    for (const state of OVERLAY_STATES.filter((entry) =>
      entry.name.endsWith("dialog"),
    )) {
      test(`the ${state.name} manages focus`, async ({ page }) => {
        await state.open(page);
        const dialog = page.locator('[aria-modal="true"]');
        await expect(dialog).toBeVisible();

        const labelledBy = await dialog.getAttribute("aria-labelledby");
        expect(labelledBy, "no aria-labelledby").toBeTruthy();
        const labelText = await page.evaluate(
          (id) => document.getElementById(id)?.textContent?.trim() ?? "",
          labelledBy!,
        );
        expect(
          labelText,
          "the dialog is labelled by an element with no text",
        ).not.toBe("");

        expect(
          await page.evaluate(() =>
            Boolean(
              document
                .querySelector('[aria-modal="true"]')
                ?.contains(document.activeElement),
            ),
          ),
          "focus did not move into the dialog",
        ).toBe(true);

        for (let step = 0; step < 12; step += 1) {
          await page.keyboard.press("Tab");
          const inside = await page.evaluate(() =>
            Boolean(
              document
                .querySelector('[aria-modal="true"]')
                ?.contains(document.activeElement),
            ),
          );
          expect(inside, `focus left the dialog after ${step + 1} tab(s)`).toBe(
            true,
          );
        }

        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
        expect(
          await page.evaluate(
            () => document.activeElement?.tagName.toLowerCase() ?? "none",
          ),
          "focus was dropped when the dialog closed",
        ).not.toBe("body");
      });
    }

    test("every tool and control is reachable by keyboard", async ({
      page,
    }) => {
      await openDocument(page);

      const reached: string[] = [];
      for (let step = 0; step < 60; step += 1) {
        await page.keyboard.press("Tab");
        const name = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el || el === document.body) return null;
          if (el.dataset.a11ySeen) return "";
          el.dataset.a11ySeen = "yes";
          return (
            el.getAttribute("aria-label") ||
            (el.textContent ?? "").trim() ||
            el.getAttribute("title") ||
            el.tagName.toLowerCase()
          );
        });
        if (name === null || name === "") break;
        reached.push(name);
      }

      for (const expected of [
        "Select",
        "Zoom in",
        "Zoom out",
        "Save",
        "Print",
        "Page number",
      ]) {
        expect(reached, `only reached: ${reached.join(", ")}`).toContain(
          expected,
        );
      }
    });

    test("every focusable control shows a focus indicator", async ({
      page,
    }) => {
      await openDocument(page);
      const { findings, checked } = await auditFocus(page);

      expect(checked).toBeGreaterThan(10);
      expect(findings, `\n${report(findings)}\n`).toEqual([]);
    });
  });
}
