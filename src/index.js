import { DurableObject } from "cloudflare:workers";

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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
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

function emptyGame() {
  return {
    status: "waiting",
    gameId: crypto.randomUUID(),
    createdAt: Date.now(),
    players: {},
    submissions: {},
  };
}

function submissionKey(playerId, questionIndex) {
  return playerId + ":" + questionIndex;
}

function walletFor(game, playerId, rewardedThrough = Infinity) {
  let balance = TOTAL;
  let shared = 0;

  for (const sub of Object.values(game.submissions || {})) {
    if (sub.playerId !== playerId) continue;

    // The stake is paid immediately when the player submits.
    balance -= sub.coins || 0;
    shared += sub.share ? 1 : 0;

    // Winnings are only added once the answer has been revealed.
    if (sub.questionIndex <= rewardedThrough) {
      const truth = QUESTIONS[sub.questionIndex]?.truth;
      if (sub.guess === truth) {
        balance += (sub.coins || 0) * 2;
      }
    }
  }

  return {
    coinsLeft: Math.max(0, balance),
    shareLeft: Math.max(0, 1 - shared),
  };
}

function finalStats(game) {
  const submissions = Object.values(game.submissions || {});
  const engagement = QUESTIONS.map((_, i) => ({
    questionIndex: i,
    engagement: submissions
      .filter((s) => s.questionIndex === i)
      .reduce((sum, s) => sum + (s.coins || 0) + (s.share ? 2 : 0), 0),
  })).sort((a, b) => b.engagement - a.engagement);

  const leaderboard = Object.values(game.players || {})
    .map((p) => ({
      name: p.name,
      coins: walletFor(game, p.playerId).coinsLeft,
    }))
    .sort((a, b) => b.coins - a.coins);

  return {
    mostEngaging: engagement[0] || null,
    leaderboard,
  };
}

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
  }

  async readGame() {
    return (await this.ctx.storage.get("game")) || emptyGame();
  }

  async writeGame(game) {
    await this.ctx.storage.put("game", game);
  }

  async fetch(request) {
    const now = Date.now();
    const url = new URL(request.url);
    let game = await this.readGame();

    if (request.method === "POST") {
      const body = await request.json();

      if (body.action === "reset") {
        game = emptyGame();
        await this.writeGame(game);
        return json({ ok: true, gameId: game.gameId });
      }

      if (body.action === "start") {
        game.status = "running";
        game.startAt = now + 1200;
        await this.writeGame(game);
        return json({ ok: true, gameId: game.gameId });
      }

      if (body.action === "join") {
        const name = String(body.name || "").trim().slice(0, 24);
        const playerId = String(body.playerId || "");

        if (!name) return json({ error: "Name required" }, 400);
        if (!playerId) return json({ error: "Player ID required" }, 400);

        game.players[playerId] = {
          playerId,
          name,
          joinedAt: game.players[playerId]?.joinedAt || now,
          lastSeenAt: now,
        };

        await this.writeGame(game);
        return json({ ok: true, gameId: game.gameId, name });
      }

      if (body.action === "submit") {
        const phase = phaseOf(game, now);

        if (phase.phase !== "bet" || phase.questionIndex !== body.questionIndex) {
          return json({ error: "Betting is closed" }, 409);
        }

        const playerId = String(body.playerId || "");
        if (!game.players[playerId]) {
          return json({ error: "You are not joined to this game. Please rejoin." }, 409);
        }

        const key = submissionKey(playerId, body.questionIndex);
        if (game.submissions[key]) {
          return json({ error: "Already submitted" }, 409);
        }

        const wallet = walletFor(game, playerId);
        const coins = Number(body.coins);

        if (!Number.isInteger(coins) || coins < 0 || coins > 3 || coins > wallet.coinsLeft) {
          return json({ error: "Invalid coin amount" }, 400);
        }

        if (!["Accurate", "Misleading", "False"].includes(body.guess)) {
          return json({ error: "Choose Accurate, Misleading or False" }, 400);
        }

        if (body.share && wallet.shareLeft < 1) {
          return json({ error: "Share already used" }, 400);
        }

        game.submissions[key] = {
          playerId,
          questionIndex: body.questionIndex,
          coins,
          guess: body.guess,
          share: !!body.share,
          submittedAt: now,
        };

        await this.writeGame(game);
        return json({ ok: true, gameId: game.gameId, questionIndex: body.questionIndex });
      }

      return json({ error: "Unknown action" }, 400);
    }

    const phase = phaseOf(game, now);
    const playerId = url.searchParams.get("playerId");

    const base = {
      ...phase,
      serverNow: now,
      gameId: game.gameId,
      playerCount: Object.keys(game.players || {}).length,
      submittedCount:
        phase.status === "running"
          ? Object.values(game.submissions || {}).filter(
              (s) => s.questionIndex === phase.questionIndex
            ).length
          : 0,
    };

    if (playerId) {
      base.registered = !!game.players?.[playerId];

      const scoredThrough =
        phase.status === "finished"
          ? Infinity
          : phase.status === "running" && phase.phase === "reveal"
          ? phase.questionIndex
          : phase.status === "running"
          ? phase.questionIndex - 1
          : -1;

      base.wallet = walletFor(game, playerId, scoredThrough);

      if (phase.status === "running") {
        const sub = game.submissions?.[submissionKey(playerId, phase.questionIndex)];

        if (sub) {
          const correct = sub.guess === QUESTIONS[phase.questionIndex]?.truth;
          base.playerSubmission = {
            submitted: true,
            coins: sub.coins,
            guess: sub.guess,
            share: sub.share,
            correct,
            rewardCoins: correct ? sub.coins * 2 : 0,
          };
        } else {
          base.playerSubmission = { submitted: false };
        }
      }
    }

    if (phase.status === "finished") {
      Object.assign(base, finalStats(game));
    }

    return json(base);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/game")) {
      const id = env.GAME.idFromName("classroom");
      const stub = env.GAME.get(id);
      return stub.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};
