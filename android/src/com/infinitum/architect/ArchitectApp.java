package com.infinitum.architect;

import android.app.Application;

import com.amplitude.android.Amplitude;
import com.amplitude.android.AutocaptureOption;
import com.amplitude.android.Configuration;
import com.amplitude.android.TrackingOptions;
import com.amplitude.core.ServerZone;

import java.util.EnumSet;

/**
 * Starts Amplitude (official analytics-android SDK, vendored by scripts/fetch-deps.sh) before the
 * first screen, so the app open and the session are both seen.
 *
 * Privacy: public API key only, US region, sessions and screen views only. No element or form
 * autocapture, no session replay, no remote config, no diagnostics, no IP address, city, DMA,
 * lat/lng, advertising ID or app set ID, no location listening. Never identifies the person.
 */
public class ArchitectApp extends Application {
    /** Public (client) API key. The Amplitude secret key never ships in an app. */
    private static final String AMPLITUDE_API_KEY = "756c0bc80c5cb27386bfd7b2b13196c8";

    @Override
    public void onCreate() {
        super.onCreate();
        try {
            Configuration c = new Configuration(AMPLITUDE_API_KEY, getApplicationContext());
            c.setServerZone(ServerZone.US);
            c.setAutocapture(EnumSet.of(AutocaptureOption.SESSIONS, AutocaptureOption.SCREEN_VIEWS));
            c.setTrackingOptions(new TrackingOptions()
                .disableIpAddress()
                .disableCity()
                .disableDma()
                .disableLatLng()
                .disableAdid()
                .disableAppSetId());
            c.setUseAdvertisingIdForDeviceId(false);
            c.setUseAppSetIdForDeviceId(false);
            c.setLocationListening(false);
            c.setEnableDiagnostics(false);
            c.setEnableAutocaptureRemoteConfig(false);
            new Amplitude(c);
        } catch (Throwable ignored) {
            // Analytics must never stop the app from starting.
        }
    }
}
