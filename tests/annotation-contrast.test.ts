import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  NOTE_MARK_OPACITY,
  NOTE_MARK_OPACITY_SELECTED,
  annotationColors,
  annotationColorSwatches,
  contrastRatio,
  flattenOver,
  foregroundOn,
  hexToRgb,
  prefersDarkForegroundOn,
  relativeLuminance,
  rgbToHex,
  type RgbColor,
} from "../src/pdfdocumenteditor/annotationColors";
import { FOREGROUND_INKS } from "../src/contrast";
import {
  defaultToolSettings,
  highlightIndicatorColor,
  toolFillColor,
} from "../src/tabbedapp/toolConfig";

// foregroundOn() returns a token reference and the light token is #231d22, not
// pure black: measuring against black flatters the result by most of a point.
const { light: INK_ON_LIGHT, dark: INK_ON_DARK } = FOREGROUND_INKS;

function chosenContrast(fill: RgbColor) {
  return contrastRatio(
    fill,
    prefersDarkForegroundOn(fill) ? INK_ON_LIGHT : INK_ON_DARK,
  );
}

test("relative luminance matches known references", () => {
  assert.equal(relativeLuminance([0, 0, 0]), 0);
  assert.equal(relativeLuminance([1, 1, 1]), 1);
  assert.ok(Math.abs(relativeLuminance([0.5, 0.5, 0.5]) - 0.214) < 0.001);
});

test("foreground choice beats the alternative for every swatch", () => {
  for (const color of annotationColorSwatches) {
    const chosen = chosenContrast(color);
    const rejected = contrastRatio(
      color,
      prefersDarkForegroundOn(color) ? INK_ON_DARK : INK_ON_LIGHT,
    );
    assert.ok(
      chosen >= rejected,
      `picked the lower-contrast foreground for ${JSON.stringify(color)}`,
    );
  }
});

// The highlighter glyph is an icon rather than text, so the bar is WCAG's 3:1
// for non-text content and red is the tightest at 3.91:1. The button paints its
// glyph opaque, which is why full-strength ink is measured here and nowhere else.
test("marks on a swatch clear the non-text contrast floor", () => {
  for (const color of annotationColorSwatches) {
    const value = chosenContrast(color);
    assert.ok(
      value >= 3,
      `${JSON.stringify(color)} is ${value.toFixed(2)}:1, under the 3:1 floor`,
    );
  }
});

test("foregroundOn returns a token, never a raw colour", () => {
  for (const color of annotationColorSwatches) {
    assert.match(foregroundOn(color), /^var\(--app-ink-on-(light|dark)\)$/);
  }
});

// The assertion above is satisfied by any name of that shape, so a rename in the
// stylesheet would leave it green with every mark painted from an unset custom
// property, which resolves to nothing and inherits the ink. Comments are
// stripped first, so a token named in prose is not a declaration.
test("the inks foregroundOn names are declared, and are the ones measured here", () => {
  const styles = readFileSync(
    fileURLToPath(
      new URL("../src/pdfdocumenteditor/styles.css", import.meta.url),
    ),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");

  const hex = (color: RgbColor) =>
    `#${color
      .map((c) =>
        Math.round(c * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")}`;

  for (const [name, ink] of [
    ["light", INK_ON_LIGHT],
    ["dark", INK_ON_DARK],
  ] as const) {
    const declared = new RegExp(
      `--app-ink-on-${name}:\\s*(#[0-9a-fA-F]{3,8})\\s*;`,
    ).exec(styles)?.[1];
    assert.equal(
      declared?.toLowerCase(),
      hex(ink),
      `--app-ink-on-${name} is ${declared ?? "not declared"}; src/contrast.ts ` +
        `measures its ratios against ${hex(ink)}`,
    );
  }
});

test("flattening is a plain alpha composite", () => {
  assert.deepEqual(flattenOver([0, 0, 0], [1, 1, 1], 1), [0, 0, 0]);
  assert.deepEqual(flattenOver([0, 0, 0], [1, 1, 1], 0), [1, 1, 1]);
  assert.deepEqual(flattenOver([0, 0, 0], [1, 1, 1], 0.25), [0.75, 0.75, 0.75]);
});

test("note popover text stays legible for every note colour", () => {
  const NOTE_ALPHA = 0.24;
  const PAGE: RgbColor = [1, 1, 1];

  for (const color of annotationColorSwatches) {
    const fill = flattenOver(color, PAGE, NOTE_ALPHA);
    const value = chosenContrast(fill);
    assert.ok(
      value >= 4.5,
      `note text is ${value.toFixed(2)}:1 on ${JSON.stringify(color)}`,
    );
  }

  assert.equal(
    prefersDarkForegroundOn(
      flattenOver(annotationColors.black, PAGE, NOTE_ALPHA),
    ),
    true,
  );
  assert.equal(prefersDarkForegroundOn(annotationColors.black), false);
});

// A note's outline and glyph are the same ink at NOTE_MARK_OPACITY over the
// note's own fill: at the 0.62 and 0.66 they used to be, purple and red measured
// about 2.5:1. The opacities are imported rather than repeated, so lowering
// either constant is what fails this test.
test("the marks on a note clear the same floor at the alpha they are painted", () => {
  for (const color of annotationColorSwatches) {
    const ink = prefersDarkForegroundOn(color) ? INK_ON_LIGHT : INK_ON_DARK;
    for (const [what, alpha] of [
      ["outline and glyph", NOTE_MARK_OPACITY],
      ["outline when selected", NOTE_MARK_OPACITY_SELECTED],
    ] as const) {
      const value = contrastRatio(color, flattenOver(ink, color, alpha));
      assert.ok(
        value >= 3,
        `${what} on ${JSON.stringify(color)} is ${value.toFixed(2)}:1 at ` +
          `alpha ${alpha}, under the 3:1 floor`,
      );
    }
  }
});

// --theme-ink's own two values (src/tabbedapp/toolConfig.ts's THEME_INK_LIGHT
// / THEME_INK_DARK), kept here as raw RGB so the test measures against the
// same backdrop the fix targets, not a value it recomputes independently.
const THEME_INK_LIGHT: RgbColor = [0x23 / 255, 0x1d / 255, 0x22 / 255];
const THEME_INK_DARK: RgbColor = [0xed / 255, 0xe5 / 255, 0xeb / 255];

// Either a plain "#rrggbb" (fill already clears the floor in both schemes) or
// "light-dark(#rrggbb, #rrggbb)" (it didn't, in at least one scheme).
function parseFill(value: string): { light: RgbColor; dark: RgbColor } {
  const pair = /^light-dark\((#[0-9a-fA-F]{6}),\s*(#[0-9a-fA-F]{6})\)$/.exec(
    value,
  );
  if (pair) {
    return { light: hexToRgb(pair[1]), dark: hexToRgb(pair[2]) };
  }
  assert.match(value, /^#[0-9a-fA-F]{6}$/, `${value} is neither form`);
  const rgb = hexToRgb(value);
  return { light: rgb, dark: rgb };
}

// The highlighter and note toolbar icons keep a plain-ink stroke, like every
// other tool, and paint the reader's own colour as a small fill instead
// (toolFillColor). That fill must still clear the icon's 3:1 floor against
// the ink it now sits next to: the default yellow measured ~1.15:1 against
// dark mode's plain ink, close enough to invisible that the shape read as a
// blob rather than an icon.
test("the highlight and note tool icons' fill clears the floor against theme ink in both schemes", () => {
  for (const tool of ["highlight", "stickyNote"] as const) {
    for (const color of annotationColorSwatches) {
      const settings =
        tool === "stickyNote"
          ? { ...defaultToolSettings, noteColor: color }
          : { ...defaultToolSettings, highlightColor: color };
      const fill = toolFillColor(tool, settings);
      assert.ok(fill, `${tool} has no fill for ${JSON.stringify(color)}`);
      const { light, dark } = parseFill(fill!);

      const lightValue = contrastRatio(light, THEME_INK_LIGHT);
      assert.ok(
        lightValue >= 3,
        `${tool} fill on ${JSON.stringify(color)} is ${lightValue.toFixed(2)}:1 against light-mode ink, under the 3:1 floor`,
      );
      const darkValue = contrastRatio(dark, THEME_INK_DARK);
      assert.ok(
        darkValue >= 3,
        `${tool} fill on ${JSON.stringify(color)} is ${darkValue.toFixed(2)}:1 against dark-mode ink, under the 3:1 floor`,
      );
    }
  }
});

// A highlight always lands on a white page, so its toolbar preview must read
// the same regardless of the app's own theme: a colour scheme cannot enter
// this computation, only paper can. Also guards against reverting to the raw
// colour plus CSS opacity, which would (correctly) look flattened over
// whatever background the button happens to have instead.
test("the highlight indicator is flattened against paper, not raw colour plus opacity", () => {
  for (const color of annotationColorSwatches) {
    for (const opacity of [0.1, 0.5, 0.8]) {
      const settings = {
        ...defaultToolSettings,
        highlightColor: color,
        highlightOpacity: opacity,
      };
      const expected = rgbToHex(flattenOver(color, [1, 1, 1], opacity));
      assert.equal(highlightIndicatorColor(settings), expected);
    }
  }

  const opaqueSettings = {
    ...defaultToolSettings,
    highlightColor: annotationColors.red,
    highlightOpacity: 0.4,
  };
  assert.notEqual(
    highlightIndicatorColor(opaqueSettings),
    rgbToHex(annotationColors.red),
    "flattening at 0.4 opacity produced the raw colour unchanged",
  );
});

test("toolFillColor has a fill only for the tools with a fillable region", () => {
  const everyTool = [
    "select",
    "highlight",
    "textHighlight",
    "freehandHighlight",
    "draw",
    "freeText",
    "imageStamp",
    "stickyNote",
    "eraser",
    "lasso",
  ] as const;
  const toolsWithFill = new Set([
    "highlight",
    "textHighlight",
    "freehandHighlight",
    "stickyNote",
  ]);

  for (const tool of everyTool) {
    const hasFill = toolFillColor(tool, defaultToolSettings) !== undefined;
    assert.equal(
      hasFill,
      toolsWithFill.has(tool),
      `${tool}: toolFillColor is ${hasFill ? "set" : "undefined"}`,
    );
  }
});

// The favicon and wordmark hand-draw the same highlighter icon as a static
// SVG, with a dark-mode rule flipping ink strokes to a light colour like
// every other icon stroke. The mark's true yellow fill fails 3:1 against
// that lighter ink, so a second dark-mode rule bends the FILL for contrast
// instead (deliberately to a different hue, not just a muted yellow) - the
// stroke is left alone, following the scheme plainly.
test("the favicon and wordmark's highlighter mark fill bends for contrast in dark mode, not the stroke", () => {
  for (const asset of ["favicon.svg", "title.svg"]) {
    const svg = readFileSync(
      fileURLToPath(
        new URL(`../src/browserapp/assets/${asset}`, import.meta.url),
      ),
      "utf8",
    );

    const darkMedia =
      /@media \(prefers-color-scheme: dark\)\s*\{([\s\S]*?)\n\s*\}/.exec(
        svg,
      )?.[1];
    assert.ok(darkMedia, `${asset}: no dark-mode media block`);

    const fillOverride =
      /path\[fill="#FFFE4E"\]\s*\{\s*fill:\s*(#[0-9a-fA-F]{6});\s*\}/i.exec(
        darkMedia!,
      )?.[1];
    assert.ok(
      fillOverride,
      `${asset}: no dark-mode fill override for the mark's yellow`,
    );

    const inkDark = hexToRgb("#ebe6e0");
    const value = contrastRatio(hexToRgb(fillOverride!), inkDark);
    assert.ok(
      value >= 3,
      `${asset}: dark-mode fill ${fillOverride} is ${value.toFixed(2)}:1 against dark-mode ink, under the 3:1 floor`,
    );

    assert.doesNotMatch(
      svg,
      /style="stroke:/i,
      `${asset}: the mark's stroke is pinned inline instead of following the scheme`,
    );
  }
});
