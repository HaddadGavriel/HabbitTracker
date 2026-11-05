// Diagnostic evidence, not an installed-app exploit or a dependency patch.
// Usage: node dependency-probes.cjs /absolute/repo/mobile /absolute/zod-4.6.7-package
// Obtain the second path by npm pack zod@4.6.7 and extracting it outside the repo.
const { createRequire } = require('node:module');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');
const installed = createRequire(resolve(process.argv[2], 'package.json'));
const zod4 = createRequire(resolve(process.argv[3], 'package.json'));
for (const [name, z] of [
  ['locked 3.25.76', installed('zod').z],
  ['4.6.7 root', zod4('./index.cjs').z],
  ['4.6.7 /v3', zod4('./v3/index.cjs').z],
]) {
  const result = z.array(z.string()).max(1).safeParse(Array(10000).fill(0));
  const optionalDefault = z.object({ label: z.string().default('fallback').optional() }).parse({});
  console.log(JSON.stringify({ package: name, issues: result.error.issues.length, optionalDefault }));
  assert.equal(result.error.issues.length, name === '4.6.7 root' ? 1 : 10001);
}
// Based on the synthetic malformed-DigestAlgorithm regression in forge PR #1158.
// e=1 isolates the parser behavior; this does not demonstrate a real-key forgery.
const forge = installed('node-forge');
const key = forge.pki.rsa.setPublicKey(
  new forge.jsbn.BigInteger('f'.repeat(256), 16), new forge.jsbn.BigInteger('1', 10));
const md = forge.md.sha256.create();
md.update('nested-digest-algorithm');
const digest = md.digest().getBytes();
const info = forge.util.hexToBytes('30343010060960864801650304020105000401000420') + digest;
const signature = forge.util.hexToBytes('0001' + 'ff'.repeat(128 - info.length - 3) + '00') + info;
const accepted = key.verify(digest, signature);
console.log(JSON.stringify({ package: 'node-forge@' + installed('node-forge/package.json').version,
  syntheticMalformedDigestAlgorithmAccepted: accepted, source: 'digitalbazaar/forge#1158' }));
assert.equal(accepted, true);
