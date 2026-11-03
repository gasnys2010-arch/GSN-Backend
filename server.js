// GSN Friend Pass Backend — Node.js 20+
'use strict';

const http = require('node:http');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 3000);
const VERSION = '4.0.1';
const TIMEOUT_MS = 15000;
const MAX_GAMES = 50;
const MAX_PASSES = 100;
const MAX_PASS_PAGES_PER_GAME = 3;

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(payload);
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'GSN-FriendPass/4.0.1',
        ...(options.headers || {})
      }
    });

    const raw = await response.text();
    let data;

    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error(`Roblox returned invalid JSON (HTTP ${response.status}).`);
    }

    if (!response.ok) {
      const message = data?.errors?.[0]?.message || data?.message || `HTTP ${response.status}`;
      throw new Error(`Roblox API: ${message}`);
    }

    return data;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('انتهت مهلة الاتصال بخوادم Roblox. حاول مرة أخرى.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveUser(username) {
  const data = await fetchJson('https://users.roblox.com/v1/usernames/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      usernames: [username],
      excludeBannedUsers: false
    })
  });

  const user = data?.data?.[0];

  if (!user?.id) {
    throw new Error('لم يتم العثور على اسم المستخدم. تأكد من كتابته بشكل صحيح.');
  }

  return {
    userId: Number(user.id),
    username: user.name || username,
    displayName: user.displayName || user.name || username
  };
}

async function getUserGames(userId) {
  const games = [];
  let cursor = '';

  for (let page = 0; page < 2 && games.length < MAX_GAMES; page++) {
    const query = new URLSearchParams({
      accessFilter: 'Public',
      limit: '50',
      sortOrder: 'Asc'
    });

    if (cursor) query.set('cursor', cursor);

    const data = await fetchJson(
      `https://games.roblox.com/v2/users/${userId}/games?${query}`
    );

    for (const game of data.data || []) {
      const universeId = Number(game.id);

      if (Number.isSafeInteger(universeId) && universeId > 0) {
        games.push({
          universeId,
          gameName: String(game.name || 'Experience')
        });
      }

      if (games.length >= MAX_GAMES) break;
    }

    cursor = data.nextPageCursor || '';
    if (!cursor) break;
  }

  return games;
}

async function getPassesForGame(game) {
  const passes = [];
  let pageToken = '';

  for (
    let page = 0;
    page < MAX_PASS_PAGES_PER_GAME && passes.length < MAX_PASSES;
    page++
  ) {
    const query = new URLSearchParams({
      passView: 'Full',
      pageSize: '100'
    });

    if (pageToken) query.set('pageToken', pageToken);

    const data = await fetchJson(
      `https://apis.roblox.com/game-passes/v1/universes/${game.universeId}/game-passes?${query}`
    );

    const rows = data.gamePasses || data.data || data.passes || [];

    for (const row of rows) {
      const id = Number(row.id || row.gamePassId);

      if (!Number.isSafeInteger(id) || id <= 0) continue;

      const rawPrice = row.price;
      const price =
        rawPrice === null || rawPrice === undefined || rawPrice === ''
          ? null
          : Number(rawPrice);

      passes.push({
        id,
        name: String(row.name || row.displayName || 'Game Pass'),
        price: Number.isFinite(price) ? price : null,
        gameName: game.gameName,
        gameUrl: `https://www.roblox.com/games/${game.universeId}`,
        buyUrl: `https://www.roblox.com/game-pass/${id}`
      });

      if (passes.length >= MAX_PASSES) break;
    }

    pageToken = data.nextPageToken || data.nextPageCursor || '';

    if (!pageToken || rows.length === 0) break;
  }

  return passes;
}

async function getThumbnails(passes) {
  const map = new Map();

  for (let i = 0; i < passes.length; i += 50) {
    const batch = passes.slice(i, i + 50);
    const ids = batch.map(pass => pass.id).join(',');

    const data = await fetchJson(
      `https://thumbnails.roblox.com/v1/game-passes?gamePassIds=${encodeURIComponent(ids)}&size=150x150&format=Png&isCircular=false`
    );

    for (const item of data.data || []) {
      if (item.targetId && item.imageUrl) {
        map.set(Number(item.targetId), item.imageUrl);
      }
    }
  }

  return map;
}

async function search(username) {
  const user = await resolveUser(username);
  const games = await getUserGames(user.userId);
  const collected = [];

  for (let i = 0; i < games.length; i += 4) {
    const batch = games.slice(i, i + 4);
    const settled = await Promise.allSettled(
      batch.map(getPassesForGame)
    );

    for (const result of settled) {
      if (result.status === 'fulfilled') {
        collected.push(...result.value);
      } else {
        console.warn(
          '[GSN] One game passes could not be loaded:',
          result.reason?.message
        );
      }
    }
  }

  const unique = [
    ...new Map(collected.map(pass => [pass.id, pass])).values()
  ].slice(0, MAX_PASSES);

  let thumbnails = new Map();

  if (unique.length) {
    try {
      thumbnails = await getThumbnails(unique);
    } catch (error) {
      console.warn('[GSN] Thumbnail lookup failed:', error.message);
    }
  }

  const passes = unique.map(pass => ({
    ...pass,
    imageUrl: thumbnails.get(pass.id) || ''
  }));

  return {
    user: {
      userId: user.userId,
      username: user.username,
      displayName: user.displayName
    },
    gamesChecked: games.length,
    passes
  };
}

const server = http.createServer(async (req, res) => {
  const base = `http://${req.headers.host || 'localhost'}`;
  const url = new URL(req.url, base);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });

    return res.end();
  }

  if (
    req.method === 'GET' &&
    (url.pathname === '/' || url.pathname === '/health')
  ) {
    return json(res, 200, {
      ok: true,
      service: 'GSN Friend Pass API',
      version: VERSION
    });
  }

  if (req.method === 'GET' && url.pathname === '/search') {
    const username = String(url.searchParams.get('username') || '').trim();

    if (!/^[A-Za-z0-9_]{1,20}$/.test(username)) {
      return json(res, 400, {
        ok: false,
        error: 'اكتب اسم Roblox صحيحاً (من 1 إلى 20 حرفاً أو رقماً).'
      });
    }

    try {
      const data = await search(username);

      return json(res, 200, {
        ok: true,
        data
      });
    } catch (error) {
      console.error('[GSN search]', username, error);

      return json(res, 502, {
        ok: false,
        error: error.message || 'حدث خطأ أثناء البحث.'
      });
    }
  }

  return json(res, 404, {
    ok: false,
    error: 'المسار غير موجود.'
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(
    `[GSN] Friend Pass API v${VERSION} listening on ${PORT}`
  );
});
