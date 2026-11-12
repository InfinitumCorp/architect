package com.infinitum.architect;

import android.app.Application;

import com.amplitude.android.Amplitude;
import com.amplitude.android.AutocaptureOption;
import com.amplitude.android.Configuration;
import com.amplitude.android.TrackingOptions;
import com.amplitude.core.ServerZone;

import java.util.EnumSet;

/**
 * Starts Amplitude once per process, with the Infinitum privacy defaults: screen views (page
 * views) and sessions only; no element, form or frustration autocapture; no session replay;
 * IP address, city, DMA, latitude/longitude and advertising IDs off; remote config off; US region.
 * Only the public API key ships in the app ({@link AmplitudeConfig}).
 */
public final class ArchitectApp extends Application {
    private static Amplitude amplitude;

    @Override
    public void onCreate() {
        super.onCreate();
        amplitude = new Amplitude(analyticsConfig(this));
    }

    /** The analytics client, or null before {@link #onCreate()}. */
    public static Amplitude analytics() {
        return amplitude;
    }

    // Every Java-callable short Configuration constructor is a Kotlin @JvmOverloads bridge that the
    // SDK marks deprecated (it still carries the old defaultTracking parameter); the setters below
    // are the supported way to configure it from Java.
    @SuppressWarnings("deprecation")
    static Configuration analyticsConfig(Application app) {
        Configuration config = new Configuration(AmplitudeConfig.API_KEY, app.getApplicationContext());
        config.setServerZone(ServerZone.US);
        config.setAutocapture(EnumSet.of(AutocaptureOption.SESSIONS, AutocaptureOption.SCREEN_VIEWS));
        config.setTrackingOptions(new TrackingOptions()
                .disableIpAddress()
                .disableCity()
                .disableDma()
                .disableLatLng()
                .disableAdid()
                .disableAppSetId());
        config.setLocationListening(false);
        config.setUseAdvertisingIdForDeviceId(false);
        config.setUseAppSetIdForDeviceId(false);
        config.setEnableAutocaptureRemoteConfig(false);
        config.setEnableDiagnostics(false);
        return config;
    }
}
