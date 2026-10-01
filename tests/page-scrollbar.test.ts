import assert from "node:assert/strict";
import test from "node:test";
import {
  MIN_THUMB_LENGTH,
  nextTrackPage,
  scrollbarThumb,
  scrollOffsetForThumb,
  steadiedPointer,
  THUMB_WOBBLE_SLACK,
  TRACK_PAGE_FRACTION,
} from "../src/pdfdocumenteditor/pageScrollbar";

const short = { contentLength: 4000, trackLength: 1000, viewportLength: 1000 };
// A hundred pages at 150%: one pixel of thumb is over a hundred of pages.
const long = { contentLength: 135_000, trackLength: 900, viewportLength: 900 };

test("the thumb is as long as the view is of the whole, and travels the track as the pages scroll", () => {
  assert.deepEqual(scrollbarThumb(short, 0), { length: 250, offset: 0 });
  assert.deepEqual(scrollbarThumb(short, 1500), { length: 250, offset: 375 });
  assert.deepEqual(scrollbarThumb(short, 3000), { length: 250, offset: 750 });
  // Overscroll either way pins it to the ends.
  assert.deepEqual(scrollbarThumb(short, -50), { length: 250, offset: 0 });
  assert.deepEqual(scrollbarThumb(short, 9000), { length: 250, offset: 750 });
});

test("the thumb keeps a length a pen can catch, but never outgrows its track", () => {
  assert.equal(scrollbarThumb(long, 0)?.length, MIN_THUMB_LENGTH);
  assert.equal(
    scrollbarThumb(long, long.contentLength - long.viewportLength)?.offset,
    long.trackLength - MIN_THUMB_LENGTH,
  );
  assert.deepEqual(scrollbarThumb({ ...long, trackLength: 20 }, 5000), {
    length: 20,
    offset: 0,
  });
});

test("there is no thumb when there is nothing to scroll", () => {
  assert.equal(scrollbarThumb({ ...short, contentLength: 1000 }, 0), null);
  assert.equal(scrollbarThumb({ ...short, contentLength: 600 }, 0), null);
  // A bar hidden for want of room has no track.
  assert.equal(scrollbarThumb({ ...short, trackLength: 0 }, 0), null);
});

test("a thumb put back where it was drawn scrolls back to where it was, so a dragged thumb stays under the pointer", () => {
  for (const metrics of [short, long]) {
    const range = metrics.contentLength - metrics.viewportLength;
    for (const scroll of [0, 1, range / 3, range / 2, range - 1, range]) {
      const thumb = scrollbarThumb(metrics, scroll)!;
      assert.ok(
        Math.abs(scrollOffsetForThumb(metrics, thumb.offset) - scroll) < 1e-6,
        `scroll ${scroll}`,
      );
    }
    assert.equal(scrollOffsetForThumb(metrics, -40), 0);
    assert.equal(scrollOffsetForThumb(metrics, metrics.trackLength), range);
  }
  assert.equal(scrollOffsetForThumb({ ...short, contentLength: 900 }, 10), 0);
});

test("a mouse is never steadied: the held position is where the pointer is", () => {
  let held = 100;
  for (const pointer of [101, 99, 140, 139, 60]) {
    held = steadiedPointer(held, pointer, 0);
    assert.equal(held, pointer);
  }
});

test("a pen held still and wobbling within the slack never moves the thumb", () => {
  const press = 300;
  let held = press;
  for (let move = 0; move < 500; move += 1) {
    const wobble = Math.round(Math.sin(move * 1.7) * THUMB_WOBBLE_SLACK * 0.99);
    held = steadiedPointer(held, press + wobble, THUMB_WOBBLE_SLACK);
    assert.equal(held, press, `move ${move}`);
  }
});

test("a deliberate pen drag moves the thumb, trailing the pen by the slack, and turning back takes twice the slack", () => {
  let held = 300;
  for (let pointer = 301; pointer <= 360; pointer += 1) {
    held = steadiedPointer(held, pointer, THUMB_WOBBLE_SLACK);
  }
  assert.equal(held, 360 - THUMB_WOBBLE_SLACK);

  // Coming back, nothing moves until the pen is twice the slack back from where it turned.
  for (
    let pointer = 359;
    pointer >= 360 - 2 * THUMB_WOBBLE_SLACK;
    pointer -= 1
  ) {
    held = steadiedPointer(held, pointer, THUMB_WOBBLE_SLACK);
    assert.equal(held, 360 - THUMB_WOBBLE_SLACK);
  }
  held = steadiedPointer(held, 351, THUMB_WOBBLE_SLACK);
  assert.equal(held, 351 + THUMB_WOBBLE_SLACK);
});

test("wobble right after a drag never turns the thumb back, moves it no further than its own width, and then stops moving it", () => {
  // Pseudo-random but repeatable, so a failure can be replayed.
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };

  for (let trial = 0; trial < 200; trial += 1) {
    const stop = 500;
    let held = stop - THUMB_WOBBLE_SLACK;
    const width = random() * 2 * THUMB_WOBBLE_SLACK;
    const low = stop - random() * width;
    const wobble = () => low + random() * width;

    const start = held;
    let direction = 0;
    for (let move = 0; move < 200; move += 1) {
      const next = steadiedPointer(held, wobble(), THUMB_WOBBLE_SLACK);
      const step = Math.sign(next - held);
      assert.ok(step === 0 || direction === 0 || step === direction);
      direction ||= step;
      held = next;
    }
    assert.ok(Math.abs(held - start) <= width + 1e-9);

    // Both extremes reached: nothing inside the wobble moves it any more.
    held = steadiedPointer(held, low, THUMB_WOBBLE_SLACK);
    held = steadiedPointer(held, low + width, THUMB_WOBBLE_SLACK);
    const settled = held;
    for (let move = 0; move < 100; move += 1) {
      held = steadiedPointer(held, wobble(), THUMB_WOBBLE_SLACK);
      assert.equal(held, settled);
    }
  }
});

test("a press on the track pages toward the pointer by seven eighths of the view, and stops once the thumb reaches it", () => {
  const metrics = {
    contentLength: 10_000,
    trackLength: 800,
    viewportLength: 800,
  };
  const step = 800 * TRACK_PAGE_FRACTION;
  assert.equal(nextTrackPage(metrics, 0, 1, 700), step);
  assert.equal(nextTrackPage(metrics, 4000, -1, 10), 4000 - step);

  // Paging on reaches the pointer and goes no further.
  let target = 0;
  let pages = 0;
  let next = nextTrackPage(metrics, target, 1, 400);
  while (next !== null) {
    target = next;
    pages += 1;
    next = nextTrackPage(metrics, target, 1, 400);
  }
  const thumb = scrollbarThumb(metrics, target)!;
  assert.ok(pages > 1);
  assert.ok(thumb.offset + thumb.length >= 400);
  assert.ok(
    scrollbarThumb(metrics, target - step)!.offset + thumb.length < 400,
  );

  // Pinned to the ends of the document.
  assert.equal(nextTrackPage(metrics, 9000, 1, 799), 9200);
  assert.equal(nextTrackPage(metrics, 300, -1, 0), 0);
  // A pointer already under the thumb pages nowhere.
  assert.equal(nextTrackPage(metrics, 0, 1, 30), null);
  assert.equal(
    nextTrackPage({ ...metrics, contentLength: 800 }, 0, 1, 700),
    null,
  );
});
