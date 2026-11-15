# Navigation overhaul candidate

> **Bakar Studio is now inside Bakar Home (15 November 2026).** Bakar asked for one app. On the glasses this
> address (`index.html`) only forwards to `../glass-home/` and hands on a pairing fragment (`#t=…&k=…` becomes
> `#sg=topic~key&tab=review&view=renders`). Pictures, Feedback and render progress (Renders) are the Review section
> of Bakar Home, whose `review/` directory holds this code. What follows describes that code. Here it is kept only as
> `local.html` for the PC sidebar (`window.STUDIO_LOCAL`) and the offline tests; `sw.js` (cache v16) keeps the
> forwarding page alone and removes older offline copies of the app. Check: `python tests/forward_test.py`.

Original record: [issue #1](https://github.com/baklarrrr/studio-glass/issues/1), [physical-controls follow-up](https://github.com/baklarrrr/studio-glass/issues/1#issuecomment-6435198965). The wearer rejected the previous navigation. This candidate remains unverified on glasses until the actual wearer journey passes.

Implementation plan: preserve the current picture transport and exact-version draft/receipt contract; replace both navigation handlers with one browser-history controller; let semantic controls and native spatial focus handle glasses input. Studio, Pictures and Feedback share entry zero. Picture is entry one; feedback edit/review are phases of entry two; Send replaces two with receipt; result picture is three; Inspect is four. Jobs use the same controller. Peer selection, paging, progress and focus do not push history.

Each route saves its focus target, scroll and selected identity. Async loads have route tokens and cannot change a route that was left. Submission may update its durable local draft after leaving, but cannot navigate or focus. Only explicit Inspect captures directions. Native Back traverses browser history, including leaving Inspect; no glasses Back buttons or Escape assumptions. An explicit `STUDIO_LOCAL` adapter supplies geometric desktop directions and Escape, while native textarea editing remains untouched.

Verification will cover native-like Back/forward, the five-entry ceiling, roots and job routes, loading cancellation, repeated activation, exact-version/uncertain retries, shared receipt lookup, nested result identity, resize/live updates and responsive layouts. Browser tests establish these application invariants; native composer, band/touchpad and physical additive-display behavior remain separate acceptance gates. Independent Director and Photographer reviews use frozen screenshots after source checks.

Optional wrist sensors, continuous drag, WebMCP voice actions and speech output are documented in the private official-controls research; they are deferred until core physical navigation qualifies. This change does not introduce a custom gesture map or haptics.

Candidate v003 qualification: 66 sequence checks, 42 retained dashboard checks, five link checks, nine encrypted review-transport checks and nine actual Chromium service-worker checks passed. The route suite uses a synthetic encrypted fake link in glasses mode, and explicitly separate local-mode sidebar tests. It includes three revision cycles, interrupted revision intent, exact remote receipt lookup, native-like Back/Forward, delayed-response cancellation, first-summary/resize focus, held Select, changed versions, uncertain retry across reload and long text at short height. A returned-picture screenshot separately shows its explicit revision consequence. The earlier independent v002 audit passed 15 scenarios; the targeted v003 review is a separate record.

Source and screenshots are bound by the private `navigation-overhaul/evidence-ui/candidate-v003/verification.json`. These receipts establish the browser candidate, not a published update, installed runtime or wearer acceptance. Original issue #1 and its physical-controls follow-up remain open under the release coordinator.

Follow-up after [PR #4](https://github.com/baklarrrr/studio-glass/pull/4), base `eebcf42048f9cf6fb934ba9d9c794523134a9373`: installed acceptance found that a terminal receipt without a result trapped the original picture in View feedback. The `codex/glasses-feedback-renewal-20261027` candidate adds explicit New feedback for stopped receipts. It preserves the shared receipt and all uncertain/running requests, replaces only the selected picture's local draft on that action, binds the currently displayed version, and uses the existing depth-two feedback route. Evidence is private under `feedback-renewal/evidence-ui/v001`; the original issue remains open pending release and physical acceptance.
