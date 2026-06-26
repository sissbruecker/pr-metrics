/**
 * Client-side, query-only UI for PR time-to-merge stats.
 *
 * Read-only: the only network calls are GETs to `/api/repos` and
 * `/api/stats?repo=<id>`. Nothing is ever written back.
 *
 * Flow:
 *   - On load, fetch the tracked repos and populate the selector (auto-selecting
 *     the first). If there are none, show a friendly message.
 *   - On repo change, fetch that repo's trailing-12-month stats and render.
 *   - Two view modes are kept in module state: "overall" (default) and
 *     "byCategory". The by-category view adds a metric selector
 *     (median / mean / count, default median).
 *   - The same fetched `StatsResult` drives both views, so toggling views or
 *     changing the metric re-renders from cached data without re-fetching.
 *
 * Chart handling: a single Chart.js instance is created once and then mutated
 * (data + options replaced, `chart.update()`) on every render, rather than
 * destroyed/recreated, to keep it cheap and flicker-free.
 *
 * Units: median/mean are stored as SECONDS. On the chart's y-axis they are
 * plotted in HOURS (seconds / 3600) for legible axis numbers; tooltips show the
 * full human-readable duration via formatDuration. The "count" metric is an
 * integer count and is plotted as-is (the axis label switches to "PRs").
 */

import { formatDuration, BLANK } from "/format.js";

const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86400;

// ---- Module state -----------------------------------------------------------

/** @type {"overall" | "byCategory"} */
let viewMode = "overall";
/** @type {"median" | "mean" | "count"} */
let categoryMetric = "median";
/** Latest fetched stats for the selected repo, or null. */
let currentStats = null;
/** The single Chart.js instance, created lazily. */
let chart = null;
/**
 * Last valid TTM threshold (in days) the UI sent to the server. Seeded from the
 * server's configured default on first load, then updated as the user edits the
 * input; used to revert when the input holds an invalid value.
 */
let lastThresholdDays = 7;

// ---- DOM refs ---------------------------------------------------------------

const els = {
  controls: document.getElementById("controls"),
  repoSelect: document.getElementById("repo-select"),
  viewToggle: document.getElementById("view-toggle"),
  metricControl: document.getElementById("metric-control"),
  metricSelect: document.getElementById("metric-select"),
  ttmThreshold: document.getElementById("ttm-threshold"),
  emptyMessage: document.getElementById("empty-message"),
  report: document.getElementById("report"),
  canvas: document.getElementById("chart"),
  table: document.getElementById("data-table"),
  footnote: document.getElementById("footnote"),
};

// Stable, distinct-ish palette for category lines (cycled if exhausted).
const PALETTE = [
  "#2563eb", // blue
  "#dc2626", // red
  "#16a34a", // green
  "#d97706", // amber
  "#7c3aed", // violet
  "#0891b2", // cyan
  "#9ca3af", // gray (Uncategorized tends to land here)
];

// ---- Helpers ----------------------------------------------------------------

/** Render a metric value (seconds for median/mean) as a table cell string. */
function formatCell(metric, value) {
  if (value === null || value === undefined) return BLANK;
  if (metric === "count") return String(value);
  return formatDuration(value);
}

/** Convert a metric value to a numeric chart point (null stays null = gap). */
function chartValue(metric, value) {
  if (value === null || value === undefined) return null;
  if (metric === "count") return value;
  return value / SECONDS_PER_HOUR; // seconds -> hours
}

/** Build a tooltip label for a metric value. */
function tooltipLabel(metric, datasetLabel, rawSeconds) {
  if (rawSeconds === null || rawSeconds === undefined) {
    return `${datasetLabel}: ${BLANK}`;
  }
  if (metric === "count") {
    return `${datasetLabel}: ${rawSeconds} PRs`;
  }
  return `${datasetLabel}: ${formatDuration(rawSeconds)}`;
}

// ---- Rendering: tables ------------------------------------------------------

/** Render the Overall table: 12 month rows x count / median / mean. */
function renderOverallTable(stats) {
  const thead = els.table.tHead;
  const tbody = els.table.tBodies[0];
  thead.innerHTML = "";
  tbody.innerHTML = "";

  const headRow = thead.insertRow();
  for (const h of ["Month", "Count", "Median", "Mean"]) {
    const th = document.createElement("th");
    th.textContent = h;
    headRow.appendChild(th);
  }

  for (const m of stats.monthly) {
    const row = tbody.insertRow();
    const cells = [
      m.month,
      String(m.all.count),
      formatCell("median", m.all.median),
      formatCell("mean", m.all.mean),
    ];
    cells.forEach((text, i) => {
      const cell = i === 0 ? document.createElement("th") : row.insertCell();
      cell.textContent = text;
      if (i === 0) {
        cell.scope = "row";
        row.appendChild(cell);
      }
    });
  }
}

/**
 * Render the By-category table: rows = months, columns = each category plus a
 * leading "Month" and a trailing "All" column, for the selected metric.
 */
function renderCategoryTable(stats, metric) {
  const thead = els.table.tHead;
  const tbody = els.table.tBodies[0];
  thead.innerHTML = "";
  tbody.innerHTML = "";

  const headRow = thead.insertRow();
  const headers = ["Month", ...stats.categories, "All"];
  for (const h of headers) {
    const th = document.createElement("th");
    th.textContent = h;
    headRow.appendChild(th);
  }

  for (const m of stats.monthly) {
    const row = tbody.insertRow();

    const monthCell = document.createElement("th");
    monthCell.scope = "row";
    monthCell.textContent = m.month;
    row.appendChild(monthCell);

    for (const cat of stats.categories) {
      const bucket = m.byCategory[cat];
      const value = bucket ? bucket[metric] : null;
      row.insertCell().textContent = formatCell(metric, value);
    }

    // Trailing "All" column from the per-month all bucket.
    row.insertCell().textContent = formatCell(metric, m.all[metric]);
  }
}

// ---- Rendering: chart -------------------------------------------------------

/** Ensure the single Chart.js instance exists. */
function ensureChart() {
  if (chart) return chart;
  chart = new Chart(els.canvas.getContext("2d"), {
    type: "line",
    data: { labels: [], datasets: [] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      spanGaps: false, // null values render as gaps
      scales: {
        y: { beginAtZero: true, title: { display: true, text: "" } },
      },
      plugins: {
        legend: { display: true },
        tooltip: { callbacks: {} },
      },
    },
  });
  return chart;
}

/** Overall chart: median & mean lines (hours). Count is NOT drawn. */
function renderOverallChart(stats) {
  const c = ensureChart();
  const labels = stats.months;

  const medianRaw = stats.monthly.map((m) => m.all.median);
  const meanRaw = stats.monthly.map((m) => m.all.mean);

  c.data.labels = labels;
  c.data.datasets = [
    {
      label: "Median",
      data: medianRaw.map((v) => chartValue("median", v)),
      _raw: medianRaw,
      _metric: "median",
      borderColor: PALETTE[0],
      backgroundColor: PALETTE[0],
      tension: 0.2,
    },
    {
      label: "Mean",
      data: meanRaw.map((v) => chartValue("mean", v)),
      _raw: meanRaw,
      _metric: "mean",
      borderColor: PALETTE[1],
      backgroundColor: PALETTE[1],
      tension: 0.2,
    },
  ];
  c.options.scales.y.title.text = "Time to merge (hours)";
  c.options.plugins.tooltip.callbacks.label = (ctx) => {
    const ds = ctx.dataset;
    return tooltipLabel(ds._metric, ds.label, ds._raw[ctx.dataIndex]);
  };
  c.update();
}

/** By-category chart: one line per category for the selected metric. */
function renderCategoryChart(stats, metric) {
  const c = ensureChart();
  c.data.labels = stats.months;
  c.data.datasets = stats.categories.map((cat, i) => {
    const raw = stats.monthly.map((m) => {
      const bucket = m.byCategory[cat];
      return bucket ? bucket[metric] : null;
    });
    const color = PALETTE[i % PALETTE.length];
    return {
      label: cat,
      data: raw.map((v) => chartValue(metric, v)),
      _raw: raw,
      _metric: metric,
      borderColor: color,
      backgroundColor: color,
      tension: 0.2,
    };
  });
  c.options.scales.y.title.text =
    metric === "count" ? "PRs merged" : "Time to merge (hours)";
  c.options.plugins.tooltip.callbacks.label = (ctx) => {
    const ds = ctx.dataset;
    return tooltipLabel(ds._metric, ds.label, ds._raw[ctx.dataIndex]);
  };
  c.update();
}

// ---- Top-level render -------------------------------------------------------

/** Render the current view from cached stats. */
function render() {
  if (!currentStats) return;

  // Show/hide the metric selector (by-category only).
  els.metricControl.classList.toggle("hidden", viewMode !== "byCategory");

  if (viewMode === "overall") {
    renderOverallTable(currentStats);
    renderOverallChart(currentStats);
  } else {
    renderCategoryTable(currentStats, categoryMetric);
    renderCategoryChart(currentStats, categoryMetric);
  }

  const ex = currentStats.excludedCount;
  const days = currentStats.ttmThresholdSeconds / SECONDS_PER_DAY;
  const exPr = ex === 1 ? "PR was" : "PRs were";
  const dayLabel = days === 1 ? "day" : "days";
  const exclusion =
    `${ex} ${exPr} excluded as outliers (time-to-merge over ${days} ${dayLabel}).`;

  const n = currentStats.approximateCount;
  const pr = n === 1 ? "PR has" : "PRs have";
  const approximate =
    `${n} ${pr} an approximate time-to-merge in this 12-month window.`;

  els.footnote.textContent = `${exclusion} ${approximate}`;
}

// ---- Data fetching ----------------------------------------------------------

/**
 * Read the TTM threshold input as a positive integer number of days. Invalid or
 * out-of-range input reverts to the last valid value (and the input is reset to
 * match), so a fetch is never made with a bad threshold.
 */
function currentThresholdDays() {
  const days = Number(els.ttmThreshold.value);
  if (!Number.isInteger(days) || days < 1) {
    els.ttmThreshold.value = String(lastThresholdDays);
    return lastThresholdDays;
  }
  lastThresholdDays = days;
  return days;
}

async function loadStats(repoId, days) {
  let url = `/api/stats?repo=${encodeURIComponent(repoId)}`;
  if (days !== undefined) {
    url += `&ttmDays=${encodeURIComponent(days)}`;
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to load stats (HTTP ${res.status})`);
  }
  currentStats = await res.json();
  els.report.classList.remove("hidden");
  render();
}

async function init() {
  let repos;
  try {
    const res = await fetch("/api/repos");
    repos = await res.json();
  } catch (err) {
    els.emptyMessage.textContent = "Failed to load repositories.";
    els.emptyMessage.classList.remove("hidden");
    return;
  }

  if (!Array.isArray(repos) || repos.length === 0) {
    els.emptyMessage.classList.remove("hidden");
    return;
  }

  // Populate the selector and auto-select the first repo.
  for (const r of repos) {
    const opt = document.createElement("option");
    opt.value = String(r.id);
    opt.textContent = `${r.owner}/${r.repo} (${r.pr_count})`;
    els.repoSelect.appendChild(opt);
  }
  els.controls.classList.remove("hidden");

  // Wire up controls.
  els.repoSelect.addEventListener("change", () => {
    loadStats(els.repoSelect.value, currentThresholdDays());
  });

  els.ttmThreshold.addEventListener("change", () => {
    loadStats(els.repoSelect.value, currentThresholdDays());
  });

  els.viewToggle.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-view]");
    if (!btn) return;
    viewMode = btn.dataset.view;
    for (const b of els.viewToggle.querySelectorAll("button")) {
      b.setAttribute("aria-pressed", String(b === btn));
    }
    render();
  });

  els.metricSelect.addEventListener("change", () => {
    categoryMetric = els.metricSelect.value;
    render();
  });

  // Initial load for the auto-selected first repo. Omit the threshold so the
  // server applies its configured default, then reflect that default in the
  // input (it may have been overridden via env var).
  await loadStats(repos[0].id);
  if (currentStats) {
    lastThresholdDays = currentStats.ttmThresholdSeconds / SECONDS_PER_DAY;
    els.ttmThreshold.value = String(lastThresholdDays);
  }
}

init();
