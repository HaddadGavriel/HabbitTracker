// Keep credentials out of Router params/history. Linking consumes the original URL.
export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  if (/(?:access_token|refresh_token|token_hash|error_code|type|code)=/.test(path) || /auth-callback/.test(path)) return '/auth-callback';
  return path;
}
