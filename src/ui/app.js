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
 *   - A category filter (one checkbox per category, all enabled by default) lets
 *     the user include/exclude whole categories from the metric. Since the
 *     median cannot be recombined from per-category medians, toggling a checkbox
 *     re-fetches with the selected categories so the server recomputes — the same
 *     way changing the repo or the TTM threshold re-fetches.
 *
 * Chart handling: a single Chart.js instance is created once and then mutated
 * (data + options replaced, `chart.update()`) on every render, rather than
 * destroyed/recreated, to keep it cheap and flicker-free.
 *
 * Units: median/mean are stored as SECONDS. On the chart's y-axis they are
 * plotted in HOURS (seconds / 3600) for legible axis numbers; tooltips show the
 * full human-readable duration via formatDuration. Count is not charted; it
 * appears only in the table.
 */

import { formatDuration, BLANK } from "/format.js";

const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86400;

// ---- Module state -----------------------------------------------------------

/**
 * Currently included categories as a Set of category names. null until the
 * filter is built from the first stats response; thereafter it always reflects
 * the checkbox state (an empty set means "none selected").
 * @type {Set<string> | null}
 */
let selectedCategories = null;
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
  categoryFilterControl: document.getElementById("category-filter-control"),
  categoryFilter: document.getElementById("category-filter"),
  ttmThreshold: document.getElementById("ttm-threshold"),
  emptyMessage: document.getElementById("empty-message"),
  report: document.getElementById("report"),
  canvas: document.getElementById("chart"),
  table: document.getElementById("data-table"),
  footnote: document.getElementById("footnote"),
};

// Colors for the median / mean lines.
const PALETTE = [
  "#3d63dd", // blue (median)
  "#d9480f", // red (mean)
];

// Light fill under the median line (PALETTE[0] at 7% opacity).
const MEDIAN_AREA = "rgba(61, 99, 221, 0.07)";

// Monospace family for all canvas-rendered text, matching the surrounding UI.
const MONO_FONT =
  "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

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

/** Render the table: 12 month rows x count / median / mean. */
function renderTable(stats) {
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
        x: {
          grid: { display: false },
          border: { color: "#c9cdd3", width: 1.25 },
          ticks: { color: "#8b919c", font: { family: MONO_FONT, size: 11 } },
        },
        y: {
          beginAtZero: true,
          grid: { color: "#eceef0", drawTicks: false },
          border: { display: false },
          ticks: {
            color: "#8b919c",
            font: { family: MONO_FONT, size: 11 },
            padding: 8,
          },
        },
      },
      plugins: {
        // The legend lives in the HTML chart header, not on the canvas.
        legend: { display: false },
        tooltip: {
          backgroundColor: "#14161a",
          titleColor: "#ffffff",
          titleFont: { family: MONO_FONT, size: 12.5, weight: "600" },
          bodyColor: "#ffffff",
          bodyFont: { family: MONO_FONT, size: 11.5 },
          bodySpacing: 6,
          footerColor: "#7e848e",
          footerFont: { family: MONO_FONT, size: 11, weight: "400" },
          footerMarginTop: 8,
          padding: 12,
          cornerRadius: 7,
          boxWidth: 11,
          boxHeight: 3,
          boxPadding: 4,
          usePointStyle: false,
          callbacks: {},
        },
      },
    },
  });
  return chart;
}

/** Chart: median & mean lines (hours). Count is NOT drawn. */
function renderChart(stats) {
  const c = ensureChart();
  const labels = stats.months;

  const medianRaw = stats.monthly.map((m) => m.all.median);
  const meanRaw = stats.monthly.map((m) => m.all.mean);

  // Shared marker styling: a white dot with a colored ring, per the design.
  const point = {
    pointRadius: 3,
    pointHoverRadius: 5,
    pointBackgroundColor: "#ffffff",
    pointBorderWidth: 1.75,
    pointHoverBorderWidth: 1.75,
  };

  c.data.labels = labels;
  c.data.datasets = [
    {
      label: "Median",
      data: medianRaw.map((v) => chartValue("median", v)),
      _raw: medianRaw,
      _metric: "median",
      borderColor: PALETTE[0],
      backgroundColor: MEDIAN_AREA,
      pointBorderColor: PALETTE[0],
      borderWidth: 2.25,
      tension: 0,
      fill: "origin", // subtle area under the median line
      ...point,
    },
    {
      label: "Mean",
      data: meanRaw.map((v) => chartValue("mean", v)),
      _raw: meanRaw,
      _metric: "mean",
      borderColor: PALETTE[1],
      backgroundColor: PALETTE[1],
      pointBorderColor: PALETTE[1],
      borderWidth: 2.25,
      tension: 0,
      fill: false,
      ...point,
    },
  ];

  const cb = c.options.plugins.tooltip.callbacks;
  cb.label = (ctx) => {
    const ds = ctx.dataset;
    return tooltipLabel(ds._metric, ds.label, ds._raw[ctx.dataIndex]);
  };
  // Render the tooltip swatch in the line color (not the faint area fill).
  cb.labelColor = (ctx) => ({
    borderColor: ctx.dataset.borderColor,
    backgroundColor: ctx.dataset.borderColor,
    borderRadius: 2,
  });
  // Footer: the PR count for the hovered month.
  cb.footer = (items) => {
    const i = items[0]?.dataIndex;
    if (i === undefined) return "";
    return `${stats.monthly[i].all.count} PRs`;
  };
  c.update();
}

// ---- Top-level render -------------------------------------------------------

/** Render the table + chart from the latest fetched stats. */
function render() {
  if (!currentStats) return;

  renderTable(currentStats);
  renderChart(currentStats);

  const ex = currentStats.excludedCount;
  const days = currentStats.ttmThresholdSeconds / SECONDS_PER_DAY;
  const exPr = ex === 1 ? "PR was" : "PRs were";
  const dayLabel = days === 1 ? "day" : "days";
  els.footnote.textContent =
    `${ex} ${exPr} excluded as outliers (time-to-merge over ${days} ${dayLabel}).`;
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

/**
 * Build the category filter checkboxes from the canonical category list, all
 * checked, and reveal the control. Seeds `selectedCategories` to the full set.
 */
function buildCategoryFilter(categories) {
  selectedCategories = new Set(categories);
  els.categoryFilter.innerHTML = "";
  for (const cat of categories) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = cat;
    input.checked = true;
    label.appendChild(input);
    label.appendChild(document.createTextNode(cat));
    els.categoryFilter.appendChild(label);
  }
  els.categoryFilterControl.classList.remove("hidden");
}

/**
 * Fetch and render stats. `categories` is a Set of category names to include;
 * when undefined the param is omitted and the server includes all categories
 * (an empty set sends `categories=`, which the server reads as "none").
 */
async function loadStats(repoId, days, categories) {
  let url = `/api/stats?repo=${encodeURIComponent(repoId)}`;
  if (days !== undefined) {
    url += `&ttmDays=${encodeURIComponent(days)}`;
  }
  if (categories !== undefined) {
    url += `&categories=${encodeURIComponent([...categories].join(","))}`;
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

  // Wire up controls. Repo and threshold changes re-fetch while preserving the
  // current category selection.
  els.repoSelect.addEventListener("change", () => {
    loadStats(els.repoSelect.value, currentThresholdDays(), selectedCategories ?? undefined);
  });

  els.ttmThreshold.addEventListener("change", () => {
    loadStats(els.repoSelect.value, currentThresholdDays(), selectedCategories ?? undefined);
  });

  // Toggling a category checkbox re-fetches: median can't be recombined from
  // per-category medians, so the server recomputes over the selected set.
  els.categoryFilter.addEventListener("change", () => {
    const boxes = els.categoryFilter.querySelectorAll('input[type="checkbox"]');
    selectedCategories = new Set([...boxes].filter((b) => b.checked).map((b) => b.value));
    loadStats(els.repoSelect.value, currentThresholdDays(), selectedCategories);
  });

  // Initial load for the auto-selected first repo. Omit the threshold so the
  // server applies its configured default, then reflect that default in the
  // input (it may have been overridden via env var).
  await loadStats(repos[0].id);
  if (currentStats) {
    lastThresholdDays = currentStats.ttmThresholdSeconds / SECONDS_PER_DAY;
    els.ttmThreshold.value = String(lastThresholdDays);
    buildCategoryFilter(currentStats.categories);
  }
}

init();
