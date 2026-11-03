// Replace the existing backend/server.js with this file.
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;
const cache = new Map();
const CACHE_MS = 5 * 60 * 1000;

async function getJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Accept: "application/json", ...(options.headers || {}) }
  });
  const body = await response.text();
  let data;
  try { data = JSON.parse(body); }
  catch { throw new Error(`Non-JSON response (${response.status})`); }
  if (!response.ok) throw new Error(`Roblox API ${response.status}: ${JSON.stringify(data).slice(0, 250)}`);
  return data;
}

async function findUser(username) {
  const data = await getJson("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: true })
  });
  return data.data?.[0] || null;
}

async function getAllGames(userId) {
  const games = [];
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({ accessFilter: "Public", sortOrder: "Asc", limit: "50" });
    if (cursor) params.set("cursor", cursor);
    const data = await getJson(`https://games.roblox.com/v2/users/${userId}/games?${params}`);
    games.push(...(data.data || []));
    cursor = data.nextPageCursor;
    if (!cursor) break;
  }
  return games;
}

async function getAllPasses(universeId) {
  const passes = [];
  let pageToken = null;
  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({ passView: "Full", pageSize: "100" });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await getJson(`https://apis.roblox.com/game-passes/v1/universes/${universeId}/game-passes?${params}`);
    passes.push(...(data.gamePasses || []));
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return passes;
}

async function addThumbnails(passes) {
  // Roblox thumbnail endpoint accepts batches of game pass IDs.
  for (let i = 0; i < passes.length; i += 100) {
    const batch = passes.slice(i, i + 100);
    const ids = batch.map(p => p.id).join(",");
    try {
      const params = new URLSearchParams({
        gamePassIds: ids,
        size: "150x150",
        format: "Png",
        isCircular: "false"
      });
      const data = await getJson(`https://thumbnails.roblox.com/v1/game-passes?${params}`);
      const byId = new Map((data.data || []).map(item => [Number(item.targetId), item.imageUrl]));
      for (const pass of batch) pass.imageUrl = byId.get(Number(pass.id)) || "";
    } catch (_) {
      for (const pass of batch) pass.imageUrl = "";
    }
  }
}

app.get("/", (_, res) => res.send("GSN Friend Pass Search API is running."));

app.get("/search", async (req, res) => {
  const username = String(req.query.username || "").trim();
  if (!username || username.length > 20) return res.status(400).json({ error: "اكتب اسم مستخدم Roblox صحيح." });

  const key = username.toLowerCase();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.time < CACHE_MS) return res.json(cached.value);

  try {
    const user = await findUser(username);
    if (!user) return res.status(404).json({ error: "لم يتم العثور على حساب بهذا الاسم." });

    const games = await getAllGames(user.id);
    const results = [];
    let failedGames = 0;

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
            creatorName: pass.creator?.name || user.name,
            imageUrl: ""
          });
        }
      } catch (_) { failedGames++; }
    }

    const unique = [...new Map(results.map(pass => [pass.id, pass])).values()];
    await addThumbnails(unique);
    unique.sort((a, b) => {
      if (a.price == null && b.price == null) return a.name.localeCompare(b.name);
      if (a.price == null) return 1;
      if (b.price == null) return -1;
      return a.price - b.price;
    });

    const result = {
      user: { id: user.id, username: user.name, displayName: user.displayName },
      gamesChecked: games.length,
      passes: unique,
      failedGames
    };
    cache.set(key, { time: Date.now(), value: result });
    return res.json(result);
  } catch (error) {
    console.error(error);
    return res.status(502).json({ error: "تعذر جلب بيانات Roblox حاليًا. جرّب مرة أخرى.", detail: error.message });
  }
});

app.listen(PORT, () => console.log(`GSN API listening on ${PORT}`));
