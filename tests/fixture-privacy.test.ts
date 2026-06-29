import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureUrl } from './pdfTestUtils';

const deniedFixturePatterns = [
  {
    label: 'Windows user path',
    pattern: /c:[/\\]users[/\\]/i
  },
  {
    label: 'Unix home path',
    pattern: /\/home\/[^/\s)]+/i
  },
  {
    label: 'macOS user path',
    pattern: /\/users\/[^/\s)]+/i
  },
  {
    label: 'private key block',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/i
  }
];

test('committed PDF fixtures do not contain local identity strings', async () => {
  const fixtureFiles = (await readdir(fixtureUrl))
    .filter((name) => name.endsWith('.pdf'))
    .sort();
  assert.ok(fixtureFiles.length > 0, 'expected at least one PDF fixture');

  for (const fixtureFile of fixtureFiles) {
    const text = Buffer.from(
      await readFile(new URL(fixtureFile, fixtureUrl))
    ).toString('latin1');
    const lowerText = text.toLowerCase();

    for (const { label, pattern } of deniedFixturePatterns) {
      assert.equal(
        pattern.test(lowerText),
        false,
        `${fixtureFile} contains ${label}`
      );
    }
  }
});
