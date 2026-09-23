import assert from "node:assert/strict";
import test from "node:test";
import { PDFArray, PDFDict, PDFDocument, PDFName } from "pdf-lib";
import {
  annotationColors,
  sameRgbColor,
} from "../src/pdfdocumenteditor/annotationColors";
import {
  createDefaultToolPresets,
  defaultToolSettings,
  tools,
} from "../src/tabbedapp/toolConfig";
import { writePdfAnnotations } from "../src/pdfdocumenteditor/pdfWriter";
import type { InkAnnotation } from "../src/pdfdocumenteditor/types";

const penTools = tools.filter((item) => item.tool === "draw");

// The dock is three pens a reader tells apart by position, and a label must not
// promise a colour the reader is free to change in the pen's own settings.
test("the dock offers exactly three pens, labelled by position", () => {
  assert.deepEqual(
    penTools.map((item) => item.label),
    ["Pen 1", "Pen 2", "Pen 3"],
  );

  const presets = createDefaultToolPresets();
  const expected = [
    annotationColors.blue,
    annotationColors.red,
    annotationColors.green,
  ];

  penTools.forEach((item, index) => {
    const preset = presets[item.key];
    assert.ok(preset, `no default preset for ${item.key}`);
    assert.ok(
      preset.drawColor && sameRgbColor(preset.drawColor, expected[index]),
      `${item.label} does not start on the expected colour`,
    );
    assert.equal(preset.drawWidth, defaultToolSettings.drawWidth);
  });
});

// The pen a mark was made with is a property of the dock, not of the mark:
// remembering which pen drew an annotation would write a dock index into a file
// the reader hands to someone else, where Pen 2 is a different colour. Scanning
// the bytes alone is not enough - an index could be written as a number - so the
// written Ink dictionary's whole key set is pinned.
test("a pen's identity never reaches annotation data", async () => {
  const blank = await PDFDocument.create();
  blank.addPage([200, 200]);
  const base = await blank.save();

  const presets = createDefaultToolPresets();

  for (const [index, item] of penTools.entries()) {
    const preset = presets[item.key] ?? {};
    const annotation: InkAnnotation = {
      id: `pen-mark-${index}`,
      kind: "draw",
      pageIndex: 0,
      paths: [
        [
          { x: 20, y: 20 },
          { x: 80, y: 90 },
        ],
      ],
      color: preset.drawColor ?? defaultToolSettings.drawColor,
      opacity: preset.drawOpacity ?? defaultToolSettings.drawOpacity,
      width: preset.drawWidth ?? defaultToolSettings.drawWidth,
      comment: "",
    };

    const written = await writePdfAnnotations(base, [annotation]);
    const text = Buffer.from(written).toString("latin1");
    for (const token of [item.key, item.label]) {
      assert.ok(
        !text.includes(token),
        `${token} reached the written PDF for ${item.label}`,
      );
    }

    const inkDict = await onlyInkAnnotation(written);
    assert.deepEqual(
      inkDict
        .keys()
        .map((key) => key.decodeText())
        .sort(),
      [
        "AP",
        "BS",
        "Border",
        "C",
        "CA",
        "CreationDate",
        "F",
        "IT",
        "InkList",
        "M",
        "NM",
        "P",
        "Rect",
        "Subtype",
        "Type",
      ],
    );

    const colour = inkDict.lookup(PDFName.of("C"), PDFArray);
    assert.deepEqual(
      colour.asArray().map((value) => Number(value.toString())),
      annotation.color.map((channel) => Number(channel.toFixed(4))),
    );
  }
});

async function onlyInkAnnotation(bytes: Uint8Array) {
  const pdfDoc = await PDFDocument.load(bytes, { updateMetadata: false });
  const annots = pdfDoc.getPages()[0].node.Annots();
  assert.ok(annots, "no annotations were written");
  const inkDicts: PDFDict[] = [];
  for (let index = 0; index < annots.size(); index += 1) {
    const dict = annots.lookupMaybe(index, PDFDict);
    if (
      dict?.lookupMaybe(PDFName.of("Subtype"), PDFName)?.decodeText() === "Ink"
    ) {
      inkDicts.push(dict);
    }
  }
  assert.equal(inkDicts.length, 1);
  return inkDicts[0];
}
