"""Release regressions: error envelope after durable commit; opaque gallery cursor history."""
import json
import os
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from playwright.sync_api import sync_playwright
from picture_review_test import ROOT, Handler, state


def run():
    evidence=Path(os.environ.get('STUDIO_UI_EVIDENCE',ROOT.parent/'evidence-ui'));evidence.mkdir(parents=True,exist_ok=True)
    server=ThreadingHTTPServer(('127.0.0.1',0),partial(Handler,directory=str(ROOT)));Thread(target=server.serve_forever,daemon=True).start()
    checks=[]
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(channel='chrome')
            try:
                page=browser.new_context(viewport={'width':600,'height':600},service_workers='block').new_page()
                page.add_init_script('window.STUDIO_LOCAL=true;')
                page.goto(f'http://127.0.0.1:{server.server_port}/');page.wait_for_function('data!==null')
                def idle():page.wait_for_function('!review.busy')
                def check(name,ok):checks.append({'name':name,'passed':bool(ok)});print(('PASS ' if ok else 'FAIL ')+name);assert ok,name
                page.click('#picturesButton');idle()
                check('first gallery request omits cursor and raw offset', all('cursor' not in r and 'offset' not in r for r in state['requests'] if r['c']=='review-list'))
                while page.evaluate('review.galleryIndex')<2:
                    page.click('#reviewNext');idle()
                lists=[r for r in state['requests'] if r['c']=='review-list']
                check('next batches use exact opaque cursors', [r.get('cursor') for r in lists]==[None,'opaque-second','opaque-third'] and all('offset' not in r for r in lists))
                check('cursor trail keeps each request independently of display offset', page.evaluate('review.galleryTrail.map(p=>p.cursor).join(",")')==',opaque-second,opaque-third')
                page.locator('.picture-button').first.click();idle();page.click('#reviewBack');page.wait_for_function('review.mode==="gallery"');idle()
                check('Back from a picture restores the originating cursor batch', page.evaluate('review.galleryIndex===2 && review.batch.items[0].id==="asset-24"'))
                page.evaluate('review.batches.clear()')
                page.click('#reviewPrevious');idle()
                lists=[r for r in state['requests'] if r['c']=='review-list']
                check('Previous reloads the saved cursor rather than calculating an offset', lists[-1].get('cursor')=='opaque-second' and 'offset' not in lists[-1])
                state['expired_cursor']='opaque-third';page.evaluate('review.batches.clear()')
                page.click('#reviewNext');idle()
                check('expired cursor resets to a recoverable gallery entry', page.evaluate('review.galleryIndex===0 && review.galleryTrail.length===1') and 'expired' in page.locator('#reviewMessage').inner_text())
                page.click('#reviewRefresh');idle()
                check('Refresh after expiry omits the invalid cursor', page.evaluate('review.batch.items[0].id==="asset-0"') and 'cursor' not in [r for r in state['requests'] if r['c']=='review-list'][-1])
                state['expired_cursor']=None
                page.evaluate('review.start=0;loadPictures(0)');idle();page.locator('.picture-button').first.click();idle()
                state['hide_status']=True
                cases=[{'code':'studio-offline','message':'Your PC has not answered.'},
                       {'code':'validation-error','message':'Ambiguous bridge outcome','uncertain':True},
                       {'code':'http-503','message':'Server reply unavailable'},
                       {'code':'unexpected-reply','message':'Outcome unknown'}]
                for index,error in enumerate(cases):
                    page.click('#giveFeedback');page.fill('#feedbackText',f'Synthetic lost-after-commit check {index}.')
                    page.click('#reviewFeedback');state['error_after_commit']=error
                    before=len(state['receipts']);page.click('#sendFeedback');idle()
                    pending=page.evaluate('review.draft.pending')
                    check(f'{error["code"]} keeps exact pending identity after server commit', bool(pending) and len(state['receipts'])==before+1 and page.evaluate('review.receipt===null'))
                    saved=page.evaluate('JSON.parse(localStorage.getItem(reviewStorageKey()))[review.asset.id].pending')
                    check('uncertain request remains durable and edits are blocked', saved==pending and page.evaluate('!canReview()'))
                    if index==0:
                        page.reload();page.wait_for_function('data!==null');page.click('#picturesButton');idle();page.locator('.picture-button').first.click();idle()
                        check('uncertain identity survives page reload', page.evaluate('review.draft.pending')==pending)
                        page.click('#giveFeedback');idle()
                    page.click('#retryFeedback');idle()
                    posts=[r for r in state['requests'] if r['c']=='review-submit']
                    check('retry preserves review ID, exact picture/version, provider and text', all(posts[-1][k]==posts[-2][k] for k in ['reviewId','assetId','assetVersion','text','provider']))
                    check('retry recovers receipt without duplicate task', len(state['receipts'])==before+1 and page.evaluate('!!review.receipt && !review.draft.pending'))
                    page.evaluate('openPicture("asset-0",false)');idle()
                # A definite validation refusal still releases the pending request for correction.
                page.click('#giveFeedback');page.fill('#feedbackText','Synthetic definite validation rejection.')
                page.click('#reviewFeedback');state['reject']=True
                page.click('#sendFeedback');idle()
                check('definite version rejection keeps editable text and clears pending', page.evaluate('review.draft.pending===null && review.draft.text.includes("definite validation")'))
            finally:browser.close()
    finally:server.shutdown();server.server_close()
    (evidence/'uncertain-cursor-results.json').write_text(json.dumps({'checks':checks,'synthetic_requests':state['requests']},indent=2),encoding='utf-8')
    print(f'ALL PASSED: {len(checks)} checks')


if __name__=='__main__':run()
