# Conductor preview builds

[Download Android debug APK](conductor-debug.apk?raw=true) · [Unsigned release AAB](conductor-release-unsigned.aab?raw=true) · [Desktop screenshot](conductor-desktop.png) · [Mobile screenshot](conductor-mobile.png)

Signed debug APK for testing, Android 8+. Android uses the browser UI in a native WebView client and connects to your HTTPS execution server. Configure that origin in Server settings, then enter its API token in Podium connection settings. See [Android setup](../android/README.md) and [Browser setup](../BROWSER.md).

Built from source commit deb9506. Fifty browser/backend tests and three Android unit tests pass; TypeScript build/typecheck, Android build and Android lint pass. APK signature verified. No physical-device test was run. The release AAB is unsigned and requires owner signing.

These small build artifacts are on a separate build branch because GitHub's upload endpoint rejected the configured credentials. Source remains in draft PR #3. Nothing was deployed or published to an app store.
