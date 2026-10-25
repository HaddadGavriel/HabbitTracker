package com.habbittracker.reminders;

import java.time.*;
import java.util.*;

/** Durable recurrence windows and a counted presentation outbox; no Android dependencies. */
public final class Journal {
  /** Work earned under an earlier plan, in (cursor, until]. Never expanded into a finite queue. */
  public static final class Window {
    public final List<Planner.Rule> rules;
    public final Instant cursor, until;
    public Window(List<Planner.Rule> rules, Instant cursor, Instant until) {
      this.rules = List.copyOf(rules); this.cursor = cursor; this.until = until;
    }
    public List<Planner.Event> pending() {
      List<Planner.Event> batch = Planner.nextBatch(rules, cursor);
      return batch.isEmpty() || batch.get(0).instant.isAfter(until) ? List.of() : batch;
    }
  }
  public static final class State {
    public final String lease;
    public final List<Planner.Rule> rules;
    public final Instant cursor;
    public final List<Window> backlog;
    public final List<Planner.Event> pending;
    public final long total, acknowledged;
    public final boolean presentationPending;
    public State(String lease, List<Planner.Rule> rules, Instant cursor) {
      this(lease, rules, cursor, List.of(), 0, 0, false);
    }
    public State(String lease, List<Planner.Rule> rules, Instant cursor, List<Window> backlog,
                 long total, long acknowledged, boolean presentationPending) {
      if (acknowledged < 0 || total < acknowledged) throw new IllegalArgumentException("count");
      this.lease = lease; this.rules = List.copyOf(rules); this.cursor = cursor;
      this.backlog = Collections.unmodifiableList(backlog.stream().filter(w -> !w.pending().isEmpty())
        .collect(java.util.stream.Collectors.toList()));
      this.total = total; this.acknowledged = acknowledged; this.presentationPending = presentationPending;
      List<List<Planner.Event>> batches = new ArrayList<>();
      batches.add(Planner.nextBatch(rules, cursor));
      this.backlog.forEach(w -> batches.add(w.pending()));
      Instant first = batches.stream().filter(b -> !b.isEmpty()).map(b -> b.get(0).instant)
        .min(Comparator.naturalOrder()).orElse(null);
      Map<String, Planner.Event> events = new TreeMap<>();
      for (List<Planner.Event> batch : batches)
        if (!batch.isEmpty() && batch.get(0).instant.equals(first)) batch.forEach(e -> events.put(e.id, e));
      this.pending = List.copyOf(events.values());
    }
    public State acknowledge(long sequence) {
      long ack = Math.max(acknowledged, Math.min(total, Math.max(0, sequence)));
      return new State(lease, rules, cursor, backlog, total, ack, presentationPending && ack < total);
    }
    State presented() { return new State(lease, rules, cursor, backlog, total, acknowledged, false); }
    State consume() {
      Instant time = pending.get(0).instant;
      List<Window> next = new ArrayList<>();
      for (Window w : backlog) {
        List<Planner.Event> batch = w.pending();
        next.add(new Window(w.rules, !batch.isEmpty() && batch.get(0).instant.equals(time) ? time : w.cursor, w.until));
      }
      List<Planner.Event> active = Planner.nextBatch(rules, cursor);
      Instant advanced = !active.isEmpty() && active.get(0).instant.equals(time) ? time : cursor;
      return new State(lease, rules, advanced, next, Math.addExact(total, pending.size()), acknowledged, true);
    }
  }
  public interface Port {
    State load();
    void save(State state); // atomically persist cursors, count AND outbox or throw
    void arm(Instant time); // replaces ONE stable alarm; throws on capacity/error
    void cancel();
    void present(State state); // retry the aggregate count in one stable notification slot
  }
  private final Port port;
  public Journal(Port port) { this.port = port; }

  /** Same transition used by Android when atomically replacing the plan and its clock anchor. */
  public static State replacement(State old, String lease, List<Planner.Rule> rules,
                                  Instant serverNow, LocalDate authoritativeDate) {
    if (old == null || !old.lease.equals(lease)) throw new IllegalStateException("stale lease");
    Instant cutover = old.cursor.isAfter(serverNow) ? old.cursor : serverNow;
    List<Window> outstanding = new ArrayList<>(old.backlog);
    outstanding.add(new Window(old.rules, old.cursor, cutover));
    List<Window> retained = new ArrayList<>();
    for (Window w : outstanding) {
      List<Planner.Rule> confirmed = new ArrayList<>();
      for (Planner.Rule previous : w.rules) {
        // Snapshots and already-frozen historical rules are immutable. A later
        // timezone rollback must not turn their earned backlog into a prediction.
        if (previous.onlyDate != null || previous.closes != null) { confirmed.add(previous); continue; }
        // The plan has no historical revocation information. Preserve elapsed dates;
        // today's/open projected work must still be authorized by the refreshed plan.
        Instant historyEnd = authoritativeDate.atStartOfDay(previous.zone).toInstant();
        confirmed.add(copy(previous, previous.start, previous.onlyDate, min(previous.closes, historyEnd), previous.weekdays));
        for (Planner.Rule current : rules) {
          Planner.Rule intersection = intersect(previous, current, authoritativeDate);
          if (intersection != null) confirmed.add(intersection);
        }
      }
      confirmed.removeIf(r -> {
        Planner.Event next = Planner.next(r, w.cursor);
        return next == null || next.instant.isAfter(w.until);
      });
      retained.add(new Window(confirmed, w.cursor, w.until));
    }
    // Newly introduced rules only become active AFTER the cutover, never retroactively.
    return new State(lease, rules, cutover, retained, old.total, old.acknowledged, old.presentationPending);
  }
  /** Product reconciliation drops elapsed predictions and old outbox work. The server
   * supplies immutable same-day snapshots; absence now means ineligible. */
  public static State reconcile(State old, String lease, List<Planner.Rule> rules, Instant now) {
    if (old == null || !old.lease.equals(lease)) throw new IllegalStateException("stale lease");
    return new State(lease, rules, old.cursor.isAfter(now) ? old.cursor : now,
      List.of(), old.total, old.total, false);
  }

  /** Routine maintenance must not consume a delayed alarm's uncounted batch.
   * An ambiguous presentation was already counted; discard only that outbox. */
  public void repairFutureOnly() {
    State state = port.load();
    if (state != null && state.presentationPending) port.save(state.presented());
    restore();
  }

  /** Explicit recovery skips missed backlog without presenting a catch-up burst. */
  public void recoverFutureOnly(Instant now) { advanceFutureOnly(now, false); }

  /** A delayed real alarm presents at most one due batch, then skips other elapsed
   * times in a single durable cursor transition. Duplicate callbacks stay inert. */
  public void deliverFutureOnly(Instant now) { advanceFutureOnly(now, true); }

  private void advanceFutureOnly(Instant now, boolean deliver) {
    State state = port.load();
    if (state == null) { port.cancel(); return; }
    boolean due = deliver && !state.pending.isEmpty() && !state.pending.get(0).instant.isAfter(now);
    long total = due ? Math.addExact(state.total, state.pending.size()) : state.total;
    State next = new State(state.lease, state.rules, state.cursor.isAfter(now) ? state.cursor : now,
      List.of(), total, state.acknowledged, due);
    port.save(next);
    if (due) flush(next);
    restore();
  }

  public void replace(String lease, List<Planner.Rule> rules, Instant serverNow, LocalDate authoritativeDate) {
    port.save(replacement(port.load(), lease, rules, serverNow, authoritativeDate));
    restore();
  }
  private static Instant min(Instant a, Instant b) { return a == null ? b : b == null ? a : a.isBefore(b) ? a : b; }
  private static Planner.Rule copy(Planner.Rule r, LocalDate start, LocalDate date, Instant closes, Set<Integer> days) {
    return new Planner.Rule(r.owner, r.habit, r.zone.getId(), start.toString(), date == null ? null : date.toString(),
      closes == null ? null : closes.toString(), days, r.time.toString());
  }
  private static Planner.Rule intersect(Planner.Rule a, Planner.Rule b, LocalDate floor) {
    if (!a.owner.equals(b.owner) || !a.habit.equals(b.habit) || !a.zone.equals(b.zone) || !a.time.equals(b.time)) return null;
    LocalDate date = a.onlyDate == null ? b.onlyDate : a.onlyDate;
    if (a.onlyDate != null && b.onlyDate != null && !a.onlyDate.equals(b.onlyDate)) return null;
    LocalDate start = Collections.max(List.of(a.start, b.start, floor));
    if (date != null && date.isBefore(start)) return null;
    Set<Integer> days = new HashSet<>(a.weekdays.isEmpty() ? b.weekdays : a.weekdays);
    if (!a.weekdays.isEmpty() && !b.weekdays.isEmpty()) {
      days.retainAll(b.weekdays); if (days.isEmpty()) return null;
    }
    return copy(a, start, date, min(a.closes, b.closes), days);
  }
  public void restore() {
    State state = port.load();
    if (state != null && state.presentationPending) port.arm(Instant.EPOCH);
    else if (state == null || state.pending.isEmpty()) port.cancel();
    else port.arm(state.pending.get(0).instant);
  }
  private State flush(State state) {
    if (state != null && state.presentationPending) {
      port.present(state);
      state = state.presented(); port.save(state);
    }
    return state;
  }
  public boolean tick(Instant now) {
    State state = flush(port.load());
    int batches = 0;
    while (batches++ < 64 && state != null && !state.pending.isEmpty() && !state.pending.get(0).instant.isAfter(now)) {
      State next = state.consume();
      port.save(next); // Count + consumption + presentation intent form ONE durable commit.
      state = flush(next); // Failures retain the outbox; retry cannot count a batch twice.
    }
    restore();
    return state == null || state.pending.isEmpty() || state.pending.get(0).instant.isAfter(now);
  }
}
