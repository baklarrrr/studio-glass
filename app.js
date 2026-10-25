'use strict';

// Bakar Studio at a glance on Meta Ray-Ban Display.
// The studio PC's relay sends a small summary (renders, AI at work, today's AI use at API prices, the
// glasses tracker) through free public MQTT brokers on a private random topic (no daily cap; any
// broker can be down). It is AES-GCM encrypted with the key in this page's URL fragment, which
// browsers never send to a server. Read-only: nothing here can change anything on the PC.
//
// The latest summary is retained on the brokers, so it shows the moment the page connects. The page
// says hello when it opens and every two minutes while it is on screen; the relay answers each hello
// with a fresh summary carrying that hello's time stamp, then sends changes, and stops when the page
// says bye or goes quiet. "Live" means the PC answered this visit's latest hello; a retained copy
// carries an older stamp (or none), so an old summary never reads as live.

const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'];
// shiftr.io's public instance on port 443, for networks that let only web traffic through; joined only
// when neither broker above connects within 5 s.
const SPARE = { url: 'wss://public.cloud.shiftr.io', username: 'public', password: 'public' };
const SPARE_AFTER = 5000;
const OUTBOX_MAX_AGE = 60000;
const ANSWER_WAIT = 10000;   // a hello the PC hasn't answered in this long: "PC not answering"
const CALM_AFTER = 15000;    // untouched this long: less light
const LOW_BATTERY = 15;      // the same threshold as Tidal Glass
const $ = (id) => document.getElementById(id);

let topic = null;
let key = null;
let data = null;
let links = [];
let linkId = '';
let spareTimer = 0;
let linkDownSince = 0;    // when the page started waiting for a broker (0 while one is connected)
let outbox = [];          // sealed messages waiting for a connection: { body, at }
const recent = [];        // the last messages handled (the same one arrives from every broker)
let helloTimer = 0;
let tickTimer = 0;
// Hello time stamps are the glasses' own clock; the relay echoes the latest one it got (`re`).
let helloAt = 0;          // this visit's latest hello
let prevHelloAt = 0;      // the one before it: its answer still counts while the latest is on its way
let firstHelloAt = 0;     // this visit's first hello; an echo older than this is a retained copy
let answeredRe = 0;       // the newest of this visit's hellos the PC has answered
let lastInputAt = Date.now();
let drawnMinute = -1;

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

function linkUp() {
  return links.some((l) => l.connected);
}

function linkChanged() {
  if (linkUp()) linkDownSince = 0;
  else {
    if (!linkDownSince) linkDownSince = Date.now();
    if (links.length && !spareTimer && !links.some((l) => l.spare)) spareTimer = setTimeout(openSpare, SPARE_AFTER);
  }
  renderState();
}

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
  s.onload = () => { mqttLoading = false; if (document.visibilityState === 'visible') openLink(); };
  s.onerror = () => { mqttLoading = false; setTimeout(loadMqtt, 3000); };
  document.head.appendChild(s);
}

function openLink() {
  if (links.length) return;
  // Tests (and only tests) supply their own link.
  if (window.__testLink) { links = [window.__testLink]; window.__testLink.onMessage = handle; flushOutbox(); return; }
  if (typeof mqtt === 'undefined') {
    if (!linkDownSince) linkDownSince = Date.now();
    loadMqtt();
    return;
  }
  linkDownSince = Date.now();
  linkId = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');
  for (const url of BROKERS) addBroker(url);
  spareTimer = setTimeout(openSpare, SPARE_AFTER);
}

function addBroker(url, extra = {}) {
  const client = mqtt.connect(url, {
    clientId: `sgg-${linkId}-${links.length}`, clean: true, keepalive: 45, protocolVersion: 4,
    reconnectPeriod: 1500, connectTimeout: 8000, ...extra,
  });
  client.on('connect', () => {
    client.subscribe(`bkr/${topic}/s`, { qos: 1 });
    linkChanged();
    flushOutbox();
    // Back after a drop: a hello lost on the way (or too old to send) is asked again.
    if (helloAt && answeredRe < helloAt && Date.now() - helloAt > 3000) hello();
  });
  client.on('message', (t, payload) => handle(new TextDecoder().decode(payload)));
  client.on('offline', linkChanged);
  client.on('close', linkChanged);
  client.on('error', () => { /* mqtt.js reconnects by itself */ });
  links.push(client);
  return client;
}

// Neither main broker connected within 5 s (a network that lets only web traffic through): the
// spare on port 443 joins in.
function openSpare() {
  spareTimer = 0;
  if (!links.length || linkUp() || links.some((l) => l.spare)) return;
  addBroker(SPARE.url, { username: SPARE.username, password: SPARE.password }).spare = true;
}

// Graceful close, so a last 'bye' still goes out.
function closeLink() {
  const old = links;
  links = [];
  outbox = [];
  linkDownSince = 0;
  clearTimeout(spareTimer);
  spareTimer = 0;
  for (const l of old) { try { l.end(false); } catch (e) { /* already closed */ } }
}

function flushOutbox() {
  const live = links.filter((l) => l.connected);
  if (!live.length) return;
  const due = outbox.filter((o) => Date.now() - o.at < OUTBOX_MAX_AGE);
  outbox = [];
  for (const o of due) for (const l of live) l.publish(`bkr/${topic}/c`, o.body, { qos: 1 });
}

async function send(c, ts = Date.now()) {
  const body = await seal({ c, ts });
  const live = links.filter((l) => l.connected);
  if (!live.length) { outbox.push({ body, at: ts }); return; }
  for (const l of live) l.publish(`bkr/${topic}/c`, body, { qos: 1 });
}

async function handle(text) {
  if (recent.includes(text)) return; // the same message from another broker
  recent.push(text);
  if (recent.length > 8) recent.shift();
  let m;
  try { m = await openMessage(text); } catch (e) { return; }
  if (m.t !== 'studio') return;
  if (data && Number(m.at) < Number(data.at)) return; // an older copy one broker still kept
  data = m;
  if (firstHelloAt && Number(m.re) >= firstHelloAt) answeredRe = Math.max(answeredRe, Number(m.re));
  render();
}

function hello() {
  prevHelloAt = helloAt;
  helloAt = Date.now();
  if (!firstHelloAt) firstHelloAt = helloAt;
  send('hello', helloAt);
}

// On screen: live link, a hello every two minutes and a clock for the state line. Hidden: nothing.
function onVisibility() {
  clearInterval(helloTimer);
  clearInterval(tickTimer);
  if (document.visibilityState === 'visible') {
    // A new visit: nothing heard before it counts as the PC answering now.
    helloAt = prevHelloAt = firstHelloAt = answeredRe = 0;
    lastInputAt = Date.now();
    openLink();
    hello();
    helloTimer = setInterval(hello, 120000);
    tickTimer = setInterval(tick, 5000);
    render();
  } else {
    send('bye').then(closeLink);
  }
}

function tick() {
  if (Math.floor(Date.now() / 60000) !== drawnMinute) render(); // running times move once a minute
  else renderState();
}

// ---- battery -----------------------------------------------------------------------------

// The glasses' own browser reading when it has one (on the glasses it matched the phone's report,
// 47% at 2026-10-25 07:53), else the glasses tracker's report while it is fresh and under 30 minutes
// old. Charging shows a bolt, not only a colour; low is 15% or less, as in Tidal Glass.
let browserBattery = null; // { level 0..1, charging } from navigator.getBattery, when it is real

function watchBrowserBattery() {
  if (!navigator.getBattery) return;
  navigator.getBattery().then((b) => {
    const read = () => {
      // Chromium answers "full, charging, never empties" when it has no battery at all.
      const unknown = b.level === 1 && b.charging && b.chargingTime === 0 && b.dischargingTime === Infinity;
      browserBattery = unknown ? null : { level: b.level, charging: b.charging };
      drawBattery();
    };
    read();
    for (const ev of ['levelchange', 'chargingchange']) b.addEventListener(ev, read);
  }).catch(() => {});
}

function drawBattery() {
  let pct = null;
  let charging = false;
  let from = '';
  const g = (data && data.glasses) || {};
  if (browserBattery) {
    pct = Math.round(browserBattery.level * 100);
    charging = browserBattery.charging;
  } else if (g.ok && g.fresh && Number.isFinite(g.bat) && g.rep && Date.now() - g.rep < 30 * 60 * 1000) {
    pct = g.bat;
    charging = !!g.chg;
    from = `, as your phone reported ${ago(g.rep)}`;
  }
  const bat = $('gbat');
  bat.hidden = pct == null;
  if (pct == null) return;
  bat.querySelector('.gbat-text').textContent = `${pct}%`;
  bat.querySelector('.gbat-fill').setAttribute('width', String(Math.max(1, 13.4 * pct / 100)));
  bat.classList.toggle('charging', charging);
  bat.classList.toggle('low', !charging && pct <= LOW_BATTERY);
  bat.setAttribute('aria-label', `Glasses battery ${pct}%${charging ? ', charging' : ''}${from}`);
}

// ---- drawing -----------------------------------------------------------------------------

function money(v) {
  return `CA$${Number(v || 0).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// A month's total in a few characters, so the note stays on one line: CA$27k, CA$2.1k, CA$640.
function shortMoney(v) {
  v = Number(v || 0);
  if (v >= 10000) return `CA$${Math.round(v / 1000)}k`;
  if (v >= 1000) return `CA$${(v / 1000).toFixed(1)}k`;
  return `CA$${Math.round(v)}`;
}

// How long ago a time stamp was; '' when there is none (never "498037 h ago").
function ago(ms) {
  ms = Number(ms);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 50) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

// How long a render has run: until now while the PC is answering, else as of its last update (an
// old copy must not count on as if the render were still going).
function runningFor(since, asOf) {
  const m = Math.max(0, Math.floor((asOf - Number(since)) / 60000));
  if (m < 1) return 'just started';
  return m < 60 ? `running ${m} min` : `running ${Math.floor(m / 60)} h ${m % 60} min`;
}

// The link first, then whether the PC answered this visit's latest hello.
function stateInfo() {
  const now = Date.now();
  if (typeof mqtt === 'undefined' && mqttTries >= 10 && !window.__testLink) {
    return { text: 'No link yet: press Back, then Refresh', warn: true, head: 'No link yet', sub: 'Press Back, then Refresh' };
  }
  if (linkDownSince && now - linkDownSince > 5000) return { text: 'Reconnecting…', warn: true, head: 'Reconnecting…' };
  const waiting = helloAt && now - helloAt <= ANSWER_WAIT;
  if ((answeredRe && answeredRe >= helloAt) || (waiting && answeredRe && answeredRe >= prevHelloAt)) {
    return { text: 'Live', live: true };
  }
  if (waiting || !helloAt) return { text: data ? 'Checking your PC…' : 'Asking your PC…', head: 'Asking your PC…' };
  const when = data && ago(data.at);
  return { text: `PC not answering${when ? ` · last update ${when}` : ''}`, warn: true,
    head: 'PC not answering', sub: 'Check that your studio PC is on' };
}

function renderState() {
  const st = stateInfo();
  // Before the first summary the head card says it; the top line would only repeat it.
  $('state').hidden = !data;
  $('stateText').textContent = st.text;
  $('dot').classList.toggle('live', !!st.live);
  $('state').classList.toggle('warn', !!st.warn);
  // Not answering or reconnecting: what is shown is the PC's last update, so it is dimmed under the
  // bright warning instead of looking live.
  document.body.classList.toggle('stale', !!data && !!st.warn);
  if (!data) {
    const head = $('headline');
    head.textContent = st.head || 'Asking your PC…';
    head.className = 'headline ' + (st.warn ? 'attention' : 'quiet');
    $('subline').textContent = st.sub || '';
  }
  checkCalm(!!st.warn);
}

function render() {
  drawnMinute = Math.floor(Date.now() / 60000);
  for (const id of ['rendersBlock', 'pairRow', 'glassesBlock']) $(id).hidden = !data;
  renderState();
  drawBattery();
  if (!data) return;

  const r = data.renders || {};
  const head = $('headline');
  head.textContent = data.head;
  head.className = 'headline ' + ({ 'Work moving': 'moving', 'Needs your eyes': 'attention', Quiet: 'quiet' }[data.head] || 'offline');

  const parts = [];
  if (r.ok === false) parts.push('Renders could not be checked');
  else {
    parts.push(r.running ? `${r.running} rendering` : 'Nothing rendering');
    if (r.queued) parts.push(`${r.queued} waiting`);
    if (r.attention) parts.push(`${r.attention} need${r.attention === 1 ? 's' : ''} a look`);
  }
  $('subline').textContent = parts.join(' · ');

  const list = $('renderList');
  list.textContent = '';
  const items = r.items || [];
  const row = (mark, ti, st) => {
    const li = document.createElement('li');
    li.innerHTML = '<span class="mark"></span><span class="ti"></span><span class="st"></span>';
    if (mark) li.querySelector('.mark').classList.add(mark);
    li.querySelector('.ti').textContent = ti;
    li.querySelector('.st').textContent = st;
    list.appendChild(li);
    return li;
  };
  if (!items.length) row('idle', r.ok === false ? 'Queue unreadable right now' : 'Nothing rendering', '');
  const asOf = stateInfo().live ? Date.now() : Number(data.at) || Date.now();
  for (const it of items) {
    const st = it.st === 'attention' ? 'needs a look'
      : it.pct != null ? `${it.pct}%` : it.since ? runningFor(it.since, asOf) : 'running';
    const li = row(it.st === 'attention' ? 'attention' : '', it.ti, st);
    if (it.why) {
      const why = document.createElement('span');
      why.className = 'why';
      why.textContent = it.why;
      li.appendChild(why);
    }
  }
  // Everything counted in the line above is either listed or counted here: what doesn't fit on the
  // glasses is taken off the end and added to "+N more", never cut off at the edge.
  const block = $('rendersBlock');
  let more = r.more || 0;
  let moreRow = null;
  const showMore = () => {
    if (!more) return;
    if (!moreRow) { moreRow = row('idle', '', ''); moreRow.classList.add('more'); }
    moreRow.querySelector('.ti').textContent = `+${more} more`;
  };
  showMore();
  while (block.scrollHeight > block.clientHeight + 1) {
    const listed = [...list.children].filter((li) => li !== moreRow);
    if (listed.length <= 1) break;
    listed[listed.length - 1].remove();
    more++;
    showMore();
  }

  // Speed Light counts AI work; when it isn't running, the count is unknown, not zero.
  const ai = data.ai || {};
  const aiState = data.aiState || (data.aiNote ? 'paused' : 'live');
  const names = Object.keys(ai).sort((a, b) => (a === 'Codex' ? -1 : b === 'Codex' ? 1 : a.localeCompare(b)));
  $('aiText').textContent = aiState !== 'live' ? 'Not tracked' : names.length ? names.map((n) => `${n} ${ai[n]}`).join(' · ') : 'None running';
  $('aiNote').textContent = aiState !== 'live' ? (data.aiNote || 'Speed Light isn’t running') : '';

  // What today's AI work would cost at API prices (not money spent). An amount the ledger has not
  // counted yet is shown as such, never as CA$0.00.
  const c = data.cost || {};
  const counted = c.ok && c.todayCad != null;
  $('costText').textContent = !c.ok ? 'Unavailable' : counted ? money(c.todayCad) : 'Not counted yet';
  const notes = [];
  if (counted) notes.push(c.partial ? 'API prices · partial' : 'API prices');
  else if (c.ok) notes.push('ledger not run today');
  if (c.ok && c.monthCad != null) notes.push(`month ${shortMoney(c.monthCad)}`);
  $('costNote').textContent = notes.join(' · ');

  // These glasses as the tracker on the PC last heard of them from the phone. The last place itself
  // stays on the PC.
  const g = data.glasses || {};
  let value;
  let state = 'quiet';
  const note = [];
  if (!g.ok) {
    value = 'Not readable';
    note.push('the tracker record on your PC');
  } else if (g.st === 'unpaired' || g.st === 'waiting') {
    value = 'Not tracked yet';
    note.push(g.st === 'unpaired' ? 'waiting for the phone app update' : 'waiting for your phone’s first report');
  } else if (g.st === 'disconnected') {
    value = 'Disconnected';
    note.push(ago(g.rep) || 'no report yet');
    if (g.place) note.push('last place saved on your PC');
  } else if (g.fresh) {
    value = g.st === 'connecting' ? 'Connecting' : 'Connected';
    state = '';
    if (Number.isFinite(g.bat)) note.push(`${g.bat}%${g.chg ? ' charging' : ''}`);
    note.push(g.rep ? `phone reported ${ago(g.rep)}` : 'no report yet');
  } else {
    value = 'Not reporting';
    note.push(g.rep ? `last report ${ago(g.rep)}` : 'no report yet', 'open Tidal Glass on your phone');
  }
  $('glassesText').textContent = value;
  $('glassesText').classList.toggle('quiet', state === 'quiet');
  $('glassesNote').textContent = note.join(' · ');
}

// ---- calm: less light while nobody is touching it -------------------------------------------
// After 15 s without a swipe or pinch, borders, labels and secondary text dim. A link warning keeps
// everything bright, and a render problem's headline and reasons stay bright in calm too. The first
// swipe or pinch wakes it at once and still does what it was meant to do.

function checkCalm(warn) {
  document.body.classList.toggle('calm', !!data && !warn && Date.now() - lastInputAt > CALM_AFTER);
}

function wakeUp() {
  lastInputAt = Date.now();
  document.body.classList.remove('calm');
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
  for (const ev of ['keydown', 'pointerdown', 'click']) document.addEventListener(ev, wakeUp, true);
  watchBrowserBattery();
  render();
  registerServiceWorker();
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', () => send('bye'));
  if (document.visibilityState === 'visible') onVisibility();
}

main();
