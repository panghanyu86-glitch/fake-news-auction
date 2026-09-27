import { QUESTIONS, TOTAL_COINS } from './shared.js';

const $ = id => document.getElementById(id);

let playerId = localStorage.getItem('fna_player_id') || crypto.randomUUID();
localStorage.setItem('fna_player_id', playerId);

let joined = localStorage.getItem('fna_joined') === '1';
let savedName = localStorage.getItem('fna_name') || '';
let currentGameId = localStorage.getItem('fna_game_id') || '';
let selectedCoins = null;
let selectedTruth = null;
let lastQ = -1;
let joining = false;
let submitting = false;

async function api(method='GET', body=null) {
  const opt = { method, headers: {'content-type':'application/json'} };
  if (body) opt.body = JSON.stringify(body);
  const suffix = method === 'GET' ? ('?playerId=' + encodeURIComponent(playerId)) : '';
  const r = await fetch('/api/game' + suffix, { ...opt, cache:'no-store' });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function joinCurrentGame(name, silent=false) {
  if (!name || joining) return;
  joining = true;
  const btn = $('joinBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = silent ? 'Rejoining…' : 'Joining…';
  }

  try {
    const r = await api('POST', { action:'join', playerId, name });
    joined = true;
    savedName = name;
    currentGameId = r.gameId || '';
    localStorage.setItem('fna_joined','1');
    localStorage.setItem('fna_name',name);
    localStorage.setItem('fna_game_id',currentGameId);
    $('joinPanel').classList.add('hidden');
    $('gamePanel').classList.remove('hidden');
  } finally {
    joining = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Join';
    }
  }
}

function makeChoices() {
  const co = $('coinOptions');
  co.innerHTML = '';
  [0,1,2,3].forEach(n => {
    const b = document.createElement('button');
    b.className = 'coin';
    b.textContent = n === 0 ? '0 🪙' : n + ' 🪙';
    b.onclick = () => {
      selectedCoins = n;
      [...co.children].forEach(x => x.classList.remove('active'));
      b.classList.add('active');
    };
    co.appendChild(b);
  });

  const to = $('truthOptions');
  to.innerHTML = '';
  [['Accurate','✅ Accurate'],['Misleading','⚠️ Misleading'],['False','❌ False']].forEach(([v,t]) => {
    const b = document.createElement('button');
    b.className = 'truth-btn';
    b.textContent = t;
    b.onclick = () => {
      selectedTruth = v;
      [...to.children].forEach(x => x.classList.remove('active'));
      b.classList.add('active');
    };
    to.appendChild(b);
  });
}
makeChoices();

$('joinBtn').onclick = async () => {
  const name = $('nameInput').value.trim();
  if (!name) return;
  try {
    await joinCurrentGame(name);
    await tick();
  } catch (e) {
    alert('Cannot join: ' + e.message);
  }
};

if (savedName) $('nameInput').value = savedName;
if (joined) {
  $('joinPanel').classList.add('hidden');
  $('gamePanel').classList.remove('hidden');
}

$('submitBtn').onclick = async () => {
  if (submitting) return;
  if (selectedCoins === null || !selectedTruth) {
    alert('Choose coins and a truth guess first.');
    return;
  }

  submitting = true;
  const btn = $('submitBtn');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Submitted ✓';

  $('betArea').classList.add('hidden');
  $('submittedBox').classList.remove('hidden');
  $('submittedBox').textContent = '✓ Submitted — waiting for the result';

  try {
    await api('POST', {
      action:'submit',
      playerId,
      questionIndex:lastQ,
      coins:selectedCoins,
      guess:selectedTruth
    });
    await tick();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = originalText;
    $('betArea').classList.remove('hidden');
    $('submittedBox').classList.add('hidden');

    const msg = String(e.message || e);
    if (msg.includes('not joined')) {
      try {
        await joinCurrentGame(savedName, true);
        alert('You were reconnected. Please submit once more.');
      } catch {
        alert('Connection problem. Please refresh and rejoin.');
      }
    } else {
      alert(msg);
    }
  } finally {
    submitting = false;
  }
};

function resetSelection() {
  selectedCoins = null;
  selectedTruth = null;
  [...document.querySelectorAll('.coin,.truth-btn')].forEach(x => x.classList.remove('active'));
  $('submitBtn').disabled = false;
  $('submitBtn').textContent = 'Submit';
}

function renderRoundResult(s) {
  const sub = s.playerSubmission;
  if (!sub?.submitted) {
    $('roundResult').innerHTML = '<b>No bet submitted this round.</b><br>Round score: 0 pts';
    return;
  }

  $('roundResult').innerHTML =
    '<div class="round-big">' + (sub.correct ? 'Correct! 🎉' : 'Not quite this time.') + '</div>' +
    '<div>You bet <b>' + sub.coins + ' 🪙</b> and chose <b>' + sub.guess + '</b>.</div>' +
    '<div class="round-score">' + (sub.correct ? ('You won ' + sub.rewardCoins + ' 🪙') : ('You lost ' + sub.coins + ' 🪙')) + '</div>' +
    '<div class="round-formula">' + (sub.correct ? (sub.coins + ' coins × 2 = ' + sub.rewardCoins + ' coins') : ('Lost stake: ' + sub.coins + ' coins')) + '</div>' +
    '<div class="round-total">Current balance: <b>' + (s.wallet?.coinsLeft ?? 0) + ' 🪙</b></div>';
}

async function ensureRegistered(s) {
  if (!joined || !savedName) return;
  const gameChanged = currentGameId && s.gameId && currentGameId !== s.gameId;

  if (s.registered === false || gameChanged || !currentGameId) {
    try {
      await joinCurrentGame(savedName, true);
    } catch {
      $('phasePill').textContent = 'Reconnect…';
    }
  }
}

function render(s) {
  if (!joined) return;

  $('phasePill').textContent = s.phaseLabel || 'Waiting';
  $('coinsLeft').textContent = s.wallet?.coinsLeft ?? TOTAL_COINS;

  if (s.status === 'waiting') {
    $('pqnum').textContent = 'Lobby';
    $('pheadline').textContent = 'Waiting for host…';
    $('psource').textContent = 'You are in';
    $('pteaser').textContent = 'The game will begin automatically.';
    $('ptimer').innerHTML = '—<small>waiting</small>';
    $('pprogress').style.width = '0%';
    $('betArea').classList.add('hidden');
    $('submittedBox').classList.add('hidden');
    $('preveal').classList.add('hidden');
    return;
  }

  if (s.status === 'finished') {
    $('gamePanel').classList.add('hidden');
    $('playerFinal').classList.remove('hidden');
    $('personalResult').innerHTML =
      'Your final balance: <b>' + (s.wallet?.coinsLeft ?? 0) + ' 🪙</b>';
    return;
  }

  const q = QUESTIONS[s.questionIndex];
  if (lastQ !== s.questionIndex) {
    lastQ = s.questionIndex;
    resetSelection();
  }

  $('pqnum').textContent = 'Post ' + (s.questionIndex + 1) + ' of ' + QUESTIONS.length;
  $('pheadline').textContent = q.headline;
  $('psource').textContent = q.source;
  $('pteaser').textContent = q.teaser;

  const left = Math.max(0, Math.ceil((s.phaseEndsAt - s.serverNow) / 1000));
  if (s.phase === 'bet') {
    $('ptimer').innerHTML = left + '<small>seconds left</small>';
    $('pprogress').style.width = Math.max(0, Math.min(100, s.phaseProgress * 100)) + '%';
  } else {
    $('ptimer').innerHTML = 'RESULT<small>next post soon</small>';
    $('pprogress').style.width = '100%';
  }

  const submitted = s.playerSubmission?.submitted;

  if (s.phase === 'bet' && !submitted && !submitting) {
    $('betArea').classList.remove('hidden');
    $('submittedBox').classList.add('hidden');
    $('preveal').classList.add('hidden');

    [...$('coinOptions').children].forEach((b,i) => {
      b.disabled = i > (s.wallet?.coinsLeft ?? 0);
    });
  } else {
    $('betArea').classList.add('hidden');
    $('submittedBox').classList.toggle('hidden', !(submitted && s.phase !== 'reveal'));
  }

  if (s.phase === 'reveal') {
    $('submittedBox').classList.add('hidden');
    $('preveal').className = 'reveal ' + q.truth;
    $('ptruth').textContent = q.truth === 'Accurate' ? '✅ ACCURATE' : q.truth === 'Misleading' ? '⚠️ MISLEADING' : '❌ FALSE';
    $('pexplanation').textContent = q.explanation;
    renderRoundResult(s);
  } else {
    $('preveal').classList.add('hidden');
  }
}

let tickTimer = null;
async function tick() {
  clearTimeout(tickTimer);
  try {
    const s = await api();
    await ensureRegistered(s);
    render(s);
  } catch {
    $('phasePill').textContent = 'Reconnect…';
  } finally {
    tickTimer = setTimeout(tick, 700);
  }
}
tick();
