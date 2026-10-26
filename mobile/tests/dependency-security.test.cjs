const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dirname } = require('node:path');
const { spawnSync } = require('node:child_process');
const query = require('query-string');
const decoderPath = require.resolve('decode-uri-component', { paths: [dirname(require.resolve('query-string'))] });
const decode = require(decoderPath);

test('Expo Router query parser uses the fixed CommonJS decoder without changing URL semantics', () => {
  assert.ok(decoderPath.includes('vendor/decode-uri-component'), decoderPath);
  assert.deepEqual({ ...query.parse('name=%D7%A9%D7%9C%D7%95%D7%9D&word=one+two&tag=a&tag=b') },
    { name: 'שלום', word: 'one two', tag: ['a', 'b'] });
  assert.equal(decode('one+two'), 'one two');
  assert.equal(decode('%F0%9F%8C%99'), '🌙');
  assert.equal(decode('%FF%41%C3%A5'), '%FFAå');
  assert.equal(decode('%25FF'), '%FF');
  assert.throws(() => decode(null), TypeError);
});

test('large malformed URL bytes finish within a bounded subprocess deadline', () => {
  const result = spawnSync(process.execPath, ['-e', `
    const query = require('query-string');
    const input = '%FF'.repeat(20000) + '%41';
    if (query.parse('value=' + input).value !== '%FF'.repeat(20000) + 'A') process.exit(2);
  `], { cwd: `${__dirname}/..`, timeout: 3000, encoding: 'utf8' });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
});
