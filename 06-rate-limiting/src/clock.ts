/**
 * Virtual-time clock. All waiting in the simulation goes through `sleep`,
 * so a run covering minutes of simulated traffic executes in milliseconds
 * and is exactly reproducible: timers fire in (time, schedule-order) order,
 * never by wall-clock race.
 */

interface Timer {
  time: number;
  seq: number;
  resolve: () => void;
}

export class VirtualClock {
  private nowMs = 0;
  private seq = 0;
  private timers: Timer[] = [];

  now(): number {
    return this.nowMs;
  }

  sleep(ms: number): Promise<void> {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error(`sleep duration must be a finite non-negative number, got ${ms}`);
    }
    return new Promise((resolve) => {
      this.timers.push({ time: this.nowMs + ms, seq: this.seq++, resolve });
    });
  }

  pendingTimers(): number {
    return this.timers.length;
  }

  /**
   * Drive virtual time forward until `done` settles. Fires one timer at a
   * time, letting all continuations run between firings, so simultaneous
   * timers still resolve in a deterministic order. Throws if `done` is
   * pending but nothing is scheduled: a sleeping simulation that can never
   * wake is a bug, not a wait.
   */
  async runUntil<T>(done: Promise<T>): Promise<T> {
    let settled = false;
    const guarded = done.finally(() => {
      settled = true;
    });
    guarded.catch(() => {}); // observed again at the final await
    while (!settled) {
      await flushContinuations();
      if (settled) break;
      const timer = this.popNext();
      if (!timer) {
        throw new Error("virtual clock deadlock: work is pending but no timers are scheduled");
      }
      this.nowMs = timer.time;
      timer.resolve();
    }
    await flushContinuations();
    return guarded;
  }

  private popNext(): Timer | undefined {
    if (this.timers.length === 0) return undefined;
    let best = 0;
    for (let i = 1; i < this.timers.length; i++) {
      const candidate = this.timers[i]!;
      const current = this.timers[best]!;
      if (
        candidate.time < current.time ||
        (candidate.time === current.time && candidate.seq < current.seq)
      ) {
        best = i;
      }
    }
    return this.timers.splice(best, 1)[0];
  }
}

/** Let every pending promise continuation run before touching the next timer. */
function flushContinuations(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
