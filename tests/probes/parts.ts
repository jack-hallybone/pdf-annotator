import { type PDFContext, type PDFObject } from "pdf-lib";

// Both spellings the specification allows: one node holding every key in
// `/Nums`, or a root whose `/Kids` each hold some behind a `/Limits`.
export function numberTree(
  context: PDFContext,
  entries: [number, PDFObject][],
  spelling: "kids" | "nums",
) {
  if (spelling === "nums") {
    return context.register(
      context.obj({ Nums: entries.flatMap(([key, value]) => [key, value]) }),
    );
  }
  return context.register(
    context.obj({
      Kids: entries.map(([key, value]) =>
        context.register(
          context.obj({ Limits: [key, key], Nums: [key, value] }),
        ),
      ),
    }),
  );
}

/** One marked-content sequence per string, numbered from zero. */
export function markedContent(texts: string[]) {
  return texts
    .map(
      (text, index) =>
        `/P <</MCID ${index}>> BDC BT /F1 12 Tf 72 ${700 - index * 20} Td (${text}) Tj ET EMC`,
    )
    .join("\n");
}
