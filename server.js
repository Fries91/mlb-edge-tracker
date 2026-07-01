const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 8787;
const MLB = "https://statsapi.mlb.com/api/v1";

const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
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
      {
        id: "mlb-schedule",
        name: "Official MLB Schedule / Scores",
        tier: "official",
        priority: 1,
        reliability: 100,
        notes: "Automatic schedule, scores, venues, and game status."
      },
      {
        id: "mlb-standings",
        name: "Official MLB Standings / Team Stats",
        tier: "official",
        priority: 1,
        reliability: 100,
        notes: "Automatic records, home/away splits, runs scored, and runs allowed."
      },
      {
        id: "mlb-pitchers",
        name: "Official MLB Probable Pitchers",
        tier: "official",
        priority: 1,
        reliability: 95,
        notes: "Automatic probable starter names and season pitching stats when available."
      },
      {
        id: "auto-recent-form",
        name: "Automatic Recent Form Engine",
        tier: "calculated",
        priority: 2,
        reliability: 82,
        notes: "Calculated from stored recent final scores."
      },
      {
        id: "auto-h2h",
        name: "Automatic Head-to-Head Engine",
        tier: "calculated",
        priority: 2,
        reliability: 78,
        notes: "Calculated from stored head-to-head final scores."
      },
      {
        id: "self-learning",
        name: "Self-Learning Result Engine",
        tier: "calculated",
        priority: 2,
        reliability: 75,
        notes: "Grades completed games and adjusts model weights."
      }
    ],
    model: {
      learningRate: 0.11,
      trainedGames: 0,
      weights: {
        bias: 0,
        winPct: 1.15,
        homeAway: 0.85,
        rpg: 0.55,
        rapg: 0.55,
        runDiff: 0.75,
        pitcherEra: 0.45,
        pitcherWhip: 0.22,
        pitcherStrikeouts: 0.18,
        recentForm: 0.72,
        h2h: 0.34
      }
    },
    logs: []
  };
}

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(defaultDb(), null, 2));
  }
}

function readDb() {
  ensureDb();

  let saved = {};

  try {
    saved = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {
    saved = {};
  }

  const fresh = defaultDb();
  const freshWeights = fresh.model.weights;
  const savedWeights = ((saved.model || {}).weights || {});
  const cleanWeights = {};

  for (const key of Object.keys(freshWeights)) {
    cleanWeights[key] = Number.isFinite(Number(savedWeights[key]))
      ? Number(savedWeights[key])
      : freshWeights[key];
  }

  return {
    ...fresh,
    ...saved,
    sourceRegistry: fresh.sourceRegistry,
    model: {
      ...fresh.model,
      ...(saved.model || {}),
      weights: cleanWeights
    }
  };
}

function writeDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function addLog(db, message) {
  db.logs = db.logs || [];
  db.logs.unshift({
    at: new Date().toISOString(),
    message
  });
  db.logs = db.logs.slice(0, 250);
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
  return String(dateStr).slice(0, 4);
}

function clamp(n, min, max) {
  const value = Number(n || 0);
  return Math.max(min, Math.min(max, value));
}

function pct(w, l) {
  const wins = Number(w || 0);
  const losses = Number(l || 0);
  const total = wins + losses;
  return total ? wins / total : 0;
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
  const n = String(name || "");
  if (n.includes("American")) return "AL";
  if (n.includes("National")) return "NL";
  return n;
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

  if (!res.ok) {
    throw new Error(`Fetch failed ${res.status}: ${url}`);
  }

  return await res.json();
}

async function syncStandings(db, dateStr) {
  const year = season(dateStr);
  const url = `${MLB}/standings?leagueId=103,104&season=${year}&standingsTypes=regularSeason&hydrate=team`;
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
  if (!person || !person.id) return null;

  const key = `${year}-${person.id}`;

  if (db.pitcherStats[key]) {
    return db.pitcherStats[key];
  }

  const out = {
    id: String(person.id),
    name: person.fullName || "TBD",
    era: null,
    whip: null,
    strikeOuts: null,
    gamesStarted: null,
    inningsPitched: null
  };

  try {
    const url = `${MLB}/people/${person.id}/stats?stats=season&group=pitching&season=${year}`;
    const data = await fetchJson(url);
    const stat = data.stats?.[0]?.splits?.[0]?.stat || {};

    out.era = stat.era ? Number(stat.era) : null;
    out.whip = stat.whip ? Number(stat.whip) : null;
    out.strikeOuts = stat.strikeOuts ? Number(stat.strikeOuts) : null;
    out.gamesStarted = stat.gamesStarted ? Number(stat.gamesStarted) : null;
    out.inningsPitched = stat.inningsPitched || null;
  } catch {
    // Keep pitcher name even if stats fail.
  }

  db.pitcherStats[key] = out;
  return out;
}

async function syncSchedule(db, dateStr, options = {}) {
  const year = season(dateStr);
  const shouldPredict = options.predict !== false;
  const url = `${MLB}/schedule?sportId=1&date=${dateStr}&hydrate=probablePitcher,team,linescore`;
  const data = await fetchJson(url);

  for (const day of data.dates || []) {
    for (const g of day.games || []) {
      const gamePk = String(g.gamePk);
      const awayTeam = g.teams?.away?.team || {};
      const homeTeam = g.teams?.home?.team || {};

      const awayPitcher = await pitcherStats(db, g.teams?.away?.probablePitcher, year);
      const homePitcher = await pitcherStats(db, g.teams?.home?.probablePitcher, year);

      db.teams[String(awayTeam.id)] = db.teams[String(awayTeam.id)] || {
        id: String(awayTeam.id),
        name: awayTeam.name || "Away",
        abbreviation: awayTeam.abbreviation || String(awayTeam.id),
        league: "",
        division: ""
      };

      db.teams[String(homeTeam.id)] = db.teams[String(homeTeam.id)] || {
        id: String(homeTeam.id),
        name: homeTeam.name || "Home",
        abbreviation: homeTeam.abbreviation || String(homeTeam.id),
        league: "",
        division: ""
      };

      db.games[gamePk] = {
        ...(db.games[gamePk] || {}),
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

      if (shouldPredict) {
        makePrediction(db, db.games[gamePk]);
      }

      gradeIfFinal(db, db.games[gamePk]);
    }
  }

  addLog(db, shouldPredict ? `Synced games for ${dateStr}` : `Synced recent results for ${dateStr}`);
}

async function syncRecentResults(db, dateStr, daysBack = 21) {
  for (let i = daysBack; i >= 1; i--) {
    const d = addDays(dateStr, -i);
    await syncSchedule(db, d, { predict: false });
  }
}

function isFinalGame(game) {
  const status = String(game?.status || "").toLowerCase();
  return status.includes("final") || status.includes("completed");
}

function gameWinnerId(game) {
  if (!isFinalGame(game)) return null;
  if (game.awayScore == null || game.homeScore == null) return null;
  if (Number(game.homeScore) > Number(game.awayScore)) return String(game.homeTeamId);
  if (Number(game.awayScore) > Number(game.homeScore)) return String(game.awayTeamId);
  return null;
}

function teamGamesBefore(db, teamId, beforeDate, maxGames = 10) {
  return Object.values(db.games || {})
    .filter(g => {
      if (!isFinalGame(g)) return false;
      if (String(g.date) >= String(beforeDate)) return false;
      return String(g.homeTeamId) === String(teamId) || String(g.awayTeamId) === String(teamId);
    })
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, maxGames);
}

function teamRecentForm(db, teamId, beforeDate, maxGames = 10) {
  const games = teamGamesBefore(db, teamId, beforeDate, maxGames);
  let wins = 0;
  let losses = 0;
  let scored = 0;
  let allowed = 0;

  for (const g of games) {
    const isHome = String(g.homeTeamId) === String(teamId);
    const teamScore = Number(isHome ? g.homeScore : g.awayScore);
    const oppScore = Number(isHome ? g.awayScore : g.homeScore);

    if (teamScore > oppScore) wins += 1;
    if (teamScore < oppScore) losses += 1;

    scored += teamScore;
    allowed += oppScore;
  }

  const total = wins + losses;

  return {
    games: total,
    wins,
    losses,
    winPct: total ? wins / total : 0.5,
    runDiffPerGame: total ? (scored - allowed) / total : 0,
    label: total ? `${wins}-${losses} last ${total}` : "No recent finals"
  };
}

function headToHead(db, homeTeamId, awayTeamId, beforeDate, maxGames = 10) {
  const games = Object.values(db.games || {})
    .filter(g => {
      if (!isFinalGame(g)) return false;
      if (String(g.date) >= String(beforeDate)) return false;

      const home = String(g.homeTeamId);
      const away = String(g.awayTeamId);
      const a = String(homeTeamId);
      const b = String(awayTeamId);

      return (home === a && away === b) || (home === b && away === a);
    })
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, maxGames);

  let homeWins = 0;
  let awayWins = 0;
  let homeRuns = 0;
  let awayRuns = 0;

  for (const g of games) {
    const homeIsTrackedHome = String(g.homeTeamId) === String(homeTeamId);

    const trackedHomeScore = Number(homeIsTrackedHome ? g.homeScore : g.awayScore);
    const trackedAwayScore = Number(homeIsTrackedHome ? g.awayScore : g.homeScore);

    homeRuns += trackedHomeScore;
    awayRuns += trackedAwayScore;

    if (trackedHomeScore > trackedAwayScore) homeWins += 1;
    if (trackedAwayScore > trackedHomeScore) awayWins += 1;
  }

  const total = homeWins + awayWins;

  return {
    games: total,
    homeWins,
    awayWins,
    homeWinPct: total ? homeWins / total : 0.5,
    runDiffPerGame: total ? (homeRuns - awayRuns) / total : 0,
    label: total ? `${homeWins}-${awayWins} H2H last ${total}` : "No recent H2H"
  };
}

function pitcherEraEdge(homePitcher, awayPitcher) {
  const leagueEra = 4.2;
  const homeEra = Number(homePitcher?.era || leagueEra);
  const awayEra = Number(awayPitcher?.era || leagueEra);
  return (awayEra - homeEra) / 5;
}

function pitcherWhipEdge(homePitcher, awayPitcher) {
  const leagueWhip = 1.3;
  const homeWhip = Number(homePitcher?.whip || leagueWhip);
  const awayWhip = Number(awayPitcher?.whip || leagueWhip);
  return (awayWhip - homeWhip) / 2;
}

function pitcherStrikeoutEdge(homePitcher, awayPitcher) {
  const homeKs = Number(homePitcher?.strikeOuts || 0);
  const awayKs = Number(awayPitcher?.strikeOuts || 0);
  return clamp((homeKs - awayKs) / 180, -0.8, 0.8);
}

function features(db, game) {
  const statsByDate = db.teamDailyStats[game.date] || {};
  const home = statsByDate[String(game.homeTeamId)];
  const away = statsByDate[String(game.awayTeamId)];

  if (!home || !away) return null;

  const homeForm = teamRecentForm(db, game.homeTeamId, game.date, 10);
  const awayForm = teamRecentForm(db, game.awayTeamId, game.date, 10);
  const h2h = headToHead(db, game.homeTeamId, game.awayTeamId, game.date, 10);

  return {
    winPct: home.winPct - away.winPct,
    homeAway: home.homePct - away.awayPct,
    rpg: (home.runsPerGame - away.runsPerGame) / 2,
    rapg: (away.runsAllowedPerGame - home.runsAllowedPerGame) / 2,
    runDiff: home.runDiffPerGame - away.runDiffPerGame,
    pitcherEra: pitcherEraEdge(game.homePitcher, game.awayPitcher),
    pitcherWhip: pitcherWhipEdge(game.homePitcher, game.awayPitcher),
    pitcherStrikeouts: pitcherStrikeoutEdge(game.homePitcher, game.awayPitcher),
    recentForm: (homeForm.winPct - awayForm.winPct) + ((homeForm.runDiffPerGame - awayForm.runDiffPerGame) / 8),
    h2h: (h2h.homeWinPct - 0.5) + (h2h.runDiffPerGame / 10)
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
  const statsByDate = db.teamDailyStats[game.date] || {};
  const home = statsByDate[String(game.homeTeamId)];
  const away = statsByDate[String(game.awayTeamId)];

  const leagueEra = 4.2;
  const homeEra = game.homePitcher?.era || leagueEra;
  const awayEra = game.awayPitcher?.era || leagueEra;

  const homeForm = teamRecentForm(db, game.homeTeamId, game.date, 10);
  const awayForm = teamRecentForm(db, game.awayTeamId, game.date, 10);
  const h2h = headToHead(db, game.homeTeamId, game.awayTeamId, game.date, 10);

  let homeRuns = home.runsPerGame * 0.52 + away.runsAllowedPerGame * 0.38 + 0.2 + (awayEra - leagueEra) * 0.16;
  let awayRuns = away.runsPerGame * 0.52 + home.runsAllowedPerGame * 0.38 - 0.04 + (homeEra - leagueEra) * 0.16;

  homeRuns += homeForm.runDiffPerGame * 0.08;
  awayRuns += awayForm.runDiffPerGame * 0.08;
  homeRuns += h2h.runDiffPerGame * 0.04;
  awayRuns -= h2h.runDiffPerGame * 0.04;

  let homeScore = Math.round(clamp(homeRuns, 1.5, 10.5));
  let awayScore = Math.round(clamp(awayRuns, 1.5, 10.5));

  if (homeScore === awayScore) {
    if (prob >= 0.5) homeScore += 1;
    else awayScore += 1;
  }

  return {
    homeScore,
    awayScore
  };
}

function factorEdgeName(value, game) {
  const n = Number(value || 0);
  if (Math.abs(n) < 0.035) return "Close";
  return n > 0 ? game.homeTeamName : game.awayTeamName;
}

function reasons(db, f, game) {
  const home = game.homeTeamName;
  const away = game.awayTeamName;
  const out = [];

  if (Math.abs(f.winPct) > 0.015) {
    out.push(f.winPct > 0 ? `${home} has the better win rate` : `${away} has the better win rate`);
  }

  if (Math.abs(f.homeAway) > 0.03) {
    out.push(f.homeAway > 0 ? `${home} has the stronger home/away split` : `${away} has the stronger road/home split`);
  }

  if (Math.abs(f.rpg) > 0.08) {
    out.push(f.rpg > 0 ? `${home} scores more runs per game` : `${away} scores more runs per game`);
  }

  if (Math.abs(f.rapg) > 0.08) {
    out.push(f.rapg > 0 ? `${home} allows fewer runs per game` : `${away} allows fewer runs per game`);
  }

  if (Math.abs(f.pitcherEra) > 0.12 || Math.abs(f.pitcherWhip) > 0.1) {
    out.push(f.pitcherEra + f.pitcherWhip > 0 ? `${home} has the starter pitching edge` : `${away} has the starter pitching edge`);
  }

  if (Math.abs(f.recentForm) > 0.06) {
    out.push(f.recentForm > 0 ? `${home} has stronger recent form` : `${away} has stronger recent form`);
  }

  if (Math.abs(f.h2h) > 0.06) {
    out.push(f.h2h > 0 ? `${home} has the recent head-to-head edge` : `${away} has the recent head-to-head edge`);
  }

  return out.length ? out.slice(0, 6) : ["Matchup is close based on stored automatic factors"];
}

function autoSourceReferences(db, f, game) {
  const homeForm = teamRecentForm(db, game.homeTeamId, game.date, 10);
  const awayForm = teamRecentForm(db, game.awayTeamId, game.date, 10);
  const h2h = headToHead(db, game.homeTeamId, game.awayTeamId, game.date, 10);

  const list = [];

  function add(id, title, edgeTeamName, value, note, reliability = 80) {
    list.push({
      id: `${game.gamePk}-${id}`,
      title,
      sourceName: "Auto Source Engine",
      tier: "calculated",
      dataType: id,
      edgeTeamName,
      impactScore: Number(clamp(value * 10, -10, 10).toFixed(2)),
      confidence: reliability,
      note,
      weightedImpact: Number(value.toFixed(4)),
      createdAt: new Date().toISOString()
    });
  }

  add(
    "winPct",
    "Win percentage edge",
    factorEdgeName(f.winPct, game),
    f.winPct,
    "Calculated from official season record.",
    92
  );

  add(
    "homeAway",
    "Home / road split edge",
    factorEdgeName(f.homeAway, game),
    f.homeAway,
    "Calculated from official home and away records.",
    86
  );

  add(
    "scoring",
    "Runs per game edge",
    factorEdgeName(f.rpg, game),
    f.rpg,
    "Calculated from official runs scored per game.",
    84
  );

  add(
    "prevention",
    "Run prevention edge",
    factorEdgeName(f.rapg, game),
    f.rapg,
    "Calculated from official runs allowed per game.",
    84
  );

  add(
    "pitcher",
    "Probable starter edge",
    factorEdgeName(f.pitcherEra + f.pitcherWhip + f.pitcherStrikeouts, game),
    f.pitcherEra + f.pitcherWhip + f.pitcherStrikeouts,
    "Calculated from probable starter ERA, WHIP, and strikeouts when available.",
    76
  );

  add(
    "recentForm",
    "Recent form edge",
    factorEdgeName(f.recentForm, game),
    f.recentForm,
    `${game.homeTeamName}: ${homeForm.label}. ${game.awayTeamName}: ${awayForm.label}.`,
    homeForm.games && awayForm.games ? 78 : 55
  );

  add(
    "h2h",
    "Head-to-head edge",
    factorEdgeName(f.h2h, game),
    f.h2h,
    h2h.label,
    h2h.games ? 72 : 45
  );

  return list.sort((a, b) => Math.abs(b.weightedImpact) - Math.abs(a.weightedImpact));
}

function hashPrediction(f, refs, game) {
  return crypto
    .createHash("sha1")
    .update(JSON.stringify({
      f,
      refs: refs.map(r => ({ id: r.id, impact: r.weightedImpact })),
      hp: game.homePitcher?.id,
      ap: game.awayPitcher?.id,
      hs: game.homeScore,
      as: game.awayScore
    }))
    .digest("hex");
}

function makePrediction(db, game) {
  const f = features(db, game);

  if (!f) return null;

  const prob = homeWinProb(db, f);
  const projected = scoreProjection(db, game, prob);
  const refs = autoSourceReferences(db, f, game);
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
    reasons: reasons(db, f, game),
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
    if (!Object.prototype.hasOwnProperty.call(db.model.weights, k)) continue;
    db.model.weights[k] = (db.model.weights[k] || 0) + lr * error * Number(v || 0);
  }

  db.model.trainedGames = Number(db.model.trainedGames || 0) + 1;
}

function gradeIfFinal(db, game) {
  if (!isFinalGame(game) || game.awayScore == null || game.homeScore == null) {
    return;
  }

  const pred = db.predictions[game.gamePk];

  if (!pred || pred.result) {
    return;
  }

  const actualWinnerTeamId = gameWinnerId(game);
  if (!actualWinnerTeamId) return;

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

async function syncPredictionDate(db, dateStr) {
  await syncStandings(db, dateStr);
  await syncSchedule(db, dateStr, { predict: true });
}

async function fullAutoSync(db, dateStr) {
  await syncRecentResults(db, dateStr, 21);
  await syncPredictionDate(db, dateStr);
  await syncPredictionDate(db, addDays(dateStr, 1));
  addLog(db, "Full automatic sync complete");
}

function accuracy(db) {
  const graded = Object.values(db.predictions || {}).filter(p => p.result);
  const correct = graded.filter(p => p.result.correct).length;

  return {
    totalGraded: graded.length,
    correct,
    accuracy: graded.length ? Math.round((correct / graded.length) * 1000) / 10 : null
  };
}

function dashboard(db, dateStr) {
  const tomorrow = addDays(dateStr, 1);

  const gamesFor = d => Object.values(db.games || {})
    .filter(g => g.date === d)
    .sort((a, b) => String(a.gameDate).localeCompare(String(b.gameDate)))
    .map(g => ({
      ...g,
      prediction: db.predictions[g.gamePk] || null
    }));

  const teams = Object.values(db.teams || {})
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
    injuries: [],
    references: [],
    sourceRegistry: db.sourceRegistry || [],
    predictions: Object.values(db.predictions || {}).sort((a, b) => String(b.date).localeCompare(String(a.date))),
    accuracy: accuracy(db),
    model: db.model,
    logs: (db.logs || []).slice(0, 40)
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

    const ext = path.extname(filePath).toLowerCase();

    const type = {
      ".html": "text/html",
      ".css": "text/css",
      ".js": "text/javascript",
      ".json": "application/json"
    }[ext] || "application/octet-stream";

    res.writeHead(200, {
      "Content-Type": type
    });

    res.end(data);
  });
}

function readBody(req) {
  return new Promise(resolve => {
    let data = "";

    req.on("data", chunk => {
      data += chunk;
    });

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
      const date = url.searchParams.get("date") || todayISO();
      return sendJson(res, dashboard(db, date));
    }

    if (url.pathname === "/api/sync") {
      const date = url.searchParams.get("date") || todayISO();

      await fullAutoSync(db, date);
      writeDb(db);

      return sendJson(res, {
        ok: true,
        dashboard: dashboard(db, date)
      });
    }

    if (url.pathname === "/api/recalculate") {
      const date = url.searchParams.get("date") || todayISO();

      for (const g of Object.values(db.games || {})) {
        if (g.date === date || g.date === addDays(date, 1)) {
          makePrediction(db, g);
          gradeIfFinal(db, g);
        }
      }

      writeDb(db);

      return sendJson(res, {
        ok: true,
        dashboard: dashboard(db, date)
      });
    }

    if (url.pathname === "/api/export") {
      return sendJson(res, db);
    }

    if (url.pathname === "/api/injuries" && req.method === "POST") {
      await readBody(req);

      return sendJson(res, {
        ok: true,
        message: "Manual injury input is disabled. The app is automatic-only now."
      });
    }

    if (url.pathname === "/api/references" && req.method === "POST") {
      await readBody(req);

      return sendJson(res, {
        ok: true,
        message: "Manual resource input is disabled. The app is automatic-only now."
      });
    }

    const safePath = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
    const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));

    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      return res.end("Forbidden");
    }

    return sendFile(res, filePath);
  } catch (e) {
    console.error(e);

    return sendJson(res, {
      ok: false,
      error: e.message
    }, 500);
  }
}

ensureDb();

http.createServer(router).listen(PORT, () => {
  console.log(`MLB Edge Tracker running at http://localhost:${PORT}`);
});

setInterval(async () => {
  const db = readDb();
  const date = todayISO();

  try {
    await fullAutoSync(db, date);
    writeDb(db);

    console.log("Auto-sync complete");
  } catch (e) {
    addLog(db, `Auto-sync failed: ${e.message}`);
    writeDb(db);
    console.error(e);
  }
}, 60 * 60 * 1000);
