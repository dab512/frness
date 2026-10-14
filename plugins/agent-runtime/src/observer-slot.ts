import type { EventObserver } from "./runtime.js";

/** Slot identity survives a handler replacement; ordered delivery crosses one drain barrier. */
export class ObserverSlot implements EventObserver {
  #queue = Promise.resolve();
  #target: EventObserver;
  constructor(target: EventObserver) {
    this.#target = target;
  }
  observe(input: Parameters<EventObserver["observe"]>[0]): Promise<void> {
    const work = this.#queue.then(() => this.#target.observe(input));
    this.#queue = work.catch(() => {});
    return work;
  }
  replace(target: EventObserver): Promise<void> {
    const changed = this.#queue.then(() => {
      this.#target = target;
    });
    this.#queue = changed;
    return changed;
  }
}
