export const defaults = Object.freeze({
  seed: 42,
  durationMs: 28_000,
  drainMs: 4_000,
  requestsPerSecond: 110,
  workers: 12,
  queueLimit: 90,
  meanServiceMs: 75,
  timeoutMs: 280,
  outageStartMs: 7_000,
  outageEndMs: 15_000,
  outageSlowdown: 4,
  outageFailureRate: 0.35,
  maxRetries: 3,
  baseBackoffMs: 140,
  maxBackoffMs: 1_200,
  retryRatio: 0.15,
  retryBurst: 6,
});

export const strategies = Object.freeze(["none", "immediate", "protected"]);

const SAMPLE_MS = 500;
const priority = { finish: 0, timeout: 1, retry: 2, arrival: 3 };
const before = (a, b) =>
  a.time < b.time || (a.time === b.time &&
    (priority[a.kind] < priority[b.kind] ||
      (a.kind === b.kind && a.order < b.order)));

class EventQueue {
  items = [];

  push(event) {
    const items = this.items;
    let index = items.length;
    items.push(event);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!before(event, items[parent])) break;
      items[index] = items[parent];
      index = parent;
    }
    items[index] = event;
  }

  pop() {
    const items = this.items;
    const first = items[0];
    const last = items.pop();
    if (items.length === 0) return first;

    let index = 0;
    while (index * 2 + 1 < items.length) {
      let child = index * 2 + 1;
      if (child + 1 < items.length && before(items[child + 1], items[child])) {
        child++;
      }
      if (!before(items[child], last)) break;
      items[index] = items[child];
      index = child;
    }
    items[index] = last;
    return first;
  }
}

// Each draw has its own key, so extra retries cannot shift another request's draws.
function draw(seed, requestId, attempt, stream) {
  let bits = seed ^ Math.imul(requestId + 1, 0x9e3779b9);
  bits ^= Math.imul(attempt + 1, 0x85ebca6b) ^ Math.imul(stream, 0xc2b2ae35);
  bits = Math.imul(bits ^ (bits >>> 16), 0x7feb352d);
  bits = Math.imul(bits ^ (bits >>> 15), 0x846ca68b);
  return ((bits ^ (bits >>> 16)) >>> 0) / 2 ** 32;
}

function exponential(unit, mean) {
  return -Math.log1p(-unit) * mean;
}

function createConfig(overrides) {
  const config = { ...defaults, ...overrides };
  const limits = {
    seed: [0, 2 ** 32 - 1],
    durationMs: [1, 120_000],
    drainMs: [0, 20_000],
    requestsPerSecond: [1, 500],
    workers: [1, 200],
    queueLimit: [0, 500],
    meanServiceMs: [1, 10_000],
    timeoutMs: [1, 10_000],
    outageStartMs: [0, config.durationMs],
    outageEndMs: [config.outageStartMs, config.durationMs],
    outageSlowdown: [1, 20],
    outageFailureRate: [0, 1],
    maxRetries: [0, 8],
    baseBackoffMs: [1, 10_000],
    maxBackoffMs: [config.baseBackoffMs, 20_000],
    retryRatio: [0, 1],
    retryBurst: [0, 200],
  };
  const fractions = new Set(["outageFailureRate", "retryRatio"]);

  for (const [name, value] of Object.entries(config)) {
    if (!Object.hasOwn(limits, name)) throw new RangeError("Unknown parameter " + name);
    const [min, max] = limits[name];
    if (!Number.isFinite(value) || value < min || value > max ||
        (!fractions.has(name) && !Number.isInteger(value))) {
      throw new RangeError(name + " must be between " + min + " and " + max);
    }
  }
  return config;
}

export function simulate(strategy, overrides = {}) {
  if (!strategies.includes(strategy)) throw new RangeError("Unknown strategy");
  const config = createConfig(overrides);
  const horizon = config.durationMs + config.drainMs;
  const samples = Array.from({ length: Math.ceil(horizon / SAMPLE_MS) }, (_, index) => ({
    time: index * SAMPLE_MS,
    arrivals: 0, attempts: 0, successes: 0, peakQueue: 0,
  }));
  const stats = {
    arrivals: 0, attempts: 0, successes: 0, failures: 0,
    rejected: 0, timeouts: 0, serviceErrors: 0, budgetDenied: 0,
    lateCompletions: 0, peakQueue: 0,
  };
  const latencies = [];
  const events = new EventQueue();
  const waiting = [];
  let waitingHead = 0;
  let scheduleOrder = 0;
  let busy = 0;
  let tokens = config.retryBurst;
  let time = 0;
  let bucketIndex = 0;
  let bucket = samples[0];

  function schedule(kind, at, data) {
    if (at < horizon) events.push({ kind, time: at, data, order: scheduleOrder++ });
  }

  function scheduleArrival(id, after) {
    const sample = draw(config.seed, id, 0, 1);
    const at = after + exponential(sample, 1000 / config.requestsPerSecond);
    if (at < config.durationMs) schedule("arrival", at, id);
  }

  function start(attempt) {
    busy++;
    const degraded = time >= config.outageStartMs && time < config.outageEndMs;
    const { id } = attempt.request;
    const speed = degraded ? config.outageSlowdown : 1;
    const elapsed = 1 + exponential(
      draw(config.seed, id, attempt.number, 2), config.meanServiceMs * speed,
    );
    attempt.serviceFailed = degraded &&
      draw(config.seed, id, attempt.number, 3) < config.outageFailureRate;
    schedule("finish", time + elapsed, attempt);
  }

  function startWaiting() {
    if (waitingHead === waiting.length) return;
    const next = waiting[waitingHead++];
    if (waitingHead === waiting.length) {
      waiting.length = 0;
      waitingHead = 0;
    } else if (waitingHead > 512 && waitingHead * 2 >= waiting.length) {
      waiting.splice(0, waitingHead);
      waitingHead = 0;
    }
    start(next);
  }

  function fail(attempt, reason) {
    attempt.settled = true;
    stats[reason]++;
    const { request, number } = attempt;
    if (strategy === "none" || number >= config.maxRetries) {
      stats.failures++;
      return;
    }

    const ceiling = Math.min(config.maxBackoffMs, config.baseBackoffMs * 2 ** number);
    const delay = strategy === "immediate" ? 0 :
      ceiling * draw(config.seed, request.id, number, 4);
    schedule("retry", time + delay, { request, number: number + 1 });
  }

  function submit(request, number) {
    stats.attempts++;
    bucket.attempts++;
    const attempt = { request, number, settled: false, serviceFailed: false };
    const depth = waiting.length - waitingHead;

    if (busy < config.workers) start(attempt);
    else if (depth < config.queueLimit) {
      waiting.push(attempt);
      stats.peakQueue = Math.max(stats.peakQueue, depth + 1);
      bucket.peakQueue = Math.max(bucket.peakQueue, depth + 1);
    } else {
      fail(attempt, "rejected");
      return;
    }

    schedule("timeout", time + config.timeoutMs, attempt);
  }

  function finish(attempt) {
    busy--;
    if (attempt.settled) stats.lateCompletions++;
    else if (attempt.serviceFailed) fail(attempt, "serviceErrors");
    else {
      attempt.settled = true;
      stats.successes++;
      bucket.successes++;
      latencies.push(time - attempt.request.arrivedAt);
    }
    startWaiting();
  }

  scheduleArrival(0, 0);
  while (events.items.length) {
    const event = events.pop();
    time = event.time;
    const eventBucket = Math.floor(time / SAMPLE_MS);
    while (bucketIndex < eventBucket) {
      bucket = samples[++bucketIndex];
      bucket.peakQueue = waiting.length - waitingHead;
    }
    bucket.peakQueue = Math.max(bucket.peakQueue, waiting.length - waitingHead);
    const data = event.data;

    switch (event.kind) {
      case "arrival":
        stats.arrivals++;
        bucket.arrivals++;
        tokens = Math.min(config.retryBurst, tokens + config.retryRatio);
        submit({ id: data, arrivedAt: time }, 0);
        scheduleArrival(data + 1, time);
        break;
      case "retry":
        if (strategy === "protected" && tokens < 1) {
          stats.budgetDenied++;
          stats.failures++;
          break;
        }
        if (strategy === "protected") tokens--;
        submit(data.request, data.number);
        break;
      case "timeout":
        if (!data.settled) fail(data, "timeouts");
        break;
      case "finish":
        finish(data);
        break;
    }
  }

  // A nonempty queue can span buckets with no events before the horizon.
  const finalDepth = waiting.length - waitingHead;
  for (let index = bucketIndex + 1; index < samples.length; index++) {
    samples[index].peakQueue = finalDepth;
  }

  latencies.sort((a, b) => a - b);
  return {
    strategy, config, samples,
    stats: {
      ...stats,
      pending: stats.arrivals - stats.successes - stats.failures,
      amplification: stats.arrivals ? stats.attempts / stats.arrivals : 0,
      successRate: stats.arrivals ? stats.successes / stats.arrivals : 0,
      p95Ms: latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1] : null,
    },
  };
}
