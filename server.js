// Replace the old backend/server.js with this version.
// Uses Roblox's replacement Game Pass endpoint announced for the old endpoint.

const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const cache = new Map();
const CACHE_MS = 5 * 60 * 1000;

async function getJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Accept": "application/json",
      "User-Agent": "GSN-FriendPass-Search/1.1",
      ...(options.headers || {})
    }
  });

  const body = await response.text();
  let data;
  try { data = JSON.parse(body); }
  catch { throw new Error(`Roblox returned non-JSON (${response.status})`); }

  if (!response.ok) {
    throw new Error(`Roblox API ${response.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

async function findUser(username) {
  const data = await getJson("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      usernames: [username],
      excludeBannedUsers: true
    })
  });
  return data.data?.[0] || null;
}

// Collect all public experiences owned by the user, following page cursors.
async function getAllGames(userId) {
  const games = [];
  let cursor = null;

  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({
      accessFilter: "Public",
      sortOrder: "Asc",
      limit: "50"
    });
    if (cursor) params.set("cursor", cursor);

    const data = await getJson(
      `https://games.roblox.com/v2/users/${userId}/games?${params}`
    );

    games.push(...(data.data || []));
    cursor = data.nextPageCursor;
    if (!cursor) break;
  }
  return games;
}

// New endpoint: old /v1/games/{universeId}/game-passes endpoint was deprecated.
async function getAllPasses(universeId) {
  const passes = [];
  let pageToken = null;

  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({
      passView: "Full",
      pageSize: "100"
    });
    if (pageToken) params.set("pageToken", pageToken);

    const data = await getJson(
      `https://apis.roblox.com/game-passes/v1/universes/${universeId}/game-passes?${params}`
    );

    passes.push(...(data.gamePasses || []));
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return passes;
}

app.get("/", (_, res) => {
  res.send("GSN Friend Pass Search API is running.");
});

app.get("/search", async (req, res) => {
  const username = String(req.query.username || "").trim();

  if (!username || username.length > 20) {
    return res.status(400).json({ error: "اكتب اسم مستخدم Roblox صحيح." });
  }

  const key = username.toLowerCase();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.time < CACHE_MS) {
    return res.json(cached.value);
  }

  try {
    const user = await findUser(username);
    if (!user) {
      return res.status(404).json({ error: "لم يتم العثور على حساب بهذا الاسم." });
    }

    const games = await getAllGames(user.id);
    const results = [];
    const errors = [];

    // Query every public game found; one failed game won't stop the remaining ones.
    for (const game of games) {
      try {
        const passes = await getAllPasses(game.id);
        for (const pass of passes) {
          const id = Number(pass.id);
          if (!id) continue;

          results.push({
            id,
            name: pass.displayName || pass.name || "Game Pass",
            price: pass.price ?? null,
            gameName: game.name || "Experience",
            gameId: game.id,
            creatorName: pass.creator?.name || user.name
          });
        }
      } catch (error) {
        errors.push({ game: game.name || String(game.id), error: error.message });
      }
    }

    const unique = [...new Map(results.map(pass => [pass.id, pass])).values()]
      .sort((a, b) => {
        if (a.price == null && b.price == null) return a.name.localeCompare(b.name);
        if (a.price == null) return 1;
        if (b.price == null) return -1;
        return a.price - b.price;
      });

    const result = {
      user: {
        id: user.id,
        username: user.name,
        displayName: user.displayName
      },
      gamesChecked: games.length,
      passes: unique,
      failedGames: errors.length,
      note: "Only public experiences and passes visible through Roblox public endpoints can be listed."
    };

    cache.set(key, { time: Date.now(), value: result });
    return res.json(result);
  } catch (error) {
    console.error(error);
    return res.status(502).json({
      error: "تعذر جلب بيانات Roblox حاليًا. جرّب مرة أخرى بعد قليل.",
      detail: error.message
    });
  }
});

app.listen(PORT, () => console.log(`GSN API listening on ${PORT}`));
