package com.habbittracker.reminders;

import java.time.Instant;
import java.util.*;

/** Write-ahead scheduling coordinator; Android persists the complete state atomically. */
public final class Journal {
  public static final class State {
    public final String lease;
    public final List<Planner.Rule> rules;
    public final Instant cursor;
    public final List<Planner.Event> pending;
    public State(String lease, List<Planner.Rule> rules, Instant cursor) {
      this.lease = lease; this.rules = Collections.unmodifiableList(new ArrayList<>(rules)); this.cursor = cursor;
      this.pending = Planner.nextBatch(rules, cursor);
    }
  }
  public interface Port {
    State load();
    void save(State state); // must be atomic and durable or throw
    void arm(Instant time); // replaces ONE stable alarm; throws on capacity/error
    void cancel();
    void present(List<Planner.Event> events); // stable notification identity, retryable
  }
  private final Port port;
  public Journal(Port port) { this.port = port; }
  public void replace(String lease, List<Planner.Rule> rules, Instant serverNow) {
    State old = port.load();
    if (old == null || !old.lease.equals(lease)) throw new IllegalStateException("stale lease");
    Instant cursor = old.cursor.isAfter(serverNow) ? old.cursor : serverNow;
    port.save(new State(lease, rules, cursor));
    restore();
  }
  public void restore() {
    State state = port.load();
    if (state == null || state.pending.isEmpty()) port.cancel();
    else port.arm(state.pending.get(0).instant);
  }
  public boolean tick(Instant now) {
    State state = port.load();
    // Drain every elapsed batch, never silently truncate to a platform queue limit.
    int batches = 0;
    while (batches++ < 64 && state != null && !state.pending.isEmpty() && !state.pending.get(0).instant.isAfter(now)) {
      port.present(state.pending);
      State next = new State(state.lease, state.rules, state.pending.get(0).instant);
      port.save(next); // crash before commit retries the same notification identity
      state = next;
    }
    restore();
    return state == null || state.pending.isEmpty() || state.pending.get(0).instant.isAfter(now);
  }
}
