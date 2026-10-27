# Render job inspection

Tracks [issue #1](https://github.com/baklarrrr/studio-glass/issues/1). The first read-only inspection update was published on 2026-10-27 through [PR #2](https://github.com/baklarrrr/studio-glass/pull/2), runtime source `c4a264fb355fd8d7e65dc0938ebc758a50c3dbde`, offline shell v11. The PC relay was updated and the published app was checked over its real encrypted connection, including opening a real job and returning to the list. Physical glasses and Neural Band interaction remain unverified; the issue remains open.

Select the headline to open jobs needing attention, or select Renders for the available jobs. Select a job to read its status and explanation. Up/Down moves focus, Enter activates, Left/Right changes pages, and Back returns. Escape and Backspace also return within the app. Native glasses gestures still require device verification.

The existing summary format remains supported. It supplies short text without reliable job identity, so a detail view keeps the saved report and labels it. A newer relay may provide `renders.details`: records with stable `id`, `ti`, `st`, `why`, `detail`, `source`, `pct`, `since` and `detailTruncated`. `renders.omitted` counts records beyond its bound. Waiting counts without individual records remain explicit. A selected stable ID that disappears is unavailable; it is never silently replaced by another job.

This page sends only the existing hello/bye messages. It does not display render images, submit feedback, approve output, control jobs or send agent messages. The richer relay adapter is installed separately through its existing scheduled task, with the previous source retained for rollback. No pairing or runtime data belongs in this repository.

## Offline checks

Requires Python with Playwright and a local Chrome installation. The navigation check starts and closes its own loopback server. Its broker is a synthetic stand-in, and external requests are blocked.

```
python tests/navigation_test.py
```

Run the existing suites against a task-owned server on port 47612:

```
python tests/studio_test.py
python tests/link_test.py http://127.0.0.1:47612/
```

A server can be started with `python -m http.server 47612 --bind 127.0.0.1`; stop only that task-owned server afterward. For another port, `studio_test.py` reads the `STUDIO_TEST_BASE` environment variable, while `link_test.py` takes the URL as its first argument. Test screenshots and receipts stay outside the public app directory. Browser tests and screenshot reviews do not prove physical display or input behavior.
