'use strict';

// GSN Friend Pass API — Node.js 20+ / Render
// Install: npm install express
// Start: node server.js

const express = require('express');
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

const PORT = Number(process.env.PORT || 3000);
const ROBLOX_TIMEOUT_MS = 12000;
const MAX_GAMES = 50;
const MAX_PASSES = 100;

async function robloxJSON(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ROBLOX_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'GSN-FriendPass/2.0 (Roblox experience backend)'
      }
    });

    const body = await response.text();
    let json;

    try {
      json = body ? JSON.parse(body) : {};
    } catch {
      throw new Error(`Roblox returned invalid JSON (HTTP ${response.status})`);
    }

    if (!response.ok) {
      const detail =
        json?.errors?.[0]?.message ||
        json?.message ||
        `HTTP ${response.status}`;

      const error = new Error(`Roblox API: ${detail}`);
      error.status = response.status;
      throw error;
    }

    return json;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('انتهت مهلة الاتصال بخوادم Roblox. حاول مرة أخرى.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const clean = value => String(value ?? '').trim();

const numberId = value =>
  Number.isSafeInteger(Number(value)) && Number(value) > 0;

async function findUser(username) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    ROBLOX_TIMEOUT_MS
  );

  let result;

  try {
    const response = await fetch(
      'https://users.roblox.com/v1/usernames/users',
      {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          usernames: [username],
          excludeBannedUsers: false
        })
      }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        data?.errors?.[0]?.message ||
        `تعذر البحث عن الحساب (HTTP ${response.status}).`
      );
    }

    result = data;
  } finally {
    clearTimeout(timer);
  }

  const user = result?.data?.[0];

  if (!user?.id) {
    throw new Error(
      'لم يتم العثور على اسم المستخدم. تأكد من كتابته بشكل صحيح.'
    );
  }

  return {
    id: Number(user.id),
    username: user.name || username,
    displayName: user.displayName || user.name || username
  };
}

async function getPublicGames(userId) {
  const games = [];
  let cursor = '';

  for (
    let page = 0;
    page < 2 && games.length < MAX_GAMES;
    page++
  ) {
    const params = new URLSearchParams({
      accessFilter: 'Public',
      limit: '50',
      sortOrder: 'Asc'
    });

    if (cursor) {
      params.set('cursor', cursor);
    }

    const data = await robloxJSON(
      `https://games.roblox.com/v2/users/${userId}/games?${params}`
    );

    for (const game of (data.data || [])) {
      if (numberId(game.id)) {
        games.push({
          id: Number(game.id),
          name: clean(game.name) || 'Experience'
        });
      }

      if (games.length >= MAX_GAMES) break;
    }

    cursor = data.nextPageCursor || '';

    if (!cursor) break;
  }

  return games;
}

async function getGamePasses(universeId, gameName) {
  const params = new URLSearchParams({
    passView: 'Full',
    pageSize: '100'
  });

  const data = await robloxJSON(
    `https://apis.roblox.com/game-passes/v1/universes/${universeId}/game-passes?${params}`
  );

  const list =
    data.gamePasses ||
    data.data ||
    data.passes ||
    [];

  return list
    .map(pass => ({
      id: Number(pass.id || pass.gamePassId),
      name: clean(pass.name || pass.displayName) || 'Game Pass',
      price:
        Number.isFinite(Number(pass.price)) &&
        pass.price !== null
          ? Number(pass.price)
          : null,
      gameName
    }))
    .filter(pass => numberId(pass.id));
}

async function getImages(passes) {
  if (!passes.length) {
    return new Map();
  }

  const ids = passes.map(pass => pass.id).join(',');

  const data = await robloxJSON(
    `https://thumbnails.roblox.com/v1/game-passes?gamePassIds=${encodeURIComponent(ids)}&size=150x150&format=Png&isCircular=false`
  );

  const map = new Map();

  for (const item of (data.data || [])) {
    if (item.targetId && item.imageUrl) {
      map.set(Number(item.targetId), item.imageUrl);
    }
  }

  return map;
}

async function searchFriend(username) {
  const user = await findUser(username);
  const games = await getPublicGames(user.id);

  if (!games.length) {
    return {
      user,
      gamesChecked: 0,
      passes: []
    };
  }

  const all = [];

  for (let i = 0; i < games.length; i += 5) {
    const batch = games.slice(i, i + 5);

    const results = await Promise.allSettled(
      batch.map(game =>
        getGamePasses(game.id, game.name)
      )
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        all.push(...result.value);
      }
    }
  }

  const unique = [
    ...new Map(
      all.map(pass => [pass.id, pass])
    ).values()
  ].slice(0, MAX_PASSES);

  let images = new Map();

  try {
    images = await getImages(unique);
  } catch (error) {
    console.warn('[thumbnails]', error.message);
  }

  const passes = unique.map(pass => ({
    ...pass,
    imageUrl: images.get(pass.id) || ''
  }));

  return {
    user,
    gamesChecked: games.length,
    passes
  };
}

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'GSN Friend Pass API',
    version: '2.0',
    health: '/health',
    search: '/search?username=RobloxName'
  });
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'GSN Friend Pass API',
    timestamp: new Date().toISOString()
  });
});

app.get('/search', async (req, res) => {
  const username = clean(req.query.username);

  if (
    !username ||
    username.length > 20 ||
    !/^[A-Za-z0-9_]+$/.test(username)
  ) {
    return res.status(400).json({
      ok: false,
      error: 'اكتب اسم Roblox صحيحاً (من 1 إلى 20 حرفاً أو رقماً).'
    });
  }

  try {
    const data = await searchFriend(username);

    return res.json({
      ok: true,
      data
    });
  } catch (error) {
    console.error('[search]', username, error);

    return res.status(502).json({
      ok: false,
      error: error.message || 'حدث خطأ أثناء البحث.'
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(
    `GSN Friend Pass API listening on ${PORT}`
  );
});
