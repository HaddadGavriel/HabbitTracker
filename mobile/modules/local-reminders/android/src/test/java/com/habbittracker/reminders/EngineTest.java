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
    Fake p = new Fake(); Journal j = new Journal(p);
    p.state = new Journal.State("lease", List.of(a,b), Instant.parse("2026-10-21T00:00:00Z"));
    j.restore(); eq(p.armed, Instant.parse("2026-10-21T08:00:00Z"));
    p.failArm = true;
    try { j.replace("lease", List.of(b), p.state.cursor); throw new AssertionError(); } catch (IllegalStateException expected) {}
    eq(p.state.rules, List.of(b)); // replacement persisted before partial OS failure
    p.failArm = false; new Journal(p).restore(); eq(p.armed, Instant.parse("2026-10-21T09:00:00Z"));
    p.failSave = true;
    try { j.tick(p.armed); throw new AssertionError(); } catch (IllegalStateException expected) {}
    eq(p.visible.size(), 1);
    p.failSave = false; new Journal(p).tick(p.armed); eq(p.visible.size(), 1); // stable identity retry
    j.tick(Instant.parse("2026-10-21T10:00:00Z")); eq(p.visible.size(), 1);
    try { j.replace("old-account", List.of(a), p.state.cursor); throw new AssertionError(); } catch (IllegalStateException expected) {}
    j.replace("lease", List.of(), p.state.cursor); eq(p.armed, null);
    p.state = null; j.restore(); eq(p.armed, null);
    p.state = new Journal.State("lease", List.of(a), Instant.parse("2026-10-21T00:00:00Z"));
    eq(j.tick(Instant.parse("2027-01-01T00:00:00Z")), false); // bounded drain retains backlog
    eq(j.tick(Instant.parse("2027-01-01T00:00:00Z")), true);
    System.out.println("Planner and journal tests passed (DST, zones, floors, capacity, restart and injected faults)");
  }
  static class Fake implements Journal.Port {
    Journal.State state; Instant armed; boolean failArm, failSave;
    Set<String> visible = new HashSet<>();
    public Journal.State load() { return state; }
    public void save(Journal.State value) { if(failSave) throw new IllegalStateException(); state=value; }
    public void arm(Instant time) { if(failArm) throw new IllegalStateException(); armed=time; }
    public void cancel() { armed=null; }
    public void present(List<Planner.Event> events) { events.forEach(e -> visible.add(e.id)); }
  }
}
