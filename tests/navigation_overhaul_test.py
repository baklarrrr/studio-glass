"""Native-contract sequence checks. Synthetic loopback only; browser/server close in finally.

Native mode uses an encrypted fake MQTT link, never STUDIO_LOCAL. Browser history is the
native-Back equivalent; real gesture/composer/optical behavior still requires glasses.
"""
import json
import os
import socket
import time
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
from threading import Thread

from playwright.sync_api import sync_playwright
import picture_review_test as fixtures

ROOT = fixtures.ROOT
EVIDENCE = Path(os.environ.get('STUDIO_UI_EVIDENCE', ROOT.parent/'navigation-overhaul/evidence-ui/candidate-v001'))
EVIDENCE.mkdir(parents=True, exist_ok=True)
state = {'requests': [], 'receipts': {}, 'version': 'test-v001', 'delay': '', 'uncertain': False, 'reject': False, 'hide_status': False}


class Handler(fixtures.Handler):
    def do_GET(self):
        if self.path == '/local/summary':
            now = int(time.time()*1000)
            items = [{'id': f'job-{i}', 'ti': f'TEST render job {i:02d}', 'st':'attention', 'detail':('A supplied reason. '*100), 'source':'Render queue'} for i in range(12)]
            self.respond({'t':'studio','at':now,'head':'Needs your eyes','renders':{'items':items[:3],'details':items,'attention':12,'ok':True},'aiState':'live','ai':{'Codex':1},'cost':{'ok':False},'glasses':{'ok':False}})
        else: super().do_GET()

    def do_POST(self):
        request=json.loads(self.rfile.read(int(self.headers['Content-Length'])));state['requests'].append(request)
        command=request['c'];data={}
        if state['delay']==command: time.sleep(1.0)
        if command=='review-list':
            offset={'cursor-two':12,'cursor-three':24}.get(request.get('cursor'),0)
            data={'items':[{'id':f'asset-{i}','title':f'TEST · Surface study {i:02d}','width':1200,'height':800,'mediaType':'image/jpeg'} for i in range(offset,min(offset+12,29))], 'offset':offset,'total':29,'nextCursor':{0:'cursor-two',12:'cursor-three'}.get(offset),'more':offset<24}
        elif command=='review-open':
            asset=request['assetId']
            data={'asset':{'id':asset,'title':f'TEST · Surface study {asset.split("-")[-1]}','version':state['version'],'sha256':'a'*64,'width':1200,'height':800,'mediaType':'image/jpeg'},'preview':{'mime':'image/jpeg','base64':fixtures.PREVIEW},'reviews':list(state['receipts'].values())}
        elif command=='review-submit':
            if state['reject'] or request['assetVersion']!=state['version']:
                self.respond({'t':'review','id':request['id'],'ok':False,'error':{'code':'version-changed','message':'Picture version changed. Refresh the picture.'}});return
            receipt={'id':request['reviewId'],'assetId':request['assetId'],'assetVersion':request['assetVersion'],'assetTitle':'TEST · Bound picture','feedback':request['text'],'feedbackExcerpt':request['text'][:50],'provider':request['provider'],'state':'submitted','status':'queued','dispatch':{'status':'queued','recipient':'codex' if request['provider']=='auto' else request['provider']}}
            data=state['receipts'].setdefault(request['reviewId'],receipt)
            if state['uncertain']:
                state['uncertain']=False
                self.respond({'t':'review','id':request['id'],'ok':False,'error':{'code':'studio-offline','uncertain':True,'message':'Response lost after possible commit.'}});return
        elif command=='review-status':
            data={'reviews':[r for r in state['receipts'].values() if r['assetId']==request['assetId'] and (not request.get('reviewId') or r['id']==request['reviewId'])]}
            if state['hide_status']: data={'reviews':[]}
        elif command=='review-inbox':
            data={'reviews':list(state['receipts'].values()),'total':len(state['receipts']),'offset':0,'more':False,'nextCursor':None,'snapshotAt':int(time.time()*1000),'coverage':'Recent saved feedback from Studio.'}
        self.respond({'t':'review','id':request['id'],'ok':True,'data':data})


NATIVE = '''window.__testLink={connected:true,end(){},async publish(topic,body){
  const request=await openMessage(body); if(request.c==='bye')return;
  const isReview=request.c.startsWith('review-');
  const response=await fetch(isReview?'/local/review':'/local/summary',isReview?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)}:{});
  const message=await response.json();if(!isReview)message.re=request.ts;
  await handle(await seal(message));
}};'''


def run():
    checks=[]; errors=[]; external=[]
    server=ThreadingHTTPServer(('127.0.0.1',0),partial(Handler,directory=str(ROOT)))
    Thread(target=server.serve_forever,daemon=True).start();base=f'http://127.0.0.1:{server.server_port}/'
    def check(name,passed):
        checks.append({'name':name,'passed':bool(passed)});print(('PASS ' if passed else 'FAIL ')+name,flush=True);assert passed,name
    try:
        with sync_playwright() as pw:
            browser=pw.chromium.launch(channel='chrome')
            try:
                def setup(local=False,size=(600,600)):
                    context=browser.new_context(viewport={'width':size[0],'height':size[1]},service_workers='block')
                    page=context.new_page();page.set_default_timeout(8000);page.on('pageerror',lambda e:errors.append(str(e)))
                    page.add_init_script('window.STUDIO_LOCAL=true;' if local else NATIVE)
                    def route(r):
                        if 'vendor/mqtt' in r.request.url:r.fulfill(status=200,body='')
                        elif r.request.url.startswith(base):r.continue_()
                        else:external.append(r.request.url);r.abort()
                    page.route('**/*',route);page.goto(base+('' if local else '#t=native-test&k=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'));page.wait_for_function('data!==null && stateInfo().live');return page
                page=setup()
                def idle():page.wait_for_function('!review.busy')
                def kind(value):page.wait_for_function('(kind)=>navigation.route.kind===kind',arg=value)
                def back():page.evaluate('history.back()');page.wait_for_timeout(80)
                def shot(name):page.screenshot(path=str(EVIDENCE/(name+'.png')))
                check('native mode has no desktop controls',page.locator('#desktopBack').is_hidden() and page.locator('#finishEditing').is_hidden())
                page.focus('#picturesTab');page.evaluate('()=>{const summary=data;data=null;acceptSummary({...summary,at:Date.now()})}');check('first summary does not move existing focus',page.evaluate('document.activeElement.id')=='picturesTab')
                check('dashboard actions are semantic buttons',page.locator('#headCard').evaluate('(e)=>e.tagName')=='BUTTON' and page.locator('#rendersBlock').evaluate('(e)=>e.tagName')=='BUTTON')
                page.focus('#headCard');page.keyboard.press('Enter');kind('jobs')
                check('native Enter activates dashboard exactly once',page.evaluate('navigation.route.depth===1'))
                page.keyboard.down('Enter');page.keyboard.down('Enter');page.keyboard.up('Enter');check('job-list entry focus cannot repeat into Refresh',page.evaluate('document.activeElement.id==="jobBody" && navigation.route.kind==="jobs"'))
                page.locator('.job-button').nth(4).click();kind('job');check('job detail is actual history entry',page.evaluate('navigation.route.depth===2'))
                page.locator('#jobBody').evaluate('(e)=>e.scrollTop=150');before=page.locator('#jobBody').evaluate('(e)=>e.scrollTop')
                page.evaluate('acceptSummary({...data,at:Date.now(),re:helloAt})');check('summary preserves job reading position',page.locator('#jobBody').evaluate('(e)=>e.scrollTop')==before)
                back();kind('jobs');check('native Back restores selected job',page.evaluate('document.activeElement.dataset.jobKey')=='id:job-4')
                back();kind('root');page.click('#picturesTab');idle()
                check('root peers share initial entry',page.evaluate('navigation.route.depth===0'))
                check('gallery has12 scrollable real record controls',page.locator('#pictureList button').count()==12 and page.evaluate('$('+'"reviewContent"'+').scrollHeight>$('+'"reviewContent"'+').clientHeight'))
                page.locator('#pictureList button').nth(7).focus();page.locator('#pictureList button').nth(7).scroll_into_view_if_needed();selected_scroll=page.locator('#reviewContent').evaluate('(e)=>e.scrollTop')
                page.set_viewport_size({'width':600,'height':560});page.wait_for_timeout(80);check('resize keeps selected picture focus',page.evaluate('document.activeElement.dataset.assetId')=='asset-7');page.set_viewport_size({'width':600,'height':600})
                check('ordinary glasses arrows are not intercepted',page.evaluate('()=>{const e=new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true,cancelable:true});document.activeElement.dispatchEvent(e);return !e.defaultPrevented}'))
                check('glasses Escape is not a Back alias',page.evaluate('()=>{const e=new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true});document.activeElement.dispatchEvent(e);return !e.defaultPrevented&&navigation.route.depth===0}'))
                page.locator('#pictureList button').nth(7).click();idle();kind('picture');check('picture loads exact requested identity',page.evaluate('review.loaded && review.asset.id==="asset-7" && $("renderPicture").naturalWidth===1200'))
                shot('picture-native-600');page.focus('#zoomPicture');page.keyboard.down('Enter');kind('inspect');page.keyboard.down('Enter');page.keyboard.up('Enter');check('held Select does not immediately exit Inspect',page.evaluate('navigation.route.kind==="inspect"'));page.keyboard.press('ArrowRight');check('only explicit Inspect captures pan',page.evaluate('review.panX<0 && navigation.route.depth===2'));shot('inspect-native-600');back();kind('picture');check('Back from Inspect restores action focus',page.evaluate('document.activeElement.id')=='zoomPicture')
                back();kind('root');check('Back restores gallery identity and scroll',page.evaluate('document.activeElement.dataset.assetId')=='asset-7' and page.locator('#reviewContent').evaluate('(e)=>e.scrollTop')>=selected_scroll-10)
                page.click('#feedbackTab');idle();page.click('#picturesTab');idle();check('root peer switch retains selected picture',page.evaluate('document.activeElement.dataset.assetId')=='asset-7')
                page.click('#feedbackTab');idle();check('empty peer restores its own tab focus',page.evaluate('document.activeElement.id')=='feedbackTab');page.click('#picturesTab');idle()
                page.click('#reviewNext');idle();check('next gallery uses opaque cursor',state['requests'][-1].get('cursor')=='cursor-two');check('page load keeps a visible nonactivating focus target',page.evaluate('document.activeElement.id==="reviewContent"'));page.click('#reviewPrevious');idle();check('previous gallery restores firstbatch without rawoffset',not any('offset'in r for r in state['requests'] if r['c']=='review-list'))
                # Delayed request cannot change or focus the route after native Back.
                state['delay']='review-open';page.locator('#pictureList button').first.click();back();kind('root');check('Back leaves loading picture immediately',page.locator('#pictureList').is_visible());page.wait_for_timeout(1150);check('late image cannot rewrite root',page.evaluate('navigation.route.depth===0 && review.mode==="gallery"'));state['delay']=''
                page.locator('#pictureList button').first.click();idle();page.click('#giveFeedback');kind('feedback');page.fill('#feedbackText','Please soften the highlight.');page.keyboard.press('Enter');page.keyboard.type('Keep the framing.');check('native text input keeps editing keys',page.locator('#feedbackText').input_value().count('\n')==1)
                # Input/change is the documented composer commit boundary, without keyboard emulation.
                page.locator('#feedbackText').evaluate('(e)=>{e.value="Committed dictation fixture";e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}))}');check('composer input/change commits durable draft',page.evaluate('review.draft.text')=='Committed dictation fixture')
                page.click('[data-provider="claude"]');page.click('#reviewFeedback');check('review phase does not push history or focus Send',page.evaluate('navigation.route.depth===2 && document.activeElement.id==="reviewContent"'))
                page.keyboard.down('Enter');page.keyboard.down('Enter');page.keyboard.up('Enter');check('held activation on review content cannot submit',not any(r['c']=='review-submit' for r in state['requests']))
                shot('confirm-native-600');page.click('#editFeedback');check('Edit is in same feedback entry',page.evaluate('navigation.route.depth===2 && review.mode==="compose"'));page.click('#reviewFeedback');back();kind('picture');check('Back from review leaves transaction and keeps draft',page.evaluate('review.draft.text')=='Committed dictation fixture')
                page.click('#giveFeedback');page.click('#reviewFeedback');state['uncertain']=True;page.click('#sendFeedback');idle();check('uncertain outcome retains immutable request',page.evaluate('!!review.draft.pending && !review.receipt && navigation.route.depth===2'));pending=page.evaluate('review.draft.pending');shot('uncertain-native-600');page.click('#retryFeedback');idle()
                submits=[r for r in state['requests'] if r['c']=='review-submit'];check('lost after commit retry preserves exact payload',all(submits[-1][k]==submits[-2][k] for k in ['reviewId','assetId','assetVersion','text','provider']) and len(state['receipts'])==1)
                check('Send replaced feedback with receipt',page.evaluate('navigation.route.kind==="receipt" && navigation.route.depth===2'))
                receipt=state['receipts'][pending['reviewId']];receipt['dispatch'].update(status='ready',note='Synthetic result ready for your review.',resultAssetId='asset-9');page.click('#checkReceipt');idle();check('receipt refresh retains visible focus on its action',page.evaluate('document.activeElement.id==="checkReceipt" && getComputedStyle(document.activeElement).boxShadow!=="none"'));shot('receipt-native-600');page.click('#openReviewResult');idle();check('nested result identity opens actual image',page.evaluate('review.asset.id==="asset-9" && navigation.route.depth===3'));page.click('#zoomPicture');check('deepest route is five entries including root',page.evaluate('navigation.route.depth===4'));back();kind('picture');back();kind('receipt');check('result Back restores exact receipt not source picture',page.evaluate('review.receipt.id')==pending['reviewId'])
                # Three explicit revisions each begin a fresh bounded branch.
                for cycle in range(3):
                    page.click('#openReviewResult');idle();page.click('#revisePicture');kind('feedback');check(f'revision{cycle+1} rebases to feedback depth2',page.evaluate('navigation.route.depth===2 && review.mode==="compose"'))
                    page.fill('#feedbackText',f'Synthetic revision {cycle+1}');page.click('#reviewFeedback');page.click('#sendFeedback');idle();rid=page.evaluate('review.receipt.id');state['receipts'][rid]['dispatch'].update(status='ready',resultAssetId=f'asset-{10+cycle}');page.click('#checkReceipt');idle()
                check('three revisions preserve prior receipts',len(state['receipts'])==4)
                # Return to root and read a shared receipt with no local draft dependency.
                back();kind('picture');back();kind('root');page.click('#feedbackTab');idle();check('shared inbox exposes actual saved reviews',page.locator('#feedbackList button').count()==4);check('same-title receipts expose version and distinct excerpts',page.locator('#feedbackList').inner_text().count('Version test-v001')==4 and 'Synthetic revision 3' in page.locator('#feedbackList').inner_text());shot('feedback-inbox-native-600');page.locator('#feedbackList button').first.click();idle();check('inbox opens exact receipt and fullfeedback',page.evaluate('navigation.route.depth===1 && review.receipt.feedback')=='Committed dictation fixture');check('status request binds review and asset',state['requests'][-1]['c']=='review-status' and state['requests'][-1]['reviewId']==pending['reviewId'])
                page.click('#openReviewResult');idle();check('inbox result stays within shorter branch',page.evaluate('navigation.route.depth===2'));back();kind('receipt');back();kind('root');page.click('#picturesTab');idle();shot('gallery-native-600')
                # Native routes do not get rewritten by a late gallery response after peer switch.
                state['delay']='review-list';page.click('#reviewRefresh');page.click('#studioTab');page.wait_for_timeout(1150);check('late gallery response cannot change root peer',page.evaluate('navigation.route.peer==="studio"'));state['delay']=''
                page.click('#picturesTab');idle();page.locator('#pictureList button').nth(3).click();idle();page.click('#giveFeedback');page.fill('#feedbackText','Draft tied to the earlier picture version.');back();kind('picture');back();kind('root');state['version']='test-v002';page.locator('#pictureList button').nth(3).click();idle();page.click('#giveFeedback')
                check('changed image preserves old draft version and blocks review',page.evaluate('review.draft.assetVersion==="test-v001" && review.asset.version==="test-v002"') and page.locator('#reviewFeedback').is_disabled())
                check('changed version warning persists in editor','earlier version' in page.locator('#reviewMessage').inner_text());shot('changed-version-native-600');page.click('#usePictureVersion');page.click('#reviewFeedback');check('adopt version requires explicit action',page.evaluate('review.draft.assetVersion==="test-v002"'))
                before_posts=len([r for r in state['requests'] if r['c']=='review-submit']);page.evaluate('__testLink.connected=false');page.click('#sendFeedback');check('offline send keeps draft without creating request',len([r for r in state['requests'] if r['c']=='review-submit'])==before_posts and page.evaluate('review.draft.pending===null'));page.evaluate('__testLink.connected=true')
                state['reject']=True;page.click('#sendFeedback');idle();check('definite version rejection unlocks draft',page.evaluate('review.draft.pending===null && review.draft.text.length>0'));state['reject']=False;back();kind('picture');idle();page.click('#giveFeedback');page.click('#reviewFeedback')
                state['delay']='review-submit';page.click('#sendFeedback');back();kind('picture');page.wait_for_timeout(1150);check('late accepted submit updates durable draft without navigating',page.evaluate('navigation.route.kind==="picture" && !!review.draft.receipt'));state['delay']='';page.evaluate('history.forward()');kind('receipt');idle();check('Forward restores same receipt route',page.evaluate('!!review.receipt && navigation.route.depth===2'))
                back();kind('picture');back();kind('root');page.locator('#pictureList button').nth(4).click();idle();page.click('#giveFeedback');page.fill('#feedbackText','Reload-safe uncertain feedback.');page.click('#reviewFeedback');state['uncertain']=True;state['hide_status']=True;page.click('#sendFeedback');idle();locked=page.evaluate('review.draft.pending');page.reload();page.wait_for_function('data!==null && !review.busy');check('reload preserves uncertain receipt identity',page.evaluate('review.draft.pending')==locked);page.click('#retryFeedback');idle();check('retry after reload reuses exact durable id',page.evaluate('review.receipt.id')==locked['reviewId']);state['hide_status']=False
                rid=page.evaluate('review.receipt.id');state['receipts'][rid]['dispatch'].update(status='ready',resultAssetId='asset-20');page.click('#checkReceipt');idle();page.click('#openReviewResult');idle()
                page.locator('#revisePicture').evaluate('(e)=>{e.click();window.dispatchEvent(new PageTransitionEvent("pagehide"));}');kind('root');page.wait_for_timeout(100);check('hide cancels pending revision rebase',page.evaluate('navigation.route.kind==="root" && navigation.route.depth===0'))
                # Desktop is an explicit adapter with spatial geometry and an editing exit.
                desktop=setup(True,(360,700));desktop.click('#picturesTab');desktop.wait_for_function('!review.busy');desktop.locator('#pictureList button').nth(2).click();desktop.wait_for_function('!review.busy');desktop.screenshot(path=str(EVIDENCE/'picture-sidebar-360.png'));desktop.click('#giveFeedback');desktop.fill('#feedbackText','Sidebar draft');desktop.keyboard.press('Escape');check('desktop Escape leaves text editing first',desktop.evaluate('navigation.route.kind==="feedback" && document.activeElement.id==="finishEditing"'));desktop.keyboard.press('ArrowDown');check('desktop directions have geometric target',desktop.evaluate('document.activeElement.id!=="feedbackText"'));desktop.click('#reviewFeedback');desktop.screenshot(path=str(EVIDENCE/'confirm-sidebar-360.png'));desktop.keyboard.press('Escape');desktop.wait_for_function('navigation.route.kind==="picture"');check('desktop Escape matches one native history step',desktop.evaluate('navigation.route.depth===1'))
                desktop.set_viewport_size({'width':700,'height':360});desktop.screenshot(path=str(EVIDENCE/'picture-landscape-700x360.png'));check('image keeps contain aspect at shortviewport',desktop.locator('#renderPicture').evaluate('(e)=>getComputedStyle(e).objectFit')=='contain')
                desktop.click('#giveFeedback');desktop.fill('#feedbackText',('Long feedback for scrolling and native composition. '*45)[:2000]);desktop.locator('#feedbackText').evaluate('(e)=>e.scrollTop=0');desktop.screenshot(path=str(EVIDENCE/'editor-long-sidebar-700x360.png'))
                desktop.locator('[data-provider="claude"]').focus();desktop.locator('[data-provider="claude"]').scroll_into_view_if_needed();check('short editor provider fits the content viewport when focused',desktop.locator('[data-provider="claude"]').evaluate('(e)=>{const r=e.getBoundingClientRect(),p=document.getElementById("reviewContent").getBoundingClientRect();return r.top>=p.top && r.bottom<=p.bottom && r.right<=p.right}'))
                desktop.set_viewport_size({'width':360,'height':700});desktop.locator('#reviewContent').evaluate('(e)=>e.scrollTop=0');desktop.screenshot(path=str(EVIDENCE/'editor-long-sidebar-360x700.png'));desktop.click('#reviewFeedback');desktop.set_viewport_size({'width':700,'height':360});desktop.screenshot(path=str(EVIDENCE/'confirmation-long-sidebar-700x360.png'));check('long confirmation is one scroll owner with visible Send',desktop.evaluate('$("reviewContent").scrollHeight>$("reviewContent").clientHeight && $("sendFeedback").getBoundingClientRect().bottom<=innerHeight'))
                desktop.click('#sendFeedback');desktop.wait_for_function('!review.busy');desktop.screenshot(path=str(EVIDENCE/'receipt-long-sidebar-700x360.png'));desktop.set_viewport_size({'width':360,'height':700});desktop.screenshot(path=str(EVIDENCE/'receipt-long-sidebar-360x700.png'))
                page.click('#picturesTab');idle();page.locator('#pictureList button').nth(6).click();idle();page.click('#giveFeedback');page.fill('#feedbackText',('Long feedback for native composition. '*60)[:2000]);page.locator('#feedbackText').evaluate('(e)=>e.scrollTop=0');shot('editor-long-native-600')
                check('no JavaScript errors',not errors);check('no external network or real brokers',not external)
            finally: browser.close()
    finally:
        server.shutdown();server.server_close()
        (EVIDENCE/'navigation-results.json').write_text(json.dumps({'checks':checks,'errors':errors,'external':external,'physical':'not tested'},indent=2),encoding='utf-8')
    print(f'ALL PASSED: {len(checks)} checks',flush=True)


if __name__=='__main__':run()
