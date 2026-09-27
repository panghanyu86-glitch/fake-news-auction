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

const BET = 30_000;
const REVEAL = 8_000;
const STEP = BET + REVEAL;
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
    return {
      status: "waiting",
      phase: "waiting",
      phaseLabel: "Waiting",
      questionIndex: 0,
      phaseEndsAt: null,
      phaseProgress: 0,
    };
  }

  const elapsed = now - game.startAt;

  if (elapsed < 0) {
    return {
      status: "running",
      phase: "bet",
      phaseLabel: "Get ready",
      questionIndex: 0,
      phaseEndsAt: game.startAt,
      phaseProgress: 0,
    };
  }

  const questionIndex = Math.floor(elapsed / STEP);

  if (questionIndex >= QUESTIONS.length) {
    return {
      status: "finished",
      phase: "finished",
      phaseLabel: "Finished",
      questionIndex: QUESTIONS.length - 1,
      phaseEndsAt: null,
      phaseProgress: 1,
    };
  }

  const within = elapsed % STEP;

  if (within < BET) {
    return {
      status: "running",
      phase: "bet",
      phaseLabel: "Betting",
      questionIndex,
      phaseEndsAt: now + (BET - within),
      phaseProgress: within / BET,
    };
  }

  return {
    status: "running",
    phase: "reveal",
    phaseLabel: "Result",
    questionIndex,
    phaseEndsAt: now + (STEP - within),
    phaseProgress: (within - BET) / REVEAL,
  };
}

async function getGame(store) {
  let game = await store.get("game", { type: "json" });

  if (!game) {
    game = {
      status: "waiting",
      gameId: crypto.randomUUID(),
      createdAt: Date.now(),
    };
    await store.setJSON("game", game);
  }

  return game;
}

async function listKeys(store, prefix) {
  const out = [];
  let cursor;

  do {
    const result = await store.list({ prefix, cursor });
    out.push(...(result.blobs || []));
    cursor = result.cursor;
  } while (cursor);

  return out;
}

async function getSubmission(store, gameId, playerId, questionIndex) {
  return store.get(
    `sub/${gameId}/${playerId}/${questionIndex}`,
    { type: "json" }
  );
}

async function getPlayer(store, gameId, playerId) {
  return store.get(
    `player/${gameId}/${playerId}`,
    { type: "json" }
  );
}

async function getWallet(store, gameId, playerId, scoredThrough = Infinity) {
  const keys = await listKeys(store, `sub/${gameId}/${playerId}/`);

  let spent = 0;
  let shared = 0;
  let score = 0;

  for (const key of keys) {
    const submission = await store.get(key.key, { type: "json" });
    if (!submission) continue;

    spent += submission.coins || 0;
    shared += submission.share ? 1 : 0;

    if (submission.questionIndex <= scoredThrough) {
      const truth = QUESTIONS[submission.questionIndex]?.truth;
      if (submission.guess === truth) {
        score += (submission.coins || 0) * 2;
      } else {
        score -= submission.coins || 0;
      }
    }
  }

  return {
    coinsLeft: Math.max(0, TOTAL - spent),
    shareLeft: Math.max(0, 1 - shared),
    score,
  };
}

async function playerCount(store, gameId) {
  return (await listKeys(store, `player/${gameId}/`)).length;
}

async function submittedCount(store, gameId, questionIndex) {
  const keys = await listKeys(store, `sub/${gameId}/`);
  return keys.filter((x) => x.key.endsWith(`/${questionIndex}`)).length;
}

async function finalStats(store, gameId) {
  const playerKeys = await listKeys(store, `player/${gameId}/`);
  const subKeys = await listKeys(store, `sub/${gameId}/`);

  const players = [];
  for (const key of playerKeys) {
    const player = await store.get(key.key, { type: "json" });
    if (player) players.push(player);
  }

  const submissions = [];
  for (const key of subKeys) {
    const submission = await store.get(key.key, { type: "json" });
    if (submission) submissions.push(submission);
  }

  const engagement = QUESTIONS.map((_, i) => ({
    questionIndex: i,
    engagement: submissions
      .filter((s) => s.questionIndex === i)
      .reduce(
        (sum, s) => sum + (s.coins || 0) + (s.share ? 2 : 0),
        0
      ),
  })).sort((a, b) => b.engagement - a.engagement);

  const leaderboard = [];

  for (const player of players) {
    const wallet = await getWallet(store, gameId, player.playerId);
    leaderboard.push({
      name: player.name,
      score: wallet.score,
    });
  }

  leaderboard.sort((a, b) => b.score - a.score);

  return {
    mostEngaging: engagement[0] || null,
    leaderboard,
  };
}

export default async (req) => {
  try {
    const store = getStore("fake-news-auction");
    const now = Date.now();
    const url = new URL(req.url);
    const playerIdFromQuery = url.searchParams.get("playerId");

    let game = await getGame(store);

    if (req.method === "POST") {
      const body = await req.json();

      if (body.action === "reset") {
        game = {
          status: "waiting",
          gameId: crypto.randomUUID(),
          createdAt: now,
        };
        await store.setJSON("game", game);
        return response({ ok: true, gameId: game.gameId });
      }

      if (body.action === "start") {
        game = {
          ...game,
          status: "running",
          startAt: now + 1500,
        };
        await store.setJSON("game", game);
        return response({ ok: true, gameId: game.gameId });
      }

      if (body.action === "join") {
        const name = String(body.name || "").trim().slice(0, 24);

        if (!name) return response({ error: "Name required" }, 400);
        if (!body.playerId) {
          return response({ error: "Player ID required" }, 400);
        }

        await store.setJSON(
          `player/${game.gameId}/${body.playerId}`,
          {
            playerId: body.playerId,
            name,
            joinedAt: now,
          }
        );

        return response({
          ok: true,
          gameId: game.gameId,
          name,
        });
      }

      if (body.action === "submit") {
        const phase = phaseOf(game, now);

        if (
          phase.phase !== "bet" ||
          phase.questionIndex !== body.questionIndex
        ) {
          return response({ error: "Betting is closed" }, 409);
        }

        const player = await getPlayer(
          store,
          game.gameId,
          body.playerId
        );

        if (!player) {
          return response(
            { error: "You are not joined to this game. Please rejoin." },
            409
          );
        }

        const existing = await getSubmission(
          store,
          game.gameId,
          body.playerId,
          body.questionIndex
        );

        if (existing) {
          return response({ error: "Already submitted" }, 409);
        }

        const wallet = await getWallet(
          store,
          game.gameId,
          body.playerId
        );

        const coins = Number(body.coins);

        if (
          !Number.isInteger(coins) ||
          coins < 0 ||
          coins > 3 ||
          coins > wallet.coinsLeft
        ) {
          return response({ error: "Invalid coin amount" }, 400);
        }

        if (
          !["Accurate", "Misleading", "False"].includes(body.guess)
        ) {
          return response(
            { error: "Choose Accurate, Misleading or False" },
            400
          );
        }

        if (body.share && wallet.shareLeft < 1) {
          return response({ error: "Share already used" }, 400);
        }

        await store.setJSON(
          `sub/${game.gameId}/${body.playerId}/${body.questionIndex}`,
          {
            playerId: body.playerId,
            questionIndex: body.questionIndex,
            coins,
            guess: body.guess,
            share: !!body.share,
            submittedAt: now,
          }
        );

        return response({
          ok: true,
          gameId: game.gameId,
          questionIndex: body.questionIndex,
        });
      }

      return response({ error: "Unknown action" }, 400);
    }

    const phase = phaseOf(game, now);

    const base = {
      ...phase,
      serverNow: now,
      gameId: game.gameId,
      playerCount: await playerCount(store, game.gameId),
      submittedCount:
        phase.status === "running"
          ? await submittedCount(
              store,
              game.gameId,
              phase.questionIndex
            )
          : 0,
    };

    if (playerIdFromQuery) {
      const currentPlayer = await getPlayer(
        store,
        game.gameId,
        playerIdFromQuery
      );

      base.registered = !!currentPlayer;

      const scoredThrough =
        phase.status === "finished"
          ? Infinity
          : phase.status === "running" && phase.phase === "reveal"
          ? phase.questionIndex
          : phase.status === "running"
          ? phase.questionIndex - 1
          : -1;

      base.wallet = await getWallet(
        store,
        game.gameId,
        playerIdFromQuery,
        scoredThrough
      );

      if (phase.status === "running") {
        const submission = await getSubmission(
          store,
          game.gameId,
          playerIdFromQuery,
          phase.questionIndex
        );

        if (submission) {
          const correct =
            submission.guess === QUESTIONS[phase.questionIndex]?.truth;

          base.playerSubmission = {
            submitted: true,
            coins: submission.coins,
            guess: submission.guess,
            share: submission.share,
            correct,
            scoreDelta: correct
              ? submission.coins * 2
              : -submission.coins,
          };
        } else {
          base.playerSubmission = { submitted: false };
        }
      }
    }

    if (phase.status === "finished") {
      Object.assign(
        base,
        await finalStats(store, game.gameId)
      );
    }

    return response(base);
  } catch (error) {
    return response(
      { error: error?.message || "Server error" },
      500
    );
  }
};
