"""Actual Chromium service-worker cache ownership check on an isolated loopback origin."""
import json
import os
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
checks = []


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *_args): pass


def run():
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Quiet, directory=str(ROOT)))
    Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}/'
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(channel='chrome')
            try:
                page = browser.new_context(viewport={'width':600,'height':600}).new_page()
                # Unpaired page cannot connect to a broker or register the worker itself.
                page.goto(base)
                page.evaluate('''async()=>{
                  await (await caches.open('another-app-v7')).put('/other-app.html',new Response('keep'));
                  await (await caches.open('studio-glass-v1')).put('/old-shell.html',new Response('old'));
                  await navigator.serviceWorker.register('sw.js');
                  await navigator.serviceWorker.ready;
                }''')
                page.wait_for_function('navigator.serviceWorker.controller !== null')
                def check(name, ok):
                    checks.append({'name':name,'passed':bool(ok)}); print(('PASS ' if ok else 'FAIL ')+name); assert ok,name
                names = page.evaluate('caches.keys()')
                check('activation preserves other apps on the same origin', 'another-app-v7' in names)
                check('activation retires only older Studio Glass shells', 'studio-glass-v1' not in names and 'studio-glass-v12-picture-review-candidate' in names)
                page.evaluate('''async()=>{
                  await fetch('/local/summary').catch(()=>{});
                  await fetch('/private-render.jpg').catch(()=>{});
                  await fetch('/review.js');
                }''')
                cached = page.evaluate('''async()=>{const c=await caches.open('studio-glass-v12-picture-review-candidate');return(await c.keys()).map(r=>new URL(r.url).pathname)}''')
                check('local API responses never enter shell cache', not any('/local/' in path for path in cached))
                check('undeclared same-origin files are not cached', '/private-render.jpg' not in cached)
                check('declared review code remains available offline', '/review.js' in cached)
                kept = page.evaluate('''async()=>{const c=await caches.open('another-app-v7');return(await c.match('/other-app.html')).text()}''')
                check('other app cached bytes remain unchanged', kept == 'keep')
                local_context = browser.new_context()
                local_page = local_context.new_page()
                local_page.add_init_script('window.STUDIO_LOCAL=true;')
                local_page.route('**/local/summary', lambda r:r.fulfill(status=200,content_type='application/json',body=json.dumps({'t':'studio','at':1,'head':'Quiet','renders':{'items':[]}})))
                local_page.goto(base)
                local_page.wait_for_function('data!==null')
                check('local sidebar mode registers no service worker', local_page.evaluate('async()=> (await navigator.serviceWorker.getRegistrations()).length') == 0)
                check('local sidebar mode never opens MQTT brokers', local_page.evaluate('links.length===0 && key===null'))
                local_context.close()
            finally: browser.close()
    finally: server.shutdown(); server.server_close()
    evidence=Path(os.environ.get('STUDIO_UI_EVIDENCE',ROOT.parent/'evidence-ui'));evidence.mkdir(parents=True,exist_ok=True)
    (evidence/'service-worker-results.json').write_text(json.dumps({'checks':checks},indent=2),encoding='utf-8')
    print(f'ALL PASSED: {len(checks)} checks')


if __name__=='__main__': run()
