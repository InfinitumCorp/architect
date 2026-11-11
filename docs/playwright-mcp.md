# Playwright MCP browser backend (optional)

Architect's own browser instrument (`src/instruments/browser.ts`) stays the default. The
Cloudflare Worker edition (`src/worker.ts`) depends on it with Browser Rendering, so it is not
replaced. Microsoft's Playwright MCP server (`@playwright/mcp`, Apache-2.0) is offered as an
alternative for the Node edition.

## Turning it on

```bash
npm install @playwright/mcp@0.0.84
```

```bash
ARCHITECT_BROWSER_BACKEND=playwright-mcp architect run "…" --allow-host example.com
```

`--headed`, `--state <file>` and `--allow-host` work the same as with the built-in browser. In code:

```ts
const browser = await PlaywrightMcpInstrument.start({ allowedHosts: ["example.com"] });
const architect = createArchitect({ browserInstrument: browser });
```

The package is an optional peer dependency. Architect never downloads it at run time; if it is
missing, starting the backend fails with the install command.

## Evaluation (0.0.84, measured against the real server)

| Question | Finding |
|---|---|
| License | Apache-2.0, "Copyright (c) Microsoft Corporation.", no NOTICE file. |
| Footprint | Pulls its own `playwright` / `playwright-core` 1.65.0-alpha, a second copy beside Architect's `playwright`. This is why it is optional, not a dependency. |
| Tools | 23 remain after the exclusions below. |
| Risk hints | Nearly every tool is marked `destructiveHint`, including clicks on harmless links, so the hint can't drive the approval gate. Architect ignores it and classifies by the element label, like the built-in browser. Labels for passwords, card numbers and similar fields count as irreversible, so a person approves them. |
| Host access | `browser_evaluate`, `browser_run_code(_unsafe)` run arbitrary page or Node code; `browser_file_upload` and `browser_drop` read host paths; `browser_install` downloads browsers; `browser_pdf_save` writes files. These are never offered to the model. |
| File writes | Many tools take a `filename` parameter that writes to a host path. Architect removes it from every schema and sets `additionalProperties: false`. |
| Navigation limits | The server's `--allowed-origins` blocks requests outside the list. Architect also refuses any call whose `url` is outside `--allow-host`, before the server sees it. |
| Sessions | Runs `--isolated` (fresh profile) and `--headless` by default. `--state` loads a storage state a person signed in to themselves. |

## When to use which

- **Built-in** (default): Worker edition, screenshot evidence, the smallest install.
- **Playwright MCP**: accessibility-snapshot driving (refs instead of coordinates), tabs, and
  form filling that tracks upstream Playwright closely.

Both register as the `browser` instrument, so plans and permissions don't change.
