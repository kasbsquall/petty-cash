import '@phosphor-icons/web/light';
import './style.css';
import { DAO, EXPLORER, loadDemo, post } from './near.js';

const TUSD = 1_000_000;
const HOLDERS = {
  'harbor-ana.testnet': { name: 'Ana', icon: 'ph-users-three' },
  'harbor-rui.testnet': { name: 'Rui', icon: 'ph-pen-nib' },
  'harbor-bot.testnet': { name: 'AI agent', icon: 'ph-robot', note: 'Its key can only call Petty Cash.' },
};
// Transactions sent while seeding the demo (app/scripts/seed-testnet.sh). The contract
// cannot know its own transaction hash, so later ones come from this browser's requests.
const SEEDED_TX = {
  0: '6rC9hAG5tzFekq5VU7pKYdPEMLmDKzEFibzhEZEMjZfc',
  1: 'FLXL5DerMG8nMDZwBDNmycKXtEw1HLKn6A8zGWGfmexy',
  2: 'ATaSFikCXJ9vYw68J4vpyXguvQxx183DYHRp1Jd2c1TT',
  3: '3PLnMKgW4XEHCqUt4xu6Z5PLyaWvuxWYzpFSbYwdNjBX',
  4: 'JCdeq7YYXno4SXEpk6uaq4RNf6SXoEXYaNLG6cW3rD3r',
  5: '42enYW742C9XjfcxKtpg6wdLVP3VdfvNwPKia2SojXf6',
  6: 'DaxhSKcauuDvo2MW16B4KPWx9bwxumi2eV5M12FiUQff',
  7: 'JAm547byodX61YbeMwBTScq52nCTfWHY2X6DJrsf1fJ1',
};
const MAX_CHANNEL = 5;
const CAT_ICON = {
  food: 'ph-fork-knife', venue: 'ph-door-open', printing: 'ph-printer',
  tools: 'ph-wrench', freelance: 'ph-paint-brush', compute: 'ph-cpu',
};

const $ = (id) => document.getElementById(id);
const app = $('app');
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const dollars = (units) => Number(units) / TUSD;
const usd = (n) => '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 });
const day = (ns) => new Date(Number(ns) / 1e6).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

let data = null;
let pos = 0;
let busy = false;

/* ---------- local memory: transaction hashes and sound preference ---------- */
function store(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function keep(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: fine */ }
}
const myTx = store('pc-tx', {});
const txOf = (spendId) => SEEDED_TX[spendId] || myTx[spendId];

/* ---------- sound ---------- */
let soundOn = store('pc-sound', true);
const sounds = { paid: new Audio('/sounds/paid.ogg'), council: new Audio('/sounds/council.ogg') };
Object.values(sounds).forEach((a) => { a.volume = 0.35; a.preload = 'auto'; });
function play(name) {
  if (!soundOn) return;
  const a = sounds[name];
  a.currentTime = 0;
  a.play().catch(() => {});
}
function paintSound() {
  $('sonido').setAttribute('aria-pressed', soundOn);
  $('sonido').innerHTML = soundOn
    ? '<i class="ph-light ph-speaker-simple-high"></i><span>Sound on</span>'
    : '<i class="ph-light ph-speaker-simple-slash"></i><span>Sound off</span>';
}
$('sonido').addEventListener('click', () => { soundOn = !soundOn; keep('pc-sound', soundOn); paintSound(); });
paintSound();

/* ---------- derived numbers ---------- */
function periodOf(b) {
  const len = b.rules.period_secs * 1e9;
  const index = Math.max(0, Math.floor((Date.now() * 1e6 - b.started_at) / len));
  const start = b.started_at + index * len;
  const rolled = index !== b.period_index;
  return {
    index,
    start,
    end: start + len,
    spent: rolled ? 0 : dollars(b.spent),
    reserved: rolled ? 0 : dollars(b.reserved),
    cap: dollars(b.rules.period_cap),
    per: dollars(b.rules.per_payment_cap),
  };
}
const holderOf = (b) => HOLDERS[b.rules.holders[0]] || { name: b.rules.holders[0], icon: 'ph-wallet' };
const listText = (xs) => (xs.length > 1 ? xs.slice(0, -1).join(', ') + ' or ' + xs.at(-1) : xs[0]);
const until = (b) => (b.rules.expires_at ? new Date(b.rules.expires_at * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : null);

function councilState(spend) {
  const p = data.proposals[spend.proposal_id];
  if (!p) return { status: 'InProgress', approvals: 0, rejections: 0 };
  const votes = Object.values(p.votes || {});
  return {
    status: p.status,
    approvals: votes.filter((v) => v === 'Approve').length,
    rejections: votes.filter((v) => v === 'Reject').length,
  };
}
const needed = () => Math.floor(data.council.length / 2) + 1;
const paidByRules = (s) => s.status === 'Paid' && !s.reason;
const outcome = (s) => {
  if (paidByRules(s)) return 'rules';
  if (s.status === 'Paid') return 'council-yes';
  if (s.status === 'Rejected') return 'council-no';
  const st = councilState(s).status;
  return st === 'Approved' ? 'council-yes' : st === 'Rejected' ? 'council-no' : 'waiting';
};
const openVotes = () => data.spends.filter((s) => s.status === 'Escalated' && councilState(s).status === 'InProgress');

/* ---------- count-up for the big figure ---------- */
function countTo(el, to) {
  const from = Number(el.dataset.v || to);
  el.dataset.v = to;
  if (reduced || from === to) { el.textContent = usd(to); return; }
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / 420);
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = usd(Math.round(from + (to - from) * e));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* ---------- gates on the model ---------- */
function paintGates() {
  data.budgets.slice(0, 3).forEach((b, i) => {
    const h = holderOf(b);
    const label = document.querySelector(`#pin-${i} .etiqueta`);
    const p = periodOf(b);
    label.querySelector('.nombre').innerHTML = `<i class="ph-light ${h.icon}"></i>${esc(b.rules.name)}`;
    label.querySelector('.det').textContent = `${usd(Math.max(0, p.cap - p.spent))} left of ${usd(p.cap)}`;
    label.setAttribute('aria-label', `${b.rules.name} budget, held by ${h.name}`);
  });
  $('embalse-saldo').innerHTML = `<b class="num">${usd(dollars(data.balance))}</b> in the DAO`;
  $('dao-link').href = `${EXPLORER}/address/${DAO}`;
  $('f-budget').innerHTML = data.budgets.map((b, i) => `<option value="${i}">${esc(b.rules.name)}</option>`).join('');
  $('f-budget').disabled = false;
}

function select(i) {
  pos = i;
  const b = data.budgets[i];
  const h = holderOf(b);
  const p = periodOf(b);
  document.querySelectorAll('.pin[id^="pin-"]:not(#pin-council)').forEach((el, k) => el.setAttribute('aria-pressed', k === i));
  $('lectura-nombre').textContent = b.rules.name;
  $('lectura-icono').className = 'ph-light ' + h.icon;
  $('lectura-titular').textContent = b.rules.holders[0];
  countTo($('lectura-cifra'), Math.max(0, p.cap - p.spent));
  $('lectura-sub').textContent = `left of ${usd(p.cap)} this period`;
  $('gastado').textContent = `${usd(p.spent)} spent`;
  $('periodo').textContent = `${day(p.start)} to ${day(p.end)}`;
  $('medidor').setAttribute('aria-label', `${usd(p.spent)} spent of ${usd(p.cap)}`);
  $('medidor').firstElementChild.style.setProperty('--p', Math.min(1, p.spent / p.cap).toFixed(3));
  const end = until(b);
  $('lectura-reglas').innerHTML = `<b>Rules:</b> up to ${usd(p.per)} a payment, ${usd(p.cap)} every ${Math.round(b.rules.period_secs / 86400)} days, for ${esc(listText(b.rules.categories))}.`
    + (end ? ` Open until ${end}.` : '') + (h.note ? ` ${h.note}` : '') + (b.paused ? ' <b>Paused by the DAO.</b>' : '');
  $('demo-quien').querySelector('span').textContent = `You act as ${h.name}, the ${b.rules.name} holder`;
  $('f-budget').value = String(i);
  $('f-monto').placeholder = `up to ${p.per}`;
  const cat = $('f-cat').value;
  $('f-cat').innerHTML = b.rules.categories.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  if (b.rules.categories.includes(cat)) $('f-cat').value = cat;
  $('f-cat').disabled = false;
  paintChannel();
  leader();
  check();
}
document.querySelectorAll('[data-pos]').forEach((el) => el.addEventListener('click', () => data && select(Number(el.dataset.pos))));
$('f-budget').addEventListener('change', (e) => select(Number(e.target.value)));

/* leader line from the readout up to its gate */
function leader() {
  const h = $('hilo');
  const l = $('lectura');
  const pin = $(`pin-${pos}`);
  if (!pin || getComputedStyle(l).position !== 'absolute') { h.style.height = '0'; return; }
  const lr = l.getBoundingClientRect();
  const pr = pin.getBoundingClientRect();
  const dx = pr.left - lr.right;
  const dy = lr.top - pr.top;
  h.style.height = Math.hypot(dx, dy) + 'px';
  h.style.transform = `rotate(${Math.atan2(-dx, -dy) * 180 / Math.PI}deg)`;
}
addEventListener('resize', leader);

/* ---------- rule check, the same rules the contract applies ---------- */
const amount = () => {
  const text = ($('f-monto').value || '').replace(/[,$\s]/g, '');
  return /^\d{1,4}(\.\d{1,2})?$/.test(text) ? Number(text) : NaN;
};
function check() {
  if (!data || busy) return;
  const b = data.budgets[pos];
  const p = periodOf(b);
  const v = amount();
  const ver = $('veredicto');
  const btn = $('enviar');
  if (!(v > 0)) {
    ver.dataset.v = 'vacio';
    ver.innerHTML = '<i class="ph-light ph-scales"></i><span>' + ($('f-monto').value ? 'Type the amount as a number up to 1,000, like 180.' : 'Type an amount to check it against the rules.') + '</span>';
    $('checks').innerHTML = '';
    btn.dataset.v = 'vacio';
    btn.disabled = true;
    $('enviar-txt').textContent = 'Request payment';
    return;
  }
  const left = p.cap - p.spent - p.reserved;
  const end = b.rules.expires_at ? b.rules.expires_at * 1000 : null;
  const c = [
    [v <= p.per ? 'si' : 'no', v <= p.per ? `Within the ${usd(p.per)} per-payment cap` : `Above the ${usd(p.per)} per-payment cap`],
    [v <= left ? 'si' : 'no', v <= left ? `Fits in the ${usd(left)} left this period` : `More than the ${usd(Math.max(0, left))} left this period`],
    ['si', `Category ${$('f-cat').value} is allowed`],
  ];
  if (end) c.push([Date.now() < end ? 'si' : 'no', Date.now() < end ? `Budget open until ${until(b)}` : `Budget closed on ${until(b)}`]);
  if (b.paused) c.push(['no', 'The DAO paused this budget']);
  const inside = c.every(([e]) => e !== 'no');
  $('checks').innerHTML = c.map(([e, t]) => `<li data-e="${e}" class="num"><i class="ph-light ${e === 'si' ? 'ph-check-circle' : 'ph-x-circle'}"></i><span>${t}</span></li>`).join('');
  ver.dataset.v = inside ? 'dentro' : 'fuera';
  ver.innerHTML = inside
    ? '<i class="ph-light ph-check-circle"></i><span>Inside the rules. Paid from the DAO in seconds.</span>'
    : `<i class="ph-light ph-lock-key"></i><span>Outside the rules. It goes to a council vote, ${needed()} of ${data.council.length} needed.</span>`;
  btn.dataset.v = ver.dataset.v;
  btn.disabled = false;
  $('enviar-txt').textContent = inside ? `Pay ${usd(v)} now` : `Send ${usd(v)} to a council vote`;
}
['f-monto', 'f-cat'].forEach((id) => $(id).addEventListener('input', check));

/* ---------- submit: a real spend on testnet ---------- */
$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (busy || !data) return;
  const memo = $('f-para').value.trim();
  const v = amount();
  $('e-para').hidden = memo.length > 0;
  $('f-para').setAttribute('aria-invalid', memo.length === 0);
  if (!memo || !(v > 0)) { if (!memo) $('f-para').focus(); return; }
  const inside = $('enviar').dataset.v === 'dentro';
  const b = data.budgets[pos];
  const btn = $('enviar');
  busy = true;
  btn.disabled = true;
  $('resultado').innerHTML = '';
  btn.innerHTML = `<span class="giro"></span><span id="enviar-txt">${inside ? 'Paying from the DAO' : 'Filing it for the council'}</span>`;
  if (inside && pos === 0) app.dataset.compuerta = 'abierta';
  try {
    const r = await post('/api/spend', {
      budgetId: b.id, amount: $('f-monto').value.replace(/[,$\s]/g, ''), category: $('f-cat').value, memo, receiver: $('f-recibe').value,
    });
    if (r.spend) { myTx[r.spend.id] = r.txHash; keep('pc-tx', myTx); }
    const s = r.spend;
    const link = `<a href="${EXPLORER}/txns/${r.txHash}" target="_blank" rel="noopener">See the transaction<i class="ph-light ph-arrow-square-out"></i></a>`;
    if (s?.status === 'Paid') {
      play('paid');
      $('resultado').innerHTML = `<div class="aviso ok"><i class="ph-light ph-check-circle"></i><span class="num">Paid ${usd(v)} to ${esc(s.receiver_id)} from the DAO, proposal #${s.proposal_id}. ${link}</span></div>`;
    } else if (s?.status === 'Escalated') {
      play('council');
      $('resultado').innerHTML = `<div class="aviso voto"><i class="ph-light ph-lock-key"></i><span class="num">${esc(s.reason || 'Outside the rules')}. ${usd(v)} stays in the DAO until ${needed()} of ${data.council.length} approve, proposal #${s.proposal_id}. ${link}</span></div>`;
    } else {
      $('resultado').innerHTML = `<div class="aviso voto"><i class="ph-light ph-warning"></i><span>${esc(s?.reason || 'The payment did not go through.')} ${link}</span></div>`;
    }
    $('f-monto').value = '';
    $('f-para').value = '';
    await refresh();
  } catch (err) {
    $('resultado').innerHTML = `<div class="aviso voto"><i class="ph-light ph-warning"></i><span>${esc(err.message)}</span></div>`;
  } finally {
    busy = false;
    btn.innerHTML = '<span id="enviar-txt">Request payment</span>';
    setTimeout(() => { app.dataset.compuerta = 'cerrada'; }, 2400);
    check();
  }
});

/* ---------- council ---------- */
function paintCouncil() {
  const open = openVotes();
  const n = open.length;
  $('badge').textContent = n;
  $('badge').hidden = n === 0;
  $('espera-txt').textContent = n === 0 ? 'nothing waiting' : n + (n === 1 ? ' payment waiting' : ' payments waiting');
  $('votos').innerHTML = n === 0
    ? '<div class="vacio">Nothing is waiting for a vote. Payments inside the rules never come here.</div>'
    : open.map((s) => {
      const b = data.budgets.find((x) => x.id === s.budget_id);
      const cs = councilState(s);
      const keys = Array.from({ length: needed() }, (_, k) => `<span class="llave ${k < cs.approvals ? 'puesta' : ''}"><i class="ph-light ph-key"></i></span>`).join('');
      return `<article class="voto" data-p="${s.proposal_id}" data-s="${s.id}">
        <div class="linea1 num"><span>${esc(b?.rules.name ?? '')}, ${esc(s.category)}, ${day(s.at)}</span><span>proposal #${s.proposal_id}</span></div>
        <span class="monto-v num">${usd(dollars(s.amount))}</span>
        <p>${esc(s.memo)}</p>
        <p class="motivo num">${esc(s.reason || 'Outside the rules')}. To ${esc(s.receiver_id)}.</p>
        <div class="llaves num" aria-label="${cs.approvals} of ${needed()} votes">${keys}<span>${cs.approvals} of ${needed()} votes${cs.rejections ? `, ${cs.rejections} against` : ''}</span></div>
        <div class="acciones"><button class="btn" data-v="fuera" type="button" data-voto="si">Approve</button><button class="btn no" type="button" data-voto="no">Reject</button></div>
      </article>`;
    }).join('');
  const thisPeriod = data.spends.filter((s) => {
    const b = data.budgets.find((x) => x.id === s.budget_id);
    return b && s.period_index === periodOf(b).index;
  });
  const paid = thisPeriod.filter(paidByRules).length;
  const voted = thisPeriod.filter((s) => s.status !== 'Failed' && !paidByRules(s)).length;
  $('consejo-resumen').textContent = `This period the council was asked to vote on ${voted} of ${voted + paid} payments. The other ${paid} were paid inside the rules, with no vote.`;
}

$('votos').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-voto]');
  if (!btn || busy) return;
  const card = btn.closest('.voto');
  const approve = btn.dataset.voto === 'si';
  busy = true;
  card.querySelectorAll('.acciones .btn').forEach((b) => { b.disabled = true; });
  btn.innerHTML = '<span class="giro"></span>Voting';
  try {
    const r = await post('/api/vote', { proposalId: Number(card.dataset.p), spendId: Number(card.dataset.s), approve });
    const status = r.proposal.status;
    const yes = Object.values(r.proposal.votes || {}).filter((v) => v === 'Approve').length;
    card.querySelectorAll('.llave').forEach((k, j) => k.classList.toggle('puesta', j < yes));
    card.querySelector('.llaves span:last-child').textContent = `${yes} of ${needed()} votes`;
    if (status !== 'InProgress') {
      const n = Math.max(0, Number($('badge').textContent) - 1);
      $('badge').textContent = n;
      $('badge').hidden = n === 0;
    }
    if (status === 'Approved') play('paid');
    const msg = status === 'Approved' ? 'Approved. The payment went out from the DAO.'
      : status === 'Rejected' ? 'Rejected. The money stays in the DAO.'
        : 'Your vote is in. It needs one more.';
    card.querySelector('.acciones').innerHTML = `<div class="aviso ${status === 'Approved' ? 'ok' : 'voto'}" style="grid-column:1/-1"><i class="ph-light ph-check"></i><span>${msg} Signed as ${esc(r.voter)}. <a href="${EXPLORER}/txns/${r.txHash}" target="_blank" rel="noopener">See the transaction<i class="ph-light ph-arrow-square-out"></i></a></span></div>`;
    busy = false;
    setTimeout(refresh, 2600);
  } catch (err) {
    busy = false;
    card.querySelector('.acciones').insertAdjacentHTML('afterend', `<div class="aviso voto"><i class="ph-light ph-warning"></i><span>${esc(err.message)}</span></div>`);
    card.querySelectorAll('.acciones .btn').forEach((b) => { b.disabled = false; });
    btn.textContent = approve ? 'Approve' : 'Reject';
  }
});

/* ---------- tabs ---------- */
function tab(which) {
  const ask = which === 'pedir';
  $('t-pedir').setAttribute('aria-selected', ask);
  $('t-consejo').setAttribute('aria-selected', !ask);
  $('t-pedir').tabIndex = ask ? 0 : -1;
  $('t-consejo').tabIndex = ask ? -1 : 0;
  $('c-pedir').hidden = !ask;
  $('c-consejo').hidden = ask;
  $('pin-council').setAttribute('aria-pressed', !ask);
}
$('t-pedir').addEventListener('click', () => tab('pedir'));
$('t-consejo').addEventListener('click', () => tab('consejo'));
$('ir-consejo').addEventListener('click', () => {
  tab('consejo');
  if (matchMedia('(max-width:1100px)').matches) document.querySelector('.panel').scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
});
document.querySelector('.tabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const ask = $('t-pedir').getAttribute('aria-selected') === 'true';
  tab(ask ? 'consejo' : 'pedir');
  (ask ? $('t-consejo') : $('t-pedir')).focus();
});

/* ---------- the channel: this period's payments of the selected budget ---------- */
function paintChannel() {
  const b = data.budgets[pos];
  const p = periodOf(b);
  const all = data.spends.filter((s) => s.budget_id === b.id && s.period_index === p.index && s.status !== 'Failed');
  const shown = all.slice(-MAX_CHANNEL);
  const ol = $('gotas');
  $('canal-t').textContent = `${b.rules.name} payments this period`;
  const noVote = all.filter(paidByRules).length;
  const toCouncil = all.length - noVote;
  $('canal-gasto').innerHTML = `<span class="sello"><i class="ph-light ph-check-circle"></i>${noVote} paid with no council vote</span><span class="sello espera"><i class="ph-light ph-lock-key"></i>${toCouncil} sent to the council</span>` + (all.length > shown.length ? `<span>Showing the last ${shown.length} of ${all.length}</span>` : '');
  if (shown.length === 0) {
    ol.style.setProperty('--n', 1);
    ol.classList.add('sin-gotas');
    ol.innerHTML = '<li class="gota-vacia">No payments yet this period. Request one and it shows up here with its transaction.</li>';
    return;
  }
  ol.classList.remove('sin-gotas');
  ol.style.setProperty('--n', shown.length);
  ol.innerHTML = shown.map((s, k) => {
    const tx = txOf(s.id);
    const txLink = tx
      ? `<a href="${EXPLORER}/txns/${tx}" target="_blank" rel="noopener" aria-label="Transaction for payment ${s.id}, DAO proposal ${s.proposal_id}">Proposal ${s.proposal_id}<i class="ph-light ph-arrow-square-out"></i></a>`
      : `<a href="${EXPLORER}/address/${s.receiver_id}" target="_blank" rel="noopener" aria-label="Receiver account ${esc(s.receiver_id)}, DAO proposal ${s.proposal_id}">Proposal ${s.proposal_id}<i class="ph-light ph-arrow-square-out"></i></a>`;
    const o = outcome(s);
    const waiting = o === 'waiting';
    const state = {
      rules: '<i class="ph-light ph-check-circle"></i>Paid inside the rules',
      'council-yes': '<i class="ph-light ph-check-circle"></i>Paid after council vote',
      'council-no': '<i class="ph-light ph-x-circle"></i>Council said no',
      waiting: `<i class="ph-light ph-hourglass-medium"></i>Council vote, ${councilState(s).approvals} of ${needed()}`,
    }[o];
    return `<li class="gota ${waiting ? 'espera' : ''}" style="--k:${Math.min(k, 7)}"><span class="tramo" aria-hidden="true"></span>
      <span class="f num"><span>${day(s.at)}</span><span class="cat"><i class="ph-light ${CAT_ICON[s.category] || 'ph-tag'}"></i>${esc(s.category)}</span></span>
      <span class="v num">${usd(dollars(s.amount))}</span>
      <span class="q" title="${esc(s.memo)}">${esc(s.memo)}</span>
      <span class="e num">${state}${txLink}</span>
    </li>`;
  }).join('');
}

/* ---------- monthly report as CSV ---------- */
$('informe').addEventListener('click', () => {
  if (!data) return;
  const rows = [['date', 'budget', 'category', 'what it is for', 'receiver', 'amount_tusd', 'status', 'dao_proposal', 'transaction']];
  data.spends.forEach((s) => {
    const b = data.budgets.find((x) => x.id === s.budget_id);
    const status = s.status === 'Failed' ? 'failed' : {
      rules: 'paid inside the rules', 'council-yes': 'paid after council vote', 'council-no': 'rejected by council', waiting: 'waiting for council',
    }[outcome(s)];
    rows.push([new Date(s.at / 1e6).toISOString().slice(0, 10), b?.rules.name ?? s.budget_id, s.category, s.memo, s.receiver_id, dollars(s.amount), status, s.proposal_id ?? '', txOf(s.id) || '']);
  });
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `harbor-builders-petty-cash-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

/* ---------- load ---------- */
async function refresh() {
  data = await loadDemo();
  paintGates();
  paintCouncil();
  select(Math.min(pos, data.budgets.length - 1));
}

async function start() {
  app.dataset.estado = 'cargando';
  $('fallo').hidden = true;
  try {
    await refresh();
    app.dataset.estado = 'listo';
    $('informe').disabled = false;
  } catch {
    app.dataset.estado = 'fallo';
    $('fallo').innerHTML = '<p><i class="ph-light ph-cloud-slash"></i><span>NEAR testnet did not answer, so there is nothing to show yet.</span></p><button class="btn-sec" type="button" id="reintentar"><i class="ph-light ph-arrow-clockwise"></i>Try again</button>';
    $('reintentar').addEventListener('click', start);
    $('fallo').hidden = false;
  }
}
$('ir-pedir').addEventListener('click', () => {
  tab('pedir');
  document.querySelector('.panel').scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
  setTimeout(() => $('f-monto').focus({ preventScroll: true }), reduced ? 0 : 400);
});
if ('IntersectionObserver' in window) {
  new IntersectionObserver(([e]) => { $('ir-pedir').dataset.oculto = e.isIntersecting ? 'si' : 'no'; }, { threshold: 0.15 })
    .observe(document.querySelector('.panel'));
}
start();
addEventListener('load', () => { leader(); setTimeout(leader, 700); });
