const express = require('express');
const cors = require('cors');

// ⚠️ Само за development – игнорира SSL грешки
process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors()); // Разрешаваме заявки отвън

const fetchFootballData = async (endpoint, res) => {
  const selected = { version: "v4", competition: "2018" };
  const apiUrl = `https://api.football-data.org/${selected.version}/competitions/${selected.competition}/${endpoint}`;

  const response = await fetch(apiUrl, {
    headers: {
      'X-Auth-Token': 'c8d23279fec54671a43fcd93068762d1' // 🔁 замени с валиден токен, ако се изисква
    }
  });
  res.status(response.status).json(await response.json());
  // axios.get(apiUrl, { headers: apiHeaders })
  //   .then(response => {
  //     res.setHeader('Content-Type', 'application/json');
  //     res.status(response.status).json(response.data);
  //   })
  //   .catch(error => {
  //     console.error(error);
  //     res.status(500).json({ error: 'Internal Server Error' });
  //   });
};

app.get('/api/matches', async (req, res) => {
  await fetchFootballData("matches", res);
});

// Проста proxy ендпойнт
// app.get('/api/matches', async (req, res) => {
//   try {
//     const fetch = (await import('node-fetch')).default;

//     const selected = { version: "v4", competition: "2018" };
//     const response = await fetch(`https://api.football-data.org/${selected.version}/competitions/${selected.competition}/matches`, {
//       headers: {
//         'X-Auth-Token': 'c8d23279fec54671a43fcd93068762d1' // 🔁 замени с валиден токен, ако се изисква
//       }
//     });

//     if (!response.ok) {
//       throw new Error(`Upstream API returned status ${response.status}`);
//     }

//     const data = await response.json();
//     res.json(data);
//   } catch (error) {
//     console.error('Error in proxy:', error.message);
//     res.status(500).json({ error: 'Proxy error', details: error.message });
//   }
// });

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
