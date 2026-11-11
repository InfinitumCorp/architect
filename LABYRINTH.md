# Labyrinth connection — ARCHITECT

By **Infinitum Corporation®**. This PR adds an explicit private client-artifact
capability; it does not automatically export exercise, agent or user records.
No existing product APIs, authorization rules or human approvals are replaced.

## Cumulus ID identity

`POST /api/labyrinth` relays to operator-configured `LBRNTH_ENDPOINT` (the central
Cumulus-backed Nexus `/api/labyrinth`). Without configuration it returns 503;
without an explicit CID/repository bearer it returns 401. Shared product API
keys, Access assertions, arbitrary CID/org headers and email addresses are not
client identities. The central authority authenticates every call and applies
current CID org membership, Labyrinth roles, CID consent and the client LBRNTH
paid entitlement. Existing API authentication is unchanged.

Sign in to the authoritative Cumulus ID host using its existing passkey/MFA/social/
SSO flow. Its authenticated `consent` operation records user-selected repo scopes;
client org onboarding/paid-plan approval remain trusted operator operations.
From the direct CID session, `sessionToken()` obtains a 15-minute repository-only
bearer linked to parent-session revocation. It cannot log in to other CID apps,
renew itself or grant consent. Keep it in memory, not URLs/logs/localStorage.
The cross-origin popup/PKCE login GUI is a follow-on, not supplied by this SDK.

## Where it runs

- `architect serve` (local and desktop) and the hosted Worker (rchtch.app) both serve
  `POST /api/labyrinth` through the same relay (`src/labyrinth/proxy.ts`). Both answer 503
  until the operator sets `LBRNTH_ENDPOINT` (a Worker var or secret, a local env var).
- `GET /v1/models` reports `labyrinth: true` when it is configured, so the app knows to offer it.

## Save to Labyrinth in the app

A finished run shows a **Save to Labyrinth** button when Labyrinth is configured. Only when the
person clicks it, the app:

1. takes their own Cumulus://ID session (`window.CumulusID.token()`, from the sign-in button;
   if they are not signed in it starts sign-in instead),
2. exchanges it once for the 15-minute repository-only bearer (`token`), kept in memory only,
3. finds or creates their private `architect` repository,
4. saves `runs/<run id>.json` on `main` against the branch head it just read
   (one retry if the head moved; otherwise the conflict is reported, never overwritten).

The artifact (`kind: "architect.run"`) holds the task, status, plan, verdict, usage and the
walkthrough. The product API token is never sent to Labyrinth, and nothing is exported automatically.

## Saved runs in the app

The **Saved** tab in the side panel (or `/saved`) lists the runs saved to the person's `architect`
repository, newest save first, from the `main` history (`history`, up to 200 commits; older saves
still show from the head tree under their run id). Opening one `load`s that file at the branch head
and shows the task, outcome, plan and walkthrough; **Use this task** puts the task back in the
composer. Browsing is read-only and only touches the `architect` repository. Opening the tab while
signed out asks the person to sign in instead of starting sign-in on its own.

## Explicit save/load SDK

Import `createArchitectLabyrinth` from `src/labyrinth/index.js`
(also exported by the package root).
Configure `endpoint` as this product's `/api/labyrinth` and `token` as a callback
returning the current real Cumulus-issued repository credential. The SDK exposes
`repositories`, `createRepository`, `save`, `load`, `history` and `diff`.
Save requires the expected branch head (null only for an empty branch); conflicts
are not silently overwritten. The central service stores artifacts under
`products/architect/...`, validates logical paths and retains private version history.
HTTP artifacts are UTF-8 strings (JSON is suitable), not automatic binary uploads.

The relay pins product id `architect`, forwards only the explicit bearer and protocol
headers, caps bodies at 2 MiB, refuses redirects, requires HTTPS except loopback,
uses a 10-second upstream timeout and returns no-store responses. Copied
`client.ts`/`proxy.ts` files implement the shared Nexus `@infinitum/lbrnth-client`
wire contract without depending on an unpublished cross-repo package.

Only repository PRs are prepared: no deployment, production secret/config change,
public website edit or merge. The central service must be deployed/configured
separately with durable encrypted storage, a trusted CID directory and paid-plan
authority before this connection becomes live.
