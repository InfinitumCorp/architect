// :\ARCHITECT\ for Android. One module; sources stay in src/, res/ and test/.
//   ./gradlew assembleDebug        -> build/outputs/apk/debug/architect-debug.apk
//   ./gradlew testDebugUnitTest    -> JVM tests for CidIdToken (no device needed)
plugins {
    id("com.android.application") version "8.13.2"
}

android {
    namespace = "com.infinitum.architect"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.infinitum.architect"
        minSdk = 24
        targetSdk = 35
        versionCode = 4
        versionName = "0.4.0"
    }

    sourceSets {
        getByName("main") {
            manifest.srcFile("AndroidManifest.xml")
            java.srcDirs("src")
            res.srcDirs("res")
        }
        getByName("test") {
            java.srcDirs("test")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        abortOnError = true
    }
}

base {
    archivesName.set("architect")
}

dependencies {
    // Official Amplitude Android SDK (Maven Central). Page views (screen views) and sessions only.
    implementation("com.amplitude:analytics-android:1.37.1")

    testImplementation("junit:junit:4.13.2")
    // The real org.json: android.jar only has stubs on the JVM.
    testImplementation("org.json:json:20250517")
}

tasks.withType<JavaCompile>().configureEach {
    options.compilerArgs.add("-Xlint:deprecation")
}
