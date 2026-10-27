"""Focused regression for the real submitted/status/dispatch.status receipt schema.

Reuses only synthetic fixtures. Saves one review-ready screenshot; older inspection packs stay intact.
"""
import json
import os
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from playwright.sync_api import sync_playwright
from picture_review_test import ROOT, Handler, state


def run():
    evidence=Path(os.environ.get('STUDIO_UI_EVIDENCE',ROOT.parent/'evidence-ui')); evidence.mkdir(parents=True,exist_ok=True)
    server=ThreadingHTTPServer(('127.0.0.1',0),partial(Handler,directory=str(ROOT)))
    Thread(target=server.serve_forever,daemon=True).start()
    checks=[]
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(channel='chrome')
            try:
                page=browser.new_context(viewport={'width':600,'height':600},service_workers='block').new_page()
                page.add_init_script('window.STUDIO_LOCAL=true;')
                page.goto(f'http://127.0.0.1:{server.server_port}/');page.wait_for_function('data!==null')
                page.click('#picturesButton');page.wait_for_function('!review.busy')
                page.locator('.picture-button').first.click();page.wait_for_function('!review.busy')
                identity='00000000-0000-4000-a000-000000000001'
                receipt={'id':identity,'assetId':'asset-0','assetVersion':'test-v001','state':'submitted','status':'queued','provider':'auto',
                         'directionId':'synthetic-task-1','dispatch':{'status':'starting','note':'Starting Codex','recipient':'codex'}}
                state['receipts'][identity]=receipt
                page.evaluate('(id)=>{review.draft.pending={reviewId:id,assetId:"asset-0",assetVersion:"test-v001",text:"Synthetic connection check",provider:"auto"};reviewRoute("receipt");}',identity)
                def check(name,ok):
                    checks.append({'name':name,'passed':bool(ok)});print(('PASS ' if ok else 'FAIL ')+name);assert ok,name
                def refresh(): page.click('#checkReceipt');page.wait_for_function('!review.busy')
                refresh()
                check('dispatch starting takes priority over queued/submitted', page.evaluate('receiptState(review.receipt)==="starting"') and page.locator('#reviewText').inner_text().startswith('Starting'))
                check('actual selected recipient and dispatch note are shown', 'Recipient: codex' in page.locator('#reviewText').inner_text() and 'Starting Codex' in page.locator('#reviewText').inner_text())
                for status,label in [('working','Running'),('ready','Review update received'),('review-ready','Needs your review'),('needs-context','Needs more context'),('interrupted','Interrupted'),('waiting','Waiting'),('dispatch-pending','Queued — waiting for an agent')]:
                    receipt['dispatch']['status']=status;receipt['dispatch']['note']='Synthetic status check'
                    refresh()
                    check(f'{status} is reported honestly', page.locator('#reviewText').inner_text().startswith(label) and 'Completed' not in page.locator('#reviewText').inner_text())
                receipt['dispatch'].pop('status');receipt['status']='working';refresh()
                check('top-level status precedes static submitted state', page.locator('#reviewText').inner_text().startswith('Running'))
                receipt['dispatch']['status']='review-ready';receipt['dispatch']['note']='The review summary is ready; no new image was produced.';refresh()
                check('review-ready stops automatic progress polling', page.evaluate('review.statusTimer===0 && receiptState(review.receipt)==="review-ready"'))
                check('review-ready without result image says none was supplied', 'No result picture was supplied' in page.locator('#reviewText').inner_text() and page.locator('#openReviewResult').is_hidden())
                check('actual dispatch note remains visible', 'no new image was produced' in page.locator('#reviewText').inner_text())
                page.screenshot(path=str(evidence/'receipt-no-result-picture-600.png'))
                receipt['dispatch']['status']='ready';receipt['dispatch']['resultAssetId']='asset-9';receipt['dispatch']['note']='A new result picture is ready.';refresh()
                check('nested result asset enables the result action', page.locator('#openReviewResult').is_visible() and page.evaluate('resultAssetId(review.receipt)==="asset-9"'))
                check('nested ready result is identified as a picture', 'Reviewed result picture available' in page.locator('#reviewText').inner_text())
                page.screenshot(path=str(evidence/'receipt-nested-result-ready-600.png'))
                page.click('#openReviewResult');page.wait_for_function('!review.busy')
                check('result action opens and decodes the exact nested asset', page.evaluate('review.loaded && review.asset.id==="asset-9"') and [r for r in state['requests'] if r['c']=='review-open'][-1]['assetId']=='asset-9')
                check('nested result takes priority over legacy top-level result', page.evaluate('resultAssetId({resultAssetId:"old",dispatch:{resultAssetId:"new"}})==="new"'))
                check('legacy top-level result remains supported', page.evaluate('resultAssetId({resultAssetId:"legacy"})==="legacy"'))
            finally:browser.close()
    finally:server.shutdown();server.server_close()
    (evidence/'receipt-progress-results.json').write_text(json.dumps({'checks':checks},indent=2),encoding='utf-8')
    print(f'ALL PASSED: {len(checks)} checks')


if __name__=='__main__':run()
