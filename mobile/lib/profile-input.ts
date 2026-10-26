import type { ProfileCreate, ProfileUpdate } from './api';
import { usernameInput } from './username-input';

function displayNameInput(value: string): string {
  const name = value.trim();
  const length = Array.from(name).length;
  if (length < 1 || length > 80) throw new Error('Display name must be 1–80 characters.');
  return name;
}
function timezoneInput(value: string): string {
  // The shared backend/native catalog is authoritative. Preserve identifiers;
  // never substitute UTC or the device zone for the user's chosen timezone.
  if (!value || /^[+-]/.test(value)) throw new Error('Enter an IANA timezone such as Asia/Jerusalem or UTC.');
  return value;
}
export function profileInput(input: ProfileCreate): ProfileCreate {
  return { username: usernameInput(input.username), display_name: displayNameInput(input.display_name), timezone: timezoneInput(input.timezone) };
}

/** Unchanged legacy fields must not become writes just because another field changed. */
export function profileUpdateInput(input: ProfileCreate, saved: ProfileCreate): ProfileUpdate {
  const patch: ProfileUpdate = {};
  if (input.username !== saved.username) {
    const username = usernameInput(input.username);
    if (username !== saved.username) patch.username = username;
  }
  if (input.display_name !== saved.display_name) {
    const name = displayNameInput(input.display_name);
    if (name !== saved.display_name) patch.display_name = name;
  }
  if (input.timezone !== saved.timezone) patch.timezone = timezoneInput(input.timezone);
  return patch;
}
