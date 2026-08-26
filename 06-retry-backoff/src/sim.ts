/**
 * Discrete-event simulation clock. Events run in (time, insertion order); the
 * clock jumps between events, so a run over hours of simulated traffic
 * finishes in milliseconds and is exactly reproducible.
 */
export type Task = () => void;

interface ScheduledEvent {
  timeSec: number;
  seq: number;
  task: Task;
}

export class Simulation {
  private heap: ScheduledEvent[] = [];
  private seq = 0;
  private currentTimeSec = 0;

  get now(): number {
    return this.currentTimeSec;
  }

  /** Schedule a task `delaySec` after the current simulated time. */
  schedule(delaySec: number, task: Task): void {
    if (!Number.isFinite(delaySec) || delaySec < 0) {
      throw new RangeError(`delaySec must be finite and >= 0, got ${delaySec}`);
    }
    this.push({ timeSec: this.currentTimeSec + delaySec, seq: this.seq++, task });
  }

  /** Run until no events remain. Tasks may schedule further events. */
  run(): void {
    for (let event = this.pop(); event !== undefined; event = this.pop()) {
      this.currentTimeSec = event.timeSec;
      event.task();
    }
  }

  get pendingCount(): number {
    return this.heap.length;
  }

  private static before(a: ScheduledEvent, b: ScheduledEvent): boolean {
    if (a.timeSec !== b.timeSec) return a.timeSec < b.timeSec;
    return a.seq < b.seq;
  }

  private push(event: ScheduledEvent): void {
    const heap = this.heap;
    heap.push(event);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const parentEvent = heap[parent]!;
      if (Simulation.before(heap[i]!, parentEvent)) {
        heap[parent] = heap[i]!;
        heap[i] = parentEvent;
        i = parent;
      } else {
        break;
      }
    }
  }

  private pop(): ScheduledEvent | undefined {
    const heap = this.heap;
    if (heap.length === 0) return undefined;
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < heap.length && Simulation.before(heap[left]!, heap[smallest]!)) smallest = left;
        if (right < heap.length && Simulation.before(heap[right]!, heap[smallest]!)) smallest = right;
        if (smallest === i) break;
        const tmp = heap[i]!;
        heap[i] = heap[smallest]!;
        heap[smallest] = tmp;
        i = smallest;
      }
    }
    return top;
  }
}
