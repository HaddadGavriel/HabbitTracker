package com.habbittracker.reminders;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.time.*;
import java.util.*;
import java.util.stream.Collectors;

/** Same exact identifier catalog as backend profile writes; never guess an offset. */
public final class TimezonePolicy {
  private TimezonePolicy() {}
  private static final Set<String> SUPPORTED = load();
  private static Set<String> load() {
    try (InputStream input = TimezonePolicy.class.getResourceAsStream("/timezones-v1.txt")) {
      if (input == null) throw new IllegalStateException("Missing timezone contract");
      try (BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
        return Collections.unmodifiableSet(reader.lines().filter(s -> !s.isEmpty() && !s.startsWith("#"))
          .collect(Collectors.toSet()));
      }
    } catch (IOException error) { throw new IllegalStateException("Cannot load timezone contract", error); }
  }
  public static final class UnsupportedTimezone extends DateTimeException {
    UnsupportedTimezone(String id) { super("Unsupported timezone: " + id); }
  }
  public static ZoneId resolve(String id) {
    if (!SUPPORTED.contains(id)) throw new UnsupportedTimezone(id);
    try { return ZoneId.of(id); }
    // An older device's tzdb may not yet know a catalog identifier. Pause safely
    // rather than falling back to UTC/the device zone or changing stored snapshots.
    catch (DateTimeException error) { throw new UnsupportedTimezone(id); }
  }
}
