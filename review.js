'use strict';

// Pictures stay in memory; exact-version drafts and mutation identities persist on this device.
const review = { mode: 'gallery', busy: false, message: '', asset: null, loaded: false, draft: null,
  receipt: null, drafts: {}, requests: new Map(), statusTimer: 0, imageURL: '', zoom: false, panX: 0, panY: 0,
  pictures: new Map(), receipts: new Map(), sending: new Set(), collections: {
    pictures: { trail: [''], index: 0, batches: new Map(), batch: null },
    feedback: { trail: [''], index: 0, batches: new Map(), batch: null }
  } };
const REVIEW_TIMEOUT = 20000;

function reviewStorageKey() { return `sg.review.v1.${window.STUDIO_LOCAL ? 'local' : topic}`; }
function saveReviewDrafts() {
  try { localStorage.setItem(reviewStorageKey(), JSON.stringify(review.drafts)); }
  catch (_) { review.message = 'This device could not save the draft. Keep this page open until a receipt arrives.'; }
}

function reviewRequest(c, args = {}) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      review.requests.delete(id);
      reject(Object.assign(new Error('No reply yet. Your draft is kept. Check progress before retrying.'), { code: 'timeout', uncertain: true }));
    }, REVIEW_TIMEOUT);
    review.requests.set(id, { resolve, reject, timer });
    send(c, Date.now(), { ...args, id }).catch((error) => {
      const pending = review.requests.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      review.requests.delete(id);
      reject(Object.assign(error, { uncertain: true }));
    });
  });
}

function handleReviewReply(message) {
  if (!message || message.t !== 'review' || typeof message.id !== 'string') return;
  const pending = review.requests.get(message.id);
  if (!pending) return; // late/duplicate/unrelated replies cannot overwrite the selected picture
  clearTimeout(pending.timer);
  review.requests.delete(message.id);
  if (message.ok === true && message.data && typeof message.data === 'object') pending.resolve(message.data);
  else {
    const error = message.error || {};
    const code = String(error.code || 'unknown').toLowerCase().replace(/_/g, '-');
    // A bridge can lose the response after Studio has committed the feedback. An error envelope
    // alone therefore never proves rejection. Unknown codes stay uncertain until a receipt check.
    const definite = new Set(['invalid-request', 'request-expired', 'request-conflict', 'invalid-page',
      'invalid-picture', 'invalid-feedback', 'picture-not-opened', 'picture-unavailable', 'asset-changed',
      'version-changed', 'stale-version', 'validation-error', 'bad-request', 'unauthorized', 'forbidden',
      'auth-required', 'authentication-required', 'permission-denied', '400', '401', '403', '422']);
    const transport = /offline|transport|network|timeout|server|unavailable|busy|not-connected|^5\d\d$|http-?5\d\d/.test(code);
    const uncertain = error.uncertain === true || transport || !definite.has(code);
    pending.reject(Object.assign(new Error(error.message || 'Studio did not confirm the outcome. Your draft is kept.'), { code, uncertain, rejected: !uncertain }));
  }
}

function collection() { return review.collections[review.mode === 'inbox' ? 'feedback' : 'pictures']; }
function openPictures() { choosePeer('pictures'); }
function openFeedbackInbox() { choosePeer('feedback'); }
function draftFor(asset) {
  let draft = review.drafts[asset.id];
  if (!draft || typeof draft.text !== 'string') {
    draft = { assetId: asset.id, assetVersion: asset.version, title: asset.title, text: '', provider: 'auto', pending: null, receipt: null };
    review.drafts[asset.id] = draft;
  }
  return draft;
}
function setPicture(cached) {
  review.asset = cached?.asset || null;
  review.loaded = !!cached;
  review.imageURL = cached?.url || '';
  review.draft = cached ? draftFor(cached.asset) : null;
  if (cached) {
    $('renderPicture').src = cached.url;
    $('renderPicture').alt = cached.asset.title || 'Render picture';
  } else $('renderPicture').removeAttribute('src');
}
function enterReviewRoute(route) {
  review.mode = route.kind === 'root' ? (route.peer === 'feedback' ? 'inbox' : 'gallery') : route.kind === 'feedback' ? (route.phase || 'compose') : route.kind;
  review.zoom = route.kind === 'inspect';
  review.panX = route.panX || 0; review.panY = route.panY || 0;
  setPicture(route.kind === 'picture' && !route.visited ? null : review.pictures.get(route.assetId));
  review.draft = review.drafts[route.assetId] || review.draft;
  review.receipt = review.receipts.get(route.reviewId) || (review.draft?.receipt && review.draft.receipt.id === route.reviewId ? review.draft.receipt : null);
  renderReview();
  const preferred = review.mode === 'compose' ? 'feedbackText' : review.mode === 'inspect' ? 'pictureFrame'
    : review.mode === 'picture' && review.loaded ? route.isResult ? 'revisePicture' : 'giveFeedback'
    : ['confirm', 'receipt', 'picture'].includes(review.mode) ? 'reviewContent' : `${route.peer}Tab`;
  restoreRoutePosition(preferred);
  if (route.kind === 'root') loadCollection(route.peer === 'feedback');
  else if (route.kind === 'receipt') refreshReviewStatus(true);
  else if (!review.loaded || (route.kind === 'picture' && !route.visited)) {
    route.visited = true; storeRoute(); loadPicture(route.assetId, true);
  }
}

async function loadCollection(force = false) {
  if (review.busy || !['gallery', 'inbox'].includes(review.mode)) return;
  const key = navigation.route.key, epoch = navigation.epoch, mode = review.mode, model = collection();
  const cursor = model.trail[model.index] || '';
  const cached = !force && model.batches.get(cursor);
  if (cached) { model.batch = cached; renderReview(); return; }
  review.busy = true; review.message = mode === 'gallery' ? 'Loading pictures…' : 'Loading feedback…'; renderReview();
  try {
    const result = await reviewRequest(mode === 'gallery' ? 'review-list' : 'review-inbox', cursor ? { cursor } : {});
    const records = mode === 'gallery' ? result.items : result.reviews;
    if (!Array.isArray(records)) throw new Error('The list could not be read. Try Refresh.');
    model.batches.set(cursor, result);
    if (mode === 'inbox') for (const receipt of records) review.receipts.set(receipt.id, receipt);
    if (!routeCurrent(key, epoch)) return;
    model.batch = result;
    review.message = records.length ? '' : mode === 'gallery' ? 'No render pictures are available yet.' : 'No saved feedback was found in this view.';
  } catch (error) {
    if (!routeCurrent(key, epoch)) return;
    review.message = error.code === 'invalid-page' ? 'This page expired. Refresh to open the latest list.' : error.message;
    if (error.code === 'invalid-page') { model.trail = ['']; model.index = 0; model.batch = null; model.batches.clear(); }
  } finally {
    if (routeCurrent(key, epoch)) { review.busy = false; renderReview(); }
  }
}
function collectionPage(delta) {
  if (review.busy) return;
  const model = collection();
  if (delta > 0) {
    const cursor = model.batch?.nextCursor;
    if (typeof cursor !== 'string' || !cursor) return;
    if (model.trail[model.index + 1] !== cursor) { model.trail.splice(model.index + 1); model.trail.push(cursor); }
    model.index++;
  } else { if (model.index === 0) return; model.index--; }
  model.batch = model.batches.get(model.trail[model.index]) || null;
  $('reviewContent').scrollTop = 0;
  renderReview(); $('reviewContent').focus({ preventScroll: true }); loadCollection(); // Paging never grows history or assigns directional gestures.
}
function openPicture(assetId, result = false) {
  const route = navigation.route;
  if (!assetId || !((route.kind === 'root' && route.peer === 'pictures') || (result && route.kind === 'receipt'))) return;
  navigateTo({ kind: 'picture', assetId, isResult: !!result, reviewId: result ? route.reviewId : undefined });
}
async function loadPicture(assetId, force = false) {
  if (!assetId || review.busy) return;
  const key = navigation.route.key, epoch = navigation.epoch;
  if (!force && review.pictures.has(assetId)) { setPicture(review.pictures.get(assetId)); renderReview(); return; }
  review.busy = true; review.loaded = false; review.message = 'Loading the picture…'; renderReview();
  let url = '';
  try {
    const result = await reviewRequest('review-open', { assetId });
    const { asset, preview } = result;
    if (!asset || asset.id !== assetId || !asset.version || !asset.sha256 || !preview || !['image/jpeg', 'image/png', 'image/webp'].includes(preview.mime) || typeof preview.base64 !== 'string') throw new Error('This exact picture version is unavailable. Feedback is disabled.');
    const bytes = Uint8Array.from(atob(preview.base64), (ch) => ch.charCodeAt(0));
    if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new Error('The preview could not be loaded. Try Refresh.');
    url = URL.createObjectURL(new Blob([bytes], { type: preview.mime }));
    const image = new Image(); image.src = url; await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('The picture could not be decoded.');
    if (!routeCurrent(key, epoch)) { URL.revokeObjectURL(url); return; }
    const previous = review.pictures.get(assetId);
    if (previous) URL.revokeObjectURL(previous.url);
    review.pictures.set(assetId, { asset, url });
    setPicture(review.pictures.get(assetId));
    reconcileReceipts(result.reviews || [], review.draft);
    review.message = review.draft.assetVersion !== asset.version ? 'The picture has changed. Your earlier draft keeps its original version.' : '';
  } catch (error) {
    if (url) URL.revokeObjectURL(url);
    if (routeCurrent(key, epoch)) review.message = error.message;
  } finally { if (routeCurrent(key, epoch)) { review.busy = false; renderReview(); } }
}
function inspectPicture() {
  if (!review.loaded || navigation.route.kind !== 'picture') return;
  navigateTo({ kind: 'inspect', assetId: review.asset.id });
}
function paintPicture() {
  $('renderPicture').style.transform = review.zoom ? `translate(${review.panX}%, ${review.panY}%) scale(2)` : 'none';
  $('pictureFrame').tabIndex = review.zoom ? 0 : -1;
  $('pictureFrame').setAttribute('role', review.zoom ? 'button' : 'img');
  $('pictureFrame').setAttribute('aria-label', review.zoom ? 'Inspect picture. Directions pan. Select or Back returns to fit.' : 'Render picture at fit.');
}
function composeFeedback() {
  if (!review.loaded || navigation.route.kind !== 'picture' || navigation.route.isResult) return;
  if (review.draft.pending || review.draft.receipt) {
    const receipt = review.draft.receipt;
    navigateTo({ kind: 'receipt', assetId: review.asset.id, assetVersion: receipt?.assetVersion || review.draft.pending.assetVersion,
      reviewId: receipt?.id || review.draft.pending.reviewId, title: review.asset.title });
    return;
  }
  navigateTo({ kind: 'feedback', assetId: review.asset.id, assetVersion: review.draft.assetVersion, phase: 'compose' });
}
function feedbackPhase(phase) {
  if (navigation.route.kind !== 'feedback') return;
  navigation.route.phase = phase; storeRoute();
  review.mode = phase; renderReview();
  $('reviewContent').scrollTop = 0;
  (phase === 'compose' ? $('feedbackText') : $('reviewContent')).focus({ preventScroll: true });
}
function updateFeedback() {
  const draft = review.draft;
  if (!draft || draft.pending || navigation.route.kind !== 'feedback') return;
  const text = $('feedbackText').value.slice(0, 2000);
  if (text !== draft.text) { draft.text = text; draft.receipt = null; review.receipt = null; }
  saveReviewDrafts(); renderReviewControls();
}
function useCurrentPictureVersion() {
  if (!review.loaded || !review.draft || review.draft.pending || review.busy) return;
  review.draft.assetVersion = review.asset.version; review.draft.receipt = null; review.receipt = null;
  navigation.route.assetVersion = review.asset.version; storeRoute();
  review.message = 'Your draft now refers to the picture shown. Review it before sending.';
  saveReviewDrafts(); renderReview();
  if (review.mode === 'compose') (canReview() ? $('reviewFeedback') : $('feedbackText')).focus();
}
function canReview() {
  return review.loaded && review.draft && !review.draft.pending && !review.draft.receipt && review.draft.text.trim().length > 0 && review.draft.assetVersion === review.asset.version;
}
function reviewFeedback() {
  if (review.mode !== 'compose') return;
  updateFeedback(); if (!canReview()) return;
  review.message = ''; feedbackPhase('confirm');
}
function matchingReceipt(receipt, pending) {
  return receipt && pending && receipt.id === pending.reviewId && receipt.assetId === pending.assetId && receipt.assetVersion === pending.assetVersion;
}
function acceptReceipt(receipt, draft) {
  if (!matchingReceipt(receipt, draft?.pending)) return false;
  draft.receipt = receipt; draft.pending = null; review.receipts.set(receipt.id, receipt); saveReviewDrafts(); return true;
}
function reconcileReceipts(receipts, draft) {
  for (const receipt of Array.isArray(receipts) ? receipts : []) {
    if (acceptReceipt(receipt, draft)) continue;
    if (draft?.receipt && receipt.id === draft.receipt.id && receipt.assetId === draft.assetId && receipt.assetVersion === draft.receipt.assetVersion) {
      draft.receipt = receipt; review.receipts.set(receipt.id, receipt); saveReviewDrafts();
    }
  }
}
async function submitFeedback(retry = false) {
  const draft = review.draft;
  if (review.busy || !draft || (!retry && (review.mode !== 'confirm' || !canReview())) || (retry && !draft.pending)) return;
  if (!window.STUDIO_LOCAL && (!linkUp() || !stateInfo().live)) {
    review.message = 'The PC is offline or has not answered. Your draft is kept. Refresh the connection before sending.'; renderReview(); return;
  }
  if (!retry) draft.pending = { reviewId: crypto.randomUUID(), assetId: review.asset.id, assetVersion: draft.assetVersion, text: draft.text, provider: draft.provider };
  const pending = { ...draft.pending };
  if (review.sending.has(pending.reviewId)) return;
  review.sending.add(pending.reviewId); draft.receipt = null; saveReviewDrafts();
  if (!retry) navigateTo({ kind: 'receipt', assetId: pending.assetId, assetVersion: pending.assetVersion, reviewId: pending.reviewId, title: draft.title }, true);
  const key = navigation.route.key, epoch = navigation.epoch;
  review.busy = true; review.message = 'Sending feedback… awaiting a saved receipt.'; renderReview();
  try {
    const receipt = await reviewRequest('review-submit', pending);
    if (!acceptReceipt(receipt, draft)) throw Object.assign(new Error('No matching saved receipt arrived.'), { uncertain: true });
    if (routeCurrent(key, epoch)) { review.receipt = receipt; review.message = ''; }
  } catch (error) {
    if (error.rejected && !error.uncertain) {
      draft.pending = null;
      if (/version|stale|changed/.test(error.code || '')) {
        const cached = review.pictures.get(pending.assetId);
        if (cached) URL.revokeObjectURL(cached.url);
        review.pictures.delete(pending.assetId);
      }
    }
    if (routeCurrent(key, epoch)) review.message = error.rejected && !error.uncertain
      ? `${error.message} Your draft is kept; no acceptance was confirmed.`
      : 'No saved receipt arrived. The outcome is unconfirmed; retry sends the same feedback.';
    saveReviewDrafts();
  } finally {
    review.sending.delete(pending.reviewId);
    if (routeCurrent(key, epoch)) { review.busy = false; renderReview(); scheduleReviewStatus(); }
  }
}
function openReceipt(receipt) {
  if (navigation.route.kind !== 'root' || navigation.route.peer !== 'feedback') return;
  review.receipts.set(receipt.id, receipt);
  navigateTo({ kind: 'receipt', assetId: receipt.assetId, assetVersion: receipt.assetVersion, reviewId: receipt.id, title: receipt.assetTitle || 'Render feedback' });
}
async function refreshReviewStatus(quiet = false) {
  const route = navigation.route;
  if (route.kind !== 'receipt' || review.busy || review.sending.has(route.reviewId)) return;
  const key = route.key, epoch = navigation.epoch, draft = review.drafts[route.assetId];
  review.busy = true; if (!quiet) review.message = 'Checking feedback progress…'; renderReview();
  try {
    const result = await reviewRequest('review-status', { assetId: route.assetId, reviewId: route.reviewId });
    const receipt = result.reviews?.find((item) => item.id === route.reviewId && item.assetId === route.assetId && (!route.assetVersion || item.assetVersion === route.assetVersion));
    if (receipt) { review.receipts.set(receipt.id, receipt); reconcileReceipts([receipt], draft); }
    if (!routeCurrent(key, epoch)) return;
    review.receipt = receipt || review.receipts.get(route.reviewId) || null;
    review.message = receipt ? '' : review.receipt ? 'No fresh update was returned. Showing the last saved receipt.' : 'No receipt found yet. The outcome remains unconfirmed.';
  } catch (error) { if (routeCurrent(key, epoch)) review.message = `Progress could not be refreshed. ${error.message}`; }
  finally { if (routeCurrent(key, epoch)) { review.busy = false; renderReview(); scheduleReviewStatus(); } }
}
function scheduleReviewStatus() {
  clearTimeout(review.statusTimer); review.statusTimer = 0;
  if (navigation.route.kind !== 'receipt' || document.visibilityState !== 'visible') return;
  if (!['completed', 'complete', 'done', 'ready', 'review-ready', 'needs-context', 'interrupted', 'failed', 'rejected', 'cancelled', 'canceled'].includes(receiptState(review.receipt))) review.statusTimer = setTimeout(() => refreshReviewStatus(true), 15000);
}
function receiptState(receipt) { return String(receipt?.dispatch?.status || receipt?.status || receipt?.state || '').toLowerCase(); }
function resultAssetId(receipt) { return [receipt?.dispatch?.resultAssetId, receipt?.resultAssetId].find((id) => typeof id === 'string' && id.trim()) || ''; }
function receiptLabel(receipt) {
  const state = receiptState(receipt);
  if (['queued', 'pending', 'accepted'].includes(state)) return 'Queued — waiting to start';
  if (state === 'dispatch-pending') return 'Queued — waiting for an agent';
  if (state === 'starting') return 'Starting';
  if (['running', 'working', 'in_progress', 'in-progress'].includes(state)) return 'Running';
  if (state === 'ready') return resultAssetId(receipt) ? 'Result picture available' : 'Review update received';
  if (state === 'review-ready') return 'Needs your review';
  if (state === 'needs-context') return 'Needs more context';
  if (state === 'interrupted') return 'Interrupted';
  if (state === 'waiting') return 'Waiting';
  if (state === 'submitted') return 'Feedback saved — progress not yet reported';
  if (['complete', 'completed', 'done'].includes(state)) return 'Completed';
  if (['failed', 'error'].includes(state)) return 'Failed';
  if (['rejected', 'cancelled', 'canceled'].includes(state)) return state[0].toUpperCase() + state.slice(1);
  return `Saved receipt · ${state || 'progress not supplied'}`;
}
function receiptText() {
  const receipt = review.receipt;
  if (!receipt) return review.draft?.pending ? 'Awaiting a saved receipt\n\nThis request may have reached Studio. Check progress, or retry the identical request. Your feedback is kept unchanged until the outcome is known.'
    : 'No saved receipt has been confirmed. Your draft is kept. Return to the picture to review it again.';
  const parts = [receiptLabel(receipt), `Recipient: ${receipt.dispatch?.recipient || receipt.provider || 'Auto'}`];
  if (receipt.message) parts.push(String(receipt.message));
  if (receipt.dispatch?.note && receipt.dispatch.note !== receipt.message) parts.push(String(receipt.dispatch.note));
  if (!resultAssetId(receipt) && ['ready', 'review-ready', 'completed', 'complete', 'done'].includes(receiptState(receipt))) parts.push('No result picture was supplied with this update.');
  const feedback = receipt.feedback || receipt.text || review.draft?.text;
  if (feedback) parts.push(`Your feedback\n${typeof feedback === 'string' ? feedback : feedback.text || ''}`);
  else if (receipt.feedbackExcerpt) parts.push(`Feedback excerpt\n${receipt.feedbackExcerpt}`);
  parts.push('Progress is tracked here. Review the result before treating the work as finished.');
  return parts.join('\n\n');
}

function renderCollection() {
  const inbox = review.mode === 'inbox', model = collection(), batch = model.batch;
  const list = inbox ? $('feedbackList') : $('pictureList');
  const records = (inbox ? batch?.reviews : batch?.items) || [];
  const wanted = new Set(records.map((item) => item.id));
  for (const li of [...list.children]) {
    const button = li.firstElementChild;
    if (!wanted.has(button.dataset[inbox ? 'reviewId' : 'assetId'])) {
      if (button === document.activeElement) {
        button.children[1].textContent = 'No longer in this list. Open to check availability.';
      } else li.remove();
    }
  }
  for (const item of records) {
    let button = [...list.querySelectorAll('button')].find((el) => el.dataset[inbox ? 'reviewId' : 'assetId'] === item.id);
    if (!button) {
      const li = document.createElement('li'); button = document.createElement('button'); button.type = 'button'; button.className = 'picture-button';
      button.dataset[inbox ? 'reviewId' : 'assetId'] = item.id;
      button.append(document.createElement('span'), document.createElement('small'));
      if (inbox) {
        const excerpt = document.createElement('p'); excerpt.className = 'feedback-excerpt'; button.append(excerpt);
      }
      button.addEventListener('click', () => inbox ? openReceipt(button.reviewRecord) : openPicture(button.reviewRecord.id));
      li.append(button); list.append(li);
    }
    button.reviewRecord = item;
    button.children[0].textContent = inbox ? item.assetTitle || 'Render feedback' : item.title || 'Untitled render';
    button.children[1].textContent = inbox ? `Version ${String(item.assetVersion || 'not supplied').slice(0, 16)} · ${receiptLabel(item)}` : `${item.width || '?'} × ${item.height || '?'} · Open picture`;
    if (inbox) button.children[2].textContent = item.feedbackExcerpt || (typeof item.feedback === 'string' ? item.feedback : '') || 'Feedback excerpt not supplied. Open to read the saved request.';
  }
  $('reviewPrevious').disabled = review.busy || model.index === 0;
  $('reviewNext').disabled = review.busy || !batch?.nextCursor;
  const offset = Number(batch?.offset) || 0, total = Number(batch?.total) || records.length;
  $('reviewPosition').textContent = records.length ? `${offset + 1}–${offset + records.length} of ${total}` : inbox ? 'No saved feedback' : 'No pictures';
  $('inboxCoverage').hidden = !inbox || !batch;
  if (inbox && batch) {
    const coverage = typeof batch.coverage === 'string' ? batch.coverage : batch.coverage?.message || '';
    $('inboxCoverage').textContent = coverage || 'Saved feedback from Studio. New progress appears when refreshed.';
  }
}
function renderReviewControls() {
  const mode = review.mode, route = navigation.route, draft = review.draft;
  const show = (id, yes) => { $(id).hidden = !yes; };
  show('zoomPicture', mode === 'picture' && review.loaded);
  show('giveFeedback', mode === 'picture' && review.loaded && !route.isResult);
  show('revisePicture', mode === 'picture' && review.loaded && !!route.isResult);
  show('revisionHint', mode === 'picture' && review.loaded && !!route.isResult);
  show('reviewFeedback', mode === 'compose'); show('editFeedback', mode === 'confirm'); show('sendFeedback', mode === 'confirm');
  show('retryFeedback', mode === 'receipt' && !!draft?.pending && draft.pending.reviewId === route.reviewId);
  show('checkReceipt', mode === 'receipt');
  show('usePictureVersion', ['picture', 'compose'].includes(mode) && review.loaded && draft?.assetVersion !== review.asset?.version && !draft?.pending);
  show('openReviewResult', mode === 'receipt' && !!resultAssetId(review.receipt));
  show('reviewRefresh', ['gallery', 'inbox'].includes(mode) || (['picture', 'compose'].includes(mode) && (!review.loaded || !!review.message)));
  // Do not disable a focused status action during its request: browsers can discard focus.
  // Handlers already guard concurrent work; aria-disabled conveys the temporary boundary.
  $('reviewRefresh').disabled = false; $('reviewRefresh').setAttribute('aria-disabled', String(review.busy));
  $('giveFeedback').textContent = draft?.pending ? 'View pending feedback' : draft?.receipt ? 'View feedback' : 'Give feedback';
  $('reviewFeedback').disabled = !canReview() || review.busy;
  $('sendFeedback').disabled = review.busy || !canReview();
  $('sendFeedback').textContent = `Send to ${draft?.provider === 'claude' ? 'Claude' : draft?.provider === 'codex' ? 'Codex' : 'Studio'}`;
  for (const id of ['retryFeedback', 'checkReceipt', 'usePictureVersion']) {
    $(id).disabled = false; $(id).setAttribute('aria-disabled', String(review.busy));
  }
  $('openReviewResult').disabled = false;
  $('feedbackText').readOnly = !!draft?.pending;
  $('feedbackCount').textContent = `${draft?.text.length || 0} / 2000 characters`;
  for (const button of document.querySelectorAll('[data-provider]')) {
    button.setAttribute('aria-pressed', String(button.dataset.provider === (draft?.provider || 'auto'))); button.disabled = !!draft?.pending;
  }
  $('reviewActions').hidden = ![...$('reviewActions').children].some((el) => !el.hidden);
}
function renderReview() {
  $('reviewScreen').hidden = view.screen !== 'review';
  if (view.screen !== 'review') return;
  const mode = review.mode, route = navigation.route, draft = review.draft;
  const show = (id, yes) => { $(id).hidden = !yes; };
  const heading = { gallery: 'Recent pictures', inbox: 'Saved feedback', compose: 'Give feedback', confirm: 'Review feedback', receipt: 'Feedback progress', inspect: 'Inspect picture' };
  $('reviewHeading').textContent = mode === 'picture' ? review.asset?.title || 'Picture' : heading[mode] || 'Picture';
  $('reviewHeading').classList.toggle('picture-heading', mode === 'picture');
  const version = mode === 'receipt' ? review.receipt?.assetVersion || route.assetVersion : ['compose', 'confirm'].includes(mode) ? draft?.assetVersion : review.asset?.version;
  const mismatch = review.asset && version && version !== review.asset.version;
  $('reviewMessage').textContent = [review.message, mismatch && ['compose', 'confirm'].includes(mode) ? 'This draft is for an earlier version. Choose Use this picture version before sending.' : ''].filter(Boolean).join(' ');
  show('reviewMessage', !!$('reviewMessage').textContent);
  const root = ['gallery', 'inbox'].includes(mode);
  show('reviewIdentity', !root && !!version);
  const title = review.asset?.title || review.receipt?.assetTitle || route.title || '';
  $('reviewIdentity').textContent = `${mode === 'picture' ? '' : title ? `${title} · ` : ''}${mode === 'picture' || mode === 'inspect' ? 'Version' : 'Feedback version'} ${String(version || '').slice(0, 16)}${mismatch ? ` · Picture shown: ${String(review.asset.version).slice(0, 16)}` : ''}`;
  show('pictureList', mode === 'gallery'); show('feedbackList', mode === 'inbox');
  show('pictureFrame', ['picture', 'inspect'].includes(mode) && review.loaded);
  show('feedbackForm', mode === 'compose'); show('reviewText', ['confirm', 'receipt'].includes(mode));
  show('reviewPager', root); show('inboxCoverage', mode === 'inbox'); show('inspectHint', mode === 'inspect');
  $('reviewContent').classList.toggle('image-content', ['picture', 'inspect'].includes(mode) && review.loaded);
  $('reviewContent').tabIndex = root || ['confirm', 'receipt'].includes(mode) || (mode === 'picture' && !review.loaded) ? 0 : -1;
  if (root) renderCollection();
  if (mode === 'compose' && $('feedbackText').value !== (draft?.text || '')) $('feedbackText').value = draft?.text || '';
  if (mode === 'confirm' || mode === 'receipt') {
    const text = mode === 'confirm' ? `${draft.provider === 'auto' ? 'Starts a new Studio task with this picture and context. Studio chooses Codex or Claude.' : `Starts a new ${draft.provider === 'codex' ? 'Codex' : 'Claude'} task with this picture and context.`}\n\n${draft.text}` : receiptText();
    if ($('reviewText').textContent !== text) $('reviewText').textContent = text;
  }
  renderReviewControls(); paintPicture();
}
function bindReview() {
  try { review.drafts = JSON.parse(localStorage.getItem(reviewStorageKey()) || '{}') || {}; } catch (_) { review.drafts = {}; }
  $('picturesButton').addEventListener('click', openPictures);
  $('jobPicturesButton').addEventListener('click', openPictures);
  $('reviewRefresh').addEventListener('click', () => ['gallery', 'inbox'].includes(review.mode) ? loadCollection(true) : loadPicture(navigation.route.assetId, true));
  $('zoomPicture').addEventListener('click', inspectPicture);
  $('giveFeedback').addEventListener('click', composeFeedback);
  $('revisePicture').addEventListener('click', startRevision);
  $('feedbackText').addEventListener('input', updateFeedback); $('feedbackText').addEventListener('change', updateFeedback);
  $('finishEditing').addEventListener('click', () => $('reviewFeedback').focus());
  for (const button of document.querySelectorAll('[data-provider]')) button.addEventListener('click', () => {
    if (!review.draft || review.draft.pending || navigation.route.kind !== 'feedback') return;
    review.draft.provider = button.dataset.provider; review.draft.receipt = null; review.receipt = null; saveReviewDrafts(); renderReviewControls();
  });
  $('reviewFeedback').addEventListener('click', reviewFeedback);
  $('editFeedback').addEventListener('click', () => feedbackPhase('compose'));
  $('sendFeedback').addEventListener('click', () => submitFeedback(false));
  $('retryFeedback').addEventListener('click', () => submitFeedback(true));
  $('checkReceipt').addEventListener('click', () => refreshReviewStatus());
  $('usePictureVersion').addEventListener('click', useCurrentPictureVersion);
  $('openReviewResult').addEventListener('click', () => { if (resultAssetId(review.receipt)) openPicture(resultAssetId(review.receipt), true); });
  $('reviewPrevious').addEventListener('click', () => collectionPage(-1)); $('reviewNext').addEventListener('click', () => collectionPage(1));
  $('pictureFrame').addEventListener('click', () => { if (navigation.route.kind === 'inspect') history.back(); });
  $('pictureFrame').addEventListener('keydown', (event) => {
    // A held Select that opened Inspect must not immediately activate its exit. Ordinary
    // activation stays the browser's native button behavior; this guard is local to Inspect.
    if (navigation.route.kind === 'inspect' && event.key === 'Enter' && event.repeat) { event.preventDefault(); return; }
    if (navigation.route.kind !== 'inspect' || !event.key.startsWith('Arrow')) return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'ArrowLeft') review.panX = Math.min(50, review.panX + 10);
    if (event.key === 'ArrowRight') review.panX = Math.max(-50, review.panX - 10);
    if (event.key === 'ArrowUp') review.panY = Math.min(50, review.panY + 10);
    if (event.key === 'ArrowDown') review.panY = Math.max(-50, review.panY - 10);
    navigation.route.panX = review.panX; navigation.route.panY = review.panY; storeRoute(); paintPicture();
  });
  document.addEventListener('visibilitychange', () => { clearTimeout(review.statusTimer); if (document.visibilityState === 'visible') scheduleReviewStatus(); });
  window.addEventListener('pagehide', () => clearTimeout(review.statusTimer));
}
