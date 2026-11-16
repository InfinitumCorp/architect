# Mixpanel on rchtch.app

Mixpanel for Startups: 1 year free, up to 1B events/yr. Data must start flowing by about 12 Feb 2027.

- `web/index.html` loads `/mixpanel.vendor.js` (first-party, no CDN) and `/mixpanel-boot.js`. The Worker (and `architect serve`)
  generates the boot script from `MIXPANEL_PROJECT_TOKEN` (+ `MIXPANEL_REGION`, `MIXPANEL=off`). Without a token it is a comment.
- Set the token as a Worker var or secret (`wrangler secret put MIXPANEL_PROJECT_TOKEN`). Only with William's OK.
- Sends one `$mp_web_page_view` per load with `product: "architect"`, domain and path. No autocapture, replay, IP geolocation,
  full URLs, query strings, referrers or UTM. Honors Global Privacy Control. Skipped in the Android app (native Amplitude counts there).
- The Chrome extension gets no analytics. Rebuild the vendor file: `scripts/mixpanel-vendor/README.md`.
