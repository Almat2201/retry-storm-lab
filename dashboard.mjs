import { defaults, simulate, strategies } from "./simulator.mjs";

const policies = [
  { name: "No retry", color: "#a9b9d8", line: "dashed", dash: [7, 4] },
  { name: "Immediate retry", color: "#ffa385", line: "solid", dash: [] },
  { name: "Backoff + budget", color: "#b0e9ac", line: "dotted", dash: [2, 3] },
];
const presets = {
  slowdown: {},
  outage: { outageFailureRate: 1, outageSlowdown: 1 },
  healthy: { outageStartMs: 0, outageEndMs: 0 },
};
const byId = (id) => document.getElementById(id);
const form = byId("controls");
const rate = byId("rate");
const timeout = byId("timeout");
const seed = byId("seed");
const scenario = byId("scenario");
const canvases = [byId("attempts"), byId("successes")];
let results = [];
let lastScenario;

function updateLabels() {
  byId("rate-label").textContent = rate.value + "/s";
  byId("timeout-label").textContent = timeout.value + " ms";
}

function renderSummary() {
  byId("summary").innerHTML = results.map(({ stats }, index) => {
    const policy = policies[index];
    const percent = (stats.successRate * 100).toFixed(1);
    const p95 = stats.p95Ms === null ? "—" : Math.round(stats.p95Ms) + " ms";
    return `<article class="stat">
      <h3><span class="swatch" aria-hidden="true" data-line="${policy.line}" style="--swatch:${policy.color}"></span>${policy.name}</h3>
      <div class="big">${percent}%</div>
      <p>Succeeded · ${stats.amplification.toFixed(2)}× attempts<br>p95 latency · ${p95}</p>
    </article>`;
  }).join("");
}

function plot(canvas, metric) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height || !results.length) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  const margin = { left: 40, top: 12, right: 15, bottom: 25 };
  const bottom = height - margin.bottom;
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = bottom - margin.top;
  const config = results[0].config;
  const horizon = config.durationMs + config.drainMs;
  const series = results.map(({ samples }) => samples.map((point) => point[metric] * 2));
  const rawMax = Math.max(1, ...series.flat());
  const tick = Math.ceil(rawMax / 100) * 25;
  const x = (ms) => margin.left + ms / horizon * plotWidth;
  const y = (value) => bottom - value / (tick * 4) * plotHeight;

  ctx.fillStyle = "#bda25530";
  ctx.fillRect(x(config.outageStartMs), margin.top,
    x(config.outageEndMs) - x(config.outageStartMs), plotHeight);
  ctx.font = "11px system-ui";
  ctx.fillStyle = "#a8b5ab";
  ctx.strokeStyle = "#344139";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let index = 0; index <= 4; index++) {
    const value = index * tick;
    ctx.beginPath();
    ctx.moveTo(margin.left, y(value));
    ctx.lineTo(width - margin.right, y(value));
    ctx.stroke();
    ctx.fillText(String(value), margin.left - 6, y(value));
  }

  ctx.textAlign = "center";
  const step = width < 460 ? 8_000 : 4_000;
  for (let time = 0; time <= horizon; time += step) {
    ctx.fillText(time / 1_000 + "s", x(time), bottom + 15);
  }

  for (const index of [0, 2, 1]) {
    const points = results[index].samples;
    ctx.beginPath();
    ctx.strokeStyle = policies[index].color;
    ctx.setLineDash(policies[index].dash);
    ctx.lineWidth = 1.7;
    for (const [i, point] of points.entries()) {
      const left = x(point.time);
      const right = x(point.time + 500);
      const level = y(series[index][i]);
      if (i === 0) ctx.moveTo(left, level);
      else ctx.lineTo(left, level);
      ctx.lineTo(right, level);
    }
    ctx.stroke();
  }
}

function renderCharts() {
  plot(canvases[0], "attempts");
  plot(canvases[1], "successes");
}

function run() {
  lastScenario = scenario.value;
  results = strategies.map((strategy) => simulate(strategy, {
    ...presets[lastScenario],
    seed: seed.valueAsNumber,
    requestsPerSecond: rate.valueAsNumber,
    timeoutMs: timeout.valueAsNumber,
  }));
  byId("outage-key").hidden = results[0].config.outageStartMs === results[0].config.outageEndMs;
  byId("status").textContent = results[0].stats.arrivals.toLocaleString("en-US") +
    " incoming requests per policy · seed " + seed.valueAsNumber;
  renderSummary();
  renderCharts();
}

function download() {
  const lines = ["scenario,seed,requested_rps,timeout_ms,policy,time_ms,arrivals,attempts,successes,peak_queue"];
  for (const { strategy, config, samples } of results) {
    for (const row of samples) {
      lines.push([lastScenario, config.seed, config.requestsPerSecond, config.timeoutMs,
        strategy, row.time, row.arrivals, row.attempts, row.successes, row.peakQueue].join(","));
    }
  }
  const url = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "retry-storm-" + results[0].config.seed + ".csv";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

rate.addEventListener("input", updateLabels);
timeout.addEventListener("input", updateLabels);
form.addEventListener("submit", (event) => {
  event.preventDefault();
  run();
});
byId("download").addEventListener("click", download);
new ResizeObserver(renderCharts).observe(canvases[0]);
rate.value = defaults.requestsPerSecond;
timeout.value = defaults.timeoutMs;
seed.value = defaults.seed;
updateLabels();
run();
