let state = null;

const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));

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

function shortTime(dateValue) {
  if (!dateValue) return "--";

  try {
    return new Date(dateValue).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit"
    });
  } catch {
    return "--";
  }
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

function setStatus(text, mode = "ready") {
  const statusText = $("#statusText");
  const dot = $("#statusDot");

  if (statusText) statusText.textContent = text;

  if (dot) {
    dot.classList.remove("working", "error");

    if (mode === "working") dot.classList.add("working");
    if (mode === "error") dot.classList.add("error");
  }
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

    render();

    const now = new Date().toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit"
    });

    const lastSync = $("#lastSync");
    if (lastSync) lastSync.textContent = now;

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

function render() {
  if (!state) return;

  $("#todayCount").textContent = state.todayGames?.length || 0;
  $("#tomorrowCount").textContent = state.tomorrowGames?.length || 0;
  $("#predictionCount").textContent = state.predictions?.length || 0;
  $("#trainedGames").textContent = state.model?.trainedGames || 0;

  const accuracy = state.accuracy?.accuracy;
  $("#accuracy").textContent = accuracy == null ? "--" : `${accuracy}%`;

  $("#todayDateLabel").textContent = `${prettyDate(state.date)} auto-calculated picks.`;
  $("#tomorrowDateLabel").textContent = `${prettyDate(state.tomorrow)} early board.`;

  renderGames("#todayGames", state.todayGames || []);
  renderGames("#tomorrowGames", state.tomorrowGames || []);
  renderMatchups();
  renderTeams();
  renderAutoSources();
  renderResults();
  renderModel();
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

function renderGames(selector, games) {
  const container = $(selector);

  if (!container) return;

  if (!games.length) {
    container.innerHTML = `
      <div class="noData">
        No games loaded yet. The app auto-syncs when opened, or you can tap Sync.
      </div>
    `;
    return;
  }

  container.innerHTML = games.map(game => {
    const pred = game.prediction;
    const pickId = String(pred?.predictedWinnerTeamId || "");
    const awayPick = pickId === String(game.awayTeamId);
    const homePick = pickId === String(game.homeTeamId);
    const confidence = Math.max(0, Math.min(100, Number(pred?.confidence || 0)));

    const reasons = pred?.reasons || ["Waiting for enough matchup data"];

    return `
      <article class="gameCard">
        <div class="gameInner">
          <div class="gameTop">
            <div class="gameMeta">
              <strong>${escapeHtml(shortTime(game.gameDate))}</strong><br>
              ${escapeHtml(game.venue || "MLB")}
            </div>
            <div class="statusPill">${escapeHtml(game.status || "Scheduled")}</div>
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

function allVisibleGames() {
  return [
    ...(state?.todayGames || []),
    ...(state?.tomorrowGames || [])
  ];
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
            <strong>${escapeHtml(edgeWinner(f.pitcherEra, game))}</strong>
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
          ${reasons.length ? reasons.map(reason => `
            <span class="edgeChip good">${escapeHtml(reason)}</span>
          `).join("") : `<span class="edgeChip warn">Waiting for calculated edges</span>`}
        </div>

        <p>
          Auto inputs used: schedule, team record, home/away split, runs scored,
          runs allowed, run differential, probable pitchers, previous results,
          and stored model learning.
        </p>

        ${refs.length ? `
          <p>
            Stored source boosts:
            ${refs.map(r => escapeHtml(r.title || r.sourceName || "Stored source")).join(", ")}
          </p>
        ` : ""}
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
    .slice(0, 40);

  if (!predictions.length) {
    container.innerHTML = `<div class="noData">No predictions stored yet. Sync will create predictions automatically.</div>`;
    return;
  }

  container.innerHTML = predictions.map(pred => {
    const result = pred.result;
    const badge = result
      ? `<span class="resultBadge ${result.correct ? "correct" : "wrong"}">
          ${result.correct ? "Correct" : "Wrong"}
        </span>`
      : `<span class="resultBadge">Pending</span>`;

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

// Automatic app behavior:
// Opens, syncs MLB data, builds predictions, and refreshes while the app is open.
load(true);

setInterval(() => {
  load(true);
}, 15 * 60 * 1000);
