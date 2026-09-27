import { getStore } from "@netlify/blobs";

const QUESTIONS = [
  { truth: "Accurate" },
  { truth: "Misleading" },
  { truth: "Accurate" },
  { truth: "False" },
  { truth: "Misleading" },
  { truth: "Accurate" },
  { truth: "Misleading" },
  { truth: "False" },
];

const BET = 25_000;
const LOCK = 3_000;
const REVEAL = 10_000;
const STEP = BET + LOCK + REVEAL;
const TOTAL = 12;

function response(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

function phaseOf(game, now) {
  if (!game || game.status === "waiting") {
    return { status: "waiting", phase: "waiting", phaseLabel: "Waiting", questionIndex: 0, phaseEndsAt: null, phaseProgress: 0 };
  }

  const elapsed = now - game.startAt;
  if (elapsed < 0) {
    return { status: "running", phase: "bet", phaseLabel: "Get ready", questionIndex: 0, phaseEndsAt: game.startAt, phaseProgress: 0 };
  }

  const qi = Math.floor(elapsed / STEP);
  if (qi >= QUESTIONS.length) {
    return { status: "finished", phase: "finished", phaseLabel: "Finished", questionIndex: QUESTIONS.length - 1, phaseEndsAt: null, phaseProgress: 1 };
  }

  const within = elapsed % STEP;
  if (within < BET) {
    return { status: "running", phase: "bet", phaseLabel: "Betting", questionIndex: qi, phaseEndsAt: now + (BET - within), phaseProgress: within / BET };
  }
  if (within < BET + LOCK) {
    return { status: "running", phase: "lock", phaseLabel: "Locked", questionIndex: qi, phaseEndsAt: now + (BET + LOCK - within), phaseProgress: (within - BET) / LOCK };
  }
  return { status: "running", phase: "reveal", phaseLabel: "Reveal", questionIndex: qi, phaseEndsAt: now + (STEP - within), phaseProgress: (within - BET - LOCK) / REVEAL };
}

async function getGame(store) {
  let game = await store.get("game", { type: "json" });
  if (!game) {
    game = { status: "waiting", gameId: crypto.randomUUID(), createdAt: Date.now() };
    await store.setJSON("game", game);
  }
  return game;
}

async function listKeys(store, prefix) {
  const out = [];
  let cursor;
  do {
    const r = await store.list({ prefix, cursor });
    out.push(...(r.blobs || []));
    cursor = r.cursor;
  } while (cursor);
  return out;
}

async function getWallet(store, gameId, playerId) {
  const keys = await listKeys(store, `sub/${gameId}/${playerId}/`);
  let spent = 0, shared = 0, score = 0;
  for (const k of keys) {
    const s = await store.get(k.key, { type: "json" });
    if (!s) continue;
    spent += s.coins || 0;
    shared += s.share ? 1 : 0;
    const truth = QUESTIONS[s.questionIndex]?.truth;
    if (s.guess === truth) score += (s.coins || 0) * 2;
    else score -= s.coins || 0;
  }
  return { coinsLeft: Math.max(0, TOTAL - spent), shareLeft: Math.max(0, 1 - shared), score };
}

async function getSubmission(store, gameId, playerId, q) {
  return store.get(`sub/${gameId}/${playerId}/${q}`, { type: "json" });
}

async function playerCount(store, gameId) {
  return (await listKeys(store, `player/${gameId}/`)).length;
}

async function submittedCount(store, gameId, q) {
  const keys = await listKeys(store, `sub/${gameId}/`);
  return keys.filter((x) => x.key.endsWith(`/${q}`)).length;
}

async function finalStats(store, gameId) {
  const playerKeys = await listKeys(store, `player/${gameId}/`);
  const subKeys = await listKeys(store, `sub/${gameId}/`);

  const players = [];
  for (const p of playerKeys) {
    const obj = await store.get(p.key, { type: "json" });
    if (obj) players.push(obj);
  }

  const subs = [];
  for (const s of subKeys) {
    const obj = await store.get(s.key, { type: "json" });
    if (obj) subs.push(obj);
  }

  const engagement = QUESTIONS.map((_, i) => ({
    questionIndex: i,
    engagement: subs.filter((s) => s.questionIndex === i).reduce((a, s) => a + (s.coins || 0) + (s.share ? 2 : 0), 0),
  })).sort((a, b) => b.engagement - a.engagement);

  const leaderboard = [];
  for (const p of players) {
    const w = await getWallet(store, gameId, p.playerId);
    leaderboard.push({ name: p.name, score: w.score });
  }
  leaderboard.sort((a, b) => b.score - a.score);

  return { mostEngaging: engagement[0] || null, leaderboard };
}

export default async (req, context) => {
  try {
    const store = getStore("fake-news-auction");
    const now = Date.now();
    const url = new URL(req.url);
    const playerIdFromQuery = url.searchParams.get("playerId");
    let game = await getGame(store);

    if (req.method === "POST") {
      const body = await req.json();

      if (body.action === "reset") {
        game = { status: "waiting", gameId: crypto.randomUUID(), createdAt: now };
        await store.setJSON("game", game);
      } else if (body.action === "start") {
        game = { ...game, status: "running", startAt: now + 1500 };
        await store.setJSON("game", game);
      } else if (body.action === "join") {
        const name = String(body.name || "").trim().slice(0, 24);
        if (!name) return response({ error: "Name required" }, 400);
        if (!body.playerId) return response({ error: "Player ID required" }, 400);
        await store.setJSON(`player/${game.gameId}/${body.playerId}`, { playerId: body.playerId, name, joinedAt: now });
      } else if (body.action === "submit") {
        const phase = phaseOf(game, now);
        if (phase.phase !== "bet" || phase.questionIndex !== body.questionIndex) return response({ error: "Betting is closed" }, 409);

        const existing = await getSubmission(store, game.gameId, body.playerId, body.questionIndex);
        if (existing) return response({ error: "Already submitted" }, 409);

        const wallet = await getWallet(store, game.gameId, body.playerId);
        const coins = Number(body.coins);
        if (!Number.isInteger(coins) || coins < 0 || coins > 3 || coins > wallet.coinsLeft) return response({ error: "Invalid coin amount" }, 400);
        if (!["Accurate", "Misleading", "False"].includes(body.guess)) return response({ error: "Choose Accurate, Misleading or False" }, 400);
        if (body.share && wallet.shareLeft < 1) return response({ error: "Share already used" }, 400);

        await store.setJSON(`sub/${game.gameId}/${body.playerId}/${body.questionIndex}`, {
          playerId: body.playerId,
          questionIndex: body.questionIndex,
          coins,
          guess: body.guess,
          share: !!body.share,
          submittedAt: now,
        });
      }
    }

    const phase = phaseOf(game, now);
    const base = {
      ...phase,
      serverNow: now,
      gameId: game.gameId,
      playerCount: await playerCount(store, game.gameId),
      submittedCount: phase.status === "running" ? await submittedCount(store, game.gameId, phase.questionIndex) : 0,
    };

    if (playerIdFromQuery) {
      base.wallet = await getWallet(store, game.gameId, playerIdFromQuery);
      if (phase.status === "running") {
        base.playerSubmission = { submitted: !!(await getSubmission(store, game.gameId, playerIdFromQuery, phase.questionIndex)) };
      }
    }

    if (phase.status === "finished") Object.assign(base, await finalStats(store, game.gameId));
    return response(base);
  } catch (error) {
    return response({ error: error?.message || "Server error" }, 500);
  }
};
