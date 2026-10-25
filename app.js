'use strict';

// Bakar Studio at a glance on Meta Ray-Ban Display.
// The studio PC's relay sends a small summary (renders, AI at work, today's AI cost) through a private
// ntfy.sh topic; it is AES-GCM encrypted with the key in this page's URL fragment, which browsers
// never send to a server. Read-only: nothing here can change anything on the PC.
//
// The page says hello when it opens and every two minutes while it is on screen; the relay answers
// at once and then sends changes, and stops when the page says bye or goes quiet.

const SERVER = 'https://ntfy.sh';
const $ = (id) => document.getElementById(id);

let topic = null;
let key = null;
let data = null;
let heardAt = 0;
let askedAt = 0;
let stream = null;
let helloTimer = 0;
let tickTimer = 0;

// ---- pairing and crypto ------------------------------------------------------------------

function fromB64url(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toB64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function readPairing() {
  const p = new URLSearchParams(location.hash.slice(1));
  let t = p.get('t');
  let k = p.get('k');
  try {
    if (t && k) localStorage.setItem('sg.pair', JSON.stringify({ t, k }));
    else {
      const saved = JSON.parse(localStorage.getItem('sg.pair') || 'null');
      if (saved) ({ t, k } = saved);
    }
  } catch (e) { /* storage may be unavailable; the fragment still works */ }
  return t && k ? { t, k } : null;
}

async function openMessage(text) {
  const buf = fromB64url(text.trim());
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12) }, key, buf.slice(12));
  return JSON.parse(new TextDecoder().decode(plain));
}

async function seal(obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj))));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return toB64url(out);
}

async function send(c) {
  try {
    await fetch(`${SERVER}/${topic}-c`, { method: 'POST', body: await seal({ c, ts: Date.now() }) });
  } catch (e) { /* the state line says when the PC goes quiet */ }
}

// ---- link --------------------------------------------------------------------------------

async function handle(text) {
  let m;
  try { m = await openMessage(text); } catch (e) { return; }
  if (m.t !== 'studio') return;
  data = m;
  heardAt = Date.now();
  render();
}

function hello() {
  askedAt = Date.now();
  send('hello');
}

async function catchUp() {
  try {
    const r = await fetch(`${SERVER}/${topic}-s/json?poll=1&since=latest`);
    for (const line of (await r.text()).split('\n')) {
      if (!line.trim()) continue;
      const ev = JSON.parse(line);
      if (ev.event === 'message') await handle(ev.message);
    }
  } catch (e) { /* the live stream still connects */ }
}

function openStream() {
  if (stream) return;
  stream = new EventSource(`${SERVER}/${topic}-s/sse`);
  stream.addEventListener('message', (e) => {
    try {
      const ev = JSON.parse(e.data);
      if (ev.event === 'message' && ev.message) handle(ev.message);
    } catch (err) { /* keepalive */ }
  });
}

function closeStream() {
  if (stream) { stream.close(); stream = null; }
}

// On screen: live link, a hello every two minutes and a clock for the state line. Hidden: nothing.
function onVisibility() {
  clearInterval(helloTimer);
  clearInterval(tickTimer);
  if (document.visibilityState === 'visible') {
    catchUp().then(openStream);
    hello();
    helloTimer = setInterval(hello, 120000);
    tickTimer = setInterval(renderState, 5000);
  } else {
    send('bye');
    closeStream();
  }
}

// ---- drawing -----------------------------------------------------------------------------

function money(v) {
  return `CA$${Number(v || 0).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 50) return 'just now';
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

function renderState() {
  let text;
  let live = false;
  if (!data) text = askedAt && Date.now() - askedAt > 10000 ? 'Your PC is not answering' : 'Asking your PC…';
  else if (Date.now() - heardAt > 5 * 60 * 1000) text = `Last heard ${ago(heardAt)}`;
  else { text = data.pc === 'live' ? `Live · ${ago(data.at)}` : `PC ${data.pc}`; live = data.pc === 'live'; }
  $('stateText').textContent = text;
  $('dot').classList.toggle('live', live);
}

function render() {
  renderState();
  if (!data) return;
  const r = data.renders || {};
  const head = $('headline');
  head.textContent = data.head;
  head.className = 'headline ' + ({ 'Work moving': 'moving', 'Needs your eyes': 'attention', Quiet: 'quiet' }[data.head] || 'offline');

  const parts = [];
  if (r.ok === false) parts.push('Renders could not be checked');
  else {
    parts.push(`${r.running || 0} rendering`);
    if (r.queued) parts.push(`${r.queued} waiting`);
    if (r.attention) parts.push(`${r.attention} need${r.attention === 1 ? 's' : ''} a look`);
  }
  $('subline').textContent = parts.join(' · ');

  const list = $('renderList');
  list.textContent = '';
  const items = r.items || [];
  if (!items.length) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="mark idle"></span><span class="ti"></span><span class="st"></span>';
    li.querySelector('.ti').textContent = r.ok === false ? 'Queue unreadable right now' : 'Nothing rendering';
    list.appendChild(li);
  }
  for (const it of items) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="mark"></span><span class="ti"></span><span class="st"></span>';
    li.querySelector('.mark').classList.toggle('attention', it.st === 'attention');
    li.querySelector('.ti').textContent = it.ti;
    li.querySelector('.st').textContent = it.st === 'attention' ? 'needs a look' : (it.pct != null ? `${it.pct}%` : 'running');
    if (it.why) {
      const why = document.createElement('span');
      why.className = 'why';
      why.textContent = it.why;
      li.appendChild(why);
    }
    list.appendChild(li);
  }

  const ai = data.ai || {};
  const names = Object.keys(ai).sort((a, b) => (a === 'Codex' ? -1 : b === 'Codex' ? 1 : a.localeCompare(b)));
  $('aiText').textContent = names.length ? names.map((n) => `${n} ${ai[n]}`).join(' · ') : (data.aiNote ? 'Not tracked' : 'None running');
  $('aiNote').textContent = data.aiNote ? 'Speed Light is paused' : '';

  const c = data.cost || {};
  $('costText').textContent = c.ok ? money(c.todayCad) : 'Unavailable';
  $('costNote').textContent = c.ok ? `At API prices · month ${money(c.monthCad).replace('.00', '')}` : '';
}

// ---- start -------------------------------------------------------------------------------

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try { navigator.serviceWorker.register('sw.js').catch(() => {}); } catch (e) { /* optional */ }
}

async function main() {
  const pair = readPairing();
  if (!pair || !window.crypto || !crypto.subtle) {
    $('glance').hidden = true;
    $('setup').hidden = false;
    return;
  }
  topic = pair.t;
  key = await crypto.subtle.importKey('raw', fromB64url(pair.k), 'AES-GCM', false, ['encrypt', 'decrypt']);
  $('headCard').focus();
  render();
  registerServiceWorker();
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', () => send('bye'));
  if (document.visibilityState === 'visible') onVisibility();
}

main();
