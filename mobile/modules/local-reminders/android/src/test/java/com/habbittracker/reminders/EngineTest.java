package com.habbittracker.reminders;
import java.time.*;
import java.util.*;

/** Runs with plain javac/java too, testing the exact production planner/coordinator. */
public class EngineTest {
  static final String OWNER = "aaaaaaaa-1111-4111-8111-111111111111";
  static final String HABIT = "bbbbbbbb-2222-4222-8222-222222222222";
  static void eq(Object actual, Object expected) {
    if (!Objects.equals(actual, expected)) throw new AssertionError(actual + " != " + expected);
  }
  static Planner.Rule rule(String zone, String start, String time, Set<Integer> days) {
    return new Planner.Rule(OWNER, HABIT, zone, start, null, null, days, time);
  }
  static void next(Planner.Rule r, String after, String expected) {
    eq(Planner.next(r, Instant.parse(after)).instant, Instant.parse(expected));
  }
  public static void main(String[] args) {
    TimeZone.setDefault(TimeZone.getTimeZone("Pacific/Honolulu"));
    next(rule("Asia/Jerusalem", "2026-10-21", "08:00", Set.of()), "2026-10-20T00:00:00Z", "2026-10-21T05:00:00Z");
    next(rule("UTC", "2026-10-21", "08:00", Set.of(1, 5)), "2026-10-21T00:00:00Z", "2026-10-23T08:00:00Z");
    next(rule("America/New_York", "2026-03-08", "02:30", Set.of()), "2026-03-08T05:00:00Z", "2026-03-08T07:30:00Z");
    next(rule("America/New_York", "2026-11-01", "01:30", Set.of()), "2026-11-01T04:00:00Z", "2026-11-01T05:30:00Z");
    next(rule("America/New_York", "2026-11-01", "01:30", Set.of()), "2026-11-01T05:30:00Z", "2026-11-02T06:30:00Z");
    next(rule("Australia/Lord_Howe", "2026-10-04", "02:15", Set.of()), "2026-10-03T00:00:00Z", "2026-10-03T15:45:00Z");
    next(rule("Pacific/Apia", "2011-12-30", "08:00", Set.of()), "2011-12-29T00:00:00Z", "2011-12-30T18:00:00Z");
    Planner.Rule snapshot = new Planner.Rule(OWNER, HABIT, "UTC", "2026-10-21", "2026-10-21", "2026-10-21T08:00:00Z", Set.of(), "08:00");
    eq(Planner.next(snapshot, Instant.parse("2026-10-21T00:00:00Z")), null);
    Planner.Rule a = rule("UTC", "2026-10-21", "08:00", Set.of());
    Planner.Rule b = rule("UTC", "2026-10-21", "09:00", Set.of());
    eq(Planner.nextBatch(List.of(a, a, b), Instant.parse("2026-10-21T00:00:00Z")).size(), 1);
    List<Planner.Rule> many = new ArrayList<>();
    for (int i=0; i<1000; i++) many.add(new Planner.Rule(OWNER, new UUID(0,i).toString(), "UTC", "2026-10-21", null, null, Set.of(), "08:00"));
    eq(Planner.nextBatch(many, Instant.parse("2026-10-21T00:00:00Z")).size(), 1000);
    Planner.Rule gapA = rule("America/New_York", "2026-03-08", "02:30", Set.of());
    Planner.Rule gapB = rule("America/New_York", "2026-03-08", "03:30", Set.of());
    eq(Planner.nextBatch(List.of(gapA, gapB), Instant.parse("2026-03-08T05:00:00Z")).size(), 2);
    next(rule("Pacific/Apia", "2011-12-24", "08:00", Set.of(5)), "2011-12-24T00:00:00Z", "2012-01-05T18:00:00Z");
    replacementAndFailures(a, b);
    backlogAndAuthority(a);
    System.out.println("Planner and journal tests passed (DST, replacement, bounded backlog, durable outbox and faults)");
  }
  static Instant at(String time) { return Instant.parse("2026-10-21T" + time + ":00Z"); }
  static void replace(Journal j, List<Planner.Rule> rules, Instant now) {
    j.replace("lease", rules, now, now.atZone(ZoneOffset.UTC).toLocalDate());
  }
  static void fails(Runnable action) {
    try { action.run(); throw new AssertionError("expected failure"); } catch (IllegalStateException expected) {}
  }
  static void replacementAndFailures(Planner.Rule a, Planner.Rule b) {
    Fake p = new Fake(); Journal j = new Journal(p);
    p.state = new Journal.State("lease", List.of(a, b), at("00:00"));
    j.restore(); eq(p.armed, at("08:00"));
    // A newly introduced 07:00 rule must not replay, but existing overdue 08:00 survives.
    List<Planner.Rule> refreshed = List.of(a, b, rule("UTC", "2026-10-21", "07:00", Set.of()));
    replace(j, refreshed, at("08:05"));
    for (int i = 0; i < 10; i++) replace(new Journal(p), refreshed, at("08:06"));
    eq(p.state.pending.get(0).instant, at("08:00")); eq(p.state.backlog.size(), 1);
    p.failSave = true; fails(() -> j.tick(at("08:06")));
    eq(p.state.total, 0L); eq(p.presentations.size(), 0); // failed transaction didn't consume anything
    p.failSave = false; p.failPresent = true; fails(() -> new Journal(p).tick(at("08:06")));
    eq(p.state.total, 1L); eq(p.state.presentationPending, true);
    // A refresh/crash must preserve the already counted outbox too.
    replace(new Journal(p), refreshed, at("08:07")); eq(p.state.total, 1L);
    p.failPresent = false; p.failAfterPresentation = true;
    fails(() -> new Journal(p).tick(at("08:07"))); eq(p.state.presentationPending, true);
    p.failAfterPresentation = false; p.failSave = false;
    new Journal(p).tick(at("08:07")); eq(p.state.total, 1L); eq(p.state.presentationPending, false);
    eq(p.presentations.get(1L), 1L); // same sequence/count on every physical retry
    replace(j, refreshed, at("08:08")); j.tick(at("08:08")); eq(p.state.total, 1L);
    j.tick(at("09:00")); eq(p.state.total, 2L);
    p.state = p.state.acknowledge(1); eq(p.state.acknowledged, 1L); // old tap doesn't acknowledge newer work
    p.state = p.state.acknowledge(2); eq(p.state.acknowledged, 2L);
    fails(() -> j.replace("old-account", List.of(a), at("10:00"), LocalDate.parse("2026-10-21")));
    replace(j, List.of(), at("10:00")); eq(p.armed, null);
  }
  static void backlogAndAuthority(Planner.Rule a) {
    Fake p = new Fake(); Journal j = new Journal(p);
    p.state = new Journal.State("lease", List.of(a), at("00:00"));
    p.failArm = true; fails(() -> replace(j, List.of(a), at("07:00")));
    eq(p.state.cursor, at("07:00")); p.failArm = false; new Journal(p).restore(); eq(p.armed, at("08:00"));
    // Authoritative removal cancels an overdue current-day projection; new 08:01 isn't replayed.
    replace(j, List.of(rule("UTC", "2026-10-21", "08:01", Set.of())), at("08:05"));
    j.tick(at("08:05")); eq(p.state.total, 0L);
    eq(p.state.pending.get(0).instant, Instant.parse("2026-10-22T08:01:00Z"));
    // More than two drain passes, with a refresh and fresh coordinator between each pass.
    p.state = new Journal.State("lease", List.of(a), at("00:00"));
    Instant later = Instant.parse("2027-03-01T08:05:00Z"); // 132 elapsed daily batches
    Planner.Rule snapshot = new Planner.Rule(OWNER, HABIT, "UTC", "2027-03-01", "2027-03-01",
      "2027-03-02T00:00:00Z", Set.of(), "08:00");
    List<Planner.Rule> current = List.of(snapshot, rule("UTC", "2027-03-02", "08:00", Set.of()));
    replace(j, current, later); eq(j.tick(later), false); eq(p.state.total, 64L);
    // Roll back the profile date during catch-up (e.g. travel to Honolulu).
    new Journal(p).replace("lease", current, later, LocalDate.parse("2027-02-28"));
    eq(new Journal(p).tick(later), false); eq(p.state.total, 128L);
    replace(new Journal(p), current, later); eq(new Journal(p).tick(later), true); eq(p.state.total, 132L);
    eq(p.state.backlog.size(), 0);
    replace(j, current, later); j.tick(later); eq(p.state.total, 132L);
    p.state = null; j.restore(); eq(p.armed, null); // cancellation discards all prior-account work
  }
  static class Fake implements Journal.Port {
    Journal.State state; Instant armed; boolean failArm, failSave, failPresent, failAfterPresentation;
    Map<Long, Long> presentations = new HashMap<>();
    public Journal.State load() { return state; }
    public void save(Journal.State value) { if (failSave) throw new IllegalStateException(); state = value; }
    public void arm(Instant time) { if (failArm) throw new IllegalStateException(); armed = time; }
    public void cancel() { armed = null; }
    public void present(Journal.State value) {
      if (failPresent) throw new IllegalStateException();
      Long count = presentations.put(value.total, value.total - value.acknowledged);
      if (count != null) eq(count, value.total - value.acknowledged);
      if (failAfterPresentation) failSave = true;
    }
  }
}
