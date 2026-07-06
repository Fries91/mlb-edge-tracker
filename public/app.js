let state = null;
let bestFilter = "all";
let qualityFilter = "all";
let bestSort = "confidence";
let volumeFilter = "5";
let lastSyncAt = null;
let nextAutoSyncAt = null;
let currentRefreshStatus = "Ready";

let lastGoodLoadAt = null;
let lastErrorMessage = "None";
let failedSyncs = 0;
let nextRetryAt = null;
let deferredInstallPrompt = null;
let qualityCalibrationCache = null;

const FRONTEND_SYNC_MS = 15 * 60 * 1000;
const CACHE_KEY = "mlb-edge-dashboard-cache";

const FACTOR_LABELS = {
  winPct: "Season Win %",
  homeAway: "Home/Away Split",
  rpg: "Scoring",
  rapg: "Run Prevention",
  runDiff: "Run Differential",

  recent7WinPct: "Last 7 Form",
  recent15WinPct: "Last 15 Form",
  recent30WinPct: "Last 30 Form",
  recent7Runs: "Recent Offense",
  recent7Prevent: "Recent Defense",
  recentRunDiff: "Recent Run Diff",
  streakEdge: "Streak",

  pitcherEra: "Starter ERA",
  pitcherWhip: "Starter WHIP",
  pitcherStrikeouts: "Starter Strikeouts",
  pitcherRecentEra: "Recent Starter ERA",
  pitcherRecentWhip: "Recent Starter WHIP",
  pitcherRecentK: "Recent Starter K",

  handednessSplit: "Batting Splits",
  lineupStrength: "Lineup Strength",

  h2h: "Head-to-Head",
  restEdge: "Rest Days",
  bullpenFatigue: "Bullpen Fatigue"
};

const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));

function setText(selector, value) {
  const el = $(selector);
  if (el) el.textContent = value;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function number(value, digits = 3) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "--";
  return n.toFixed(digits);
}

function percent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "--";
  return `${Math.round(n * 1000) / 10}%`;
}

function formatClock(value) {
  if (!value) return "--";

  try {
    return new Date(value).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit"
    });
  } catch {
    return "--";
  }
}

function shortTime(dateValue) {
  return formatClock(dateValue);
}

function prettyDate(dateValue) {
  if (!dateValue) return "--";

  try {
    return new Date(dateValue + "T12:00:00").toLocaleDateString([], {
      weekday: "short",
      month: "short",
      day: "numeric"
    });
  } catch {
    return dateValue;
  }
}

function isFinalStatus(status) {
  const s = String(status || "").toLowerCase();
  return s.includes("final") || s.includes("completed") || s.includes("game over");
}

function saveDashboardCache(data) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      savedAt: new Date().toISOString(),
      dashboard: data
    }));
  } catch {
    // Cache is helpful but not required.
  }
}

function loadDashboardCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;

    const cached = JSON.parse(raw);
    return cached?.dashboard || null;
  } catch {
    return null;
  }
}

function clearQualityCalibration() {
  qualityCalibrationCache = null;
}

function setStatus(text, mode = "ready") {
  currentRefreshStatus = text;

  const statusText = $("#statusText");
  const dot = $("#statusDot");

  if (statusText) statusText.textContent = text;

  if (dot) {
    dot.classList.remove("working", "error");

    if (mode === "working") dot.classList.add("working");
    if (mode === "error") dot.classList.add("error");
  }

  renderRefreshStatus();
  renderSafetyMonitor();
}

function factorLabel(key) {
  return FACTOR_LABELS[key] || key;
}

function qualityRank(key) {
  const ranks = {
    elite: 5,
    strong: 4,
    good: 3,
    lean: 2,
    risky: 1
  };

  return ranks[key] || 1;
}

function rankToQualityKey(rank) {
  const safeRank = clamp(Math.round(rank), 1, 5);

  if (safeRank === 5) return "elite";
  if (safeRank === 4) return "strong";
  if (safeRank === 3) return "good";
  if (safeRank === 2) return "lean";
  return "risky";
}

function qualityMeta(key) {
  if (key === "elite") return { key, label: "🏆 Elite Edge", className: "qualityElite" };
  if (key === "strong") return { key, label: "🔥 Strong Edge", className: "qualityStrong" };
  if (key === "good") return { key, label: "✅ Good Edge", className: "qualityGood" };
  if (key === "lean") return { key, label: "⚠️ Lean", className: "qualityLean" };

  return {
    key: "risky",
    label: "🧊 Risky / Toss Up",
    className: "qualityRisky"
  };
}

function volumeLimit() {
  if (volumeFilter === "3") return 3;
  if (volumeFilter === "5") return 5;
  if (volumeFilter === "8") return 8;
  return Infinity;
}

function volumeLabel() {
  if (volumeFilter === "3") return "Best 3";
  if (volumeFilter === "5") return "Best 5";
  if (volumeFilter === "8") return "Best 8";
  return "All Qualified";
}

function bestFilterMinimum() {
  if (bestFilter === "strong") return 68;
  if (bestFilter === "good") return 60;
  if (bestFilter === "lean") return 54;
  return 0;
}

function bestFilterLabel() {
  if (bestFilter === "strong") return "Confidence: 🔥 Strong Edge only, 68%+.";
  if (bestFilter === "good") return "Confidence: ✅ Good Edge+, 60%+.";
  if (bestFilter === "lean") return "Confidence: ⚠️ Lean+, 54%+.";
  return "Confidence: All.";
}

function qualityFilterLabel() {
  if (qualityFilter === "elite") return "Quality: 🏆 Elite only.";
  if (qualityFilter === "strong") return "Quality: 🔥 Strong+.";
  if (qualityFilter === "good") return "Quality: ✅ Good+.";
  if (qualityFilter === "lean") return "Quality: ⚠️ Lean+.";
  return "Quality: All.";
}

function sortFilterLabel() {
  if (bestSort === "quality") return "Sort: Best quality.";
  if (bestSort === "time") return "Sort: Game time.";
  if (bestSort === "edge") return "Sort: Strongest edge score.";
  return "Sort: Highest calibrated confidence.";
}

async function getJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  const data = await res.json();

  if (!res.ok || data.ok === false) {
    throw new Error(data.error || "Request failed");
  }

  return data;
}

async function load(sync = false) {
  try {
    setStatus(sync ? "Syncing..." : "Loading...", "working");

    const data = sync
      ? await getJson("/api/sync")
      : await getJson("/api/dashboard");

    state = data.dashboard || data;
    clearQualityCalibration();

    lastSyncAt = new Date();
    lastGoodLoadAt = new Date();
    nextAutoSyncAt = new Date(Date.now() + FRONTEND_SYNC_MS);
    nextRetryAt = nextAutoSyncAt;
    failedSyncs = 0;
    lastErrorMessage = "None";

    saveDashboardCache(state);
    render();

    setStatus("Live", "ready");
  } catch (error) {
    console.error(error);

    failedSyncs += 1;
    lastErrorMessage = error.message || "Sync failed";
    nextRetryAt = new Date(Date.now() + FRONTEND_SYNC_MS);

    const cached = state || loadDashboardCache();

    if (cached) {
      state = cached;
      clearQualityCalibration();
      render();
      setStatus("Using cached data", "error");
    } else {
      setStatus(lastErrorMessage, "error");
      renderSafetyMonitor();
    }
  }
}

function setupTabs() {
  $$(".tab").forEach(button => {
    button.addEventListener("click", () => {
      const tab = button.dataset.tab;

      $$(".tab").forEach(b => b.classList.remove("active"));
      button.classList.add("active");

      $$(".tabPanel").forEach(panel => panel.classList.add("hidden"));

      const activePanel = $(`#panel-${tab}`);
      if (activePanel) activePanel.classList.remove("hidden");
    });
  });
}

function setupBestFilters() {
  $$("#volumeFilters .filterBtn").forEach(button => {
    button.addEventListener("click", () => {
      volumeFilter = button.dataset.volume || "5";

      $$("#volumeFilters .filterBtn").forEach(b => b.classList.remove("active"));
      button.classList.add("active");

      render();
    });
  });

  $$("#confidenceFilters .filterBtn").forEach(button => {
    button.addEventListener("click", () => {
      bestFilter = button.dataset.filter || "all";

      $$("#confidenceFilters .filterBtn").forEach(b => b.classList.remove("active"));
      button.classList.add("active");

      render();
    });
  });

  $$("#qualityFilters .filterBtn").forEach(button => {
    button.addEventListener("click", () => {
      qualityFilter = button.dataset.quality || "all";

      $$("#qualityFilters .filterBtn").forEach(b => b.classList.remove("active"));
      button.classList.add("active");

      render();
    });
  });

  $$("#sortFilters .filterBtn").forEach(button => {
    button.addEventListener("click", () => {
      bestSort = button.dataset.sort || "confidence";

      $$("#sortFilters .filterBtn").forEach(b => b.classList.remove("active"));
      button.classList.add("active");

      render();
    });
  });
}

function setupInstallButton() {
  const installBtn = $("#installBtn");
  if (!installBtn) return;

  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();

    deferredInstallPrompt = event;
    installBtn.classList.remove("hidden");
  });

  installBtn.addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;

    deferredInstallPrompt.prompt();

    try {
      await deferredInstallPrompt.userChoice;
    } catch {
      // Ignore cancelled install prompt.
    }

    deferredInstallPrompt = null;
    installBtn.classList.add("hidden");
  });

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    installBtn.classList.add("hidden");
  });
}

function allVisibleGames() {
  return [
    ...(state?.todayGames || []),
    ...(state?.tomorrowGames || [])
  ];
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function combinedEdge(values) {
  const usable = values
    .map(value => finiteNumber(value))
    .filter(value => value !== null);

  if (!usable.length) return null;

  return usable.reduce((sum, value) => sum + value, 0);
}

function edgeWinner(value, game) {
  const n = Number(value || 0);

  if (Math.abs(n) < 0.03) return "Close";

  return n > 0 ? game.homeTeamName : game.awayTeamName;
}

function edgeValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "--";

  const sign = n > 0 ? "+" : "";
  return `${sign}${number(n, 3)}`;
}

function getPredictionEdges(game, pred) {
  if (!pred) return [];

  const f = pred.features || {};

  const pitcherEdge = combinedEdge([f.pitcherEra, f.pitcherWhip, f.pitcherStrikeouts]);
  const pitcherRecentEdge = combinedEdge([f.pitcherRecentEra, f.pitcherRecentWhip, f.pitcherRecentK]);
  const seasonEdge = combinedEdge([f.winPct, f.homeAway, f.rpg, f.rapg, f.runDiff]);

  const recentTeamEdge = combinedEdge([
    f.recent7WinPct,
    f.recent15WinPct,
    f.recent30WinPct,
    f.recent7Runs,
    f.recent7Prevent,
    f.recentRunDiff,
    f.streakEdge
  ]);

  const fatigueEdge = combinedEdge([f.restEdge, f.bullpenFatigue]);

  return [
    { label: "Overall Season Edge", value: seasonEdge },
    { label: "Recent Team Form Edge", value: recentTeamEdge },
    { label: "Pitcher Season Edge", value: pitcherEdge },
    { label: "Pitcher Recent Form Edge", value: pitcherRecentEdge },
    { label: "Rest / Bullpen Edge", value: fatigueEdge },

    { label: "Win % Edge", value: f.winPct },
    { label: "Home/Away Edge", value: f.homeAway },
    { label: "Scoring Edge", value: f.rpg },
    { label: "Run Prevention Edge", value: f.rapg },
    { label: "Run Differential Edge", value: f.runDiff },

    { label: "Last 7 Form Edge", value: f.recent7WinPct },
    { label: "Last 15 Form Edge", value: f.recent15WinPct },
    { label: "Last 30 Form Edge", value: f.recent30WinPct },
    { label: "Recent Offense Edge", value: f.recent7Runs },
    { label: "Recent Defense Edge", value: f.recent7Prevent },
    { label: "Recent Run Diff Edge", value: f.recentRunDiff },
    { label: "Streak Edge", value: f.streakEdge },

    { label: "Starter ERA Edge", value: f.pitcherEra },
    { label: "Starter WHIP Edge", value: f.pitcherWhip },
    { label: "Starter K Edge", value: f.pitcherStrikeouts },
    { label: "Starter Recent ERA Edge", value: f.pitcherRecentEra },
    { label: "Starter Recent WHIP Edge", value: f.pitcherRecentWhip },
    { label: "Starter Recent K Edge", value: f.pitcherRecentK },

    { label: "Batting Split Edge", value: f.handednessSplit },
    { label: "Lineup Strength Edge", value: f.lineupStrength },

    { label: "Head-to-Head Edge", value: f.h2h },
    { label: "Rest-Day Edge", value: f.restEdge },
    { label: "Bullpen Fatigue Edge", value: f.bullpenFatigue }
  ];
}

function edgeSupportsPick(edge, game, pred) {
  const n = finiteNumber(edge.value);

  if (n === null) return "unknown";
  if (Math.abs(n) < 0.03) return "close";

  const winner = edgeWinner(n, game);
  const picked = pred?.predictedWinnerName || "";

  if (!picked || picked.includes("No Pick") || winner === "Close") return "close";
  if (winner === picked) return "support";

  return "against";
}

function strengthSummaryData(game, pred) {
  const edges = getPredictionEdges(game, pred);

  let support = 0;
  let against = 0;
  let close = 0;

  edges.forEach(edge => {
    const type = edgeSupportsPick(edge, game, pred);

    if (type === "support") support += 1;
    else if (type === "against") against += 1;
    else close += 1;
  });

  const score = support - against;
  const total = support + against + close;
  const fill = total
    ? Math.max(5, Math.min(100, Math.round(((score + total) / (total * 2)) * 100)))
    : 50;

  return { support, against, close, score, fill };
}

function basePickQualityData(game, pred) {
  if (!pred) {
    return {
      key: "risky",
      label: "Calculating",
      detail: "Waiting for enough automatic data.",
      className: "qualityRisky"
    };
  }

  if (pred.noPick === true || pred.qualified === false) {
    return {
      key: "risky",
      label: "No Pick",
      detail: pred.noPickReason || "Skipped because the matchup is too close or missing key data.",
      className: "qualityRisky"
    };
  }

  const confidence = Number(pred.confidence || 0);
  const summary = strengthSummaryData(game, pred);
  const f = pred.features || {};

  const recentPower = combinedEdge([
    f.recent7WinPct,
    f.recent15WinPct,
    f.recent7Runs,
    f.recent7Prevent,
    f.recentRunDiff
  ]);

  const pitcherPower = combinedEdge([
    f.pitcherEra,
    f.pitcherWhip,
    f.pitcherRecentEra,
    f.pitcherRecentWhip
  ]);

  const hasRecentSupport = Math.abs(Number(recentPower || 0)) >= 0.12;
  const hasPitcherSupport = Math.abs(Number(pitcherPower || 0)) >= 0.1;

  if (
    confidence >= 74 &&
    summary.score >= 8 &&
    summary.against <= 2 &&
    hasRecentSupport &&
    hasPitcherSupport
  ) {
    return {
      key: "elite",
      label: "🏆 Elite Edge",
      detail: "High confidence with season, recent form, and pitcher data lining up together.",
      className: "qualityElite"
    };
  }

  if (confidence >= 68 && summary.score >= 5 && summary.against <= 4) {
    return {
      key: "strong",
      label: "🔥 Strong Edge",
      detail: "Strong confidence with more advanced factors supporting than against.",
      className: "qualityStrong"
    };
  }

  if (confidence >= 60 && summary.score >= 3) {
    return {
      key: "good",
      label: "✅ Good Edge",
      detail: "Good calculated edge with several matchup factors supporting the pick.",
      className: "qualityGood"
    };
  }

  if (confidence >= 54 && summary.score >= 0) {
    return {
      key: "lean",
      label: "⚠️ Lean",
      detail: "Small edge. Watchable, but not a dominant matchup.",
      className: "qualityLean"
    };
  }

  return {
    key: "risky",
    label: "🧊 Risky / Toss Up",
    detail: "Low separation, mixed factors, or not enough strong support.",
    className: "qualityRisky"
  };
}

function buildQualityCalibration() {
  if (qualityCalibrationCache) return qualityCalibrationCache;

  const buckets = {
    elite: { correct: 0, total: 0 },
    strong: { correct: 0, total: 0 },
    good: { correct: 0, total: 0 },
    lean: { correct: 0, total: 0 },
    risky: { correct: 0, total: 0 }
  };

  const predictions = state?.predictions || [];

  predictions.forEach(pred => {
    const result = pred.result;

    if (!result) return;
    if (result.counted === false) return;
    if (pred.noPick === true || pred.qualified === false) return;

    const rawQuality = basePickQualityData(pred, pred);
    const key = buckets[rawQuality.key] ? rawQuality.key : "risky";

    buckets[key].total += 1;

    if (result.correct) buckets[key].correct += 1;
  });

  const counted = Object.values(buckets).reduce((sum, bucket) => sum + bucket.total, 0);

  qualityCalibrationCache = {
    buckets,
    counted,
    ready: counted >= 30
  };

  return qualityCalibrationCache;
}

function bucketAccuracy(bucket) {
  if (!bucket || !bucket.total) return null;
  return bucket.correct / bucket.total;
}

function calibratedQualityKey(baseKey) {
  const calibration = buildQualityCalibration();

  if (!calibration.ready) return baseKey;

  const bucket = calibration.buckets[baseKey];

  if (!bucket || bucket.total < 6) return baseKey;

  const accuracy = bucketAccuracy(bucket);
  let rank = qualityRank(baseKey);

  if (accuracy < 0.48) rank -= 2;
  else if (accuracy < 0.55) rank -= 1;
  else if (accuracy >= 0.64 && bucket.total >= 8) rank += 1;
  else if (accuracy >= 0.60 && rank <= 2 && bucket.total >= 8) rank += 1;

  return rankToQualityKey(rank);
}

function calibratedConfidence(game, pred) {
  if (!pred) return 0;

  const baseConfidence = Number(pred.confidence || 0);
  if (!Number.isFinite(baseConfidence)) return 0;

  if (pred.noPick === true || pred.qualified === false) {
    return Math.min(baseConfidence, 52);
  }

  const baseQuality = basePickQualityData(game || pred, pred);
  const calibration = buildQualityCalibration();

  if (!calibration.ready) return Math.round(baseConfidence);

  const bucket = calibration.buckets[baseQuality.key];

  if (!bucket || bucket.total < 6) return Math.round(baseConfidence);

  const accuracy = bucketAccuracy(bucket);
  let adjustment = 0;

  if (accuracy < 0.48) adjustment = -12;
  else if (accuracy < 0.52) adjustment = -8;
  else if (accuracy < 0.56) adjustment = -5;
  else if (accuracy >= 0.66) adjustment = 6;
  else if (accuracy >= 0.62) adjustment = 4;
  else if (accuracy >= 0.59) adjustment = 2;

  return Math.round(clamp(baseConfidence + adjustment, 51, 86));
}

function pickStrength(pred, game = pred) {
  if (!pred) {
    return {
      label: "Calculating",
      detail: "Waiting for data",
      className: "warn"
    };
  }

  if (pred.noPick === true || pred.qualified === false) {
    return {
      label: "No Pick",
      detail: pred.noPickReason || "Skipped by qualified-pick filter",
      className: "warn"
    };
  }

  const c = calibratedConfidence(game, pred);

  if (c >= 68) return { label: "🔥 Strong Edge", detail: "Highest calibrated automatic edge", className: "good" };
  if (c >= 60) return { label: "✅ Good Edge", detail: "Solid calibrated edge", className: "good" };
  if (c >= 54) return { label: "⚠️ Lean", detail: "Small calculated edge", className: "warn" };

  return {
    label: "🧊 Toss Up",
    detail: "Very close matchup",
    className: "warn"
  };
}

function strengthBadge(pred, game = pred) {
  if (!pred) return `<span class="edgeChip warn">Calculating strength</span>`;

  const strength = pickStrength(pred, game);

  return `<span class="edgeChip ${strength.className}" title="${escapeHtml(strength.detail)}">${escapeHtml(strength.label)}</span>`;
}

function pickQualityData(game, pred) {
  const base = basePickQualityData(game, pred);
  const calibration = buildQualityCalibration();

  if (!pred || pred.noPick === true || pred.qualified === false || !calibration.ready) return base;

  const bucket = calibration.buckets[base.key];

  if (!bucket || bucket.total < 6) return base;

  const adjustedKey = calibratedQualityKey(base.key);
  const meta = qualityMeta(adjustedKey);
  const accuracy = bucketAccuracy(bucket);
  const accuracyText = accuracy == null ? "--" : `${Math.round(accuracy * 100)}%`;
  const moved = qualityRank(adjustedKey) > qualityRank(base.key)
    ? "upgraded"
    : qualityRank(adjustedKey) < qualityRank(base.key)
      ? "downgraded"
      : "confirmed";

  if (adjustedKey === base.key) {
    return {
      ...base,
      detail: `${base.detail} Calibration: ${accuracyText} over ${bucket.total} counted games.`
    };
  }

  return {
    key: adjustedKey,
    label: meta.label,
    className: meta.className,
    detail: `Auto-${moved} from ${base.label} because this bucket is ${accuracyText} over ${bucket.total} counted games.`
  };
}

function openBestBoardGames() {
  return allVisibleGames()
    .filter(game => game.prediction)
    .filter(game => game.prediction.qualified !== false)
    .filter(game => game.prediction.noPick !== true)
    .filter(game => !game.prediction.locked)
    .filter(game => !isFinalStatus(game.status))
    .sort((a, b) => {
      const ac = calibratedConfidence(a, a.prediction);
      const bc = calibratedConfidence(b, b.prediction);

      if (bc !== ac) return bc - ac;

      return String(a.gameDate).localeCompare(String(b.gameDate));
    });
}

function passesQualityFilter(game) {
  if (qualityFilter === "all") return true;

  const quality = pickQualityData(game, game.prediction);
  const rank = qualityRank(quality.key);

  if (qualityFilter === "elite") return quality.key === "elite";
  if (qualityFilter === "strong") return rank >= qualityRank("strong");
  if (qualityFilter === "good") return rank >= qualityRank("good");
  if (qualityFilter === "lean") return rank >= qualityRank("lean");

  return true;
}

function sortedBestBoardGames(games) {
  const copy = games.slice();

  copy.sort((a, b) => {
    const aConf = calibratedConfidence(a, a.prediction);
    const bConf = calibratedConfidence(b, b.prediction);
    const aQuality = qualityRank(pickQualityData(a, a.prediction).key);
    const bQuality = qualityRank(pickQualityData(b, b.prediction).key);
    const aEdge = strengthSummaryData(a, a.prediction).score;
    const bEdge = strengthSummaryData(b, b.prediction).score;
    const aTime = new Date(a.gameDate || 0).getTime();
    const bTime = new Date(b.gameDate || 0).getTime();

    if (bestSort === "quality") {
      if (bQuality !== aQuality) return bQuality - aQuality;
      if (bConf !== aConf) return bConf - aConf;
      if (bEdge !== aEdge) return bEdge - aEdge;
      return aTime - bTime;
    }

    if (bestSort === "time") {
      if (aTime !== bTime) return aTime - bTime;
      if (bConf !== aConf) return bConf - aConf;
      return bEdge - aEdge;
    }

    if (bestSort === "edge") {
      if (bEdge !== aEdge) return bEdge - aEdge;
      if (bConf !== aConf) return bConf - aConf;
      if (bQuality !== aQuality) return bQuality - aQuality;
      return aTime - bTime;
    }

    if (bConf !== aConf) return bConf - aConf;
    if (bQuality !== aQuality) return bQuality - aQuality;
    if (bEdge !== aEdge) return bEdge - aEdge;
    return aTime - bTime;
  });

  return copy;
}

function qualifiedFilteredGamesBeforeVolume() {
  const min = bestFilterMinimum();

  return sortedBestBoardGames(
    openBestBoardGames()
      .filter(game => calibratedConfidence(game, game.prediction) >= min)
      .filter(game => passesQualityFilter(game))
  );
}

function filteredBestBoardGames() {
  const filtered = qualifiedFilteredGamesBeforeVolume();
  const limit = volumeLimit();

  if (!Number.isFinite(limit)) return filtered;

  return filtered.slice(0, limit);
}

function render() {
  if (!state) return;

  const allOpenBest = openBestBoardGames();
  const beforeVolume = qualifiedFilteredGamesBeforeVolume();
  const bestGames = filteredBestBoardGames();
  const topConfidence = allOpenBest[0]?.prediction
    ? calibratedConfidence(allOpenBest[0], allOpenBest[0].prediction)
    : null;

  setText("#todayCount", state.todayGames?.length || 0);
  setText("#tomorrowCount", state.tomorrowGames?.length || 0);
  setText("#predictionCount", state.predictions?.length || 0);
  setText("#trainedGames", state.model?.trainedGames || 0);
  setText("#topConfidence", topConfidence ? `${topConfidence}%` : "--");

  const accuracy = state.accuracy?.accuracy;
  const excluded = state.accuracy?.excluded || 0;
  setText("#accuracy", accuracy == null ? "--" : `${accuracy}%${excluded ? ` (${excluded} excluded)` : ""}`);

  setText("#todayDateLabel", `${prettyDate(state.date)} auto-calculated picks.`);
  setText("#tomorrowDateLabel", `${prettyDate(state.tomorrow)} early board.`);
  setText(
    "#bestFilterNote",
    `${volumeLabel()}. ${bestFilterLabel()} ${qualityFilterLabel()} ${sortFilterLabel()} Showing ${bestGames.length} of ${beforeVolume.length} filtered qualified picks. ${allOpenBest.length} total open qualified.`
  );

  renderDailySummary(bestGames, beforeVolume);
  renderRefreshStatus();
  renderDataHealth();
  renderQualityAccuracy();
  renderRollingAccuracy();
  renderSafetyMonitor();
  renderBestBoard(bestGames);
  renderGames("#todayGames", state.todayGames || [], "No today games loaded yet. Tap Sync.");
  renderGames("#tomorrowGames", state.tomorrowGames || [], "No tomorrow games loaded yet. Tap Sync.");
  renderMatchups();
  renderTeams();
  renderAutoSources();
  renderResults();
  renderModelReport();
  renderOptimizerReport();
  renderFactorReport();
  renderFactorTrustReport();
  renderModel();
}

function renderDailySummary(bestGames = filteredBestBoardGames(), beforeVolume = qualifiedFilteredGamesBeforeVolume()) {
  const todayGames = state?.todayGames || [];
  const todayPredictions = todayGames.filter(game => game.prediction);
  const qualifiedToday = todayPredictions.filter(game => {
    return game.prediction.qualified !== false &&
      game.prediction.noPick !== true &&
      !game.prediction.locked &&
      !isFinalStatus(game.status);
  });

  const bestToday = qualifiedToday
    .slice()
    .sort((a, b) => calibratedConfidence(b, b.prediction) - calibratedConfidence(a, a.prediction))[0];

  const fallbackBest = todayPredictions
    .filter(game => game.prediction.qualified !== false && game.prediction.noPick !== true)
    .slice()
    .sort((a, b) => calibratedConfidence(b, b.prediction) - calibratedConfidence(a, a.prediction))[0];

  const bestGame = bestToday || fallbackBest;

  const strongCount = qualifiedToday.filter(game => calibratedConfidence(game, game.prediction) >= 68).length;
  const goodCount = qualifiedToday.filter(game => calibratedConfidence(game, game.prediction) >= 60).length;
  const lockedCount = todayPredictions.filter(game => game.prediction.locked).length;
  const pendingCount = todayPredictions.filter(game => !game.prediction.result).length;

  const accuracy = state.accuracy?.accuracy;

  setText(
    "#summaryBestPick",
    bestGame
      ? `${bestGame.prediction.predictedWinnerName} ${calibratedConfidence(bestGame, bestGame.prediction)}%`
      : "No qualified pick yet"
  );

  setText("#summaryStrong", strongCount);
  setText("#summaryGood", goodCount);
  setText("#summaryVolume", volumeLabel());
  setText("#summaryDisplayed", `${bestGames.length}/${beforeVolume.length}`);
  setText("#summaryLocked", lockedCount);
  setText("#summaryPending", pendingCount);
  setText("#summaryAccuracy", accuracy == null ? "--" : `${accuracy}%`);
}

function renderRefreshStatus() {
  setText("#refreshLastSync", lastSyncAt ? formatClock(lastSyncAt) : "--");
  setText("#refreshNextSync", nextAutoSyncAt ? formatClock(nextAutoSyncAt) : "--");
  setText("#refreshFrontend", "15 min");
  setText("#refreshBackend", "Hourly");
  setText("#refreshStorage", state ? "Saved DB active" : "Checking");
  setText("#refreshStatus", currentRefreshStatus || "Ready");
}

function renderDataHealth() {
  const todayGames = state?.todayGames || [];
  const tomorrowGames = state?.tomorrowGames || [];
  const predictions = state?.predictions || [];
  const logs = state?.logs || [];

  const storedGames = todayGames.length + tomorrowGames.length;
  const predictionCount = predictions.length;
  const latestLog = logs[0];
  const latestBackendSync = latestLog?.at ? formatClock(latestLog.at) : lastSyncAt ? formatClock(lastSyncAt) : "--";

  const apiStatus = state ? "Connected" : "Checking";
  const dbStatus = state?.model ? "Working" : state ? "Loaded" : "Checking";

  setText("#healthApi", apiStatus);
  setText("#healthDb", dbStatus);
  setText("#healthGames", storedGames);
  setText("#healthPredictions", predictionCount);
  setText("#healthBackendSync", latestBackendSync);
  setText("#healthStoragePath", "/var/data");
}

function renderSafetyMonitor() {
  const cached = state || loadDashboardCache();
  const recoveryStatus = failedSyncs === 0
    ? "Ready"
    : cached
      ? "Using cached data"
      : "Waiting for retry";

  setText("#safeLastGood", lastGoodLoadAt ? formatClock(lastGoodLoadAt) : "--");
  setText("#safeLastError", lastErrorMessage || "None");
  setText("#safeCachedData", cached ? "Available" : "None");
  setText("#safeFailedSyncs", failedSyncs);
  setText("#safeRecoveryStatus", recoveryStatus);
  setText("#safeNextRetry", nextRetryAt ? formatClock(nextRetryAt) : "--");
}

function qualityAccuracyText(bucket) {
  if (!bucket.total) return "--";

  const accuracy = Math.round((bucket.correct / bucket.total) * 100);
  return `${accuracy}% (${bucket.correct}/${bucket.total})`;
}

function renderQualityAccuracy() {
  const predictions = state?.predictions || [];

  const buckets = {
    elite: { correct: 0, total: 0 },
    strong: { correct: 0, total: 0 },
    good: { correct: 0, total: 0 },
    lean: { correct: 0, total: 0 },
    risky: { correct: 0, total: 0 }
  };

  let countedGames = 0;

  predictions.forEach(pred => {
    const result = pred.result;

    if (!result) return;
    if (result.counted === false) return;
    if (pred.noPick === true || pred.qualified === false) return;

    const quality = pickQualityData(pred, pred);
    const key = buckets[quality.key] ? quality.key : "risky";

    buckets[key].total += 1;
    countedGames += 1;

    if (result.correct) buckets[key].correct += 1;
  });

  setText("#qualityEliteAccuracy", qualityAccuracyText(buckets.elite));
  setText("#qualityStrongAccuracy", qualityAccuracyText(buckets.strong));
  setText("#qualityGoodAccuracy", qualityAccuracyText(buckets.good));
  setText("#qualityLeanAccuracy", qualityAccuracyText(buckets.lean));
  setText("#qualityRiskyAccuracy", qualityAccuracyText(buckets.risky));
  setText("#qualityCountedGames", countedGames);
}

function rollingAccuracyText(item) {
  if (!item || item.accuracy == null) return "--";
  return `${item.accuracy}%`;
}

function rollingRecordText(item) {
  if (!item || !item.total) return "0/0";
  return `${item.correct}/${item.total}`;
}

function rollingTrendIcon(direction) {
  if (direction === "up") return "📈";
  if (direction === "down") return "📉";
  if (direction === "flat") return "➖";
  return "⏳";
}

function renderRollingAccuracy() {
  const rolling = state?.rollingAccuracy || {};
  const last7 = rolling.last7 || null;
  const last14 = rolling.last14 || null;
  const last30 = rolling.last30 || null;

  setText("#rolling7Accuracy", rollingAccuracyText(last7));
  setText("#rolling7Record", rollingRecordText(last7));

  setText("#rolling14Accuracy", rollingAccuracyText(last14));
  setText("#rolling14Record", rollingRecordText(last14));

  setText("#rolling30Accuracy", rollingAccuracyText(last30));
  setText("#rolling30Record", rollingRecordText(last30));

  const trendIcon = rollingTrendIcon(rolling.trendDirection);
  setText("#rollingTrend", `${trendIcon} ${rolling.trendStatus || "Learning"}`);
  setText("#rollingUpdated", rolling.updatedAt ? formatClock(rolling.updatedAt) : "--");
}

function average(values) {
  const usable = values
    .map(value => Number(value))
    .filter(value => Number.isFinite(value));

  if (!usable.length) return null;

  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
}

function qualityName(key) {
  if (key === "elite") return "🏆 Elite";
  if (key === "strong") return "🔥 Strong";
  if (key === "good") return "✅ Good";
  if (key === "lean") return "⚠️ Lean";
  return "🧊 Risky";
}

function renderModelReport() {
  const predictions = state?.predictions || [];

  const graded = predictions.filter(pred => pred.result);
  const excluded = graded.filter(pred => pred.result?.counted !== true);
  const counted = graded.filter(pred => pred.result?.counted === true);
  const correct = counted.filter(pred => pred.result?.correct);
  const wrong = counted.filter(pred => !pred.result?.correct);

  const avgCorrect = average(correct.map(pred => calibratedConfidence(pred, pred)));
  const avgWrong = average(wrong.map(pred => calibratedConfidence(pred, pred)));

  const buckets = {
    elite: { correct: 0, total: 0 },
    strong: { correct: 0, total: 0 },
    good: { correct: 0, total: 0 },
    lean: { correct: 0, total: 0 },
    risky: { correct: 0, total: 0 }
  };

  counted.forEach(pred => {
    const quality = pickQualityData(pred, pred);
    const key = buckets[quality.key] ? quality.key : "risky";

    buckets[key].total += 1;

    if (pred.result?.correct) buckets[key].correct += 1;
  });

  let bestQuality = "--";
  let bestRate = -1;

  Object.entries(buckets).forEach(([key, bucket]) => {
    if (!bucket.total) return;

    const rate = bucket.correct / bucket.total;

    if (rate > bestRate) {
      bestRate = rate;
      bestQuality = `${qualityName(key)} ${Math.round(rate * 100)}% (${bucket.correct}/${bucket.total})`;
    }
  });

  let modelStatus = "Collecting Data";

  if (counted.length >= 50) modelStatus = "Qualified Pick Calibration";
  if (counted.length >= 100) modelStatus = "Stronger Sample";
  if (counted.length >= 200) modelStatus = "Strong Sample";

  setText("#reportGradedGames", graded.length);
  setText("#reportCorrectPicks", correct.length);
  setText("#reportWrongPicks", wrong.length);
  setText("#reportExcludedGames", excluded.length);
  setText("#reportAvgConfidenceCorrect", avgCorrect == null ? "--" : `${Math.round(avgCorrect)}%`);
  setText("#reportAvgConfidenceWrong", avgWrong == null ? "--" : `${Math.round(avgWrong)}%`);
  setText("#reportBestQuality", bestQuality);
  setText("#reportModelStatus", modelStatus);
}

function renderOptimizerReport() {
  const report = state?.optimizerReport || null;
  const rules = state?.optimizedRules || null;

  if (!report) {
    setText("#optimizerStatus", "Waiting");
    setText("#optimizerTested", "--");
    setText("#optimizerQualified", "--");
    setText("#optimizerAccuracy", "--");
    setText("#optimizerCoverage", "--");
    setText("#optimizerConfidence", rules?.minConfidence ? `${rules.minConfidence}%` : "--");
    setText("#optimizerEdge", rules?.minEdgeScore ? `+${rules.minEdgeScore}` : "--");
    setText("#optimizerSupport", rules?.minSupport ?? "--");
    setText("#optimizerAgainst", rules?.maxAgainst ?? "--");
    setText("#optimizerPitcher", rules?.requirePitcherSignal ? "Yes" : "No");
    setText("#optimizerLineup", rules?.requireLineupSignal ? "Yes" : "No");
    return;
  }

  const activeRules = report.rule || rules || {};

  setText("#optimizerStatus", report.ready ? "Active" : "Learning");
  setText("#optimizerTested", report.testedPredictions ?? "--");
  setText("#optimizerQualified", report.qualified ?? "--");
  setText("#optimizerAccuracy", report.accuracy == null ? "--" : `${report.accuracy}%`);
  setText("#optimizerCoverage", report.coverage == null ? "--" : `${report.coverage}%`);
  setText("#optimizerConfidence", activeRules.minConfidence == null ? "--" : `${activeRules.minConfidence}%`);
  setText("#optimizerEdge", activeRules.minEdgeScore == null ? "--" : `+${activeRules.minEdgeScore}`);
  setText("#optimizerSupport", activeRules.minSupport ?? "--");
  setText("#optimizerAgainst", activeRules.maxAgainst ?? "--");
  setText("#optimizerPitcher", activeRules.requirePitcherSignal ? "Yes" : "No");
  setText("#optimizerLineup", activeRules.requireLineupSignal ? "Yes" : "No");
}

function factorStatus(item) {
  const acc = Number(item?.accuracyWhenSupported);

  if (!Number.isFinite(acc)) {
    return { label: "Learning", className: "warn" };
  }

  if (acc >= 60) return { label: "Strong Helper", className: "good" };
  if (acc >= 54) return { label: "Useful", className: "good" };
  if (acc >= 50) return { label: "Neutral", className: "warn" };

  return { label: "Hurting", className: "bad" };
}

function renderFactorReport() {
  const container = $("#factorAccuracyList");
  const report = state?.factorReport || {};

  if (!container) return;

  const entries = Object.entries(report)
    .filter(([, item]) => item && Number(item.supports || 0) > 0)
    .map(([key, item]) => ({
      key,
      item,
      supports: Number(item.supports || 0),
      correct: Number(item.correctWhenSupported || 0),
      wrong: Number(item.wrongWhenSupported || 0),
      accuracy: Number(item.accuracyWhenSupported)
    }))
    .sort((a, b) => {
      if (b.supports !== a.supports) return b.supports - a.supports;
      return Number(b.accuracy || 0) - Number(a.accuracy || 0);
    });

  const mature = entries.filter(entry => {
    return entry.supports >= 10 && Number.isFinite(entry.accuracy);
  });

  const best = mature
    .slice()
    .sort((a, b) => b.accuracy - a.accuracy)[0];

  const weakest = mature
    .slice()
    .sort((a, b) => a.accuracy - b.accuracy)[0];

  const strongSignals = mature.filter(entry => entry.accuracy >= 58).length;
  const weakSignals = mature.filter(entry => entry.accuracy < 50).length;
  const totalSupports = entries.reduce((sum, entry) => sum + entry.supports, 0);

  setText("#factorBestSignal", best ? `${factorLabel(best.key)} ${best.accuracy}%` : "--");
  setText("#factorWeakSignal", weakest ? `${factorLabel(weakest.key)} ${weakest.accuracy}%` : "--");
  setText("#factorTracked", entries.length);
  setText("#factorStrongSignals", strongSignals);
  setText("#factorWeakSignals", weakSignals);
  setText("#factorSample", totalSupports);

  if (!entries.length) {
    container.innerHTML = `
      <div class="noData">
        No factor report yet. Run reset/retrain, optimize rules, then sync after games finish.
      </div>
    `;
    return;
  }

  container.innerHTML = entries.map(entry => {
    const status = factorStatus(entry.item);
    const acc = Number.isFinite(entry.accuracy) ? entry.accuracy : 0;
    const width = Math.max(5, Math.min(100, acc));

    return `
      <div class="weightCard">
        <div class="weightName">${escapeHtml(factorLabel(entry.key))}</div>

        <div class="weightBar">
          <div class="weightFill" style="width:${width}%;"></div>
        </div>

        <div class="weightValue">
          ${Number.isFinite(entry.accuracy) ? `${escapeHtml(entry.accuracy)}%` : "--"}
        </div>

        <div class="edgeList">
          <span class="edgeChip ${escapeHtml(status.className)}">${escapeHtml(status.label)}</span>
          <span class="edgeChip good">${escapeHtml(entry.correct)} correct</span>
          <span class="edgeChip warn">${escapeHtml(entry.wrong)} wrong</span>
          <span class="edgeChip warn">${escapeHtml(entry.supports)} supports</span>
        </div>
      </div>
    `;
  }).join("");
}

function factorTrustStatusClass(status, muted) {
  const s = String(status || "").toLowerCase();

  if (muted || s.includes("muted")) return "bad";
  if (s.includes("reduced") || s.includes("cautious")) return "warn";
  if (s.includes("boosted") || s.includes("trusted")) return "good";
  if (s.includes("normal")) return "good";

  return "warn";
}

function renderFactorTrustReport() {
  const container = $("#factorTrustList");
  const trust = state?.factorTrust || {};
  const report = state?.factorTrustReport || null;
  const mutedFactors = state?.mutedFactors || [];

  if (!container) return;

  setText("#factorTrustStatus", report ? "Active" : "Learning");
  setText("#factorTrustMuted", report?.mutedCount ?? mutedFactors.length ?? "--");
  setText("#factorTrustReduced", report?.reducedCount ?? "--");
  setText("#factorTrustBoosted", report?.boostedCount ?? "--");
  setText("#factorTrustLearning", report?.learningCount ?? "--");
  setText("#factorTrustUpdated", report?.updatedAt ? formatClock(report.updatedAt) : "--");

  const entries = Object.entries(trust)
    .filter(([key]) => key !== "bias")
    .map(([key, item]) => {
      const trustScore = Number(item?.trust ?? 1);
      const supports = Number(item?.supports || 0);
      const accuracy = Number(item?.accuracy);
      const muted = Boolean(item?.muted);

      return {
        key,
        item,
        trustScore,
        supports,
        accuracy,
        muted,
        status: item?.status || "Learning",
        correct: Number(item?.correct || 0),
        wrong: Number(item?.wrong || 0)
      };
    })
    .sort((a, b) => {
      if (a.muted !== b.muted) return a.muted ? -1 : 1;
      if (b.trustScore !== a.trustScore) return b.trustScore - a.trustScore;
      return b.supports - a.supports;
    });

  if (!entries.length) {
    container.innerHTML = `
      <div class="noData">
        No factor trust data yet. Open /api/factor-trust, then Sync.
      </div>
    `;
    return;
  }

  container.innerHTML = entries.map(entry => {
    const statusClass = factorTrustStatusClass(entry.status, entry.muted);
    const trustPercent = Math.round(clamp(entry.trustScore, 0, 1.25) * 100);
    const barWidth = entry.muted
      ? 5
      : Math.max(5, Math.min(100, Math.round(clamp(entry.trustScore, 0, 1.25) * 80)));

    const accuracyText = Number.isFinite(entry.accuracy)
      ? `${entry.accuracy}%`
      : "--";

    return `
      <div class="weightCard">
        <div class="weightName">${escapeHtml(factorLabel(entry.key))}</div>

        <div class="weightBar">
          <div class="weightFill" style="width:${barWidth}%;"></div>
        </div>

        <div class="weightValue">
          Trust ${escapeHtml(trustPercent)}%
        </div>

        <div class="edgeList">
          <span class="edgeChip ${escapeHtml(statusClass)}">${escapeHtml(entry.status)}</span>
          ${entry.muted ? `<span class="edgeChip bad">Muted</span>` : ""}
          <span class="edgeChip warn">Accuracy ${escapeHtml(accuracyText)}</span>
          <span class="edgeChip warn">${escapeHtml(entry.supports)} supports</span>
          <span class="edgeChip good">${escapeHtml(entry.correct)} correct</span>
          <span class="edgeChip warn">${escapeHtml(entry.wrong)} wrong</span>
        </div>
      </div>
    `;
  }).join("");
}

function pitcherText(pitcher) {
  if (!pitcher) return "Starter: TBD";

  const parts = [];

  if (pitcher.name) parts.push(pitcher.name);
  if (pitcher.pitchHand) parts.push(pitcher.pitchHand);
  if (pitcher.era != null) parts.push(`ERA ${number(pitcher.era, 2)}`);
  if (pitcher.whip != null) parts.push(`WHIP ${number(pitcher.whip, 2)}`);
  if (pitcher.recentEra != null) parts.push(`Recent ERA ${number(pitcher.recentEra, 2)}`);

  return parts.length ? parts.join(" • ") : "Starter: TBD";
}

function predictedScore(game, pred) {
  if (!pred) return "--";
  return `${pred.projectedAwayScore ?? "--"} - ${pred.projectedHomeScore ?? "--"}`;
}

function actualOrProjectedScore(game, side, pred) {
  const actual = side === "away" ? game.awayScore : game.homeScore;
  const projected = side === "away" ? pred?.projectedAwayScore : pred?.projectedHomeScore;

  if (actual != null) return actual;
  if (projected != null) return projected;

  return "--";
}

function pickQualityCard(game, pred) {
  const quality = pickQualityData(game, pred);

  return `
    <div class="pickQuality ${escapeHtml(quality.className)}">
      <span>${pred?.noPick || pred?.qualified === false ? "Qualified Pick Filter" : "Calibrated Pick Quality"}</span>
      <strong>${escapeHtml(quality.label)}</strong>
      <small>${escapeHtml(quality.detail)}</small>
    </div>
  `;
}

function strengthSummary(game, pred) {
  if (!pred) return "";

  const summary = strengthSummaryData(game, pred);

  return `
    <div class="strengthSummary">
      <div class="strengthBox good">
        <span>Supports</span>
        <strong>${escapeHtml(summary.support)}</strong>
      </div>

      <div class="strengthBox bad">
        <span>Against</span>
        <strong>${escapeHtml(summary.against)}</strong>
      </div>

      <div class="strengthBox warn">
        <span>Close/Data</span>
        <strong>${escapeHtml(summary.close)}</strong>
      </div>

      <div class="strengthBox blue">
        <span>Edge Score</span>
        <strong>${escapeHtml(summary.score > 0 ? `+${summary.score}` : summary.score)}</strong>
      </div>

      <div class="strengthMiniBar">
        <div class="strengthMiniFill" style="width:${summary.fill}%;"></div>
      </div>
    </div>
  `;
}

function breakdownLine(label, value, game, pred) {
  const n = finiteNumber(value);

  if (n === null) {
    return `
      <div class="breakdownLine warn">
        <span>${escapeHtml(label)}</span>
        <strong>Not enough data</strong>
      </div>
    `;
  }

  const winner = edgeWinner(n, game);
  const picked = pred?.predictedWinnerName || "";
  let className = "warn";

  if (winner !== "Close" && picked && !picked.includes("No Pick") && winner === picked) {
    className = "good";
  } else if (winner !== "Close" && picked && !picked.includes("No Pick") && winner !== picked) {
    className = "bad";
  }

  return `
    <div class="breakdownLine ${className}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(winner)} ${escapeHtml(edgeValue(n))}</strong>
    </div>
  `;
}

function confidenceBreakdown(game, pred) {
  if (!pred) return "";

  const edges = getPredictionEdges(game, pred);
  const rawConfidence = Number(pred.confidence || 0);
  const calibrated = calibratedConfidence(game, pred);

  return `
    <details class="confidenceDetails">
      <summary>Confidence Breakdown</summary>

      <div class="confidenceBreakdown">
        <div class="breakdownLine ${pred.noPick || pred.qualified === false ? "warn" : "good"}">
          <span>Qualified Status</span>
          <strong>${escapeHtml(pred.noPick || pred.qualified === false ? (pred.noPickReason || "No Pick") : "Qualified Pick")}</strong>
        </div>

        <div class="breakdownLine good">
          <span>Raw Confidence</span>
          <strong>${escapeHtml(rawConfidence)}%</strong>
        </div>

        <div class="breakdownLine good">
          <span>Calibrated Confidence</span>
          <strong>${escapeHtml(calibrated)}%</strong>
        </div>

        ${edges.map(edge => breakdownLine(edge.label, edge.value, game, pred)).join("")}
      </div>
    </details>
  `;
}

function edgeClass(text) {
  const t = String(text || "").toLowerCase();

  if (
    t.includes("qualified") ||
    t.includes("better") ||
    t.includes("stronger") ||
    t.includes("scores more") ||
    t.includes("fewer") ||
    t.includes("edge") ||
    t.includes("form") ||
    t.includes("pitcher") ||
    t.includes("bullpen") ||
    t.includes("lineup")
  ) {
    return "good";
  }

  return "warn";
}

function lockBadge(pred) {
  if (!pred) return "";

  if (pred.noPick === true || pred.qualified === false) {
    return `<span class="edgeChip warn">Skipped</span>`;
  }

  if (pred.locked) {
    return `<span class="edgeChip warn">🔒 Locked</span>`;
  }

  return `<span class="edgeChip good">Open until game starts</span>`;
}

function renderBestBoard(games) {
  const container = $("#bestPicks");

  if (!container) return;

  if (!games.length) {
    container.innerHTML = `
      <div class="noData">
        No qualified picks match this filter right now. That is good if the board is messy — the app is skipping weak games.
      </div>
    `;
    return;
  }

  renderGames("#bestPicks", games, "No qualified best picks loaded yet.");
}

function renderGames(selector, games, emptyMessage = "No games loaded yet. Tap Sync.") {
  const container = $(selector);

  if (!container) return;

  if (!games.length) {
    container.innerHTML = `
      <div class="noData">
        ${escapeHtml(emptyMessage)}
      </div>
    `;
    return;
  }

  container.innerHTML = games.map((game, index) => {
    const pred = game.prediction;
    const pickId = String(pred?.predictedWinnerTeamId || "");
    const awayPick = pickId && pickId === String(game.awayTeamId);
    const homePick = pickId && pickId === String(game.homeTeamId);
    const confidence = Math.max(0, Math.min(100, calibratedConfidence(game, pred)));
    const rawConfidence = Number(pred?.confidence || 0);
    const reasons = pred?.reasons || ["Waiting for enough matchup data"];
    const isBestBoard = selector === "#bestPicks";

    let pillText = game.status || "Scheduled";

    if (isBestBoard) {
      pillText = `#${index + 1} ${volumeLabel()}`;
    } else if (pred?.noPick || pred?.qualified === false) {
      pillText = "No Pick";
    } else if (pred?.locked) {
      pillText = "🔒 Locked";
    }

    return `
      <article class="gameCard">
        <div class="gameInner">
          <div class="gameTop">
            <div class="gameMeta">
              <strong>${escapeHtml(shortTime(game.gameDate))}</strong><br>
              ${escapeHtml(game.venue || "MLB")}
            </div>

            <div class="statusPill">
              ${escapeHtml(pillText)}
            </div>
          </div>

          <div class="teamStack">
            <div class="teamRow ${awayPick ? "pick" : ""}">
              <div>
                <div class="teamName">${escapeHtml(game.awayTeamName)}</div>
                <span class="pitcher">${escapeHtml(pitcherText(game.awayPitcher))}</span>
              </div>
              <div class="scoreTag">${escapeHtml(actualOrProjectedScore(game, "away", pred))}</div>
            </div>

            <div class="teamRow ${homePick ? "pick" : ""}">
              <div>
                <div class="teamName">${escapeHtml(game.homeTeamName)}</div>
                <span class="pitcher">${escapeHtml(pitcherText(game.homePitcher))}</span>
              </div>
              <div class="scoreTag">${escapeHtml(actualOrProjectedScore(game, "home", pred))}</div>
            </div>
          </div>

          <div class="pickBox">
            <div class="pickLabel">${pred?.noPick || pred?.qualified === false ? "Qualified Filter" : "Auto Pick"}</div>
            <div class="pickName">${escapeHtml(pred?.predictedWinnerName || "Calculating")}</div>

            <div class="projectedScore">
              <span>Projected score</span>
              <strong>${escapeHtml(predictedScore(game, pred))}</strong>
            </div>

            <div class="confidenceWrap">
              <div class="confidenceLine">
                <span>Calibrated Confidence</span>
                <strong>${confidence || "--"}%</strong>
              </div>
              <div class="confidenceBar">
                <div class="confidenceFill" style="width:${confidence}%;"></div>
              </div>
              ${rawConfidence && rawConfidence !== confidence ? `
                <small class="mutedSmall">Raw model confidence: ${escapeHtml(rawConfidence)}%</small>
              ` : ""}
            </div>

            ${pickQualityCard(game, pred)}
            ${strengthSummary(game, pred)}

            <div class="edgeList">
              ${strengthBadge(pred, game)}
              ${lockBadge(pred)}
              ${reasons.slice(0, 8).map(reason => `
                <span class="edgeChip ${edgeClass(reason)}">${escapeHtml(reason)}</span>
              `).join("")}
            </div>

            ${confidenceBreakdown(game, pred)}
          </div>
        </div>
      </article>
    `;
  }).join("");
}

function renderMatchups() {
  const container = $("#matchupList");

  if (!container) return;

  const games = allVisibleGames();

  if (!games.length) {
    container.innerHTML = `<div class="noData">No matchup data loaded yet.</div>`;
    return;
  }

  container.innerHTML = games.map(game => {
    const pred = game.prediction;
    const f = pred?.features || {};

    return `
      <article class="breakdownCard">
        <h3>${escapeHtml(game.awayTeamName)} @ ${escapeHtml(game.homeTeamName)}</h3>
        <p>
          Auto result:
          <strong class="goldText">${escapeHtml(pred?.predictedWinnerName || "Calculating")}</strong>
          ${pred ? `with ${escapeHtml(calibratedConfidence(game, pred))}% calibrated confidence.` : ""}
        </p>

        <div class="edgeList">
          ${strengthBadge(pred, game)}
          ${lockBadge(pred)}
        </div>

        ${pickQualityCard(game, pred)}
        ${strengthSummary(game, pred)}

        <div class="factorGrid">
          <div class="factor">
            <span>Season Edge</span>
            <strong>${escapeHtml(edgeWinner(combinedEdge([f.winPct, f.homeAway, f.rpg, f.rapg, f.runDiff]), game))}</strong>
          </div>

          <div class="factor">
            <span>Recent Form</span>
            <strong>${escapeHtml(edgeWinner(combinedEdge([f.recent7WinPct, f.recent15WinPct, f.recent7Runs, f.recent7Prevent, f.recentRunDiff]), game))}</strong>
          </div>

          <div class="factor">
            <span>Pitcher Season</span>
            <strong>${escapeHtml(edgeWinner(combinedEdge([f.pitcherEra, f.pitcherWhip, f.pitcherStrikeouts]), game))}</strong>
          </div>

          <div class="factor">
            <span>Pitcher Recent</span>
            <strong>${escapeHtml(edgeWinner(combinedEdge([f.pitcherRecentEra, f.pitcherRecentWhip, f.pitcherRecentK]), game))}</strong>
          </div>

          <div class="factor">
            <span>Lineup / Splits</span>
            <strong>${escapeHtml(edgeWinner(combinedEdge([f.lineupStrength, f.handednessSplit]), game))}</strong>
          </div>

          <div class="factor">
            <span>Rest / Bullpen</span>
            <strong>${escapeHtml(edgeWinner(combinedEdge([f.restEdge, f.bullpenFatigue]), game))}</strong>
          </div>
        </div>

        <div class="edgeList">
          ${(pred?.reasons || []).map(reason => `
            <span class="edgeChip ${edgeClass(reason)}">${escapeHtml(reason)}</span>
          `).join("")}
        </div>

        ${confidenceBreakdown(game, pred)}
      </article>
    `;
  }).join("");
}

function renderTeams() {
  const tbody = $("#teamsTable tbody");

  if (!tbody) return;

  const teams = state?.teams || [];

  if (!teams.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="9">No team data loaded yet.</td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = teams.map(team => {
    const s = team.stats || {};

    return `
      <tr>
        <td><strong>${escapeHtml(team.name)}</strong></td>
        <td>${escapeHtml(`${s.wins ?? "--"}-${s.losses ?? "--"}`)}</td>
        <td>${escapeHtml(percent(s.winPct))}</td>
        <td>${escapeHtml(s.home || "--")}</td>
        <td>${escapeHtml(s.away || "--")}</td>
        <td>${escapeHtml(number(s.runsPerGame, 2))}</td>
        <td>${escapeHtml(number(s.runsAllowedPerGame, 2))}</td>
        <td>${escapeHtml(number(s.runDiffPerGame, 2))}</td>
        <td>${escapeHtml(s.last7 || s.last10 || s.streak || "--")}</td>
      </tr>
    `;
  }).join("");
}

function renderAutoSources() {
  const container = $("#autoSourceList");

  if (!container) return;

  const games = allVisibleGames();

  if (!games.length) {
    container.innerHTML = `<div class="noData">Auto source engine will fill after Sync.</div>`;
    return;
  }

  container.innerHTML = games.map(game => {
    const pred = game.prediction;
    const reasons = pred?.reasons || [];
    const refs = pred?.sourceReferences || [];

    return `
      <article class="autoCard">
        <h3>${escapeHtml(game.awayTeamName)} @ ${escapeHtml(game.homeTeamName)}</h3>
        <p>
          Result:
          <strong class="goldText">${escapeHtml(pred?.predictedWinnerName || "Calculating")}</strong>
          • Projected:
          <strong>${escapeHtml(predictedScore(game, pred))}</strong>
        </p>

        <div class="edgeList">
          ${strengthBadge(pred, game)}
          ${lockBadge(pred)}
          ${reasons.length ? reasons.map(reason => `
            <span class="edgeChip ${edgeClass(reason)}">${escapeHtml(reason)}</span>
          `).join("") : `<span class="edgeChip warn">Waiting for calculated edges</span>`}
        </div>

        ${pickQualityCard(game, pred)}
        ${strengthSummary(game, pred)}

        ${refs.length ? `
          <div class="factorGrid">
            ${refs.slice(0, 12).map(ref => `
              <div class="factor">
                <span>${escapeHtml(ref.title || ref.dataType || "Auto Factor")}</span>
                <strong>${escapeHtml(ref.edgeTeamName || "Close")}</strong>
              </div>
            `).join("")}
          </div>
        ` : ""}

        ${confidenceBreakdown(game, pred)}

        <p>
          Auto inputs used: schedule, team record, home/away split, scoring trends,
          run prevention, run differential, probable pitchers, starter recent form,
          pitcher handedness, batting splits, announced lineup strength when available,
          recent team form, head-to-head history, rest days, bullpen fatigue estimate,
          weather/park estimate, previous results, calibration, and stored model learning.
        </p>
      </article>
    `;
  }).join("");
}

function renderResults() {
  const container = $("#resultsList");

  if (!container) return;

  const predictions = (state?.predictions || [])
    .slice()
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, 50);

  if (!predictions.length) {
    container.innerHTML = `<div class="noData">No predictions stored yet. Sync will create predictions automatically.</div>`;
    return;
  }

  container.innerHTML = predictions.map(pred => {
    const result = pred.result;
    const counted = result?.counted === true;
    const confidence = calibratedConfidence(pred, pred);

    const badge = result
      ? `<span class="resultBadge ${result.correct ? "correct" : "wrong"}">
          ${result.correct ? "Correct" : "Wrong"}
        </span>`
      : `<span class="resultBadge">Pending</span>`;

    const countedBadge = result
      ? `<span class="edgeChip ${counted ? "good" : "warn"}">
          ${counted ? "Qualified / counted" : "No Pick / excluded"}
        </span>`
      : "";

    return `
      <article class="resultCard">
        <h3>${escapeHtml(pred.awayTeamName)} @ ${escapeHtml(pred.homeTeamName)}</h3>
        <p>
          Date: ${escapeHtml(prettyDate(pred.date))}
          • Result: <strong class="goldText">${escapeHtml(pred.predictedWinnerName)}</strong>
          • Calibrated Confidence: <strong>${escapeHtml(confidence)}%</strong>
        </p>

        <p>
          Projected score:
          <strong>${escapeHtml(pred.projectedAwayScore)} - ${escapeHtml(pred.projectedHomeScore)}</strong>
        </p>

        ${result ? `
          <p>
            Final score:
            <strong>${escapeHtml(result.awayScore)} - ${escapeHtml(result.homeScore)}</strong>
            • Winner:
            <strong>${escapeHtml(result.actualWinnerName)}</strong>
          </p>
        ` : ""}

        <div class="edgeList">
          ${strengthBadge(pred, pred)}
          ${lockBadge(pred)}
          ${countedBadge}
        </div>

        ${pred.qualified ? badge : `<span class="resultBadge">No Pick</span>`}
      </article>
    `;
  }).join("");
}

function renderModel() {
  const weightsContainer = $("#modelWeights");
  const logsContainer = $("#logList");

  if (weightsContainer) {
    const weights = state?.model?.weights || {};
    const entries = Object.entries(weights);

    if (!entries.length) {
      weightsContainer.innerHTML = `<div class="noData">No model weights loaded yet.</div>`;
    } else {
      weightsContainer.innerHTML = entries.map(([name, value]) => {
        const n = Number(value || 0);
        const width = Math.max(5, Math.min(100, Math.abs(n) * 35));

        return `
          <div class="weightCard">
            <div class="weightName">${escapeHtml(name)}</div>
            <div class="weightBar">
              <div class="weightFill" style="width:${width}%;"></div>
            </div>
            <div class="weightValue">${escapeHtml(number(n, 3))}</div>
          </div>
        `;
      }).join("");
    }
  }

  if (logsContainer) {
    const logs = state?.logs || [];

    if (!logs.length) {
      logsContainer.innerHTML = `<div class="noData">No update logs yet.</div>`;
    } else {
      logsContainer.innerHTML = logs.map(log => `
        <div class="logItem">
          <strong>${escapeHtml(new Date(log.at).toLocaleString())}</strong><br>
          ${escapeHtml(log.message)}
        </div>
      `).join("");
    }
  }
}

const syncBtn = $("#syncBtn");

if (syncBtn) {
  syncBtn.addEventListener("click", () => load(true));
}

setupTabs();
setupBestFilters();
setupInstallButton();
renderRefreshStatus();
renderSafetyMonitor();

load(true);

setInterval(() => {
  load(true);
}, FRONTEND_SYNC_MS);
