let state = null;
let bestFilter = "all";
let lastSyncAt = null;
let nextAutoSyncAt = null;
let currentRefreshStatus = "Ready";

const FRONTEND_SYNC_MS = 15 * 60 * 1000;

const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));

function setText(selector, value) {
  const el = $(selector);
  if (el) el.textContent = value;
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
  return s.includes("final") || s.includes("completed");
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
}

function pickStrength(confidence) {
  const c = Number(confidence || 0);

  if (c >= 68) {
    return {
      label: "🔥 Strong Edge",
      detail: "Highest confidence automatic edge",
      className: "good"
    };
  }

  if (c >= 60) {
    return {
      label: "✅ Good Edge",
      detail: "Solid calculated edge",
      className: "good"
    };
  }

  if (c >= 54) {
    return {
      label: "⚠️ Lean",
      detail: "Small calculated edge",
      className: "warn"
    };
  }

  return {
    label: "🧊 Toss Up",
    detail: "Very close matchup",
    className: "warn"
  };
}

function strengthBadge(pred) {
  if (!pred) return `<span class="edgeChip warn">Calculating strength</span>`;

  const strength = pickStrength(pred.confidence);

  return `<span class="edgeChip ${strength.className}" title="${escapeHtml(strength.detail)}">${escapeHtml(strength.label)}</span>`;
}

function bestFilterMinimum() {
  if (bestFilter === "strong") return 68;
  if (bestFilter === "good") return 60;
  if (bestFilter === "lean") return 54;
  return 0;
}

function bestFilterLabel() {
  if (bestFilter === "strong") return "Showing 🔥 Strong Edge picks only, 68%+ confidence.";
  if (bestFilter === "good") return "Showing ✅ Good Edge+ picks, 60%+ confidence.";
  if (bestFilter === "lean") return "Showing ⚠️ Lean+ picks, 54%+ confidence.";
  return "Showing all open picks before game start.";
}

async function getJson(url) {
  const res = await fetch(url, {
    cache: "no-store"
  });

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

    lastSyncAt = new Date();
    nextAutoSyncAt = new Date(Date.now() + FRONTEND_SYNC_MS);

    render();

    setStatus("Live", "ready");
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Error", "error");
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
  $$(".filterBtn").forEach(button => {
    button.addEventListener("click", () => {
      bestFilter = button.dataset.filter || "all";

      $$(".filterBtn").forEach(b => b.classList.remove("active"));
      button.classList.add("active");

      render();
    });
  });
}

function allVisibleGames() {
  return [
    ...(state?.todayGames || []),
    ...(state?.tomorrowGames || [])
  ];
}

function openBestBoardGames() {
  return allVisibleGames()
    .filter(game => game.prediction)
    .filter(game => !game.prediction.locked)
    .filter(game => !isFinalStatus(game.status))
    .sort((a, b) => {
      const ac = Number(a.prediction?.confidence || 0);
      const bc = Number(b.prediction?.confidence || 0);

      if (bc !== ac) return bc - ac;

      return String(a.gameDate).localeCompare(String(b.gameDate));
    });
}

function filteredBestBoardGames() {
  const min = bestFilterMinimum();

  return openBestBoardGames().filter(game => {
    return Number(game.prediction?.confidence || 0) >= min;
  });
}

function render() {
  if (!state) return;

  const allOpenBest = openBestBoardGames();
  const bestGames = filteredBestBoardGames();
  const topConfidence = allOpenBest[0]?.prediction?.confidence;

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
  setText("#bestFilterNote", `${bestFilterLabel()} Showing ${bestGames.length} of ${allOpenBest.length} open picks.`);

  renderDailySummary();
  renderRefreshStatus();
  renderBestBoard(bestGames);
  renderGames("#todayGames", state.todayGames || [], "No today games loaded yet. Tap Sync.");
  renderGames("#tomorrowGames", state.tomorrowGames || [], "No tomorrow games loaded yet. Tap Sync.");
  renderMatchups();
  renderTeams();
  renderAutoSources();
  renderResults();
  renderModel();
}

function renderDailySummary() {
  const todayGames = state?.todayGames || [];
  const todayPredictions = todayGames.filter(game => game.prediction);
  const openToday = todayPredictions.filter(game => {
    return !game.prediction.locked && !isFinalStatus(game.status);
  });

  const bestToday = openToday
    .slice()
    .sort((a, b) => Number(b.prediction.confidence || 0) - Number(a.prediction.confidence || 0))[0];

  const fallbackBest = todayPredictions
    .slice()
    .sort((a, b) => Number(b.prediction.confidence || 0) - Number(a.prediction.confidence || 0))[0];

  const bestGame = bestToday || fallbackBest;

  const strongCount = openToday.filter(game => Number(game.prediction.confidence || 0) >= 68).length;
  const goodCount = openToday.filter(game => Number(game.prediction.confidence || 0) >= 60).length;
  const lockedCount = todayPredictions.filter(game => game.prediction.locked).length;
  const pendingCount = todayPredictions.filter(game => !game.prediction.result).length;

  const accuracy = state.accuracy?.accuracy;

  setText(
    "#summaryBestPick",
    bestGame
      ? `${bestGame.prediction.predictedWinnerName} ${bestGame.prediction.confidence}%`
      : "--"
  );

  setText("#summaryStrong", strongCount);
  setText("#summaryGood", goodCount);
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

function pitcherText(pitcher) {
  if (!pitcher) return "Starter: TBD";

  const parts = [];

  if (pitcher.name) parts.push(pitcher.name);
  if (pitcher.era != null) parts.push(`ERA ${number(pitcher.era, 2)}`);
  if (pitcher.whip != null) parts.push(`WHIP ${number(pitcher.whip, 2)}`);

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

function edgeClass(text) {
  const t = String(text || "").toLowerCase();

  if (
    t.includes("better") ||
    t.includes("stronger") ||
    t.includes("scores more") ||
    t.includes("fewer") ||
    t.includes("edge")
  ) {
    return "good";
  }

  return "warn";
}

function lockBadge(pred) {
  if (!pred) return "";

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
        No picks match this filter right now. Try All, or sync again after more games load.
      </div>
    `;
    return;
  }

  renderGames("#bestPicks", games.slice(0, 8), "No best picks loaded yet.");
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
    const awayPick = pickId === String(game.awayTeamId);
    const homePick = pickId === String(game.homeTeamId);
    const confidence = Math.max(0, Math.min(100, Number(pred?.confidence || 0)));
    const reasons = pred?.reasons || ["Waiting for enough matchup data"];
    const isBestBoard = selector === "#bestPicks";

    let pillText = game.status || "Scheduled";

    if (isBestBoard) {
      pillText = `#${index + 1} Best`;
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
            <div class="pickLabel">Auto Pick</div>
            <div class="pickName">${escapeHtml(pred?.predictedWinnerName || "Calculating")}</div>

            <div class="projectedScore">
              <span>Projected score</span>
              <strong>${escapeHtml(predictedScore(game, pred))}</strong>
            </div>

            <div class="confidenceWrap">
              <div class="confidenceLine">
                <span>Confidence</span>
                <strong>${confidence || "--"}%</strong>
              </div>
              <div class="confidenceBar">
                <div class="confidenceFill" style="width:${confidence}%;"></div>
              </div>
            </div>

            <div class="edgeList">
              ${strengthBadge(pred)}
              ${lockBadge(pred)}
              ${reasons.slice(0, 5).map(reason => `
                <span class="edgeChip ${edgeClass(reason)}">${escapeHtml(reason)}</span>
              `).join("")}
            </div>
          </div>
        </div>
      </article>
    `;
  }).join("");
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
          Auto pick:
          <strong class="goldText">${escapeHtml(pred?.predictedWinnerName || "Calculating")}</strong>
          ${pred ? `with ${escapeHtml(pred.confidence)}% confidence.` : ""}
        </p>

        <div class="edgeList">
          ${strengthBadge(pred)}
          ${lockBadge(pred)}
        </div>

        <div class="factorGrid">
          <div class="factor">
            <span>Win % Edge</span>
            <strong>${escapeHtml(edgeWinner(f.winPct, game))}</strong>
          </div>

          <div class="factor">
            <span>Home/Away Edge</span>
            <strong>${escapeHtml(edgeWinner(f.homeAway, game))}</strong>
          </div>

          <div class="factor">
            <span>Scoring Edge</span>
            <strong>${escapeHtml(edgeWinner(f.rpg, game))}</strong>
          </div>

          <div class="factor">
            <span>Run Prevention</span>
            <strong>${escapeHtml(edgeWinner(f.rapg, game))}</strong>
          </div>

          <div class="factor">
            <span>Run Diff</span>
            <strong>${escapeHtml(edgeValue(f.runDiff))}</strong>
          </div>

          <div class="factor">
            <span>Pitcher Edge</span>
            <strong>${escapeHtml(edgeWinner(Number(f.pitcherEra || 0) + Number(f.pitcherWhip || 0), game))}</strong>
          </div>
        </div>

        <div class="edgeList">
          ${(pred?.reasons || []).map(reason => `
            <span class="edgeChip ${edgeClass(reason)}">${escapeHtml(reason)}</span>
          `).join("")}
        </div>
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
        <td>${escapeHtml(s.last10 || s.streak || "--")}</td>
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
          Pick:
          <strong class="goldText">${escapeHtml(pred?.predictedWinnerName || "Calculating")}</strong>
          • Projected:
          <strong>${escapeHtml(predictedScore(game, pred))}</strong>
        </p>

        <div class="edgeList">
          ${strengthBadge(pred)}
          ${lockBadge(pred)}
          ${reasons.length ? reasons.map(reason => `
            <span class="edgeChip good">${escapeHtml(reason)}</span>
          `).join("") : `<span class="edgeChip warn">Waiting for calculated edges</span>`}
        </div>

        ${refs.length ? `
          <div class="factorGrid">
            ${refs.slice(0, 6).map(ref => `
              <div class="factor">
                <span>${escapeHtml(ref.title || ref.dataType || "Auto Factor")}</span>
                <strong>${escapeHtml(ref.edgeTeamName || "Close")}</strong>
              </div>
            `).join("")}
          </div>
        ` : ""}

        <p>
          Auto inputs used: schedule, team record, home/away split, runs scored,
          runs allowed, run differential, probable pitchers, recent form,
          head-to-head history, previous results, and stored model learning.
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
    const counted = result?.counted !== false;

    const badge = result
      ? `<span class="resultBadge ${result.correct ? "correct" : "wrong"}">
          ${result.correct ? "Correct" : "Wrong"}
        </span>`
      : `<span class="resultBadge">Pending</span>`;

    const countedBadge = result
      ? `<span class="edgeChip ${counted ? "good" : "warn"}">
          ${counted ? "Counted in accuracy" : "Late-created / excluded"}
        </span>`
      : "";

    return `
      <article class="resultCard">
        <h3>${escapeHtml(pred.awayTeamName)} @ ${escapeHtml(pred.homeTeamName)}</h3>
        <p>
          Date: ${escapeHtml(prettyDate(pred.date))}
          • Pick: <strong class="goldText">${escapeHtml(pred.predictedWinnerName)}</strong>
          • Confidence: <strong>${escapeHtml(pred.confidence)}%</strong>
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
          ${strengthBadge(pred)}
          ${lockBadge(pred)}
          ${countedBadge}
        </div>

        ${badge}
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
renderRefreshStatus();

load(true);

setInterval(() => {
  load(true);
}, FRONTEND_SYNC_MS);
