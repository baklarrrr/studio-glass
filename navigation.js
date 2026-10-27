'use strict';

// The host owns glasses focus, activation and Back. This is the only history owner.
// No pairing data, feedback text or picture bytes are written to browser history.
const navigation = { route: null, epoch: 0, saved: new Map(), pendingPeer: '', revision: null, editing: false };

function controlKey(el) {
  if (!el) return '';
  return el.dataset.assetId ? `asset:${el.dataset.assetId}` : el.dataset.reviewId ? `review:${el.dataset.reviewId}`
    : el.dataset.jobKey ? `job:${el.dataset.jobKey}` : el.id || (el.dataset.provider ? `provider:${el.dataset.provider}` : '');
}
function findControl(key) { return visibleControls().find((el) => controlKey(el) === key); }
function saveRoutePosition() {
  if (!navigation.route) return;
  const previous = navigation.saved.get(navigation.route.key) || {};
  const focus = document.activeElement?.dataset.peer
    ? previous.focus || `${navigation.route.peer}Tab` : controlKey(document.activeElement);
  navigation.saved.set(navigation.route.key, { ...previous, focus: focus || previous.focus,
    scroll: Object.fromEntries(['reviewContent', 'jobBody'].map((id) => [id, $(id).scrollTop])) });
}
function routeCurrent(key, epoch) { return navigation.route?.key === key && navigation.epoch === epoch; }
function restoreRoutePosition(preferred) {
  const saved = navigation.saved.get(navigation.route.key);
  for (const [id, top] of Object.entries(saved?.scroll || {})) $(id).scrollTop = top;
  const target = findControl(saved?.focus) || findControl(preferred) || visibleControls()[0];
  target?.focus({ preventScroll: true });
}
function storeRoute() { history.replaceState({ studioNav: navigation.route }, ''); }
function navigateTo(route, replace = false) {
  navigation.revision = null;
  saveRoutePosition();
  const depth = replace ? navigation.route.depth : navigation.route.depth + 1;
  if (depth > 4) return false;
  navigation.route = { ...route, key: route.key || crypto.randomUUID(), depth,
    anchorKey: depth === 0 ? route.key : navigation.route.depth === 0 ? navigation.route.key : navigation.route.anchorKey };
  if (replace) storeRoute(); else history.pushState({ studioNav: navigation.route }, '');
  enterRoute();
  return true;
}
function choosePeer(peer) {
  navigation.revision = null;
  if (!['studio', 'pictures', 'feedback'].includes(peer)) return;
  if (navigation.route.depth) {
    navigation.pendingPeer = peer;
    history.go(-navigation.route.depth);
    return;
  }
  if (navigation.route.peer === peer) return;
  navigateTo({ kind: 'root', peer, key: `root:${peer}` }, true);
}
function startRevision() {
  if (navigation.route.kind !== 'picture' || !navigation.route.isResult || !review.loaded || navigation.revision) return;
  const transaction = { assetId: review.asset.id, rootKey: navigation.route.anchorKey, token: crypto.randomUUID() };
  const draft = draftFor(review.asset);
  if (draft.receipt && !draft.pending) {
    review.drafts[review.asset.id] = { ...draft, text: '', receipt: null };
  }
  saveReviewDrafts();
  navigation.revision = transaction;
  history.go(-navigation.route.depth);
}
function enterRoute() {
  const route = navigation.route;
  navigation.epoch++;
  navigation.editing = false;
  clearTimeout(review.statusTimer);
  review.statusTimer = 0;
  review.busy = false;
  review.message = '';
  $('rootNavigation').hidden = route.kind !== 'root';
  $('desktopBack').hidden = !window.STUDIO_LOCAL || route.depth === 0;
  for (const button of document.querySelectorAll('[data-peer]')) button.setAttribute('aria-current', button.dataset.peer === route.peer ? 'page' : 'false');
  if (route.kind === 'root' && route.peer === 'studio') {
    view.screen = 'dashboard'; render(); restoreRoutePosition('headCard');
  } else if (route.kind === 'jobs' || route.kind === 'job') {
    view.screen = route.kind === 'jobs' ? 'list' : 'detail';
    view.filter = route.filter || 'all'; view.selected = route.selected || null;
    render(); restoreRoutePosition('jobBody');
  } else {
    view.screen = 'review'; render();
    enterReviewRoute(route);
  }
}
function desktopDirection(event) {
  if (!window.STUDIO_LOCAL || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
  const editing = event.target.matches?.('textarea,input,select') || event.target.isContentEditable;
  if (event.key === 'Escape') {
    if (editing) { event.preventDefault(); navigation.editing = false; $('finishEditing').focus(); }
    else if (navigation.route.depth) { event.preventDefault(); history.back(); }
    return;
  }
  if (editing || !event.key.startsWith('Arrow')) return;
  const active = document.activeElement;
  const scroller = active?.classList.contains('native-scroll') ? active : null;
  const vertical = event.key === 'ArrowDown' || event.key === 'ArrowUp';
  const sign = ['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1;
  if (scroller && vertical && ((sign > 0 && scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1) || (sign < 0 && scroller.scrollTop > 0))) {
    event.preventDefault(); scroller.scrollTop += sign * Math.max(80, scroller.clientHeight * .7); return;
  }
  const controls = visibleControls().filter((el) => el !== active);
  const box = active?.getBoundingClientRect();
  if (!box || !active?.getClientRects().length) { controls[0]?.focus(); event.preventDefault(); return; }
  const ax = (box.left + box.right) / 2, ay = (box.top + box.bottom) / 2;
  const ranked = controls.map((el) => {
    const b = el.getBoundingClientRect();
    const dx = (b.left + b.right) / 2 - ax, dy = (b.top + b.bottom) / 2 - ay;
    const along = (vertical ? dy : dx) * sign, across = Math.abs(vertical ? dx : dy);
    const overlap = vertical ? b.right > box.left && b.left < box.right : b.bottom > box.top && b.top < box.bottom;
    return { el, along, score: along + across * (overlap ? .2 : 3) };
  }).filter((item) => item.along > 2).sort((a, b) => a.score - b.score);
  if (ranked[0]) { event.preventDefault(); ranked[0].el.focus(); ranked[0].el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
}
function bindNavigation() {
  document.body.classList.toggle('desktop-preview', !!window.STUDIO_LOCAL);
  navigation.route = history.state?.studioNav || { kind: 'root', peer: 'studio', key: 'root:studio', depth: 0 };
  storeRoute();
  for (const button of document.querySelectorAll('[data-peer]')) button.addEventListener('click', () => choosePeer(button.dataset.peer));
  $('desktopBack').addEventListener('click', () => history.back());
  document.addEventListener('focusin', (event) => {
    if (!navigation.route || event.target.dataset.peer) return;
    const key = controlKey(event.target);
    if (key) navigation.saved.set(navigation.route.key, { ...navigation.saved.get(navigation.route.key), focus: key });
  });
  window.addEventListener('popstate', (event) => {
    saveRoutePosition();
    if (!event.state?.studioNav) { navigation.revision = null; return; } // Back belongs to the native shell.
    navigation.route = event.state.studioNav;
    if (navigation.pendingPeer && navigation.route.depth === 0) {
      navigation.route = { kind: 'root', peer: navigation.pendingPeer, key: `root:${navigation.pendingPeer}`, depth: 0 };
      navigation.pendingPeer = ''; storeRoute();
    }
    enterRoute();
    const transaction = navigation.revision;
    if (transaction && navigation.route.depth === 0 && navigation.route.key === transaction.rootKey) {
      const rootKey = navigation.route.key, epoch = navigation.epoch;
      // An explicit Revise action starts a new branch after traversal has completed. A passive
      // Back/reply never creates history, and an intervening navigation cancels this intent.
      setTimeout(() => {
        if (navigation.revision !== transaction || !routeCurrent(rootKey, epoch)) return;
        navigation.revision = null;
        navigateTo({ kind: 'picture', assetId: transaction.assetId, visited: true });
        composeFeedback();
      }, 0);
    } else if (transaction) navigation.revision = null;
  });
  if (window.STUDIO_LOCAL) document.addEventListener('keydown', desktopDirection);
  window.addEventListener('resize', () => { if (view.screen === 'dashboard') render(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') navigation.revision = null; });
  window.addEventListener('pagehide', () => { navigation.revision = null; });
  enterRoute();
}
