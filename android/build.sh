#!/usr/bin/env bash
# Build the Architect Android app without Gradle, using the Android SDK's own tools.
#   bash android/build.sh            -> android/build/architect.apk (debug-signed)
# Needs: ANDROID_HOME (platforms/android-36, build-tools/36.0.0) and a JDK on PATH.
set -euo pipefail
cd "$(dirname "$0")"
SDK="${ANDROID_HOME:?set ANDROID_HOME}"
BT="$SDK/build-tools/${BUILD_TOOLS:-36.0.0}"
JAR="$SDK/platforms/${PLATFORM:-android-36}/android.jar"
OUT=build
# Windows ships some tools as .bat files.
tool() { if [ -f "$BT/$1.bat" ]; then echo "$BT/$1.bat"; else echo "$BT/$1"; fi; }
D8=$(tool d8); APKSIGNER=$(tool apksigner)
rm -rf "$OUT" && mkdir -p "$OUT/res" "$OUT/classes" "$OUT/dex"

echo "1/5 resources"
"$BT/aapt2" compile --dir res -o "$OUT/res"
"$BT/aapt2" link -I "$JAR" --manifest AndroidManifest.xml -o "$OUT/base.apk" "$OUT"/res/*.flat --min-sdk-version 24 --target-sdk-version 35

echo "2/5 compile"
javac -source 11 -target 11 -Xlint:-options -encoding UTF-8 -classpath "$JAR" -d "$OUT/classes" $(find src -name '*.java')

echo "3/5 dex"
"$D8" --release --min-api 24 --lib "$JAR" --output "$OUT/dex" $(find "$OUT/classes" -name '*.class')

echo "4/5 package"
(cd "$OUT/dex" && "$BT/aapt" add ../base.apk classes.dex >/dev/null)
"$BT/zipalign" -f -p 4 "$OUT/base.apk" "$OUT/aligned.apk"

echo "5/5 sign"
KS="${ARCHITECT_KEYSTORE:-$HOME/.android/debug.keystore}"
"$APKSIGNER" sign --ks "$KS" --ks-pass "pass:${ARCHITECT_KS_PASS:-android}" --ks-key-alias "${ARCHITECT_KS_ALIAS:-androiddebugkey}" \
  --out "$OUT/architect.apk" "$OUT/aligned.apk"
"$APKSIGNER" verify "$OUT/architect.apk"
echo "built $(pwd)/$OUT/architect.apk"
