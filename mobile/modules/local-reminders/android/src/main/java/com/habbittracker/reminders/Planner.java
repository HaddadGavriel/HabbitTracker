package com.habbittracker.reminders;

import java.time.*;
import java.util.*;

/** Pure wall-clock planner. No device zone, database writes, completion or streaks. */
public final class Planner {
  public static final class Rule {
    public final String owner, habit;
    public final ZoneId zone;
    public final LocalDate start, onlyDate;
    public final Instant closes;
    public final Set<Integer> weekdays;
    public final LocalTime time;
    public Rule(String owner, String habit, String zone, String start, String onlyDate,
                String closes, Set<Integer> weekdays, String time) {
      this.owner = UUID.fromString(owner).toString();
      this.habit = UUID.fromString(habit).toString();
      this.zone = ZoneId.of(zone);
      this.start = LocalDate.parse(start);
      this.onlyDate = onlyDate == null ? null : LocalDate.parse(onlyDate);
      this.closes = closes == null ? null : Instant.parse(closes);
      this.weekdays = Collections.unmodifiableSet(new HashSet<>(weekdays));
      if (weekdays.stream().anyMatch(d -> d < 1 || d > 7)) throw new IllegalArgumentException("weekday");
      if (!time.matches("(?:[01][0-9]|2[0-3]):[0-5][0-9]")) throw new IllegalArgumentException("time");
      this.time = LocalTime.parse(time);
    }
  }
  public static final class Event {
    public final Rule rule;
    public final LocalDate date;
    public final Instant instant;
    public final String id;
    Event(Rule rule, LocalDate date, Instant instant) {
      this.rule = rule; this.date = date; this.instant = instant;
      // Logical identity survives plan replacement; distinct configured times stay distinct in gaps.
      id = rule.owner + "/" + rule.habit + "/" + date + "/" + rule.time;
    }
  }
  /** Gap: shift by gap duration. Overlap: earlier offset, exactly once. */
  public static Instant resolve(LocalDate date, LocalTime time, ZoneId zone) {
    return ZonedDateTime.ofLocal(LocalDateTime.of(date, time), zone, null).toInstant();
  }
  public static Event next(Rule rule, Instant after) {
    LocalDate date = rule.onlyDate == null ? after.atZone(rule.zone).toLocalDate() : rule.onlyDate;
    if (date.isBefore(rule.start)) date = rule.start;
    // Allow a skipped civil date on the only selected weekday, then the following week.
    for (int i = 0; i < 16; i++, date = date.plusDays(1)) {
      if (rule.onlyDate != null && !date.equals(rule.onlyDate)) return null;
      if (!rule.weekdays.isEmpty() && !rule.weekdays.contains(date.getDayOfWeek().getValue())) continue;
      Instant instant = resolve(date, rule.time, rule.zone);
      // Skipped civil dates (e.g. Apia 2011) must not deliver on another date.
      if (!instant.atZone(rule.zone).toLocalDate().equals(date)) continue;
      if (instant.isAfter(after) && (rule.closes == null || instant.isBefore(rule.closes)))
        return new Event(rule, date, instant);
    }
    throw new IllegalStateException("No next weekly reminder; repair required");
  }
  public static List<Event> nextBatch(List<Rule> rules, Instant after) {
    List<Event> events = new ArrayList<>(); Instant earliest = null;
    Set<String> ids = new HashSet<>();
    for (Rule rule : rules) {
      Event event = next(rule, after);
      if (event == null) continue;
      if (earliest == null || event.instant.isBefore(earliest)) {
        events.clear(); ids.clear(); earliest = event.instant;
      }
      if (event.instant.equals(earliest) && ids.add(event.id)) events.add(event);
    }
    events.sort(Comparator.comparing(e -> e.id));
    return events;
  }
}
