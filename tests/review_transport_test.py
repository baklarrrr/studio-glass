"""Encrypted fake-link review correlation, timeout, and no-offline-queue regression."""
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
                context = browser.new_context(viewport={'width': 600, 'height': 600}, service_workers='block')
                page = context.new_page(); errors = []
                page.on('pageerror', lambda e: errors.append(str(e)))
                page.add_init_script('window.__sent=[];window.__testLink={connected:true,publish(t,b){__sent.push({t,b})},end(){}};')
                page.route('**/*', lambda r: r.fulfill(status=200, body='') if 'vendor/mqtt' in r.request.url else r.continue_() if r.request.url.startswith(base) else r.abort())
                page.goto(base + '#t=synthetic&k=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
                page.wait_for_function('key!==null && helloAt>0')
                def check(name, ok):
                    checks.append({'name':name,'passed':bool(ok)}); print(('PASS ' if ok else 'FAIL ')+name); assert ok, name
                page.evaluate('()=>{window.answer=null;window.error=null;reviewRequest("review-list",{offset:12}).then(v=>window.answer=v).catch(e=>window.error=e.message);}')
                page.wait_for_function('__sent.length>=2')
                request = page.evaluate('openMessage(__sent[__sent.length-1].b)')
                check('review command encrypted on existing paired command topic', page.evaluate('__sent[__sent.length-1].t') == 'bkr/synthetic/c' and request['c'] == 'review-list' and request['offset'] == 12 and len(request['id']) == 36)
                page.evaluate('async m=>handle(await seal(m))', {'t':'review','id':'wrong-request','ok':True,'data':{'items':[]}})
                check('unrelated reply cannot resolve request', page.evaluate('window.answer===null && review.requests.size===1'))
                page.evaluate('async m=>handle(await seal(m))', {'t':'review','id':request['id'],'ok':True,'data':{'items':[],'total':0}})
                check('matching encrypted reply resolves request', page.evaluate('window.answer?.total===0 && review.requests.size===0'))
                check('review reply does not replace studio summary', page.evaluate('data===null'))
                page.evaluate('()=>{window.__testLink.connected=false; window.error=null; reviewRequest("review-submit",{reviewId:crypto.randomUUID(),text:"synthetic"}).catch(e=>window.error=e.message);}')
                page.wait_for_function('window.error!==null')
                check('offline review never enters dashboard outbox', page.evaluate('outbox.length===0 && review.requests.size===0'))
                check('offline failure is explicit', 'Offline' in page.evaluate('window.error'))
                page.clock.install()
                page.evaluate('()=>{window.__testLink.connected=true; window.error=null; reviewRequest("review-status",{assetId:"synthetic"}).catch(e=>window.error=e.message);}')
                page.clock.fast_forward(21000)
                page.wait_for_function('window.error!==null')
                check('unanswered request times out and releases correlation state', 'No reply yet' in page.evaluate('window.error') and page.evaluate('review.requests.size===0'))
                check('review requests are absent from reconnect replay window', page.evaluate('async()=>{const m=await Promise.all(sentLately.map(x=>openMessage(x.body)));return m.every(x=>!x.c.startsWith("review-"))}'))
                check('no JavaScript errors', not errors)
            finally: browser.close()
    finally: server.shutdown(); server.server_close()
    evidence=Path(os.environ.get('STUDIO_UI_EVIDENCE',ROOT.parent/'evidence-ui')); evidence.mkdir(exist_ok=True)
    (evidence/'review-transport-results.json').write_text(json.dumps({'checks':checks},indent=2),encoding='utf-8')
    print(f'ALL PASSED: {len(checks)} checks')


if __name__=='__main__': run()
