'use strict';

// Bakar Studio at a glance on Meta Ray-Ban Display.
// The studio PC's relay sends a small summary (renders, AI at work, today's AI cost) through two free
// public MQTT brokers on a private random topic (no daily cap; either broker can be down). It is
// AES-GCM encrypted with the key in this page's URL fragment, which browsers never send to a server.
// Read-only: nothing here can change anything on the PC.
//
// The latest summary is retained on the brokers, so it shows the moment the page connects. The page
// says hello when it opens and every two minutes while it is on screen; the relay then sends changes,
// and stops when the page says bye or goes quiet.

const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'];
// shiftr.io's public instance on port 443, for networks that let only web traffic through; joined only
// when neither broker above connects within 5 s.
const SPARE = { url: 'wss://public.cloud.shiftr.io', username: 'public', password: 'public' };
let spareTimer = 0;
const $ = (id) => document.getElementById(id);

let topic = null;
let key = null;
let data = null;
let heardAt = 0;
let askedAt = 0;
let links = [];
let outbox = [];
const recent = [];
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

// ---- link --------------------------------------------------------------------------------

// The link library is a large file. On the first launch after an update the previous offline copy
// of this app can give up on it before it arrives, so it is fetched again for about half a minute.
let mqttTries = 0;
let mqttLoading = false;
function loadMqtt() {
  if (typeof mqtt !== 'undefined' || mqttLoading || mqttTries >= 10) return;
  mqttTries++;
  mqttLoading = true;
  const s = document.createElement('script');
  s.src = 'vendor/mqtt.min.js';
  s.onload = () => { mqttLoading = false; if (document.visibilityState === 'visible') { openLink(); flushOutbox(); } };
  s.onerror = () => { mqttLoading = false; setTimeout(loadMqtt, 3000); };
  document.head.appendChild(s);
}

let linkId = '';

function openLink() {
  if (links.length) return;
  if (typeof mqtt === 'undefined') { loadMqtt(); return; }
  linkId = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');
  for (const url of BROKERS) addBroker(url);
  spareTimer = setTimeout(openSpare, 5000);
}

function addBroker(url, extra = {}) {
  const client = mqtt.connect(url, {
    clientId: `sgg-${linkId}-${links.length}`, clean: true, keepalive: 45, protocolVersion: 4,
    reconnectPeriod: 1500, connectTimeout: 8000, ...extra,
  });
  client.on('connect', () => {
    client.subscribe(`bkr/${topic}/s`, { qos: 1 });
    flushOutbox();
  });
  client.on('message', (t, payload) => handle(new TextDecoder().decode(payload)));
  client.on('error', () => { /* mqtt.js reconnects by itself */ });
  links.push(client);
  return client;
}

// Neither main broker connected within 5 s (a network that lets only web traffic through): the
// spare on port 443 joins in.
function openSpare() {
  spareTimer = 0;
  if (!links.length || links.some((l) => l.connected || l.spare)) return;
  addBroker(SPARE.url, { username: SPARE.username, password: SPARE.password }).spare = true;
}

// Graceful close, so a last 'bye' still goes out.
function closeLink() {
  const old = links;
  links = [];
  clearTimeout(spareTimer);
  spareTimer = 0;
  for (const l of old) { try { l.end(false); } catch (e) { /* already closed */ } }
}

function flushOutbox() {
  const live = links.filter((l) => l.connected);
  if (!live.length) return;
  const due = outbox.filter((o) => Date.now() - o.at < 60000);
  outbox = [];
  for (const o of due) for (const l of live) l.publish(`bkr/${topic}/c`, o.body, { qos: 1 });
}

async function send(c) {
  const body = await seal({ c, ts: Date.now() });
  const live = links.filter((l) => l.connected);
  if (!live.length) { outbox.push({ body, at: Date.now() }); return; }
  for (const l of live) l.publish(`bkr/${topic}/c`, body, { qos: 1 });
}

async function handle(text) {
  if (recent.includes(text)) return; // the same message from the other broker
  recent.push(text);
  if (recent.length > 8) recent.shift();
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

// On screen: live link, a hello every two minutes and a clock for the state line. Hidden: nothing.
function onVisibility() {
  clearInterval(helloTimer);
  clearInterval(tickTimer);
  if (document.visibilityState === 'visible') {
    openLink();
    hello();
    helloTimer = setInterval(hello, 120000);
    tickTimer = setInterval(renderState, 5000);
  } else {
    send('bye').then(closeLink);
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

  // An amount the ledger has not counted yet is shown as such, never as CA$0.00.
  const c = data.cost || {};
  const counted = c.ok && c.todayCad != null;
  $('costText').textContent = !c.ok ? 'Unavailable' : counted ? money(c.todayCad) : 'Not counted yet';
  const notes = [];
  if (counted) notes.push(c.partial ? 'Partial · API prices' : 'API prices');
  else if (c.ok) notes.push('Ledger not run today');
  if (c.ok && c.monthCad != null) notes.push(`month CA$${Math.round(c.monthCad).toLocaleString('en-CA')}`);
  $('costNote').textContent = notes.join(' · ');

  // These glasses as the phone last reported them. The last place itself stays on the PC.
  const g = data.glasses || {};
  $('glassesBlock').hidden = !g.ok;
  if (g.ok) {
    // A battery reading is shown only while it is live (connected, recent report). Otherwise the phone's
    // tracker has not caught up with these glasses, which are plainly working while this is on screen.
    const live = g.fresh && g.st !== 'disconnected';
    const value = $('glassesText');
    value.textContent = live ? (g.bat != null ? `${g.bat}%` : 'Connected') : 'Not reporting';
    value.classList.toggle('low', live && g.bat != null && g.bat <= 20 && !g.chg);
    value.classList.toggle('quiet', !live);
    const parts = [];
    if (live) {
      if (g.chg) parts.push('charging');
      parts.push(`phone reported ${ago(g.rep)}`);
    } else if (g.st === 'disconnected') {
      parts.push(`disconnected ${ago(g.rep)}`);
      if (g.place) parts.push('place in Studio');
    } else {
      parts.push(`last heard ${ago(g.rep)}`, 'check Tidal Glass');
    }
    $('glassesNote').textContent = parts.join(' · ');
  }
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
