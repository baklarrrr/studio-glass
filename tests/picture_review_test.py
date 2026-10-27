"""Synthetic picture/feedback UI test: no broker, real image, account, agent, or user data.

Task-owned loopback server and headless browser close in finally. The fixture is visibly labelled.
"""
import base64
import io
import json
import os
import socket
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from time import time

from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = Path(os.environ.get('STUDIO_UI_EVIDENCE', ROOT.parent / 'evidence-ui'))
EVIDENCE.mkdir(exist_ok=True)
state = {'version': 'test-v001', 'receipts': {}, 'requests': [], 'drop': False, 'hide_status': False, 'reject': False, 'bad_receipt': False, 'error_after_commit': None, 'expired_cursor': None}
fixture = Image.new('RGB', (1200, 800), '#173c43')
d = ImageDraw.Draw(fixture)
d.rectangle((20, 20, 1180, 780), outline='#dfb769', width=12)
d.ellipse((400, 180, 800, 580), fill='#bf7656', outline='#f6e8c8', width=8)
d.text((70, 65), 'SYNTHETIC TEST IMAGE - 1200 x 800', fill='white', font_size=42)
d.text((70, 690), 'Aspect and navigation test only', fill='white', font_size=36)
buf = io.BytesIO(); fixture.save(buf, format='JPEG', quality=85)
PREVIEW = base64.b64encode(buf.getvalue()).decode()


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def respond(self, data, code=200):
        body = json.dumps(data).encode()
        self.send_response(code); self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store'); self.send_header('Content-Length', str(len(body)))
        self.end_headers(); self.wfile.write(body)

    def do_GET(self):
        if self.path == '/local/summary':
            now = int(time() * 1000)
            self.respond({'t': 'studio', 'at': now, 'head': 'Quiet', 'renders': {'items': [], 'details': [], 'ok': True},
                          'aiState': 'live', 'ai': {}, 'cost': {'ok': False}, 'glasses': {'ok': False}})
        else:
            super().do_GET()

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        state['requests'].append(request)
        command = request['c']; data = {}
        if command == 'review-list':
            if request.get('cursor') and request['cursor'] == state['expired_cursor']:
                self.respond({'t':'review','id':request['id'],'ok':False,'error':{'code':'invalid-page','message':'Gallery page expired'}});return
            offset = {'opaque-second':12,'opaque-third':24}.get(request.get('cursor'),0)
            data = {'offset': offset, 'total': 29, 'more': offset + 12 < 29,
                    'nextCursor': {0:'opaque-second',12:'opaque-third'}.get(offset),
                    'items': [{'id': f'asset-{i}', 'title': f'TEST · Surface study {i:02d}', 'width': 1200, 'height': 800, 'mediaType': 'image/jpeg'} for i in range(offset, min(29, offset + 12))]}
        elif command == 'review-open':
            asset_id = request['assetId']
            if asset_id == 'missing':
                self.respond({'t': 'review', 'id': request['id'], 'ok': False, 'error': {'code': 'missing', 'message': 'This picture is unavailable.'}}); return
            data = {'asset': {'id': asset_id, 'title': f'TEST · Surface study {int(asset_id.split("-")[1]):02d}', 'version': state['version'], 'sha256': 'a' * 64,
                              'width': 1200, 'height': 800, 'mediaType': 'image/jpeg'},
                    'preview': {'mime': 'image/jpeg', 'base64': PREVIEW, 'width': 1200, 'height': 800},
                    'reviews': [] if state['hide_status'] else list(state['receipts'].values())}
        elif command == 'review-submit':
            if state['reject'] or request['assetVersion'] != state['version']:
                self.respond({'t': 'review', 'id': request['id'], 'ok': False, 'error': {'code': 'version_changed', 'message': 'This picture changed. Reload it before sending.'}}); return
            review_id = request['reviewId']
            data = state['receipts'].setdefault(review_id, {'id': review_id, 'assetId': request['assetId'], 'assetVersion': request['assetVersion'],
                                                            'state': 'submitted', 'status': 'queued', 'directionId': 'synthetic-task-1', 'provider': request['provider'],
                                                            'dispatch': {'status': 'queued', 'recipient': 'codex' if request['provider'] == 'auto' else request['provider']}})
            if state['drop']:
                state['drop'] = False
                self.connection.shutdown(socket.SHUT_RDWR); self.connection.close(); return
            if state['bad_receipt']:
                data = dict(data, assetVersion='wrong-version')
            if state['error_after_commit']:
                error=state['error_after_commit'];state['error_after_commit']=None
                self.respond({'t':'review','id':request['id'],'ok':False,'error':error});return
        elif command == 'review-status':
            data = {'reviews': [] if state['hide_status'] else list(state['receipts'].values())}
        self.respond({'t': 'review', 'id': request['id'], 'ok': True, 'data': data})


def run():
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
    Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}/'
    checks = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(channel='chrome')
            try:
                context = browser.new_context(viewport={'width': 600, 'height': 600}, service_workers='block')
                page = context.new_page(); errors, outside = [], []
                page.on('pageerror', lambda err: errors.append(str(err)))
                page.add_init_script('window.STUDIO_LOCAL=true;')
                def route(r):
                    if 'vendor/mqtt.min.js' in r.request.url:
                        r.fulfill(status=200, content_type='text/javascript', body='window.mqtt={connect(){throw Error("real MQTT prohibited")}};')
                    elif r.request.url.startswith(base): r.continue_()
                    else: outside.append(r.request.url); r.abort()
                page.route('**/*', route)
                page.goto(base); page.wait_for_function('data !== null && stateInfo().live')
                def check(name, ok):
                    print(('PASS ' if ok else 'FAIL ') + name)
                    checks.append({'name': name, 'passed': bool(ok)}); assert ok, name
                def idle(): page.wait_for_function('!review.busy')
                def shot(name):
                    if not os.environ.get('STUDIO_UI_SKIP_SCREENSHOTS'): page.screenshot(path=str(EVIDENCE / (name + '.png')))
                def fits():
                    return page.evaluate('''() => {
                      const screen=$('reviewScreen'), controls=visibleControls();
                      const content=$('reviewContent'), form=$('feedbackForm');
                      return screen.scrollHeight<=screen.clientHeight+1 && document.documentElement.scrollWidth<=innerWidth &&
                        (review.mode!=='compose'||form.scrollHeight<=content.clientHeight+1) &&
                        (!['confirm','receipt'].includes(review.mode)||$('reviewText').scrollHeight<=content.clientHeight+1) &&
                        controls.every(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1});
                    }''')
                check('local mode works without pairing or MQTT', page.evaluate('key===null && links.length===0 && stateInfo().live'))
                page.click('#picturesButton'); idle()
                check('gallery requests 12 and exposes real titles', page.locator('.picture-button').count() > 0 and page.evaluate('review.batch.items.length') == 12)
                shot('review-gallery-600')
                seen = set()
                for _ in range(20):
                    seen.update(page.locator('.picture-button').evaluate_all('(els)=>els.map(el=>el.dataset.assetId)'))
                    if page.locator('#reviewNext').is_disabled(): break
                    page.keyboard.press('ArrowRight'); idle()
                check('all 29 gallery records reachable across remote batches', len(seen) == 29)
                page.evaluate('review.start=0; loadPictures(0)'); idle()
                page.locator('.picture-button').first.click(); idle()
                check('image decode required before feedback is enabled', page.evaluate('review.loaded && $("renderPicture").naturalWidth === 1200 && !$("giveFeedback").disabled'))
                check('picture preserves aspect with contain', page.evaluate('getComputedStyle($("renderPicture")).objectFit === "contain"'))
                shot('review-picture-600')
                page.click('#zoomPicture'); page.keyboard.press('ArrowRight')
                check('D-pad pans the zoomed image', page.evaluate('review.zoom && review.panX < 0'))
                page.keyboard.press('Escape')
                check('Escape restores fit before leaving picture', page.evaluate('!review.zoom && review.mode === "picture"'))
                page.click('#giveFeedback')
                page.fill('#feedbackText', 'Please soften the highlight and keep the label readable.')
                page.keyboard.press('Enter'); page.keyboard.type('Keep the camera framing.')
                page.keyboard.press('ArrowLeft'); page.keyboard.press('Backspace')
                check('textarea keeps native Enter and editing keys', page.evaluate('review.mode === "compose" && review.draft.text.includes("\\n") && document.activeElement.id === "feedbackText"'))
                page.click('[data-provider="claude"]')
                check('provider choice is explicit', page.evaluate('review.draft.provider === "claude"'))
                shot('review-compose-600')
                page.click('#reviewFeedback')
                check('review shows picture version, recipient and text', page.evaluate('review.textPages.join("").includes("test-v001") && review.textPages.join("").includes("Claude") && review.textPages.join("").includes("Please soften")'))
                check('confirmation states that Send starts a new task', 'Starts a new Claude task with this picture and context.' in page.evaluate('review.textPages.join("")'))
                shot('review-confirm-600')
                check('no submit occurs before Send', not any(r['c'] == 'review-submit' for r in state['requests']))
                page.click('#sendFeedback'); idle()
                check('only durable matching receipt confirms queued', page.evaluate('receiptState(review.receipt) === "queued" && review.receipt.state === "submitted" && review.draft.pending === null'))
                check('submission binds exact displayed asset version', next(r for r in state['requests'] if r['c'] == 'review-submit')['assetVersion'] == 'test-v001')
                shot('review-receipt-600')
                receipt = next(iter(state['receipts'].values())); receipt['status'] = receipt['dispatch']['status'] = 'working'
                page.click('#checkReceipt'); idle()
                check('progress distinguishes running from queued', 'Running' in page.locator('#reviewText').inner_text())
                receipt['status'] = receipt['dispatch']['status'] = 'completed'
                page.click('#checkReceipt'); idle()
                check('progress reports completed only from backend state', 'Completed' in page.locator('#reviewText').inner_text())
                # Browser Back restores confirm, then composer, then picture without dropping draft.
                page.go_back(); page.wait_for_function('review.mode === "confirm"')
                check('unchanged confirmed feedback cannot create another task', page.locator('#sendFeedback').is_disabled())
                page.go_back(); page.wait_for_function('review.mode === "compose"')
                check('browser history preserves draft and provider', page.evaluate('review.draft.provider === "claude" && review.draft.text.startsWith("Please soften")'))
                page.fill('#feedbackText', 'Second feedback with an uncertain reply.')
                page.click('#reviewFeedback')
                state['drop'] = True; state['hide_status'] = True
                page.click('#sendFeedback'); idle()
                check('lost reply stays unconfirmed with locked exact request', page.evaluate('!!review.draft.pending && !review.receipt'))
                pending = page.evaluate('review.draft.pending')
                shot('review-uncertain-600')
                page.click('#retryFeedback'); idle()
                posts = [r for r in state['requests'] if r['c'] == 'review-submit']
                check('uncertain retry reuses review ID and exact text', posts[-1]['reviewId'] == posts[-2]['reviewId'] and posts[-1]['text'] == posts[-2]['text'] == pending['text'])
                check('retry creates no duplicate task', len(state['receipts']) == 2)
                state['hide_status'] = False
                # Reload retains receipts/drafts locally; image must be loaded again before another send.
                page.reload(); page.wait_for_function('data!==null')
                page.click('#picturesButton'); idle(); page.locator('.picture-button').first.click(); idle()
                check('draft and durable receipt survive page reload', page.evaluate('review.draft.text === "Second feedback with an uncertain reply." && !!review.draft.receipt'))
                state['version'] = 'test-v002'
                page.click('#reviewRefresh'); idle()
                page.click('#giveFeedback')
                check('changed picture keeps old draft version and blocks review', page.evaluate('review.draft.assetVersion === "test-v001" && $("reviewFeedback").disabled'))
                check('changed-version compose names retained draft and displayed picture separately', 'Feedback version test-v001' in page.locator('#reviewIdentity').inner_text() and 'Picture shown: test-v002' in page.locator('#reviewIdentity').inner_text() and 'earlier version' in page.locator('#reviewMessage').inner_text())
                shot('review-version-changed-600')
                page.click('#checkReceipt'); idle()
                check('receipt keeps the submitted version after picture changes', 'Feedback version test-v001' in page.locator('#reviewIdentity').inner_text() and 'Picture shown: test-v002' in page.locator('#reviewIdentity').inner_text())
                shot('review-receipt-old-version-600')
                page.go_back(); page.wait_for_function('review.mode === "compose"')
                page.click('#usePictureVersion')
                check('explicit version selection keeps text and binds latest', page.evaluate('review.draft.assetVersion === "test-v002" && review.draft.text.startsWith("Second feedback")'))
                page.fill('#feedbackText', 'Third feedback that will be rejected.')
                page.click('#reviewFeedback'); state['reject'] = True
                page.click('#sendFeedback'); idle()
                check('version rejection keeps draft without a success receipt', page.evaluate('!review.loaded && !review.receipt && review.draft.text.includes("Third feedback")'))
                state['reject'] = False
                page.evaluate('openPicture("asset-0",false)'); idle()
                page.click('#giveFeedback')
                page.fill('#feedbackText', 'Check exact receipt identity.')
                page.click('#reviewFeedback'); state['bad_receipt'] = True
                page.click('#sendFeedback'); idle()
                check('wrong-version receipt cannot confirm success', page.evaluate('!!review.draft.pending && !review.receipt'))
                state['bad_receipt'] = False
                page.click('#checkReceipt'); idle()
                check('status can recover the matching durable receipt', page.evaluate('!!review.receipt && !review.draft.pending'))
                page.evaluate('openPicture("asset-0",false)'); idle()
                # Responsive picture and compose screens, including short landscape.
                for width, height in [(600, 600), (360, 700), (700, 360)]:
                    page.set_viewport_size({'width': width, 'height': height}); page.wait_for_timeout(100)
                    check(f'picture controls fit {width}x{height}', fits())
                    shot(f'review-picture-{width}x{height}')
                    page.click('#giveFeedback')
                    page.fill('#feedbackText', ('Please keep the camera framing and soften the highlight. ' * 38)[:2000])
                    check(f'composer controls fit {width}x{height}', fits())
                    shot(f'review-compose-{width}x{height}')
                    page.click('#reviewFeedback')
                    check(f'confirmation controls fit {width}x{height}', fits())
                    check('confirmation pagination retains all text', page.evaluate('review.textPages.join("").includes(review.draft.text)'))
                    check('long feedback stays capped at 2000 characters', page.evaluate('review.draft.text.length===2000 && review.textPages.length>1'))
                    for _ in range(page.evaluate('review.textPages.length')):
                        check(f'long feedback page fits {width}x{height}', fits())
                        page.keyboard.press('ArrowRight')
                    shot(f'review-confirm-{width}x{height}')
                    page.evaluate('openPicture("asset-0",false)'); idle()
                page.evaluate('openPicture("missing",false)'); idle()
                check('missing image never enables feedback', page.evaluate('!review.loaded && $("giveFeedback").hidden'))
                check('all request correlation IDs are UUIDs', all(len(r.get('id', '')) == 36 for r in state['requests']))
                check('no page errors', not errors)
                check('no external network attempts', not outside)
                (EVIDENCE / 'picture-review-results.json').write_text(json.dumps({'checks': checks, 'errors': errors, 'external_requests': outside, 'synthetic_requests': state['requests']}, indent=2), encoding='utf-8')
            finally: browser.close()
    finally: server.shutdown(); server.server_close()
    print(f'ALL PASSED: {len(checks)} checks')


if __name__ == '__main__': run()
