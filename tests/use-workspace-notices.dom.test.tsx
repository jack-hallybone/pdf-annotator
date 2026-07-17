import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, renderHook } from '@testing-library/react';
import { useWorkspaceNotices } from '../src/workspace/useWorkspaceNotices';

test('shows a notice and auto-dismisses it after its duration', () => {
  const { result } = renderHook(() => useWorkspaceNotices());

  act(() => result.current.showNotice('Saved', 1000));
  assert.equal(result.current.notices.length, 1);
  assert.equal(result.current.notices[0].message, 'Saved');

  const id = result.current.notices[0].id;
  act(() => result.current.dismissNotice(id));
  assert.equal(result.current.notices.length, 0);
});

test('re-showing the same message refreshes instead of stacking a duplicate', () => {
  const { result } = renderHook(() => useWorkspaceNotices());

  act(() => result.current.showNotice('Could not save.'));
  act(() => result.current.showNotice('Could not save.'));

  assert.equal(result.current.notices.length, 1);
  // The refreshed notice is a new entry with a fresh id.
  assert.equal(result.current.notices[0].message, 'Could not save.');
});

test('distinct messages stack in order', () => {
  const { result } = renderHook(() => useWorkspaceNotices());

  act(() => result.current.showNotice('First'));
  act(() => result.current.showNotice('Second'));

  assert.deepEqual(
    result.current.notices.map((notice) => notice.message),
    ['First', 'Second']
  );
});

test('reportMalformedAnnotations ignores zero and pluralises', () => {
  const { result } = renderHook(() => useWorkspaceNotices());

  act(() => result.current.reportMalformedAnnotations(0));
  assert.equal(result.current.notices.length, 0);

  act(() => result.current.reportMalformedAnnotations(1));
  assert.match(result.current.notices[0].message, /^1 annotation could not/);

  act(() => result.current.reportMalformedAnnotations(3));
  assert.match(result.current.notices[1].message, /^3 annotations could not/);
});

test('auto-dismiss timer removes the notice when it elapses', async () => {
  const { result } = renderHook(() => useWorkspaceNotices());

  act(() => result.current.showNotice('Temporary', 20));
  assert.equal(result.current.notices.length, 1);

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
  assert.equal(result.current.notices.length, 0);
});
