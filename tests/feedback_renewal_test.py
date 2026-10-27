"""Persisted terminal receipt renewal; synthetic server + encrypted fake native link only."""
import copy
import json
import os
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from playwright.sync_api import sync_playwright
import navigation_overhaul_test as fixtures

ROOT = fixtures.ROOT
EVIDENCE = Path(os.environ.get('STUDIO_UI_EVIDENCE', ROOT.parent/'feedback-renewal/evidence-ui/v001'))
EVIDENCE.mkdir(parents=True, exist_ok=True)


def run():
    checks=[];errors=[];outside=[]
    server=ThreadingHTTPServer(('127.0.0.1',0),partial(fixtures.Handler,directory=os.environ.get('STUDIO_RENEWAL_BASELINE_ROOT',str(ROOT))))
    Thread(target=server.serve_forever,daemon=True).start();base=f'http://127.0.0.1:{server.server_port}/'
    def check(name,passed):
        checks.append({'name':name,'passed':bool(passed)});print(('PASS ' if passed else 'FAIL ')+name,flush=True);assert passed,name
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(channel='chrome')
            try:
                for status in ['failed','ready','needs-context','interrupted','working','review-ready','uncertain']:
                    current_version='test-v001' if status in ['failed','ready','review-ready'] else 'test-v002'
                    fixtures.state.update(requests=[],receipts={},version=current_version,delay='',uncertain=False,reject=False,hide_status=False)
                    receipt={'id':f'persisted-{status}','assetId':'asset-0','assetVersion':'test-v001','assetTitle':'TEST · Original picture','feedback':'Earlier request kept in Studio.','feedbackExcerpt':'Earlier request kept in Studio.','state':'submitted','provider':'claude','dispatch':{'status':status,'recipient':'claude','note':'Synthetic saved outcome; no result picture.'}}
                    if status=='review-ready':
                        receipt['provider']='codex';receipt['status']='review-ready';receipt['dispatch'].update(recipient='codex',note='Connection check received; no picture change requested')
                    pending={'reviewId':'uncertain-original-id','assetId':'asset-0','assetVersion':'test-v001','text':'Never reset this uncertain request.','provider':'claude'} if status=='uncertain' else None
                    draft={'assetId':'asset-0','assetVersion':'test-v001','title':'TEST · Original picture','text':pending['text'] if pending else receipt['feedback'],'provider':receipt['provider'],'pending':pending,'receipt':None if pending else receipt}
                    other={'assetId':'asset-5','assetVersion':'other-v001','title':'Other draft','text':'Leave this draft alone.','provider':'codex','pending':None,'receipt':None}
                    saved={'asset-0':draft,'asset-5':other}
                    if not pending: fixtures.state['receipts'][receipt['id']]=copy.deepcopy(receipt)
                    context=browser.new_context(viewport={'width':600,'height':600},service_workers='block');page=context.new_page();page.set_default_timeout(8000)
                    page.on('pageerror',lambda e:errors.append(str(e)))
                    page.add_init_script(fixtures.NATIVE)
                    page.add_init_script('if(!localStorage.getItem("sg.review.v1.native-test"))localStorage.setItem("sg.review.v1.native-test",'+json.dumps(json.dumps(saved))+');')
                    def route(r):
                        if 'vendor/mqtt' in r.request.url:r.fulfill(status=200,body='')
                        elif r.request.url.startswith(base):r.continue_()
                        else:outside.append(r.request.url);r.abort()
                    page.route('**/*',route);page.goto(base+'#t=native-test&k=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');page.wait_for_function('data!==null');page.click('#picturesTab');page.wait_for_function('!review.busy');page.locator('#pictureList button').first.click();page.wait_for_function('!review.busy')
                    check(f'{status}: loaded persisted original receipt/draft without clearing it',page.evaluate('review.draft.assetVersion')=='test-v001' and page.evaluate('review.draft.text')==draft['text'])
                    if os.environ.get('STUDIO_RENEWAL_BASELINE'):
                        page.screenshot(path=str(EVIDENCE/'before-original-terminal-600.png'))
                        check('published baseline has no fresh feedback action',page.locator('#newFeedback').count()==0)
                        page.click('#giveFeedback');page.wait_for_function('!review.busy');check('published baseline View feedback only opens old receipt',page.evaluate('navigation.route.kind==="receipt" && review.receipt.id==="persisted-failed"'));break
                    allowed=status in ['failed','ready','needs-context','interrupted','review-ready']
                    check(f'{status}: fresh action follows terminal/pending boundary',page.locator('#newFeedback').is_visible()==allowed)
                    check(f'{status}: version adoption cannot clear a saved or pending request',page.locator('#usePictureVersion').is_hidden())
                    if not allowed:
                        before=page.evaluate('JSON.parse(localStorage.getItem("sg.review.v1.native-test"))')
                        page.locator('#newFeedback').evaluate('(e)=>e.click()')
                        page.locator('#usePictureVersion').evaluate('(e)=>e.click()')
                        check(f'{status}: guarded activation cannot reset protected request',page.evaluate('JSON.parse(localStorage.getItem("sg.review.v1.native-test"))')==before and page.evaluate('navigation.route.kind')=='picture')
                        context.close();continue
                    if status=='failed':
                        page.screenshot(path=str(EVIDENCE/'after-original-terminal-600.png'));page.set_viewport_size({'width':700,'height':360});page.screenshot(path=str(EVIDENCE/'after-original-terminal-700x360.png'));page.set_viewport_size({'width':600,'height':600})
                    if status=='review-ready':
                        page.click('#giveFeedback');page.wait_for_function('!review.busy');check('exact review-ready acknowledgement remains Needs your review with no fabricated result','Needs your review' in page.locator('#reviewText').inner_text() and 'Connection check received; no picture change requested' in page.locator('#reviewText').inner_text() and page.locator('#openReviewResult').is_hidden());page.screenshot(path=str(EVIDENCE/'acknowledgement-receipt-600.png'));page.evaluate('history.back()');page.wait_for_function('navigation.route.kind==="picture"');page.screenshot(path=str(EVIDENCE/'acknowledgement-fresh-action-600.png'))
                    page.click('#newFeedback')
                    check(f'{status}: explicit renewal opens blank exact-current-version editor',page.evaluate('navigation.route.kind==="feedback" && navigation.route.depth===2 && review.draft.text==="" && !review.draft.pending && !review.draft.receipt') and page.evaluate('review.draft.assetVersion')==current_version and page.evaluate('review.draft.provider')==receipt['provider'])
                    check(f'{status}: unrelated local draft and old shared receipt remain',page.evaluate('review.drafts["asset-5"]')==other and fixtures.state['receipts'][receipt['id']]==receipt)
                    page.fill('#feedbackText',f'Fresh feedback after {status}.')
                    page.evaluate('history.back()');page.wait_for_function('navigation.route.kind==="picture"')
                    check(f'{status}: Back preserves fresh draft and picture context',page.evaluate('review.asset.id==="asset-0" && review.draft.text.length>0 && document.activeElement.id==="giveFeedback"'))
                    page.click('#giveFeedback');page.click('#reviewFeedback')
                    if status=='failed':page.screenshot(path=str(EVIDENCE/'fresh-confirmation-600.png'))
                    page.click('#sendFeedback');page.wait_for_function('!review.busy')
                    request=[r for r in fixtures.state['requests'] if r['c']=='review-submit'][-1]
                    check(f'{status}: send uses new durable identity and shown version',request['reviewId']!=receipt['id'] and request['assetVersion']==current_version and request['assetId']=='asset-0' and len(fixtures.state['receipts'])==2)
                    page.evaluate('history.back()');page.wait_for_function('navigation.route.kind==="picture"');page.evaluate('history.back()');page.wait_for_function('navigation.route.kind==="root"');page.click('#feedbackTab');page.wait_for_function('!review.busy')
                    check(f'{status}: shared inbox still exposes original and fresh receipt',page.locator('#feedbackList button').count()==2 and page.locator(f'[data-review-id="{receipt["id"]}"]').count()==1)
                    context.close()
                check('no JavaScript errors',not errors);check('no external network or real broker',not outside)
            finally:browser.close()
    finally:
        server.shutdown();server.server_close()
        (EVIDENCE/('baseline-results.json' if os.environ.get('STUDIO_RENEWAL_BASELINE') else 'renewal-results.json')).write_text(json.dumps({'checks':checks,'errors':errors,'external':outside},indent=2),encoding='utf-8')
    print(f'ALL PASSED: {len(checks)} checks',flush=True)


if __name__=='__main__':run()
