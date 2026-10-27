"""Read-only drilldown checks, using synthetic data and a task-owned loopback server.

No broker or production relay is contacted. Every browser/server closes in finally.
Screenshots go to the task's evidence directory, never a public bundle.
"""
import json
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT.parent / 'evidence'
EVIDENCE.mkdir(exist_ok=True)


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def run():
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=str(ROOT)))
    Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}/'
    checks = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(channel='chrome')
            try:
                context = browser.new_context(viewport={'width': 600, 'height': 600}, service_workers='block')
                page = context.new_page()
                errors, external = [], []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.add_init_script('window.__sent=[]; window.__testLink={connected:true,publish(t,b){__sent.push(b)},end(){}};')

                def route(request):
                    if 'vendor/mqtt.min.js' in request.request.url:
                        request.fulfill(status=200, content_type='text/javascript', body='')
                    elif request.request.url.startswith(base):
                        request.continue_()
                    else:
                        external.append(request.request.url)
                        request.abort()

                page.route('**/*', route)
                page.goto(base + 'index.html#t=synthetic&k=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
                page.wait_for_function('key !== null && helloAt > 0')

                def check(name, ok):
                    checks.append({'name': name, 'passed': bool(ok)})
                    print(('PASS ' if ok else 'FAIL ') + name)
                    assert ok, name

                def text(selector):
                    return page.locator(selector).text_content()

                def feed(records, **over):
                    now = page.evaluate('Date.now()')
                    records = [dict(it) for it in records]
                    renders = {'ok': True, 'running': sum(it['st'] == 'running' for it in records),
                               'attention': sum(it['st'] == 'attention' for it in records), 'queued': 4,
                               'items': records[:6], 'more': max(0, len(records) - 6), 'details': records, 'omitted': 0}
                    renders.update(over.pop('renders', {}))
                    msg = {'t': 'studio', 'at': now, 're': page.evaluate('helloAt'), 'head': 'Needs your eyes',
                           'renders': renders, 'ai': {'Codex': 2, 'Claude': 1}, 'aiState': 'live',
                           'cost': {'ok': True, 'todayCad': 12.34, 'monthCad': 26569},
                           'glasses': {'ok': True, 'st': 'connected', 'fresh': True, 'bat': 47, 'rep': now - 120000}}
                    msg.update(over)
                    page.evaluate('async m => { await handle(await seal(m)); }', msg)

                def fits():
                    return page.evaluate('''() => {
                      const body=$('jobBody'), content=view.screen==='detail'?$('detailText'):$('jobList');
                      const controls=visibleControls();
                      return content.scrollHeight <= body.clientHeight + 1 && document.documentElement.scrollWidth<=innerWidth &&
                        controls.every(el=>{const r=el.getBoundingClientRect(); return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight});
                    }''')

                check('waiting dashboard has no dead focus targets', page.evaluate('visibleControls().length === 0'))
                reason = ('The output file was not found after the worker stopped. Check the saved render path and the last completed frame. ' * 9) + 'END-OF-REASON'
                jobs = [dict(id=f'job-{i}', ti=f'TEST · Render {i:02d}', st='attention' if i < 3 else 'running',
                             pct=None if i < 3 else i * 3, since=page.evaluate('Date.now()') - 720000,
                             why='Output missing' if i < 3 else '', detail=reason if i == 0 else 'The job is running.' if i >= 3 else 'Output missing.',
                             source='Render queue') for i in range(12)]
                jobs[0]['ti'] = 'TEST · Surface study'
                jobs[1]['ti'] = 'TEST · Lighting comparison'
                jobs[2]['ti'] = 'TEST · Product turntable'
                jobs[3]['ti'] = 'TEST · Close-up'
                jobs[4]['ti'] = 'TEST · Wide angle'
                jobs[0]['why'] = 'Output missing — inspect the saved render path'
                jobs[1]['why'] = 'Render ended before every frame was saved'
                jobs[2]['why'] = 'Worker stopped during the render'
                jobs[3]['pct'] = 42
                jobs[4]['pct'] = 68
                feed(jobs[:5], renders={'more': 1})
                check('first summary focuses the actionable headline', page.evaluate('document.activeElement.id === "headCard"'))
                check('dashboard only actionable cards can focus', page.evaluate('visibleControls().map(el=>el.id).join(",")') == 'headCard,rendersBlock')
                check('dashboard rows stay above the bottom padding', page.evaluate('''() => {const b=$('rendersBlock'), s=getComputedStyle(b);return $('renderList').getBoundingClientRect().bottom <= b.getBoundingClientRect().bottom - parseFloat(s.paddingBottom) - parseFloat(s.borderBottomWidth) + 1;}'''))
                page.focus('#headCard')
                page.screenshot(path=str(EVIDENCE / 'candidate-dashboard-600.png'))
                feed(jobs)
                page.keyboard.press('Enter')
                check('headline opens attention-only jobs', page.evaluate('view.screen === "list" && view.filter === "attention" && view.listPages.flat().every(it=>it.st === "attention")'))
                check('list focuses an actionable job', page.evaluate('document.activeElement.classList.contains("job-button")'))
                page.screenshot(path=str(EVIDENCE / 'candidate-attention-list-600.png'))
                page.keyboard.press('Enter')
                check('Enter opens selected job details', page.evaluate('view.screen === "detail" && view.selected.key === "id:job-0"'))
                page.evaluate('document.dispatchEvent(new KeyboardEvent("keydown", {key:"Enter", repeat:true, bubbles:true, cancelable:true}))')
                check('held Enter does not activate the next screen', page.evaluate('view.screen === "detail" && view.detailPage === 0'))
                check('full reason spans readable pages without lost text', page.evaluate('view.detailPages.join("") === view.detailText && view.detailPages.length > 1') and reason in page.evaluate('view.detailText'))
                page.screenshot(path=str(EVIDENCE / 'candidate-job-detail-600.png'))
                count = page.evaluate('view.detailPages.length')
                for _ in range(count - 1):
                    check('detail page remains within viewport', fits())
                    page.keyboard.press('ArrowRight')
                check('D-pad reaches final reason text', 'END-OF-REASON' in page.evaluate('view.detailPages.join("")') and page.evaluate('view.detailPage === view.detailPages.length - 1'))
                check('last detail page fits', fits())
                check('job identity remains visible on continuation pages', text('#jobHeading') == jobs[0]['ti'])
                page.screenshot(path=str(EVIDENCE / 'candidate-job-detail-last-600.png'))
                page.keyboard.press('ArrowLeft')
                check('left arrow moves to previous detail page', page.evaluate('view.detailPage === view.detailPages.length - 2'))
                before_page = page.evaluate('view.detailPage')
                jobs[0]['pct'] = 7
                feed(jobs)
                check('metadata refresh preserves reading page', page.evaluate('view.detailPage') == before_page)
                page.keyboard.press('Backspace')
                check('Backspace returns to the same job', page.evaluate('view.screen === "list" && document.activeElement.dataset.jobKey === "id:job-0"'))
                page.keyboard.press('Escape')
                check('Escape returns to attention headline', page.evaluate('view.screen === "dashboard" && document.activeElement.id === "headCard"'))
                page.keyboard.press('ArrowDown')
                page.keyboard.press('Enter')
                check('Renders opens all supplied jobs', page.evaluate('view.filter === "all" && view.listPages.flat().length === 12'))
                check('unknown waiting details stay a count', '4 waiting; details unavailable' in text('#jobContext'))
                reached = set()
                for i in range(page.evaluate('view.listPages.length')):
                    reached.update(page.evaluate('view.listPages[view.listPage].map(it=>it.id)'))
                    check('list page remains within viewport', fits())
                    page.keyboard.press('ArrowRight')
                check('all supplied jobs reachable with D-pad paging', len(reached) == 12)
                page.keyboard.press('Enter')
                selected = page.evaluate('view.selected.key')
                feed(list(reversed(jobs)))
                check('reordered refresh preserves selected identity', page.evaluate('view.selected.key') == selected)
                selected_id = selected.removeprefix('id:')
                feed([it for it in jobs if it['id'] != selected_id])
                check('missing selected job is explicit', 'No longer in this report' in page.evaluate('view.detailText') and 'current state is unknown' in page.evaluate('view.detailText'))
                check('missing state does not substitute another job', page.evaluate('view.selected.key') == selected)
                page.screenshot(path=str(EVIDENCE / 'candidate-missing-job-600.png'))
                feed(jobs)
                check('same returning identity recovers', 'No longer in this report' not in page.evaluate('view.detailText'))
                page.click('#refreshButton')
                sent = page.evaluate('async()=>Promise.all(__sent.map(openMessage))')
                check('only existing hello command used for refresh', len(sent) >= 2 and all(m['c'] == 'hello' for m in sent))
                page.evaluate('helloAt=Date.now()-11000; prevHelloAt=answeredRe=helloAt-120000; render()')
                check('stale detail retains connection warning', text('#stateText').startswith('PC not answering') and page.evaluate('document.body.classList.contains("stale")'))
                check('stale detail explicitly describes saved status', text('#jobContext').startswith('Saved status:'))
                check('stale essential text stays bright', page.evaluate('getComputedStyle($("jobBody")).opacity === "1" && getComputedStyle($("jobContext")).opacity === "1"'))
                page.screenshot(path=str(EVIDENCE / 'candidate-stale-detail-600.png'))
                page.keyboard.press('Escape')
                page.keyboard.press('Escape')
                many = [dict(id=f'many-{i}', ti=f'TEST · Job {i}', st='queued' if i == 47 else 'running', pct=i, source='Managed render') for i in range(48)]
                feed(many, renders={'omitted': 11, 'queued': 1})
                page.click('#rendersBlock')
                check('48 supplied jobs retained and omitted count explicit', page.evaluate('view.listPages.flat().length === 48') and '11 more unavailable here' in text('#jobContext'))
                check('supplied queued identity stays an actual selectable job', page.evaluate('view.listPages.flat().some(it=>it.id==="many-47"&&it.st==="queued")'))
                all_keys = set()
                for _ in range(page.evaluate('view.listPages.length')):
                    all_keys.update(page.evaluate('view.listPages[view.listPage].map(it=>it.id)'))
                    page.keyboard.press('ArrowRight')
                check('every one of 48 jobs can be reached', len(all_keys) == 48)
                page.keyboard.press('Escape')
                legacy = [dict(ti='TEST · Legacy job', st='attention', why='Only the short reason was sent')]
                page.evaluate('hello()')
                feed(legacy, renders={'details': None, 'more': 8, 'queued': 0})
                page.click('#rendersBlock')
                check('old relay says more records unavailable', '8 more unavailable here' in text('#jobContext'))
                page.keyboard.press('Enter')
                old = page.evaluate('view.detailText')
                check('legacy reason and identity limits are explicit', 'full reason was not supplied' in old and 'identity not supplied' in old)
                check('saved legacy report has visible time', 'Saved report:' in text('#jobContext') and 'time unavailable' not in text('#jobContext'))
                check('live connection does not imply legacy detail refreshed', text('#stateText') == 'Live' and text('#jobContext').startswith('Saved status:'))
                feed([dict(ti='TEST · Different legacy job', st='running', pct=44)], renders={'details': None})
                check('legacy selection never silently becomes another job', page.evaluate('view.detailText') == old)
                page.screenshot(path=str(EVIDENCE / 'candidate-legacy-detail-600.png'))
                page.keyboard.press('Escape')
                page.keyboard.press('Escape')
                long_job = dict(id='long-job', ti='TEST · ' + 'Long product study title ' * 7, st='attention',
                                detail='x' * 1200, why='', source='Managed render', detailTruncated=True)
                feed([long_job], renders={'queued': 0, 'omitted': 6})
                page.click('#headCard')
                page.keyboard.press('Enter')
                check('full provided long title survives pagination', long_job['ti'] in page.evaluate('view.detailPages.join("")'))
                check('truncated relay reason is labelled', 'relay shortened this reason' in page.evaluate('view.detailText'))
                for size in [(600, 600), (390, 600), (600, 480)]:
                    page.set_viewport_size({'width': size[0], 'height': size[1]})
                    page.wait_for_timeout(100)
                    page.evaluate('view.detailPage=0; renderJobs()')
                    for _ in range(page.evaluate('view.detailPages.length')):
                        check(f'unbroken detail fits {size[0]}x{size[1]}', fits())
                        page.keyboard.press('ArrowRight')
                    check('pagination preserves all supplied text after resize', page.evaluate('view.detailPages.join("") === view.detailText'))
                page.set_viewport_size({'width': 600, 'height': 600})
                page.keyboard.press('Escape')
                page.keyboard.press('Escape')
                feed([], head='Quiet', renders={'queued': 0})
                page.click('#headCard')
                check('quiet headline opens honest empty list', page.evaluate('view.filter === "all"') and 'No individual render jobs' in text('#jobEmpty'))
                check('empty list has no disabled pager in focus order', page.evaluate('visibleControls().map(el=>el.id).join(",")') == 'backButton,refreshButton')
                check('no JavaScript errors', not errors)
                check('no external network attempted', not external)
                (EVIDENCE / 'navigation-results.json').write_text(json.dumps({'checks': checks, 'errors': errors, 'external_requests': external}, indent=2), encoding='utf-8')
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()
    print(f'ALL PASSED: {len(checks)} checks')


if __name__ == '__main__':
    run()
