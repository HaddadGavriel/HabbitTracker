import aliases from './timezone-aliases.json';

/** Only the initial device suggestion uses reviewed IANA equivalents. Explicit
 * form input and persisted profile/occurrence identifiers remain untouched. */
export function deviceTimezone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return Object.prototype.hasOwnProperty.call(aliases, zone)
      ? aliases[zone as keyof typeof aliases] : zone || '';
  } catch {
    // Unknown device timezone needs an explicit choice, never an assumed UTC.
    return '';
  }
}
