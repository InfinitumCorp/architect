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
