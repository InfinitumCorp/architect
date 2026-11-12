#!/usr/bin/env bash
# Plain-JVM unit tests for the Android app's Android-free classes (no Android SDK needed).
#   bash android/test.sh
# Needs a JDK (11+) and, the first time, Maven Central for JUnit 4 and org.json (checked by SHA-256).
set -euo pipefail
cd "$(dirname "$0")"
LIB=build/test-libs
OUT=build/test-classes
mkdir -p "$LIB"
fetch() { # path sha256
  local f="$LIB/$(basename "$1")"
  if [ ! -f "$f" ]; then
    curl -fsSL --retry 4 --retry-all-errors -o "$f.part" "https://repo1.maven.org/maven2/$1"
    mv "$f.part" "$f"
  fi
  echo "$2  $f" | sha256sum -c --quiet - || { rm -f "$f"; echo "checksum mismatch: $f" >&2; exit 1; }
}
fetch junit/junit/4.13.2/junit-4.13.2.jar 8e495b634469d64fb8acfa3495a065cbacc8a0fff55ce1e31007be4c16dc57d3
fetch org/hamcrest/hamcrest-core/1.3/hamcrest-core-1.3.jar 66fdef91e9739348df7a096aa384a5685f4e875584cce89386a7a47251c4d8e9
fetch org/json/json/20250517/json-20250517.jar 3ea61b2a06e31edf1c91134fe9106b0ebb16628be169f3db75bc7a2b06b45796
CP="$LIB/junit-4.13.2.jar:$LIB/hamcrest-core-1.3.jar:$LIB/json-20250517.jar"
rm -rf "$OUT" && mkdir -p "$OUT"
# Only the classes with no Android imports; MainActivity needs android.jar (build.sh).
javac -encoding UTF-8 -Xlint:-options --release 11 -classpath "$CP" -d "$OUT" \
  src/com/infinitum/architect/CidIdToken.java $(find test -name '*.java')
java -cp "$OUT:$CP" org.junit.runner.JUnitCore $(cd test && find . -name '*Test.java' | sed 's|^\./||; s|\.java$||; s|/|.|g')
