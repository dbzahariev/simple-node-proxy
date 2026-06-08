const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

const FOOTBALL_API = {
  version: 'v4',
  competition: 'WC', //2018 European Championship; 200 world cup;
  baseUrl: 'https://api.football-data.org',
  token: 'c8d23279fec54671a43fcd93068762d1', // Replace with a valid token if needed
};

async function fetchFootballData(endpoint) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000); // 15 секунди таймаут

  try {
    const url = `${FOOTBALL_API.baseUrl}/${FOOTBALL_API.version}/competitions/${FOOTBALL_API.competition}/${endpoint}`;
    const startTime = Date.now();

    const response = await fetch(url, {
      headers: { 'X-Auth-Token': FOOTBALL_API.token },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }
    const data = await response.json();
    const duration = Date.now() - startTime;
    console.log(`[API Log] Request to ${endpoint} took ${duration}ms`);
    return { status: response.status, data };
  } catch (error) {
    const errorMsg = error.name === 'AbortError' ? 'Request timed out' : error.message;
    console.error(`[API Error] ${endpoint}:`, errorMsg);
    return { status: 500, data: { error: errorMsg } };
  } finally {
    clearTimeout(timeout);
  }
}

// Health-check endpoint for self-pings and monitoring services
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.get('/api/matches', async (req, res) => {
  const result = await fetchFootballData('matches');
  res.status(result.status).json(result.data);
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

let lastMatches = null;
let lastMatchesHash = '';
let intervalId = null;
let longIntervalId = null;
let clientsCount = 0;

function startInterval() {
  if (!intervalId) {
    const runNext = async () => {
      await checkForUpdates();
      intervalId = setTimeout(runNext, 30 * 1000); // 30 seconds
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
  console.log(`Client connected. Total clients: ${clientsCount}`);

  startInterval();
  checkForUpdates();

  socket.on('disconnect', () => {
    console.log('Client disconnected');
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
  try {
    const result = await fetchFootballData('matches');
    
    if (result.status === 200) {
      // Create a hash of the new data to compare efficiently
      const currentDataStr = JSON.stringify(result.data);
      const currentHash = crypto.createHash('md5').update(currentDataStr).digest('hex');

      if (currentHash !== lastMatchesHash) {
        lastMatches = result.data;
        lastMatchesHash = currentHash;
      }
      
      // Use volatile to avoid memory bloat from slow clients
      io.volatile.emit('matchesUpdate', lastMatches);
    } else if (lastMatches) {
      io.volatile.emit('matchesUpdate', lastMatches);
    }
  } catch (error) {
    io.volatile.emit('matchesUpdate', { message: 'Failed to fetch match updates', details: error.message });
  }
}

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
