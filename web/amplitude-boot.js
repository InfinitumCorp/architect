/* Public Amplitude API key (not the Secret key). Boots the vendored Browser SDK.
   Inside the Android app (user agent "ArchitectShell/android") the native Amplitude Android SDK
   already counts screen views and sessions, so the web SDK stays off there to avoid counting twice. */
if (typeof initInfinitumAmplitude === "function" && !/\bArchitectShell\/android\b/.test(navigator.userAgent)) {
  initInfinitumAmplitude('756c0bc80c5cb27386bfd7b2b13196c8');
}
