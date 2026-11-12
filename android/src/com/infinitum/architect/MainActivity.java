package com.infinitum.architect;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.util.Base64;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;

/**
 * :\ARCHITECT\ for Android. A native shell around the web app (https://rchtch.app, or your own
 * `architect serve`).
 *
 * People sign in with Cumulus ID (id.cumuluscloud.app), never with a pasted token: the app opens
 * Cumulus ID in a Custom Tab (OAuth 2.0 code + PKCE S256), the sign-in page also offers "Create a
 * Cumulus ID", and https://rchtch.app/cid-return.html hands the one-time code back over
 * architect://cid. The code is useless without the verifier, which never leaves the app. The
 * session then rides into the web app once, in the URL fragment.
 */
public class MainActivity extends Activity {
    private static final int BG = Color.WHITE;
    private static final int LINE = Color.parseColor("#d6dce1");
    private static final int TEXT = Color.parseColor("#111820");
    private static final int DIM = Color.parseColor("#52606b");
    private static final int ACCENT = Color.parseColor("#111820");

    private static final String CID_CLIENT = "architect";
    private static final String DEFAULT_ISSUER = "https://id.cumuluscloud.app";
    private static final String CID_RETURN = "https://rchtch.app/cid-return.html?to=android";
    private static final String DEFAULT_SERVER = "https://rchtch.app";

    private FrameLayout root;
    private WebView web;
    private SharedPreferences prefs;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("architect", MODE_PRIVATE);
        // The pasted API token is gone; forget any saved one.
        if (prefs.contains("token")) prefs.edit().remove("token").apply();
        getWindow().setStatusBarColor(BG);
        getWindow().setNavigationBarColor(BG);

        root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        applyInsets(root);
        setContentView(root);

        // The decor view exists only after setContentView; asking for the insets controller earlier crashes.
        if (Build.VERSION.SDK_INT >= 30) {
            android.view.WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) c.setSystemBarsAppearance(
                android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS,
                android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);
        } else if (Build.VERSION.SDK_INT >= 26) {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        }

        if (!handleReturn(getIntent())) start();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleReturn(intent);
    }

    private void start() {
        if (signedIn()) openWebApp(server());
        else showSignIn(null);
    }

    private String server() {
        return prefs.getString("server", DEFAULT_SERVER);
    }

    /** Cumulus ID issuer; a mirror reachable from Russia without a VPN can be set as "cid_issuer". */
    private String issuer() {
        String v = prefs.getString("cid_issuer", DEFAULT_ISSUER);
        return (v.startsWith("https://") ? v : DEFAULT_ISSUER).replaceAll("/+$", "");
    }

    private boolean signedIn() {
        return !prefs.getString("cid_token", "").isEmpty() && prefs.getLong("cid_until", 0) > System.currentTimeMillis() + 60_000;
    }

    /** Android 15 draws apps edge to edge: keep content clear of the status bar, navigation bar and keyboard. */
    private void applyInsets(View v) {
        if (Build.VERSION.SDK_INT < 30) return;
        v.setOnApplyWindowInsetsListener((view, insets) -> {
            Insets b = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime() | WindowInsets.Type.displayCutout());
            view.setPadding(b.left, b.top, b.right, b.bottom);
            return WindowInsets.CONSUMED;
        });
    }

    private int dp(float v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    private TextView label(String text, int color, float size, boolean mono) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextColor(color);
        t.setTextSize(size);
        if (mono) t.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        return t;
    }

    private Button button(String text, boolean primary) {
        Button b = new Button(this);
        b.setText(text);
        b.setAllCaps(false);
        b.setTextSize(16);
        b.setContentDescription(text);
        b.setTextColor(primary ? Color.WHITE : TEXT);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(primary ? ACCENT : BG);
        bg.setStroke(dp(1), ACCENT);
        b.setBackground(bg);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52));
        lp.topMargin = dp(12);
        b.setLayoutParams(lp);
        return b;
    }

    /** Signed out: Sign in with Cumulus ID, or create one in the same flow. */
    private void showSignIn(String note) {
        if (web != null) {
            web.destroy();
            web = null;
        }
        root.removeAllViews();
        ScrollView scroll = new ScrollView(this);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(24), dp(32), dp(24), dp(24));
        box.setGravity(Gravity.TOP);
        scroll.addView(box);

        box.addView(label(":\\ARCHITECT\\™", ACCENT, 26, true));
        TextView tag = label("Describe an outcome. Architect plans it, does it, and proves it is done.", DIM, 14, false);
        tag.setPadding(0, dp(6), 0, dp(24));
        box.addView(tag);

        box.addView(label("Sign in with your Cumulus ID. No Cumulus ID yet? Create one here; you come straight back signed in.", TEXT, 15, false));

        Button signIn = button("Sign in with Cumulus ID", true);
        LinearLayout.LayoutParams first = (LinearLayout.LayoutParams) signIn.getLayoutParams();
        first.topMargin = dp(20);
        signIn.setOnClickListener(v -> startSignIn(false));
        box.addView(signIn);

        Button create = button("Create a Cumulus ID", false);
        create.setOnClickListener(v -> startSignIn(true));
        box.addView(create);

        if (note != null) {
            TextView n = label(note, TEXT, 14, false);
            n.setPadding(0, dp(16), 0, 0);
            box.addView(n);
        }

        // Where the web app lives: rchtch.app, or your own `architect serve`. Not a credential.
        TextView serverLabel = label("Architect server", DIM, 13, false);
        serverLabel.setPadding(0, dp(36), 0, 0);
        box.addView(serverLabel);
        final EditText server = new EditText(this);
        server.setText(server());
        server.setHint(DEFAULT_SERVER);
        server.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        server.setSingleLine(true);
        server.setTextColor(TEXT);
        server.setHintTextColor(DIM);
        server.setTextSize(15);
        server.setContentDescription("Architect server address");
        server.setOnFocusChangeListener((v, has) -> {
            if (!has) saveServer(server.getText().toString());
        });
        box.addView(server);
        signIn.setOnClickListener(v -> { saveServer(server.getText().toString()); startSignIn(false); });
        create.setOnClickListener(v -> { saveServer(server.getText().toString()); startSignIn(true); });

        root.addView(scroll, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void saveServer(String raw) {
        String s = raw.trim().replaceAll("/+$", "");
        if (s.isEmpty()) s = DEFAULT_SERVER;
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "https://" + s;
        prefs.edit().putString("server", s).apply();
    }

    private static String b64url(byte[] bytes) {
        return Base64.encodeToString(bytes, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }

    private static String random(int n) {
        byte[] b = new byte[n];
        new SecureRandom().nextBytes(b);
        return b64url(b);
    }

    /** Opens Cumulus ID in a Custom Tab (Chrome) or the browser. */
    private void startSignIn(boolean create) {
        try {
            String verifier = random(48);
            String state = random(16);
            String challenge = b64url(MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII)));
            // Kept in prefs: Android may stop this process while the browser is in front.
            prefs.edit().putString("cid_verifier", verifier).putString("cid_state", state).apply();
            Uri.Builder u = Uri.parse(issuer() + "/api/id/authorize").buildUpon()
                .appendQueryParameter("client_id", CID_CLIENT)
                .appendQueryParameter("redirect_uri", CID_RETURN)
                .appendQueryParameter("code_challenge", challenge)
                .appendQueryParameter("code_challenge_method", "S256")
                .appendQueryParameter("state", state);
            if (create) u.appendQueryParameter("prompt", "create");
            Intent i = new Intent(Intent.ACTION_VIEW, u.build());
            // Custom Tab without the support library: the session extra is what turns it on.
            Bundle extras = new Bundle();
            extras.putBinder("android.support.customtabs.extra.SESSION", null);
            i.putExtras(extras);
            i.putExtra("android.support.customtabs.extra.TOOLBAR_COLOR", BG);
            startActivity(i);
        } catch (ActivityNotFoundException e) {
            showSignIn("No browser is installed to sign in with.");
        } catch (Exception e) {
            showSignIn("Sign-in could not start: " + e.getMessage());
        }
    }

    /** architect://cid?code&state from the return page. Returns true when it was one. */
    private boolean handleReturn(Intent intent) {
        Uri data = intent == null ? null : intent.getData();
        if (data == null || !"architect".equals(data.getScheme()) || !"cid".equals(data.getHost())) return false;
        intent.setData(null);
        final String code = data.getQueryParameter("code");
        String state = data.getQueryParameter("state");
        final String verifier = prefs.getString("cid_verifier", "");
        String expected = prefs.getString("cid_state", "");
        prefs.edit().remove("cid_verifier").remove("cid_state").apply();
        if (code == null || verifier.isEmpty() || expected.isEmpty() || !expected.equals(state)) {
            String err = data.getQueryParameter("error");
            showSignIn(err != null ? err : "That sign-in didn't match. Please try again.");
            return true;
        }
        showSignIn("Signing in…");
        new Thread(() -> {
            try {
                JSONObject body = new JSONObject()
                    .put("code", code)
                    .put("code_verifier", verifier)
                    .put("client_id", CID_CLIENT)
                    .put("redirect_uri", CID_RETURN);
                HttpURLConnection c = (HttpURLConnection) new URL(issuer() + "/api/id/token").openConnection();
                c.setRequestMethod("POST");
                c.setConnectTimeout(20_000);
                c.setReadTimeout(20_000);
                c.setDoOutput(true);
                c.setRequestProperty("content-type", "application/json");
                c.setRequestProperty("accept", "application/json");
                try (OutputStream o = c.getOutputStream()) {
                    o.write(body.toString().getBytes(StandardCharsets.UTF_8));
                }
                int status = c.getResponseCode();
                JSONObject res = new JSONObject(read(status < 400 ? c.getInputStream() : c.getErrorStream()));
                String token = res.optString("access_token", "");
                if (status >= 400 || token.isEmpty()) throw new Exception(res.optString("error", "Cumulus ID answered " + status));
                JSONObject profile = res.optJSONObject("profile");
                long until = System.currentTimeMillis() + res.optLong("expires_in", 3600) * 1000;
                prefs.edit()
                    .putString("cid_token", token)
                    .putString("cid_profile", profile == null ? "{}" : profile.toString())
                    .putLong("cid_until", until)
                    .apply();
                runOnUiThread(() -> openWebApp(server()));
            } catch (Exception e) {
                runOnUiThread(() -> showSignIn("Sign-in failed: " + e.getMessage()));
            }
        }).start();
        return true;
    }

    private static String read(InputStream in) throws java.io.IOException {
        if (in == null) return "{}";
        try (InputStream s = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            for (int n; (n = s.read(buf)) > 0; ) out.write(buf, 0, n);
            String text = out.toString("UTF-8");
            return text.trim().startsWith("{") ? text : "{}";
        }
    }

    private void signOut(String note) {
        final String token = prefs.getString("cid_token", "");
        prefs.edit().remove("cid_token").remove("cid_profile").remove("cid_until").apply();
        if (!token.isEmpty()) new Thread(() -> {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(issuer() + "/api/id/signout").openConnection();
                c.setRequestMethod("POST");
                c.setRequestProperty("authorization", "Bearer " + token);
                c.getResponseCode();
            } catch (Exception ignored) {
                // Signed out on this phone either way.
            }
        }).start();
        showSignIn(note);
    }

    private void openWebApp(final String server) {
        if (!signedIn()) {
            showSignIn(null);
            return;
        }
        root.removeAllViews();
        web = new WebView(this);
        web.setBackgroundColor(BG);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        // Tells the web app it runs inside this app, so it accepts the session handed over below.
        s.setUserAgentString(s.getUserAgentString() + " ArchitectShell/android");
        final String issuer = issuer();
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                String url = u.toString();
                // The web app's own Cumulus ID buttons: sign in, out or create natively instead.
                if (url.startsWith(issuer + "/api/id/authorize")) {
                    startSignIn("create".equals(u.getQueryParameter("prompt")));
                    return true;
                }
                if (url.startsWith(issuer + "/api/id/end")) {
                    signOut("Signed out.");
                    return true;
                }
                // Stay inside the app for the Architect server; open anything else in the browser.
                if (url.startsWith(server)) return false;
                startActivity(new Intent(Intent.ACTION_VIEW, u));
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) {
                    showSignIn("Could not reach " + server + " (" + err.getDescription() + "). Check the address and your connection.");
                }
            }
        });
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        String handoff;
        try {
            JSONObject h = new JSONObject()
                .put("token", prefs.getString("cid_token", ""))
                .put("profile", new JSONObject(prefs.getString("cid_profile", "{}")))
                .put("until", prefs.getLong("cid_until", 0));
            handoff = b64url(h.toString().getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            handoff = "";
        }
        web.loadUrl(server + "/" + (handoff.isEmpty() ? "" : "#cid_handoff=" + handoff));
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }
}
