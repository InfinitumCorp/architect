#!/usr/bin/env bash
# Build the Architect Android app without Gradle, using the Android SDK's own tools.
#   bash android/build.sh            -> android/build/architect.apk (debug-signed)
# Needs: ANDROID_HOME (platforms/android-36, build-tools/36.0.0), a JDK, curl and python on PATH.
# Amplitude's official Android SDK and its runtime deps are fetched (SHA-256 pinned) into .deps/.
set -euo pipefail
cd "$(dirname "$0")"
SDK="${ANDROID_HOME:?set ANDROID_HOME}"
BT="$SDK/build-tools/${BUILD_TOOLS:-36.0.0}"
JAR="$SDK/platforms/${PLATFORM:-android-36}/android.jar"
OUT=build
# Windows ships some tools as .bat files.
tool() { if [ -f "$BT/$1.bat" ]; then echo "$BT/$1.bat"; else echo "$BT/$1"; fi; }
D8=$(tool d8); APKSIGNER=$(tool apksigner)
bash scripts/fetch-deps.sh
DEPS=$(ls .deps/jars/*.jar)
# javac wants the platform's path separator (';' on Windows).
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) SEP=';';; *) SEP=':';; esac
CP="$JAR$SEP$(echo $DEPS | tr ' ' "$SEP")"
rm -rf "$OUT" && mkdir -p "$OUT/res" "$OUT/classes" "$OUT/dex"

echo "1/5 resources"
"$BT/aapt2" compile --dir res -o "$OUT/res"
# androidx.startup and lifecycle-runtime read their own R classes at runtime (InitializationProvider
# uses androidx.startup.R$string). Without Gradle there is no resource merge, so compile their
# res/ from the AARs and have aapt2 generate R classes for those packages too.
mkdir -p "$OUT/libres" "$OUT/gen"
for aar in startup-runtime lifecycle-runtime; do
  rm -rf "$OUT/x-$aar" && mkdir -p "$OUT/x-$aar"
  (cd "$OUT/x-$aar" && jar xf "../../.deps/dl/$aar.aar" res)
  mkdir -p "$OUT/libres/$aar"; [ -d "$OUT/x-$aar/res" ] && "$BT/aapt2" compile --dir "$OUT/x-$aar/res" -o "$OUT/libres/$aar"
done
"$BT/aapt2" link -I "$JAR" --manifest AndroidManifest.xml -o "$OUT/base.apk" "$OUT"/res/*.flat "$OUT"/libres/*/*.flat   --java "$OUT/gen" --extra-packages androidx.startup:androidx.lifecycle.runtime --min-sdk-version 24 --target-sdk-version 35

echo "2/5 compile"
javac -source 11 -target 11 -Xlint:-options -encoding UTF-8 -classpath "$CP" -d "$OUT/classes" $(find src "$OUT/gen" -name '*.java')

echo "3/5 dex"
"$D8" --release --min-api 24 --lib "$JAR" --output "$OUT/dex" $(find "$OUT/classes" -name '*.class') $DEPS

echo "4/5 package"
(cd "$OUT/dex" && "$BT/aapt" add ../base.apk classes*.dex >/dev/null)
# kotlinx-coroutines finds its Android main dispatcher through META-INF/services.
(cd .deps/meta && "$BT/aapt" add ../../"$OUT"/base.apk $(find META-INF -type f) >/dev/null)
"$BT/zipalign" -f -p 4 "$OUT/base.apk" "$OUT/aligned.apk"

echo "5/5 sign"
KS="${ARCHITECT_KEYSTORE:-$HOME/.android/debug.keystore}"
"$APKSIGNER" sign --ks "$KS" --ks-pass "pass:${ARCHITECT_KS_PASS:-android}" --ks-key-alias "${ARCHITECT_KS_ALIAS:-androiddebugkey}" \
  --out "$OUT/architect.apk" "$OUT/aligned.apk"
"$APKSIGNER" verify "$OUT/architect.apk"
echo "built $(pwd)/$OUT/architect.apk"
