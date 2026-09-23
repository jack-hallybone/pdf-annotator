import assert from "node:assert/strict";
import test from "node:test";
import { safePdfExternalUrl } from "../src/pdfdocumenteditor/pdfLinks";

// Every external PDF link goes through one allowlist before anything can reach
// `window.open`: a `/URI` is untrusted input, and both the anchor construction
// (pdfLinks) and the point of opening (useExternalLinks) call this.

test("the allowed protocols survive sanitization", () => {
  assert.equal(
    safePdfExternalUrl("https://example.com/docs"),
    "https://example.com/docs",
  );
  assert.equal(
    safePdfExternalUrl("http://example.com/docs"),
    "http://example.com/docs",
  );
  assert.equal(
    safePdfExternalUrl("mailto:someone@example.com?subject=Hi"),
    "mailto:someone@example.com?subject=Hi",
  );
});

test("scripting and non-navigational schemes are rejected", () => {
  // `javascript:`/`vbscript:` are the direct XSS vectors, `data:` and `blob:` would
  // run in our own origin, and `file:` reads the reader's disk.
  for (const url of [
    "javascript:alert(1)",
    "vbscript:msgbox(1)",
    "data:text/html,<script>alert(1)</script>",
    "blob:https://example.com/0a1b2c3d",
    "file:///etc/passwd",
    "about:blank",
    "chrome://settings",
    "ftp://example.com/x",
    "tel:+15551234",
  ]) {
    assert.equal(safePdfExternalUrl(url), null, `${url} must not be openable`);
  }
});

test("the allowlist is applied to the parsed protocol, not the raw text", () => {
  // Two ways a raw-string prefix check gets fooled and this one does not. The
  // scheme is case-normalised by the parser, so an allowed scheme in any case is
  // still recognised as allowed...
  assert.equal(
    safePdfExternalUrl("HTTPS://EXAMPLE.COM/Path"),
    "https://example.com/Path",
  );
  assert.equal(safePdfExternalUrl("MAILTO:a@b.com"), "mailto:a@b.com");

  assert.equal(safePdfExternalUrl("JavaScript:alert(1)"), null);
  assert.equal(safePdfExternalUrl("JAVASCRIPT:alert(1)"), null);

  // The parser also strips embedded tabs and newlines from the scheme, so
  // "java\nscript:" parses as `javascript:`. A `startsWith` guard on the raw
  // string would wave this through.
  assert.equal(safePdfExternalUrl("java\nscript:alert(1)"), null);
  assert.equal(safePdfExternalUrl("java\tscript:alert(1)"), null);
});

test("embedded credentials are stripped from an allowed URL", () => {
  const sanitized = safePdfExternalUrl("https://user:pass@example.com/path");
  assert.equal(sanitized, "https://example.com/path");
  assert.ok(!sanitized?.includes("user"));
  assert.ok(!sanitized?.includes("pass"));

  assert.equal(
    safePdfExternalUrl("https://user@example.com/path"),
    "https://example.com/path",
  );
  assert.equal(
    safePdfExternalUrl("https://:pass@example.com/"),
    "https://example.com/",
  );

  // A second `@` is the classic "which host is this really?" trick: everything
  // before the last one is credentials, so the real host is good.example.
  assert.equal(
    safePdfExternalUrl("https://user:pass@evil.example@good.example/"),
    "https://good.example/",
  );
});

test("unparseable input is rejected rather than passed through", () => {
  for (const url of [
    "not a url",
    "",
    "   ",
    "example.com",
    "/relative/path",
    "//example.com/x",
    "https://",
  ]) {
    assert.equal(
      safePdfExternalUrl(url),
      null,
      `${JSON.stringify(url)} must not be openable`,
    );
  }
});

test("query and fragment are preserved on an allowed URL", () => {
  assert.equal(
    safePdfExternalUrl("https://example.com/a/b?q=1&x=2#frag"),
    "https://example.com/a/b?q=1&x=2#frag",
  );
  assert.equal(
    safePdfExternalUrl("https://example.com/p?q=a%20b#sec:1"),
    "https://example.com/p?q=a%20b#sec:1",
  );

  assert.equal(
    safePdfExternalUrl("https://example.com/a?javascript:alert(1)#x"),
    "https://example.com/a?javascript:alert(1)#x",
  );
});

test("the sanitized URL is stable under re-sanitization", () => {
  // The same allowlist is checked at both ends, so passing an already-sanitized
  // URL back through must be a no-op.
  for (const url of [
    "https://user:pass@example.com/a?q=1#f",
    "http://example.com",
    "mailto:someone@example.com?subject=Hi",
    "https://例え.テスト/",
    "https://example.com/a b",
  ]) {
    const once = safePdfExternalUrl(url);
    assert.ok(once, `${url} should be allowed`);
    assert.equal(safePdfExternalUrl(once), once);
  }
});
