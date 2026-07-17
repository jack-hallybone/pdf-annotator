import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useState } from 'react';
import { act, render, renderHook, screen } from '@testing-library/react';

// Proves the jsdom + Testing Library harness is wired: a DOM exists,
// components render, and hook state updates flush under act().

test('renders a component into jsdom', () => {
  render(<button type="button">Save</button>);
  assert.ok(screen.getByRole('button', { name: 'Save' }));
});

test('renderHook drives React state updates', () => {
  const { result } = renderHook(() => {
    const [count, setCount] = useState(0);
    return { count, increment: () => setCount((value) => value + 1) };
  });

  assert.equal(result.current.count, 0);
  act(() => result.current.increment());
  assert.equal(result.current.count, 1);
});
