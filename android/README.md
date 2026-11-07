# Conductor for Android

Native Android client for the Conductor Podium. Requires Android 8+ and a reachable **HTTPS Conductor execution server** built from this branch. This is a WebView client of the complete browser app, with native server setup, Android sharing, document import/export, navigation and connection errors. The execution engine runs on the server, not on the phone; background jobs continue when the app closes.

## Install and connect

1. Install the debug APK from the preview build. A debug build is for testing; Android may ask to allow installation from this source.
2. Open Conductor → Server settings → enter the HTTPS origin of your execution server, such as `https://conductor.example.com`. No path, query, credentials or fragment.
3. In the Podium header, open Connection settings and enter `ARCHITECT_API_TOKEN`. Model credentials remain server-side.
4. Compose and review a score, then start the performance. Approval prompts remain human decisions.

Share text from another Android app to Conductor to prefill an outcome; sharing never starts work automatically. Use Score library → Import to choose a JSON package with Android's document picker. Exports open Android's save-document picker (up to 2 MB). Clear session is available in Server settings. Server addresses are the only values persisted in native preferences; API tokens use the WebView tab's session storage. Shared text is sent to the configured engine in the initial HTTPS navigation, then removed from the address; avoid sharing secrets.

## Build

Install JDK 21 and Android SDK platform 35. From `android/`:

```sh
./gradlew assembleDebug testDebugUnitTest lintDebug bundleRelease
```

Outputs:

- `app/build/outputs/apk/debug/app-debug.apk`: signed, installable test build.
- `app/build/outputs/bundle/release/app-release.aab`: unsigned release bundle, requires owner signing before distribution.
- `app/build/reports/lint-results-debug.html`: lint report.

Release signing uses environment variables `CONDUCTOR_KEYSTORE`, `CONDUCTOR_STORE_PASSWORD`, `CONDUCTOR_KEY_ALIAS`, and `CONDUCTOR_KEY_PASSWORD`. Supply the keystore outside the repository. Without them the release bundle is unsigned. No Play Store submission or production release is performed by this project.

The app rejects cleartext and invalid certificates, blocks mixed content, disables file access and third-party cookies, and keeps navigation on the chosen server origin. External HTTPS links require confirmation before opening a browser. There is no native JavaScript interface. Build/lint/unit checks do not substitute for testing on a physical device, including document pickers and background/resume behavior.
