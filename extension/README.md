# :\ARCHITECT\™ for Chrome

A Manifest V3 extension that gives quick access to :\ARCHITECT\ at https://rchtch.app.

- **Side panel** (toolbar button): write a goal, pick a start URL (or "This tab") and an autonomy level, start a run, follow recent runs, cancel them, and approve or decline pending steps.
- **Context menu**: "Send selection to :\ARCHITECT\" and "Send this page to :\ARCHITECT\" open the side panel with a drafted goal and the page as the start URL. Nothing starts until you press **Start run**.

## Sign-in

rchtch.app is behind Cloudflare Access, and its API also needs the server's `ARCHITECT_API_TOKEN`.

1. Sign in at https://rchtch.app in the same Chrome profile. The extension sends that session cookie with its requests (`host_permissions: https://rchtch.app/*`). When the session is missing or expired, the panel shows **Sign in at rchtch.app**.
2. In **Options**, paste the API token, or press **Copy from open Podium tab** to reuse the token the Podium already saved. The token stays in `chrome.storage.local` in this profile. The extension ships no keys.

## Develop

```bash
npm run extension:icons   # render podium/icon.svg to extension/icons (Playwright Chromium)
npx vitest run test/extension.test.ts
npm run extension:zip     # checks the manifest, writes dist/architect-extension-<version>.zip
```

Load unpacked: `chrome://extensions` → Developer mode → **Load unpacked** → this `extension/` folder.

## Chrome Web Store

Upload `dist/architect-extension-<version>.zip`. Bump `version` in `manifest.json` for each upload. Permissions to justify in the listing:

| Permission | Why |
| --- | --- |
| `sidePanel` | The main UI. |
| `contextMenus` | Send the selection or page. |
| `storage` | The API token (local) and the pending draft (session). |
| `activeTab` | Read the current tab's address for "This tab". |
| `scripting` | Only for "Copy from open Podium tab", which reads the Podium's saved token on rchtch.app. |
| host `https://rchtch.app/*` | Call the :\ARCHITECT\ API with the Access session. |
