/**
 * FIFO counting semaphore. `acquire` resolves with a release function once a
 * permit is free; waiters are served strictly in arrival order, so under the
 * virtual clock every interleaving is deterministic. A permit must be
 * released exactly once — releasing twice throws instead of silently
 * inflating the limit.
 */
export class Semaphore {
  private held = 0;
  private waiters: Array<(release: () => void) => void> = [];
  private heldHighWater = 0;
  private queueHighWater = 0;

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`semaphore limit must be a positive integer, got ${limit}`);
    }
  }

  acquire(): Promise<() => void> {
    if (this.held < this.limit) {
      this.held++;
      this.heldHighWater = Math.max(this.heldHighWater, this.held);
      return Promise.resolve(this.makeRelease());
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this.queueHighWater = Math.max(this.queueHighWater, this.waiters.length);
    });
  }

  /** Run `fn` while holding a permit; the permit is released even if `fn` throws. */
  async withPermit<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  inUse(): number {
    return this.held;
  }

  waiting(): number {
    return this.waiters.length;
  }

  /** Most permits ever held at once. */
  highWater(): number {
    return this.heldHighWater;
  }

  /** Longest the wait queue ever got. */
  maxQueue(): number {
    return this.queueHighWater;
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) {
        throw new Error("semaphore permit released twice");
      }
      released = true;
      const next = this.waiters.shift();
      if (next) {
        // Hand the permit straight to the next waiter: held count is unchanged.
        this.heldHighWater = Math.max(this.heldHighWater, this.held);
        next(this.makeRelease());
      } else {
        this.held--;
      }
    };
  }
}
