package com.infinitum.architect;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
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
import android.widget.TextView;

/**
 * :\ARCHITECT\ for Android. A native shell around the Podium served by `architect serve`.
 * The phone reaches the server over USB (adb reverse tcp:7337 tcp:7337, then http://localhost:7337)
 * or the local network (http://<computer-ip>:7337). The API token stays on the device.
 */
public class MainActivity extends Activity {
    private static final int BG = Color.WHITE;
    private static final int PANEL = Color.parseColor("#f5f5f5");
    private static final int LINE = Color.parseColor("#e4e4e4");
    private static final int TEXT = Color.BLACK;
    private static final int DIM = Color.parseColor("#6e6e6e");
    private static final int ACCENT = Color.BLACK;
    private static final int BAD = Color.parseColor("#c62828");

    private FrameLayout root;
    private WebView web;
    private SharedPreferences prefs;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("architect", MODE_PRIVATE);
        getWindow().setStatusBarColor(BG);
        getWindow().setNavigationBarColor(BG);
        if (Build.VERSION.SDK_INT >= 30) {
            android.view.WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) c.setSystemBarsAppearance(
                android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS,
                android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);
        } else if (Build.VERSION.SDK_INT >= 26) {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        }

        root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        applyInsets(root);
        setContentView(root);

        String server = prefs.getString("server", null);
        if (server == null) showSetup(null);
        else openPodium(server, prefs.getString("token", ""));
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

    private EditText field(String hint, String value, int type) {
        EditText e = new EditText(this);
        e.setHint(hint);
        e.setText(value);
        e.setInputType(type);
        e.setSingleLine(true);
        e.setTextColor(TEXT);
        e.setHintTextColor(DIM);
        e.setTextSize(16);
        e.setBackgroundColor(PANEL);
        e.setPadding(dp(14), dp(12), dp(14), dp(12));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(10);
        e.setLayoutParams(lp);
        return e;
    }

    private TextView label(String text, int color, float size, boolean mono) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextColor(color);
        t.setTextSize(size);
        if (mono) t.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        return t;
    }

    /** First run, or the server could not be reached: ask where the Architect server is. */
    private void showSetup(String error) {
        if (web != null) {
            web.destroy();
            web = null;
        }
        root.removeAllViews();
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(24), dp(32), dp(24), dp(24));
        box.setGravity(Gravity.TOP);

        box.addView(label(":\\ARCHITECT\\™", ACCENT, 26, true));
        TextView tag = label("Describe an outcome. Architect plans it, does it, and proves it is done.", DIM, 14, false);
        tag.setPadding(0, dp(6), 0, dp(20));
        box.addView(tag);

        box.addView(label("Architect server", TEXT, 14, false));
        final EditText server = field("http://localhost:7337", prefs.getString("server", "http://localhost:7337"), InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        server.setContentDescription("Architect server address");
        box.addView(server);

        TextView tokenLabel = label("API token (if the server has one)", TEXT, 14, false);
        tokenLabel.setPadding(0, dp(16), 0, 0);
        box.addView(tokenLabel);
        final EditText token = field("ARCHITECT_API_TOKEN", prefs.getString("token", ""), InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        token.setContentDescription("API token");
        box.addView(token);

        if (error != null) {
            TextView err = label(error, BAD, 14, false);
            err.setPadding(0, dp(14), 0, 0);
            box.addView(err);
        }

        Button connect = new Button(this);
        connect.setText("Connect");
        connect.setAllCaps(false);
        connect.setTextSize(16);
        connect.setTextColor(Color.WHITE);
        connect.setBackgroundColor(ACCENT);
        connect.setContentDescription("Connect");
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52));
        lp.topMargin = dp(22);
        connect.setLayoutParams(lp);
        connect.setOnClickListener(v -> {
            String s = server.getText().toString().trim().replaceAll("/+$", "");
            if (!s.startsWith("http://") && !s.startsWith("https://")) s = "http://" + s;
            String t = token.getText().toString().trim();
            prefs.edit().putString("server", s).putString("token", t).apply();
            openPodium(s, t);
        });
        box.addView(connect);

        TextView help = label(
            "Start the server on your computer with  architect serve\n\n"
                + "Over USB: run  adb reverse tcp:7337 tcp:7337  and use http://localhost:7337\n"
                + "Over Wi-Fi: use http://<your computer's IP>:7337",
            DIM, 13, false);
        help.setPadding(0, dp(22), 0, 0);
        box.addView(help);

        root.addView(box, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void openPodium(final String server, String token) {
        root.removeAllViews();
        web = new WebView(this);
        web.setBackgroundColor(BG);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                // Stay inside the app for the Architect server; open anything else in the browser.
                if (u.toString().startsWith(server)) return false;
                startActivity(new Intent(Intent.ACTION_VIEW, u));
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) {
                    showSetup("Could not reach " + server + " (" + err.getDescription() + "). Is `architect serve` running?");
                }
            }
        });
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        String url = server + "/" + (token.isEmpty() ? "" : "?token=" + Uri.encode(token));
        web.loadUrl(url);
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else if (web != null) showSetup(null);
        else super.onBackPressed();
    }
}
