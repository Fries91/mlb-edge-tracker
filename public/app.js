let state = null;
let selectedTab = "today";

const $ = (id) => document.getElementById(id);
const fmtPct = n => Number.isFinite(Number(n)) ? Number(n).toFixed(3).replace(/^0/,"") : "--";
const fmt2 = n => Number.isFinite(Number(n)) ? Number(n).toFixed(2) : "--";

function localDateLabel(dateStr) {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function gameTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit"
  });
}

function setStatus(msg) {
  $("status").textContent = msg || "";
}

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json();

  if (!res.ok || data.ok === false) {
    throw new Error(data.error || "Request failed");
  }

  return data;
}

async function load(sync = false) {
  try {
    setStatus(sync ? "Syncing MLB data, pitchers, games, and predictions..." : "Loading...");

    const data = sync ? await api("/api/sync") : await api("/api/dashboard");
    state = data.dashboard || data;

    render();
    setStatus(sync ? "Sync complete. Predictions recalculated." : "");
  } catch (e) {
    console.error(e);
    setStatus("Error: " + e.message);
  }
}

function render() {
  if (!state) return;

  $("todayLabel").textContent = localDateLabel(state.date);
  $("todayCount").textContent = state.todayGames.length;
  $("gradedCount").textContent = state.accuracy.totalGraded || 0;
  $("accuracy").textContent = state.accuracy.accuracy == null ? "--" : state.accuracy.accuracy + "%";
  $("trainedGames").textContent = state.model.trainedGames || 0;

  renderGames("todayGames", state.todayGames);
  renderGames("tomorrowGames", state.tomorrowGames);
  renderTeams();
  renderInjuryFormTeams();
  renderResourceFormTeams();
  renderInjuries();
  renderSources();
  renderReferences();
  renderHistory();
  renderModel();
}

function pitcherLine(p) {
  if (!p) return "TBD";

  const bits = [p.name || "TBD"];

  if (p.era != null) bits.push(`${p.era} ERA`);
  if (p.whip != null) bits.push(`${p.whip} WHIP`);
  if (p.strikeOuts != null) bits.push(`${p.strikeOuts} SO`);

  return bits.join(" • ");
}

function renderGames(containerId, games) {
  const box = $(containerId);

  if (!games.length) {
    box.innerHTML = `<div class="gameCard">No games stored yet. Tap <b>Sync</b>.</div>`;
    return;
  }

  box.innerHTML = games.map(g => {
    const p = g.prediction;
    const result = p?.result;

    const resultBadge = result
      ? `<span class="badge ${result.correct ? "good" : "bad"}">${result.correct ? "RIGHT" : "WRONG"}</span>`
      : `<span class="badge">${g.status}</span>`;

    const pick = p ? p.predictedWinnerName : "Not enough data";
    const conf = p ? `${p.confidence}%` : "--";
    const proj = p ? `${p.projectedAwayScore}-${p.projectedHomeScore}` : "--";

    const actual = result
      ? `${result.awayScore}-${result.homeScore}`
      : (g.awayScore != null && g.homeScore != null ? `${g.awayScore}-${g.homeScore}` : "Pending");

    const reasons = p?.reasons?.length
      ? `<div class="reasons"><b>Why:</b><ul>${p.reasons.map(r => `<li>${r}</li>`).join("")}</ul></div>`
      : "";

    const refs = p?.sourceReferences?.length
      ? `<div class="sourceRefs"><b>References used:</b><ul>${p.sourceReferences.slice(0, 4).map(r => `<li>${tierName(r.tier)}: ${r.title || r.sourceName} (${r.edgeTeamName || "team"} impact ${r.impactScore}, confidence ${r.confidence}%)</li>`).join("")}</ul></div>`
      : "";

    return `
      <article class="gameCard">
        <div class="gameTop">
          <div>
            <div class="matchup">${g.awayTeamName} @ ${g.homeTeamName}</div>
            <div class="time">${gameTime(g.gameDate)} ${g.venue ? "• " + g.venue : ""}</div>
          </div>
          ${resultBadge}
        </div>

        <div class="prediction">
          <div>
            <span>Pick</span>
            <strong>${pick}</strong>
          </div>

          <div>
            <span>Confidence</span>
            <strong>${conf}</strong>
          </div>

          <div>
            <span>Projected / Actual</span>
            <strong>${proj} / ${actual}</strong>
          </div>
        </div>

        <div class="pitchers">
          <b>Starters:</b><br>
          ${g.awayTeamName}: ${pitcherLine(g.awayPitcher)}<br>
          ${g.homeTeamName}: ${pitcherLine(g.homePitcher)}
        </div>

        ${reasons}
        ${refs}
      </article>
    `;
  }).join("");
}

function renderTeams() {
  const tbody = $("teamsTable").querySelector("tbody");

  tbody.innerHTML = state.teams.map(t => {
    const s = t.stats;

    return `
      <tr>
        <td>
          <strong>${t.name}</strong><br>
          <small>${t.league} • ${t.division}</small>
        </td>
        <td>${s.wins}-${s.losses}</td>
        <td>${fmtPct(s.winPct)}</td>
        <td>${s.home}<br><small>${fmtPct(s.homePct)}</small></td>
        <td>${s.away}<br><small>${fmtPct(s.awayPct)}</small></td>
        <td>${fmt2(s.runsPerGame)}</td>
        <td>${fmt2(s.runsAllowedPerGame)}</td>
        <td>${fmt2(s.runDiffPerGame)}</td>
        <td>${s.streak || "--"}</td>
      </tr>
    `;
  }).join("");
}

function renderInjuryFormTeams() {
  const select = $("injTeam");
  const current = select.value;

  select.innerHTML = state.teams
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(t => `<option value="${t.id}">${t.name}</option>`)
    .join("");

  if (current) select.value = current;
}

function tierName(tier) {
  const t = String(tier || "manual").toLowerCase();

  if (t === "official") return "Official";
  if (t === "trusted" || t === "reliable") return "Trusted";
  if (t === "outside") return "Outside";

  return "Manual";
}

function tierClass(tier) {
  const t = String(tier || "manual").toLowerCase();

  if (t === "official") return "tier-official";
  if (t === "trusted" || t === "reliable") return "tier-trusted";
  if (t === "outside") return "tier-outside";

  return "tier-manual";
}

function renderResourceFormTeams() {
  const teamSelect = $("resTeam");
  const oppSelect = $("resOpponent");

  if (!teamSelect || !oppSelect || !state) return;

  const teams = [...state.teams].sort((a, b) => a.name.localeCompare(b.name));
  const currentTeam = teamSelect.value;
  const currentOpp = oppSelect.value;

  teamSelect.innerHTML = teams
    .map(t => `<option value="${t.id}">${t.name}</option>`)
    .join("");

  oppSelect.innerHTML =
    `<option value="">Any opponent</option>` +
    teams.map(t => `<option value="${t.id}">${t.name}</option>`).join("");

  if (currentTeam) teamSelect.value = currentTeam;
  if (currentOpp) oppSelect.value = currentOpp;
  if (!$("resDate").value) $("resDate").value = state.date;
}

function renderSources() {
  const box = $("sourceRegistry");

  if (!box) return;

  const sources = [...(state.sourceRegistry || [])]
    .sort((a, b) => Number(a.priority || 9) - Number(b.priority || 9));

  box.innerHTML = sources.map(s => `
    <div class="sourceItem">
      <span class="tierBadge ${tierClass(s.tier)}">${tierName(s.tier)}</span>

      <div>
        <strong>${s.name}</strong>
        <div class="refMeta">${s.notes || ""}</div>
      </div>

      <strong>${s.reliability || "--"}%</strong>
    </div>
  `).join("");
}

function renderReferences() {
  const list = $("referencesList");

  if (!list) return;

  const refs = [...(state.references || [])].sort((a, b) => {
    const order = {
      official: 1,
      trusted: 2,
      reliable: 2,
      manual: 3,
      user: 3,
      outside: 4
    };

    const ao = order[String(a.tier || "").toLowerCase()] || 5;
    const bo = order[String(b.tier || "").toLowerCase()] || 5;

    if (ao !== bo) return ao - bo;

    return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
  });

  if (!refs.length) {
    list.innerHTML = `<div class="historyCard">No reference data stored yet. Add notes here to give the model extra context for matchups.</div>`;
    return;
  }

  list.innerHTML = refs.map(r => `
    <article class="historyCard">
      <div class="gameTop">
        <div>
          <div class="matchup">${r.title || "Reference note"}</div>

          <div class="refMeta">
            ${r.sourceName || "Source"} • ${tierName(r.tier)} • ${r.dataType || "general"} •
            Team: ${r.edgeTeamName || "Unknown"}${r.opponentTeamName ? " vs " + r.opponentTeamName : ""}${r.appliesDate ? " • " + r.appliesDate : ""}
          </div>
        </div>

        <span class="tierBadge ${tierClass(r.tier)}">
          ${r.inactive ? "Inactive" : "Impact " + r.impactScore}
        </span>
      </div>

      <div class="prediction">
        <div>
          <span>Confidence</span>
          <strong>${r.confidence || 0}%</strong>
        </div>

        <div>
          <span>Tier weight</span>
          <strong>${tierName(r.tier)}</strong>
        </div>

        <div>
          <span>Direction</span>
          <strong>${Number(r.impactScore || 0) >= 0 ? "Helps team" : "Hurts team"}</strong>
        </div>
      </div>

      ${r.note ? `<div class="refNote">${r.note}</div>` : ""}
      ${r.sourceUrl ? `<p class="refMeta">Source URL stored in database export.</p>` : ""}
      ${!r.inactive ? `<button onclick="deactivateReference('${r.id}')">Deactivate Reference</button>` : ""}
    </article>
  `).join("");
}

async function deactivateReference(id) {
  await api("/api/references/inactive", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ id })
  });

  await load();
}

function renderInjuries() {
  const list = $("injuryList");
  const injuries = state.injuries || [];

  if (!injuries.length) {
    list.innerHTML = `<div class="injuryCard">No injuries manually tracked yet. Add key injuries here to change prediction impact.</div>`;
    return;
  }

  list.innerHTML = injuries.map(i => `
    <article class="injuryCard">
      <div class="gameTop">
        <div>
          <div class="matchup">${i.playerName || "Unknown Player"}</div>
          <div class="time">${i.teamName || (state.teams.find(t => t.id == i.teamId) || {}).name || "Team"} • ${i.position || "POS"} • ${i.status || "Status"}</div>
        </div>

        <span class="badge ${i.resolved ? "good" : "bad"}">
          ${i.resolved ? "Resolved" : "Impact " + i.impactScore}
        </span>
      </div>

      <p class="hint">
        ${i.expectedReturn ? "Expected return: " + i.expectedReturn + " • " : ""}${i.note || ""}
      </p>

      ${!i.resolved ? `<button onclick="resolveInjury('${i.id}')">Mark Resolved</button>` : ""}
    </article>
  `).join("");
}

async function resolveInjury(id) {
  await api("/api/injuries/resolve", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ id })
  });

  await load();
}

function renderHistory() {
  const list = $("historyList");
  const graded = (state.predictions || []).filter(p => p.result).slice(0, 80);

  if (!graded.length) {
    list.innerHTML = `<div class="historyCard">No final games graded yet. After games finish, sync again and outcomes will show here.</div>`;
    return;
  }

  list.innerHTML = graded.map(p => `
    <article class="historyCard">
      <div class="gameTop">
        <div>
          <div class="matchup">${p.awayTeamName} @ ${p.homeTeamName}</div>
          <div class="time">${p.date} • Pick: ${p.predictedWinnerName} • Confidence: ${p.confidence}%</div>
        </div>

        <span class="badge ${p.result.correct ? "good" : "bad"}">
          ${p.result.correct ? "RIGHT" : "WRONG"}
        </span>
      </div>

      <div class="prediction">
        <div>
          <span>Projected</span>
          <strong>${p.projectedAwayScore}-${p.projectedHomeScore}</strong>
        </div>

        <div>
          <span>Actual</span>
          <strong>${p.result.awayScore}-${p.result.homeScore}</strong>
        </div>

        <div>
          <span>Winner</span>
          <strong>${p.result.actualWinnerName}</strong>
        </div>
      </div>
    </article>
  `).join("");
}

function renderModel() {
  const w = state.model.weights || {};

  $("modelBox").innerHTML = Object.keys(w).map(k => `
    <div class="weight">
      <span>${k}</span>
      <strong>${Number(w[k]).toFixed(4)}</strong>
    </div>
  `).join("");

  $("logList").innerHTML = (state.logs || []).map(l => `
    <div class="logItem">
      ${new Date(l.at).toLocaleString()} — ${l.message}
    </div>
  `).join("");
}

document.querySelectorAll(".tab").forEach(btn => {
  btn.addEventListener("click", () => {
    selectedTab = btn.dataset.tab;

    document.querySelectorAll(".tab").forEach(b => {
      b.classList.toggle("active", b === btn);
    });

    document.querySelectorAll(".tabPanel").forEach(p => {
      p.classList.add("hidden");
    });

    $("panel-" + selectedTab).classList.remove("hidden");
  });
});

$("syncBtn").addEventListener("click", () => load(true));

$("resourceForm").addEventListener("submit", async (e) => {
  e.preventDefault();

  await api("/api/references", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      sourceName: $("resSource").value,
      tier: $("resTier").value,
      dataType: $("resType").value,
      edgeTeamId: $("resTeam").value,
      opponentTeamId: $("resOpponent").value,
      appliesDate: $("resDate").value,
      impactScore: $("resImpact").value,
      confidence: $("resConfidence").value,
      title: $("resTitle").value,
      sourceUrl: $("resUrl").value,
      note: $("resNote").value
    })
  });

  e.target.reset();

  $("resImpact").value = 2;
  $("resConfidence").value = 70;

  if (state?.date) $("resDate").value = state.date;

  await load();
});

$("injuryForm").addEventListener("submit", async (e) => {
  e.preventDefault();

  const teamId = $("injTeam").value;
  const teamName = ($("injTeam").selectedOptions[0] || {}).textContent || "";

  await api("/api/injuries", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      teamId,
      teamName,
      playerName: $("injPlayer").value,
      position: $("injPosition").value,
      status: $("injStatus").value,
      expectedReturn: $("injReturn").value,
      impactScore: $("injImpact").value,
      note: $("injNote").value
    })
  });

  e.target.reset();
  $("injImpact").value = 3;

  await load();
});

load();
