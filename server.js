// GSN Friend Game Pass Search API
// Deploy this Node.js app on a public HTTPS host (Render/Railway/VPS).
// Install: npm install
// Start: npm start

const express = require("express");
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const CACHE = new Map();
const CACHE_MS = 5 * 60 * 1000;

async function getJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Accept": "application/json", ...(options.headers || {}) }
  });
  if (!response.ok) throw new Error(`Roblox API returned ${response.status}`);
  return response.json();
}

async function findUser(username) {
  const data = await getJson("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: true })
  });
  return data.data && data.data[0];
}

async function getAllGames(userId) {
  let cursor = "";
  const games = [];
  for (let page = 0; page < 4; page++) {
    const url = `https://games.roblox.com/v2/users/${userId}/games?accessFilter=Public&sortOrder=Asc&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const data = await getJson(url);
    games.push(...(data.data || []));
    if (!data.nextPageCursor) break;
    cursor = data.nextPageCursor;
  }
  return games;
}

async function getPasses(universeId) {
  let cursor = "";
  const passes = [];
  for (let page = 0; page < 3; page++) {
    const url = `https://games.roblox.com/v1/games/${universeId}/game-passes?limit=50&sortOrder=Asc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const data = await getJson(url);
    passes.push(...(data.data || []));
    if (!data.nextPageCursor) break;
    cursor = data.nextPageCursor;
  }
  return passes;
}

app.get("/search", async (req, res) => {
  const username = String(req.query.username || "").trim();
  if (!username || username.length > 20) {
    return res.status(400).json({ error: "Enter a valid Roblox username." });
  }

  const key = username.toLowerCase();
  const cached = CACHE.get(key);
  if (cached && Date.now() - cached.time < CACHE_MS) {
    return res.json(cached.value);
  }

  try {
    const user = await findUser(username);
    if (!user) return res.status(404).json({ error: "Roblox user was not found." });

    const games = await getAllGames(user.id);
    const collected = [];
    for (const game of games) {
      try {
        const passes = await getPasses(game.id);
        for (const pass of passes) {
          if (pass.id) {
            collected.push({
              id: pass.id,
              name: pass.name || "Game Pass",
              price: pass.price ?? null,
              gameName: game.name || "Experience"
            });
          }
        }
      } catch (_) {
        // Skip an experience whose public pass list cannot be read.
      }
    }

    const unique = [...new Map(collected.map(p => [p.id, p])).values()]
      .sort((a, b) => (a.price ?? 0) - (b.price ?? 0))
      .slice(0, 60);

    const result = {
      user: { id: user.id, username: user.name, displayName: user.displayName },
      passes: unique,
      note: "Only public experiences and publicly visible passes can be listed."
    };
    CACHE.set(key, { time: Date.now(), value: result });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: "Could not retrieve passes right now. Try again later.", detail: err.message });
  }
});

app.get("/", (_, res) => res.send("GSN Friend Pass Search API is running."));
app.listen(PORT, () => console.log(`GSN API listening on ${PORT}`));
