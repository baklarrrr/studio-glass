'use strict';

// Picture bytes stay in memory. Drafts and receipt identities are saved only on this device.
// Request IDs correlate transport replies; reviewId is the durable idempotency key for work.
const review = { mode: 'gallery', origin: 'dashboard', offset: 0, start: 0, batch: null,
  batches: new Map(), galleryTrail: [{ cursor: '', offset: 0 }], galleryIndex: 0, asset: null, loaded: false, imageURL: '', imageToken: 0,
  zoom: false, panX: 0, panY: 0, busy: false, message: '', drafts: {}, draft: null,
  textPage: 0, textPages: [], receipt: null, requests: new Map(), statusTimer: 0, historyReady: false };
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

function reviewRoute(mode, push = true) {
  review.mode = mode;
  review.textPage = 0;
  if (push) history.pushState({ ...history.state, studioReview: { mode, assetId: mode === 'picture' ? review.requestedAssetId || review.asset?.id || '' : review.asset?.id || '', galleryIndex: review.galleryIndex, offset: review.offset, start: review.start } }, '');
  renderReview();
}

function openPictures() {
  if (view.screen !== 'review') review.origin = view.screen;
  view.screen = 'review';
  review.message = '';
  render();
  reviewRoute('gallery');
  loadPictures(0);
}

function reviewBack() {
  if (review.zoom) { setPictureZoom(false); return; }
  if (history.state?.studioReview) history.back();
  else closePictures();
}

function closePictures() {
  clearTimeout(review.statusTimer);
  view.screen = review.origin;
  $('reviewScreen').hidden = true;
  render();
  focusControl(view.screen === 'dashboard' ? 'picturesButton' : 'jobPicturesButton');
}

async function loadPictures(pageIndex = 0, force = false, tail = false) {
  if (review.busy) return;
  review.galleryIndex = Math.max(0, Math.min(pageIndex, review.galleryTrail.length - 1));
  const entry = review.galleryTrail[review.galleryIndex];
  const cacheKey = entry.cursor || 'first';
  review.offset = entry.offset;
  review.batch = !force ? review.batches.get(cacheKey) || null : null;
  review.busy = true;
  review.message = 'Loading pictures…';
  renderReview();
  try {
    const cached = !force && review.batches.get(cacheKey);
    const batch = cached || await reviewRequest('review-list', entry.cursor ? { cursor: entry.cursor } : {});
    if (!Array.isArray(batch.items)) throw new Error('The picture list was not readable. Try Refresh.');
    review.batch = batch;
    review.offset = Number.isFinite(batch.offset) ? batch.offset : entry.offset;
    entry.offset = review.offset;
    review.batches.set(cacheKey, batch);
    review.start = tail ? Math.max(0, Math.floor((batch.items.length - 1) / galleryCapacity()) * galleryCapacity())
      : Math.min(review.start, Math.max(0, batch.items.length - 1));
    review.message = batch.items.length ? '' : 'No render pictures are available yet.';
  } catch (error) {
    review.message = error.code === 'invalid-page' ? 'This gallery page expired. Refresh to open the latest pictures.' : error.message;
    if (error.code === 'invalid-page') { review.galleryTrail = [{ cursor: '', offset: 0 }]; review.galleryIndex = 0; review.start = 0; review.offset = 0; review.batches.clear(); }
  }
  finally {
    review.busy = false;
    if (review.mode === 'gallery') history.replaceState({ ...history.state, studioReview: { mode: 'gallery', galleryIndex: review.galleryIndex, offset: review.offset, start: review.start } }, '');
    renderReview(); focusReview('.picture-button');
  }
}

function draftFor(asset) {
  let draft = review.drafts[asset.id];
  if (!draft || typeof draft.text !== 'string') {
    draft = { assetId: asset.id, assetVersion: asset.version, title: asset.title, text: '', provider: 'auto', pending: null, receipt: null };
    review.drafts[asset.id] = draft;
  }
  return draft;
}

async function openPicture(assetId, push = true) {
  if (review.busy) return;
  review.busy = true;
  review.loaded = false;
  review.requestedAssetId = assetId;
  review.asset = null;
  review.draft = null;
  review.receipt = null;
  review.message = 'Loading the picture…';
  review.zoom = false;
  const token = ++review.imageToken;
  if (review.imageURL) URL.revokeObjectURL(review.imageURL);
  review.imageURL = '';
  $('renderPicture').removeAttribute('src');
  reviewRoute('picture', push);
  try {
    const result = await reviewRequest('review-open', { assetId });
    if (token !== review.imageToken) return;
    const asset = result.asset;
    const preview = result.preview;
    if (!asset || asset.id !== assetId || !asset.version || !asset.sha256 || !preview || !['image/jpeg', 'image/png', 'image/webp'].includes(preview.mime) || typeof preview.base64 !== 'string') {
      throw new Error('This picture or its exact version is unavailable. Feedback stays disabled.');
    }
    review.asset = asset;
    review.draft = draftFor(asset);
    review.receipt = review.draft.receipt;
    const bytes = Uint8Array.from(atob(preview.base64), (ch) => ch.charCodeAt(0));
    if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new Error('The preview could not be loaded. Try Refresh.');
    review.imageURL = URL.createObjectURL(new Blob([bytes], { type: preview.mime }));
    const img = $('renderPicture');
    img.alt = asset.title || 'Render picture';
    img.src = review.imageURL;
    await img.decode();
    if (token !== review.imageToken) return;
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('The picture could not be decoded.');
    review.loaded = true;
    review.message = review.draft.assetVersion !== asset.version
      ? 'This picture has changed. Your earlier draft is kept with its original version.' : '';
    reconcileReceipts(result.reviews || []);
  } catch (error) { review.message = error.message; }
  finally {
    if (token === review.imageToken) {
      review.busy = false;
      renderReview();
      focusReview(review.loaded ? '#giveFeedback' : '#reviewRefresh');
    }
  }
}

function setPictureZoom(zoom) {
  review.zoom = zoom;
  review.panX = review.panY = 0;
  paintPicture();
  $('zoomPicture').textContent = zoom ? 'Fit picture' : 'Zoom 2×';
  if (zoom) $('pictureFrame').focus({ preventScroll: true });
}

function paintPicture() {
  $('renderPicture').style.transform = review.zoom ? `translate(${review.panX}%, ${review.panY}%) scale(2)` : 'none';
  $('pictureFrame').setAttribute('aria-label', review.zoom ? 'Zoomed picture. Arrow keys pan. Escape returns to fit.' : 'Render picture at fit.');
}

function composeFeedback() {
  if (!review.loaded || !review.asset) return;
  review.message = review.draft.assetVersion !== review.asset.version ? 'Your earlier draft still refers to its original picture version.' : '';
  reviewRoute('compose');
  $('feedbackText').value = review.draft.text;
  renderReview();
  focusReview('#feedbackText');
}

function updateFeedback() {
  const draft = review.draft;
  if (!draft || draft.pending) return;
  const text = $('feedbackText').value.slice(0, 2000);
  if (text !== draft.text) { draft.text = text; draft.receipt = null; review.receipt = null; }
  saveReviewDrafts();
  renderReviewControls();
}

function useCurrentPictureVersion() {
  if (!review.loaded || !review.draft || review.draft.pending) return;
  review.draft.assetVersion = review.asset.version;
  review.draft.receipt = null;
  review.receipt = null;
  review.message = 'Your draft now refers to the picture shown. Review it before sending.';
  saveReviewDrafts();
  renderReview();
}

function canReview() {
  return review.loaded && review.draft && !review.draft.pending && !review.draft.receipt && review.draft.text.trim().length > 0 && review.draft.assetVersion === review.asset.version;
}

function reviewFeedback() {
  updateFeedback();
  if (!canReview()) return;
  review.message = '';
  reviewRoute('confirm');
  focusReview(review.textPages.length > 1 ? '#reviewNext' : '#sendFeedback');
}

function matchingReceipt(receipt, pending) {
  return receipt && pending && receipt.id === pending.reviewId && receipt.assetId === pending.assetId && receipt.assetVersion === pending.assetVersion;
}

function acceptReceipt(receipt) {
  if (!matchingReceipt(receipt, review.draft?.pending)) return false;
  review.draft.receipt = receipt;
  review.draft.pending = null;
  review.receipt = receipt;
  saveReviewDrafts();
  return true;
}

function reconcileReceipts(receipts) {
  if (!Array.isArray(receipts) || !review.draft) return;
  for (const receipt of receipts) {
    if (acceptReceipt(receipt)) continue;
    if (review.draft.receipt && receipt.id === review.draft.receipt.id && receipt.assetId === review.asset.id && receipt.assetVersion === review.draft.receipt.assetVersion) {
      review.draft.receipt = review.receipt = receipt;
      saveReviewDrafts();
    }
  }
}

async function submitFeedback(retry = false) {
  if (review.busy || !review.loaded || !review.draft) return;
  const draft = review.draft;
  if (!retry && (!canReview() || review.mode !== 'confirm')) return;
  if (retry && !draft.pending) return;
  if (!window.STUDIO_LOCAL && (!linkUp() || !stateInfo().live)) {
    review.message = 'The PC is offline or has not answered. Your draft is kept. Refresh before sending.';
    renderReview(); return;
  }
  if (!retry) {
    draft.pending = { reviewId: crypto.randomUUID(), assetId: review.asset.id, assetVersion: review.asset.version, text: draft.text, provider: draft.provider };
    draft.receipt = null;
  }
  saveReviewDrafts(); // durable request identity exists before transport starts
  const pending = { ...draft.pending };
  review.busy = true;
  review.message = 'Sending feedback… awaiting a saved receipt.';
  reviewRoute('receipt');
  try {
    const receipt = await reviewRequest('review-submit', pending);
    if (!acceptReceipt(receipt)) throw Object.assign(new Error('No matching saved receipt arrived. Check progress before retrying.'), { uncertain: true });
    review.message = '';
  } catch (error) {
    if (error.rejected && !error.uncertain) {
      draft.pending = null;
      review.message = `${error.message} Your draft is kept; no acceptance was confirmed.`;
      if (/version|stale|changed/i.test(error.code || '')) review.loaded = false;
    } else review.message = 'No saved receipt arrived. The outcome is unconfirmed; retry sends the same feedback.';
    saveReviewDrafts();
  } finally { review.busy = false; renderReview(); focusReview('#checkReceipt'); scheduleReviewStatus(); }
}

async function refreshReviewStatus(quiet = false) {
  if (!review.asset || review.busy) return;
  review.busy = true;
  if (!quiet) review.message = 'Checking feedback progress…';
  renderReview();
  try {
    const result = await reviewRequest('review-status', { assetId: review.asset.id });
    reconcileReceipts(result.reviews);
    review.message = review.draft?.pending ? 'No receipt found yet. The outcome remains unconfirmed.' : '';
  } catch (error) { review.message = `Progress could not be refreshed. ${error.message}`; }
  finally { review.busy = false; renderReview(); scheduleReviewStatus(); }
}

function scheduleReviewStatus() {
  clearTimeout(review.statusTimer);
  review.statusTimer = 0;
  if (view.screen !== 'review' || review.mode !== 'receipt' || document.visibilityState !== 'visible') return;
  const state = receiptState(review.receipt);
  if (review.draft?.pending || (review.receipt && !['completed', 'complete', 'done', 'ready', 'review-ready', 'needs-context', 'interrupted', 'failed', 'rejected', 'cancelled', 'canceled'].includes(state))) {
    review.statusTimer = setTimeout(() => refreshReviewStatus(true), 15000);
  }
}

function receiptState(receipt) {
  return String(receipt?.dispatch?.status || receipt?.status || receipt?.state || '').toLowerCase();
}

function resultAssetId(receipt) {
  return [receipt?.dispatch?.resultAssetId, receipt?.resultAssetId]
    .find((id) => typeof id === 'string' && id.trim().length > 0) || '';
}

function receiptLabel(receipt) {
  const state = receiptState(receipt);
  if (['queued', 'pending', 'accepted'].includes(state)) return 'Queued — waiting to start';
  if (state === 'dispatch-pending') return 'Queued — waiting for an agent';
  if (state === 'starting') return 'Starting';
  if (['running', 'working', 'in_progress', 'in-progress'].includes(state)) return 'Running';
  if (state === 'ready') return resultAssetId(receipt) ? 'Reviewed result picture available' : 'Review update received';
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
  if (!receipt) return review.draft?.pending
    ? 'Awaiting a saved receipt\n\nThis request may have reached Studio. Check progress, or retry the identical request. Your feedback is kept unchanged until the outcome is known.'
    : 'No saved receipt has been confirmed. Your draft is kept. Go back to the picture, refresh, and review your feedback again.';
  const parts = [receiptLabel(receipt), `Recipient: ${receipt.dispatch?.recipient || receipt.provider || 'Auto'}`, `Saved receipt ${String(receipt.id).slice(0, 8)}`];
  if (receipt.message) parts.push(String(receipt.message));
  if (receipt.dispatch?.note && receipt.dispatch.note !== receipt.message) parts.push(String(receipt.dispatch.note));
  if (!resultAssetId(receipt) && ['ready', 'review-ready', 'completed', 'complete', 'done'].includes(receiptState(receipt))) {
    parts.push('No result picture was supplied with this update.');
  }
  parts.push('Progress is tracked here. Review the result before treating the work as finished.');
  return parts.join('\n\n');
}

function paginateReviewText(text) {
  const el = $('reviewText'), room = $('reviewContent').clientHeight;
  const pages = [];
  let rest = text;
  while (rest.length) {
    let lo = 1, hi = rest.length, fit = 1;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      el.textContent = rest.slice(0, mid);
      if (el.scrollHeight <= room) { fit = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (fit < rest.length) {
      const boundary = Math.max(rest.lastIndexOf('\n', fit - 1), rest.lastIndexOf(' ', fit - 1));
      if (boundary > fit * 0.65) fit = boundary + 1;
      if (fit > 1 && /[\uD800-\uDBFF]/.test(rest[fit - 1])) fit--;
    }
    pages.push(rest.slice(0, fit)); rest = rest.slice(fit);
  }
  return pages.length ? pages : [''];
}

function galleryCapacity() { return Math.max(1, Math.floor(($('reviewContent').clientHeight - 6) / 76)); }

function renderReviewControls() {
  const mode = review.mode, draft = review.draft;
  const show = (id, yes) => { $(id).hidden = !yes; };
  show('zoomPicture', mode === 'picture' && review.loaded);
  show('giveFeedback', mode === 'picture' && review.loaded);
  show('reviewFeedback', mode === 'compose');
  show('sendFeedback', mode === 'confirm');
  show('retryFeedback', mode === 'receipt' && !!draft?.pending);
  show('checkReceipt', mode === 'receipt' || (['picture', 'compose'].includes(mode) && !!(draft?.pending || draft?.receipt)));
  show('usePictureVersion', ['picture', 'compose'].includes(mode) && review.loaded && draft?.assetVersion !== review.asset?.version && !draft?.pending);
  show('openReviewResult', mode === 'receipt' && !!resultAssetId(review.receipt));
  $('giveFeedback').textContent = draft?.pending ? 'View pending feedback' : 'Give feedback';
  $('reviewFeedback').disabled = !canReview() || review.busy;
  $('sendFeedback').disabled = review.busy || !canReview();
  for (const id of ['reviewRefresh', 'giveFeedback', 'retryFeedback', 'checkReceipt', 'usePictureVersion', 'openReviewResult']) $(id).disabled = review.busy;
  $('feedbackText').readOnly = !!draft?.pending;
  $('feedbackCount').textContent = `${draft?.text.length || 0} / 2000 characters${draft?.pending ? ' · Waiting for a receipt; draft locked' : draft?.receipt ? ' · Already received; edit to send new feedback' : ''}`;
  for (const button of document.querySelectorAll('[data-provider]')) {
    button.setAttribute('aria-pressed', String(button.dataset.provider === (draft?.provider || 'auto')));
    button.disabled = !!draft?.pending;
  }
  $('reviewActions').hidden = ![...$('reviewActions').children].some((el) => !el.hidden);
}

function renderReview() {
  $('reviewScreen').hidden = view.screen !== 'review';
  if (view.screen !== 'review') return;
  const mode = review.mode;
  const old = document.activeElement, focusId = old?.id;
  const show = (id, yes) => { $(id).hidden = !yes; };
  $('reviewHeading').textContent = ({ gallery: 'Pictures', picture: review.asset?.title || 'Picture', compose: 'Give feedback', confirm: 'Review feedback', receipt: 'Feedback progress' })[mode];
  $('reviewHeading').classList.toggle('picture-heading', mode === 'picture');
  const boundVersion = mode === 'receipt' ? review.receipt?.assetVersion || review.draft?.pending?.assetVersion || review.draft?.assetVersion
    : ['compose', 'confirm'].includes(mode) ? review.draft?.assetVersion : review.asset?.version;
  const mismatch = review.asset && boundVersion && boundVersion !== review.asset.version;
  const mismatchNote = mismatch && ['compose', 'confirm'].includes(mode) ? 'The draft is for an earlier version. Choose Use this picture version before sending.' : '';
  $('reviewMessage').textContent = [review.message, mismatchNote].filter(Boolean).join(' ');
  show('reviewMessage', !!$('reviewMessage').textContent);
  show('reviewIdentity', mode !== 'gallery' && !!review.asset);
  const titleClipped = $('reviewHeading').scrollWidth > $('reviewHeading').clientWidth;
  const shortVersion = (version) => `${String(version).slice(0, 16)}${String(version).length > 16 ? '…' : ''}`;
  $('reviewIdentity').textContent = review.asset ? `${mode === 'picture' && !titleClipped ? '' : `${review.asset.title} · `}${mode === 'picture' ? 'Version' : 'Feedback version'} ${shortVersion(boundVersion)}${mismatch ? ` · Picture shown: ${shortVersion(review.asset.version)}` : ''}` : '';
  show('pictureList', mode === 'gallery'); show('pictureFrame', mode === 'picture' && review.loaded);
  show('feedbackForm', mode === 'compose'); show('reviewText', mode === 'confirm' || mode === 'receipt');
  show('reviewPager', ['gallery', 'confirm', 'receipt'].includes(mode));
  renderReviewControls();
  if (mode === 'gallery') {
    const list = $('pictureList'); list.replaceChildren();
    const items = review.batch?.items || [], capacity = galleryCapacity();
    for (const asset of items.slice(review.start, review.start + capacity)) {
      const li = document.createElement('li'), button = document.createElement('button');
      button.type = 'button'; button.className = 'picture-button'; button.dataset.assetId = asset.id;
      const name = document.createElement('span'); name.textContent = asset.title || 'Untitled render';
      const info = document.createElement('small'); info.textContent = `${asset.width || '?'} × ${asset.height || '?'} · Open picture`;
      button.append(name, info); button.disabled = review.busy;
      button.addEventListener('click', () => openPicture(asset.id)); li.append(button); list.append(li);
    }
    const total = Number(review.batch?.total) || items.length;
    $('reviewPosition').textContent = items.length ? `${review.offset + review.start + 1}–${review.offset + Math.min(items.length, review.start + capacity)} of ${total}` : 'No pictures';
    $('reviewPrevious').disabled = review.busy || (review.galleryIndex === 0 && review.start === 0);
    $('reviewNext').disabled = review.busy || (!review.batch?.nextCursor && review.start + capacity >= items.length);
  } else if (mode === 'confirm' || mode === 'receipt') {
    const draft = review.draft;
    const copy = mode === 'confirm'
      ? `${review.asset.title}\nVersion: ${String(draft.assetVersion).slice(0, 16)}\n${draft.provider === 'auto' ? 'Starts a new Studio task with this picture and context. Studio chooses Codex or Claude.' : `Starts a new ${draft.provider === 'codex' ? 'Codex' : 'Claude'} task with this picture and context.`}\n\n${draft.text}`
      : receiptText();
    review.textPages = paginateReviewText(copy);
    review.textPage = Math.min(review.textPage, review.textPages.length - 1);
    $('reviewText').textContent = review.textPages[review.textPage];
    $('reviewPosition').textContent = `Page ${review.textPage + 1} of ${review.textPages.length}`;
    $('reviewPrevious').disabled = review.textPage === 0;
    $('reviewNext').disabled = review.textPage >= review.textPages.length - 1;
    renderReviewControls();
  }
  if (mode === 'picture') paintPicture();
  if (old && (!old.isConnected || old.hidden || old.disabled)) focusReview(focusId ? `#${focusId}` : 'button');
}

function focusReview(selector) {
  const controls = visibleControls();
  const match = controls.find((el) => el.matches(selector));
  (match || controls[0])?.focus({ preventScroll: true });
}

function reviewPage(delta) {
  if (review.mode === 'gallery') {
    if (review.busy || !review.batch) return;
    const capacity = galleryCapacity(), next = review.start + delta * capacity;
    if (next < 0) {
      if (review.galleryIndex === 0) return;
      loadPictures(review.galleryIndex - 1, false, true); return;
    }
    if (next >= review.batch.items.length) {
      if (typeof review.batch.nextCursor !== 'string' || !review.batch.nextCursor) return;
      const cursor = review.batch.nextCursor;
      if (review.galleryTrail[review.galleryIndex + 1]?.cursor !== cursor) {
        review.galleryTrail.splice(review.galleryIndex + 1);
        review.galleryTrail.push({ cursor, offset: review.offset + review.batch.items.length });
      }
      review.start = 0; loadPictures(review.galleryIndex + 1); return;
    }
    review.start = next;
    history.replaceState({ ...history.state, studioReview: { mode: 'gallery', galleryIndex: review.galleryIndex, offset: review.offset, start: review.start } }, '');
    renderReview(); focusReview('.picture-button');
  } else if (['confirm', 'receipt'].includes(review.mode)) {
    review.textPage = Math.max(0, Math.min(review.textPages.length - 1, review.textPage + delta));
    renderReview();
    focusReview(review.mode === 'confirm' && review.textPage === review.textPages.length - 1 ? '#sendFeedback' : delta > 0 && !$('reviewNext').disabled ? '#reviewNext' : '#reviewPrevious');
  }
}

function navigateReview(event) {
  if (event.key === 'Escape' || event.key === 'Backspace') { event.preventDefault(); reviewBack(); return; }
  if (review.zoom && document.activeElement === $('pictureFrame') && event.key.startsWith('Arrow')) {
    event.preventDefault();
    if (event.key === 'ArrowLeft') review.panX = Math.min(50, review.panX + 10);
    if (event.key === 'ArrowRight') review.panX = Math.max(-50, review.panX - 10);
    if (event.key === 'ArrowUp') review.panY = Math.min(50, review.panY + 10);
    if (event.key === 'ArrowDown') review.panY = Math.max(-50, review.panY - 10);
    paintPicture(); return;
  }
  if (['ArrowLeft', 'ArrowRight'].includes(event.key) && ['gallery', 'confirm', 'receipt'].includes(review.mode)) {
    event.preventDefault(); reviewPage(event.key === 'ArrowRight' ? 1 : -1); return;
  }
  const controls = visibleControls(), index = controls.indexOf(document.activeElement);
  if (event.key.startsWith('Arrow')) {
    event.preventDefault();
    const next = Math.max(0, Math.min(controls.length - 1, index + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1)));
    controls[next]?.focus({ preventScroll: true });
  } else if (event.key === 'Enter' || event.key === ' ') {
    if (document.activeElement === $('pictureFrame')) { event.preventDefault(); if (!event.repeat) setPictureZoom(!review.zoom); }
    else if (document.activeElement?.tagName === 'BUTTON') { event.preventDefault(); if (!event.repeat) document.activeElement.click(); }
  }
}

function bindReview() {
  try { review.drafts = JSON.parse(localStorage.getItem(reviewStorageKey()) || '{}') || {}; } catch (_) { review.drafts = {}; }
  history.replaceState({ ...history.state, studioReview: null }, '');
  $('picturesButton').addEventListener('click', openPictures);
  $('jobPicturesButton').addEventListener('click', openPictures);
  $('reviewBack').addEventListener('click', reviewBack);
  $('reviewRefresh').addEventListener('click', () => {
    if (review.mode === 'gallery') loadPictures(review.galleryIndex, true);
    else if (review.mode === 'receipt') refreshReviewStatus();
    else if (review.requestedAssetId || review.asset) openPicture(review.requestedAssetId || review.asset.id, false);
  });
  $('zoomPicture').addEventListener('click', () => setPictureZoom(!review.zoom));
  $('giveFeedback').addEventListener('click', () => review.draft?.pending ? (reviewRoute('receipt'), refreshReviewStatus()) : composeFeedback());
  $('feedbackText').addEventListener('input', updateFeedback);
  $('feedbackText').addEventListener('change', updateFeedback);
  for (const button of document.querySelectorAll('[data-provider]')) button.addEventListener('click', () => {
    if (!review.draft || review.draft.pending) return;
    review.draft.provider = button.dataset.provider; review.draft.receipt = null; review.receipt = null;
    saveReviewDrafts(); renderReviewControls();
  });
  $('reviewFeedback').addEventListener('click', reviewFeedback);
  $('sendFeedback').addEventListener('click', () => submitFeedback(false));
  $('retryFeedback').addEventListener('click', () => submitFeedback(true));
  $('checkReceipt').addEventListener('click', () => { if (review.mode !== 'receipt') reviewRoute('receipt'); refreshReviewStatus(); });
  $('usePictureVersion').addEventListener('click', useCurrentPictureVersion);
  $('openReviewResult').addEventListener('click', () => {
    const assetId = resultAssetId(review.receipt);
    if (assetId) openPicture(assetId);
  });
  $('reviewPrevious').addEventListener('click', () => reviewPage(-1));
  $('reviewNext').addEventListener('click', () => reviewPage(1));
  window.addEventListener('popstate', () => {
    const route = history.state?.studioReview;
    if (!route) { closePictures(); return; }
    view.screen = 'review'; render();
    review.mode = route.mode; review.offset = route.offset || 0; review.start = route.start || 0;
    if (route.mode === 'gallery') loadPictures(route.galleryIndex || 0);
    else if (route.assetId && review.asset?.id !== route.assetId) openPicture(route.assetId, false);
    else { renderReview(); focusReview('#reviewBack'); }
  });
  window.addEventListener('resize', renderReview);
  document.addEventListener('visibilitychange', () => { clearTimeout(review.statusTimer); if (document.visibilityState === 'visible') scheduleReviewStatus(); });
  window.addEventListener('pagehide', () => { clearTimeout(review.statusTimer); if (review.imageURL) URL.revokeObjectURL(review.imageURL); });
}
