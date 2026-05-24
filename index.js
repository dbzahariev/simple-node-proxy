const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const http = require('http');
const { Server } = require('socket.io');

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
    return { status: 500, data: { error: error.message } };
  } finally {
    clearTimeout(timeout);
  }
}

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
let intervalId = null;
let longIntervalId = null;
let clientsCount = 0;

function startInterval() {
  if (!intervalId) {
    intervalId = setInterval(async () => {
      await checkForUpdates();
    }, 10 * 1000); // Check for updates every 10 seconds
  }
}

function stopInterval() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

function startLongInterval() {
  if (!longIntervalId) {
    const TEN_MINUTES = 10 * 60 * 1000;
    console.log(`[${new Date().toLocaleTimeString()}] Long interval initialized (10 min)`);
    
    const runNext = () => {
      longIntervalId = setTimeout(async () => {
        console.log(`[${new Date().toLocaleTimeString()}] Background check (long interval) starting...`);
        await checkForUpdates();
        const nextTime = new Date(Date.now() + TEN_MINUTES).toLocaleTimeString();
        console.log(`[${new Date().toLocaleTimeString()}] Background check finished. Next check scheduled for ${nextTime}`);
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

// Извикваме проверката веднага веднъж при стартиране на сървъра
checkForUpdates();

async function checkForUpdates() {
  try {
    const result = await fetchFootballData('matches');
    
    // Обновяваме само ако заявката е успешна (status 200)
    if (result.status === 200) {
      if (JSON.stringify(result.data) !== JSON.stringify(lastMatches)) {
        lastMatches = result.data;
      }
      io.emit('matchesUpdate', lastMatches);
    } else if (lastMatches) {
      // При грешка от API-то, пращаме последната успешна кеширана информация
      io.emit('matchesUpdate', lastMatches);
    }
  } catch (error) {
    io.emit('matchesUpdate', { message: 'Failed to fetch match updates', details: error.message });
  }
}

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
