# Mixpanel vendor bundle

`public/mixpanel.vendor.js` is built from `init.mjs` (privacy-first options) and mixpanel-browser 2.85.0's
core build (Apache-2.0, no session-replay recorder). It is served first-party; nothing loads from a Mixpanel CDN.

Rebuild:

    cd scripts/mixpanel-vendor
    npm i --no-save mixpanel-browser@2.85.0
    npx esbuild vendor-entry.mjs --bundle --minify --format=iife --target=es2018 --legal-comments=inline --outfile=../../web/mixpanel.vendor.js

Options: one page view per load (domain + path; `$current_url`, query string and referrers are dropped) and sessions only. `autocapture: false`, `ip: false`,
`record_sessions_percent: 0`, no UTM/referrer capture, no feature flags, no remote settings, localStorage
(no cookies). Off when the token is missing, `MIXPANEL=off` at build time, Global Privacy Control is on,
or the page runs inside the Android app shell (ArchitectShell/android, where the native Amplitude SDK counts).
