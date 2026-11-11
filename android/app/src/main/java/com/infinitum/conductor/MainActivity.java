package com.infinitum.conductor;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.util.Base64;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import java.io.OutputStream;
import org.json.JSONTokener;
import org.json.JSONObject;

/** Native Android shell. The engine remains on the configured HTTPS server. No JavaScript bridge. */
public class MainActivity extends Activity {
    private static final int CHOOSE_FILE = 41, SAVE_REPORT = 42;
    private static final int BG = Color.rgb(16,18,16), FG = Color.rgb(239,241,233), ACCENT = Color.rgb(218,251,128);
    private WebView web;
    private ProgressBar progress;
    private LinearLayout root;
    private String origin = "", pendingShare;
    private byte[] pendingDownload;
    private ValueCallback<Uri[]> fileCallback;
    private TextView error;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(BG); getWindow().setNavigationBarColor(BG);
        root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(BG);
        root.setOnApplyWindowInsetsListener((view,insets) -> {
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                view.setPadding(bars.left,bars.top,bars.right,bars.bottom);
            } else { view.setPadding(insets.getSystemWindowInsetLeft(),insets.getSystemWindowInsetTop(),insets.getSystemWindowInsetRight(),insets.getSystemWindowInsetBottom()); }
            return insets;
        });
        setContentView(root);
        LinearLayout bar = new LinearLayout(this); bar.setGravity(android.view.Gravity.CENTER_VERTICAL); bar.setPadding(dp(12),0,dp(6),0);
        TextView title = new TextView(this); title.setText("/C/   CONDUCTOR"); title.setTextColor(ACCENT); title.setTextSize(14); title.setTypeface(null,android.graphics.Typeface.BOLD);
        bar.addView(title,new LinearLayout.LayoutParams(0,dp(48),1));
        Button reload = new Button(this); reload.setText("↻"); reload.setContentDescription("Reload performance"); reload.setTextColor(FG); reload.setBackgroundColor(BG); reload.setOnClickListener(v -> { error.setVisibility(View.GONE); web.reload(); });
        bar.addView(reload,new LinearLayout.LayoutParams(dp(48),dp(48)));
        Button settings = new Button(this); settings.setText("⚙"); settings.setContentDescription("Server settings"); settings.setTextColor(FG); settings.setBackgroundColor(BG); settings.setOnClickListener(v -> configure());
        bar.addView(settings,new LinearLayout.LayoutParams(dp(48),dp(48))); root.addView(bar);
        progress = new ProgressBar(this,null,android.R.attr.progressBarStyleHorizontal); progress.setMax(100); progress.setProgressTintList(android.content.res.ColorStateList.valueOf(ACCENT)); root.addView(progress,new LinearLayout.LayoutParams(-1,dp(3)));
        error = new TextView(this); error.setTextColor(FG); error.setPadding(dp(20),dp(24),dp(20),dp(24)); error.setVisibility(View.GONE); root.addView(error);
        web = new WebView(this); web.setBackgroundColor(BG); root.addView(web,new LinearLayout.LayoutParams(-1,0,1));
        WebSettings ws = web.getSettings(); ws.setJavaScriptEnabled(true); ws.setDomStorageEnabled(true);
        ws.setAllowFileAccess(false); ws.setAllowContentAccess(false); ws.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        ws.setJavaScriptCanOpenWindowsAutomatically(false); ws.setSupportMultipleWindows(false); ws.setMediaPlaybackRequiresUserGesture(true); ws.setSafeBrowsingEnabled(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web,false);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                String target = req.getUrl().toString();
                if (ServerAddress.sameOrigin(origin,target)) return false;
                if (req.isForMainFrame() && "https".equalsIgnoreCase(req.getUrl().getScheme()) && req.hasGesture()) {
                    new AlertDialog.Builder(MainActivity.this).setTitle("Open external website?").setMessage(req.getUrl().getHost())
                        .setNegativeButton("Stay here",null).setPositiveButton("Open browser",(d,w) -> openExternal(req.getUrl())).show();
                }
                return true;
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError ssl) {
                handler.cancel(); showError("The server’s secure connection could not be verified. Check the server address and its certificate.");
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) showError("Cannot reach your execution engine. Your work continues on the server. Check your connection, then tap reload or change Server settings.");
            }
            @Override public void onPageFinished(WebView view,String url) { progress.setVisibility(View.GONE); }
            @Override public void onReceivedHttpError(WebView view,WebResourceRequest req,android.webkit.WebResourceResponse response) {
                if (req.isForMainFrame() && response.getStatusCode() >= 400) showError("The server returned HTTP " + response.getStatusCode() + ". Check Server settings or reload.");
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView v,int value) { progress.setVisibility(value < 100 ? View.VISIBLE : View.GONE); progress.setProgress(value); }
            @Override public boolean onShowFileChooser(WebView v,ValueCallback<Uri[]> callback,FileChooserParams params) {
                if (!ServerAddress.sameOrigin(origin,v.getUrl())) { callback.onReceiveValue(null); return true; }
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT); i.addCategory(Intent.CATEGORY_OPENABLE); i.setType("application/json");
                try { startActivityForResult(i,CHOOSE_FILE); } catch(ActivityNotFoundException e) { fileCallback.onReceiveValue(null); fileCallback = null; toast("No document picker is installed."); }
                return true;
            }
        });
        web.setDownloadListener((url,userAgent,disposition,mime,length) -> exportBlob(url));
        String saved = getPreferences(MODE_PRIVATE).getString("origin","");
        try { origin = ServerAddress.normalize(saved); } catch(IllegalArgumentException ignored) {}
        readShare(getIntent());
        if (origin.isEmpty()) configure(); else loadHome();
    }
    private int dp(int n) { return (int)(n * getResources().getDisplayMetrics().density); }
    private void showError(String message) { error.setText(message); error.setVisibility(View.VISIBLE); progress.setVisibility(View.GONE); }
    private void toast(String text) { Toast.makeText(this,text,Toast.LENGTH_LONG).show(); }
    private void openExternal(Uri uri) { try { startActivity(new Intent(Intent.ACTION_VIEW,uri)); } catch(ActivityNotFoundException e) { toast("No browser is installed."); } }
    private void readShare(Intent intent) {
        if (Intent.ACTION_SEND.equals(intent.getAction()) && "text/plain".equals(intent.getType())) {
            String text = intent.getStringExtra(Intent.EXTRA_TEXT); if (text != null) pendingShare = text.substring(0,Math.min(text.length(),10000));
        }
    }
    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); readShare(intent); if (!origin.isEmpty()) loadHome(); }
    private void loadHome() {
        error.setVisibility(View.GONE);
        Uri.Builder target = Uri.parse(origin).buildUpon(); if (pendingShare != null) { target.appendQueryParameter("intent",pendingShare); pendingShare = null; }
        web.loadUrl(target.build().toString());
    }
    private void configure() {
        LinearLayout content = new LinearLayout(this); content.setOrientation(LinearLayout.VERTICAL); content.setPadding(dp(24),dp(12),dp(24),dp(8));
        TextView description = new TextView(this); description.setText("Connect to your Conductor execution engine. Enter its HTTPS origin. Model credentials stay on your server. You’ll enter the API token inside the app."); content.addView(description);
        EditText address = new EditText(this); address.setSingleLine(true); address.setHint("https://conductor.example.com"); address.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI); address.setText(origin); content.addView(address);
        TextView validation = new TextView(this); validation.setTextColor(Color.rgb(180,40,40)); content.addView(validation);
        AlertDialog dlg = new AlertDialog.Builder(this).setTitle("Server settings").setView(content)
                .setNegativeButton("Cancel",null).setNeutralButton("Clear session",(d,w) -> clearSession())
                .setPositiveButton("Connect",null).create();
        dlg.setOnShowListener(x -> dlg.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            try {
                String next = ServerAddress.normalize(address.getText().toString());
                if (!next.equals(origin)) { web.loadUrl("about:blank"); web.clearHistory(); }
                origin = next; getPreferences(MODE_PRIVATE).edit().putString("origin",origin).apply(); dlg.dismiss(); loadHome();
            } catch(IllegalArgumentException e) { validation.setText(e.getMessage()); }
        }));
        dlg.show();
    }
    private void clearSession() {
        // Clear only this app's WebView data. No credentials are stored in native preferences.
        web.evaluateJavascript("sessionStorage.clear();localStorage.clear()", ignored -> {
            web.loadUrl("about:blank"); web.clearCache(true); web.clearHistory();
            android.webkit.WebStorage.getInstance().deleteAllData();
            CookieManager.getInstance().removeAllCookies(done -> {
                CookieManager.getInstance().flush();
                toast("Session cleared. Reopen Conductor to connect again."); finish();
            });
        });
    }
    private void exportBlob(String url) {
        if (!ServerAddress.sameOrigin(origin,web.getUrl()) || !url.startsWith("blob:" + origin.substring(0,origin.length()-1) + "/")) { toast("Only Conductor JSON exports can be saved here."); return; }
        String script = "(async()=>{try{const b=await(await fetch(" + JSONObject.quote(url) + ")).blob();if(b.size>2000000)return null;return await new Promise(r=>{const f=new FileReader();f.onload=()=>r(f.result);f.onerror=()=>r(null);f.readAsDataURL(b)})}catch{return null}})()";
        // evaluateJavascript does not await promises. Complete via polling a random, temporary DOM property, without a native bridge.
        final String key = "__conductorExport" + java.util.UUID.randomUUID().toString().replace("-","");
        web.evaluateJavascript("window[" + JSONObject.quote(key) + "]=null;(" + script + ").then(x=>window[" + JSONObject.quote(key) + "]=x||'error')",null);
        pollExport(key,0);
    }
    private void pollExport(String key,int attempt) {
        if (attempt > 40 || isFinishing()) { toast("Export timed out. Try again."); return; }
        web.postDelayed(() -> web.evaluateJavascript("window[" + JSONObject.quote(key) + "]",value -> {
            try {
                Object decoded = new JSONTokener(value).nextValue();
                if (!(decoded instanceof String)) { pollExport(key,attempt+1); return; }
                web.evaluateJavascript("delete window[" + JSONObject.quote(key) + "]",null);
                String data = (String)decoded;
                if (!data.startsWith("data:") || !data.contains(";base64,")) { toast("Could not export this file."); return; }
                pendingDownload = Base64.decode(data.substring(data.indexOf(',')+1),Base64.DEFAULT);
                if (pendingDownload.length > 2000000) { pendingDownload = null; toast("Export is too large."); return; }
                Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT); i.addCategory(Intent.CATEGORY_OPENABLE); i.setType("application/json"); i.putExtra(Intent.EXTRA_TITLE,"conductor-export.json"); startActivityForResult(i,SAVE_REPORT);
            } catch(Exception e) { pendingDownload = null; toast("Could not export this file."); }
        }),150);
    }
    @Override protected void onActivityResult(int request,int result,Intent data) {
        super.onActivityResult(request,result,data);
        if (request == CHOOSE_FILE && fileCallback != null) { fileCallback.onReceiveValue(result == RESULT_OK && data != null ? new Uri[]{data.getData()} : null); fileCallback = null; }
        if (request == SAVE_REPORT) {
            if (result == RESULT_OK && data != null && pendingDownload != null) {
                try (OutputStream out = getContentResolver().openOutputStream(data.getData())) { out.write(pendingDownload); toast("Export saved."); } catch(Exception e) { toast("Could not save the export."); }
            }
            pendingDownload = null;
        }
    }
    @Override public void onBackPressed() { if (web.canGoBack()) web.goBack(); else super.onBackPressed(); }
    @Override protected void onDestroy() { if (fileCallback != null) fileCallback.onReceiveValue(null); if (web != null) { ((ViewGroup)web.getParent()).removeView(web); web.destroy(); } pendingDownload = null; super.onDestroy(); }
}
