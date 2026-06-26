const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const METRICS_SAMPLE_SIZE = 200;
const METRICS_LOG_EVERY_CHECKS = 20;
const UPSTREAM_TIMEOUT_MS = Number.parseInt(process.env.UPSTREAM_TIMEOUT_MS ?? '15000', 10);
const HAS_UPSTREAM_TIMEOUT = Number.isFinite(UPSTREAM_TIMEOUT_MS) && UPSTREAM_TIMEOUT_MS > 0;
const ENABLE_CHANGE_DETECTION = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.ENABLE_CHANGE_DETECTION ?? 'false').toLowerCase()
);
const SOCKET_TRANSPORT_MODE = String(process.env.SOCKET_TRANSPORT_MODE ?? 'hybrid').toLowerCase();
const SOCKET_WEBSOCKET_ONLY = SOCKET_TRANSPORT_MODE === 'websocket';
const ENABLE_SELF_PING = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.ENABLE_SELF_PING ?? 'false').toLowerCase()
);
const POLL_INTERVAL_MS_RAW = Number.parseInt(process.env.POLL_INTERVAL_MS ?? '30000', 10);
const POLL_INTERVAL_MS_MIN = 30000;
const POLL_INTERVAL_MS = Number.isFinite(POLL_INTERVAL_MS_RAW) && POLL_INTERVAL_MS_RAW > 0
  ? Math.max(POLL_INTERVAL_MS_RAW, POLL_INTERVAL_MS_MIN)
  : POLL_INTERVAL_MS_MIN;
const BASELINE_REFRESH_MS = Number.parseInt(process.env.BASELINE_REFRESH_MS ?? '300000', 10);
const LIVE_STATUS_REFRESH_QUERY = 'matches?competitions=2000&status=LIVE,TIMED';

const runtimeMetrics = {
  upstreamFetchMs: [],
  checkCycleMs: [],
  apiFetchMs: [],
  wsEmits: 0,
  cacheHits: 0,
  checks: 0,
};

let lastInboundActivityAt = Date.now();

function logInboundActivity(source, details = '') {
  const now = Date.now();
  const idleSeconds = Math.max(0, Math.round((now - lastInboundActivityAt) / 1000));
  lastInboundActivityAt = now;

  const suffix = details ? ` ${details}` : '';
  console.log(`[Activity] ${source}${suffix} | idleBefore=${idleSeconds}s`);
}

function shouldSkipActivityLog(req) {
  const path = String(req.path || req.originalUrl || '').split('?')[0];

  // Ignore Render-style health checks and root HEAD probes.
  if (/^\/health\d*$/i.test(path)) {
    return true;
  }

  if (req.method === 'HEAD' && path === '/') {
    return true;
  }

  return false;
}

function pushMetricSample(samples, value) {
  if (!Number.isFinite(value)) return;
  samples.push(value);
  if (samples.length > METRICS_SAMPLE_SIZE) {
    samples.shift();
  }
}

function percentile(samples, p) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

function formatLatencySummary(label, samples) {
  if (!samples.length) {
    return `${label}: n/a`;
  }

  const p50 = percentile(samples, 50);
  const p95 = percentile(samples, 95);
  return `${label}: p50=${Math.round(p50)}ms p95=${Math.round(p95)}ms n=${samples.length}`;
}

function logRuntimeMetricsSummary() {
  const parts = [
    formatLatencySummary('upstream', runtimeMetrics.upstreamFetchMs),
    formatLatencySummary('checkCycle', runtimeMetrics.checkCycleMs),
    formatLatencySummary('apiFetch', runtimeMetrics.apiFetchMs),
    `wsEmits=${runtimeMetrics.wsEmits}`,
    `cacheHits=${runtimeMetrics.cacheHits}`,
  ];

  console.log(`[Metrics] ${parts.join(' | ')}`);
}

function getMatchesHash(data) {
  return crypto.createHash('md5').update(JSON.stringify(data)).digest('hex');
}

function stripCompetitionFromMatchesPayload(payload) {
  if (!payload || !Array.isArray(payload.matches)) {
    return [];
  }

  return payload.matches.map((match) => {
    if (!match || typeof match !== 'object') {
      return match;
    }

    return {
      id: match.id,
      utcDate: match.utcDate,
      lastUpdated: match.lastUpdated ?? null,
      status: match.status,
      matchday: match.matchday,
      stage: match.stage,
      group: match.group,
      homeTeam: match.homeTeam
        ? {
            id: match.homeTeam.id,
            name: match.homeTeam.name,
          }
        : null,
      awayTeam: match.awayTeam
        ? {
            id: match.awayTeam.id,
            name: match.awayTeam.name,
          }
        : null,
      score: match.score,
    };
  });
}

app.use(cors());
app.use((req, res, next) => {
  if (!shouldSkipActivityLog(req)) {
    logInboundActivity('HTTP', `${req.method} ${req.originalUrl}`);
  }
  next();
});

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

const FOOTBALL_API = {
  version: 'v4',
  competition: 'WC', //2018 European Championship; 200 world cup;
  baseUrl: 'https://api.football-data.org',
  token: 'c8d23279fec54671a43fcd93068762d1', // Replace with a valid token if needed
};

function parseIntHeader(value) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchFootballData(path, options = {}) {
  const unfoldLineups = options.unfoldLineups === true;
  const unfoldBookings = options.unfoldBookings === true;
  const unfoldSubs = options.unfoldSubs === true;
  const unfoldGoals = options.unfoldGoals === true;

  const controller = new AbortController();
  const timeout = HAS_UPSTREAM_TIMEOUT
    ? setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)
    : null;
  const startTime = Date.now();

  try {
    const normalizedPath = String(path).replace(/^\/+/, '');
    const url = `${FOOTBALL_API.baseUrl}/${FOOTBALL_API.version}/${normalizedPath}`;
    const response = await fetch(url, {
      headers: {
        'X-Auth-Token': FOOTBALL_API.token,
        'X-Unfold-Lineups': String(unfoldLineups),
        'X-Unfold-Bookings': String(unfoldBookings),
        'X-Unfold-Subs': String(unfoldSubs),
        'X-Unfold-Goals': String(unfoldGoals),
      },
      signal: controller.signal,
    });

    let data;
    try {
      data = await response.json();
    } catch {
      data = { error: `Unexpected non-JSON response (HTTP ${response.status})` };
    }

    const duration = Date.now() - startTime;
    pushMetricSample(runtimeMetrics.upstreamFetchMs, duration);
    console.log(`[API Log] Request to ${normalizedPath} took ${duration}ms (status=${response.status})`);

    return {
      status: response.status,
      data,
      durationMs: duration,
      rate: {
        available: parseIntHeader(response.headers.get('X-RequestsAvailable')),
        resetSeconds: parseIntHeader(response.headers.get('X-RequestCounter-Reset')),
      },
    };
  } catch (error) {
    const errorMsg = error.name === 'AbortError' ? 'Request timed out' : error.message;
    const duration = Date.now() - startTime;
    pushMetricSample(runtimeMetrics.upstreamFetchMs, duration);
    console.error(`[API Error] ${path}:`, errorMsg);
    return {
      status: 500,
      data: { error: errorMsg },
      durationMs: duration,
      rate: { available: null, resetSeconds: null },
    };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

// Health-check endpoint for self-pings and monitoring services
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.get('/api/matches', async (req, res) => {
  const result = await fetchFootballData(`competitions/${FOOTBALL_API.competition}/matches`);
  pushMetricSample(runtimeMetrics.apiFetchMs, result.durationMs);
  applyRateLimitHints(result);

  if (result.status === 200) {
    const matchesPayload = stripCompetitionFromMatchesPayload(result.data);
    console.log('[API /api/matches] Returning matches payload:', JSON.stringify(matchesPayload, null, 2));
    replaceSnapshot(matchesPayload);
    lastMatchesFetchedAt = Date.now();
    return res.status(200).json(matchesPayload);
  }

  res.status(result.status).json(result.data);
});

app.get('/api/matches/live', async (req, res) => {
  const result = await fetchLiveMatchesDelta();
  pushMetricSample(runtimeMetrics.apiFetchMs, result.durationMs);
  applyRateLimitHints(result);

  if (result.status === 200) {
    const liveStatuses = ['IN_PLAY', 'PAUSED', 'TIMED', 'SCHEDULED', 'EXTRA_TIME', 'PENALTY_SHOOTOUT'];
    const delta = stripCompetitionFromMatchesPayload(result.data)
      .filter((match) => liveStatuses.includes(String(match?.status || '').toUpperCase()));
    return res.status(200).json(delta);
  }

  res.status(result.status).json(result.data);
});

app.get('/api/matches/live/full', async (req, res) => {
  const result = await fetchLiveMatchesDelta();
  pushMetricSample(runtimeMetrics.apiFetchMs, result.durationMs);
  applyRateLimitHints(result);

  if (result.status === 200) {
    const delta = stripCompetitionFromMatchesPayload(result.data);
    mergeSnapshot(delta);
    return res.status(200).json(getSnapshotMatchesSorted());
  }

  res.status(result.status).json(result.data);
});

app.get('/api/matches/:id', async (req, res) => {
  const matchIdRaw = req.params.id;
  const matchId = Number.parseInt(matchIdRaw, 10);

  if (!Number.isFinite(matchId) || matchId <= 0) {
    return res.status(400).json({
      error: 'Invalid match id. Expected a positive integer.',
    });
  }

  const baseResult = await fetchFootballData(`matches/${matchId}`);
  pushMetricSample(runtimeMetrics.apiFetchMs, baseResult.durationMs);
  applyRateLimitHints(baseResult);

  if (baseResult.status !== 200) {
    return res.status(baseResult.status).json(baseResult.data);
  }

  const status = String(baseResult.data?.status || '').toUpperCase();
  const needsExpandedDetails = [
    'IN_PLAY',
    'PAUSED',
    'FINISHED',
    'AWARDED',
    'EXTRA_TIME',
    'PENALTY_SHOOTOUT',
  ].includes(status);

  if (!needsExpandedDetails) {
    return res.status(200).json(baseResult.data);
  }

  const expandedResult = await fetchFootballData(`matches/${matchId}`, {
    unfoldLineups: true,
    unfoldBookings: true,
    unfoldSubs: true,
    unfoldGoals: true,
  });

  pushMetricSample(runtimeMetrics.apiFetchMs, expandedResult.durationMs);
  applyRateLimitHints(expandedResult);

  if (expandedResult.status === 200) {
    return res.status(200).json(expandedResult.data);
  }

  return res.status(expandedResult.status).json(expandedResult.data);
});

app.get('/api/standings', async (req, res) => {
  const result = await fetchFootballData(`competitions/${FOOTBALL_API.competition}/standings`);
  pushMetricSample(runtimeMetrics.apiFetchMs, result.durationMs);
  applyRateLimitHints(result);

  if (result.status !== 200) {
    return res.status(result.status).json(result.data);
  }

  return res.status(200).json(result.data);
});

app.get('/api/matches/cached', (req, res) => {
  res.status(410).json({
    message: 'Cached match responses are disabled. Use /api/matches for a fresh upstream fetch.',
  });
});

const server = http.createServer(app);
const io = new Server(server, {
  transports: SOCKET_WEBSOCKET_ONLY ? ['websocket'] : ['polling', 'websocket'],
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

let lastMatchesHash = '';
let lastMatchesFetchedAt = 0;
let lastBaselineRefreshAt = 0;
let trackedMatchIds = [];
let pollIntervalDynamicMs = POLL_INTERVAL_MS;
let nextPollNotBeforeTs = 0;
let retryBackoffMs = 0;
const snapshotById = new Map();
let intervalId = null;
let longIntervalId = null;
let clientsCount = 0;
let isPollingLoopStarted = false;
let isCheckingUpdates = false;
let rerunUpdateCheck = false;

function statusSetContains(statuses, status) {
  return statuses.includes(String(status || '').toUpperCase());
}

function extractTrackedMatchIds(matches) {
  return matches
    .filter((match) => {
      const status = String(match?.status || '').toUpperCase();
      return statusSetContains(['IN_PLAY', 'PAUSED', 'TIMED', 'SCHEDULED'], status);
    })
    .map((match) => match.id)
    .filter((id) => Number.isFinite(id));
}

function sortMatchesForEmission(matches) {
  return [...matches].sort((a, b) => {
    const left = String(a?.utcDate || '');
    const right = String(b?.utcDate || '');
    return left.localeCompare(right) || (a?.id ?? 0) - (b?.id ?? 0);
  });
}

function getSnapshotMatchesSorted() {
  return sortMatchesForEmission(Array.from(snapshotById.values()));
}

function replaceSnapshot(matches) {
  snapshotById.clear();
  for (const match of matches) {
    if (match && Number.isFinite(match.id)) {
      snapshotById.set(match.id, match);
    }
  }
  trackedMatchIds = extractTrackedMatchIds(matches);
  lastBaselineRefreshAt = Date.now();
}

function mergeSnapshot(deltaMatches) {
  for (const match of deltaMatches) {
    if (match && Number.isFinite(match.id)) {
      snapshotById.set(match.id, match);
    }
  }
  trackedMatchIds = extractTrackedMatchIds(getSnapshotMatchesSorted());
}

function applyRateLimitHints(result) {
  const available = result?.rate?.available;
  const resetSeconds = result?.rate?.resetSeconds;

  if (result?.status === 429) {
    const waitMs = Math.max(30000, ((Number.isFinite(resetSeconds) ? resetSeconds : 60) + 1) * 1000);
    retryBackoffMs = Math.min(Math.max(retryBackoffMs * 2 || waitMs, waitMs), 5 * 60 * 1000);
    nextPollNotBeforeTs = Date.now() + retryBackoffMs;
    pollIntervalDynamicMs = Math.max(POLL_INTERVAL_MS, retryBackoffMs);
    console.warn(`[RateLimit] 429 received. Backing off for ${Math.round(retryBackoffMs / 1000)}s`);
    return;
  }

  if (result?.status >= 500) {
    retryBackoffMs = Math.min(Math.max(retryBackoffMs * 2 || POLL_INTERVAL_MS, POLL_INTERVAL_MS), 5 * 60 * 1000);
    nextPollNotBeforeTs = Date.now() + retryBackoffMs;
    pollIntervalDynamicMs = Math.max(POLL_INTERVAL_MS, retryBackoffMs);
    return;
  }

  retryBackoffMs = 0;
  nextPollNotBeforeTs = 0;
  pollIntervalDynamicMs = POLL_INTERVAL_MS;

  if (Number.isFinite(available) && Number.isFinite(resetSeconds) && available <= 2) {
    pollIntervalDynamicMs = Math.max(POLL_INTERVAL_MS, (resetSeconds + 1) * 1000);
    console.warn(`[RateLimit] Low remaining quota (${available}), temporary poll=${pollIntervalDynamicMs}ms`);
  }
}

function isBaselineRefreshDue() {
  if (!Number.isFinite(lastBaselineRefreshAt) || lastBaselineRefreshAt === 0) {
    return true;
  }

  return Date.now() - lastBaselineRefreshAt >= BASELINE_REFRESH_MS;
}

async function fetchCompetitionSnapshot() {
  return fetchFootballData(`competitions/${FOOTBALL_API.competition}/matches`);
}

async function fetchLiveMatchesDelta() {
  if (trackedMatchIds.length > 0) {
    return fetchFootballData(`matches?ids=${trackedMatchIds.join(',')}`);
  }

  return fetchFootballData(LIVE_STATUS_REFRESH_QUERY);
}

function startInterval() {
  if (isPollingLoopStarted) {
    return;
  }

  isPollingLoopStarted = true;

  const runNext = async () => {
    await checkForUpdates();

    if (clientsCount === 0) {
      intervalId = null;
      isPollingLoopStarted = false;
      return;
    }

    intervalId = setTimeout(runNext, pollIntervalDynamicMs);
  };

  runNext();
}

function stopInterval() {
  if (intervalId) {
    clearTimeout(intervalId);
    intervalId = null;
  }

  isPollingLoopStarted = false;
}

function startLongInterval() {
  if (!longIntervalId) {
    const TEN_MINUTES = 10 * 60 * 1000;
    console.log(`[${new Date().toISOString()}] Long interval background service initialized (10 min)`);
    
    const runNext = () => {
      const nextCheckTime = new Date(Date.now() + TEN_MINUTES).toISOString();
      console.log(`[${new Date().toISOString()}] Next background update scheduled for: ${nextCheckTime}`);

      longIntervalId = setTimeout(async () => {
        console.log(`[${new Date().toISOString()}] Executing scheduled background check...`);
        await checkForUpdates();
        runNext();
      }, TEN_MINUTES);
    };

    runNext();
  }
}

function stopLongInterval() {
  if (longIntervalId) {
    clearTimeout(longIntervalId);
    longIntervalId = null;
  }
}

// Self-pinging logic to prevent Render from sleeping
function startSelfPing() {
  if (!ENABLE_SELF_PING) {
    console.log('[Keep-Alive] Self-ping disabled (ENABLE_SELF_PING is false)');
    return;
  }

  const url = process.env.RENDER_EXTERNAL_URL;
  if (!url) return; // Only run if RENDER_EXTERNAL_URL is set (on Render)

  const INTERVAL = 14 * 60 * 1000; // 14 minutes
  const runNext = () => {
    setTimeout(async () => {
      try {
        const response = await fetch(`${url}/health`);
        console.log(`[Keep-Alive] Self-ping successful: ${response.status}`);
      } catch (error) {
        console.error('[Keep-Alive] Self-ping failed:', error.message);
      }
      runNext();
    }, INTERVAL);
  };
  runNext();
}

io.on('connection', (socket) => {
  logInboundActivity('Socket', `connect id=${socket.id}`);
  clientsCount++;
  console.log(`Client connected. Total clients: ${clientsCount}. Transport: ${socket.conn.transport.name}`);

  socket.conn.on('upgrade', () => {
    console.log(`Client transport upgraded to: ${socket.conn.transport.name}`);
  });

  startInterval();

  socket.on('disconnect', (reason) => {
    logInboundActivity('Socket', `disconnect id=${socket.id} reason=${reason}`);
    console.log(`Client disconnected. Reason: ${reason}`);
    clientsCount--;
    if (clientsCount === 0) {
      stopInterval();
    }
  });
});

// Start the self-pinging service
startSelfPing();

async function checkForUpdates() {
  if (isCheckingUpdates) {
    rerunUpdateCheck = true;
    return;
  }

  if (nextPollNotBeforeTs > Date.now()) {
    return;
  }

  isCheckingUpdates = true;
  const checkStartedAt = Date.now();

  try {
    const shouldRefreshBaseline = isBaselineRefreshDue() || snapshotById.size === 0;
    const result = shouldRefreshBaseline
      ? await fetchCompetitionSnapshot()
      : await fetchLiveMatchesDelta();
    applyRateLimitHints(result);
    
    if (result.status === 200) {
      lastMatchesFetchedAt = Date.now();
      const payload = stripCompetitionFromMatchesPayload(result.data);

      if (shouldRefreshBaseline) {
        replaceSnapshot(payload);
      } else {
        mergeSnapshot(payload);
      }

      const fullSnapshot = getSnapshotMatchesSorted();
      const currentHash = getMatchesHash(fullSnapshot);

      if (ENABLE_CHANGE_DETECTION) {
        if (currentHash !== lastMatchesHash) {
          lastMatchesHash = currentHash;
          io.emit('matchesUpdate', fullSnapshot);
          runtimeMetrics.wsEmits++;
        }
      } else {
        io.emit('matchesUpdate', fullSnapshot);
        runtimeMetrics.wsEmits++;
      }
    } else {
      console.warn(`[Polling] Upstream non-200 status=${result.status}`);
    }
  } catch (error) {
    console.error('[Polling] Failed to fetch updates:', error.message);
  } finally {
    isCheckingUpdates = false;
    pushMetricSample(runtimeMetrics.checkCycleMs, Date.now() - checkStartedAt);
    runtimeMetrics.checks++;

    if (runtimeMetrics.checks % METRICS_LOG_EVERY_CHECKS === 0) {
      logRuntimeMetricsSummary();
    }

    if (rerunUpdateCheck) {
      rerunUpdateCheck = false;
      setImmediate(() => {
        checkForUpdates();
      });
    }
  }
}

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  if (Number.isFinite(POLL_INTERVAL_MS_RAW) && POLL_INTERVAL_MS_RAW > 0 && POLL_INTERVAL_MS_RAW < POLL_INTERVAL_MS_MIN) {
    console.log(`[Config] POLL_INTERVAL_MS was set to ${POLL_INTERVAL_MS_RAW}ms and has been clamped to ${POLL_INTERVAL_MS}ms (minimum ${POLL_INTERVAL_MS_MIN}ms)`);
  }
  console.log('[Config] Environment settings:');
  console.log(`  POLL_INTERVAL_MS      = ${process.env.POLL_INTERVAL_MS ?? '(not set, default 30000ms)'}`);
  console.log(`  BASELINE_REFRESH_MS   = ${process.env.BASELINE_REFRESH_MS ?? '(not set, default 300000ms)'}`);
  console.log(`  UPSTREAM_TIMEOUT_MS   = ${process.env.UPSTREAM_TIMEOUT_MS ?? '(not set, default 15000ms)'}`);
  console.log(`  ENABLE_CHANGE_DETECTION = ${process.env.ENABLE_CHANGE_DETECTION ?? '(not set, default false)'}`);
  console.log(`  ENABLE_SELF_PING      = ${process.env.ENABLE_SELF_PING ?? '(not set, default false)'}`);
  console.log(`  SOCKET_TRANSPORT_MODE = ${process.env.SOCKET_TRANSPORT_MODE ?? '(not set, default hybrid)'}`);
  console.log(`  RENDER_EXTERNAL_URL   = ${process.env.RENDER_EXTERNAL_URL ?? '(not set, self-ping disabled)'}`);
  console.log('[Config] Active values:');
  console.log(`  POLL_INTERVAL_MS      → ${POLL_INTERVAL_MS}ms`);
  console.log(`  BASELINE_REFRESH_MS   → ${BASELINE_REFRESH_MS}ms`);
  console.log(`  UPSTREAM_TIMEOUT_MS   → ${HAS_UPSTREAM_TIMEOUT ? `${UPSTREAM_TIMEOUT_MS}ms` : 'disabled'}`);
  console.log(`  ENABLE_CHANGE_DETECTION → ${ENABLE_CHANGE_DETECTION}`);
  console.log(`  ENABLE_SELF_PING      → ${ENABLE_SELF_PING}`);
  console.log(`  SOCKET_TRANSPORT_MODE → ${SOCKET_WEBSOCKET_ONLY ? 'websocket-only' : 'hybrid (polling + websocket)'}`);
});
