# Studio Glass

<sub>BAKAR STUDIO / WEARABLE EXPERIMENTS</sub>

A web interface for Meta Ray-Ban Display that brings render status, picture inspection and feedback into a compact studio companion.

The aim is to inspect a job or a specific picture version without opening a full desktop dashboard. Studio, Pictures and Feedback are peers; picture feedback keeps the selected asset, version and receipt together.

[Hosted page](https://baklarrrr.github.io/studio-glass/) | [Interaction and transport](INTERACTION.md) | [Navigation model](NAVIGATION.md) | [Bakar Studio](https://bakar.ca/)

## Current status

The source includes render-job inspection, paged picture review and feedback requests with correlated receipts. These features depend on the separate studio PC relay and task backend.

**Physical glasses, Neural Band input and native text composition remain unverified for the current interaction.** [Issue #1](https://github.com/baklarrrr/studio-glass/issues/1) tracks acceptance. Browser checks and synthetic pictures establish application behavior only; they do not prove wearer acceptance or a completed creative revision.

## Preview locally

Prerequisites: Git, Python 3 and a current browser. The app is static HTML, CSS and JavaScript at the repository root, with no Node install or build step.

```sh
git clone https://github.com/baklarrrr/studio-glass.git
cd studio-glass
python -m http.server 8000 --bind 127.0.0.1
```

Open <http://127.0.0.1:8000/> in a fresh browser profile without a pairing fragment. The expected unpaired screen says **Not paired with your studio PC yet**. A 600 x 600 viewport can help inspect the intended display size; it is not a device simulation. Stop the server with Ctrl+C.

## Connected use

Real status, private pictures and feedback need an authorized PC relay, the matching pairing and its task backend. Those components are not distributed in this public web repository; cloning it does not provision a studio connection.

The normal glasses route reads its pairing from a URL fragment or saved browser storage and exchanges AES-GCM messages over MQTT. A separate, explicitly enabled local-sidebar mode expects same-origin `/local/summary` and `/local/review` endpoints. Python's static file server does not provide those endpoints.

Dashboard status is read-only. Sending reviewed picture feedback starts a new Studio task for the exact selected version. Queued, running, completed, rejected and unconfirmed receipts have different meanings; an acknowledgement alone does not establish that a picture was revised. See [INTERACTION.md](INTERACTION.md) for retry and receipt behavior.

## Browser checks

The included suites use Python, Playwright and an installed Google Chrome. Picture fixtures also require Pillow. Install the Python dependencies in a local virtual environment, then run from the repository root:

```sh
python -m pip install playwright pillow
python tests/navigation_overhaul_test.py
python tests/feedback_renewal_test.py
python tests/review_transport_test.py
python tests/service_worker_test.py
python tests/run_regressions.py
```

These commands use the existing test harness; the listed suites manage their loopback servers. `STUDIO_UI_EVIDENCE` can direct outputs to an isolated directory outside the public app. [INTERACTION.md](INTERACTION.md#offline-checks) distinguishes current qualification suites from historical navigation fixtures. This README update does not report a new test run.

## Privacy and credits

Application messages are encrypted over public MQTT brokers. Brokers can still observe topic names and traffic timing. Pairing secrets and local drafts/receipt identities are saved in browser storage; picture bytes are kept in memory by the review interface. Keep private pictures, feedback records, pairing links and runtime reports out of this repository.

Personal project by [Bakar Studio](https://bakar.ca/), independent of Meta. The vendored [MQTT.js](https://github.com/mqttjs/MQTT.js) library retains its [MIT license and contributor credits](vendor/mqtt-LICENSE.md). That dependency license does not assign a license to the rest of this application.
