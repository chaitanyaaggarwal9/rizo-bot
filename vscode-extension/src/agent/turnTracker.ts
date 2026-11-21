// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// Keeps track of running turns: each turn gets its own AbortController
// (so Stop cancels exactly that turn, not whichever started last), and
// turns on the same thread run one after another (so two turns can never
// load the same history and overwrite each other's saved messages).
// No 'vscode' import: tested in turnTracker.test.ts.

export interface TurnHandle {
  // Aborted when this turn is cancelled (Stop, panel closed).
  readonly signal: AbortSignal;
  // Resolves once every earlier turn on the same thread has finished.
  readonly ready: Promise<void>;
  // Call exactly once when the turn is over, however it ended.
  finish(): void;
}

export class TurnTracker {
  private readonly controllers = new Map<string, AbortController>();
  private readonly threadTails = new Map<string, Promise<void>>();
  // Stop can arrive before the turn has registered (the message race is
  // small but real); remember it so the turn starts already cancelled.
  private readonly cancelledEarly = new Set<string>();

  begin(turnId: string, threadId: string): TurnHandle {
    const controller = new AbortController();
    if (this.cancelledEarly.delete(turnId)) controller.abort();
    this.controllers.set(turnId, controller);

    const previous = this.threadTails.get(threadId) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => done);
    this.threadTails.set(threadId, tail);

    let finished = false;
    return {
      signal: controller.signal,
      ready: previous,
      finish: () => {
        if (finished) return;
        finished = true;
        this.controllers.delete(turnId);
        release();
        if (this.threadTails.get(threadId) === tail) this.threadTails.delete(threadId);
      },
    };
  }

  cancel(turnId: string): void {
    const controller = this.controllers.get(turnId);
    if (controller) controller.abort();
    else this.cancelledEarly.add(turnId);
  }

  cancelAll(): void {
    for (const controller of this.controllers.values()) controller.abort();
  }

  get runningCount(): number {
    return this.controllers.size;
  }
}
