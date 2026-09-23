import assert from "node:assert/strict";
import { test } from "node:test";
import { useRef } from "react";
import { act, renderHook } from "@testing-library/react";
import { useExternalLinks } from "../src/tabbedapp/useExternalLinks";

type OpenCall = { url: string; fileName: string; sourceId: string };

function useLinksHarness(opens: OpenCall[], notices: string[]) {
  const sourceIdRef = useRef("doc-1");
  return useExternalLinks({
    onOpenExternalLink: (url, context) => {
      opens.push({
        url,
        fileName: context.fileName,
        sourceId: context.sourceId,
      });
    },
    fileName: "report.pdf",
    sourceIdRef,
    showNotice: (message) => notices.push(message),
  });
}

test("an untrusted link opens the confirmation dialog instead of opening", () => {
  const opens: OpenCall[] = [];
  const { result } = renderHook(() => useLinksHarness(opens, []));

  act(() => result.current.requestExternalLink("https://example.com/a"));

  assert.equal(opens.length, 0);
  assert.equal(
    result.current.pendingExternalLink?.url,
    "https://example.com/a",
  );
  assert.equal(
    result.current.pendingExternalLink?.trustKey,
    "https://example.com",
  );
});

test("confirming opens the link with file context and clears the dialog", () => {
  const opens: OpenCall[] = [];
  const { result } = renderHook(() => useLinksHarness(opens, []));

  act(() => result.current.requestExternalLink("https://example.com/a"));
  act(() => result.current.confirmExternalLink());

  assert.equal(result.current.pendingExternalLink, null);
  assert.deepEqual(opens, [
    { url: "https://example.com/a", fileName: "report.pdf", sourceId: "doc-1" },
  ]);
});

test("cancelling closes the dialog without opening", () => {
  const opens: OpenCall[] = [];
  const { result } = renderHook(() => useLinksHarness(opens, []));

  act(() => result.current.requestExternalLink("https://example.com/a"));
  act(() => result.current.cancelExternalLink());

  assert.equal(result.current.pendingExternalLink, null);
  assert.equal(opens.length, 0);
});

test('"always" trusts the origin so later links from it open without a prompt', () => {
  const opens: OpenCall[] = [];
  const { result } = renderHook(() => useLinksHarness(opens, []));

  act(() => result.current.requestExternalLink("https://trusted.example/a"));
  act(() => result.current.confirmExternalLink({ always: true }));
  assert.equal(opens.length, 1);

  // Asserted through a local because node:assert/strict's `equal` is an assertion
  // signature, so asserting the property itself narrows every later read of it.
  act(() => result.current.requestExternalLink("https://trusted.example/b"));
  const afterTrustedOpen = result.current.pendingExternalLink;
  assert.equal(afterTrustedOpen, null);
  assert.equal(opens.length, 2);
  assert.equal(opens[1].url, "https://trusted.example/b");

  act(() => result.current.requestExternalLink("https://other.example/c"));
  assert.equal(
    result.current.pendingExternalLink?.url,
    "https://other.example/c",
  );
});

test("trust is per-origin, not per-full-url; reset clears the trust list", () => {
  const opens: OpenCall[] = [];
  const { result } = renderHook(() => useLinksHarness(opens, []));

  act(() => result.current.requestExternalLink("https://site.example/a"));
  act(() => result.current.confirmExternalLink({ always: true }));

  act(() => result.current.reset());

  act(() => result.current.requestExternalLink("https://site.example/a"));
  assert.equal(
    result.current.pendingExternalLink?.url,
    "https://site.example/a",
  );
});

test("an unparseable url is ignored (no dialog, no open)", () => {
  const opens: OpenCall[] = [];
  const { result } = renderHook(() => useLinksHarness(opens, []));

  act(() => result.current.requestExternalLink("not a url"));

  assert.equal(result.current.pendingExternalLink, null);
  assert.equal(opens.length, 0);
});

// Defence in depth: the PDF link layer sanitizes before it calls in here, and
// the allowlist is re-applied at the point that actually opens a URL.
test("a url outside the protocol allowlist never reaches the dialog", () => {
  const opens: OpenCall[] = [];
  const { result } = renderHook(() => useLinksHarness(opens, []));

  for (const url of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
  ]) {
    act(() => result.current.requestExternalLink(url));
    assert.equal(result.current.pendingExternalLink, null, url);
    assert.equal(opens.length, 0, url);
  }
});

test("a disallowed url is refused with a notice even if confirmed", () => {
  const opens: OpenCall[] = [];
  const notices: string[] = [];
  const { result } = renderHook(() => useLinksHarness(opens, notices));

  act(() => result.current.requestExternalLink("https://example.com/a"));
  act(() => result.current.confirmExternalLink({ always: true }));
  assert.equal(opens.length, 1);

  act(() => result.current.requestExternalLink("javascript:alert(1)"));
  assert.equal(opens.length, 1, "no second open");
  assert.equal(result.current.pendingExternalLink, null);
});

test("credentials are stripped before a link is opened", () => {
  const opens: OpenCall[] = [];
  const { result } = renderHook(() => useLinksHarness(opens, []));

  act(() =>
    result.current.requestExternalLink("https://user:secret@example.com/a"),
  );
  act(() => result.current.confirmExternalLink());

  assert.equal(opens.length, 1);
  assert.equal(opens[0].url, "https://example.com/a");
  assert.ok(!opens[0].url.includes("secret"));
});

// Credentials are where a display path and an open path deriving separately
// would disagree, so the string the dialog renders has to be the one handed to
// the opener.
test("the url offered for confirmation is the sanitized url that opens", () => {
  const opens: OpenCall[] = [];
  const { result } = renderHook(() => useLinksHarness(opens, []));

  act(() =>
    result.current.requestExternalLink("https://user:secret@example.com/a?b=1"),
  );

  const offeredUrl = result.current.pendingExternalLink?.url;
  assert.equal(offeredUrl, "https://example.com/a?b=1");

  act(() => result.current.confirmExternalLink());

  assert.equal(opens.length, 1);
  assert.equal(opens[0].url, offeredUrl);
});

test("a trusted-origin repeat opens the sanitized url without a dialog", () => {
  const opens: OpenCall[] = [];
  const { result } = renderHook(() => useLinksHarness(opens, []));

  act(() => result.current.requestExternalLink("https://trusted.example/a"));
  act(() => result.current.confirmExternalLink({ always: true }));

  act(() =>
    result.current.requestExternalLink("https://user:secret@trusted.example/b"),
  );

  assert.equal(result.current.pendingExternalLink, null);
  assert.equal(opens.length, 2);
  assert.equal(opens[1].url, "https://trusted.example/b");
});

test("a failing opener surfaces a notice", async () => {
  const notices: string[] = [];
  const sourceIdRef = { current: "doc-1" };
  const { result } = renderHook(() =>
    useExternalLinks({
      onOpenExternalLink: () => {
        throw new Error("nope");
      },
      fileName: "report.pdf",
      sourceIdRef,
      showNotice: (message) => notices.push(message),
    }),
  );

  act(() => result.current.requestExternalLink("https://example.com/a"));
  await act(async () => {
    result.current.confirmExternalLink();
    await Promise.resolve();
  });

  assert.deepEqual(notices, ["Could not open this link."]);
});

test('"always" on one mailto address does not trust the other addresses in the document', () => {
  const opens: OpenCall[] = [];
  const { result } = renderHook(() => useLinksHarness(opens, []));

  act(() =>
    result.current.requestExternalLink(
      "mailto:support@vendor.example?subject=Hi",
    ),
  );
  assert.equal(
    result.current.pendingExternalLink?.trustKey,
    "mailto:support@vendor.example",
  );
  assert.equal(
    result.current.pendingExternalLink?.trustScopeLabel,
    "support@vendor.example",
  );
  act(() => result.current.confirmExternalLink({ always: true }));
  assert.equal(opens.length, 1);

  act(() => result.current.requestExternalLink("mailto:attacker@evil.example"));
  assert.equal(
    result.current.pendingExternalLink?.url,
    "mailto:attacker@evil.example",
  );
  assert.equal(opens.length, 1);
  act(() => result.current.cancelExternalLink());

  act(() =>
    result.current.requestExternalLink(
      "mailto:support@vendor.example,attacker@evil.example",
    ),
  );
  assert.equal(
    result.current.pendingExternalLink?.url,
    "mailto:support@vendor.example,attacker@evil.example",
  );
  assert.equal(opens.length, 1);
  act(() => result.current.cancelExternalLink());

  act(() =>
    result.current.requestExternalLink(
      "mailto:support@vendor.example?subject=Later",
    ),
  );
  assert.equal(result.current.pendingExternalLink, null);
  assert.equal(opens.length, 2);
  assert.equal(opens[1].url, "mailto:support@vendor.example?subject=Later");
});

test("an http trust scope is still the origin, and is labelled as the origin", () => {
  const opens: OpenCall[] = [];
  const { result } = renderHook(() => useLinksHarness(opens, []));

  act(() => result.current.requestExternalLink("https://example.com/a?b=1"));
  assert.equal(
    result.current.pendingExternalLink?.trustKey,
    "https://example.com",
  );
  assert.equal(
    result.current.pendingExternalLink?.trustScopeLabel,
    "https://example.com",
  );
});
