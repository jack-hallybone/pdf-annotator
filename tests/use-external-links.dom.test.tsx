import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useRef } from 'react';
import { act, renderHook } from '@testing-library/react';
import { useExternalLinks } from '../src/workspace/useExternalLinks';

type OpenCall = { url: string; fileName: string; sourceId: string };

function useLinksHarness(opens: OpenCall[], notices: string[]) {
  const sourceIdRef = useRef('doc-1');
  return useExternalLinks({
    onOpenExternalLink: (url, context) => {
      opens.push({ url, fileName: context.fileName, sourceId: context.sourceId });
    },
    fileName: 'report.pdf',
    sourceIdRef,
    showNotice: (message) => notices.push(message)
  });
}

test('an untrusted link opens the confirmation dialog instead of opening', () => {
  const opens: OpenCall[] = [];
  const { result } = renderHook(() => useLinksHarness(opens, []));

  act(() => result.current.requestExternalLink('https://example.com/a'));

  assert.equal(opens.length, 0);
  assert.equal(result.current.pendingExternalLink?.url, 'https://example.com/a');
  assert.equal(result.current.pendingExternalLink?.trustKey, 'https://example.com');
});

test('confirming opens the link with file context and clears the dialog', () => {
  const opens: OpenCall[] = [];
  const { result } = renderHook(() => useLinksHarness(opens, []));

  act(() => result.current.requestExternalLink('https://example.com/a'));
  act(() => result.current.confirmExternalLink());

  assert.equal(result.current.pendingExternalLink, null);
  assert.deepEqual(opens, [
    { url: 'https://example.com/a', fileName: 'report.pdf', sourceId: 'doc-1' }
  ]);
});

test('cancelling closes the dialog without opening', () => {
  const opens: OpenCall[] = [];
  const { result } = renderHook(() => useLinksHarness(opens, []));

  act(() => result.current.requestExternalLink('https://example.com/a'));
  act(() => result.current.cancelExternalLink());

  assert.equal(result.current.pendingExternalLink, null);
  assert.equal(opens.length, 0);
});

test('"always" trusts the origin so later links from it open without a prompt', () => {
  const opens: OpenCall[] = [];
  const { result } = renderHook(() => useLinksHarness(opens, []));

  act(() => result.current.requestExternalLink('https://trusted.example/a'));
  act(() => result.current.confirmExternalLink({ always: true }));
  assert.equal(opens.length, 1);

  // Same origin, different path: opens directly, no dialog.
  act(() => result.current.requestExternalLink('https://trusted.example/b'));
  assert.equal(result.current.pendingExternalLink, null);
  assert.equal(opens.length, 2);
  assert.equal(opens[1].url, 'https://trusted.example/b');

  // A different origin is still gated.
  act(() => result.current.requestExternalLink('https://other.example/c'));
  assert.equal(result.current.pendingExternalLink?.url, 'https://other.example/c');
});

test('trust is per-origin, not per-full-url; reset clears the trust list', () => {
  const opens: OpenCall[] = [];
  const { result } = renderHook(() => useLinksHarness(opens, []));

  act(() => result.current.requestExternalLink('https://site.example/a'));
  act(() => result.current.confirmExternalLink({ always: true }));

  act(() => result.current.reset());

  // After reset the origin is untrusted again, so it prompts.
  act(() => result.current.requestExternalLink('https://site.example/a'));
  assert.equal(result.current.pendingExternalLink?.url, 'https://site.example/a');
});

test('an unparseable url is ignored (no dialog, no open)', () => {
  const opens: OpenCall[] = [];
  const { result } = renderHook(() => useLinksHarness(opens, []));

  act(() => result.current.requestExternalLink('not a url'));

  assert.equal(result.current.pendingExternalLink, null);
  assert.equal(opens.length, 0);
});

test('a failing opener surfaces a notice', async () => {
  const notices: string[] = [];
  const sourceIdRef = { current: 'doc-1' };
  const { result } = renderHook(() =>
    useExternalLinks({
      onOpenExternalLink: () => {
        throw new Error('nope');
      },
      fileName: 'report.pdf',
      sourceIdRef,
      showNotice: (message) => notices.push(message)
    })
  );

  act(() => result.current.requestExternalLink('https://example.com/a'));
  // The opener is awaited inside the hook, so the error handler that raises
  // the notice runs on a microtask - flush it before asserting.
  await act(async () => {
    result.current.confirmExternalLink();
    await Promise.resolve();
  });

  assert.deepEqual(notices, ['Could not open this link.']);
});
