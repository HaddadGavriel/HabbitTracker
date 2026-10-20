// Python str.strip() whitespace, deliberately excluding JavaScript's BOM trim.
const edgeWhitespace = /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;

export function trimExplanation(value: string): string { return value.replace(edgeWhitespace, ''); }

export function explanationInput(value: string): string {
  const trimmed = trimExplanation(value);
  const points = Array.from(trimmed);
  if (points.length < 1 || points.length > 1000) throw new Error('Explanation must contain 1–1,000 Unicode characters after trimming whitespace.');
  if (points.some(point => point === '\0' || (point.length === 1 && point.charCodeAt(0) >= 0xd800 && point.charCodeAt(0) <= 0xdfff))) {
    throw new Error('Explanation cannot contain NUL characters or unpaired Unicode surrogates.');
  }
  return trimmed;
}
