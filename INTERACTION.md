# Render job inspection

Tracks [issue #1](https://github.com/baklarrrr/studio-glass/issues/1). The first read-only inspection update was published on 2026-10-27 through [PR #2](https://github.com/baklarrrr/studio-glass/pull/2), runtime source `c4a264fb355fd8d7e65dc0938ebc758a50c3dbde`, offline shell v11. The PC relay was updated and the published app was checked over its real encrypted connection, including opening a real job and returning to the list. Physical glasses and Neural Band interaction remain unverified; the issue remains open.

The prior interaction was rejected in the owner's [physical-controls follow-up](https://github.com/baklarrrr/studio-glass/issues/1#issuecomment-6435198965). This branch replaces it with the route model in [NAVIGATION.md](NAVIGATION.md). Select the headline to open attention jobs, Renders for all jobs, and a job for its explanation. These are actual browser-history routes. Native directions move spatial focus or scroll; Select activates semantic buttons; native Back traverses history. No global Arrow, Enter, Escape or Backspace navigation handler runs on glasses.

The existing summary format remains supported. It supplies short text without reliable job identity, so a detail view keeps the saved report and labels it. A newer relay may provide `renders.details`: records with stable `id`, `ti`, `st`, `why`, `detail`, `source`, `pct`, `since` and `detailTruncated`. `renders.omitted` counts records beyond its bound. Waiting counts without individual records remain explicit. A selected stable ID that disappears is unavailable; it is never silently replaced by another job.

The original job inspector sends hello/bye messages and reads status. The picture-review candidate below adds a separate request/reply route. It does not approve output or stop render jobs. No pairing, private pictures, feedback records or runtime data belongs in this repository.

## Picture and feedback candidate

Tracks the [picture/feedback acceptance comment on issue #1](https://github.com/baklarrrr/studio-glass/issues/1#issuecomment-6434520235). This source is an isolated candidate until its release and actual-device checks are recorded by the owner of the release.

Studio, Pictures and Feedback are root peers sharing the initial history entry. Pictures opens twelve actual render records per cursor page, with native scrolling and visible Previous/Next actions. Select one to load the supplied JPEG/PNG/WebP preview. Fit preserves its aspect ratio. Inspect is an explicit route where directions pan; Select or native Back returns to Fit. The full picture must decode and its exact asset/version identity must be present before feedback becomes available.

Give feedback opens a standard textarea. Meta's [official text-input guidance](https://github.com/facebook/meta-wearables-webapp/blob/main/AGENTS.md#text-input) says a wearer must focus and activate the field to open the native handwriting/voice composer; programmatic focus alone does not open it. Native editing keys and composition events are not intercepted. Physical dictation/handwriting remains a separate verification gate.

Choose Auto, Codex or Claude, then Review feedback and Send. Editing and review are phases of one feedback route; Send replaces that entry with its receipt. Review focuses the readable content, never Send. The review screen explains that sending starts a new Studio task. The transmitted request binds the exact asset ID, version and feedback text. A changed picture keeps the old draft and requires an explicit version selection. Draft and receipt identities are saved locally; image bytes remain in memory. Only a matching backend receipt confirms acceptance. Queued, running, completed, rejected and unconfirmed outcomes remain distinct. An uncertain retry keeps the same `reviewId` and unchanged payload. Progress is shown here without implying delivery into an existing desktop chat.

Feedback shows shared saved receipts from the PC, including requests made on the sidebar. Opening one requests its exact review ID and full feedback. Progress reads `dispatch.status` before `status`/`state`; returned pictures use `dispatch.resultAssetId`, falling back to its legacy top-level field. A returned picture first goes Back to its receipt. Only its explicit Revise this picture action starts a fresh root → picture → feedback branch; earlier receipts remain in Feedback. This keeps all subsequent revision cycles within five total history entries including the root.

An original picture with a stopped receipt also offers New feedback. This explicit action opens a blank draft for the exact version currently shown; its prior receipt remains in Feedback and View feedback still opens it. New feedback is available for ready, review-ready, completed, failed/error, rejected, interrupted, needs-context and cancelled outcomes. Review-ready still means Needs your review, including a finished acknowledgement with no result picture; New feedback starts a separate request and does not imply approval. Pending uncertainty and queued/starting/running/waiting work remain protected; neither New feedback nor version adoption can clear them. A new request receives a new durable review ID only when Send is selected. No receipt is cleared merely by loading a picture.

Encrypted MQTT requests use `review-list`, `review-open`, `review-submit`, `review-inbox` and `review-status`, each with a fresh request UUID. Exact receipt lookup supplies both `assetId` and `reviewId`. Responses arrive on the existing paired topic's `/r` channel, with `{t:'review',id,ok,data}` or `{t:'review',id,ok:false,error}`. Review sends never enter the dashboard's offline outbox or reconnect replay window. The local sidebar transport is explicitly enabled by `window.STUDIO_LOCAL = true`; it uses same-origin `/local/summary` and `/local/review`, bypasses MQTT/pairing and does not register a service worker. Only that mode installs a geometric desktop Arrow adapter and Escape → Back. Escape from a focused textarea first exits text editing; a visible Finish editing control does the same. Local endpoints are excluded from shell caching.

Gallery paging retains the relay's opaque request cursors as a history stack. First-page requests omit the cursor; Next uses `nextCursor`, Previous reuses the saved prior cursor, and `offset` is only a display count. An expired page offers a fresh gallery reload. Error replies after a possible feedback commit retain the pending review ID and exact payload: `uncertain: true`, known transport/server failures and unrecognized errors cannot be treated as definite rejections. Only explicit validation or authorization rejection permits correcting that pending draft.

## Offline checks

Requires Python with Playwright and a local Chrome installation. The navigation check starts and closes its own loopback server. Its broker is a synthetic stand-in, and external requests are blocked.

```
python tests/navigation_overhaul_test.py
python tests/feedback_renewal_test.py
python tests/review_transport_test.py
python tests/service_worker_test.py
python tests/run_regressions.py
```

Run the existing suites against a task-owned server on port 47612:

```
python tests/studio_test.py
python tests/link_test.py http://127.0.0.1:47612/
```

A server can be started with `python -m http.server 47612 --bind 127.0.0.1`; stop only that task-owned server afterward. `run_regressions.py` instead creates an ephemeral server and closes it in `finally`. For another port, `studio_test.py` reads `STUDIO_TEST_BASE`, while `link_test.py` takes the URL as its first argument. `STUDIO_UI_EVIDENCE` selects an isolated screenshot/receipt directory; outputs stay outside the public app directory. Picture tests use visibly labelled synthetic images and a fake task backend. The new navigation suite uses encrypted fake MQTT in glasses mode and a separate explicit desktop mode; it covers the native-history model, shared inbox, three revision cycles, loading cancellation, focus, version changes and uncertain retries. Earlier `navigation_test.py`, `picture_review_test.py`, `receipt_progress_test.py` and `uncertain_cursor_test.py` retain the rejected version's pager/Back-button expectations as historical fixtures; they are not qualification evidence for this navigation architecture. Browser tests and screenshot reviews do not prove physical display/input, live agent work or a released version.
