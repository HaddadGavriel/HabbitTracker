package com.habbittracker.reminders;

import java.time.*;
import java.util.*;

/** Durable recurrence windows and a counted presentation outbox; no Android dependencies. */
public final class Journal {
  public static final Duration DELIVERY_GRACE = Duration.ofHours(1);
  private static final Duration RETRY_DELAY = Duration.ofMinutes(1);
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
    /** Latest product batch, persisted for eligibility checks and bounded retries. */
    public final List<Planner.Event> delivery;
    public State(String lease, List<Planner.Rule> rules, Instant cursor) {
      this(lease, rules, cursor, List.of(), 0, 0, false);
    }
    public State(String lease, List<Planner.Rule> rules, Instant cursor, List<Window> backlog,
                 long total, long acknowledged, boolean presentationPending) {
      this(lease, rules, cursor, backlog, total, acknowledged, presentationPending, List.of());
    }
    public State(String lease, List<Planner.Rule> rules, Instant cursor, List<Window> backlog,
                 long total, long acknowledged, boolean presentationPending, List<Planner.Event> delivery) {
      if (acknowledged < 0 || total < acknowledged) throw new IllegalArgumentException("count");
      this.lease = lease; this.rules = List.copyOf(rules); this.cursor = cursor;
      this.backlog = Collections.unmodifiableList(backlog.stream().filter(w -> !w.pending().isEmpty())
        .collect(java.util.stream.Collectors.toList()));
      this.total = total; this.acknowledged = acknowledged; this.presentationPending = presentationPending;
      this.delivery = List.copyOf(delivery);
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
      return new State(lease, rules, cursor, backlog, total, ack, presentationPending && ack < total,
        ack >= total ? List.of() : delivery);
    }
    State presented() { return new State(lease, rules, cursor, backlog, total, acknowledged, false, delivery); }
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
  /** Keep only previously scheduled recent work still authorized by the new plan.
   * Newly introduced times never create retroactive work. Visible batch membership
   * survives an unchanged refresh; completion/archive/expiry removes its members. */
  public static State reconcile(State old, String lease, List<Planner.Rule> rules, Instant now) {
    if (old == null || !old.lease.equals(lease)) throw new IllegalStateException("stale lease");
    Instant cutover = old.cursor.isAfter(now) ? old.cursor : now;
    List<Window> outstanding = new ArrayList<>(old.backlog);
    outstanding.add(new Window(old.rules, old.cursor, cutover));
    List<Window> retained = new ArrayList<>();
    Instant grace = now.minus(DELIVERY_GRACE).minusNanos(1);
    for (Window w : outstanding) {
      List<Planner.Rule> confirmed = new ArrayList<>();
      for (Planner.Rule previous : w.rules) for (Planner.Rule current : rules) {
        Planner.Rule r = intersect(previous, current, grace.atZone(previous.zone).toLocalDate());
        if (r != null && (r.closes == null || r.closes.isAfter(now))) confirmed.add(r);
      }
      Instant cursor = w.cursor.isAfter(grace) ? w.cursor : grace;
      if (cursor.isBefore(w.until)) retained.add(new Window(confirmed, cursor, w.until));
    }
    List<Planner.Event> delivery = authorized(old.delivery, rules, now, old.presentationPending);
    return new State(lease, rules, cutover, retained, old.total,
      delivery.isEmpty() ? old.total : old.acknowledged,
      old.presentationPending && !delivery.isEmpty(), delivery);
  }

  public static Instant deadline(Planner.Event e) {
    Instant midnight = e.date.plusDays(1).atStartOfDay(e.rule.zone).toInstant();
    return e.rule.onlyDate != null && e.rule.closes != null ? e.rule.closes : min(midnight, e.rule.closes);
  }
  private static boolean open(Planner.Event e, Instant now) {
    return deadline(e).isAfter(now);
  }
  private static List<Planner.Rule> openRules(List<Planner.Rule> rules, Instant now) {
    List<Planner.Rule> result = new ArrayList<>();
    for (Planner.Rule r : rules) {
      if (r.closes != null && !r.closes.isAfter(now)) continue;
      LocalDate today = now.atZone(r.zone).toLocalDate();
      if (r.onlyDate == null && r.start.isBefore(today))
        result.add(copy(r, today, null, r.closes, r.weekdays));
      else result.add(r);
    }
    return result;
  }
  private static List<Planner.Event> authorized(List<Planner.Event> events, List<Planner.Rule> rules,
                                                Instant now, boolean retry) {
    List<Planner.Event> result = new ArrayList<>();
    for (Planner.Event e : events) {
      if (!open(e, now) || (retry && e.instant.plus(DELIVERY_GRACE).isBefore(now))) continue;
      for (Planner.Rule rule : rules) {
        if (!rule.habit.equals(e.rule.habit) || !rule.owner.equals(e.rule.owner)) continue;
        Planner.Event candidate = Planner.next(rule, e.instant.minusNanos(1));
        if (candidate != null && candidate.id.equals(e.id) && candidate.instant.equals(e.instant)
            && open(candidate, now)) { result.add(candidate); break; }
      }
    }
    return result;
  }
  /** Routine maintenance preserves due alarms and retries known presentation
   * failures. Native persistence discards only an ambiguous in-progress attempt. */
  public void repairFutureOnly(Instant now) {
    State state = port.load();
    if (state == null) { port.cancel(); return; }
    boolean failed = true;
    try {
      if (state.presentationPending) {
        List<Planner.Event> delivery = authorized(state.delivery, state.rules, now, true);
        state = new State(state.lease, state.rules, state.cursor, state.backlog, state.total,
          delivery.isEmpty() ? state.total : state.acknowledged, !delivery.isEmpty(), delivery);
        port.save(state);
      }
      flush(state); failed = false;
    } finally { restoreFutureOnly(now, failed); }
  }

  /** Explicit recovery skips missed backlog without presenting a catch-up burst. */
  public void recoverFutureOnly(Instant now) { advanceFutureOnly(now, false); }

  /** A delayed real alarm presents at most one due batch, then skips other elapsed
   * times in a single durable cursor transition. Duplicate callbacks stay inert. */
  public void deliverFutureOnly(Instant now) { advanceFutureOnly(now, true); }

  private void advanceFutureOnly(Instant now, boolean deliver) {
    State state = port.load();
    if (state == null) { port.cancel(); return; }
    // Skip expired work without iterating over an unbounded offline history.
    Instant floor = now.minus(DELIVERY_GRACE).minusNanos(1);
    State recent = new State(state.lease, openRules(state.rules, now), state.cursor.isAfter(floor) ? state.cursor : floor,
      state.backlog.stream().map(w -> new Window(openRules(w.rules, now), w.cursor.isAfter(floor) ? w.cursor : floor, w.until))
        .collect(java.util.stream.Collectors.toList()), state.total, state.acknowledged, false, state.delivery);
    List<Planner.Event> batch = recent.pending.stream().filter(e -> open(e, now)).collect(java.util.stream.Collectors.toList());
    boolean due = deliver && !batch.isEmpty() && !batch.get(0).instant.isAfter(now);
    // A newly due batch supersedes a failed older presentation. Posting both
    // here would immediately replace one alert with another catch-up alert.
    if (state.presentationPending && !due) {
      repairFutureOnly(now);
      state = port.load();
    }
    long total = due ? Math.addExact(state.total, batch.size()) : state.total;
    State next = new State(state.lease, state.rules, state.cursor.isAfter(now) ? state.cursor : now,
      List.of(), total, due ? state.total : state.acknowledged, due, due ? batch : state.delivery);
    boolean failed = true;
    try { port.save(next); if (due) flush(next); failed = false; }
    finally { restoreFutureOnly(now, failed); }
  }
  private void restoreFutureOnly(Instant now, boolean failed) {
    State state = port.load();
    if (state == null) { port.cancel(); return; }
    Instant next = state.pending.isEmpty() ? null : state.pending.get(0).instant;
    if (failed && next != null && !next.isAfter(now)) next = now.plus(RETRY_DELAY);
    if (state.presentationPending) next = min(next, now.plus(RETRY_DELAY));
    if (next == null) port.cancel(); else port.arm(next);
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
