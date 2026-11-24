# Retry Storm Lab

Retry Storm Lab is a discrete-event simulator for retry amplification. It models how a temporary backend slowdown can keep a service overloaded after the slowdown ends. All requests are simulated in memory.

**[Open the interactive demo](https://almat2201.github.io/retry-storm-lab/)** · [Simulation engine](simulator.mjs) · [Tests](simulator.test.mjs)

Choose a slowdown, a hard outage, or a healthy service. Change the arrival rate, timeout, and seed, then compare no retries, immediate retries, and exponential backoff with full jitter and a shared token budget. The dashboard shows attempts, successful responses, and p95 latency and exports 500 ms buckets as CSV.

## Reference run

The default run uses seed 42, 12 workers, a 90-attempt queue, a 280 ms attempt timeout, and a slowdown from second 7 to second 15. All policies receive the same 3,120 incoming requests.

| Policy | Attempts | Attempts per request | Successful requests |
| --- | ---: | ---: | ---: |
| No retry | 3,120 | 1.00× | 60.6% |
| Immediate retry | 10,102 | 3.24× | 25.9% |
| Backoff + budget | 3,357 | 1.08× | 61.1% |

In this scenario, the protected policy issues 66.8% fewer attempts than immediate retries and recovers roughly the same share of requests as no retries. The result depends on workload, timeouts, and the capacity model.

## Run locally

No dependencies or build step. Run the engine and tests with Node.js 20 or newer.

```sh
node --test simulator.test.mjs
node --input-type=module -e "import {simulate} from './simulator.mjs'; console.log(simulate('protected').stats)"
```

For the dashboard, serve this directory over HTTP with any static server. For example, with Python installed, run `python -m http.server 8000` and open `http://localhost:8000`.

## Model

- A binary min-heap advances the clock to the next arrival, completion, timeout, or retry. Each event costs O(log n) to enqueue or remove, where n is the number of queued events. Ties resolve by event type and insertion order. A completion at the deadline wins over its timeout.
- Arrivals follow a seeded Poisson process. Service times are exponential. The engine keys random draws by logical request, attempt, and draw type, so retries cannot shift the workload used by another policy.
- A bounded FIFO feeds the worker pool. The client clock starts on admission and includes time spent waiting for a worker. Expired attempts still use server resources and their late results are ignored. A retry can overlap server work from an earlier attempt that timed out.
- The protected policy waits uniformly between zero and a capped exponential delay. It spends one token per retry and earns a fraction of a token per original arrival, up to a fixed burst capacity. When the budget is empty at retry time, that request fails.
- The degradation model applies at service start. New arrivals stop at 28 seconds, with four extra seconds to observe in-flight work. Success rate uses all original requests as the denominator. Latency is measured from original arrival to the accepted completion, for successful requests only.

This is an AI-assisted prototype. It models a single worker pool and does not model a real service, network, or production traffic.
