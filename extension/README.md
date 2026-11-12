# :\ARCHITECT\™ for Chrome

A Manifest V3 extension that gives quick access to :\ARCHITECT\ at https://rchtch.app.

- **Side panel** (toolbar button): write a goal, pick a start URL (or "This tab") and an autonomy level, start a run, follow recent runs, cancel them, and approve or decline pending steps.
- **Context menu**: "Send selection to :\ARCHITECT\" and "Send this page to :\ARCHITECT\" open the side panel with a drafted goal and the page as the start URL. Nothing starts until you press **Start run**.

## Sign-in

Sign in with Cumulus ID, in **Options** or straight from the panel: **Sign in with Cumulus ID** or **Create a Cumulus ID** opens the Cumulus ID page (`chrome.identity.launchWebAuthFlow`, OAuth 2.0 code + PKCE) and comes back signed in. The session stays in `chrome.storage.local` in this profile and is sent as the API's Bearer. Nothing is pasted; the extension ships no keys.

Cumulus ID must accept this extension's return address, `https://<extension-id>.chromiumapp.org/cid`, for the `architect` client.

If rchtch.app is also behind Cloudflare Access, the panel shows **Sign in at rchtch.app** when that session is missing.

## Develop

```bash
npm run extension:icons   # render web/icon.svg to extension/icons (Playwright Chromium)
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
| `storage` | The Cumulus ID session (local) and the pending draft (session). |
| `activeTab` | Read the current tab's address for "This tab". |
| `identity` | Sign in with Cumulus ID (`launchWebAuthFlow`). |
| host `https://rchtch.app/*` | Call the :\ARCHITECT\ API. |
| host `https://id.cumuluscloud.app/*` | Trade the sign-in code for a Cumulus ID session. |
