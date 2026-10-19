// Python str.strip() whitespace: JavaScript trim() additionally removes U+FEFF
// and omits U+001C–001F/U+0085, which would disagree with profile search.
const surroundingWhitespace = /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;

/** Same trim, Unicode lowercase, then ASCII validation as backend ProfileFields. */
export function usernameInput(value: string): string {
  const username = value.replace(surroundingWhitespace, '').toLowerCase();
  if (!/^[a-z0-9_]{3,30}$/.test(username)) throw new Error('Username must be 3–30 ASCII letters, digits, or underscores.');
  return username;
}
