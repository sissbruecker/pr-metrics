/**
 * Client-side UI for PR stats, running entirely on generated static data.
 *
 * The only network calls are GETs for `./data/repos.json` (the repo index, once
 * at startup) and `./data/<owner>-<repo>.json` (one repo's merged PRs, once per
 * repo, cached in memory). Everything else — the trailing-12-month window, the
 * version-bump exclusion, the category filter, the outlier cap, and the
 * median/mean aggregation — is computed locally by the shared stats pipeline
 * (`./stats.ts`), so changing the threshold or toggling a category never
 * refetches. All URLs are relative, so the site works hosted under a subpath.
 *
 * The page shows ONE metric at a time, chosen via the topbar switcher (see
 * `METRICS`). A computed stats result carries every metric's per-month bucket,
 * so switching metrics is a pure re-render of the already-computed data.
 *
 * Flow:
 *   - On load, build the metric switcher, then fetch the repo index and
 *     populate the selector (auto-selecting the first). If there are none, show
 *     a friendly message.
 *   - On repo change, fetch that repo's rows (or reuse the cache) and recompute.
 *   - On metric change, re-render the computed stats against the new bucket.
 *   - On threshold or category change, recompute locally and re-render.
 *
 * The window is derived from `new Date()` at view time, while the data is only
 * as fresh as the last `generate`; the index's `generatedAt` is rendered at the
 * bottom of the page so a stale deployment explains itself rather than
 * mysteriously showing empty recent months.
 *
 * Chart handling: a single Chart.js instance is created once and then mutated
 * (data + options replaced, `chart.update()`) on every render, rather than
 * destroyed/recreated, to keep it cheap and flicker-free.
 *
 * Units: median/mean are computed as SECONDS. On the chart's y-axis they are
 * plotted in HOURS (seconds / 3600) for legible axis numbers; tooltips show the
 * full human-readable duration via formatDuration. Count is not charted; it
 * appears only in the table.
 */

import Chart from "./chart.umd.js";
import { CATEGORIES, type Category } from "./categorize.ts";
import { formatDuration, BLANK } from "./format.ts";
import {
  computeStats,
  DEFAULT_OUTLIER_THRESHOLD_DAYS,
  SECONDS_PER_DAY,
  type StatsResult,
} from "./stats.ts";
import { repoDataFileName, type RepoDataFile, type RepoInfo, type ReposFile, type StatsRow } from "./types.ts";

const SECONDS_PER_HOUR = 3600;

// ---- Metrics ----------------------------------------------------------------

/** The bucket key of one metric in a month's stats. */
type MetricKey = "timeToMerge" | "timeToFirstReview" | "timeToApproval";

interface MetricDescriptor {
  key: MetricKey;
  slug: string;
  title: string;
  caption: string;
  subtitle: string;
  outlierNoun: string;
}

/**
 * The metrics the UI can display, in switcher order. Each entry is the page
 * chrome for one metric plus `key`, the name of its bucket in every month of a
 * stats result ({median, mean, excludedCount}). The whole page renders ONE
 * selected metric at a time; switching only swaps which bucket is read, so it is
 * a pure re-render — the computed result already carries every metric's bucket.
 *
 * Adding a metric is a one-entry edit here (plus the matching bucket in the
 * stats pipeline): the topbar switcher, title, subtitle, chart caption, and
 * outlier footnote all derive from this list.
 */
const METRICS: readonly MetricDescriptor[] = [
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
  {
    key: "timeToApproval",
    slug: "time-to-approval",
    title: "Time-to-Approval",
    caption: "Time to approval · hours",
    subtitle:
      "Time to approval is measured from when a PR is ready for review to its first approval, <strong>excluding weekends</strong> (Saturdays and Sundays, UTC).",
    outlierNoun: "time-to-approval",
  },
];

/** Look up a metric descriptor by its bucket key. */
function metricByKey(key: MetricKey): MetricDescriptor {
  return METRICS.find((m) => m.key === key) ?? METRICS[0]!;
}

// ---- Settings persistence ---------------------------------------------------

/**
 * The control selections (metric, repo, threshold, and the set of unchecked
 * categories) are mirrored to localStorage under one key so they survive a page
 * reload. Reads/writes are wrapped in try/catch: a disabled or corrupt store
 * degrades silently to defaults rather than throwing.
 */
const STORAGE_KEY = "pr-stats:ui";

interface SavedSettings {
  metric?: string;
  /** Repo slug (`owner/repo`). Older builds stored a numeric DB id; the repo
   * restore guard treats such stale values as "not found". */
  repo?: string;
  thresholdDays?: number;
  deselectedCategories?: string[];
}

/** Read the saved settings object, or {} if missing/unavailable/corrupt. */
function loadSettings(): SavedSettings {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") || {};
  } catch {
    return {};
  }
}

/** Merge a partial settings patch into the stored object. */
function saveSettings(patch: SavedSettings): void {
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
let selectedMetric: MetricKey = METRICS[0]!.key;

/**
 * Currently included categories as a Set of category names. null until the
 * filter is built at startup; thereafter it always reflects the checkbox state
 * (an empty set means "none selected").
 */
let selectedCategories: Set<Category> | null = null;
/** The selected repo's merged-PR rows, or null before the first load. */
let currentRows: StatsRow[] | null = null;
/** Per-repo row cache: each repo's data file is fetched at most once. */
const rowsBySlug = new Map<string, StatsRow[]>();
/** Latest computed stats for the selected repo + filters, or null. */
let currentStats: StatsResult | null = null;
/** The single Chart.js instance, created lazily. */
let chart: any = null;
/**
 * Last valid outlier threshold (in days). The cap is shared by every metric.
 * Initialized to the default and updated as the user edits the input; used both
 * for the outlier footnote and to revert when the input holds an invalid value.
 */
let lastThresholdDays = DEFAULT_OUTLIER_THRESHOLD_DAYS;

// ---- DOM refs ---------------------------------------------------------------

const els = {
  metricTabs: document.getElementById("metric-tabs")!,
  pageTitle: document.getElementById("page-title")!,
  subtitle: document.getElementById("subtitle")!,
  chartCaption: document.getElementById("chart-caption")!,
  controls: document.getElementById("controls")!,
  repoSelect: document.getElementById("repo-select") as HTMLSelectElement,
  categoryFilterControl: document.getElementById("category-filter-control")!,
  categoryFilter: document.getElementById("category-filter")!,
  outlierThreshold: document.getElementById("outlier-threshold") as HTMLInputElement,
  emptyMessage: document.getElementById("empty-message")!,
  report: document.getElementById("report")!,
  canvas: document.getElementById("chart") as HTMLCanvasElement,
  table: document.getElementById("data-table") as HTMLTableElement,
  footnote: document.getElementById("footnote")!,
  generatedAt: document.getElementById("generated-at")!,
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
function formatCell(metric: string, value: number | null | undefined): string {
  if (value === null || value === undefined) return BLANK;
  if (metric === "count") return String(value);
  return formatDuration(value);
}

/** Convert a metric value to a numeric chart point (null stays null = gap). */
function chartValue(metric: string, value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (metric === "count") return value;
  return value / SECONDS_PER_HOUR; // seconds -> hours
}

/** Build a tooltip label for a metric value. */
function tooltipLabel(
  metric: string,
  datasetLabel: string,
  rawSeconds: number | null | undefined,
): string {
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
function renderTable(stats: StatsResult): void {
  const thead = els.table.tHead!;
  const tbody = els.table.tBodies[0]!;
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
        (cell as HTMLTableCellElement).scope = "row";
        row.appendChild(cell);
      }
    });
  }
}

// ---- Rendering: chart -------------------------------------------------------

/** Ensure the single Chart.js instance exists. */
function ensureChart(): any {
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
function renderChart(stats: StatsResult): void {
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
  cb.label = (ctx: any) => {
    const ds = ctx.dataset;
    return tooltipLabel(ds._metric, ds.label, ds._raw[ctx.dataIndex]);
  };
  // Render the tooltip swatch in the line color (not the faint area fill).
  cb.labelColor = (ctx: any) => ({
    borderColor: ctx.dataset.borderColor,
    backgroundColor: ctx.dataset.borderColor,
    borderRadius: 2,
  });
  // Footer: the PR count for the hovered month.
  cb.footer = (items: any[]) => {
    const i = items[0]?.dataIndex;
    if (i === undefined) return "";
    const m = stats.monthly[i]!;
    return `${m.count - m[selectedMetric].excludedCount} PRs`;
  };
  c.update();
}

// ---- Metric chrome ----------------------------------------------------------

/**
 * Build the topbar metric switcher once, one button per metric. Clicking a
 * button selects that metric and re-renders from the already-computed stats (no
 * recompute — every metric's bucket is already present). Segments are separated
 * by a muted dot to read as a path inside the terminal topbar.
 */
function buildMetricTabs(): void {
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
function selectMetric(key: MetricKey): void {
  if (key === selectedMetric) return;
  selectedMetric = key;
  saveSettings({ metric: key });
  applyMetricChrome();
  render();
}

/**
 * Update the page chrome that depends on the selected metric: the active topbar
 * tab, the title, the subtitle, and the chart caption. Independent of any data,
 * so it is safe to call before the first data load.
 */
function applyMetricChrome(): void {
  const metric = metricByKey(selectedMetric);
  for (const btn of els.metricTabs.querySelectorAll(".metric-tab")) {
    btn.setAttribute(
      "aria-pressed",
      (btn as HTMLElement).dataset.metric === selectedMetric ? "true" : "false",
    );
  }
  els.pageTitle.textContent = metric.title;
  els.subtitle.innerHTML = metric.subtitle;
  els.chartCaption.textContent = metric.caption;
}

// ---- Top-level render -------------------------------------------------------

/** Render the table + chart from the latest computed stats. */
function render(): void {
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

// ---- Data loading & local recompute ------------------------------------------

/**
 * Read the outlier threshold input as a positive integer number of days. Invalid
 * or out-of-range input reverts to the last valid value (and the input is reset
 * to match), so stats are never computed with a bad threshold.
 */
function currentThresholdDays(): number {
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
function buildCategoryFilter(
  categories: readonly Category[],
  deselected: Set<string> = new Set(),
): void {
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

/** Fetch a JSON resource, throwing on a non-OK response. */
async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to load ${url} (HTTP ${res.status})`);
  }
  return (await res.json()) as T;
}

/**
 * Recompute the stats from the loaded rows and the current filter controls,
 * then render. Pure local work — never fetches.
 */
function recompute(): void {
  if (!currentRows) return;
  currentStats = computeStats(
    currentRows,
    new Date(),
    currentThresholdDays() * SECONDS_PER_DAY,
    selectedCategories ?? undefined,
  );
  els.report.classList.remove("hidden");
  render();
}

/**
 * Load a repo's rows (from the in-memory cache, or its data file on first
 * selection) and recompute.
 */
async function showRepo(slug: string): Promise<void> {
  let rows = rowsBySlug.get(slug);
  if (!rows) {
    const data = await fetchJson<RepoDataFile>(`./data/${repoDataFileName(slug)}`);
    rows = data.pullRequests;
    rowsBySlug.set(slug, rows);
  }
  currentRows = rows;
  recompute();
}

/** Render the generation timestamp so a stale deployment explains itself. */
function renderGeneratedAt(generatedAt: string): void {
  const ms = Date.parse(generatedAt);
  const label = Number.isNaN(ms)
    ? generatedAt
    : new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  els.generatedAt.textContent = `Data generated ${label}.`;
}

async function init(): Promise<void> {
  // Restore persisted selections (defaults to {} if nothing/invalid is stored).
  const saved = loadSettings();

  // Restore the metric before applying chrome, guarding against a stale key
  // from a since-removed metric.
  if (saved.metric && METRICS.some((m) => m.key === saved.metric)) {
    selectedMetric = saved.metric as MetricKey;
  }

  // Build the metric switcher and apply the (possibly restored) metric's chrome
  // up front, so the topbar, title, and subtitle are populated even on the
  // empty / error states (the switcher itself depends only on the static
  // METRICS list).
  buildMetricTabs();
  applyMetricChrome();

  let index: ReposFile;
  try {
    index = await fetchJson<ReposFile>("./data/repos.json");
  } catch {
    els.emptyMessage.textContent = "Failed to load repositories.";
    els.emptyMessage.classList.remove("hidden");
    return;
  }

  renderGeneratedAt(index.generatedAt);

  const repos: RepoInfo[] = index.repos;
  if (!Array.isArray(repos) || repos.length === 0) {
    els.emptyMessage.classList.remove("hidden");
    return;
  }

  // Populate the selector, restoring the saved repo if it still exists and
  // otherwise auto-selecting the first. Options are keyed by slug; a stale
  // saved value (including a numeric id from an older build) falls through.
  for (const r of repos) {
    const opt = document.createElement("option");
    opt.value = r.slug;
    opt.textContent = `${r.slug} (${r.prCount})`;
    els.repoSelect.appendChild(opt);
  }
  let initialRepo = repos[0]!.slug;
  if (saved.repo != null && repos.some((r) => r.slug === saved.repo)) {
    initialRepo = saved.repo;
  }
  els.repoSelect.value = initialRepo;

  buildCategoryFilter(CATEGORIES, new Set(saved.deselectedCategories ?? []));

  // Seed the threshold input from a valid saved value before the first
  // compute, using the same positive-integer guard as currentThresholdDays.
  if (Number.isInteger(saved.thresholdDays) && saved.thresholdDays! >= 1) {
    els.outlierThreshold.value = String(saved.thresholdDays);
  }

  els.controls.classList.remove("hidden");

  // Wire up controls. Only a repo change can fetch (once per repo); threshold
  // and category changes recompute locally from the rows already in hand.
  els.repoSelect.addEventListener("change", () => {
    saveSettings({ repo: els.repoSelect.value });
    showRepo(els.repoSelect.value);
  });

  els.outlierThreshold.addEventListener("change", () => {
    const days = currentThresholdDays();
    saveSettings({ thresholdDays: days });
    recompute();
  });

  els.categoryFilter.addEventListener("change", () => {
    const boxes = els.categoryFilter.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    selectedCategories = new Set(
      [...boxes].filter((b) => b.checked).map((b) => b.value as Category),
    );
    saveSettings({
      deselectedCategories: [...boxes].filter((b) => !b.checked).map((b) => b.value),
    });
    recompute();
  });

  // Initial load for the selected repo (restored or first).
  await showRepo(initialRepo);
}

init();
