import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import "./rendererAssetStubs";

// PdfPageView's hand-written comparator excludes every callback prop on purpose
// because the host passes inline arrows, and adding a data prop while
// forgetting the comparator silently freezes that page, so the prop inventory is
// read out of the source and a new prop fails until it is classified.

const sourcePath = fileURLToPath(
  new URL("../src/pdfdocumenteditor/PdfPageView.tsx", import.meta.url),
);
const source = readFileSync(sourcePath, "utf8");

// PdfPageView pulls in pdf.js's web viewer and pdfRuntime's Vite `?url` asset,
// which the side-effect import above stubs, so this import has to be dynamic to
// run after that registration rather than alongside it.
const { PdfPageView } = await import("../src/pdfdocumenteditor/PdfPageView");

type Props = Record<string, unknown>;
type Comparator = (previous: Props, next: Props) => boolean;

const compare = (PdfPageView as unknown as { compare?: Comparator }).compare;

const DATA_PROPS: Record<string, [unknown, unknown]> = {
  active: [false, true],
  annotations: [[], []],
  focusedAnnotationId: [null, "annotation-1"],
  page: [{ pageNumber: 1 }, { pageNumber: 2 }],
  pageCount: [3, 4],
  pageIndex: [0, 1],
  readOnly: [false, true],
  renderPriority: ["visible", "near"],
  scale: [1, 2],
  selectedAnnotationIds: [[], ["annotation-1"]],
  showAnnotations: [true, false],
  tool: ["select", "draw"],
  toolSettings: [{}, {}],
};

function declaredProps() {
  const block = /\ntype PdfPageViewProps = \{\n([\s\S]*?)\n\};\n/.exec(source);
  assert.ok(block, "could not find the PdfPageViewProps declaration");

  const members = [...block[1].matchAll(/^ {2}(\w+)\??: (.*)$/gm)].map(
    (match) => ({
      isCallback: match[2].trimStart().startsWith("("),
      name: match[1],
    }),
  );

  const callbacks = members
    .filter((member) => member.isCallback)
    .map((member) => member.name);
  const data = members
    .filter((member) => !member.isCallback)
    .map((member) => member.name);

  // If the declaration is ever reformatted past this parser, fail here rather than
  // quietly testing an empty prop list.
  assert.ok(data.length > 5, "parsed suspiciously few data props");
  assert.ok(callbacks.length > 5, "parsed suspiciously few callback props");
  assert.ok(data.includes("annotations"), "expected a known data prop");
  assert.ok(callbacks.includes("onAddAnnotation"), "expected a known callback");

  return { callbacks, data };
}

const { callbacks, data } = declaredProps();

const noop = () => undefined;

function baseProps(): Props {
  const props: Props = {};
  for (const name of callbacks) {
    props[name] = noop;
  }
  for (const name of data) {
    props[name] = DATA_PROPS[name]?.[0];
  }
  return props;
}

function withProp(name: string, value: unknown): Props {
  return { ...baseProps(), [name]: value };
}

test("every declared data prop has a fixture entry", () => {
  assert.deepEqual([...data].sort(), Object.keys(DATA_PROPS).sort());
});

test("changing any data prop forces a re-render", () => {
  for (const name of data) {
    const [, changed] = DATA_PROPS[name];
    assert.equal(
      compare?.(baseProps(), withProp(name, changed)),
      false,
      `${name} is not compared, so that page would stop updating`,
    );
  }
});

test("changing only a callback prop does not force a re-render", () => {
  for (const name of callbacks) {
    assert.equal(
      compare?.(
        baseProps(),
        withProp(name, () => undefined),
      ),
      true,
      `${name} is compared, so every gesture would re-render this page`,
    );
  }
});

test("selectedAnnotationIds is compared by value, not identity", () => {
  const previous = withProp("selectedAnnotationIds", ["a", "b"]);
  assert.equal(
    compare?.(previous, withProp("selectedAnnotationIds", ["a", "b"])),
    true,
  );
  assert.equal(
    compare?.(previous, withProp("selectedAnnotationIds", ["b", "a"])),
    false,
  );
  assert.equal(
    compare?.(previous, withProp("selectedAnnotationIds", ["a"])),
    false,
  );
});
