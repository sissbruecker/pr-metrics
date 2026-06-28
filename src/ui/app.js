/**
 * Client-side, query-only UI for PR stats.
 *
 * Read-only: the only network calls are GETs to `/api/repos`, `/api/categories`,
 * and `/api/stats?repo=<id>`. Nothing is ever written back.
 *
 * The page shows ONE metric at a time, chosen via the topbar switcher (see
 * `METRICS`). A stats response carries every metric's per-month bucket, so
 * switching metrics is a pure client-side re-render of the already-loaded data —
 * only repo / category / threshold changes re-fetch.
 *
 * Flow:
 *   - On load, build the metric switcher, then fetch the tracked repos and
 *     populate the selector (auto-selecting the first). If there are none, show a
 *     friendly message.
 *   - On repo change, fetch that repo's trailing-12-month stats and render.
 *   - On metric change, re-render the loaded stats against the new bucket.
 *   - A category filter (one checkbox per category, all enabled by default) lets
 *     the user include/exclude whole categories from the metric. Since the
 *     median cannot be recombined from per-category medians, toggling a checkbox
 *     re-fetches with the selected categories so the server recomputes — the same
 *     way changing the repo or the outlier threshold re-fetches.
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

// ---- Metrics ----------------------------------------------------------------

/**
 * The metrics the UI can display, in switcher order. Each entry is the page
 * chrome for one metric plus `key`, the name of its bucket in every month of a
 * stats response ({median, mean, excludedCount}). The whole page renders ONE
 * selected metric at a time; switching only swaps which bucket is read, so it is
 * a pure client-side re-render — the stats response already carries every
 * metric's bucket, and no refetch is needed.
 *
 * Adding a metric is a one-entry edit here (plus the matching server-side
 * bucket): the topbar switcher, title, subtitle, chart caption, and outlier
 * footnote all derive from this list.
 */
const METRICS = [
  {
    key: "timeToMerge",
    slug: "time-to-merge",
    title: "Time-to-Merge",
    caption: "Time to merge · hours",
    subtitle:
      "Time to merge is measured from when a PR is ready for review to when it merges, <strong>excluding weekends</strong> (Saturdays and Sundays, UTC).",
    outlierNoun: "time-to-merge",
  },
  {
    key: "timeToFirstReview",
    slug: "time-to-first-review",
    title: "Time-to-First-Review",
    caption: "Time to first review · hours",
    subtitle:
      "Time to first review is measured from when a PR is ready for review to its first review, <strong>excluding weekends</strong> (Saturdays and Sundays, UTC).",
    outlierNoun: "time-to-first-review",
  },
];

/** Look up a metric descriptor by its bucket key. */
function metricByKey(key) {
  return METRICS.find((m) => m.key === key) ?? METRICS[0];
}

// ---- Settings persistence ---------------------------------------------------

/**
 * The control selections (metric, repo, threshold, and the set of unchecked
 * categories) are mirrored to localStorage under one key so they survive a page
 * reload. Reads/writes are wrapped in try/catch: a disabled or corrupt store
 * degrades silently to defaults rather than throwing.
 */
const STORAGE_KEY = "pr-stats:ui";

/** Read the saved settings object, or {} if missing/unavailable/corrupt. */
function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

/** Merge a partial settings patch into the stored object. */
function saveSettings(patch) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...loadSettings(), ...patch }),
    );
  } catch {
    // Ignore: persistence is best-effort.
  }
}

// ---- Module state -----------------------------------------------------------

/** The currently selected metric's bucket key (defaults to the first metric). */
let selectedMetric = METRICS[0].key;

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
 * Last valid outlier threshold (in days) the UI sent to the server. The cap is
 * shared by every metric. Initialized to the input's default and updated as the
 * user edits the input; used both for the outlier footnote and to revert when
 * the input holds an invalid value.
 */
let lastThresholdDays = 7;

// ---- DOM refs ---------------------------------------------------------------

const els = {
  metricTabs: document.getElementById("metric-tabs"),
  pageTitle: document.getElementById("page-title"),
  subtitle: document.getElementById("subtitle"),
  chartCaption: document.getElementById("chart-caption"),
  controls: document.getElementById("controls"),
  repoSelect: document.getElementById("repo-select"),
  categoryFilterControl: document.getElementById("category-filter-control"),
  categoryFilter: document.getElementById("category-filter"),
  outlierThreshold: document.getElementById("outlier-threshold"),
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
    const bucket = m[selectedMetric];
    const row = tbody.insertRow();
    const cells = [
      m.month,
      String(m.count - bucket.excludedCount),
      formatCell("median", bucket.median),
      formatCell("mean", bucket.mean),
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

  const medianRaw = stats.monthly.map((m) => m[selectedMetric].median);
  const meanRaw = stats.monthly.map((m) => m[selectedMetric].mean);

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
    const m = stats.monthly[i];
    return `${m.count - m[selectedMetric].excludedCount} PRs`;
  };
  c.update();
}

// ---- Metric chrome ----------------------------------------------------------

/**
 * Build the topbar metric switcher once, one button per metric. Clicking a
 * button selects that metric and re-renders from the already-loaded stats (no
 * refetch — every metric's bucket is already present). Segments are separated by
 * a muted dot to read as a path inside the terminal topbar.
 */
function buildMetricTabs() {
  els.metricTabs.innerHTML = "";
  METRICS.forEach((metric, i) => {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "metric-tab-sep";
      sep.textContent = "·";
      sep.setAttribute("aria-hidden", "true");
      els.metricTabs.appendChild(sep);
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "metric-tab";
    btn.dataset.metric = metric.key;
    btn.textContent = metric.slug;
    btn.addEventListener("click", () => selectMetric(metric.key));
    els.metricTabs.appendChild(btn);
  });
}

/** Switch the displayed metric and re-render. Ignores a no-op reselect. */
function selectMetric(key) {
  if (key === selectedMetric) return;
  selectedMetric = key;
  saveSettings({ metric: key });
  applyMetricChrome();
  render();
}

/**
 * Update the page chrome that depends on the selected metric: the active topbar
 * tab, the title, the subtitle, and the chart caption. Independent of any data,
 * so it is safe to call before the first stats load.
 */
function applyMetricChrome() {
  const metric = metricByKey(selectedMetric);
  for (const btn of els.metricTabs.querySelectorAll(".metric-tab")) {
    btn.setAttribute(
      "aria-pressed",
      btn.dataset.metric === selectedMetric ? "true" : "false",
    );
  }
  els.pageTitle.textContent = metric.title;
  els.subtitle.innerHTML = metric.subtitle;
  els.chartCaption.textContent = metric.caption;
}

// ---- Top-level render -------------------------------------------------------

/** Render the table + chart from the latest fetched stats. */
function render() {
  if (!currentStats) return;

  renderTable(currentStats);
  renderChart(currentStats);

  const metric = metricByKey(selectedMetric);
  const ex = currentStats.monthly.reduce(
    (s, m) => s + m[selectedMetric].excludedCount,
    0,
  );
  const days = lastThresholdDays;
  const exPr = ex === 1 ? "PR was" : "PRs were";
  const dayLabel = days === 1 ? "day" : "days";
  els.footnote.textContent =
    `${ex} ${exPr} excluded as outliers (${metric.outlierNoun} over ${days} ${dayLabel}).`;
}

// ---- Data fetching ----------------------------------------------------------

/**
 * Read the outlier threshold input as a positive integer number of days. Invalid
 * or out-of-range input reverts to the last valid value (and the input is reset
 * to match), so a fetch is never made with a bad threshold.
 */
function currentThresholdDays() {
  const days = Number(els.outlierThreshold.value);
  if (!Number.isInteger(days) || days < 1) {
    els.outlierThreshold.value = String(lastThresholdDays);
    return lastThresholdDays;
  }
  lastThresholdDays = days;
  return days;
}

/**
 * Build the category filter checkboxes from the canonical category list and
 * reveal the control. A category is checked unless it appears in `deselected`
 * (the persisted set of unchecked names), so categories added since the last
 * visit default to checked. Seeds `selectedCategories` from the checked boxes.
 */
function buildCategoryFilter(categories, deselected = new Set()) {
  selectedCategories = new Set();
  els.categoryFilter.innerHTML = "";
  for (const cat of categories) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = cat;
    input.checked = !deselected.has(cat);
    if (input.checked) selectedCategories.add(cat);
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
    url += `&thresholdDays=${encodeURIComponent(days)}`;
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
  // Restore persisted selections (defaults to {} if nothing/invalid is stored).
  const saved = loadSettings();

  // Restore the metric before applying chrome, guarding against a stale key
  // from a since-removed metric.
  if (saved.metric && METRICS.some((m) => m.key === saved.metric)) {
    selectedMetric = saved.metric;
  }

  // Build the metric switcher and apply the (possibly restored) metric's chrome
  // up front, so the topbar, title, and subtitle are populated even on the
  // empty / error states (the switcher itself depends only on the static
  // METRICS list).
  buildMetricTabs();
  applyMetricChrome();

  // Repos and the category list are independent resources; fetch them together.
  let repos, categories;
  try {
    const [reposRes, categoriesRes] = await Promise.all([
      fetch("/api/repos"),
      fetch("/api/categories"),
    ]);
    repos = await reposRes.json();
    categories = await categoriesRes.json();
  } catch (err) {
    els.emptyMessage.textContent = "Failed to load repositories.";
    els.emptyMessage.classList.remove("hidden");
    return;
  }

  if (!Array.isArray(repos) || repos.length === 0) {
    els.emptyMessage.classList.remove("hidden");
    return;
  }

  // Populate the selector, restoring the saved repo if it still exists and
  // otherwise auto-selecting the first.
  for (const r of repos) {
    const opt = document.createElement("option");
    opt.value = String(r.id);
    opt.textContent = `${r.owner}/${r.repo} (${r.pr_count})`;
    els.repoSelect.appendChild(opt);
  }
  let initialRepo = String(repos[0].id);
  if (saved.repo != null && repos.some((r) => String(r.id) === String(saved.repo))) {
    initialRepo = String(saved.repo);
  }
  els.repoSelect.value = initialRepo;

  buildCategoryFilter(categories, new Set(saved.deselectedCategories ?? []));

  // Seed the threshold input from a valid saved value before the first fetch,
  // using the same positive-integer guard as currentThresholdDays.
  if (Number.isInteger(saved.thresholdDays) && saved.thresholdDays >= 1) {
    els.outlierThreshold.value = String(saved.thresholdDays);
  }

  els.controls.classList.remove("hidden");

  // Wire up controls. Repo and threshold changes re-fetch while preserving the
  // current category selection.
  els.repoSelect.addEventListener("change", () => {
    saveSettings({ repo: els.repoSelect.value });
    loadStats(els.repoSelect.value, currentThresholdDays(), selectedCategories ?? undefined);
  });

  els.outlierThreshold.addEventListener("change", () => {
    const days = currentThresholdDays();
    saveSettings({ thresholdDays: days });
    loadStats(els.repoSelect.value, days, selectedCategories ?? undefined);
  });

  // Toggling a category checkbox re-fetches: median can't be recombined from
  // per-category medians, so the server recomputes over the selected set.
  els.categoryFilter.addEventListener("change", () => {
    const boxes = els.categoryFilter.querySelectorAll('input[type="checkbox"]');
    selectedCategories = new Set([...boxes].filter((b) => b.checked).map((b) => b.value));
    saveSettings({
      deselectedCategories: [...boxes].filter((b) => !b.checked).map((b) => b.value),
    });
    loadStats(els.repoSelect.value, currentThresholdDays(), selectedCategories);
  });

  // Initial load for the selected repo (restored or first), using the threshold
  // shown in the input.
  await loadStats(initialRepo, currentThresholdDays(), selectedCategories ?? undefined);
}

init();
