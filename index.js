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
const POLL_INTERVAL_MS_RAW = Number.parseInt(process.env.POLL_INTERVAL_MS ?? '30000', 10);
const POLL_INTERVAL_MS = Number.isFinite(POLL_INTERVAL_MS_RAW) && POLL_INTERVAL_MS_RAW > 0
  ? POLL_INTERVAL_MS_RAW
  : 30000;

const runtimeMetrics = {
  upstreamFetchMs: [],
  checkCycleMs: [],
  apiFetchMs: [],
  wsEmits: 0,
  cacheHits: 0,
  checks: 0,
};

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

    const { competition, area, odds, referees, season, ...rest } = match;
    return rest;
  });
}

app.use(cors());

const FOOTBALL_API = {
  version: 'v4',
  competition: 'WC', //2018 European Championship; 200 world cup;
  baseUrl: 'https://api.football-data.org',
  token: 'c8d23279fec54671a43fcd93068762d1', // Replace with a valid token if needed
};

async function fetchFootballData(endpoint) {
  const controller = new AbortController();
  const timeout = HAS_UPSTREAM_TIMEOUT
    ? setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)
    : null;
  const startTime = Date.now();

  try {
    const url = `${FOOTBALL_API.baseUrl}/${FOOTBALL_API.version}/competitions/${FOOTBALL_API.competition}/${endpoint}`;
    const response = await fetch(url, {
      headers: { 'X-Auth-Token': FOOTBALL_API.token },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }
    const data = await response.json();
    const duration = Date.now() - startTime;
    pushMetricSample(runtimeMetrics.upstreamFetchMs, duration);
    console.log(`[API Log] Request to ${endpoint} took ${duration}ms`);
    return { status: response.status, data, durationMs: duration };
  } catch (error) {
    const errorMsg = error.name === 'AbortError' ? 'Request timed out' : error.message;
    const duration = Date.now() - startTime;
    pushMetricSample(runtimeMetrics.upstreamFetchMs, duration);
    console.error(`[API Error] ${endpoint}:`, errorMsg);
    return { status: 500, data: { error: errorMsg }, durationMs: duration };
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
  const now = Date.now();

  if (lastMatches && now - lastMatchesFetchedAt < MATCHES_CACHE_TTL_MS) {
    runtimeMetrics.cacheHits++;
    return res.status(200).json(stripCompetitionFromMatchesPayload(lastMatches));
  }

  const result = await fetchFootballData('matches');
  pushMetricSample(runtimeMetrics.apiFetchMs, result.durationMs);

  if (result.status === 200) {
    lastMatches = result.data;
    if (ENABLE_CHANGE_DETECTION) {
      lastMatchesHash = getMatchesHash(lastMatches);
    }
    lastMatchesFetchedAt = Date.now();
    return res.status(200).json(stripCompetitionFromMatchesPayload(lastMatches));
  }

  if (lastMatches) {
    res.set('X-Data-Source', 'stale-cache');
    return res.status(200).json(stripCompetitionFromMatchesPayload(lastMatches));
  }

  res.status(result.status).json(result.data);
});

// Cache-only endpoint: returns immediately and never calls the upstream API.
app.get('/api/matches/cached', (req, res) => {
  if (!lastMatches) {
    return res.status(503).json({
      message: 'No cached matches available yet',
      cached: false,
    });
  }

  res.set('X-Data-Source', 'cache-only');
  res.status(200).json({
    cached: true,
    fetchedAt: new Date(lastMatchesFetchedAt).toISOString(),
    data: stripCompetitionFromMatchesPayload(lastMatches),
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

let lastMatches = null;
let lastMatchesHash = '';
let lastMatchesFetchedAt = 0;
let intervalId = null;
let longIntervalId = null;
let clientsCount = 0;
let isCheckingUpdates = false;
let rerunUpdateCheck = false;

const MATCHES_CACHE_TTL_MS = 15 * 1000;

function startInterval() {
  if (!intervalId) {
    const runNext = async () => {
      await checkForUpdates();
      intervalId = setTimeout(runNext, POLL_INTERVAL_MS);
    };
    runNext();
  }
}

function stopInterval() {
  if (intervalId) {
    clearTimeout(intervalId);
    intervalId = null;
  }
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
  clientsCount++;
  console.log(`Client connected. Total clients: ${clientsCount}. Transport: ${socket.conn.transport.name}`);

  socket.conn.on('upgrade', () => {
    console.log(`Client transport upgraded to: ${socket.conn.transport.name}`);
  });

  if (lastMatches) {
    socket.emit('matchesUpdate', stripCompetitionFromMatchesPayload(lastMatches));
  }

  startInterval();

  socket.on('disconnect', (reason) => {
    console.log(`Client disconnected. Reason: ${reason}`);
    clientsCount--;
    if (clientsCount === 0) {
      stopInterval();
    }
  });
});

// Стартираме дългия интервал веднага, независимо от клиентите
startLongInterval();

// Start the self-pinging service
startSelfPing();

// Извикваме проверката веднага веднъж при стартиране на сървъра
checkForUpdates();

async function checkForUpdates() {
  if (isCheckingUpdates) {
    rerunUpdateCheck = true;
    return;
  }

  isCheckingUpdates = true;
  const checkStartedAt = Date.now();

  try {
    const result = await fetchFootballData('matches');
    
    if (result.status === 200) {
      lastMatches = result.data;
      lastMatchesFetchedAt = Date.now();

      if (ENABLE_CHANGE_DETECTION) {
        const currentHash = getMatchesHash(lastMatches);
        if (currentHash !== lastMatchesHash) {
          lastMatchesHash = currentHash;
          io.emit('matchesUpdate', stripCompetitionFromMatchesPayload(lastMatches));
          runtimeMetrics.wsEmits++;
        }
      } else {
        io.emit('matchesUpdate', stripCompetitionFromMatchesPayload(lastMatches));
        runtimeMetrics.wsEmits++;
      }
    }
  } catch (error) {
    io.emit('matchesUpdate', { message: 'Failed to fetch match updates', details: error.message });
    runtimeMetrics.wsEmits++;
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
  console.log('[Config] Environment settings:');
  console.log(`  POLL_INTERVAL_MS      = ${process.env.POLL_INTERVAL_MS ?? '(not set, default 30000ms)'}`);
  console.log(`  UPSTREAM_TIMEOUT_MS   = ${process.env.UPSTREAM_TIMEOUT_MS ?? '(not set, default 15000ms)'}`);
  console.log(`  ENABLE_CHANGE_DETECTION = ${process.env.ENABLE_CHANGE_DETECTION ?? '(not set, default false)'}`);
  console.log(`  SOCKET_TRANSPORT_MODE = ${process.env.SOCKET_TRANSPORT_MODE ?? '(not set, default hybrid)'}`);
  console.log(`  RENDER_EXTERNAL_URL   = ${process.env.RENDER_EXTERNAL_URL ?? '(not set, self-ping disabled)'}`);
  console.log('[Config] Active values:');
  console.log(`  POLL_INTERVAL_MS      → ${POLL_INTERVAL_MS}ms`);
  console.log(`  UPSTREAM_TIMEOUT_MS   → ${HAS_UPSTREAM_TIMEOUT ? `${UPSTREAM_TIMEOUT_MS}ms` : 'disabled'}`);
  console.log(`  ENABLE_CHANGE_DETECTION → ${ENABLE_CHANGE_DETECTION}`);
  console.log(`  SOCKET_TRANSPORT_MODE → ${SOCKET_WEBSOCKET_ONLY ? 'websocket-only' : 'hybrid (polling + websocket)'}`);
});
