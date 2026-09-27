import { QUESTIONS } from './shared.js';
const $=id=>document.getElementById(id);
async function api(method='GET',body=null){const opt={method,headers:{'content-type':'application/json'}};if(body)opt.body=JSON.stringify(body);const r=await fetch('/api/game',{...opt,cache:'no-store'});if(!r.ok)throw new Error(await r.text());return r.json()}
function render(s){$('players').textContent=s.playerCount??0;$('submitted').textContent=s.submittedCount??0;$('hostStatus').textContent=s.phaseLabel||'Waiting';$('startBtn').disabled=s.status==='running';
if(s.status==='waiting'){$('qnum').textContent='Lobby';$('headline').textContent='Ready when you are.';$('source').textContent='Players can join now';$('teaser').textContent='Press Start once. The rest runs automatically.';$('timer').innerHTML='—<small>seconds</small>';$('progressBar').style.width='0%';$('reveal').classList.add('hidden');$('finalPanel').classList.add('hidden');return}
if(s.status==='finished'){showFinal(s);return}
const q=QUESTIONS[s.questionIndex];$('qnum').textContent=`Post ${s.questionIndex+1} of ${QUESTIONS.length}`;$('headline').textContent=q.headline;$('source').textContent=q.source;$('teaser').textContent=q.teaser;const left=Math.max(0,Math.ceil((s.phaseEndsAt-s.serverNow)/1000));if(s.phase==='bet'){$('timer').innerHTML=`${left}<small>seconds left</small>`;$('progressBar').style.width=`${Math.max(0,Math.min(100,s.phaseProgress*100))}%`}else{$('timer').innerHTML=`RESULT<small>next post soon</small>`;$('progressBar').style.width='100%'};
if(s.phase==='reveal'){$('reveal').className=`reveal ${q.truth}`;$('truth').textContent=q.truth==='Accurate'?'✅ ACCURATE':q.truth==='Misleading'?'⚠️ MISLEADING':'❌ FALSE';$('explanation').textContent=q.explanation}else $('reveal').classList.add('hidden')}
function showFinal(s){$('qnum').textContent='Finished';$('headline').textContent='The auction is over!';$('source').textContent='Popular ≠ Reliable';$('teaser').textContent='Clicks, shares and attention can amplify misleading information.';$('timer').innerHTML='✓<small>complete</small>';$('progressBar').style.width='100%';$('reveal').classList.add('hidden');$('finalPanel').classList.remove('hidden');const top=(s.leaderboard||[]).slice(0,3);const medals=['🥇','🥈','🥉'];$('podium').innerHTML=top.map((p,i)=>`<div class="podium-card place-${i+1}"><div class="medal">${medals[i]}</div><div class="place-label">${i===0?'1st Place':i===1?'2nd Place':'3rd Place'}</div><div class="podium-name">${p.name}</div><div class="podium-score">${p.coins} 🪙</div></div>`).join('');$('mostEngaging').innerHTML=s.mostEngaging?`🔥 <b>Most engaging post:</b> ${QUESTIONS[s.mostEngaging.questionIndex].headline}<br>${s.mostEngaging.engagement} engagement points`:''}
$('startBtn').onclick=async()=>{try{await api('POST',{action:'start'});await tick()}catch(e){alert('Cannot start: '+e.message)}};
$('resetBtn').onclick=async()=>{if(confirm('Reset the whole lobby and clear all player submissions?')){try{await api('POST',{action:'reset'});await tick()}catch(e){alert('Cannot reset: '+e.message)}}};
async function tick(){try{render(await api())}catch(e){$('hostStatus').textContent='Reconnect…'}}let tickTimer=null;
async function scheduleTick(){
  clearTimeout(tickTimer);
  await tick();
  tickTimer=setTimeout(scheduleTick,700);
}
scheduleTick();
