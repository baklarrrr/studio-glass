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

// Three public brokers, all opened together: EMQX, HiveMQ and shiftr.io's on port 443 (the relay is on
// all three). shiftr.io used to wait 5 s as a spare, but on 2026-10-25 EMQX and HiveMQ could not be
// reached from home at all, so every opening waited on it.
const BROKERS = [
  { url: 'wss://broker.emqx.io:8084/mqtt' },
  { url: 'wss://broker.hivemq.com:8884/mqtt' },
  { url: 'wss://public.cloud.shiftr.io', username: 'public', password: 'public' },
];
const OUTBOX_MAX_AGE = 60000;
// A broker that connects late (or again) is also handed what went out in the last few seconds, so a
// hello that went only to a broker without the relay still arrives.
const RESEND_WINDOW = 10000;
const ANSWER_WAIT = 10000;   // a hello the PC hasn't answered in this long: "PC not answering"
const CALM_AFTER = 15000;    // untouched this long: less light
const LOW_BATTERY = 15;      // the same threshold as Tidal Glass
const $ = (id) => document.getElementById(id);

let topic = null;
let key = null;
let data = null;
let links = [];
let linkId = '';
let linkDownSince = 0;    // when the page started waiting for a broker (0 while one is connected)
let outbox = [];          // sealed messages waiting for a connection: { body, at }
let sentLately = [];      // sealed messages already out: { body, at }
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
const view = { screen: 'dashboard', filter: 'all', listPage: 0, detailPage: 0,
  selected: null, detailText: '', listPages: [], detailPages: [] };

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
  else if (!linkDownSince) linkDownSince = Date.now();
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
  for (const b of BROKERS) addBroker(b);
}

// Retries are scheduled here, not by mqtt.js (reconnectPeriod 0), as in Tidal Glass build 17: on 2026-10-25 an open
// page without signal tried every broker about every 2 s for 8.5 minutes, keeping the glasses' radio awake. Now 1 s
// for three tries, then doubling to 30 s while nothing is connected, and 10 min for a broker that keeps failing
// while another carries the link. A connect, a network change or a new visit (fresh links) starts it fast again.
function retryDelay(fails, othersUp) {
  if (othersUp) return Math.min(600000, 1000 * 2 ** Math.min(fails, 10));
  return fails <= 3 ? 1000 : Math.min(30000, 1000 * 2 ** (fails - 3));
}

function scheduleRetry(client) {
  if (client.retryTimer || !links.includes(client) || client.connected) return;
  client.fails = (client.fails || 0) + 1;
  client.retryTimer = setTimeout(() => {
    client.retryTimer = 0;
    if (!links.includes(client) || client.connected) return;
    // The same message stores, as mqtt.js's own reconnect: a publish still waiting for its acknowledgement is sent
    // again and cleared. With fresh stores it stays unacknowledged forever, and end(false) in closeLink then never
    // closes this link (found in the Quran Glass review, 2026-10-25).
    try { client.reconnect({ incomingStore: client.incomingStore, outgoingStore: client.outgoingStore }); } catch (e) { scheduleRetry(client); }
  }, retryDelay(client.fails, linkUp()));
}

let clientSeq = 0;
function addBroker({ url, ...extra }) {
  const client = mqtt.connect(url, {
    clientId: `sgg-${linkId}-${clientSeq++}`, clean: true, keepalive: 45, protocolVersion: 4,
    reconnectPeriod: 0, connectTimeout: 6000, ...extra,
  });
  client.on('connect', () => {
    client.fails = 0;
    clearTimeout(client.retryTimer);
    client.retryTimer = 0;
    client.subscribe(`bkr/${topic}/s`, { qos: 1 });
    linkChanged();
    const now = Date.now();
    sentLately = sentLately.filter((o) => now - o.at < RESEND_WINDOW);
    for (const o of sentLately) client.publish(`bkr/${topic}/c`, o.body, { qos: 1 });
    flushOutbox();
    // Back after a drop: a hello lost on the way (or too old to send) is asked again.
    if (helloAt && answeredRe < helloAt && Date.now() - helloAt > 3000) hello();
  });
  client.on('message', (t, payload) => handle(new TextDecoder().decode(payload)));
  client.on('offline', linkChanged);
  client.on('close', () => { linkChanged(); scheduleRetry(client); });
  client.on('error', () => { /* the close that follows schedules the next try */ });
  links.push(client);
  return client;
}

// Graceful close, so a last 'bye' still goes out.
function closeLink() {
  const old = links;
  links = [];
  outbox = [];
  sentLately = [];
  linkDownSince = 0;
  for (const l of old) { clearTimeout(l.retryTimer); try { l.end(false); } catch (e) { /* already closed */ } }
}

function flushOutbox() {
  const live = links.filter((l) => l.connected);
  if (!live.length) return;
  const now = Date.now();
  const due = outbox.filter((o) => now - o.at < OUTBOX_MAX_AGE);
  outbox = [];
  for (const o of due) {
    for (const l of live) l.publish(`bkr/${topic}/c`, o.body, { qos: 1 });
    sentLately.push({ body: o.body, at: now });
  }
}

async function send(c, ts = Date.now()) {
  const body = await seal({ c, ts });
  const live = links.filter((l) => l.connected);
  if (!live.length) { outbox.push({ body, at: ts }); return; }
  for (const l of live) l.publish(`bkr/${topic}/c`, body, { qos: 1 });
  sentLately.push({ body, at: Date.now() });
  if (sentLately.length > 20) sentLately.shift();
}

async function handle(text) {
  if (recent.includes(text)) return; // the same message from another broker
  recent.push(text);
  if (recent.length > 8) recent.shift();
  let m;
  try { m = await openMessage(text); } catch (e) { return; }
  if (m.t !== 'studio') return;
  if (data && Number(m.at) < Number(data.at)) return; // an older copy one broker still kept
  const firstSummary = !data;
  data = m;
  if (firstHelloAt && Number(m.re) >= firstHelloAt) answeredRe = Math.max(answeredRe, Number(m.re));
  render();
  if (firstSummary && view.screen === 'dashboard') $('headCard').focus({ preventScroll: true });
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
  if (view.screen === 'detail' && data) renderJobs();
}

function render() {
  drawnMinute = Math.floor(Date.now() / 60000);
  for (const el of document.querySelectorAll('.dashboard')) el.hidden = view.screen !== 'dashboard' || (el.id !== 'headCard' && !data);
  $('headCard').setAttribute('aria-disabled', String(!data));
  $('headCard').tabIndex = data ? 0 : -1;
  $('headCard').setAttribute('aria-label', data && data.renders && data.renders.attention ? 'Open jobs needing your eyes' : 'Open render jobs');
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
  const lowerEdge = () => block.getBoundingClientRect().bottom - parseFloat(getComputedStyle(block).paddingBottom) - parseFloat(getComputedStyle(block).borderBottomWidth);
  const fitRenders = () => {
    while (!block.hidden && (block.scrollHeight > block.clientHeight + 1 || list.getBoundingClientRect().bottom > lowerEdge() + 1)) {
      const listed = [...list.children].filter((li) => li !== moreRow);
      if (listed.length <= 1) break;
      listed[listed.length - 1].remove();
      more++;
      showMore();
    }
  };

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
  // One short line (the value above already says "Not counted yet" when the ledger hasn't run today).
  const notes = [];
  if (counted) notes.push(c.partial ? 'API prices · partial' : 'API prices');
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
    // "Not reporting 3 h ago · open Tidal Glass on your phone": short enough for one line.
    value = 'Not reporting';
    if (g.rep) note.push(ago(g.rep));
    note.push('open Tidal Glass on your phone');
  }
  $('glassesText').textContent = value;
  $('glassesText').classList.toggle('quiet', state === 'quiet');
  $('glassesNote').textContent = note.join(' · ');
  // Measure only after the cards below have their final text and height.
  fitRenders();
  renderJobs();
}

// ---- read-only render drilldown ------------------------------------------------------------
// No new commands: Refresh uses the same hello as the dashboard. Older relays have no identities,
// so their detail page keeps a labelled snapshot instead of guessing which job a refresh describes.
function suppliedJobs() {
  const r = (data && data.renders) || {};
  const rich = Array.isArray(r.details);
  const records = rich ? r.details : (Array.isArray(r.items) ? r.items : []);
  const counts = new Map();
  for (const it of records) if (typeof it.id === 'string' && it.id) counts.set(it.id, (counts.get(it.id) || 0) + 1);
  return records.map((it, index) => {
    const stable = typeof it.id === 'string' && it.id && counts.get(it.id) === 1;
    return { ...it, stable: !!stable, rich, jobKey: stable ? `id:${it.id}` : `summary:${index}` };
  });
}

function jobState(it) {
  if (it.st === 'attention') return 'Needs a look';
  if (it.st === 'queued') return 'Waiting';
  if (it.st === 'running') return 'Rendering';
  return 'State not supplied';
}

function jobProgress(it, asOf) {
  const parts = [jobState(it)];
  if (Number.isFinite(it.pct)) parts.push(`${it.pct}%`);
  if (it.st === 'running' && Number.isFinite(Number(it.since)) && Number(it.since) > 0) {
    parts.push(runningFor(it.since, asOf || (stateInfo().live ? Date.now() : Number(data.at) || Date.now())));
  }
  return parts.join(' · ');
}

function focusControl(key) {
  const controls = visibleControls();
  const found = controls.find((el) => (el.dataset.jobKey || el.id) === key);
  (found || controls.find((el) => el.classList.contains('job-button')) || controls[0])?.focus({ preventScroll: true });
}

function showJobList(filter) {
  if (!data) return;
  view.screen = 'list';
  view.filter = filter;
  view.listPage = 0;
  view.selected = null;
  render();
  focusControl('');
}

function showJob(it) {
  view.selected = { key: it.jobKey, stable: it.stable, snapshot: { ...it }, at: data.at };
  view.screen = 'detail';
  view.detailPage = 0;
  view.detailText = '';
  render();
  focusControl(view.detailPages.length > 1 ? 'nextPage' : 'backButton');
}

function goBack() {
  if (view.screen === 'detail') {
    view.screen = 'list';
    const key = view.selected && view.selected.key;
    renderJobs(key);
    focusControl(key);
  } else if (view.screen === 'list') {
    view.screen = 'dashboard';
    render();
    $(view.filter === 'attention' ? 'headCard' : 'rendersBlock').focus({ preventScroll: true });
  }
}

function listContext(jobs) {
  const r = data.renders || {};
  const notes = [];
  if (r.ok === false) notes.push('The render queue could not be checked.');
  const total = view.filter === 'attention' ? Number(r.attention) || 0 : jobs.length;
  notes.push(view.filter === 'attention'
    ? jobs.length === total ? `${jobs.length} jobs need attention` : `${jobs.length} of ${total} attention jobs available`
    : `${jobs.length} render jobs`);
  const hidden = Array.isArray(r.details) ? Number(r.omitted) || 0 : Number(r.more) || 0;
  if (hidden) notes.push(`${hidden} more unavailable here`);
  const queued = Math.max(0, (Number(r.queued) || 0) - suppliedJobs().filter((it) => it.st === 'queued').length);
  if (queued) notes.push(`${queued} waiting; details unavailable`);
  if (!Array.isArray(r.details)) notes.push('Short summaries only');
  return notes.join(' · ');
}

function jobButton(it) {
  const li = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `job-button ${it.st === 'attention' ? 'attention' : it.st === 'queued' ? 'queued' : ''}`;
  button.dataset.jobKey = it.jobKey;
  const name = document.createElement('span');
  name.className = 'job-name';
  name.textContent = it.ti || 'Unnamed render job';
  const meta = document.createElement('span');
  meta.className = 'job-meta';
  meta.textContent = jobProgress(it);
  button.append(name, meta);
  button.addEventListener('click', () => showJob(it));
  li.append(button);
  return li;
}

function paginateJobs(jobs) {
  const list = $('jobList');
  const pages = [];
  let page = [];
  list.replaceChildren();
  for (const it of jobs) {
    const row = jobButton(it);
    list.append(row);
    if (list.scrollHeight > $('jobBody').clientHeight && page.length) {
      pages.push(page);
      page = [];
      list.replaceChildren(row);
    }
    page.push(it);
  }
  if (page.length) pages.push(page);
  return pages.length ? pages : [[]];
}

function detailCopy(it, missing, showName) {
  const selected = view.selected;
  const parts = showName ? [it.ti || 'Unnamed render job'] : [];
  if (missing) {
    parts.push('No longer in this report', 'This job is absent from the latest report. Its current state is unknown. Go back or refresh to check again.');
    return parts.join('\n\n');
  }
  const detail = typeof it.detail === 'string' && it.detail.trim() ? it.detail : '';
  const why = typeof it.why === 'string' && it.why.trim() ? it.why : '';
  if (why && detail && !detail.startsWith(why)) parts.push(why);
  if (detail) parts.push(detail);
  else if (why) parts.push(why, 'The full reason was not supplied by this relay.');
  else parts.push('No reason was supplied.');
  if (it.detailTruncated) parts.push('The relay shortened this reason. The remaining text is unavailable here.');
  if (!selected.stable) parts.push('Short summary — identity not supplied. This view keeps the report you opened. Go back and reopen for the latest summary.');
  if (it.source) parts.push(`Source: ${it.source}`);
  else parts.push('Source not supplied');
  return parts.join('\n\n');
}

// Measure actual wrapping, not a character-count guess. Preserve every supplied character across
// pages, including long filenames and unbroken text; no scrolling or invisible clipped paragraph.
function paginateDetail(text) {
  const el = $('detailText');
  const room = $('jobBody').clientHeight;
  const pages = [];
  let rest = text;
  while (rest.length) {
    let low = 1;
    let high = rest.length;
    let fit = 0;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      el.textContent = rest.slice(0, mid);
      if (el.scrollHeight <= room) { fit = mid; low = mid + 1; }
      else high = mid - 1;
    }
    // An extremely short viewport still needs one character per page to make forward progress.
    fit = Math.max(1, fit);
    if (fit < rest.length) {
      const boundary = Math.max(rest.lastIndexOf('\n', fit - 1), rest.lastIndexOf(' ', fit - 1));
      if (boundary > fit * 0.65) fit = boundary + 1;
      const code = rest.charCodeAt(fit - 1);
      if (code >= 0xD800 && code <= 0xDBFF && fit > 1) fit--;
    }
    pages.push(rest.slice(0, fit));
    rest = rest.slice(fit);
  }
  return pages.length ? pages : [''];
}

function renderJobs(returnKey) {
  $('jobScreen').hidden = view.screen === 'dashboard';
  if (view.screen === 'dashboard' || !data) return;
  const oldFocus = document.activeElement;
  const focusKey = oldFocus && (oldFocus.dataset.jobKey || oldFocus.id);
  const inList = view.screen === 'list';
  $('jobHeading').classList.toggle('detail-heading', !inList);
  $('jobContext').classList.remove('saved');
  $('jobList').hidden = !inList;
  $('detailText').hidden = inList;
  $('jobEmpty').hidden = true;
  let total;
  let page;
  if (inList) {
    const jobs = suppliedJobs().filter((it) => view.filter !== 'attention' || it.st === 'attention');
    $('jobHeading').textContent = view.filter === 'attention' ? 'Needs your eyes' : 'Render jobs';
    $('jobContext').textContent = listContext(jobs);
    view.listPages = paginateJobs(jobs);
    const keep = returnKey || (oldFocus && oldFocus.classList.contains('job-button') ? focusKey : '');
    const location = keep ? view.listPages.findIndex((items) => items.some((it) => it.jobKey === keep)) : -1;
    if (location >= 0) view.listPage = location;
    view.listPage = Math.min(view.listPage, view.listPages.length - 1);
    $('jobList').replaceChildren(...view.listPages[view.listPage].map(jobButton));
    if (!jobs.length) {
      $('jobEmpty').hidden = false;
      $('jobEmpty').textContent = view.filter === 'attention' ? 'No attention-job details were supplied.' : 'No individual render jobs were supplied.';
    }
    total = view.listPages.length;
    page = view.listPage;
  } else {
    const selected = view.selected;
    const current = selected.stable ? suppliedJobs().find((it) => it.stable && it.jobKey === selected.key) : selected.snapshot;
    $('jobHeading').textContent = (current || selected.snapshot).ti || 'Unnamed render job';
    const reportTime = Number(selected.at) > 0 ? new Date(Number(selected.at)).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'time unavailable';
    const saved = !selected.stable || !stateInfo().live;
    const status = current ? jobProgress(current, !selected.stable ? Number(selected.at) : null) : '';
    $('jobContext').textContent = !current ? 'Job unavailable in the latest report' : !selected.stable
      ? `Saved status: ${status}\nSaved report: ${reportTime} · identity not supplied`
      : `${saved ? 'Saved status: ' : ''}${status}`;
    $('jobContext').classList.toggle('saved', saved || !current);
    const heading = $('jobHeading');
    const copy = detailCopy(current || selected.snapshot, !current, heading.scrollWidth > heading.clientWidth);
    view.detailText = copy;
    view.detailPages = paginateDetail(copy);
    view.detailPage = Math.min(view.detailPage, view.detailPages.length - 1);
    $('detailText').textContent = view.detailPages[view.detailPage];
    total = view.detailPages.length;
    page = view.detailPage;
  }
  $('pagePosition').textContent = `Page ${page + 1} of ${total}`;
  $('previousPage').disabled = page === 0;
  $('nextPage').disabled = page >= total - 1;
  if (oldFocus && (!oldFocus.isConnected || oldFocus.disabled)) focusControl(focusKey);
}

function changePage(delta) {
  const prop = view.screen === 'detail' ? 'detailPage' : 'listPage';
  const pages = view.screen === 'detail' ? view.detailPages : view.listPages;
  const next = Math.max(0, Math.min(pages.length - 1, view[prop] + delta));
  if (next === view[prop]) return;
  view[prop] = next;
  // A focused job from the old page must not pull us back to that page during reconciliation.
  $('backButton').focus({ preventScroll: true });
  renderJobs();
  focusControl(view.screen === 'detail' ? (delta > 0 && !$('nextPage').disabled ? 'nextPage' : 'previousPage') : '');
}

function visibleControls() {
  return [...document.querySelectorAll('#glance button, #glance [role="button"]')]
    .filter((el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true' && el.getClientRects().length);
}

function navigateJobs(event) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if ((event.key === 'Escape' || event.key === 'Backspace') && view.screen !== 'dashboard') {
    event.preventDefault(); goBack(); return;
  }
  if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft') && view.screen !== 'dashboard') {
    event.preventDefault(); changePage(event.key === 'ArrowRight' ? 1 : -1); return;
  }
  const controls = visibleControls();
  if (!controls.length) return;
  if (['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(event.key)) {
    event.preventDefault();
    const index = controls.indexOf(document.activeElement);
    const delta = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1;
    controls[Math.max(0, Math.min(controls.length - 1, index < 0 ? 0 : index + delta))].focus({ preventScroll: true });
  } else if (event.key === 'Enter' || event.key === ' ') {
    if (event.repeat) { event.preventDefault(); return; }
    const active = document.activeElement;
    if (controls.includes(active)) { event.preventDefault(); active.click(); }
  }
}

function bindJobNavigation() {
  $('headCard').addEventListener('click', () => showJobList(data && data.renders && data.renders.attention ? 'attention' : 'all'));
  $('rendersBlock').addEventListener('click', () => showJobList('all'));
  $('backButton').addEventListener('click', goBack);
  $('refreshButton').addEventListener('click', () => { hello(); renderState(); });
  $('previousPage').addEventListener('click', () => changePage(-1));
  $('nextPage').addEventListener('click', () => changePage(1));
  document.addEventListener('keydown', navigateJobs);
  window.addEventListener('resize', () => { if (data) render(); });
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
  bindJobNavigation();
  for (const ev of ['keydown', 'pointerdown', 'click']) document.addEventListener(ev, wakeUp, true);
  watchBrowserBattery();
  render();
  registerServiceWorker();
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', () => send('bye'));
  if (document.visibilityState === 'visible') onVisibility();
}

main();
