import assert from "node:assert/strict";
import test from "node:test";
import { defaults, simulate, strategies } from "./simulator.mjs";

test("runs are reproducible and arrivals match across all strategies", () => {
  const runs = strategies.map((strategy) => simulate(strategy));
  assert.deepEqual(runs[2], simulate("protected"));
  const arrivals = ({ samples }) => samples.map((sample) => sample.arrivals);
  assert.deepEqual(arrivals(runs[0]), arrivals(runs[1]));
  assert.deepEqual(arrivals(runs[0]), arrivals(runs[2]));
  assert.notDeepEqual(arrivals(runs[0]), arrivals(simulate("none", { seed: 43 })));
});

test("the reference slowdown amplifies load and reduces goodput under immediate retries", () => {
  const runs = strategies.map((strategy) => simulate(strategy).stats);
  assert.deepEqual(runs.map(({ attempts, successes }) => [attempts, successes]), [
    [3120, 1891], [10102, 807], [3357, 1905],
  ]);
});

test("attempt, queue, budget, and logical-request accounting stay bounded", () => {
  for (const seed of [0, 1, 42, 2 ** 32 - 1]) {
    for (const strategy of strategies) {
      const { stats, samples } = simulate(strategy, { seed, queueLimit: 12 });
      assert.equal(stats.arrivals, stats.successes + stats.failures + stats.pending);
      assert.ok(stats.pending >= 0);
      assert.ok(stats.lateCompletions <= stats.timeouts);
      assert.ok(stats.peakQueue <= 12);
      assert.equal(Math.max(...samples.map((sample) => sample.peakQueue)), stats.peakQueue);
      for (const key of ["arrivals", "attempts", "successes"]) {
        assert.equal(samples.reduce((total, sample) => total + sample[key], 0), stats[key]);
      }
      assert.ok(stats.attempts <= stats.arrivals * (1 + defaults.maxRetries));
      if (strategy === "protected") {
        assert.ok(stats.attempts - stats.arrivals <=
          defaults.retryBurst + stats.arrivals * defaults.retryRatio);
      }
    }
  }
});

test("work can complete after the client gives up without becoming a success", () => {
  const { stats } = simulate("none", { timeoutMs: 1, queueLimit: 0 });
  assert.equal(stats.peakQueue, 0);
  assert.equal(stats.successes, 0);
  assert.equal(stats.p95Ms, null);
  assert.ok(stats.lateCompletions > 0);
  assert.ok(stats.rejected > 0);
});

test("a zero budget denies retries without adding attempts", () => {
  const { stats } = simulate("protected", { retryRatio: 0, retryBurst: 0 });
  assert.equal(stats.attempts, stats.arrivals);
  assert.ok(stats.budgetDenied > 0);
});

test("an unfinished request remains pending at the observation cutoff", () => {
  const { stats } = simulate("none", {
    durationMs: 100, drainMs: 0, outageStartMs: 0, outageEndMs: 0,
    requestsPerSecond: 500, meanServiceMs: 10_000, timeoutMs: 10_000,
  });
  assert.ok(stats.pending > 0);
  assert.equal(stats.pending, stats.arrivals - stats.successes);
});

test("invalid inputs are rejected", () => {
  assert.throws(() => simulate("unknown"), RangeError);
  assert.throws(() => simulate("none", { seed: -1 }), /seed/);
  assert.throws(() => simulate("none", { outageEndMs: 10 }), /outageEndMs/);
  assert.throws(() => simulate("none", { unknown: 5 }), /Unknown parameter/);
});
