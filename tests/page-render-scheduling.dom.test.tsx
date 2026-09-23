import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  promotePendingPageTasks,
  schedulePromotableTask,
  type PendingPageTask,
} from "../src/pdfdocumenteditor/pageRenderScheduling";

// The rule this module exists to hold: a page's render priority decides when its
// work runs, never whether finished work is thrown away, which it did from three
// of PdfPageView's effect dependency arrays, whose cleanups blanked every
// visible canvas on a page boundary.

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

test("visible work runs immediately and registers nothing to promote", () => {
  const pending = new Set<PendingPageTask>();
  let runs = 0;

  schedulePromotableTask(pending, "visible", () => {
    runs += 1;
  });

  assert.equal(runs, 1);
  assert.equal(pending.size, 0, "already-started work is not promotable");
});

test("queued work waits, and promotion starts it exactly once", async () => {
  const pending = new Set<PendingPageTask>();
  let runs = 0;

  schedulePromotableTask(pending, "idle", () => {
    runs += 1;
  });
  assert.equal(runs, 0, "idle work must not run synchronously");
  assert.equal(pending.size, 1);

  promotePendingPageTasks(pending);
  assert.equal(runs, 1);
  assert.equal(pending.size, 0);

  promotePendingPageTasks(pending);
  await flush();
  assert.equal(runs, 1);
});

test("promoting work that already started does nothing", async () => {
  const pending = new Set<PendingPageTask>();
  let runs = 0;

  schedulePromotableTask(pending, "near", () => {
    runs += 1;
  });
  await flush();
  assert.equal(runs, 1, "near work runs on its own");

  promotePendingPageTasks(pending);
  await flush();
  assert.equal(runs, 1, "a re-rank must not restart a rendered page");
});

test("cancelled work is deregistered, so a later promotion cannot resurrect it", async () => {
  const pending = new Set<PendingPageTask>();
  let runs = 0;

  const cancel = schedulePromotableTask(pending, "idle", () => {
    runs += 1;
  });
  cancel();
  assert.equal(pending.size, 0);

  promotePendingPageTasks(pending);
  await flush();
  assert.equal(runs, 0);
});

// Putting the priority back into a dependency array is a one-word edit that no
// type or lint error catches and the pure cases above cannot see, so the arrays
// are read.
const pageViewSource = readFileSync(
  fileURLToPath(
    new URL("../src/pdfdocumenteditor/PdfPageView.tsx", import.meta.url),
  ),
  "utf8",
);

test("no render effect depends on renderPriority", () => {
  const dependencyArrays = [
    ...pageViewSource.matchAll(/\n {2}\}, \[([^\]]*)\]\);/g),
  ].map((match) =>
    match[1]
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );

  // A reformat this parser stops matching would make the assertion below pass over
  // an empty list, so finding fewer arrays than there are effects means the parse
  // went blind rather than the file got simpler.
  const effectCount = [...pageViewSource.matchAll(/\buseEffect\(/g)].length;
  assert.ok(
    effectCount >= 8,
    `parsed suspiciously few effects (${effectCount})`,
  );
  assert.ok(
    dependencyArrays.length >= effectCount,
    `parsed ${dependencyArrays.length} dependency arrays for ${effectCount} effects`,
  );
  assert.ok(
    dependencyArrays.some((names) => names.includes("renderPriorityRef")),
    "expected the render effects to read the priority through its ref",
  );

  const offenders = dependencyArrays.filter(
    (names) => names.includes("renderPriority") && names.length > 1,
  );
  assert.deepEqual(
    offenders,
    [],
    "an effect that re-runs on a priority change tears down the canvas it " +
      "already painted; promote the pending task instead",
  );
});
