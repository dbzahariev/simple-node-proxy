const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const http = require('http');
const { Server } = require('socket.io');

// ⚠️ For development only – ignore SSL errors
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

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
  try {
    const url = `${FOOTBALL_API.baseUrl}/${FOOTBALL_API.version}/competitions/${FOOTBALL_API.competition}/${endpoint}`;
    const response = await fetch(url, {
      headers: { 'X-Auth-Token': FOOTBALL_API.token },
    });
    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }
    const data = await response.json();
    return { status: response.status, data };
  } catch (error) {
    console.error('fetchFootballData error:', error);
    return { status: 500, data: { error: error.message } };
  }
}

// app.get('/api/matches', async (req, res) => {
//   await checkForUpdates(true);
// });

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

let lastMatches = null;
let intervalId = null;
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

io.on('connection', (socket) => {
  clientsCount++;

  startInterval();
  checkForUpdates();

  socket.on('disconnect', () => {
    clientsCount--;
    if (clientsCount === 0) {
      stopInterval();
    }
  });
});

async function checkForUpdates() {
  try {
    const { data } = await fetchFootballData('matches');
    if (JSON.stringify(data) !== JSON.stringify(lastMatches)) {
      lastMatches = data;
      io.emit('matchesUpdate', data);
    } else {
      io.emit('matchesUpdate', lastMatches);
    }
  } catch (error) {
    io.emit('matchesUpdate', { message: 'Failed to fetch match updates', details: error.message });
  }
}

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
