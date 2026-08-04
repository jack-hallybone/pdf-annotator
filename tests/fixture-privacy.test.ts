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

// Only the domains reserved for documentation and testing (RFC 2606/6761).
// Anything else is somebody's real address.
const allowedFixtureEmailDomains = [
  'example.com',
  'example.net',
  'example.org',
  'example.invalid',
  'example.test',
  'localhost'
];

const fixtureEmailPattern = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}/gi;

test('committed PDF fixtures do not contain local identity strings', async () => {
  const fixtureFiles = await pdfFixtureFiles();

  for (const fixtureFile of fixtureFiles) {
    const text = await fixtureScanText(fixtureFile);
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

// A signed fixture carries its signer's certificate inside the /Contents hex
// blob, so a plain ASCII scan of the file cannot see the identity in it. That
// is exactly how a third-party sample PDF carrying an unrelated real name and
// email address once sat in this directory unnoticed - the scan has to decode
// the hex before it can see anything.
test('committed PDF fixtures carry no real email addresses', async () => {
  for (const fixtureFile of await pdfFixtureFiles()) {
    const text = await fixtureScanText(fixtureFile);
    const addresses = new Set(text.match(fixtureEmailPattern) ?? []);

    for (const address of addresses) {
      const domain = address.split('@')[1]?.toLowerCase() ?? '';
      assert.ok(
        allowedFixtureEmailDomains.some(
          (allowed) => domain === allowed || domain.endsWith(`.${allowed}`)
        ),
        `${fixtureFile} contains the email address ${address}, which is not in a reserved test domain`
      );
    }
  }
});

async function pdfFixtureFiles() {
  const fixtureFiles = (await readdir(fixtureUrl))
    .filter((name) => name.endsWith('.pdf'))
    .sort();
  assert.ok(fixtureFiles.length > 0, 'expected at least one PDF fixture');
  return fixtureFiles;
}

// The raw bytes plus anything hidden inside a hex string - which is where a
// PKCS#7 signature blob, and therefore a certificate's subject, lives.
async function fixtureScanText(fixtureFile: string) {
  const bytes = Buffer.from(await readFile(new URL(fixtureFile, fixtureUrl)));
  const raw = bytes.toString('latin1');
  return [raw, ...decodedHexStrings(raw)].join('\n');
}

function decodedHexStrings(raw: string) {
  const decoded: string[] = [];
  // Long hex strings only: short ones are ordinary PDF values (IDs, dates),
  // not embedded binary structures worth decoding.
  for (const match of raw.matchAll(/<([0-9A-Fa-f\s]{512,})>/g)) {
    const hex = match[1].replace(/\s/g, '');
    if (hex.length % 2 !== 0) {
      continue;
    }
    decoded.push(Buffer.from(hex, 'hex').toString('latin1'));
  }
  return decoded;
}
