const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 8787;
const MLB = "https://statsapi.mlb.com/api/v1";
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "mlb-edge-db.json");

function defaultDb() {
  return {
    teams: {},
    teamDailyStats: {},
    games: {},
    pitcherStats: {},
    predictions: {},
    injuries: [],
    references: [],
    sourceRegistry: [
      { id: "mlb-standings", name: "MLB Official Standings / Stats API", tier: "official", priority: 1, reliability: 100, notes: "Primary W-L, home/away, runs, schedule source." },
      { id: "mlb-pitchers", name: "MLB Official Probable Pitchers", tier: "official", priority: 1, reliability: 100, notes: "Primary probable starter source. Starters can change." },
      { id: "mlb-injuries", name: "MLB Official Injury Report", tier: "official", priority: 1, reliability: 95, notes: "Official injury reference. Manual impact is stored in this starter build." },
      { id: "savant", name: "Baseball Savant / Statcast", tier: "trusted", priority: 2, reliability: 90, notes: "Trusted advanced stat reference." },
      { id: "baseball-reference", name: "Baseball-Reference", tier: "trusted", priority: 2, reliability: 85, notes: "Trusted historical/team/player reference." },
      { id: "manual", name: "Your Manual Research", tier: "manual", priority: 3, reliability: 70, notes: "Your own matchup, lineup, weather, or form notes." },
      { id: "outside", name: "Outside Source", tier: "outside", priority: 4, reliability: 45, notes: "Lower-priority outside information." }
    ],
    model: {
      learningRate: 0.12,
      trainedGames: 0,
      weights: {
        bias: 0,
        winPct: 1.15,
        homeAway: 0.85,
        rpg: 0.55,
        rapg: 0.55,
        runDiff: 0.75,
        pitcherEra: 0.45,
        injury: 0.25,
        resourceImpact: 0.50
      }
    },
    logs: []
  };
}

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify(defaultDb(), null, 2));
}

function readDb() {
  ensureDb();
  const saved = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  const fresh = defaultDb();

  return {
    ...fresh,
    ...saved,
    model: {
      ...fresh.model,
      ...(saved.model || {}),
      weights: {
        ...fresh.model.weights,
        ...((saved.model || {}).weights || {})
      }
    }
  };
}

function writeDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function addLog(db, message) {
  db.logs.unshift({ at: new Date().toISOString(), message });
  db.logs = db.logs.slice(0, 200);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function season(dateStr) {
  return dateStr.slice(0, 4);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, Number(n || 0)));
}

function pct(w, l) {
  const t = Number(w || 0) + Number(l || 0);
  return t ? Number(w || 0) / t : 0;
}

function splitText(s) {
  if (!s) return "0-0";
  return `${Number(s.wins || 0)}-${Number(s.losses || 0)}`;
}

function getSplit(splitRecords, type) {
  const wanted = String(type).toLowerCase();
  return (splitRecords || []).find(s => String(s.type || "").toLowerCase() === wanted) || null;
}

function leagueName(name) {
  if (!name) return "";
  if (name.includes("American")) return "AL";
  if (name.includes("National")) return "NL";
  return name;
}

function divisionName(name) {
  return String(name || "")
    .replace("American League", "AL")
    .replace("National League", "NL");
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      Accept: "application/json"
    }
  });

  if (!res.ok) throw new Error(`Fetch failed ${res.status}: ${url}`);

  return res.json();
}

async function syncStandings(db, dateStr) {
  const url = `${MLB}/standings?leagueId=103,104&season=${season(dateStr)}&standingsTypes=regularSeason&hydrate=team`;
  const data = await fetchJson(url);

  db.teamDailyStats[dateStr] = db.teamDailyStats[dateStr] || {};

  for (const group of data.records || []) {
    for (const tr of group.teamRecords || []) {
      const team = tr.team || {};
      const id = String(team.id);

      const w = Number(tr.leagueRecord?.wins || tr.wins || 0);
      const l = Number(tr.leagueRecord?.losses || tr.losses || 0);
      const winPct = Number(tr.leagueRecord?.pct || pct(w, l));

      const records = tr.records?.splitRecords || [];
      const home = getSplit(records, "home") || {};
      const away = getSplit(records, "away") || {};
      const lastTen = getSplit(records, "lastTen") || getSplit(records, "last 10");

      const games = Math.max(1, w + l);
      const rs = Number(tr.runsScored || tr.runsFor || tr.rs || 0);
      const ra = Number(tr.runsAllowed || tr.runsAgainst || tr.ra || 0);

      db.teams[id] = {
        id,
        name: team.name || "Unknown",
        abbreviation: team.abbreviation || team.fileCode || id,
        league: leagueName(tr.league?.name || group.league?.name || ""),
        division: divisionName(tr.division?.name || group.division?.name || "")
      };

      db.teamDailyStats[dateStr][id] = {
        teamId: id,
        date: dateStr,
        wins: w,
        losses: l,
        winPct,
        home: splitText(home),
        away: splitText(away),
        homePct: pct(home.wins, home.losses),
        awayPct: pct(away.wins, away.losses),
        runsScored: rs,
        runsAllowed: ra,
        games,
        runsPerGame: rs / games,
        runsAllowedPerGame: ra / games,
        runDiffPerGame: (rs - ra) / games,
        last10: lastTen ? splitText(lastTen) : "",
        streak: tr.streak?.streakCode || ""
      };
    }
  }

  addLog(db, `Synced standings for ${dateStr}`);
}

async function pitcherStats(db, person, year) {
  if (!person?.id) return null;

  const key = `${year}-${person.id}`;

  if (db.pitcherStats[key]) return db.pitcherStats[key];

  const out = {
    id: String(person.id),
    name: person.fullName || "TBD",
    era: null,
    whip: null,
    strikeOuts: null
  };

  try {
    const data = await fetchJson(`${MLB}/people/${person.id}/stats?stats=season&group=pitching&season=${year}`);
    const stat = data.stats?.[0]?.splits?.[0]?.stat || {};

    out.era = stat.era ? Number(stat.era) : null;
    out.whip = stat.whip ? Number(stat.whip) : null;
    out.strikeOuts = stat.strikeOuts ? Number(stat.strikeOuts) : null;
  } catch (e) {
    // Keep pitcher name even if stats fail.
  }

  db.pitcherStats[key] = out;
  return out;
}

async function syncSchedule(db, dateStr) {
  const data = await fetchJson(`${MLB}/schedule?sportId=1&date=${dateStr}&hydrate=probablePitcher,team,linescore`);
  const year = season(dateStr);

  for (const day of data.dates || []) {
    for (const g of day.games || []) {
      const gamePk = String(g.gamePk);
      const awayTeam = g.teams?.away?.team || {};
      const homeTeam = g.teams?.home?.team || {};

      const awayPitcher = await pitcherStats(db, g.teams?.away?.probablePitcher, year);
      const homePitcher = await pitcherStats(db, g.teams?.home?.probablePitcher, year);

      db.games[gamePk] = {
        gamePk,
        date: dateStr,
        gameDate: g.gameDate,
        status: g.status?.detailedState || g.status?.abstractGameState || "Unknown",
        awayTeamId: String(awayTeam.id),
        homeTeamId: String(homeTeam.id),
        awayTeamName: awayTeam.name || "Away",
        homeTeamName: homeTeam.name || "Home",
        venue: g.venue?.name || "",
        awayScore: g.teams?.away?.score ?? null,
        homeScore: g.teams?.home?.score ?? null,
        awayPitcher,
        homePitcher,
        updatedAt: new Date().toISOString()
      };

      makePrediction(db, db.games[gamePk]);
      gradeIfFinal(db, db.games[gamePk]);
    }
  }

  addLog(db, `Synced games for ${dateStr}`);
}

function activeInjuries(db, teamId) {
  const now = new Date();

  return (db.injuries || []).filter(i => {
    if (String(i.teamId) !== String(teamId)) return false;
    if (i.resolved) return false;
    if (i.expectedReturn && new Date(i.expectedReturn + "T23:59:59") < now) return false;

    return true;
  });
}

function injuryScore(db, teamId) {
  return activeInjuries(db, teamId).reduce((sum, i) => {
    return sum + Number(i.impactScore || 0);
  }, 0);
}

function tierWeight(tier) {
  const t = String(tier || "manual").toLowerCase();

  if (t === "official") return 1.0;
  if (t === "trusted" || t === "reliable") return 0.78;
  if (t === "manual") return 0.62;
  if (t === "outside") return 0.42;

  return 0.4;
}

function tierOrder(tier) {
  const t = String(tier || "manual").toLowerCase();

  if (t === "official") return 1;
  if (t === "trusted" || t === "reliable") return 2;
  if (t === "manual") return 3;
  if (t === "outside") return 4;

  return 5;
}

function gameRefs(db, game) {
  return (db.references || [])
    .filter(r => {
      if (r.inactive) return false;
      if (r.appliesDate && r.appliesDate !== game.date) return false;
      if (r.gamePk && String(r.gamePk) !== String(game.gamePk)) return false;
      if (!r.edgeTeamId) return false;

      const edge = String(r.edgeTeamId);
      const opp = String(r.opponentTeamId || "");
      const teams = [String(game.homeTeamId), String(game.awayTeamId)];

      if (!teams.includes(edge)) return false;
      if (opp && !teams.includes(opp)) return false;

      return true;
    })
    .sort((a, b) => tierOrder(a.tier) - tierOrder(b.tier));
}

function resourceImpact(db, game) {
  const refs = gameRefs(db, game);
  let score = 0;
  const details = [];

  for (const r of refs) {
    const raw = clamp(r.impactScore, -10, 10) / 10;
    const conf = clamp(r.confidence || 60, 0, 100) / 100;
    const weighted = raw * conf * tierWeight(r.tier);

    const homePerspective = String(r.edgeTeamId) === String(game.homeTeamId)
      ? weighted
      : -weighted;

    score += homePerspective;

    details.push({
      ...r,
      weightedImpact: Number(homePerspective.toFixed(4))
    });
  }

  return {
    score: clamp(score, -1.25, 1.25),
    details: details.slice(0, 8)
  };
}

function features(db, game) {
  const s = db.teamDailyStats[game.date] || {};
  const home = s[String(game.homeTeamId)];
  const away = s[String(game.awayTeamId)];

  if (!home || !away) return null;

  const homeEra = game.homePitcher?.era || 4.2;
  const awayEra = game.awayPitcher?.era || 4.2;
  const res = resourceImpact(db, game);

  return {
    winPct: home.winPct - away.winPct,
    homeAway: home.homePct - away.awayPct,
    rpg: (home.runsPerGame - away.runsPerGame) / 2,
    rapg: (away.runsAllowedPerGame - home.runsAllowedPerGame) / 2,
    runDiff: home.runDiffPerGame - away.runDiffPerGame,
    pitcherEra: (awayEra - homeEra) / 5,
    injury: (injuryScore(db, game.awayTeamId) - injuryScore(db, game.homeTeamId)) / 10,
    resourceImpact: res.score
  };
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function homeWinProb(db, f) {
  const w = db.model.weights;
  let z = w.bias || 0;

  for (const [k, v] of Object.entries(f)) {
    z += (w[k] || 0) * Number(v || 0);
  }

  return sigmoid(z);
}

function scoreProjection(db, game, prob) {
  const s = db.teamDailyStats[game.date] || {};
  const home = s[String(game.homeTeamId)];
  const away = s[String(game.awayTeamId)];

  const leagueEra = 4.2;
  const homeEra = game.homePitcher?.era || leagueEra;
  const awayEra = game.awayPitcher?.era || leagueEra;

  let homeRuns = home.runsPerGame * 0.56 + away.runsAllowedPerGame * 0.44 + 0.15 + (awayEra - leagueEra) * 0.18;
  let awayRuns = away.runsPerGame * 0.56 + home.runsAllowedPerGame * 0.44 - 0.05 + (homeEra - leagueEra) * 0.18;

  homeRuns -= injuryScore(db, game.homeTeamId) * 0.04;
  awayRuns -= injuryScore(db, game.awayTeamId) * 0.04;

  let homeScore = Math.round(clamp(homeRuns, 1.5, 10.5));
  let awayScore = Math.round(clamp(awayRuns, 1.5, 10.5));

  if (homeScore === awayScore) {
    prob >= 0.5 ? homeScore++ : awayScore++;
  }

  return {
    homeScore,
    awayScore
  };
}

function reasons(f, game) {
  const home = game.homeTeamName;
  const away = game.awayTeamName;
  const out = [];

  if (Math.abs(f.winPct) > 0.015) out.push(f.winPct > 0 ? `${home} has the better win rate` : `${away} has the better win rate`);
  if (Math.abs(f.homeAway) > 0.03) out.push(f.homeAway > 0 ? `${home} has the stronger home/away split` : `${away} has the stronger road/home split`);
  if (Math.abs(f.rpg) > 0.08) out.push(f.rpg > 0 ? `${home} scores more runs per game` : `${away} scores more runs per game`);
  if (Math.abs(f.rapg) > 0.08) out.push(f.rapg > 0 ? `${home} allows fewer runs per game` : `${away} allows fewer runs per game`);
  if (Math.abs(f.pitcherEra) > 0.12) out.push(f.pitcherEra > 0 ? `${home} has the starter ERA edge` : `${away} has the starter ERA edge`);
  if (Math.abs(f.injury) > 0.05) out.push(f.injury > 0 ? `${away} has more tracked injury impact` : `${home} has more tracked injury impact`);
  if (Math.abs(f.resourceImpact) > 0.03) out.push(f.resourceImpact > 0 ? `${home} has a stored reference edge` : `${away} has a stored reference edge`);

  return out.length ? out.slice(0, 4) : ["Matchup is close based on stored stats"];
}

function hashPrediction(f, refs, game) {
  return crypto
    .createHash("sha1")
    .update(JSON.stringify({
      f,
      refs,
      hp: game.homePitcher?.id,
      ap: game.awayPitcher?.id
    }))
    .digest("hex");
}

function makePrediction(db, game) {
  const f = features(db, game);

  if (!f) return null;

  const prob = homeWinProb(db, f);
  const projected = scoreProjection(db, game, prob);
  const refs = resourceImpact(db, game).details;
  const predHash = hashPrediction(f, refs, game);
  const existing = db.predictions[game.gamePk];

  const pred = {
    gamePk: game.gamePk,
    date: game.date,
    awayTeamId: game.awayTeamId,
    homeTeamId: game.homeTeamId,
    awayTeamName: game.awayTeamName,
    homeTeamName: game.homeTeamName,
    predictedWinnerTeamId: prob >= 0.5 ? game.homeTeamId : game.awayTeamId,
    predictedWinnerName: prob >= 0.5 ? game.homeTeamName : game.awayTeamName,
    homeWinProbability: Number(prob.toFixed(4)),
    confidence: Math.round(Math.max(prob, 1 - prob) * 100),
    projectedAwayScore: projected.awayScore,
    projectedHomeScore: projected.homeScore,
    features: f,
    reasons: reasons(f, game),
    sourceReferences: refs,
    featureHash: predHash,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    result: existing?.result || null,
    revisions: existing?.revisions || []
  };

  if (existing && existing.featureHash !== predHash && !existing.result) {
    pred.revisions.unshift({
      at: new Date().toISOString(),
      pick: existing.predictedWinnerName,
      confidence: existing.confidence,
      projectedAwayScore: existing.projectedAwayScore,
      projectedHomeScore: existing.projectedHomeScore
    });

    pred.revisions = pred.revisions.slice(0, 20);
  }

  db.predictions[game.gamePk] = pred;
  return pred;
}

function train(db, f, y) {
  const lr = Number(db.model.learningRate || 0.1);
  const p = homeWinProb(db, f);
  const error = y - p;

  db.model.weights.bias += lr * error;

  for (const [k, v] of Object.entries(f)) {
    db.model.weights[k] = (db.model.weights[k] || 0) + lr * error * Number(v || 0);
  }

  db.model.trainedGames = Number(db.model.trainedGames || 0) + 1;
}

function gradeIfFinal(db, game) {
  const isFinal =
    String(game.status || "").toLowerCase().includes("final") ||
    String(game.status || "").toLowerCase().includes("completed");

  if (!isFinal || game.awayScore == null || game.homeScore == null) return;

  const pred = db.predictions[game.gamePk];

  if (!pred || pred.result) return;

  const actualWinnerTeamId = Number(game.homeScore) > Number(game.awayScore)
    ? game.homeTeamId
    : game.awayTeamId;

  const correct = String(actualWinnerTeamId) === String(pred.predictedWinnerTeamId);

  pred.result = {
    actualWinnerTeamId,
    actualWinnerName: String(actualWinnerTeamId) === String(game.homeTeamId)
      ? game.homeTeamName
      : game.awayTeamName,
    awayScore: game.awayScore,
    homeScore: game.homeScore,
    correct,
    gradedAt: new Date().toISOString()
  };

  train(db, pred.features, String(actualWinnerTeamId) === String(game.homeTeamId) ? 1 : 0);
  addLog(db, `Graded ${game.awayTeamName} @ ${game.homeTeamName}: ${correct ? "correct" : "wrong"}`);
}

async function syncDate(db, dateStr) {
  await syncStandings(db, dateStr);
  await syncSchedule(db, dateStr);
}

function accuracy(db) {
  const graded = Object.values(db.predictions).filter(p => p.result);
  const correct = graded.filter(p => p.result.correct).length;

  return {
    totalGraded: graded.length,
    correct,
    accuracy: graded.length ? Math.round((correct / graded.length) * 1000) / 10 : null
  };
}

function dashboard(db, dateStr) {
  const tomorrow = addDays(dateStr, 1);

  const gamesFor = d => Object.values(db.games)
    .filter(g => g.date === d)
    .sort((a, b) => String(a.gameDate).localeCompare(String(b.gameDate)))
    .map(g => ({
      ...g,
      prediction: db.predictions[g.gamePk] || null
    }));

  const teams = Object.values(db.teams)
    .map(t => ({
      ...t,
      stats: (db.teamDailyStats[dateStr] || {})[t.id]
    }))
    .filter(t => t.stats)
    .sort((a, b) => b.stats.winPct - a.stats.winPct);

  return {
    date: dateStr,
    tomorrow,
    teams,
    todayGames: gamesFor(dateStr),
    tomorrowGames: gamesFor(tomorrow),
    injuries: db.injuries,
    references: db.references,
    sourceRegistry: db.sourceRegistry,
    predictions: Object.values(db.predictions).sort((a, b) => String(b.date).localeCompare(String(a.date))),
    accuracy: accuracy(db),
    model: db.model,
    logs: db.logs.slice(0, 30)
  };
}

function sendJson(res, obj, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  });

  res.end(JSON.stringify(obj, null, 2));
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const type = {
      ".html": "text/html",
      ".css": "text/css",
      ".js": "text/javascript"
    }[path.extname(filePath).toLowerCase()] || "application/octet-stream";

    res.writeHead(200, {
      "Content-Type": type
    });

    res.end(data);
  });
}

function readBody(req) {
  return new Promise(resolve => {
    let data = "";

    req.on("data", chunk => data += chunk);

    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

async function router(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const db = readDb();

  try {
    if (url.pathname === "/api/dashboard") {
      return sendJson(res, dashboard(db, url.searchParams.get("date") || todayISO()));
    }

    if (url.pathname === "/api/sync") {
      const date = url.searchParams.get("date") || todayISO();

      await syncDate(db, date);
      await syncDate(db, addDays(date, 1));

      writeDb(db);

      return sendJson(res, {
        ok: true,
        dashboard: dashboard(db, date)
      });
    }

    if (url.pathname === "/api/recalculate") {
      const date = url.searchParams.get("date") || todayISO();

      for (const g of Object.values(db.games)) {
        if (g.date === date || g.date === addDays(date, 1)) {
          makePrediction(db, g);
        }
      }

      writeDb(db);

      return
