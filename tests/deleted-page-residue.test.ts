// The probes are in tests/probes/; the readers in tests/pdf-inspect.ts measure
// the written bytes rather than agreeing with the implementation.
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
  type PDFObject,
} from "pdf-lib";
import {
  applyStructuralOperation,
  extractPagesBytes,
  invertStructuralOperation,
  movePageBy,
  removePage,
  removePagesRange,
  rotatePageByDelta,
  type PdfStructuralOperation,
} from "../src/pdfdocumenteditor/pdfPageOperations";
import {
  SECRET,
  danglingPointers,
  fieldNamed,
  getDocument,
  markersIn,
  pdfJsFieldNames,
  readBack,
  structTreeOfKeptPage,
  structureIdentifiers,
  structureTexts,
  widgetExports,
} from "./pdf-inspect";
import { loadTestPdf, readFixture } from "./pdfTestUtils";
import {
  cappedContentProbePdf,
  contentReadingProbePdf,
  CONTENT_READING_SHAPES,
  repeatedDrawProbePdf,
} from "./probes/content-reading";
import {
  inheritedResourcesProbePdf,
  INHERITED_RESOURCE_ENTRIES,
  letterheadProbePdf,
  LETTERHEAD_ENTRIES,
  type LetterheadDrawing,
} from "./probes/letterhead";
import { markedContent } from "./probes/parts";
import { placementProbePdf } from "./probes/placement";
import { buttonProbePdf, pointerProbePdf } from "./probes/pointers";
import { probePdf } from "./probes/residue";
import {
  sharedObjectProbePdf,
  sharedRouteMarkers,
  SHARED_ROUTES,
  SHARED_ROUTE_KEY,
  SHARED_ROUTE_SECRETS,
  type SharedRoute,
} from "./probes/shared-objects";
import {
  classMapProbePdf,
  sharedAltProbePdf,
  taggedProbePdf,
} from "./probes/tagging";

// Both storage spellings: a save's spelling decides whether residue is a plain
// object or one compressed into an object stream.
const droppingOperations: {
  drop: (bytes: Uint8Array, pageIndex: number) => Promise<Uint8Array>;
  name: string;
}[] = [
  {
    drop: async (bytes, pageIndex) =>
      (await removePage(bytes, pageIndex)).bytes,
    name: "removePage",
  },
  {
    drop: async (bytes, pageIndex) =>
      (await removePagesRange(bytes, pageIndex, 1)).bytes,
    name: "removePagesRange",
  },
  {
    drop: async (bytes, pageIndex) =>
      (
        await applyStructuralOperation(bytes, {
          count: 1,
          startIndex: pageIndex,
          type: "removePages",
        })
      ).bytes,
    name: "applyStructuralOperation(removePages)",
  },
];

describe("objects a deleted page owned", () => {
  for (const useObjectStreams of [false, true]) {
    for (const { drop, name } of droppingOperations) {
      test(`${name} leaves nothing the deleted page owned (object streams: ${useObjectStreams})`, async () => {
        const bytes = await probePdf(useObjectStreams);
        const before = await markersIn(bytes);
        const left = [...before].filter((marker) => SECRET.test(marker));
        assert.ok(
          left.length >= 18,
          `the probe page must own something to lose: ${left.length}`,
        );

        const after = await markersIn(await drop(bytes, 0));
        assert.deepEqual(
          [...after].filter((marker) => SECRET.test(marker)).sort(),
          [],
        );
      });

      test(`${name} keeps everything the rest of the document reaches (object streams: ${useObjectStreams})`, async () => {
        const bytes = await probePdf(useObjectStreams);
        const before = await markersIn(bytes);
        const after = await markersIn(await drop(bytes, 0));
        // Every non-SECRET marker is a control; excluding any by prefix would swallow
        // a later marker.
        const controls = [...before].filter((marker) => !SECRET.test(marker));
        for (const marker of controls) {
          assert.ok(after.has(marker), `${marker} was lost`);
        }
      });

      test(`${name} takes only the page it was asked for (object streams: ${useObjectStreams})`, async () => {
        const bytes = await probePdf(useObjectStreams);
        const before = await markersIn(bytes);
        const after = await markersIn(await drop(bytes, 1));
        for (const marker of [...before].filter((marker) =>
          SECRET.test(marker),
        )) {
          assert.ok(after.has(marker), `${marker} was lost`);
        }
      });
    }

    test(`relinking operations drop nothing (object streams: ${useObjectStreams})`, async () => {
      const bytes = await probePdf(useObjectStreams);
      const before = await markersIn(bytes);
      for (const [name, moved] of [
        ["movePageBy", await movePageBy(bytes, 0, 1)],
        ["rotatePageByDelta", await rotatePageByDelta(bytes, 0, 90)],
      ] as const) {
        const after = await markersIn(moved);
        for (const marker of before) {
          assert.ok(after.has(marker), `${name} lost ${marker}`);
        }
      }
    });

    test(`an annotation a surviving page also lists is kept (object streams: ${useObjectStreams})`, async () => {
      const doc = await PDFDocument.create();
      const { context } = doc;
      const shared = context.register(
        context.obj({
          Contents: PDFHexString.fromText("SHARED-annotation"),
          Rect: [72, 700, 92, 720],
          Subtype: "Text",
          Type: "Annot",
        }),
      );
      const pages = [doc.addPage([612, 792]), doc.addPage([612, 792])];
      for (const page of pages) {
        page.node.set(PDFName.of("Annots"), context.obj([shared]));
      }
      const bytes = await doc.save({
        updateFieldAppearances: false,
        useObjectStreams,
      });

      const after = await markersIn((await removePage(bytes, 0)).bytes);
      assert.ok(after.has("SHARED-annotation"));
    });

    test(`the undo of a delete brings the page's objects back (object streams: ${useObjectStreams})`, async () => {
      const bytes = await probePdf(useObjectStreams);
      const before = await markersIn(bytes);
      const secrets = [...before]
        .filter((marker) => SECRET.test(marker))
        // Not one of the page's objects: it lives on the catalog's structure tree,
        // so no copy of the page carries it.
        .filter((marker) => marker !== "SECRET-struct-alt-on-deleted-page")
        .sort();

      const deletion: PdfStructuralOperation = {
        count: 1,
        startIndex: 0,
        type: "removePages",
      };
      // Built the way handleDeletePage builds it: from the document before the delete.
      const undo = await invertStructuralOperation(deletion, bytes);
      const deleted = (await applyStructuralOperation(bytes, deletion)).bytes;
      assert.deepEqual(
        [...(await markersIn(deleted))].filter((marker) => SECRET.test(marker)),
        [],
      );

      const undone = (await applyStructuralOperation(deleted, undo)).bytes;
      assert.equal((await loadTestPdf(undone)).getPageCount(), 2);
      const restored = await markersIn(undone);
      for (const marker of secrets) {
        assert.ok(restored.has(marker), `${marker} did not come back`);
      }

      const redo = await invertStructuralOperation(undo, undone);
      const redone = (await applyStructuralOperation(undone, redo)).bytes;
      assert.equal((await loadTestPdf(redone)).getPageCount(), 1);
      assert.deepEqual(
        [...(await markersIn(redone))].filter((marker) => SECRET.test(marker)),
        [],
      );
    });

    test(`a page extracted for undo still carries what was on it (object streams: ${useObjectStreams})`, async () => {
      const bytes = await probePdf(useObjectStreams);
      const extracted = await extractPagesBytes(bytes, 0, 1);
      const carried = await markersIn(extracted.bytes);
      assert.ok(carried.has("SECRET-note-contents"));
      assert.ok(carried.has("SECRET-page-content"));
    });
  }

  test("a page object another slot still lists is kept", async () => {
    const doc = await PDFDocument.create();
    const { context } = doc;
    const page = doc.addPage([612, 792]);
    page.node.set(
      PDFName.of("Annots"),
      context.obj([
        context.register(
          context.obj({
            Contents: PDFHexString.fromText(
              "KEEP-note-on-the-listed-twice-page",
            ),
            P: page.ref,
            Rect: [72, 700, 92, 720],
            Subtype: "Text",
            Type: "Annot",
          }),
        ),
      ]),
    );
    const tree = doc.catalog.lookup(PDFName.of("Pages"), PDFDict);
    tree.lookup(PDFName.of("Kids"), PDFArray).push(page.ref);
    tree.set(PDFName.of("Count"), PDFNumber.of(2));
    const bytes = await doc.save({
      updateFieldAppearances: false,
      useObjectStreams: false,
    });

    const after = (await removePage(bytes, 0)).bytes;
    assert.equal((await loadTestPdf(after)).getPageCount(), 1);
    assert.ok(
      (await markersIn(after)).has("KEEP-note-on-the-listed-twice-page"),
    );
  });

  test("a form field whose only widget was on the deleted page goes with it", async () => {
    const doc = await PDFDocument.create();
    const { context } = doc;
    const pages = [doc.addPage([612, 792]), doc.addPage([612, 792])];
    const widget = (page: (typeof pages)[number]) =>
      context.register(
        context.obj({
          P: page.ref,
          Rect: [72, 300, 300, 320],
          Subtype: "Widget",
          Type: "Annot",
        }),
      );

    const onlyWidget = widget(pages[0]);
    const goneField = context.register(
      context.obj({
        FT: "Tx",
        Kids: [onlyWidget],
        T: PDFString.of("field-on-the-deleted-page"),
        V: PDFString.of("SECRET-typed-into-the-deleted-page"),
      }),
    );
    const sharedWidgets = [widget(pages[0]), widget(pages[1])];
    const keptField = context.register(
      context.obj({
        FT: "Tx",
        Kids: sharedWidgets,
        T: PDFString.of("field-on-both-pages"),
        V: PDFString.of("KEEP-typed-into-both-pages"),
      }),
    );
    for (const [fieldRef, kids] of [
      [goneField, [onlyWidget]],
      [keptField, sharedWidgets],
    ] as const) {
      for (const kid of kids) {
        context.lookup(kid, PDFDict).set(PDFName.of("Parent"), fieldRef);
      }
    }
    pages[0].node.set(
      PDFName.of("Annots"),
      context.obj([onlyWidget, sharedWidgets[0]]),
    );
    pages[1].node.set(PDFName.of("Annots"), context.obj([sharedWidgets[1]]));
    doc.catalog.set(
      PDFName.of("AcroForm"),
      context.obj({ Fields: [goneField, keptField] }),
    );

    const bytes = await doc.save({
      updateFieldAppearances: false,
      useObjectStreams: false,
    });
    assert.ok(
      (await markersIn(bytes)).has("SECRET-typed-into-the-deleted-page"),
    );

    const after = await markersIn((await removePage(bytes, 0)).bytes);
    assert.equal(after.has("SECRET-typed-into-the-deleted-page"), false);
    assert.ok(after.has("KEEP-typed-into-both-pages"));
  });

  // pdf-lib allocates above the highest number it has seen, and the orphans the
  // removal above now deletes were what kept that ceiling up.
  test("no page operation gives one annotation's number to another", async () => {
    const doc = await PDFDocument.create();
    const { context } = doc;
    for (const texts of [["p0a", "p0b"], ["p1"], [], ["p3a", "p3b"]]) {
      const page = doc.addPage([612, 792]);
      if (texts.length === 0) {
        continue;
      }
      page.node.set(
        PDFName.of("Annots"),
        context.obj(
          texts.map((text, index) =>
            context.register(
              context.obj({
                Contents: PDFHexString.fromText(text),
                P: page.ref,
                Rect: [72, 700 - index * 40, 92, 720 - index * 40],
                Subtype: "Text",
                Type: "Annot",
              }),
            ),
          ),
        ),
      );
    }
    let bytes = await doc.save({
      updateFieldAppearances: false,
      useObjectStreams: false,
    });

    const namedSoFar = new Map<string, string>();
    const record = async (step: string) => {
      const loaded = await loadTestPdf(bytes);
      for (const page of loaded.getPages()) {
        const annots = page.node.Annots();
        for (let index = 0; index < (annots?.size() ?? 0); index += 1) {
          const entry = annots?.get(index);
          const text = annots
            ?.lookupMaybe(index, PDFDict)
            ?.lookupMaybe(PDFName.of("Contents"), PDFString, PDFHexString)
            ?.decodeText();
          if (!(entry instanceof PDFRef) || !text) {
            continue;
          }
          const name = entry.toString();
          const held = namedSoFar.get(name);
          assert.ok(
            held === undefined || held === text,
            `${step}: ${name} named ${held} and now names ${text}`,
          );
          namedSoFar.set(name, text);
        }
      }
    };

    // The order that makes a collision reachable: each undo re-creates objects
    // while the other delete's entry still names the numbers it took.
    await record("start");
    const deleteLast: PdfStructuralOperation = {
      count: 1,
      startIndex: 3,
      type: "removePages",
    };
    const undoLast = await invertStructuralOperation(deleteLast, bytes);
    bytes = (await applyStructuralOperation(bytes, deleteLast)).bytes;
    await record("after deleting the last page");

    const deleteFirst: PdfStructuralOperation = {
      count: 1,
      startIndex: 0,
      type: "removePages",
    };
    const undoFirst = await invertStructuralOperation(deleteFirst, bytes);
    bytes = (await applyStructuralOperation(bytes, deleteFirst)).bytes;
    await record("after deleting the first page");

    bytes = (await applyStructuralOperation(bytes, undoFirst)).bytes;
    await record("after undoing the first delete");

    bytes = (await applyStructuralOperation(bytes, undoLast)).bytes;
    await record("after undoing the last delete");
  });
});

// A pointer left naming a deleted object is invisible to the markers above, so
// these read the written bytes back through both readers instead.

describe("pointers to what a delete removed", () => {
  for (const useObjectStreams of [false, true]) {
    for (const { drop, name } of droppingOperations) {
      test(`${name} writes a file both readers still read (object streams: ${useObjectStreams})`, async () => {
        const bytes = await probePdf(useObjectStreams);
        const before = await readBack(
          bytes,
          "before the delete",
          "KEEP-dest-on-kept-page",
        );
        assert.deepEqual(before.fieldNames, ["field-on-page-0"]);

        const after = await readBack(
          await drop(bytes, 0),
          name,
          "KEEP-dest-on-kept-page",
        );
        assert.equal(after.pageCount, 1);
        assert.deepEqual(after.fieldNames, []);
        assert.deepEqual(after.outlineTitles, before.outlineTitles);
        assert.ok(
          after.namedDestination,
          "the kept page's named destination stopped resolving",
        );
        assert.equal(after.annotationCount, 1);
        assert.deepEqual(after.ocgOrder, before.ocgOrder);
      });

      test(`${name} leaves no pointer to a deleted object in a list of objects (object streams: ${useObjectStreams})`, async () => {
        const bytes = await pointerProbePdf(useObjectStreams);
        assert.deepEqual(
          await danglingPointers(bytes),
          { coordinates: [], inLists: [] },
          "the probe starts with no dangling pointer at all",
        );

        const after = await drop(bytes, 0);
        const dangling = await danglingPointers(after);
        assert.deepEqual(dangling.inLists, []);

        // Coordinates are left dangling deliberately: their entries are positional,
        // so pruning one would corrupt it.
        assert.deepEqual(dangling.coordinates.sort(), [
          "/Root/Names/Dests/Names[3][0]",
          "/Root/OpenAction[0]",
          "/Root/Outlines/First/Dest[0]",
          "/Root/Pages/Kids[0]/Annots[3]/Popup",
          "/Root/Pages/Kids[0]/Annots[4]/IRT",
          "/Root/Pages/Kids[0]/Annots[5]/Dest[0]",
          "/Root/StructTreeRoot/K[0]/K[0]/Obj",
          "/Root/StructTreeRoot/K[0]/Pg",
          "/Root/Threads[0]/F/P",
        ]);
      });

      test(`${name} keeps a form the reader can still use (object streams: ${useObjectStreams})`, async () => {
        const bytes = await pointerProbePdf(useObjectStreams);
        const before = await readBack(
          bytes,
          "before the delete",
          "KEEP-dest-on-kept-page",
        );
        assert.deepEqual(before.fieldNames, [
          "button",
          "holderless",
          "merged",
          "radio",
          "surviving",
        ]);
        assert.deepEqual(before.structTreeAlts, ["KEEP-alt-on-the-kept-page"]);

        const after = await readBack(
          await drop(bytes, 0),
          name,
          "KEEP-dest-on-kept-page",
        );
        assert.deepEqual(after.fieldNames, ["button", "radio", "surviving"]);
        assert.deepEqual(after.structTreeAlts, ["KEEP-alt-on-the-kept-page"]);
        assert.deepEqual(after.outlineTitles, before.outlineTitles);
        assert.ok(
          after.namedDestination,
          "the kept page's named destination stopped resolving",
        );
      });

      test(`${name} keeps a button's options lined up with its widgets (object streams: ${useObjectStreams})`, async () => {
        const bytes = await pointerProbePdf(useObjectStreams);
        const after = await loadTestPdf(await drop(bytes, 0));
        const radio = fieldNamed(after, "radio");
        const kids = radio?.lookup(PDFName.of("Kids"), PDFArray);
        const options = radio?.lookup(PDFName.of("Opt"), PDFArray);
        assert.equal(kids?.size(), 1);
        assert.deepEqual(
          options
            ?.asArray()
            .map((option) => (option as PDFString).decodeText()),
          ["EXPORT-of-the-kept-page"],
        );
      });
    }
  }
});

describe("what a tagged PDF says about the page", () => {
  const TAGGED_PROBE_SECRETS = [
    "/A SECRET-a-array-with-revisions-first",
    "/A SECRET-a-array-with-revisions-second",
    "/A SECRET-a-array-with-revisions-second-stream-bytes",
    "/A SECRET-a-single-dictionary",
    "/A SECRET-a-single-stream",
    "/A SECRET-a-single-stream-stream-bytes",
    "/A SECRET-inline-attribute",
    "/A SECRET-userproperty-name",
    "/A SECRET-userproperty-value",
    "/AF SECRET-attached-file-bytes",
    "/AF SECRET-attached-file-description",
    "/AF SECRET-attached-file-name",
    "/AF SECRET-attached-file-unicode-name",
    "/AF SECRET-tree-root-associated-file-bytes",
    "/AF SECRET-tree-root-associated-file-description",
    "/AF SECRET-tree-root-associated-file-name",
    "/AF SECRET-tree-root-associated-file-unicode-name",
    "/ActualText SECRET-actual-text",
    "/Alt SECRET-alt",
    "/Alt SECRET-sect-alt-with-no-page-of-its-own",
    "/C SECRET-class-array-first",
    "/C SECRET-class-array-second",
    "/C SECRET-class-name",
    "/C SECRET-class-with-revision",
    "/ClassMap SECRET-class-array-first",
    "/ClassMap SECRET-class-array-first-second-summary",
    "/ClassMap SECRET-class-array-first-summary",
    "/ClassMap SECRET-class-array-second",
    "/ClassMap SECRET-class-array-second-summary",
    "/ClassMap SECRET-class-array-second-summary-stream-bytes",
    "/ClassMap SECRET-class-name",
    "/ClassMap SECRET-class-with-revision",
    "/ClassMap SECRET-class-with-revision-summary",
    "/ClassMap SECRET-classmap-attribute",
    "/E SECRET-expansion",
    "/ID SECRET-element-id",
    "/ID SECRET-sect-element-id",
    "/IDTree SECRET-element-id",
    "/IDTree SECRET-sect-element-id",
    "/Lang SECRET-lang",
    "/NS SECRET-declared-namespace-uri",
    "/NS SECRET-namespace-schema-bytes",
    "/NS SECRET-namespace-schema-description",
    "/NS SECRET-namespace-schema-name",
    "/NS SECRET-namespace-schema-unicode-name",
    "/NS SECRET-namespace-uri",
    "/NS SECRET-namespaced-role",
    "/Namespaces SECRET-declared-namespace-uri",
    "/Namespaces SECRET-namespace-schema-bytes",
    "/Namespaces SECRET-namespace-schema-description",
    "/Namespaces SECRET-namespace-schema-name",
    "/Namespaces SECRET-namespace-schema-unicode-name",
    "/Namespaces SECRET-namespaced-role",
    "/Phoneme SECRET-phoneme",
    "/PhoneticAlphabet SECRET-phonetic-alphabet",
    "/PronunciationLexicon SECRET-pronunciation-lexicon-bytes",
    "/PronunciationLexicon SECRET-pronunciation-lexicon-description",
    "/PronunciationLexicon SECRET-pronunciation-lexicon-name",
    "/PronunciationLexicon SECRET-pronunciation-lexicon-unicode-name",
    "/RoleMap SECRET-custom-role",
    "/S SECRET-custom-role",
    "/S SECRET-namespaced-role",
    "/SECRET-extension-key SECRET-extension-key",
    "/SECRET-extension-key SECRET-extension-value",
    "/T SECRET-sect-title-with-no-page-of-its-own",
    "/T SECRET-title",
  ];

  // The document's own vocabulary and attachments: declared once for the file,
  // named by no page, and asserted as a list so a tenth survivor fails by name.
  const TAGGED_PROBE_VOCABULARY = [
    "/AF SECRET-tree-root-associated-file-bytes",
    "/AF SECRET-tree-root-associated-file-description",
    "/AF SECRET-tree-root-associated-file-name",
    "/AF SECRET-tree-root-associated-file-unicode-name",
    "/Namespaces SECRET-declared-namespace-uri",
    "/Namespaces SECRET-namespace-schema-bytes",
    "/Namespaces SECRET-namespace-schema-description",
    "/Namespaces SECRET-namespace-schema-name",
    "/Namespaces SECRET-namespace-schema-unicode-name",
    "/Namespaces SECRET-namespaced-role",
    "/PronunciationLexicon SECRET-pronunciation-lexicon-bytes",
    "/PronunciationLexicon SECRET-pronunciation-lexicon-description",
    "/PronunciationLexicon SECRET-pronunciation-lexicon-name",
    "/PronunciationLexicon SECRET-pronunciation-lexicon-unicode-name",
    "/RoleMap SECRET-custom-role",
  ];

  for (const useObjectStreams of [false, true]) {
    for (const { drop, name } of droppingOperations) {
      test(`${name} takes everything the structure said about the deleted page (object streams: ${useObjectStreams})`, async () => {
        const bytes = await taggedProbePdf(useObjectStreams);
        const before = await structureTexts(bytes);
        assert.deepEqual(
          before.filter((text) => SECRET.test(text.split(" ")[1] ?? "")),
          TAGGED_PROBE_SECRETS,
          "the probe must carry text in every place the specification allows one",
        );

        const dropped = await drop(bytes, 0);
        const after = await structureTexts(dropped);
        assert.deepEqual(
          after.filter((text) => SECRET.test(text.split(" ")[1] ?? "")),
          TAGGED_PROBE_VOCABULARY,
        );
        assert.deepEqual(
          after.filter((text) => !SECRET.test(text.split(" ")[1] ?? "")),
          before.filter((text) => !SECRET.test(text.split(" ")[1] ?? "")),
        );

        assert.deepEqual(
          [...(await markersIn(dropped))]
            .filter((marker) => SECRET.test(marker))
            .sort(),
          TAGGED_PROBE_VOCABULARY.map((entry) => entry.split(" ")[1]).sort(),
        );
      });

      test(`${name} leaves the structure tree's shape alone (object streams: ${useObjectStreams})`, async () => {
        const bytes = await taggedProbePdf(useObjectStreams);
        const before = await structTreeOfKeptPage(bytes, 2);
        assert.ok(
          before.includes("KEEP-alt-of-the-kept-page"),
          "probe precondition",
        );

        const dropped = await drop(bytes, 0);
        assert.equal(await structTreeOfKeptPage(dropped, 1), before);
        assert.equal((await loadTestPdf(dropped)).getPageCount(), 1);
      });

      test(`${name} takes the deleted element's identifier out of the name tree (object streams: ${useObjectStreams})`, async () => {
        const bytes = await taggedProbePdf(useObjectStreams);
        assert.deepEqual(await structureIdentifiers(bytes), [
          " limits none",
          "/0 limits KEEP-element-id..KEEP-element-id",
          "/0 KEEP-element-id -> an element",
          "/1 limits KEEP-second-element-id..SECRET-element-id",
          "/1 KEEP-second-element-id -> an element",
          "/1 SECRET-element-id -> an element",
          "/2 limits SECRET-sect-element-id..SECRET-sect-element-id",
          "/2 SECRET-sect-element-id -> an element",
        ]);

        assert.deepEqual(await structureIdentifiers(await drop(bytes, 0)), [
          " limits none",
          "/0 limits KEEP-element-id..KEEP-element-id",
          "/0 KEEP-element-id -> an element",
          "/1 limits KEEP-second-element-id..KEEP-second-element-id",
          "/1 KEEP-second-element-id -> an element",
        ]);
      });

      test(`${name} takes only the words of the page it was asked for (object streams: ${useObjectStreams})`, async () => {
        const bytes = await taggedProbePdf(useObjectStreams);
        const before = await structureTexts(bytes);
        const after = await structureTexts(await drop(bytes, 1));
        for (const text of before.filter((entry) =>
          SECRET.test(entry.split(" ")[1] ?? ""),
        )) {
          assert.ok(after.includes(text), `${text} was lost`);
        }
      });
    }

    test(`relinking operations keep every description (object streams: ${useObjectStreams})`, async () => {
      const bytes = await taggedProbePdf(useObjectStreams);
      const before = await structureTexts(bytes);
      for (const [name, moved] of [
        ["movePageBy", await movePageBy(bytes, 0, 1)],
        ["rotatePageByDelta", await rotatePageByDelta(bytes, 0, 90)],
      ] as const) {
        assert.deepEqual(
          await structureTexts(moved),
          before,
          `${name} changed the tagged text`,
        );
      }
    });

    // Recorded, not fixed: the undo restores the page under a new number while the
    // elements' /Pg still names the object that left, so nothing reconnects.
    test(`the undo of a delete cannot bring the descriptions back (object streams: ${useObjectStreams})`, async () => {
      const bytes = await taggedProbePdf(useObjectStreams);
      const deletion: PdfStructuralOperation = {
        count: 1,
        startIndex: 0,
        type: "removePages",
      };
      const undo = await invertStructuralOperation(deletion, bytes);
      const deleted = (await applyStructuralOperation(bytes, deletion)).bytes;
      assert.deepEqual(
        (await structureTexts(deleted)).filter((text) =>
          SECRET.test(text.split(" ")[1] ?? ""),
        ),
        TAGGED_PROBE_VOCABULARY,
      );

      const undone = (await applyStructuralOperation(deleted, undo)).bytes;
      assert.equal((await loadTestPdf(undone)).getPageCount(), 2);
      assert.deepEqual(
        (await structureTexts(undone)).filter((text) =>
          SECRET.test(text.split(" ")[1] ?? ""),
        ),
        TAGGED_PROBE_VOCABULARY,
      );

      const restored = await loadTestPdf(undone);
      const root = restored.catalog.lookup(
        PDFName.of("StructTreeRoot"),
        PDFDict,
      );
      const orphan = root
        .lookup(PDFName.of("K"), PDFArray)
        .lookupMaybe(0, PDFDict)
        ?.lookupMaybe(PDFName.of("K"), PDFArray)
        ?.lookupMaybe(0, PDFDict);
      const page = orphan?.get(PDFName.of("Pg"));
      assert.ok(
        page instanceof PDFRef,
        "the probe's first element must name a page",
      );
      assert.equal(restored.context.lookup(page), undefined);
      assert.equal(
        await structTreeOfKeptPage(undone, 1),
        '{"children":[],"role":"Root"}',
      );
    });
  }

  // The fixture's own producer emits StructTreeRoot -> /Document -> /P with the
  // /Document naming no page, which a gate asking each element for its /Pg skips.
  test("a description on a /Document element the fixture's own producer emits goes with the page", async () => {
    const pdfDoc = await loadTestPdf(await readFixture("test-annotated.pdf"));
    pdfDoc.addPage([612, 792]);
    const root = pdfDoc.catalog.lookup(PDFName.of("StructTreeRoot"), PDFDict);
    const documentElement = root
      .lookup(PDFName.of("K"), PDFArray)
      .lookup(0, PDFDict);
    assert.deepEqual(
      documentElement.keys().map(String).sort(),
      ["/K", "/P", "/S", "/Type"],
      "the fixture's /Document element must name no page of its own",
    );
    documentElement.set(
      PDFName.of("Alt"),
      PDFString.of("SECRET-alt-on-the-document-element"),
    );
    documentElement.set(
      PDFName.of("T"),
      PDFString.of("SECRET-title-on-the-document-element"),
    );
    documentElement
      .lookup(PDFName.of("K"), PDFArray)
      .lookup(0, PDFDict)
      .set(PDFName.of("Alt"), PDFString.of("SECRET-alt-on-the-paragraph"));

    const bytes = await pdfDoc.save({ updateFieldAppearances: false });
    assert.equal(
      [...(await markersIn(bytes))].filter((marker) => SECRET.test(marker))
        .length,
      3,
      "the fixture must have something to lose",
    );

    const after = (await removePage(bytes, 0)).bytes;
    assert.deepEqual(
      [...(await markersIn(after))].filter((marker) => SECRET.test(marker)),
      [],
    );
  });

  test("an element no page places keeps its description", async () => {
    const after = (await removePage(await taggedProbePdf(false), 0)).bytes;
    assert.ok(
      (await structureTexts(after)).includes(
        "/Alt KEEP-alt-of-an-element-no-page-places",
      ),
    );
  });
});

describe("what places a structure element", () => {
  // A shared /Resources has the XObject's key claimed from both sides and no page
  // here draws it, so nothing places the element and its own /Pg decides.
  const AMBIGUOUS_KEY_RESIDUE = ["/Alt SECRET-placed-by-a-form-xobject-key"];

  for (const spelling of ["kids", "nums"] as const) {
    for (const resources of ["own", "shared"] as const) {
      for (const { drop, name } of droppingOperations) {
        const useObjectStreams = spelling === "kids";
        const shape = `${spelling}, ${resources} /Resources`;
        test(`${name} takes what only the /ParentTree places on the deleted page (${shape})`, async () => {
          const bytes = await placementProbePdf(
            useObjectStreams,
            spelling,
            resources,
          );
          const before = await structureTexts(bytes);
          assert.deepEqual(
            before.filter((text) => SECRET.test(text.split(" ")[1] ?? "")),
            [
              "/Alt SECRET-mixed-leaf-on-the-deleted-page",
              "/Alt SECRET-placed-by-a-form-xobject-key",
              "/Alt SECRET-placed-by-a-form-xobject-key-with-a-page",
              "/Alt SECRET-placed-by-an-annotation-key",
              "/Alt SECRET-placed-by-the-deleted-page-key",
            ],
            "the probe must place text through every mechanism",
          );

          const dropped = await drop(bytes, 0);
          const left = (await structureTexts(dropped)).filter((text) =>
            SECRET.test(text.split(" ")[1] ?? ""),
          );
          assert.deepEqual(
            left,
            resources === "shared" ? AMBIGUOUS_KEY_RESIDUE : [],
          );
          assert.deepEqual(
            [...(await markersIn(dropped))]
              .filter((marker) => SECRET.test(marker))
              .sort(),
            resources === "shared"
              ? ["SECRET-placed-by-a-form-xobject-key"]
              : [],
          );
        });

        test(`${name} keeps what any mechanism places on the page that stays (${shape})`, async () => {
          const bytes = await placementProbePdf(
            useObjectStreams,
            spelling,
            resources,
          );
          const before = await structureTexts(bytes);
          const dropped = await drop(bytes, 0);
          const after = await structureTexts(dropped);
          for (const text of before.filter(
            (entry) => !SECRET.test(entry.split(" ")[1] ?? ""),
          )) {
            assert.ok(after.includes(text), `${text} was lost`);
          }
        });
      }
    }

    const useObjectStreams = spelling === "kids";
    for (const resources of ["own", "shared"] as const) {
      test(`the page that stays keeps the structure a reader reads (${spelling}, ${resources} /Resources)`, async () => {
        const bytes = await placementProbePdf(
          useObjectStreams,
          spelling,
          resources,
        );
        const before = await structTreeOfKeptPage(bytes, 2);
        assert.ok(
          before.includes("KEEP-alt-the-parent-tree-places-on-the-kept-page"),
          "probe precondition",
        );
        assert.equal(
          await structTreeOfKeptPage((await removePage(bytes, 0)).bytes, 1),
          before,
        );
      });
    }

    for (const resources of ["own", "shared"] as const) {
      test(`placement takes only the words of the page it was asked for (${spelling}, ${resources} /Resources)`, async () => {
        const bytes = await placementProbePdf(
          useObjectStreams,
          spelling,
          resources,
        );
        const before = await structureTexts(bytes);
        const after = await structureTexts((await removePage(bytes, 1)).bytes);
        for (const text of before.filter((entry) =>
          SECRET.test(entry.split(" ")[1] ?? ""),
        )) {
          assert.ok(after.includes(text), `${text} was lost`);
        }
      });
    }
  }
});

describe("an object two pages share", () => {
  const ANNOTATION_HELD_ROUTES: ReadonlySet<SharedRoute> = new Set([
    "aa",
    "hide-t",
    "irt",
    "next",
    "pieceinfo",
    "popup",
  ]);

  // Recorded, not fixed: these holders are listed by no /Annots, drawn by no
  // content and reachable from both sides, so nothing says whose page they are.
  const ROUTES_NOTHING_PLACES: ReadonlySet<SharedRoute> = new Set([
    "bead",
    "ocmd",
    "resources",
  ]);

  for (const route of SHARED_ROUTES) {
    test(`a reference through ${route} into the deleted page does not keep what the element's own /Pg gives up`, async () => {
      const bytes = await sharedObjectProbePdf(route, true);
      const before = [...(await markersIn(bytes))].filter((marker) =>
        SECRET.test(marker),
      );
      for (const secret of SHARED_ROUTE_SECRETS) {
        assert.ok(before.includes(secret), `the probe must carry ${secret}`);
      }

      const after = [
        ...(await markersIn((await removePage(bytes, 0)).bytes)),
      ].filter((marker) => SECRET.test(marker));
      assert.deepEqual(after.sort(), []);
    });

    test(`a reference through ${route} keeps what the page that stays says`, async () => {
      const bytes = await sharedObjectProbePdf(route, true);
      const before = [...(await markersIn(bytes))].filter(
        (marker) => !SECRET.test(marker),
      );
      const after = await markersIn((await removePage(bytes, 0)).bytes);
      for (const marker of before) {
        assert.ok(after.has(marker), `${marker} was lost`);
      }
    });

    // Asserted exactly, so growing the residue and clearing it - which destroys
    // text on a page the reader kept - both fail here.
    const decidedWithNoPage =
      ANNOTATION_HELD_ROUTES.has(route) || route === "resources-drawn";
    test(`a reference through ${route} ${decidedWithNoPage ? "takes" : "keeps"} an element that names no page at all`, async () => {
      const bytes = await sharedObjectProbePdf(route, false);
      const after = [
        ...(await markersIn((await removePage(bytes, 0)).bytes)),
      ].filter((marker) => SECRET.test(marker));
      assert.deepEqual(
        after.sort(),
        decidedWithNoPage ? [] : [...SHARED_ROUTE_SECRETS].sort(),
      );
    });
  }

  for (const route of SHARED_ROUTES) {
    const nothingPlacesIt = ROUTES_NOTHING_PLACES.has(route);
    const kept = sharedRouteMarkers("KEEP").sort();

    test(`a reference through ${route} into the page that stays does not take what that page says`, async () => {
      const bytes = await sharedObjectProbePdf(
        route,
        false,
        "into the page that stays",
      );
      const before = [...(await markersIn(bytes))].filter((marker) =>
        marker.startsWith("KEEP-shared-"),
      );
      for (const marker of [...kept, "KEEP-shared-kept-page-content"]) {
        assert.ok(
          before.includes(marker),
          `the probe must put ${marker} on the page that stays`,
        );
      }

      const after = [
        ...(await markersIn((await removePage(bytes, 0)).bytes)),
      ].filter((marker) => marker.startsWith("KEEP-shared-"));
      assert.deepEqual(after.sort(), before.sort());
    });

    test(`a reference through ${route} into the page that stays does not let an ancestor /Pg naming the deleted page take it`, async () => {
      const bytes = await sharedObjectProbePdf(
        route,
        true,
        "into the page that stays",
      );
      const after = [
        ...(await markersIn((await removePage(bytes, 0)).bytes)),
      ].filter((marker) => kept.includes(marker));
      assert.deepEqual(after.sort(), nothingPlacesIt ? [] : kept);
    });
  }

  for (const route of ["irt", "popup"] as const) {
    test(`the page that stays reads the same to pdf.js after a delete through ${route}`, async () => {
      const bytes = await sharedObjectProbePdf(
        route,
        true,
        "into the page that stays",
      );
      const before = await structTreeOfKeptPage(bytes, 2);
      assert.ok(
        before.includes("KEEP-shared-alt"),
        "the probe must place the description on the page that stays",
      );
      assert.equal(
        await structTreeOfKeptPage((await removePage(bytes, 0)).bytes, 1),
        before,
      );
    });
  }
});

describe("a form XObject more than one page reaches", () => {
  const LETTERHEAD_ENTRIES_OF_THE_XOBJECT = LETTERHEAD_ENTRIES.filter(
    (entry) => !entry.startsWith("LETTERHEAD-OUTER-"),
  );

  async function letterheadEntriesTaken(
    drawnBy: LetterheadDrawing,
    namesItsPage = true,
  ) {
    const bytes = await letterheadProbePdf(drawnBy, namesItsPage);
    const before = await markersIn(bytes);
    for (const entry of LETTERHEAD_ENTRIES) {
      assert.ok(before.has(entry), `the probe must carry ${entry}`);
    }
    const removal = await removePage(bytes, 1);
    const after = await markersIn(removal.bytes);
    assert.ok(
      after.has("KEEP-letterhead-body-alt"),
      "the body of a page that stayed was taken",
    );
    assert.equal(
      removal.descriptionsUnproven,
      false,
      "the scan read every page",
    );
    return LETTERHEAD_ENTRIES.filter((entry) => !after.has(entry));
  }

  for (const namesItsPage of [true, false]) {
    const named = namesItsPage
      ? "whose /Pg names the deleted page"
      : "that names no page at all";

    test(`a letterhead the pages that stay draw keeps the description ${named}`, async () => {
      assert.deepEqual(
        await letterheadEntriesTaken("every page", namesItsPage),
        [],
      );
      assert.deepEqual(
        await letterheadEntriesTaken("only the pages that stay", namesItsPage),
        [],
      );
    });

    test(`a letterhead only the deleted page draws takes the description ${named}`, async () => {
      assert.deepEqual(
        await letterheadEntriesTaken("only the page that goes", namesItsPage),
        LETTERHEAD_ENTRIES_OF_THE_XOBJECT,
      );
    });
  }

  for (const otherPageReachesIt of [false, true]) {
    const reach = otherPageReachesIt
      ? " even when the other page's own /Resources names it"
      : "";

    test(`an XObject an inherited /Resources holds keeps its description when a page that stays draws it${reach}`, async () => {
      const bytes = await inheritedResourcesProbePdf(
        "the page that stays",
        otherPageReachesIt,
      );
      const before = await markersIn(bytes);
      const expected = INHERITED_RESOURCE_ENTRIES.map(
        (entry) => `KEEP-inherited-${entry}`,
      );
      for (const marker of expected) {
        assert.ok(before.has(marker), `the probe must carry ${marker}`);
      }

      const after = await markersIn((await removePage(bytes, 0)).bytes);
      for (const marker of expected) {
        assert.ok(
          after.has(marker),
          `${marker} was taken from a page that stays`,
        );
      }
    });

    test(`an XObject an inherited /Resources holds takes its description when only the deleted page draws it${reach}`, async () => {
      const bytes = await inheritedResourcesProbePdf(
        "the page that goes",
        otherPageReachesIt,
      );
      const after = [
        ...(await markersIn((await removePage(bytes, 0)).bytes)),
      ].filter((marker) => marker.startsWith("SECRET-inherited-"));
      assert.deepEqual(after, []);
    });
  }
});

// The scan reads bytes, so a `Do` inside a string, a comment or inline-image data
// must not read as a drawing, and an XObject that draws itself must terminate.

describe("reading what a page draws", () => {
  test("a page whose /Contents names nothing is reported rather than answered", async () => {
    const bytes = await contentReadingProbePdf("", false);
    const doc = await loadTestPdf(bytes);
    const { context } = doc;
    const kept = doc.getPage(1);
    kept.node.set(
      PDFName.of("Contents"),
      PDFRef.of(context.largestObjectNumber + 40),
    );
    const removal = await removePage(
      await doc.save({
        updateFieldAppearances: false,
        useObjectStreams: false,
      }),
      0,
    );
    assert.equal(removal.descriptionsUnproven, true);
  });

  for (const shape of CONTENT_READING_SHAPES) {
    const drawnByTheKeptPage = "drawnByTheKeptPage" in shape;
    test(`${shape.name} in the surviving page's content ${drawnByTheKeptPage ? "keeps" : "does not keep"} the deleted page's description`, async () => {
      const bytes = await contentReadingProbePdf(
        shape.keptContent,
        drawnByTheKeptPage,
      );
      assert.ok(
        (await markersIn(bytes)).has("SECRET-content-alt"),
        "the probe must carry the description",
      );

      const removal = await removePage(bytes, 0);
      assert.equal(removal.descriptionsUnproven, false, "the scan read it all");
      const after = [...(await markersIn(removal.bytes))].filter((marker) =>
        marker.startsWith("SECRET-content-"),
      );
      assert.deepEqual(
        after.sort(),
        drawnByTheKeptPage
          ? ["SECRET-content-alt", "SECRET-content-title"]
          : [],
      );
    });
  }

  test("a form XObject that draws itself terminates and is still read", async () => {
    const bytes = await contentReadingProbePdf("", true, true);
    const removal = await removePage(bytes, 0);
    assert.equal(removal.descriptionsUnproven, false);
    assert.ok(
      (await markersIn(removal.bytes)).has("SECRET-content-alt"),
      "the surviving page draws it, so its description stays",
    );
  });

  for (const shape of ["deep", "long"] as const) {
    test(`a ${shape === "deep" ? "Do nested past the cap" : "content stream past the byte budget"} is reported rather than answered`, async () => {
      const removal = await removePage(await cappedContentProbePdf(shape), 0);
      assert.equal(removal.descriptionsUnproven, true);
    });
  }

  test("a figure drawn twice at every level is read once at every level", async () => {
    const removal = await removePage(await repeatedDrawProbePdf(), 0);
    assert.equal(removal.descriptionsUnproven, false);
  });

  // Neither silent fallback may ship - one leaves the deleted page's description,
  // the other takes a kept page's - so removePage reports what it could not read.
  test("a delete that cannot read the content it needs says so", async () => {
    const unreadable = await removePage(
      await letterheadProbePdf("only the page that goes", true, true),
      1,
    );
    assert.equal(unreadable.descriptionsUnproven, true);

    const readable = await removePage(
      await letterheadProbePdf("only the page that goes", true, false),
      1,
    );
    assert.equal(readable.descriptionsUnproven, false);
  });

  test("a delete whose references already settle every key says nothing", async () => {
    for (const useObjectStreams of [false, true]) {
      const removal = await removePage(await probePdf(useObjectStreams), 0);
      assert.equal(removal.descriptionsUnproven, false);
      const tagged = await removePage(
        await taggedProbePdf(useObjectStreams),
        0,
      );
      assert.equal(tagged.descriptionsUnproven, false);
    }
  });

  test("the undo/redo path reports what it could not prove too", async () => {
    const bytes = await letterheadProbePdf(
      "only the page that goes",
      true,
      true,
    );
    const removed = await applyStructuralOperation(bytes, {
      type: "removePages",
      startIndex: 1,
      count: 1,
    });
    assert.equal(removed.descriptionsUnproven, true);
    const moved = await applyStructuralOperation(bytes, {
      type: "movePage",
      pageIndex: 0,
      direction: 1,
    });
    assert.equal(moved.descriptionsUnproven, false);
  });
});

describe("a /ClassMap entry", () => {
  // "No surviving element names this class" is a claim about the whole document,
  // so the walk may only make it having reached every element the /ParentTree names.
  test("a class an element under an ambiguous key names is not pruned", async () => {
    const doc = await PDFDocument.create();
    const { context } = doc;
    const gone = doc.addPage([612, 792]);
    const kept = doc.addPage([612, 792]);
    const element = (extra: Record<string, unknown>) =>
      context.register(context.obj({ S: "P", Type: "StructElem", ...extra }));

    const unreached = element({ C: "Cls-orphan", K: [0] });
    const onGone = element({
      Alt: PDFString.of("SECRET-orphan-class-user-alt"),
      C: "Cls-orphan",
      K: [0],
      Pg: gone.ref,
    });

    const font = context.register(
      context.obj({ BaseFont: "Helvetica", Subtype: "Type1", Type: "Font" }),
    );
    const formXObject = context.register(
      context.flateStream(markedContent(["shared-xobject"]), {
        BBox: [0, 0, 612, 792],
        Resources: context.obj({ Font: context.obj({ F1: font }) }),
        StructParents: SHARED_ROUTE_KEY,
        Subtype: "Form",
        Type: "XObject",
      }),
    );
    const shared = context.register(
      context.obj({
        Font: context.obj({ F1: font }),
        XObject: context.obj({ Fm0: formXObject }),
      }),
    );
    gone.node.set(PDFName.of("Resources"), shared);
    kept.node.set(PDFName.of("Resources"), shared);

    const structRoot = context.register(
      context.obj({
        ClassMap: context.obj({
          "Cls-orphan": context.obj({
            O: "Table",
            Summary: PDFString.of("KEEP-orphan-class-summary"),
          }),
        }),
        K: [onGone],
        ParentTree: context.register(
          context.obj({
            Nums: [
              0,
              context.obj([onGone]),
              SHARED_ROUTE_KEY,
              context.obj([unreached]),
            ],
          }),
        ),
        ParentTreeNextKey: SHARED_ROUTE_KEY + 1,
        Type: "StructTreeRoot",
      }),
    );
    context.lookup(onGone, PDFDict).set(PDFName.of("P"), structRoot);
    doc.catalog.set(PDFName.of("StructTreeRoot"), structRoot);
    doc.catalog.set(PDFName.of("MarkInfo"), context.obj({ Marked: true }));
    gone.node.set(PDFName.of("StructParents"), PDFNumber.of(0));
    gone.node.set(
      PDFName.of("Contents"),
      context.register(context.flateStream(markedContent(["gone"]))),
    );
    kept.node.set(
      PDFName.of("Contents"),
      context.register(context.flateStream(markedContent(["KEEP-kept"]))),
    );

    const bytes = await doc.save({
      updateFieldAppearances: false,
      useObjectStreams: false,
    });
    const after = await markersIn((await removePage(bytes, 0)).bytes);
    assert.ok(
      after.has("KEEP-orphan-class-summary"),
      "a class the walk cannot speak for was pruned",
    );
    assert.ok(!after.has("SECRET-orphan-class-user-alt"));
  });

  test("a class whose last user left the document goes with it", async () => {
    const after = (await removePage(await classMapProbePdf("complete"), 0))
      .bytes;
    assert.deepEqual(
      (await structureTexts(after)).filter((text) =>
        text.includes("SHARED-class-attribute-text"),
      ),
      [],
    );
    assert.deepEqual(
      [...(await markersIn(after))].filter((marker) =>
        marker.includes("SHARED-class-attribute-text"),
      ),
      [],
    );
  });

  for (const shape of [
    "cyclic",
    "in-tree",
    "parent-tree-only",
    "ref-only",
  ] as const) {
    test(`a class the walk cannot say has lost its last user stays (${shape})`, async () => {
      const after = (await removePage(await classMapProbePdf(shape), 0)).bytes;
      assert.deepEqual(
        (await structureTexts(after)).filter((text) =>
          text.includes("SHARED-class-attribute-text"),
        ),
        ["/ClassMap SHARED-class-attribute-text"],
      );
    });
  }
});

describe("a description written as its own object", () => {
  test("a description written as its own object goes with the page", async () => {
    const bytes = await sharedAltProbePdf(false);
    assert.ok(
      (await markersIn(bytes)).has("SECRET-alt-written-as-its-own-object"),
    );

    const after = (await removePage(bytes, 0)).bytes;
    assert.deepEqual(await structureTexts(after), [
      "/A KEEP-attribute-of-its-own",
      "/Alt KEEP-alt-of-its-own",
    ]);
    assert.deepEqual(
      [...(await markersIn(after))].filter((marker) => SECRET.test(marker)),
      [],
    );
  });

  test("a description an element on a kept page shares is not taken", async () => {
    const after = (await removePage(await sharedAltProbePdf(true), 0)).bytes;
    assert.deepEqual(await structureTexts(after), [
      "/A SECRET-property-two-levels-down",
      "/A SECRET-property-value-two-levels-down",
      "/Alt SECRET-alt-written-as-its-own-object",
    ]);
  });

  test("an attached file the document still lists is kept", async () => {
    const doc = await PDFDocument.create();
    const { context } = doc;
    const gone = doc.addPage([612, 792]);
    doc.addPage([612, 792]);
    const attachment = context.register(
      context.obj({
        EF: context.obj({
          F: context.register(context.flateStream("SHARED-attachment-bytes")),
        }),
        F: PDFString.of("SHARED-attachment-name.txt"),
        Type: "Filespec",
      }),
    );
    doc.catalog.set(
      PDFName.of("Names"),
      context.register(
        context.obj({
          EmbeddedFiles: context.obj({
            Names: [PDFString.of("SHARED-attachment-name.txt"), attachment],
          }),
        }),
      ),
    );
    doc.catalog.set(
      PDFName.of("StructTreeRoot"),
      context.register(
        context.obj({
          K: [
            context.register(
              context.obj({
                AF: [attachment],
                Pg: gone.ref,
                S: "P",
                Type: "StructElem",
              }),
            ),
          ],
          Type: "StructTreeRoot",
        }),
      ),
    );

    const { bytes: after } = await removePage(
      await doc.save({ updateFieldAppearances: false }),
      0,
    );
    assert.deepEqual(await structureTexts(after), []);
    const markers = await markersIn(after);
    assert.ok(markers.has("SHARED-attachment-bytes"));
    assert.ok(markers.has("SHARED-attachment-name"));
  });
});

describe("a button's /Opt and its /Kids", () => {
  for (const { drop, name } of droppingOperations) {
    for (const shape of ["inherited", "size-mismatch"] as const) {
      test(`${name} never leaves a widget with another widget's export value (/Opt ${shape})`, async () => {
        const bytes = await buttonProbePdf(shape);
        assert.deepEqual(widgetExports(await loadTestPdf(bytes)), [
          "SECRET-on-state-of-the-deleted-widget = SECRET-export-of-the-deleted-widget",
          "KEEP-on-state-of-the-surviving-widget = KEEP-export-of-the-surviving-widget",
        ]);

        const after = await loadTestPdf(await drop(bytes, 0));
        assert.deepEqual(
          widgetExports(after).filter((entry) =>
            entry.startsWith("KEEP-on-state"),
          ),
          [
            "KEEP-on-state-of-the-surviving-widget = KEEP-export-of-the-surviving-widget",
          ],
        );
      });
    }

    test(`${name} prunes an inherited /Opt onto the field rather than through it`, async () => {
      const after = await loadTestPdf(
        await drop(await buttonProbePdf("inherited"), 0),
      );
      const group = fieldNamed(after, "group");
      const radio = group
        ?.lookup(PDFName.of("Kids"), PDFArray)
        .lookup(0, PDFDict);
      assert.deepEqual(
        radio?.lookup(PDFName.of("Kids"), PDFArray).size(),
        1,
        "the dropped widget is still listed",
      );
      assert.deepEqual(
        radio
          ?.lookup(PDFName.of("Opt"), PDFArray)
          .asArray()
          .map((option) => (option as PDFString).decodeText()),
        ["KEEP-export-of-the-surviving-widget"],
      );
      assert.deepEqual(
        group
          ?.lookup(PDFName.of("Opt"), PDFArray)
          .asArray()
          .map((option) => (option as PDFString).decodeText()),
        [
          "SECRET-export-of-the-deleted-widget",
          "KEEP-export-of-the-surviving-widget",
        ],
        "the parent's own list must not be pruned through",
      );
    });

    test(`${name} leaves /Kids alone when nothing lines it up with /Opt`, async () => {
      const bytes = await drop(await buttonProbePdf("size-mismatch"), 0);
      const after = await loadTestPdf(bytes);
      const radio = fieldNamed(after, "radio");
      assert.equal(radio?.lookup(PDFName.of("Kids"), PDFArray).size(), 2);
      assert.deepEqual(
        after
          .getForm()
          .getFields()
          .map((field) => field.getName()),
        ["radio"],
      );
      assert.deepEqual(await pdfJsFieldNames(bytes), ["radio"]);
      assert.deepEqual(
        radio
          ?.lookup(PDFName.of("Opt"), PDFArray)
          .asArray()
          .map((option) => (option as PDFString).decodeText()),
        [
          "SECRET-export-of-the-deleted-widget",
          "KEEP-export-of-the-surviving-widget",
          "KEEP-export-nothing-is-at",
        ],
      );
    });
  }
});

describe("the object number a delete pins", () => {
  // deleteObjects pins the highest object number rather than lowering it, so a
  // number never means two objects and coordinates land on an empty dictionary.
  test("a coordinate naming the pinned object reads as a destination that goes nowhere", async () => {
    const doc = await PDFDocument.create();
    const { context } = doc;
    const kept = doc.addPage([612, 792]);
    kept.node.set(
      PDFName.of("Contents"),
      context.register(context.flateStream("BT (KEEP-page) Tj ET")),
    );
    const outline = context.register(
      context.obj({ Count: 1, Type: "Outlines" }),
    );
    const item = context.register(
      context.obj({ Parent: outline, Title: PDFString.of("KEEP-bookmark") }),
    );
    const element = context.register(
      context.obj({ S: "P", Type: "StructElem" }),
    );
    const structRoot = context.register(
      context.obj({ K: [element], Type: "StructTreeRoot" }),
    );
    const names = context.register(
      context.obj({ Dests: context.obj({ Names: [PDFString.of("gone")] }) }),
    );
    const gone = doc.addPage([612, 792]);
    context.lookup(outline, PDFDict).set(PDFName.of("First"), item);
    context.lookup(outline, PDFDict).set(PDFName.of("Last"), item);
    context
      .lookup(item, PDFDict)
      .set(PDFName.of("Dest"), context.obj([gone.ref, "Fit"]));
    context.lookup(element, PDFDict).set(PDFName.of("Pg"), gone.ref);
    context
      .lookup(names, PDFDict)
      .lookup(PDFName.of("Dests"), PDFDict)
      .lookup(PDFName.of("Names"), PDFArray)
      .push(context.obj([gone.ref, "Fit"]));
    doc.catalog.set(PDFName.of("Names"), names);
    doc.catalog.set(PDFName.of("OpenAction"), context.obj([gone.ref, "Fit"]));
    doc.catalog.set(PDFName.of("Outlines"), outline);
    doc.catalog.set(PDFName.of("StructTreeRoot"), structRoot);

    const bytes = await doc.save({
      updateFieldAppearances: false,
      useObjectStreams: false,
    });
    const after = (await removePage(bytes, 1)).bytes;
    const pdfDoc = await loadTestPdf(after);
    const pinned = PDFRef.of(pdfDoc.context.largestObjectNumber);
    assert.deepEqual(
      pdfDoc.context.lookup(pinned, PDFDict).keys(),
      [],
      "the pin must be the empty dictionary the deleted page's number now holds",
    );
    const coordinate = (path: string, value: PDFObject | undefined) =>
      `${path} -> ${value === pinned ? "the pin" : "something else"}`;
    assert.deepEqual(
      [
        coordinate(
          "/Root/OpenAction[0]",
          pdfDoc.catalog.lookup(PDFName.of("OpenAction"), PDFArray).get(0),
        ),
        coordinate(
          "/Root/Outlines/First/Dest[0]",
          pdfDoc.catalog
            .lookup(PDFName.of("Outlines"), PDFDict)
            .lookup(PDFName.of("First"), PDFDict)
            .lookup(PDFName.of("Dest"), PDFArray)
            .get(0),
        ),
        coordinate(
          "/Root/StructTreeRoot/K[0]/Pg",
          pdfDoc.catalog
            .lookup(PDFName.of("StructTreeRoot"), PDFDict)
            .lookup(PDFName.of("K"), PDFArray)
            .lookup(0, PDFDict)
            .get(PDFName.of("Pg")),
        ),
      ],
      [
        "/Root/OpenAction[0] -> the pin",
        "/Root/Outlines/First/Dest[0] -> the pin",
        "/Root/StructTreeRoot/K[0]/Pg -> the pin",
      ],
    );

    const options = {
      data: after.slice(),
      disableFontFace: true,
      isEvalSupported: false,
      useSystemFonts: false,
    };
    const loadingTask = getDocument(options);
    try {
      const pdfJsDoc = await loadingTask.promise;
      assert.equal(pdfJsDoc.numPages, 1);
      assert.deepEqual(
        (await pdfJsDoc.getOutline())?.map((entry) => entry.title),
        ["KEEP-bookmark"],
      );
      assert.equal(
        await structTreeOfKeptPage(after, 1),
        '{"children":[],"role":"Root"}',
      );
    } finally {
      await loadingTask.destroy();
    }
  });
});
