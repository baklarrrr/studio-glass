"""Regression checks for Studio Glass (run before every publish).

Serves nothing itself: start `python -m http.server 47612 --bind 127.0.0.1 --directory webapp` first.
The link to the PC is replaced by a fake one: summaries are sealed with the page's own code and fed
in, and everything the page sends is decrypted and checked. Synthetic data only.

Guards the 2026-10-25 review: an old retained summary read as "Live"; Speed Light hid render
problems; "last heard 498037 h ago"; no "Reconnecting…"; "3 need a look" with 2 listed.

  python webapp/tests/studio_test.py [frames folder]
"""
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
URL = f"http://127.0.0.1:47612/index.html?test=1#t=sgstudiotest&k={KEY}"
FRAMES = Path(sys.argv[1]) if len(sys.argv) > 1 else None

failures = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail and not ok else ""))
    if not ok:
        failures.append(name)


def summary(now, **over):
    s = {"t": "studio", "at": now, "re": 0, "head": "Work moving", "pc": "live", "ai": {"Codex": 2, "Claude": 1},
         "aiState": "live", "aiNote": "",
         "renders": {"ok": True, "running": 1, "queued": 0, "attention": 0, "more": 0,
                     "items": [{"ti": "TEST-shot-010", "st": "running", "pct": None, "since": now - 12 * 60000}]},
         "cost": {"ok": True, "todayCad": 12.34, "monthCad": 26569.0, "partial": False, "updated": "10:00"},
         "glasses": {"ok": True, "st": "connected", "fresh": True, "bat": 47, "chg": False, "worn": True,
                     "seen": now, "rep": now - 120000, "place": False}}
    s.update(over)
    return s


with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", args=["--enable-spatial-navigation"])
    page = browser.new_context(viewport={"width": 600, "height": 600}).new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.add_init_script("""
      window.__sent = [];
      window.__testLink = { connected: true, publish(t, body) { window.__sent.push(body); }, end() {} };
    """)
    page.route("**/broker.*/**", lambda route: route.abort())
    page.goto(URL)
    page.wait_for_function("typeof key !== 'undefined' && key !== null && helloAt > 0")

    def now():
        return page.evaluate("Date.now()")

    def feed(s):
        page.evaluate("async m => { await handle(await seal(m)); }", s)

    def text(sel):
        return page.evaluate("s => document.querySelector(s).textContent", sel)

    def hidden(sel):
        return page.evaluate("s => document.querySelector(s).hidden", sel)

    def shot(name):
        if FRAMES:
            FRAMES.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(FRAMES / f"{name}.png"))

    # 1. Before any summary: one message in the head card, no empty boxes, no repeated top line.
    check("waiting: no empty boxes", all(hidden(s) for s in ("#rendersBlock", "#pairRow", "#glassesBlock")))
    check("waiting: head card says it", text("#headline") == "Asking your PC…", text("#headline"))
    check("waiting: top line not repeating it", hidden("#state"))
    shot("A00_waiting")
    page.evaluate("helloAt = Date.now() - 11000; prevHelloAt = 0; renderState()")
    check("no summary, no answer: 'PC not answering'", text("#headline") == "PC not answering", text("#headline"))
    shot("A01_pc_not_answering_no_data")
    page.evaluate("hello()")

    # 2. The hello the page sent carries its own time stamp.
    sent = page.evaluate("async () => { const o = []; for (const b of window.__sent) o.push(await openMessage(b)); return o; }")
    hellos = [m for m in sent if m.get("c") == "hello"]
    hello_ts = page.evaluate("helloAt")
    check("hello sent with its time stamp", bool(hellos) and hellos[-1]["ts"] == hello_ts, json.dumps(sent[-2:]))

    # 3. A three-hour-old retained summary is never "Live" (G05).
    t = now()
    feed(summary(t - 3 * 3600_000, re=t - 3 * 3600_000))
    check("old retained copy: still checking, not live", text("#stateText") == "Checking your PC…" and
          not page.evaluate("document.getElementById('dot').classList.contains('live')"), text("#stateText"))
    page.evaluate("helloAt = Date.now() - 11000; prevHelloAt = 0; renderState()")
    check("old copy, no answer: 'PC not answering · last update 3 h ago'",
          text("#stateText") == "PC not answering · last update 3 h ago", text("#stateText"))
    check("not answering is shown as a warning", page.evaluate("document.getElementById('state').classList.contains('warn')"))
    page.evaluate("render()")
    check("old copy is dimmed under the warning", page.evaluate("document.body.classList.contains('stale')"))
    check("old copy: running time as of its last update", text("#renderList li .st") == "running 12 min",
          text("#renderList li .st"))
    shot("A02_old_copy_pc_not_answering")

    # 4. A reply to this visit's hello is live.
    page.evaluate("hello()")
    t = now()
    feed(summary(t, re=page.evaluate("helloAt")))
    check("fresh reply: Live", text("#stateText") == "Live" and
          page.evaluate("document.getElementById('dot').classList.contains('live')"), text("#stateText"))
    check("live: not dimmed", not page.evaluate("document.body.classList.contains('stale')"))
    check("running render named, with its time", text("#renderList li .ti") == "TEST-shot-010" and
          text("#renderList li .st") == "running 12 min", text("#renderList li .st"))
    check("cost: AI use at API prices, month in a few characters",
          text("#costLabel") == "AI use today" and text("#costNote") == "API prices · month CA$27k", text("#costNote"))
    check("cost note on one line", page.evaluate(
        "(() => { const n = document.getElementById('costNote'); return n.scrollWidth <= n.clientWidth; })()"))
    check("glasses line: connected, battery and report age",
          text("#glassesText") == "Connected" and text("#glassesNote") == "47% · phone reported 2 min ago", text("#glassesNote"))
    shot("A03_live")

    # 5. The next hello keeps "Live" while it is on its way, and only then says not answering.
    page.evaluate("hello()")
    check("next hello in flight: still Live", text("#stateText") == "Live", text("#stateText"))
    # (Time moved on: the answered hello is two minutes older than the latest, which went 11 s ago.)
    page.evaluate("helloAt = Date.now() - 11000; prevHelloAt = answeredRe = helloAt - 120000; renderState()")
    check("next hello unanswered: not answering", text("#stateText").startswith("PC not answering"), text("#stateText"))
    page.evaluate("hello()")
    feed(summary(now(), re=page.evaluate("helloAt")))

    # 6. A dropped link says "Reconnecting…" (G02), and recovers.
    page.evaluate("window.__testLink.connected = false; linkChanged(); linkDownSince = Date.now() - 6000; renderState()")
    check("link down: Reconnecting…", text("#stateText") == "Reconnecting…", text("#stateText"))
    shot("A04_reconnecting")
    page.evaluate("window.__testLink.connected = true; linkChanged()")
    check("link back: Live again", text("#stateText") == "Live", text("#stateText"))

    # 7. A render problem leads, and Speed Light only reaches the AI card (G06).
    probs = [{"ti": f"TEST-fail-{n}", "st": "attention", "why": "Output missing"} for n in range(6)]
    feed(summary(now(), re=page.evaluate("helloAt"), head="Needs your eyes", ai={}, aiState="stale",
                 aiNote="Speed Light stopped updating",
                 renders={"ok": True, "running": 1, "queued": 0, "attention": 6, "more": 1, "items": probs}))
    check("headline: Needs your eyes", text("#headline") == "Needs your eyes")
    check("AI card: not tracked, Speed Light named", text("#aiText") == "Not tracked" and
          text("#aiNote") == "Speed Light stopped updating", text("#aiNote"))
    rows = page.evaluate("[...document.querySelectorAll('#renderList li')].map(li => li.querySelector('.ti').textContent)")
    listed = len(rows) - 1
    check("everything counted is listed or '+N more'", rows[-1] == f"+{7 - listed} more" and listed >= 2, json.dumps(rows))
    check("nothing cut off at the bottom", page.evaluate(
        "(() => { const b = document.getElementById('rendersBlock'); return b.scrollHeight <= b.clientHeight + 1; })()"))
    shot("A05_needs_eyes_speedlight_stale")

    # 8. Nothing rendering is said in words, not "0 rendering".
    feed(summary(now(), re=page.evaluate("helloAt"), head="Quiet",
                 renders={"ok": True, "running": 0, "queued": 0, "attention": 0, "more": 0, "items": []}))
    check("'Nothing rendering', not '0 rendering'", text("#subline") == "Nothing rendering", text("#subline"))

    # 9. Glasses: no report time is "no report yet" (G07); states before pairing are shown, not hidden.
    g0 = {"ok": True, "st": "connected", "fresh": False, "bat": None, "chg": None, "worn": None, "seen": None,
          "rep": None, "place": False}
    feed(summary(now(), re=page.evaluate("helloAt"), glasses=g0))
    check("no report time: 'no report yet'", text("#glassesNote") == "no report yet · open Tidal Glass on your phone",
          text("#glassesNote"))
    check("no hours count anywhere", " h ago" not in page.evaluate("document.body.innerText"))
    shot("A06_glasses_no_report")
    feed(summary(now(), re=page.evaluate("helloAt"), glasses={**g0, "st": "unpaired"}))
    check("unpaired: shown, says what it waits for", not hidden("#glassesBlock") and text("#glassesText") == "Not tracked yet"
          and text("#glassesNote") == "waiting for the phone app update", text("#glassesNote"))
    feed(summary(now(), re=page.evaluate("helloAt"), glasses={**g0, "st": "disconnected", "fresh": True,
                                                              "rep": now() - 3600_000, "place": True}))
    check("disconnected: when, and where the place is kept",
          text("#glassesNote") == "1 h ago · last place saved on your PC", text("#glassesNote"))

    # 10. Battery: the browser's own reading first, 15% low, a bolt while charging; the phone's as fallback.
    page.evaluate("browserBattery = { level: 0.14, charging: false }; drawBattery()")
    check("14% is low", text("#gbat .gbat-text") == "14%" and page.evaluate("document.getElementById('gbat').classList.contains('low')"))
    page.evaluate("browserBattery = { level: 0.16, charging: false }; drawBattery()")
    check("16% is not low", not page.evaluate("document.getElementById('gbat').classList.contains('low')"))
    page.evaluate("browserBattery = { level: 0.14, charging: true }; drawBattery()")
    check("charging: bolt shown, not low", page.evaluate(
        "getComputedStyle(document.querySelector('#gbat .gbat-bolt')).display !== 'none' && !document.getElementById('gbat').classList.contains('low')"))
    page.evaluate("browserBattery = null")
    feed(summary(now(), re=page.evaluate("helloAt")))
    check("no browser reading: the phone's fresh report", not hidden("#gbat") and text("#gbat .gbat-text") == "47%")
    page.evaluate("browserBattery = { level: 0.47, charging: false }; drawBattery()")

    # 11. Calm: less light after 15 s untouched; a problem stays bright; a press wakes it at once.
    feed(summary(now(), re=page.evaluate("helloAt"), head="Needs your eyes",
                 renders={"ok": True, "running": 0, "queued": 0, "attention": 1, "more": 0, "items": probs[:1]}))
    page.evaluate("lastInputAt = Date.now() - 16000; renderState()")
    check("calm after 15 s", page.evaluate("document.body.classList.contains('calm')"))
    page.wait_for_timeout(1000)
    check("calm: a problem's headline stays bright", page.evaluate(
        "getComputedStyle(document.getElementById('headline')).opacity") == "1")
    check("calm: secondary text dims", float(page.evaluate("getComputedStyle(document.getElementById('subline')).opacity")) < 0.6)
    shot("A07_calm_needs_eyes")
    page.keyboard.press("ArrowDown")
    check("a swipe wakes it", not page.evaluate("document.body.classList.contains('calm')"))
    page.evaluate("lastInputAt = Date.now() - 16000; helloAt = Date.now() - 11000;"
                  "prevHelloAt = answeredRe = helloAt - 120000; renderState()")
    check("a link warning keeps it bright", not page.evaluate("document.body.classList.contains('calm')")
          and text("#stateText").startswith("PC not answering"), text("#stateText"))

    # 12. Focus is a ring, not a lit card.
    page.evaluate("hello()")
    feed(summary(now(), re=page.evaluate("helloAt")))
    page.focus("#headCard")
    check("focused card has no fill", page.evaluate(
        "getComputedStyle(document.getElementById('headCard')).backgroundColor") in ("rgba(0, 0, 0, 0)", "transparent"))
    shot("A08_live_head_focused")

    check("no page errors", not errors, "; ".join(errors))
    browser.close()

print(f"\n{'ALL PASSED' if not failures else str(len(failures)) + ' FAILED'}")
sys.exit(1 if failures else 0)
