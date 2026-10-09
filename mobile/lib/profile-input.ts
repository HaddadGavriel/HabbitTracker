import type { ProfileCreate } from './api';
export function profileInput(input: ProfileCreate): ProfileCreate {
  const profile = { username: input.username.trim().toLowerCase(), display_name: input.display_name.trim(), timezone: input.timezone };
  if (!/^[a-z0-9_]{3,30}$/.test(profile.username)) throw new Error('Username must be 3–30 ASCII letters, digits, or underscores.');
  const length = Array.from(profile.display_name).length;
  if (length < 1 || length > 80) throw new Error('Display name must be 1–80 characters.');
  // The backend IANA database is authoritative; Intl can accept aliases/offsets
  // that Python does not, so do not silently canonicalize this field.
  if (!profile.timezone || /^[+-]/.test(profile.timezone)) throw new Error('Enter an IANA timezone such as Asia/Jerusalem or UTC.');
  return profile;
}
