# Render job inspection

Tracks [issue #1](https://github.com/baklarrrr/studio-glass/issues/1). The first read-only inspection update was published on 2026-10-27 through [PR #2](https://github.com/baklarrrr/studio-glass/pull/2), runtime source `c4a264fb355fd8d7e65dc0938ebc758a50c3dbde`, offline shell v11. The PC relay was updated and the published app was checked over its real encrypted connection, including opening a real job and returning to the list. Physical glasses and Neural Band interaction remain unverified; the issue remains open.

Select the headline to open jobs needing attention, or select Renders for the available jobs. Select a job to read its status and explanation. Up/Down moves focus, Enter activates, Left/Right changes pages, and Back returns. Escape and Backspace also return within the app. Native glasses gestures still require device verification.

The existing summary format remains supported. It supplies short text without reliable job identity, so a detail view keeps the saved report and labels it. A newer relay may provide `renders.details`: records with stable `id`, `ti`, `st`, `why`, `detail`, `source`, `pct`, `since` and `detailTruncated`. `renders.omitted` counts records beyond its bound. Waiting counts without individual records remain explicit. A selected stable ID that disappears is unavailable; it is never silently replaced by another job.

The original job inspector sends hello/bye messages and reads status. The picture-review candidate below adds a separate request/reply route. It does not approve output or stop render jobs. No pairing, private pictures, feedback records or runtime data belongs in this repository.

## Picture and feedback candidate

Tracks the [picture/feedback acceptance comment on issue #1](https://github.com/baklarrrr/studio-glass/issues/1#issuecomment-6434520235). This source is an isolated candidate until its release and actual-device checks are recorded by the owner of the release.

Pictures opens a paged list of actual render records. Select one to load the supplied JPEG/PNG/WebP preview. Fit preserves its aspect ratio; Zoom 2× and the arrow keys inspect a region, and Escape returns to fit. The full picture must decode and its exact asset/version identity must be present before feedback becomes available.

Give feedback opens a standard textarea. Meta's [official text-input guidance](https://github.com/facebook/meta-wearables-webapp/blob/main/AGENTS.md#text-input) says a wearer must focus and activate the field to open the native handwriting/voice composer; programmatic focus alone does not open it. Native editing keys and composition events are not intercepted. Physical dictation/handwriting remains a separate verification gate.

Choose Auto, Codex or Claude, then Review feedback and Send. The review screen explains that sending starts a new Studio task. The transmitted request binds the exact asset ID, version and feedback text. A changed picture keeps the old draft and requires an explicit version selection. Draft and receipt identities are saved locally; image bytes remain in memory. Only a matching backend receipt confirms acceptance. Queued, running, completed, rejected and unconfirmed outcomes remain distinct. An uncertain retry keeps the same `reviewId` and unchanged payload; already-confirmed, unchanged feedback cannot start another task. Progress is shown here without implying delivery into an existing desktop chat.

Encrypted MQTT requests use `review-list`, `review-open`, `review-submit` and `review-status`, each with a fresh request UUID. Responses arrive on the existing paired topic's `/r` channel, with `{t:'review',id,ok,data}` or `{t:'review',id,ok:false,error}`. Review sends never enter the dashboard's offline outbox or reconnect replay window. The local sidebar transport is explicitly enabled by `window.STUDIO_LOCAL = true`; it uses same-origin `/local/summary` and `/local/review`, bypasses MQTT/pairing and does not register a service worker. Local endpoints are excluded from shell caching.

Gallery paging retains the relay's opaque request cursors as a history stack. First-page requests omit the cursor; Next uses `nextCursor`, Previous reuses the saved prior cursor, and `offset` is only a display count. An expired page offers a fresh gallery reload. Error replies after a possible feedback commit retain the pending review ID and exact payload: `uncertain: true`, known transport/server failures and unrecognized errors cannot be treated as definite rejections. Only explicit validation or authorization rejection permits correcting that pending draft.

## Offline checks

Requires Python with Playwright and a local Chrome installation. The navigation check starts and closes its own loopback server. Its broker is a synthetic stand-in, and external requests are blocked.

```
python tests/navigation_test.py
python tests/picture_review_test.py
python tests/review_transport_test.py
python tests/service_worker_test.py
python tests/receipt_progress_test.py
python tests/uncertain_cursor_test.py
python tests/run_regressions.py
```

Run the existing suites against a task-owned server on port 47612:

```
python tests/studio_test.py
python tests/link_test.py http://127.0.0.1:47612/
```

A server can be started with `python -m http.server 47612 --bind 127.0.0.1`; stop only that task-owned server afterward. `run_regressions.py` instead creates an ephemeral server and closes it in `finally`. For another port, `studio_test.py` reads `STUDIO_TEST_BASE`, while `link_test.py` takes the URL as its first argument. `STUDIO_UI_EVIDENCE` selects an isolated screenshot/receipt directory; outputs stay outside the public app directory. Picture tests use visibly labelled synthetic images and a fake task backend. Browser tests and screenshot reviews do not prove physical display/input, live agent work or a released version.
