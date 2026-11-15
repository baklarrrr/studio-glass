"""Bakar Studio's address forwards to Bakar Home. Synthetic loopback only; a stub stands in for Bakar Home."""
import json
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
KEY = 'A' * 43  # synthetic
checks = []
seen = []
HOME = b'<!doctype html><title>Bakar Home stub</title><p id="home">Bakar Home</p>'


class Site(SimpleHTTPRequestHandler):
    """Laid out like the public site: /studio-glass/ is this repository, /glass-home/ is a stub."""
    def log_message(self, *_args): pass
    def do_GET(self):
        seen.append(self.path)
        if self.path.split('?')[0] == '/glass-home/':
            self.send_response(200); self.send_header('Content-Type', 'text/html'); self.send_header('Content-Length', str(len(HOME))); self.end_headers(); self.wfile.write(HOME); return
        if not self.path.startswith('/studio-glass/'):
            self.send_error(404); return
        self.path = self.path[len('/studio-glass'):]
        super().do_GET()


def run():
    server = ThreadingHTTPServer(('127.0.0.1', 0), lambda *a: Site(*a, directory=str(ROOT)))
    Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}/studio-glass/'
    def check(name, ok):
        checks.append({'name': name, 'passed': bool(ok)}); print(('PASS ' if ok else 'FAIL ') + name); assert ok, name
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(channel='chrome')
            try:
                def fresh(script=''):
                    context = browser.new_context(viewport={'width': 600, 'height': 600}, service_workers='block')
                    page = context.new_page(); page.set_default_timeout(8000)
                    if script: page.add_init_script(script)
                    return page
                def fragment(page):
                    return page.evaluate('Object.fromEntries(new URLSearchParams(location.hash.slice(1)))')
                page = fresh(); page.goto(base + f'#t=synthetic-topic&k={KEY}'); page.wait_for_selector('#home')
                check('a PC link to Bakar Studio lands in Bakar Home', page.evaluate('location.pathname') == '/glass-home/')
                check('its pairing is handed on in the fragment, on Review, Renders', fragment(page) == {'sg': f'synthetic-topic~{KEY}', 'tab': 'review', 'view': 'renders'})
                check('nothing of it goes in a query', page.evaluate('location.search') == '')
                page.go_back()
                check('the forward leaves no Bakar Studio entry behind for Back', 'studio-glass' not in page.url)
                page = fresh(); page.goto(base); page.wait_for_selector('#home')
                check('an old registration with no link still lands on Review, Renders', fragment(page) == {'tab': 'review', 'view': 'renders'})
                page = fresh(); page.goto(base + 'index.html?test=1#tab=apps'); page.wait_for_selector('#home')
                check('another fragment is carried as it is', fragment(page) == {'tab': 'apps', 'view': 'renders'} and page.evaluate('location.search') == '')
                page = fresh(); page.goto(base + f'local.html#t=synthetic-topic&k={KEY}'); page.wait_for_selector('#home')
                check('the kept sidebar page also forwards on the glasses', fragment(page).get('sg') == f'synthetic-topic~{KEY}')
                held = fresh('window.__holdForward=true;'); held.goto(base + f'#t=synthetic-topic&k={KEY}')
                check('one visible line says where Bakar Studio went', held.inner_text('#moved') == 'Bakar Studio is now inside Bakar Home.' and held.is_visible('#moved'))
                check('the fallback is focused and is a real control', held.evaluate('document.activeElement.id') == 'go' and held.inner_text('#go') == 'Open Bakar Home')
                box = held.evaluate('(()=>{const r=document.getElementById("go").getBoundingClientRect();return [r.left,r.top,r.right,r.bottom]})()')
                check('line and button fit the 600 by 600 display', box[0] >= 0 and box[1] >= 0 and box[2] <= 600 and box[3] <= 600 and held.evaluate('document.documentElement.scrollHeight<=600&&document.documentElement.scrollWidth<=600'))
                check('the page keeps no pairing of its own', held.evaluate('localStorage.length') == 0)
                held.keyboard.press('Enter'); held.wait_for_selector('#home')
                check('pressing the button opens Bakar Home with the pairing', fragment(held).get('sg') == f'synthetic-topic~{KEY}')
                check('no pairing reached the server', not any('synthetic-topic' in path or KEY in path for path in seen))
                local = fresh('window.STUDIO_LOCAL=true;')
                local.route('**/local/summary', lambda r: r.fulfill(status=200, content_type='application/json', body=json.dumps({'t': 'studio', 'at': 1, 'head': 'Quiet', 'renders': {'items': []}})))
                local.goto(base); local.wait_for_url('**/local.html'); local.wait_for_function('data!==null')
                check('the PC sidebar keeps its own page', local.is_visible('#headCard'))
            finally: browser.close()
    finally: server.shutdown(); server.server_close()
    evidence = Path(os.environ.get('STUDIO_UI_EVIDENCE', ROOT.parent / 'evidence-ui')); evidence.mkdir(parents=True, exist_ok=True)
    (evidence / 'forward-results.json').write_text(json.dumps({'checks': checks}, indent=2), encoding='utf-8')
    print(f'ALL PASSED: {len(checks)} checks')


if __name__ == '__main__': run()
