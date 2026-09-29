/**
 * Task queue — multi-step goals with preconditions.
 *
 * A single mode like `gather` does one thing. The interesting behaviours are
 * sequences: "gather 32 logs, craft them into planks, craft sticks, craft a
 * pickaxe". Before this, asking for that meant running each step by hand and
 * guessing when the previous one had finished.
 *
 * A task is { label, run(actor) }. The queue runs them in order, awaiting each,
 * and stops on the first failure with the reason logged — never silently
 * continuing as if a step had succeeded. Preconditions are just checks inside
 * `run` that throw; the queue treats the throw as "this step cannot be done" and
 * reports it.
 *
 *   const q = new TaskQueue(actor);
 *   q.add('gather 8 logs', a => a.setMode('gather', [8]));
 *   q.start();
 */

'use strict';

class TaskQueue {
  constructor(actor) {
    this.actor = actor;
    this.tasks = [];
    this.running = false;
    this.current = null;       // {label, startedAt}
    this.lastError = null;
    this.finishedAt = null;
  }

  add(label, run) {
    if (typeof run !== 'function') throw new Error(`task "${label}" has no run function`);
    this.tasks.push({ label, run });
    return this;
  }

  get info() {
    return {
      pending: this.tasks.length,
      running: this.running,
      current: this.current ? this.current.label : null,
      lastError: this.lastError,
      finished: this.finishedAt != null,
      finishedAt: this.finishedAt
    };
  }

  clear() {
    this.tasks = [];
    this.lastError = null;
    this.current = null;
    this.finishedAt = null;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.lastError = null;
    this.finishedAt = null;
    const log = (this.actor && this.actor.log) || { info() {}, warn() {}, error() {}, debug() {} };
    try {
      while (this.tasks.length) {
        const task = this.tasks.shift();
        this.current = { label: task.label, startedAt: Date.now() };
        log.info('task: start', { task: task.label, remaining: this.tasks.length });
        try {
          await task.run(this.actor);
          log.info('task: done', { task: task.label });
        } catch (e) {
          // A failed step aborts the queue: continuing would run later steps
          // against inputs the earlier step never produced.
          this.lastError = `${task.label}: ${e && e.message ? e.message : String(e)}`;
          log.warn('task: failed, stopping the queue', { task: task.label, error: this.lastError });
          break;
        }
      }
      this.finishedAt = Date.now();
    } finally {
      this.running = false;
      this.current = null;
    }
  }
}

module.exports = { TaskQueue };
