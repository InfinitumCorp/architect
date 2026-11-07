# Conductor Podium

The standalone `InfinitumCorp/architect` repository is the execution engine. `infinitum-nexus/apps/architect` is an older simulation scaffold and is not the backend for this client. The browser and Android client use the standalone `/v1` API.

## Run

```sh
npm ci
npx playwright install chromium
npm run build
# Set ANTHROPIC_API_KEY or the existing compatible model routing configuration.
# Set ARCHITECT_API_TOKEN before exposing the engine beyond your machine.
node dist/cli.js serve --port 7337
```

Open `http://localhost:7337`, click Connection settings in the header and enter the server API token. For Android, put this server behind an HTTPS reverse proxy; preserve `/v1` and streaming responses, and disable proxy buffering for SSE. Keep the server's data directory persistent. The engine can access its workspace and configured instruments, so run it in a workspace appropriate for its account permissions.

## Browser workflows

- Compose an outcome with autonomy, optional spending limit, start URL and JSON inputs. Composition uses the configured model and can incur a cost. No performance begins until you review the score, estimate and permissions and choose Start performance.
- Monitor live performance events, action history, spending, success criteria, verification and text/screenshot evidence.
- Review approval input and choose approve or decline, with an optional note.
- Recover failed/handed-off work with a new budget, or Encore into a new run with different inputs. Handoffs show the engine's instructions.
- Save scores, review their permissions, play them, export/import packages and delete them. Existing names overwrite saved scores.
- Create, edit, enable/pause and delete recurring schedules. Schedules run while `serve` is running; daily times are in the server's timezone. Review the score's permissions and budget before enabling automation.
- Export full JSON performance reports. Search the 50 most recent runs. The file-backed engine retains older runs for direct access through their IDs.

Bearer tokens live in session storage; the UI removes legacy persistent tokens and removes bootstrap token query parameters from the visible address. Fetch-based event streams and evidence use authorization headers. A dropped browser connection does not cancel server work. No offline execution is provided.

## Verify

```sh
npm run typecheck
npm run build
npm test
# Optional screenshots from the end-to-end browser test:
CONDUCTOR_SCREENSHOT_DIR=test-results/screenshots npm test
```

The browser tests drive Chromium through the real HTTP server and file-backed store with a deterministic test Brain. They cover composition, plan/cost review, start, approvals, evidence/verdict, save/export, schedules, encore, token recovery and mobile overflow. Existing engine tests exercise browser/workspace tools, model routing, budgets, policy, recovery, library and schedules. These tests do not call a paid model or prove production credentials and remote instruments are configured.

GitHub Actions builds the browser app, runs tests, and builds/tests/lints Android, uploading screenshots, the debug APK and an unsigned release AAB.
