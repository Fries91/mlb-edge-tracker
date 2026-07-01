const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");
const DB_FILE = path.join(DATA_DIR, "mlb-edge-db.json");
const MLB_API = "https://statsapi.mlb.com/api/v1";

const FRONTEND_URL = "/";
const SYNC_INTERVAL_MS = 60 * 60 * 1000;
const PITCHER_CACHE_MS = 6 * 60 * 60 * 1000;
const LEARN_RATE = 0.035;

const DEFAULT_WEIGHTS = {
  bias: 0.04,
  winPct: 0.9,
  homeAway: 0.55,
  rpg: 0.75,
  rapg: 0.75,
  runDiff: 0.85,
  pitcherEra: 0.45,
  pitcherWhip: 0.32,
  pitcherStrikeouts: 0.2,
  recentForm: 0.45,
  h2h: 0.22
};

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function defaultDb() {
  return {
    teams: {},
    pitchers: {},
    predictions: [],
    recentGames: [],
    model: {
      weights: { ...DEFAULT_WEIGHTS },
      trainedGames: 0,
      lastTrainedAt: null
    },
    logs: [],
    meta: {}
  };
}

function normalizeDb(db) {
  const clean = db && typeof db === "object" ? db : defaultDb();

  return {
    teams: clean.teams || {},
    pitchers: clean.pitchers || {},
    predictions: Array.isArray(clean.predictions) ? clean.predictions : [],
    recentGames: Array.isArray(clean.recentGames) ? clean.recentGames : [],
    model: {
      ...(clean.model || {}),
      weights: {
        ...DEFAULT_WEIGHTS,
        ...((clean.model && clean.model.weights) || {})
      },
      trainedGames: Number(clean.model?.trainedGames || 0),
      lastTrainedAt: clean.model?.lastTrainedAt || null
    },
    logs: Array.isArray(clean.logs) ? clean.logs : [],
    meta: clean.meta || {}
  };
}

function readDb() {
  ensureDataDir();

  if (!fs.existsSync(DB_FILE)) {
    const fresh = defaultDb();
    saveDb(fresh);
    return fresh;
  }

  try {
    const raw = fs.readFileSync(DB_FILE, "utf8");
    return normalizeDb(JSON.parse(raw));
  } catch {
    const fresh = defaultDb();
    saveDb(fresh);
    return fresh;
  }
}

function saveDb(db) {
  ensureDataDir();
  fs.writeFileSync(DB_FILE, JSON.stringify(normalizeDb(db), null, 2));
}

function logMessage(db, message) {
  db.logs = db.logs || [];
  db.logs.unshift({
    at: new Date().toISOString(),
    message
  });

  db.logs = db.logs.slice(0, 80);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function rate(part, total, fallback = 0.5) {
  if (!total) return fallback;
  return part / total;
}

function ymd(date = new Date()) {
  return new Date(date).toISOString().slice(0, 10);
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return ymd(date);
}

function currentSeason() {
  return new Date().getUTCFullYear();
}

function mlb(pathName) {
  return `${MLB_API}${pathName}`;
}

function fetchJson(url, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      let body = "";

      res.on("data", chunk => {
        body += chunk;
      });

      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`MLB API returned ${res.statusCode}`));
          return;
        }

        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error("MLB API returned invalid JSON"));
        }
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("MLB API timeout"));
    });

    req.on("error", reject);
  });
}

async function syncMlbTeams(db) {
  try {
    const data = await fetchJson(mlb("/teams?sportId=1"));
    const teams = data.teams || [];

    teams.forEach(team => {
      const id = String(team.id);
      db.teams[id] = {
        ...(db.teams[id] || {}),
        id: team.id,
        name: team.name,
        abbreviation: team.abbreviation || "",
        stats: db.teams[id]?.stats || emptyStats()
      };
    });
  } catch (error) {
    logMessage(db, `Team sync skipped: ${error.message}`);
  }
}

async function fetchScheduleByDate(date) {
  const url = mlb(`/schedule?sportId=1&date=${date}&hydrate=probablePitcher,team,linescore`);
  const data = await fetchJson(url);
  return flattenSchedule(data).map(normalizeGame).filter(Boolean);
}

async function fetchScheduleRange(startDate, endDate) {
  const url = mlb(`/schedule?sportId=1&startDate=${startDate}&endDate=${endDate}&hydrate=probablePitcher,team,linescore`);
  const data = await fetchJson(url);
  return flattenSchedule(data).map(normalizeGame).filter(Boolean);
}

function flattenSchedule(data) {
  const dates = data?.dates || [];
  return dates.flatMap(day => day.games || []);
}

function normalizePitcher(pitcher) {
  if (!pitcher) return null;

  return {
    id: pitcher.id || null,
    name: pitcher.fullName || pitcher.name || "TBD",
    era: null,
    whip: null,
    strikeOuts: null,
    starts: null,
    kPerGame: null
  };
}

function normalizeGame(raw) {
  if (!raw || !raw.teams?.away?.team || !raw.teams?.home?.team) return null;

  const away = raw.teams.away;
  const home = raw.teams.home;

  const awayScore = away.score ?? raw.linescore?.teams?.away?.runs ?? null;
  const homeScore = home.score ?? raw.linescore?.teams?.home?.runs ?? null;

  return {
    gamePk: String(raw.gamePk),
    gameDate: raw.gameDate,
    officialDate: raw.officialDate || ymd(raw.gameDate),
    status: raw.status?.detailedState || raw.status?.abstractGameState || "Scheduled",
    venue: raw.venue?.name || "MLB",
    awayTeamId: away.team.id,
    awayTeamName: away.team.name,
    homeTeamId: home.team.id,
    homeTeamName: home.team.name,
    awayScore: awayScore == null ? null : Number(awayScore),
    homeScore: homeScore == null ? null : Number(homeScore),
    awayPitcher: normalizePitcher(away.probablePitcher),
    homePitcher: normalizePitcher(home.probablePitcher)
  };
}

async function hydratePitchers(games, db) {
  const season = currentSeason();
  const ids = new Map();

  games.forEach(game => {
    if (game.awayPitcher?.id) ids.set(String(game.awayPitcher.id), game.awayPitcher);
    if (game.homePitcher?.id) ids.set(String(game.homePitcher.id), game.homePitcher);
  });

  const statsById = {};

  await Promise.all(
    Array.from(ids.keys()).map(async id => {
      statsById[id] = await getPitcherSeasonStats(id, db, season);
    })
  );

  games.forEach(game => {
    if (game.awayPitcher?.id && statsById[String(game.awayPitcher.id)]) {
      game.awayPitcher = {
        ...game.awayPitcher,
        ...statsById[String(game.awayPitcher.id)]
      };
    }

    if (game.homePitcher?.id && statsById[String(game.homePitcher.id)]) {
      game.homePitcher = {
        ...game.homePitcher,
        ...statsById[String(game.homePitcher.id)]
      };
    }
  });
}

async function getPitcherSeasonStats(id, db, season) {
  const cacheKey = String(id);
  const cached = db.pitchers?.[cacheKey];
  const cachedAt = cached?.updatedAt ? new Date(cached.updatedAt).getTime() : 0;

  if (
    cached &&
    cached.season === season &&
    Date.now() - cachedAt < PITCHER_CACHE_MS
  ) {
    return cached.stats;
  }

  try {
    const url = mlb(`/people/${id}/stats?stats=season&group=pitching&season=${season}`);
    const data = await fetchJson(url, 15000);
    const stat = data?.stats?.[0]?.splits?.[0]?.stat || {};

    const starts = toNumber(stat.gamesStarted, toNumber(stat.gamesPlayed, 0));
    const strikeOuts = toNumber(stat.strikeOuts, null);

    const stats = {
      era: toNumber(stat.era, null),
      whip: toNumber(stat.whip, null),
      strikeOuts,
      starts,
      kPerGame: starts && strikeOuts != null ? strikeOuts / starts : null
    };

    db.pitchers[cacheKey] = {
      season,
      updatedAt: new Date().toISOString(),
      stats
    };

    return stats;
  } catch {
    return {
      era: null,
      whip: null,
      strikeOuts: null,
      starts: null,
      kPerGame: null
    };
  }
}

function emptyStats() {
  return {
    played: 0,
    wins: 0,
    losses: 0,
    winPct: 0.5,
    home: "0-0",
    away: "0-0",
    homeWinPct: 0.5,
    awayWinPct: 0.5,
    runsPerGame: 4.4,
    runsAllowedPerGame: 4.4,
    runDiffPerGame: 0,
    last10: "0-0",
    last10WinPct: 0.5,
    streak: "--",
    games: []
  };
}

function initTeamRecord(team) {
  return {
    id: team.id,
    name: team.name,
    abbreviation: team.abbreviation || "",
    stats: {
      played: 0,
      wins: 0,
      losses: 0,
      homeWins: 0,
      homeLosses: 0,
      awayWins: 0,
      awayLosses: 0,
      runsFor: 0,
      runsAgainst: 0,
      games: []
    }
  };
}

function isFinalGame(game) {
  const status = String(game.status || "").toLowerCase();

  return (
    status.includes("final") ||
    status.includes("completed") ||
    status.includes("game over")
  ) && game.awayScore != null && game.homeScore != null;
}

function buildTeamStats(db, recentGames) {
  const records = {};

  Object.values(db.teams || {}).forEach(team => {
    records[String(team.id)] = initTeamRecord(team);
  });

  recentGames.filter(isFinalGame).forEach(game => {
    const awayId = String(game.awayTeamId);
    const homeId = String(game.homeTeamId);

    if (!records[awayId]) {
      records[awayId] = initTeamRecord({
        id: game.awayTeamId,
        name: game.awayTeamName
      });
    }

    if (!records[homeId]) {
      records[homeId] = initTeamRecord({
        id: game.homeTeamId,
        name: game.homeTeamName
      });
    }

    const awayWon = game.awayScore > game.homeScore;
    const homeWon = game.homeScore > game.awayScore;

    applyTeamGame(records[awayId].stats, {
      date: game.officialDate,
      isHome: false,
      won: awayWon,
      runsFor: game.awayScore,
      runsAgainst: game.homeScore,
      opponentId: game.homeTeamId
    });

    applyTeamGame(records[homeId].stats, {
      date: game.officialDate,
      isHome: true,
      won: homeWon,
      runsFor: game.homeScore,
      runsAgainst: game.awayScore,
      opponentId: game.awayTeamId
    });
  });

  Object.values(records).forEach(record => {
    record.stats = finalizeTeamStats(record.stats);
    db.teams[String(record.id)] = record;
  });
}

function applyTeamGame(stats, game) {
  stats.played += 1;

  if (game.won) stats.wins += 1;
  else stats.losses += 1;

  if (game.isHome) {
    if (game.won) stats.homeWins += 1;
    else stats.homeLosses += 1;
  } else {
    if (game.won) stats.awayWins += 1;
    else stats.awayLosses += 1;
  }

  stats.runsFor += game.runsFor;
  stats.runsAgainst += game.runsAgainst;

  stats.games.push({
    date: game.date,
    won: game.won,
    runsFor: game.runsFor,
    runsAgainst: game.runsAgainst,
    opponentId: game.opponentId,
    isHome: game.isHome
  });
}

function finalizeTeamStats(raw) {
  const played = raw.played || 0;
  const homeTotal = (raw.homeWins || 0) + (raw.homeLosses || 0);
  const awayTotal = (raw.awayWins || 0) + (raw.awayLosses || 0);

  const games = (raw.games || [])
    .slice()
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));

  const last10 = games.slice(0, 10);
  const last10Wins = last10.filter(game => game.won).length;
  const last10Losses = last10.length - last10Wins;

  let streak = "--";

  if (games.length) {
    const first = games[0].won;
    let count = 0;

    for (const game of games) {
      if (game.won === first) count += 1;
      else break;
    }

    streak = `${first ? "W" : "L"}${count}`;
  }

  return {
    played,
    wins: raw.wins || 0,
    losses: raw.losses || 0,
    winPct: rate(raw.wins || 0, played, 0.5),
    home: `${raw.homeWins || 0}-${raw.homeLosses || 0}`,
    away: `${raw.awayWins || 0}-${raw.awayLosses || 0}`,
    homeWinPct: rate(raw.homeWins || 0, homeTotal, 0.5),
    awayWinPct: rate(raw.awayWins || 0, awayTotal, 0.5),
    runsPerGame: played ? raw.runsFor / played : 4.4,
    runsAllowedPerGame: played ? raw.runsAgainst / played : 4.4,
    runDiffPerGame: played ? (raw.runsFor - raw.runsAgainst) / played : 0,
    last10: `${last10Wins}-${last10Losses}`,
    last10WinPct: rate(last10Wins, last10.length, 0.5),
    streak,
    games
  };
}

function teamStats(db, id) {
  return db.teams?.[String(id)]?.stats || emptyStats();
}

function normalizedPitcherEraEdge(homePitcher, awayPitcher) {
  const homeEra = toNumber(homePitcher?.era, null);
  const awayEra = toNumber(awayPitcher?.era, null);

  if (homeEra == null || awayEra == null) return 0;

  return clamp((awayEra - homeEra) / 6, -1, 1);
}

function normalizedPitcherWhipEdge(homePitcher, awayPitcher) {
  const homeWhip = toNumber(homePitcher?.whip, null);
  const awayWhip = toNumber(awayPitcher?.whip, null);

  if (homeWhip == null || awayWhip == null) return 0;

  return clamp((awayWhip - homeWhip) / 2, -1, 1);
}

function normalizedPitcherStrikeoutEdge(homePitcher, awayPitcher) {
  const homeK = toNumber(homePitcher?.kPerGame, null);
  const awayK = toNumber(awayPitcher?.kPerGame, null);

  if (homeK == null || awayK == null) return 0;

  return clamp((homeK - awayK) / 12, -1, 1);
}

function h2hFeature(homeTeamId, awayTeamId, db) {
  const games = (db.recentGames || [])
    .filter(isFinalGame)
    .filter(game => {
      const teams = [String(game.homeTeamId), String(game.awayTeamId)];
      return teams.includes(String(homeTeamId)) && teams.includes(String(awayTeamId));
    })
    .slice(-10);

  if (!games.length) return 0;

  let homeWins = 0;
  let awayWins = 0;

  games.forEach(game => {
    const homeSideWon = game.homeScore > game.awayScore;
    const actualWinnerId = homeSideWon ? game.homeTeamId : game.awayTeamId;

    if (String(actualWinnerId) === String(homeTeamId)) homeWins += 1;
    if (String(actualWinnerId) === String(awayTeamId)) awayWins += 1;
  });

  return clamp((homeWins - awayWins) / games.length, -1, 1);
}

function calculateFeatures(game, db) {
  const home = teamStats(db, game.homeTeamId);
  const away = teamStats(db, game.awayTeamId);

  return {
    winPct: clamp((home.winPct || 0.5) - (away.winPct || 0.5), -1, 1),
    homeAway: clamp((home.homeWinPct || 0.5) - (away.awayWinPct || 0.5), -1, 1),
    rpg: clamp(((home.runsPerGame || 4.4) - (away.runsPerGame || 4.4)) / 5, -1, 1),
    rapg: clamp(((away.runsAllowedPerGame || 4.4) - (home.runsAllowedPerGame || 4.4)) / 5, -1, 1),
    runDiff: clamp(((home.runDiffPerGame || 0) - (away.runDiffPerGame || 0)) / 5, -1, 1),
    pitcherEra: normalizedPitcherEraEdge(game.homePitcher, game.awayPitcher),
    pitcherWhip: normalizedPitcherWhipEdge(game.homePitcher, game.awayPitcher),
    pitcherStrikeouts: normalizedPitcherStrikeoutEdge(game.homePitcher, game.awayPitcher),
    recentForm: clamp((home.last10WinPct || 0.5) - (away.last10WinPct || 0.5), -1, 1),
    h2h: h2hFeature(game.homeTeamId, game.awayTeamId, db)
  };
}

function weightedScore(features, weights) {
  let score = weights.bias || 0;

  Object.keys(features).forEach(key => {
    score += (weights[key] || 0) * (features[key] || 0);
  });

  return score;
}

function edgeTeam(value, game) {
  if (Math.abs(value || 0) < 0.035) return "Close";
  return value > 0 ? game.homeTeamName : game.awayTeamName;
}

function buildReasons(game, features) {
  const map = [
    ["winPct", "win rate edge"],
    ["homeAway", "better home/away split"],
    ["rpg", "scores more"],
    ["rapg", "allows fewer runs"],
    ["runDiff", "better run differential"],
    ["pitcherEra", "starter ERA edge"],
    ["pitcherWhip", "starter WHIP edge"],
    ["pitcherStrikeouts", "starter strikeout edge"],
    ["recentForm", "better recent form"],
    ["h2h", "head-to-head edge"]
  ];

  const reasons = map
    .map(([key, label]) => ({
      key,
      label,
      value: features[key] || 0,
      team: edgeTeam(features[key] || 0, game)
    }))
    .filter(item => item.team !== "Close")
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .slice(0, 5)
    .map(item => `${item.team} ${item.label}`);

  return reasons.length ? reasons : ["Very close matchup"];
}

function buildSourceReferences(game, features) {
  return Object.entries(features).map(([key, value]) => ({
    title: key,
    dataType: "calculated",
    value,
    edgeTeamName: edgeTeam(value, game)
  }));
}

function projectedScores(game, db, pickHome) {
  const home = teamStats(db, game.homeTeamId);
  const away = teamStats(db, game.awayTeamId);
  const leagueRuns = 4.4;

  let homeExpected =
    ((home.runsPerGame || leagueRuns) + (away.runsAllowedPerGame || leagueRuns)) / 2 + 0.15;

  let awayExpected =
    ((away.runsPerGame || leagueRuns) + (home.runsAllowedPerGame || leagueRuns)) / 2;

  const homeEra = toNumber(game.homePitcher?.era, null);
  const awayEra = toNumber(game.awayPitcher?.era, null);

  if (awayEra != null) homeExpected += clamp((awayEra - 4.2) * 0.16, -0.8, 0.8);
  if (homeEra != null) awayExpected += clamp((homeEra - 4.2) * 0.16, -0.8, 0.8);

  let homeScore = clamp(Math.round(homeExpected), 1, 11);
  let awayScore = clamp(Math.round(awayExpected), 1, 11);

  if (pickHome && homeScore <= awayScore) {
    homeScore = awayScore + 1;
  }

  if (!pickHome && awayScore <= homeScore) {
    awayScore = homeScore + 1;
  }

  return {
    projectedHomeScore: clamp(homeScore, 1, 12),
    projectedAwayScore: clamp(awayScore, 1, 12)
  };
}

function calculatePrediction(game, db) {
  const features = calculateFeatures(game, db);
  const score = weightedScore(features, db.model.weights);
  const pickHome = score >= 0;
  const confidence = clamp(
    Math.round(50 + Math.tanh(Math.abs(score) * 1.8) * 35),
    51,
    85
  );

  const scores = projectedScores(game, db, pickHome);

  return {
    id: String(game.gamePk),
    gamePk: String(game.gamePk),
    date: game.officialDate || ymd(game.gameDate),
    gameDate: game.gameDate,
    awayTeamId: game.awayTeamId,
    awayTeamName: game.awayTeamName,
    homeTeamId: game.homeTeamId,
    homeTeamName: game.homeTeamName,
    predictedWinnerTeamId: pickHome ? game.homeTeamId : game.awayTeamId,
    predictedWinnerName: pickHome ? game.homeTeamName : game.awayTeamName,
    confidence,
    projectedHomeScore: scores.projectedHomeScore,
    projectedAwayScore: scores.projectedAwayScore,
    features,
    reasons: buildReasons(game, features),
    sourceReferences: buildSourceReferences(game, features),
    locked: false,
    lateCreated: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function hasGameStarted(game) {
  const status = String(game.status || "").toLowerCase();

  if (
    status.includes("final") ||
    status.includes("live") ||
    status.includes("in progress") ||
    status.includes("delayed") ||
    status.includes("game over") ||
    status.includes("completed")
  ) {
    return true;
  }

  const start = new Date(game.gameDate).getTime();

  if (!Number.isFinite(start)) return false;

  return Date.now() >= start;
}

function upsertPrediction(game, db) {
  const index = db.predictions.findIndex(pred => String(pred.gamePk) === String(game.gamePk));
  const existing = index >= 0 ? db.predictions[index] : null;
  const started = hasGameStarted(game);

  if (existing && (existing.locked || existing.result || started)) {
    const updated = {
      ...existing,
      locked: true,
      status: game.status,
      updatedAt: new Date().toISOString()
    };

    db.predictions[index] = updated;
    return updated;
  }

  const calculated = calculatePrediction(game, db);

  const prediction = {
    ...(existing || {}),
    ...calculated,
    createdAt: existing?.createdAt || calculated.createdAt,
    result: existing?.result || null,
    locked: started,
    lateCreated: existing?.lateCreated || started,
    updatedAt: new Date().toISOString()
  };

  if (index >= 0) {
    db.predictions[index] = prediction;
  } else {
    db.predictions.push(prediction);
  }

  return prediction;
}

function syncPredictionsForGames(games, db) {
  games.forEach(game => {
    upsertPrediction(game, db);
  });
}

function attachPredictions(games, db) {
  return games.map(game => {
    const prediction = db.predictions.find(pred => String(pred.gamePk) === String(game.gamePk));

    return {
      ...game,
      prediction: prediction || null
    };
  });
}

function gradePredictions(db, finalGames) {
  const finalMap = new Map();

  finalGames.filter(isFinalGame).forEach(game => {
    finalMap.set(String(game.gamePk), game);
  });

  db.predictions.forEach(pred => {
    const finalGame = finalMap.get(String(pred.gamePk));
    if (!finalGame) return;

    const actualWinnerTeamId =
      finalGame.homeScore > finalGame.awayScore
        ? finalGame.homeTeamId
        : finalGame.awayTeamId;

    const actualWinnerName =
      String(actualWinnerTeamId) === String(finalGame.homeTeamId)
        ? finalGame.homeTeamName
        : finalGame.awayTeamName;

    const correct = String(actualWinnerTeamId) === String(pred.predictedWinnerTeamId);
    const counted = !pred.lateCreated;

    pred.locked = true;
    pred.result = {
      ...(pred.result || {}),
      finalAt: pred.result?.finalAt || new Date().toISOString(),
      awayScore: finalGame.awayScore,
      homeScore: finalGame.homeScore,
      actualWinnerTeamId,
      actualWinnerName,
      correct,
      counted,
      trained: pred.result?.trained || false
    };

    trainPrediction(db, pred);
  });
}

function trainPrediction(db, pred) {
  if (!pred.result) return;
  if (pred.result.counted === false) return;
  if (pred.result.trained) return;

  const actualHomeSign =
    String(pred.result.actualWinnerTeamId) === String(pred.homeTeamId) ? 1 : -1;

  const weights = db.model.weights;

  Object.keys(DEFAULT_WEIGHTS).forEach(key => {
    if (key === "bias") return;

    const featureValue = Number(pred.features?.[key] || 0);
    weights[key] = clamp((weights[key] || 0) + LEARN_RATE * actualHomeSign * featureValue, -2.5, 2.5);
  });

  weights.bias = clamp((weights.bias || 0) + LEARN_RATE * actualHomeSign * 0.05, -0.5, 0.5);

  pred.result.trained = true;
  db.model.trainedGames = db.predictions.filter(item => item.result?.trained).length;
  db.model.lastTrainedAt = new Date().toISOString();
}

function accuracyStats(db) {
  const graded = db.predictions.filter(pred => pred.result);
  const counted = graded.filter(pred => pred.result.counted !== false);
  const excluded = graded.filter(pred => pred.result.counted === false);
  const correct = counted.filter(pred => pred.result.correct);

  return {
    accuracy: counted.length ? Math.round((correct.length / counted.length) * 100) : null,
    correct: correct.length,
    total: counted.length,
    excluded: excluded.length,
    graded: graded.length
  };
}

function cleanupDb(db) {
  db.predictions = db.predictions
    .slice()
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))
    .slice(0, 800);

  db.recentGames = db.recentGames
    .slice()
    .sort((a, b) => String(b.officialDate || "").localeCompare(String(a.officialDate || "")))
    .slice(0, 900);
}

function buildDashboard(db) {
  const teams = Object.values(db.teams || {})
    .map(team => ({
      ...team,
      stats: team.stats || emptyStats()
    }))
    .sort((a, b) => {
      const aw = Number(a.stats?.winPct || 0);
      const bw = Number(b.stats?.winPct || 0);
      return bw - aw;
    });

  const predictions = (db.predictions || [])
    .slice()
    .sort((a, b) => {
      const dateCompare = String(b.date || "").localeCompare(String(a.date || ""));
      if (dateCompare !== 0) return dateCompare;
      return Number(b.confidence || 0) - Number(a.confidence || 0);
    });

  return {
    date: db.meta.currentDate || ymd(),
    tomorrow: db.meta.tomorrowDate || addDays(ymd(), 1),
    todayGames: db.meta.todayGames || [],
    tomorrowGames: db.meta.tomorrowGames || [],
    teams,
    predictions,
    accuracy: accuracyStats(db),
    model: db.model,
    logs: db.logs || []
  };
}

async function fullAutoSync() {
  const db = readDb();

  const today = ymd();
  const tomorrow = addDays(today, 1);
  const startDate = addDays(today, -28);

  await syncMlbTeams(db);

  const recentGames = await fetchScheduleRange(startDate, today);
  const finalRecentGames = recentGames.filter(isFinalGame);

  db.recentGames = finalRecentGames;

  buildTeamStats(db, finalRecentGames);

  const todayGames = await fetchScheduleByDate(today);
  const tomorrowGames = await fetchScheduleByDate(tomorrow);

  await hydratePitchers([...todayGames, ...tomorrowGames], db);

  syncPredictionsForGames([...todayGames, ...tomorrowGames], db);
  gradePredictions(db, [...finalRecentGames, ...todayGames, ...tomorrowGames]);

  const todayWithPredictions = attachPredictions(todayGames, db);
  const tomorrowWithPredictions = attachPredictions(tomorrowGames, db);

  db.meta = {
    ...(db.meta || {}),
    currentDate: today,
    tomorrowDate: tomorrow,
    todayGames: todayWithPredictions,
    tomorrowGames: tomorrowWithPredictions,
    lastFullSync: new Date().toISOString(),
    dataDir: DATA_DIR
  };

  cleanupDb(db);
  logMessage(db, `Full sync complete: ${todayGames.length} today games, ${tomorrowGames.length} tomorrow games.`);
  saveDb(db);

  return buildDashboard(db);
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });

  res.end(JSON.stringify(payload, null, 2));
}

function sendText(res, status, text) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8"
  });

  res.end(text);
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon"
  }[ext] || "application/octet-stream";
}

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);

  if (pathname === "/") pathname = "/index.html";

  const relativePath = pathname.replace(/^\/+/, "");
  const filePath = path.join(PUBLIC_DIR, relativePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendText(res, 404, "Not found");
      return;
    }

    res.writeHead(200, {
      "Content-Type": mimeType(filePath),
      "Cache-Control": filePath.endsWith(".html") ? "no-store" : "public, max-age=60"
    });

    res.end(data);
  });
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/dashboard") {
    const db = readDb();
    sendJson(res, 200, {
      ok: true,
      dashboard: buildDashboard(db)
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/sync") {
    const dashboard = await fullAutoSync();
    sendJson(res, 200, {
      ok: true,
      dashboard
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/recalculate") {
    const dashboard = await fullAutoSync();
    sendJson(res, 200, {
      ok: true,
      message: "Recalculated from latest automatic data.",
      dashboard
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/export") {
    const db = readDb();

    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": "attachment; filename=\"mlb-edge-db.json\"",
      "Cache-Control": "no-store"
    });

    res.end(JSON.stringify(db, null, 2));
    return;
  }

  if (req.method === "POST" && ["/api/injuries", "/api/references"].includes(url.pathname)) {
    sendJson(res, 200, {
      ok: false,
      disabled: true,
      message: "Manual inputs are disabled. This build is automatic-only."
    });
    return;
  }

  sendJson(res, 404, {
    ok: false,
    error: "API route not found"
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    serveStatic(req, res, url);
  } catch (error) {
    console.error(error);

    try {
      const db = readDb();
      logMessage(db, `Server error: ${error.message}`);
      saveDb(db);
    } catch {
      // Ignore secondary logging error.
    }

    sendJson(res, 500, {
      ok: false,
      error: error.message || "Server error"
    });
  }
});

server.listen(PORT, () => {
  console.log(`MLB Edge Tracker running on port ${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
  console.log(`Open: ${FRONTEND_URL}`);
});

fullAutoSync().catch(error => {
  console.error("Initial sync failed:", error.message);

  try {
    const db = readDb();
    logMessage(db, `Initial sync failed: ${error.message}`);
    saveDb(db);
  } catch {
    // Ignore.
  }
});

setInterval(() => {
  fullAutoSync().catch(error => {
    console.error("Background sync failed:", error.message);

    try {
      const db = readDb();
      logMessage(db, `Background sync failed: ${error.message}`);
      saveDb(db);
    } catch {
      // Ignore.
    }
  });
}, SYNC_INTERVAL_MS);
