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

const ENGINE_VERSION = "qualified-picks-optimizer-factortrust-v1";
const SYNC_INTERVAL_MS = 60 * 60 * 1000;
const PITCHER_CACHE_MS = 6 * 60 * 60 * 1000;
const HISTORY_DAYS = 120;
const BACKTEST_TRAINING_LIMIT = 420;
const LEARN_RATE = 0.024;

const FACTOR_TRUST_MIN_SUPPORT = 10;
const FACTOR_MUTE_ACCURACY = 46;
const FACTOR_REDUCE_ACCURACY = 50;
const FACTOR_BOOST_ACCURACY = 60;

const DEFAULT_QUALIFY_RULES = {
  minConfidence: 58,
  minEdgeScore: 2,
  minSupport: 5,
  maxAgainst: 8,
  requirePitcherSignal: false,
  requireLineupSignal: false
};

const OPTIMIZER_MIN_SAMPLE = 30;

const DEFAULT_WEIGHTS = {
  bias: 0.035,

  winPct: 0.62,
  homeAway: 0.38,
  rpg: 0.48,
  rapg: 0.52,
  runDiff: 0.65,

  recent7WinPct: 0.62,
  recent15WinPct: 0.5,
  recent30WinPct: 0.32,
  recent7Runs: 0.42,
  recent7Prevent: 0.45,
  recentRunDiff: 0.52,
  streakEdge: 0.14,

  pitcherEra: 0.36,
  pitcherWhip: 0.31,
  pitcherStrikeouts: 0.16,
  pitcherRecentEra: 0.42,
  pitcherRecentWhip: 0.34,
  pitcherRecentK: 0.16,

  handednessSplit: 0.22,
  lineupStrength: 0.28,

  h2h: 0.1,
  restEdge: 0.18,
  bullpenFatigue: 0.26
};

function defaultFactorTrust() {
  const trust = {};

  Object.keys(DEFAULT_WEIGHTS).forEach(key => {
    if (key === "bias") return;

    trust[key] = {
      trust: 1,
      muted: false,
      status: "Learning",
      supports: 0,
      correct: 0,
      wrong: 0,
      accuracy: null
    };
  });

  return trust;
}

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
    meta: {
      engineVersion: ENGINE_VERSION,
      optimizedRules: { ...DEFAULT_QUALIFY_RULES },
      factorTrust: defaultFactorTrust(),
      mutedFactors: [],
      factorTrustReport: null
    }
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
    meta: {
      ...(clean.meta || {}),
      optimizedRules: {
        ...DEFAULT_QUALIFY_RULES,
        ...((clean.meta && clean.meta.optimizedRules) || {})
      },
      factorTrust: {
        ...defaultFactorTrust(),
        ...((clean.meta && clean.meta.factorTrust) || {})
      },
      mutedFactors: Array.isArray(clean.meta?.mutedFactors) ? clean.meta.mutedFactors : []
    }
  };
}

function logMessage(db, message) {
  db.logs = db.logs || [];
  db.logs.unshift({
    at: new Date().toISOString(),
    message
  });
  db.logs = db.logs.slice(0, 120);
}

function maybeUpgradeEngine(db) {
  if (db.meta?.engineVersion === ENGINE_VERSION) return false;

  db.predictions = [];
  db.model = {
    weights: { ...DEFAULT_WEIGHTS },
    trainedGames: 0,
    lastTrainedAt: null
  };

  db.meta = {
    ...(db.meta || {}),
    engineVersion: ENGINE_VERSION,
    optimizedRules: { ...DEFAULT_QUALIFY_RULES },
    optimizerReport: null,
    factorReport: {},
    factorTrust: defaultFactorTrust(),
    mutedFactors: [],
    factorTrustReport: null,
    engineResetAt: new Date().toISOString()
  };

  logMessage(db, `Engine upgraded to ${ENGINE_VERSION}. Old predictions and weights reset.`);
  return true;
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

function fetchJson(url, timeoutMs = 30000) {
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

function parseInnings(value) {
  if (value == null) return 0;

  const text = String(value);
  const [wholeRaw, partialRaw] = text.split(".");
  const whole = Number(wholeRaw || 0);
  const partial = Number(partialRaw || 0);

  if (!Number.isFinite(whole)) return 0;
  if (partial === 1) return whole + 1 / 3;
  if (partial === 2) return whole + 2 / 3;

  return whole;
}

async function syncMlbTeams(db) {
  const data = await fetchJson(mlb("/teams?sportId=1"));
  const teams = data.teams || [];

  teams.forEach(team => {
    const id = String(team.id);

    db.teams[id] = {
      ...(db.teams[id] || {}),
      id: team.id,
      name: team.name,
      abbreviation: team.abbreviation || "",
      stats: db.teams[id]?.stats || emptyStats(),
      battingSplits: db.teams[id]?.battingSplits || null
    };
  });
}

async function syncTeamBattingSplits(db) {
  const season = currentSeason();
  const teams = Object.values(db.teams || {});

  await Promise.all(
    teams.map(async team => {
      try {
        const url = mlb(`/teams/${team.id}/stats?stats=season&group=hitting&season=${season}&splits=pitchingHand`);
        const data = await fetchJson(url, 18000);
        const splits = data?.stats?.[0]?.splits || [];

        const parsed = {
          R: null,
          L: null
        };

        splits.forEach(split => {
          const stat = split.stat || {};
          const splitText = JSON.stringify(split.split || {}).toLowerCase();
          const ops = toNumber(stat.ops, null);
          const obp = toNumber(stat.obp, null);
          const slg = toNumber(stat.slg, null);
          const usableOps = ops != null ? ops : obp != null && slg != null ? obp + slg : null;

          if (usableOps == null) return;

          if (splitText.includes("right") || splitText.includes("\"r\"")) {
            parsed.R = {
              ops: usableOps,
              avg: toNumber(stat.avg, null),
              runs: toNumber(stat.runs, null)
            };
          }

          if (splitText.includes("left") || splitText.includes("\"l\"")) {
            parsed.L = {
              ops: usableOps,
              avg: toNumber(stat.avg, null),
              runs: toNumber(stat.runs, null)
            };
          }
        });

        db.teams[String(team.id)].battingSplits = parsed;
      } catch {
        // Split data is optional.
      }
    })
  );
}

async function fetchScheduleByDate(date) {
  const url = mlb(`/schedule?sportId=1&date=${date}&hydrate=probablePitcher,team,linescore,weather`);
  const data = await fetchJson(url);
  return flattenSchedule(data).map(normalizeGame).filter(Boolean);
}

async function fetchScheduleRange(startDate, endDate) {
  const url = mlb(`/schedule?sportId=1&startDate=${startDate}&endDate=${endDate}&hydrate=probablePitcher,team,linescore,weather`);
  const data = await fetchJson(url, 45000);
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
    pitchHand: pitcher.pitchHand?.code || pitcher.pitchHand || null,
    era: null,
    whip: null,
    strikeOuts: null,
    starts: null,
    kPerGame: null,
    recentEra: null,
    recentWhip: null,
    recentKPerGame: null,
    recentGamesUsed: 0
  };
}

function normalizeWeather(weather) {
  if (!weather) {
    return {
      condition: null,
      tempF: null,
      windMph: null,
      raw: null
    };
  }

  const raw = JSON.stringify(weather);
  const tempText = String(weather.temp || weather.temperature || "");
  const windText = String(weather.wind || "");

  const tempMatch = tempText.match(/-?\d+/);
  const windMatch = windText.match(/-?\d+/);

  return {
    condition: weather.condition || weather.conditions || null,
    tempF: tempMatch ? Number(tempMatch[0]) : null,
    windMph: windMatch ? Number(windMatch[0]) : null,
    raw
  };
}

function normalizeGame(raw) {
  if (!raw || !raw.teams?.away?.team || !raw.teams?.home?.team) return null;

  const away = raw.teams.away;
  const home = raw.teams.home;

  const awayScore = away.score ?? raw.linescore?.teams?.away?.runs ?? null;
  const homeScore = home.score ?? raw.linescore?.teams?.home?.runs ?? null;

  const inningCount = Array.isArray(raw.linescore?.innings)
    ? raw.linescore.innings.length
    : 9;

  return {
    gamePk: String(raw.gamePk),
    gameDate: raw.gameDate,
    officialDate: raw.officialDate || ymd(raw.gameDate),
    status: raw.status?.detailedState || raw.status?.abstractGameState || "Scheduled",
    venue: raw.venue?.name || "MLB",
    weather: normalizeWeather(raw.weather),
    awayTeamId: away.team.id,
    awayTeamName: away.team.name,
    homeTeamId: home.team.id,
    homeTeamName: home.team.name,
    awayScore: awayScore == null ? null : Number(awayScore),
    homeScore: homeScore == null ? null : Number(homeScore),
    inningCount,
    awayPitcher: normalizePitcher(away.probablePitcher),
    homePitcher: normalizePitcher(home.probablePitcher),
    awayLineup: null,
    homeLineup: null
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
      statsById[id] = await getPitcherStats(id, db, season);
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

async function getPitcherStats(id, db, season) {
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

  const baseStats = {
    pitchHand: null,
    era: null,
    whip: null,
    strikeOuts: null,
    starts: null,
    kPerGame: null,
    recentEra: null,
    recentWhip: null,
    recentKPerGame: null,
    recentGamesUsed: 0
  };

  try {
    const personData = await fetchJson(mlb(`/people/${id}`), 15000);
    const person = personData?.people?.[0];

    if (person?.pitchHand?.code) {
      baseStats.pitchHand = person.pitchHand.code;
    }
  } catch {
    // Optional.
  }

  try {
    const seasonUrl = mlb(`/people/${id}/stats?stats=season&group=pitching&season=${season}`);
    const seasonData = await fetchJson(seasonUrl, 18000);
    const stat = seasonData?.stats?.[0]?.splits?.[0]?.stat || {};

    const starts = toNumber(stat.gamesStarted, toNumber(stat.gamesPlayed, 0));
    const strikeOuts = toNumber(stat.strikeOuts, null);

    baseStats.era = toNumber(stat.era, null);
    baseStats.whip = toNumber(stat.whip, null);
    baseStats.strikeOuts = strikeOuts;
    baseStats.starts = starts;
    baseStats.kPerGame = starts && strikeOuts != null ? strikeOuts / starts : null;
  } catch {
    // Optional.
  }

  try {
    const logUrl = mlb(`/people/${id}/stats?stats=gameLog&group=pitching&season=${season}`);
    const logData = await fetchJson(logUrl, 18000);
    const splits = logData?.stats?.[0]?.splits || [];

    const recent = splits
      .slice()
      .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))
      .slice(0, 5);

    let innings = 0;
    let earnedRuns = 0;
    let hits = 0;
    let walks = 0;
    let strikeouts = 0;

    recent.forEach(split => {
      const stat = split.stat || {};

      innings += parseInnings(stat.inningsPitched);
      earnedRuns += toNumber(stat.earnedRuns, 0);
      hits += toNumber(stat.hits, 0);
      walks += toNumber(stat.baseOnBalls, 0);
      strikeouts += toNumber(stat.strikeOuts, 0);
    });

    if (innings > 0 && recent.length) {
      baseStats.recentEra = (earnedRuns * 9) / innings;
      baseStats.recentWhip = (hits + walks) / innings;
      baseStats.recentKPerGame = strikeouts / recent.length;
      baseStats.recentGamesUsed = recent.length;
    }
  } catch {
    // Optional.
  }

  db.pitchers[cacheKey] = {
    season,
    updatedAt: new Date().toISOString(),
    stats: baseStats
  };

  return baseStats;
}

async function hydrateLineups(games) {
  await Promise.all(
    games.map(async game => {
      try {
        const data = await fetchJson(mlb(`/game/${game.gamePk}/boxscore`), 18000);

        game.awayLineup = parseLineup(data?.teams?.away);
        game.homeLineup = parseLineup(data?.teams?.home);
      } catch {
        game.awayLineup = null;
        game.homeLineup = null;
      }
    })
  );
}

function parseLineup(teamBox) {
  if (!teamBox || !teamBox.players) return null;

  const playerIds = Object.keys(teamBox.players);
  const batters = [];

  playerIds.forEach(key => {
    const player = teamBox.players[key];
    const battingOrder = player?.battingOrder;

    if (!battingOrder) return;

    const stat = player?.seasonStats?.batting || {};
    const ops = toNumber(stat.ops, null);
    const obp = toNumber(stat.obp, null);
    const slg = toNumber(stat.slg, null);
    const usableOps = ops != null ? ops : obp != null && slg != null ? obp + slg : null;

    batters.push({
      name: player?.person?.fullName || "Batter",
      battingOrder: Number(battingOrder),
      ops: usableOps
    });
  });

  const ordered = batters
    .filter(batter => Number.isFinite(batter.battingOrder))
    .sort((a, b) => a.battingOrder - b.battingOrder)
    .slice(0, 9);

  const opsValues = ordered
    .map(batter => batter.ops)
    .filter(value => Number.isFinite(value));

  if (!ordered.length || opsValues.length < 6) {
    return {
      announced: false,
      hitters: ordered,
      avgOps: null
    };
  }

  return {
    announced: true,
    hitters: ordered,
    avgOps: opsValues.reduce((sum, value) => sum + value, 0) / opsValues.length
  };
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
    last7: "0-0",
    last15: "0-0",
    last30: "0-0",
    last10: "0-0",
    last7WinPct: 0.5,
    last15WinPct: 0.5,
    last30WinPct: 0.5,
    last7RunsPerGame: 4.4,
    last7RunsAllowedPerGame: 4.4,
    last15RunDiffPerGame: 0,
    streak: "--",
    games: []
  };
}

function initTeamRecord(team) {
  return {
    id: team.id,
    name: team.name,
    abbreviation: team.abbreviation || "",
    battingSplits: team.battingSplits || null,
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
      opponentId: game.homeTeamId,
      venue: game.venue,
      inningCount: game.inningCount || 9
    });

    applyTeamGame(records[homeId].stats, {
      date: game.officialDate,
      isHome: true,
      won: homeWon,
      runsFor: game.homeScore,
      runsAgainst: game.awayScore,
      opponentId: game.awayTeamId,
      venue: game.venue,
      inningCount: game.inningCount || 9
    });
  });

  Object.values(records).forEach(record => {
    record.stats = finalizeTeamStats(record.stats);

    db.teams[String(record.id)] = {
      ...(db.teams[String(record.id)] || {}),
      ...record
    };
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
    isHome: game.isHome,
    venue: game.venue,
    inningCount: game.inningCount || 9
  });
}

function rollingStats(games, count) {
  const sample = games.slice(0, count);
  const wins = sample.filter(game => game.won).length;
  const losses = sample.length - wins;
  const runsFor = sample.reduce((sum, game) => sum + Number(game.runsFor || 0), 0);
  const runsAgainst = sample.reduce((sum, game) => sum + Number(game.runsAgainst || 0), 0);

  return {
    text: `${wins}-${losses}`,
    games: sample.length,
    wins,
    losses,
    winPct: rate(wins, sample.length, 0.5),
    runsPerGame: sample.length ? runsFor / sample.length : 4.4,
    runsAllowedPerGame: sample.length ? runsAgainst / sample.length : 4.4,
    runDiffPerGame: sample.length ? (runsFor - runsAgainst) / sample.length : 0
  };
}

function finalizeTeamStats(raw) {
  const played = raw.played || 0;
  const homeTotal = (raw.homeWins || 0) + (raw.homeLosses || 0);
  const awayTotal = (raw.awayWins || 0) + (raw.awayLosses || 0);

  const games = (raw.games || [])
    .slice()
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));

  const last7 = rollingStats(games, 7);
  const last10 = rollingStats(games, 10);
  const last15 = rollingStats(games, 15);
  const last30 = rollingStats(games, 30);

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

    last7: last7.text,
    last10: last10.text,
    last15: last15.text,
    last30: last30.text,

    last7WinPct: last7.winPct,
    last15WinPct: last15.winPct,
    last30WinPct: last30.winPct,

    last7RunsPerGame: last7.runsPerGame,
    last7RunsAllowedPerGame: last7.runsAllowedPerGame,
    last15RunDiffPerGame: last15.runDiffPerGame,

    streak,
    games
  };
}

function teamStats(db, id) {
  return db.teams?.[String(id)]?.stats || emptyStats();
}

function factorTrustInfo(db, key) {
  return db.meta?.factorTrust?.[key] || defaultFactorTrust()[key] || {
    trust: 1,
    muted: false
  };
}

function isFactorMuted(db, key) {
  return Boolean(factorTrustInfo(db, key)?.muted);
}

function effectiveWeight(db, key) {
  const base = Number(db.model?.weights?.[key] || 0);

  if (key === "bias") return base;

  const info = factorTrustInfo(db, key);

  if (info.muted) return 0;

  const trust = Number(info.trust);

  if (!Number.isFinite(trust)) return base;

  return base * clamp(trust, 0, 1.25);
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

function normalizedPitcherRecentEraEdge(homePitcher, awayPitcher) {
  const homeEra = toNumber(homePitcher?.recentEra, null);
  const awayEra = toNumber(awayPitcher?.recentEra, null);

  if (homeEra == null || awayEra == null) return 0;
  return clamp((awayEra - homeEra) / 6, -1, 1);
}

function normalizedPitcherRecentWhipEdge(homePitcher, awayPitcher) {
  const homeWhip = toNumber(homePitcher?.recentWhip, null);
  const awayWhip = toNumber(awayPitcher?.recentWhip, null);

  if (homeWhip == null || awayWhip == null) return 0;
  return clamp((awayWhip - homeWhip) / 2, -1, 1);
}

function normalizedPitcherRecentKEdge(homePitcher, awayPitcher) {
  const homeK = toNumber(homePitcher?.recentKPerGame, null);
  const awayK = toNumber(awayPitcher?.recentKPerGame, null);

  if (homeK == null || awayK == null) return 0;
  return clamp((homeK - awayK) / 12, -1, 1);
}

function handednessSplitFeature(game, db) {
  const homePitchHand = game.homePitcher?.pitchHand;
  const awayPitchHand = game.awayPitcher?.pitchHand;

  const homeSplit = db.teams?.[String(game.homeTeamId)]?.battingSplits?.[awayPitchHand];
  const awaySplit = db.teams?.[String(game.awayTeamId)]?.battingSplits?.[homePitchHand];

  const homeOps = toNumber(homeSplit?.ops, null);
  const awayOps = toNumber(awaySplit?.ops, null);

  if (homeOps == null || awayOps == null) return 0;

  return clamp((homeOps - awayOps) / 0.35, -1, 1);
}

function lineupStrengthFeature(game) {
  const homeOps = toNumber(game.homeLineup?.avgOps, null);
  const awayOps = toNumber(game.awayLineup?.avgOps, null);

  if (homeOps == null || awayOps == null) return 0;

  return clamp((homeOps - awayOps) / 0.35, -1, 1);
}

function h2hFeature(homeTeamId, awayTeamId, db) {
  const games = (db.recentGames || [])
    .filter(isFinalGame)
    .filter(game => {
      const teams = [String(game.homeTeamId), String(game.awayTeamId)];
      return teams.includes(String(homeTeamId)) && teams.includes(String(awayTeamId));
    })
    .slice(-12);

  if (!games.length) return 0;

  let homeWins = 0;
  let awayWins = 0;

  games.forEach(game => {
    const actualWinnerId = game.homeScore > game.awayScore ? game.homeTeamId : game.awayTeamId;

    if (String(actualWinnerId) === String(homeTeamId)) homeWins += 1;
    if (String(actualWinnerId) === String(awayTeamId)) awayWins += 1;
  });

  return clamp((homeWins - awayWins) / games.length, -1, 1);
}

function daysBetween(a, b) {
  const one = new Date(`${a}T12:00:00Z`).getTime();
  const two = new Date(`${b}T12:00:00Z`).getTime();

  if (!Number.isFinite(one) || !Number.isFinite(two)) return 0;
  return Math.round((two - one) / (24 * 60 * 60 * 1000));
}

function restDaysForTeam(teamId, beforeDate, db) {
  const games = (db.recentGames || [])
    .filter(isFinalGame)
    .filter(game => {
      return String(game.homeTeamId) === String(teamId) || String(game.awayTeamId) === String(teamId);
    })
    .filter(game => String(game.officialDate) < String(beforeDate))
    .sort((a, b) => String(b.officialDate).localeCompare(String(a.officialDate)));

  if (!games.length) return 3;

  return clamp(daysBetween(games[0].officialDate, beforeDate), 0, 5);
}

function teamRunsAllowedInGame(game, teamId) {
  if (String(game.homeTeamId) === String(teamId)) return Number(game.awayScore || 0);
  if (String(game.awayTeamId) === String(teamId)) return Number(game.homeScore || 0);
  return 0;
}

function estimateBullpenFatigue(teamId, beforeDate, db) {
  const games = (db.recentGames || [])
    .filter(isFinalGame)
    .filter(game => {
      return String(game.homeTeamId) === String(teamId) || String(game.awayTeamId) === String(teamId);
    })
    .filter(game => {
      const diff = daysBetween(game.officialDate, beforeDate);
      return diff >= 1 && diff <= 3;
    });

  let fatigue = 0;

  games.forEach(game => {
    const diff = daysBetween(game.officialDate, beforeDate);

    if (diff === 1) fatigue += 0.18;
    if (diff === 2) fatigue += 0.1;
    if (diff === 3) fatigue += 0.05;

    if (Number(game.inningCount || 9) > 9) fatigue += 0.12;

    const allowed = teamRunsAllowedInGame(game, teamId);
    if (allowed >= 6) fatigue += 0.04;
    if (allowed >= 9) fatigue += 0.04;
  });

  return clamp(fatigue, 0, 1);
}

function streakValue(streak) {
  const text = String(streak || "");
  const type = text[0];
  const count = Number(text.slice(1));

  if (!Number.isFinite(count)) return 0;

  if (type === "W") return clamp(count / 8, 0, 1);
  if (type === "L") return clamp(-count / 8, -1, 0);

  return 0;
}

function parkRunAdjustment(venue, db) {
  const games = (db.recentGames || [])
    .filter(isFinalGame)
    .filter(game => game.venue === venue);

  const allGames = (db.recentGames || []).filter(isFinalGame);

  if (games.length < 8 || allGames.length < 20) return 0;

  const venueAvg =
    games.reduce((sum, game) => sum + Number(game.awayScore || 0) + Number(game.homeScore || 0), 0) / games.length;

  const leagueAvg =
    allGames.reduce((sum, game) => sum + Number(game.awayScore || 0) + Number(game.homeScore || 0), 0) / allGames.length;

  return clamp((venueAvg - leagueAvg) / 4, -0.7, 0.7);
}

function weatherRunAdjustment(weather) {
  if (!weather) return 0;

  let boost = 0;

  const temp = toNumber(weather.tempF, null);
  const wind = toNumber(weather.windMph, null);
  const condition = String(weather.condition || "").toLowerCase();

  if (temp != null && temp >= 82) boost += 0.15;
  if (temp != null && temp <= 50) boost -= 0.12;
  if (wind != null && wind >= 12) boost += 0.08;
  if (condition.includes("rain") || condition.includes("drizzle")) boost -= 0.1;

  return clamp(boost, -0.35, 0.35);
}

function calculateFeatures(game, db) {
  const home = teamStats(db, game.homeTeamId);
  const away = teamStats(db, game.awayTeamId);
  const gameDate = game.officialDate || ymd(game.gameDate);

  const homeRest = restDaysForTeam(game.homeTeamId, gameDate, db);
  const awayRest = restDaysForTeam(game.awayTeamId, gameDate, db);

  const homeFatigue = estimateBullpenFatigue(game.homeTeamId, gameDate, db);
  const awayFatigue = estimateBullpenFatigue(game.awayTeamId, gameDate, db);

  return {
    winPct: clamp((home.winPct || 0.5) - (away.winPct || 0.5), -1, 1),
    homeAway: clamp((home.homeWinPct || 0.5) - (away.awayWinPct || 0.5), -1, 1),
    rpg: clamp(((home.runsPerGame || 4.4) - (away.runsPerGame || 4.4)) / 5, -1, 1),
    rapg: clamp(((away.runsAllowedPerGame || 4.4) - (home.runsAllowedPerGame || 4.4)) / 5, -1, 1),
    runDiff: clamp(((home.runDiffPerGame || 0) - (away.runDiffPerGame || 0)) / 5, -1, 1),

    recent7WinPct: clamp((home.last7WinPct || 0.5) - (away.last7WinPct || 0.5), -1, 1),
    recent15WinPct: clamp((home.last15WinPct || 0.5) - (away.last15WinPct || 0.5), -1, 1),
    recent30WinPct: clamp((home.last30WinPct || 0.5) - (away.last30WinPct || 0.5), -1, 1),
    recent7Runs: clamp(((home.last7RunsPerGame || 4.4) - (away.last7RunsPerGame || 4.4)) / 5, -1, 1),
    recent7Prevent: clamp(((away.last7RunsAllowedPerGame || 4.4) - (home.last7RunsAllowedPerGame || 4.4)) / 5, -1, 1),
    recentRunDiff: clamp(((home.last15RunDiffPerGame || 0) - (away.last15RunDiffPerGame || 0)) / 5, -1, 1),
    streakEdge: clamp(streakValue(home.streak) - streakValue(away.streak), -1, 1),

    pitcherEra: normalizedPitcherEraEdge(game.homePitcher, game.awayPitcher),
    pitcherWhip: normalizedPitcherWhipEdge(game.homePitcher, game.awayPitcher),
    pitcherStrikeouts: normalizedPitcherStrikeoutEdge(game.homePitcher, game.awayPitcher),
    pitcherRecentEra: normalizedPitcherRecentEraEdge(game.homePitcher, game.awayPitcher),
    pitcherRecentWhip: normalizedPitcherRecentWhipEdge(game.homePitcher, game.awayPitcher),
    pitcherRecentK: normalizedPitcherRecentKEdge(game.homePitcher, game.awayPitcher),

    handednessSplit: handednessSplitFeature(game, db),
    lineupStrength: lineupStrengthFeature(game),

    h2h: h2hFeature(game.homeTeamId, game.awayTeamId, db),
    restEdge: clamp((homeRest - awayRest) / 5, -1, 1),
    bullpenFatigue: clamp(awayFatigue - homeFatigue, -1, 1)
  };
}

function weightedScore(features, db) {
  let score = effectiveWeight(db, "bias");

  Object.keys(features).forEach(key => {
    score += effectiveWeight(db, key) * (features[key] || 0);
  });

  return score;
}

function supportSummary(features, pickHome, db) {
  let support = 0;
  let against = 0;
  let close = 0;

  Object.entries(features).forEach(([key, value]) => {
    if (isFactorMuted(db, key)) {
      close += 1;
      return;
    }

    const n = Number(value || 0);

    if (Math.abs(n) < 0.04) {
      close += 1;
      return;
    }

    const supportsHome = n > 0;

    if (supportsHome === pickHome) support += 1;
    else against += 1;
  });

  return {
    support,
    against,
    close,
    edgeScore: support - against
  };
}

function getQualificationRules(db) {
  return {
    ...DEFAULT_QUALIFY_RULES,
    ...((db.meta && db.meta.optimizedRules) || {})
  };
}

function hasPitcherSignal(features) {
  return [
    features.pitcherEra,
    features.pitcherWhip,
    features.pitcherStrikeouts,
    features.pitcherRecentEra,
    features.pitcherRecentWhip,
    features.pitcherRecentK
  ].some(value => Math.abs(Number(value || 0)) >= 0.04);
}

function hasLineupSignal(features) {
  return Math.abs(Number(features.lineupStrength || 0)) >= 0.04 ||
    Math.abs(Number(features.handednessSplit || 0)) >= 0.04;
}

function ruleCandidateList() {
  const candidates = [];

  const confidenceOptions = [56, 58, 60, 62, 64];
  const edgeOptions = [1, 2, 3, 4, 5];
  const supportOptions = [4, 5, 6, 7];
  const againstOptions = [4, 5, 6, 7, 8];

  confidenceOptions.forEach(minConfidence => {
    edgeOptions.forEach(minEdgeScore => {
      supportOptions.forEach(minSupport => {
        againstOptions.forEach(maxAgainst => {
          candidates.push({
            minConfidence,
            minEdgeScore,
            minSupport,
            maxAgainst,
            requirePitcherSignal: false,
            requireLineupSignal: false
          });

          candidates.push({
            minConfidence,
            minEdgeScore,
            minSupport,
            maxAgainst,
            requirePitcherSignal: true,
            requireLineupSignal: false
          });

          candidates.push({
            minConfidence,
            minEdgeScore,
            minSupport,
            maxAgainst,
            requirePitcherSignal: false,
            requireLineupSignal: true
          });
        });
      });
    });
  });

  return candidates;
}

function predictionPassesRule(pred, rule) {
  if (!pred) return false;
  if (!pred.features) return false;
  if (!pred.supportSummary) return false;
  if (!pred.modelWinnerTeamId) return false;

  const confidence = Number(pred.confidence || 0);
  const summary = pred.supportSummary;
  const features = pred.features;

  if (confidence < rule.minConfidence) return false;
  if (Number(summary.edgeScore || 0) < rule.minEdgeScore) return false;
  if (Number(summary.support || 0) < rule.minSupport) return false;
  if (Number(summary.against || 0) > rule.maxAgainst) return false;
  if (Number(summary.against || 0) > Number(summary.support || 0)) return false;

  if (rule.requirePitcherSignal && !hasPitcherSignal(features)) return false;
  if (rule.requireLineupSignal && !hasLineupSignal(features)) return false;

  return true;
}

function evaluateRule(predictions, rule) {
  const qualified = predictions.filter(pred => predictionPassesRule(pred, rule));

  if (qualified.length < OPTIMIZER_MIN_SAMPLE) {
    return null;
  }

  const correct = qualified.filter(pred => {
    return String(pred.result?.actualWinnerTeamId) === String(pred.modelWinnerTeamId);
  }).length;

  const accuracy = correct / qualified.length;
  const coverage = qualified.length / predictions.length;

  const score =
    accuracy * 100 +
    Math.min(coverage, 0.35) * 18 +
    Math.min(qualified.length / 100, 1) * 5;

  return {
    rule,
    qualified: qualified.length,
    correct,
    accuracy,
    coverage,
    score
  };
}

function optimizeQualificationRules(db) {
  const predictions = (db.predictions || []).filter(pred => {
    return pred.result &&
      pred.features &&
      pred.supportSummary &&
      pred.modelWinnerTeamId &&
      pred.result.actualWinnerTeamId;
  });

  if (predictions.length < OPTIMIZER_MIN_SAMPLE) {
    db.meta = {
      ...(db.meta || {}),
      optimizedRules: {
        ...DEFAULT_QUALIFY_RULES
      },
      optimizerReport: {
        ready: false,
        reason: `Need at least ${OPTIMIZER_MIN_SAMPLE} graded model picks. Current: ${predictions.length}`,
        testedPredictions: predictions.length,
        updatedAt: new Date().toISOString()
      }
    };

    return db.meta.optimizedRules;
  }

  let best = null;

  ruleCandidateList().forEach(rule => {
    const result = evaluateRule(predictions, rule);

    if (!result) return;

    if (!best || result.score > best.score) {
      best = result;
    }
  });

  if (!best) {
    db.meta = {
      ...(db.meta || {}),
      optimizedRules: {
        ...DEFAULT_QUALIFY_RULES
      },
      optimizerReport: {
        ready: false,
        reason: "No optimizer rule had enough qualified historical picks.",
        testedPredictions: predictions.length,
        updatedAt: new Date().toISOString()
      }
    };

    return db.meta.optimizedRules;
  }

  db.meta = {
    ...(db.meta || {}),
    optimizedRules: best.rule,
    optimizerReport: {
      ready: true,
      testedPredictions: predictions.length,
      qualified: best.qualified,
      correct: best.correct,
      accuracy: Math.round(best.accuracy * 100),
      coverage: Math.round(best.coverage * 100),
      score: Math.round(best.score * 100) / 100,
      rule: best.rule,
      updatedAt: new Date().toISOString()
    }
  };

  return db.meta.optimizedRules;
}

function qualifyPrediction(confidence, summary, game, features, db) {
  const rules = getQualificationRules(db);
  const missingPitchers = !game.homePitcher?.id || !game.awayPitcher?.id;
  const lineupKnown = Boolean(game.homeLineup?.announced && game.awayLineup?.announced);

  const strongLineupAgainst =
    Math.abs(features.lineupStrength || 0) >= 0.35 &&
    ((features.lineupStrength > 0 && summary.edgeScore < 0) ||
      (features.lineupStrength < 0 && summary.edgeScore > 0));

  if (confidence < rules.minConfidence) {
    return {
      qualified: false,
      reason: `No Pick: confidence below optimized ${rules.minConfidence}%`
    };
  }

  if (summary.edgeScore < rules.minEdgeScore) {
    return {
      qualified: false,
      reason: `No Pick: edge score below optimized +${rules.minEdgeScore}`
    };
  }

  if (summary.support < rules.minSupport) {
    return {
      qualified: false,
      reason: `No Pick: fewer than ${rules.minSupport} support factors`
    };
  }

  if (summary.against > rules.maxAgainst) {
    return {
      qualified: false,
      reason: `No Pick: more than ${rules.maxAgainst} opposing factors`
    };
  }

  if (summary.against > summary.support) {
    return {
      qualified: false,
      reason: "No Pick: too many factors disagree"
    };
  }

  if (rules.requirePitcherSignal && !hasPitcherSignal(features)) {
    return {
      qualified: false,
      reason: "No Pick: optimizer requires pitcher edge"
    };
  }

  if (rules.requireLineupSignal && !hasLineupSignal(features)) {
    return {
      qualified: false,
      reason: "No Pick: optimizer requires lineup/split edge"
    };
  }

  if (missingPitchers && confidence < Math.max(66, rules.minConfidence + 4)) {
    return {
      qualified: false,
      reason: "No Pick: probable pitcher data missing"
    };
  }

  if (strongLineupAgainst && lineupKnown) {
    return {
      qualified: false,
      reason: "No Pick: announced lineup pushes against the model"
    };
  }

  return {
    qualified: true,
    reason: "Optimized Qualified Pick"
  };
}

function edgeTeam(value, game) {
  if (Math.abs(value || 0) < 0.035) return "Close";
  return value > 0 ? game.homeTeamName : game.awayTeamName;
}

function buildReasons(game, features, qualifiedInfo, db) {
  if (!qualifiedInfo.qualified) return [qualifiedInfo.reason];

  const map = [
    ["winPct", "season win-rate edge"],
    ["homeAway", "home/away split edge"],
    ["rpg", "scoring edge"],
    ["rapg", "run prevention edge"],
    ["runDiff", "run differential edge"],

    ["recent7WinPct", "last 7 form edge"],
    ["recent15WinPct", "last 15 form edge"],
    ["recent30WinPct", "last 30 form edge"],
    ["recent7Runs", "recent offense edge"],
    ["recent7Prevent", "recent defense edge"],
    ["recentRunDiff", "recent run differential edge"],
    ["streakEdge", "streak edge"],

    ["pitcherEra", "starter ERA edge"],
    ["pitcherWhip", "starter WHIP edge"],
    ["pitcherStrikeouts", "starter strikeout edge"],
    ["pitcherRecentEra", "recent starter ERA edge"],
    ["pitcherRecentWhip", "recent starter WHIP edge"],
    ["pitcherRecentK", "recent starter strikeout edge"],

    ["handednessSplit", "batting split edge"],
    ["lineupStrength", "announced lineup edge"],

    ["h2h", "head-to-head edge"],
    ["restEdge", "rest-day edge"],
    ["bullpenFatigue", "bullpen fatigue edge"]
  ];

  const reasons = map
    .filter(([key]) => !isFactorMuted(db, key))
    .map(([key, label]) => ({
      key,
      label,
      value: features[key] || 0,
      team: edgeTeam(features[key] || 0, game)
    }))
    .filter(item => item.team !== "Close")
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .slice(0, 8)
    .map(item => `${item.team} ${item.label}`);

  return reasons.length ? reasons : ["Optimized Qualified Pick"];
}

function buildSourceReferences(game, features, db) {
  return Object.entries(features).map(([key, value]) => {
    const info = factorTrustInfo(db, key);

    return {
      title: key,
      dataType: "calculated",
      value,
      edgeTeamName: edgeTeam(value, game),
      trust: info.trust,
      muted: info.muted,
      trustStatus: info.status
    };
  });
}

function projectedScores(game, db, pickHome) {
  const home = teamStats(db, game.homeTeamId);
  const away = teamStats(db, game.awayTeamId);
  const leagueRuns = 4.4;

  const homeOffense =
    ((home.runsPerGame || leagueRuns) * 0.44) +
    ((home.last7RunsPerGame || leagueRuns) * 0.36) +
    ((home.last15RunDiffPerGame || 0) * 0.12) +
    leagueRuns * 0.18;

  const awayOffense =
    ((away.runsPerGame || leagueRuns) * 0.44) +
    ((away.last7RunsPerGame || leagueRuns) * 0.36) +
    ((away.last15RunDiffPerGame || 0) * 0.12) +
    leagueRuns * 0.18;

  const homeDefense =
    ((home.runsAllowedPerGame || leagueRuns) * 0.55) +
    ((home.last7RunsAllowedPerGame || leagueRuns) * 0.45);

  const awayDefense =
    ((away.runsAllowedPerGame || leagueRuns) * 0.55) +
    ((away.last7RunsAllowedPerGame || leagueRuns) * 0.45);

  let homeExpected = (homeOffense + awayDefense) / 2 + 0.12;
  let awayExpected = (awayOffense + homeDefense) / 2;

  const homeEra = toNumber(game.homePitcher?.era, null);
  const awayEra = toNumber(game.awayPitcher?.era, null);
  const homeRecentEra = toNumber(game.homePitcher?.recentEra, null);
  const awayRecentEra = toNumber(game.awayPitcher?.recentEra, null);

  if (awayEra != null) homeExpected += clamp((awayEra - 4.2) * 0.12, -0.7, 0.7);
  if (homeEra != null) awayExpected += clamp((homeEra - 4.2) * 0.12, -0.7, 0.7);

  if (awayRecentEra != null) homeExpected += clamp((awayRecentEra - 4.2) * 0.1, -0.5, 0.5);
  if (homeRecentEra != null) awayExpected += clamp((homeRecentEra - 4.2) * 0.1, -0.5, 0.5);

  const homeLineupOps = toNumber(game.homeLineup?.avgOps, null);
  const awayLineupOps = toNumber(game.awayLineup?.avgOps, null);

  if (homeLineupOps != null) homeExpected += clamp((homeLineupOps - 0.72) * 1.4, -0.6, 0.6);
  if (awayLineupOps != null) awayExpected += clamp((awayLineupOps - 0.72) * 1.4, -0.6, 0.6);

  const park = parkRunAdjustment(game.venue, db);
  const weather = weatherRunAdjustment(game.weather);

  homeExpected += park / 2 + weather / 2;
  awayExpected += park / 2 + weather / 2;

  let homeScore = clamp(Math.round(homeExpected), 1, 12);
  let awayScore = clamp(Math.round(awayExpected), 1, 12);

  if (pickHome && homeScore <= awayScore) homeScore = awayScore + 1;
  if (!pickHome && awayScore <= homeScore) awayScore = homeScore + 1;

  return {
    projectedHomeScore: clamp(homeScore, 1, 13),
    projectedAwayScore: clamp(awayScore, 1, 13)
  };
}

function calculatePrediction(game, db) {
  const features = calculateFeatures(game, db);
  const score = weightedScore(features, db);
  const pickHome = score >= 0;
  const summary = supportSummary(features, pickHome, db);

  const confidence = clamp(
    Math.round(50 + Math.tanh(Math.abs(score) * 1.55) * 36),
    51,
    86
  );

  const qualifiedInfo = qualifyPrediction(confidence, summary, game, features, db);
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

    modelWinnerTeamId: pickHome ? game.homeTeamId : game.awayTeamId,
    modelWinnerName: pickHome ? game.homeTeamName : game.awayTeamName,
    modelPickHome: pickHome,

    predictedWinnerTeamId: qualifiedInfo.qualified ? (pickHome ? game.homeTeamId : game.awayTeamId) : null,
    predictedWinnerName: qualifiedInfo.qualified ? (pickHome ? game.homeTeamName : game.awayTeamName) : "No Pick / Too Close",

    confidence,
    qualified: qualifiedInfo.qualified,
    noPick: !qualifiedInfo.qualified,
    noPickReason: qualifiedInfo.qualified ? null : qualifiedInfo.reason,
    supportSummary: summary,

    projectedHomeScore: scores.projectedHomeScore,
    projectedAwayScore: scores.projectedAwayScore,

    features,
    reasons: buildReasons(game, features, qualifiedInfo, db),
    sourceReferences: buildSourceReferences(game, features, db),

    locked: false,
    lateCreated: false,
    historicalTraining: false,
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
    historicalTraining: existing?.historicalTraining || false,
    updatedAt: new Date().toISOString()
  };

  if (index >= 0) db.predictions[index] = prediction;
  else db.predictions.push(prediction);

  return prediction;
}

function buildTrainingDbForDate(db, finalGames, date) {
  const trainingDb = normalizeDb({
    ...db,
    teams: JSON.parse(JSON.stringify(db.teams || {})),
    predictions: [],
    recentGames: finalGames.filter(game => String(game.officialDate) < String(date)),
    model: db.model,
    logs: []
  });

  buildTeamStats(trainingDb, trainingDb.recentGames);
  return trainingDb;
}

function backfillHistoricalTraining(db, finalGames) {
  const games = finalGames
    .filter(isFinalGame)
    .slice()
    .sort((a, b) => String(a.officialDate || "").localeCompare(String(b.officialDate || "")))
    .slice(-BACKTEST_TRAINING_LIMIT);

  let added = 0;

  games.forEach(game => {
    const exists = db.predictions.find(pred => String(pred.gamePk) === String(game.gamePk));
    if (exists) return;

    const trainingDb = buildTrainingDbForDate(db, finalGames, game.officialDate);

    const prediction = {
      ...calculatePrediction(game, trainingDb),
      locked: true,
      lateCreated: false,
      historicalTraining: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    db.predictions.push(prediction);
    added += 1;
  });

  return added;
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

    const correct = pred.qualified &&
      String(actualWinnerTeamId) === String(pred.modelWinnerTeamId || pred.predictedWinnerTeamId);

    const counted = Boolean(pred.qualified && !pred.lateCreated && !pred.historicalTraining);

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

  db.meta.factorReport = buildFactorReport(db);
  updateFactorTrustFromReport(db);
  autoTuneWeightsFromFactorReport(db);
}

function trainPrediction(db, pred) {
  if (!pred.result) return;
  if (pred.result.trained) return;
  if (!pred.qualified) return;

  const actualHomeSign =
    String(pred.result.actualWinnerTeamId) === String(pred.homeTeamId) ? 1 : -1;

  const weights = db.model.weights;

  Object.keys(DEFAULT_WEIGHTS).forEach(key => {
    if (key === "bias") return;

    const featureValue = Number(pred.features?.[key] || 0);
    const adjustment = LEARN_RATE * actualHomeSign * featureValue;

    weights[key] = clamp((weights[key] || 0) + adjustment, -2.2, 2.2);
  });

  weights.bias = clamp((weights.bias || 0) + LEARN_RATE * actualHomeSign * 0.035, -0.45, 0.45);

  pred.result.trained = true;
  db.model.trainedGames = db.predictions.filter(item => item.result?.trained).length;
  db.model.lastTrainedAt = new Date().toISOString();
}

function buildFactorReport(db) {
  const report = {};

  Object.keys(DEFAULT_WEIGHTS).forEach(key => {
    if (key !== "bias") {
      report[key] = {
        supports: 0,
        correctWhenSupported: 0,
        wrongWhenSupported: 0,
        accuracyWhenSupported: null
      };
    }
  });

  db.predictions
    .filter(pred => pred.qualified && pred.result)
    .forEach(pred => {
      const pickHome = String(pred.modelWinnerTeamId || pred.predictedWinnerTeamId) === String(pred.homeTeamId);

      Object.keys(report).forEach(key => {
        const value = Number(pred.features?.[key] || 0);

        if (Math.abs(value) < 0.04) return;

        const supportsHome = value > 0;
        const supportedPick = supportsHome === pickHome;

        if (!supportedPick) return;

        report[key].supports += 1;

        if (pred.result.correct) report[key].correctWhenSupported += 1;
        else report[key].wrongWhenSupported += 1;
      });
    });

  Object.keys(report).forEach(key => {
    const item = report[key];

    if (item.supports) {
      item.accuracyWhenSupported = Math.round((item.correctWhenSupported / item.supports) * 100);
    }
  });

  return report;
}

function updateFactorTrustFromReport(db) {
  const report = db.meta?.factorReport || {};
  const trust = defaultFactorTrust();

  const mutedFactors = [];
  const reducedFactors = [];
  const boostedFactors = [];
  const learningFactors = [];

  Object.keys(trust).forEach(key => {
    const item = report[key] || {};
    const supports = Number(item.supports || 0);
    const correct = Number(item.correctWhenSupported || 0);
    const wrong = Number(item.wrongWhenSupported || 0);
    const accuracy = Number(item.accuracyWhenSupported);

    let status = "Learning";
    let trustScore = 1;
    let muted = false;

    if (supports < FACTOR_TRUST_MIN_SUPPORT || !Number.isFinite(accuracy)) {
      status = "Learning";
      trustScore = 1;
      muted = false;
      learningFactors.push(key);
    } else if (accuracy < FACTOR_MUTE_ACCURACY) {
      status = "Muted";
      trustScore = 0;
      muted = true;
      mutedFactors.push(key);
    } else if (accuracy < FACTOR_REDUCE_ACCURACY) {
      status = "Reduced";
      trustScore = 0.45;
      muted = false;
      reducedFactors.push(key);
    } else if (accuracy < 54) {
      status = "Cautious";
      trustScore = 0.75;
      muted = false;
      reducedFactors.push(key);
    } else if (accuracy >= 64) {
      status = "Boosted";
      trustScore = 1.18;
      muted = false;
      boostedFactors.push(key);
    } else if (accuracy >= FACTOR_BOOST_ACCURACY) {
      status = "Trusted";
      trustScore = 1.08;
      muted = false;
      boostedFactors.push(key);
    } else {
      status = "Normal";
      trustScore = 1;
      muted = false;
    }

    trust[key] = {
      trust: trustScore,
      muted,
      status,
      supports,
      correct,
      wrong,
      accuracy: Number.isFinite(accuracy) ? accuracy : null
    };
  });

  db.meta.factorTrust = trust;
  db.meta.mutedFactors = mutedFactors;
  db.meta.factorTrustReport = {
    updatedAt: new Date().toISOString(),
    minSupport: FACTOR_TRUST_MIN_SUPPORT,
    muteBelowAccuracy: FACTOR_MUTE_ACCURACY,
    reduceBelowAccuracy: FACTOR_REDUCE_ACCURACY,
    boostAtAccuracy: FACTOR_BOOST_ACCURACY,
    mutedFactors,
    reducedFactors,
    boostedFactors,
    learningFactors,
    mutedCount: mutedFactors.length,
    reducedCount: reducedFactors.length,
    boostedCount: boostedFactors.length,
    learningCount: learningFactors.length
  };

  return db.meta.factorTrustReport;
}

function autoTuneWeightsFromFactorReport(db) {
  const report = db.meta?.factorReport || {};
  const weights = db.model.weights || {};

  Object.entries(report).forEach(([key, item]) => {
    if (!weights[key]) return;
    if (!item.supports || item.supports < 10) return;

    const acc = item.correctWhenSupported / item.supports;

    if (acc < 0.46) {
      weights[key] = clamp(weights[key] * 0.88, -2.2, 2.2);
    } else if (acc < 0.5) {
      weights[key] = clamp(weights[key] * 0.93, -2.2, 2.2);
    } else if (acc >= 0.64) {
      weights[key] = clamp(weights[key] * 1.05, -2.2, 2.2);
    } else if (acc >= 0.6) {
      weights[key] = clamp(weights[key] * 1.03, -2.2, 2.2);
    } else if (acc >= 0.56) {
      weights[key] = clamp(weights[key] * 1.015, -2.2, 2.2);
    }
  });
}

function predictionDateMs(pred) {
  const rawDate =
    pred.result?.finalAt ||
    pred.date ||
    pred.gameDate ||
    pred.updatedAt ||
    pred.createdAt;

  const time = new Date(rawDate).getTime();

  return Number.isFinite(time) ? time : 0;
}

function rollingWindowAccuracy(db, days) {
  const now = Date.now();
  const cutoff = now - days * 24 * 60 * 60 * 1000;

  const counted = (db.predictions || []).filter(pred => {
    if (!pred.result) return false;
    if (pred.result.counted !== true) return false;
    if (!pred.qualified) return false;

    return predictionDateMs(pred) >= cutoff;
  });

  const correct = counted.filter(pred => pred.result.correct).length;
  const total = counted.length;
  const wrong = total - correct;

  return {
    days,
    accuracy: total ? Math.round((correct / total) * 100) : null,
    correct,
    wrong,
    total
  };
}

function rollingAccuracyStats(db) {
  const last7 = rollingWindowAccuracy(db, 7);
  const last14 = rollingWindowAccuracy(db, 14);
  const last30 = rollingWindowAccuracy(db, 30);

  let trendStatus = "Learning";
  let trendDirection = "flat";

  if (last7.total >= 5 && last14.total >= 10) {
    if ((last7.accuracy || 0) >= (last14.accuracy || 0) + 5) {
      trendStatus = "Improving";
      trendDirection = "up";
    } else if ((last7.accuracy || 0) <= (last14.accuracy || 0) - 5) {
      trendStatus = "Cooling Off";
      trendDirection = "down";
    } else {
      trendStatus = "Stable";
      trendDirection = "flat";
    }
  }

  if (last7.total < 3 && last14.total < 6) {
    trendStatus = "Need More Recent Finals";
    trendDirection = "learning";
  }

  return {
    last7,
    last14,
    last30,
    trendStatus,
    trendDirection,
    updatedAt: new Date().toISOString()
  };
}

function accuracyStats(db) {
  const graded = db.predictions.filter(pred => pred.result);
  const counted = graded.filter(pred => pred.result.counted === true);
  const excluded = graded.filter(pred => pred.result.counted !== true);
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
    .sort((a, b) => {
      const dateCompare = String(b.date || "").localeCompare(String(a.date || ""));
      if (dateCompare !== 0) return dateCompare;
      return Number(b.confidence || 0) - Number(a.confidence || 0);
    })
    .slice(0, 1200);

  db.recentGames = db.recentGames
    .slice()
    .sort((a, b) => String(b.officialDate || "").localeCompare(String(a.officialDate || "")))
    .slice(0, 3000);
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
    rollingAccuracy: rollingAccuracyStats(db),
    model: db.model,
    logs: db.logs || [],
    factorReport: db.meta.factorReport || {},
    factorTrust: db.meta.factorTrust || defaultFactorTrust(),
    factorTrustReport: db.meta.factorTrustReport || null,
    mutedFactors: db.meta.mutedFactors || [],
    optimizerReport: db.meta.optimizerReport || null,
    optimizedRules: db.meta.optimizedRules || DEFAULT_QUALIFY_RULES,
    engineVersion: ENGINE_VERSION
  };
}

async function fullAutoSync() {
  const db = readDb();
  maybeUpgradeEngine(db);

  const today = ymd();
  const tomorrow = addDays(today, 1);
  const startDate = addDays(today, -HISTORY_DAYS);

  await syncMlbTeams(db);
  await syncTeamBattingSplits(db);

  const recentGames = await fetchScheduleRange(startDate, today);
  const finalRecentGames = recentGames.filter(isFinalGame);

  db.recentGames = finalRecentGames;

  buildTeamStats(db, finalRecentGames);

  const addedTraining = backfillHistoricalTraining(db, finalRecentGames);
  gradePredictions(db, finalRecentGames);

  const optimizedRules = optimizeQualificationRules(db);

  logMessage(
    db,
    `Backtest optimizer selected: confidence ${optimizedRules.minConfidence}%, edge +${optimizedRules.minEdgeScore}, support ${optimizedRules.minSupport}, max against ${optimizedRules.maxAgainst}.`
  );

  const todayGames = await fetchScheduleByDate(today);
  const tomorrowGames = await fetchScheduleByDate(tomorrow);

  await hydratePitchers([...todayGames, ...tomorrowGames], db);
  await hydrateLineups([...todayGames, ...tomorrowGames]);

  syncPredictionsForGames([...todayGames, ...tomorrowGames], db);
  gradePredictions(db, [...finalRecentGames, ...todayGames, ...tomorrowGames]);

  const todayWithPredictions = attachPredictions(todayGames, db);
  const tomorrowWithPredictions = attachPredictions(tomorrowGames, db);

  db.meta = {
    ...(db.meta || {}),
    engineVersion: ENGINE_VERSION,
    currentDate: today,
    tomorrowDate: tomorrow,
    todayGames: todayWithPredictions,
    tomorrowGames: tomorrowWithPredictions,
    lastFullSync: new Date().toISOString(),
    dataDir: DATA_DIR,
    historyDays: HISTORY_DAYS,
    addedHistoricalTraining: addedTraining,
    qualifiedPickMode: true
  };

  cleanupDb(db);

  const qualifiedToday = todayWithPredictions.filter(game => game.prediction?.qualified).length;
  const qualifiedTomorrow = tomorrowWithPredictions.filter(game => game.prediction?.qualified).length;
  const mutedCount = db.meta?.mutedFactors?.length || 0;

  logMessage(
    db,
    `Factor trust sync complete: ${qualifiedToday}/${todayGames.length} today, ${qualifiedTomorrow}/${tomorrowGames.length} tomorrow, ${mutedCount} muted factors, ${addedTraining} new training games.`
  );

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
    ".webmanifest": "application/manifest+json; charset=utf-8",
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

  if (req.method === "GET" && url.pathname === "/api/reset-retrain") {
    const db = readDb();

    db.predictions = [];
    db.model = {
      weights: { ...DEFAULT_WEIGHTS },
      trainedGames: 0,
      lastTrainedAt: null
    };
    db.meta = {
      ...(db.meta || {}),
      engineVersion: ENGINE_VERSION,
      optimizedRules: { ...DEFAULT_QUALIFY_RULES },
      optimizerReport: null,
      factorReport: {},
      factorTrust: defaultFactorTrust(),
      mutedFactors: [],
      factorTrustReport: null
    };

    logMessage(db, "Manual reset + retrain requested.");
    saveDb(db);

    const dashboard = await fullAutoSync();

    sendJson(res, 200, {
      ok: true,
      message: "Model reset and retrained.",
      dashboard
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/optimize-rules") {
    const db = readDb();

    const rules = optimizeQualificationRules(db);
    logMessage(
      db,
      `Manual optimizer run: confidence ${rules.minConfidence}%, edge +${rules.minEdgeScore}, support ${rules.minSupport}, max against ${rules.maxAgainst}.`
    );

    saveDb(db);

    sendJson(res, 200, {
      ok: true,
      message: "Backtest optimizer complete.",
      optimizedRules: rules,
      optimizerReport: db.meta.optimizerReport || null,
      dashboard: buildDashboard(db)
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/factor-trust") {
    const db = readDb();

    db.meta.factorReport = buildFactorReport(db);
    const factorTrustReport = updateFactorTrustFromReport(db);

    logMessage(
      db,
      `Manual factor trust run: ${factorTrustReport.mutedCount} muted, ${factorTrustReport.reducedCount} reduced, ${factorTrustReport.boostedCount} boosted.`
    );

    saveDb(db);

    sendJson(res, 200, {
      ok: true,
      message: "Factor trust report rebuilt.",
      factorTrust: db.meta.factorTrust,
      mutedFactors: db.meta.mutedFactors,
      factorTrustReport,
      dashboard: buildDashboard(db)
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
  console.log(`Engine: ${ENGINE_VERSION}`);
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
