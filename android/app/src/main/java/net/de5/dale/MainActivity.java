package net.de5.dale;

import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebView;
import androidx.appcompat.app.AppCompatDelegate;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {
    /* 轮 347：最近一次推给网页的安全区（CSS px）。-1 = 还没推过。 */
    private final int[] lastSafe = { -1, -1 };
    private View decor;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        /* 轮 39：App 恒为米色浅色主题——先把本 Activity 的夜间配置钉死成「浅色」再建窗口。
         * 深色模式下（尤其夜间），WebView 的 Force Dark 会把浅色页面整个反黑，
         * 用户看到的「黑屏」就是它；轮 38 在下午浅色模式下抓帧实测，测不出这层。
         * 必须在 super.onCreate 之前调：它内部就 setContentView + 建 WebView 了。 */
        AppCompatDelegate.setDefaultNightMode(AppCompatDelegate.MODE_NIGHT_NO);
        super.onCreate(savedInstanceState);
        /* 自定义插件：分享卡片（ShareCard 的「保存 / 分享」按钮在 App 里走系统分享面板） */
        registerPlugin(WpSharePlugin.class);
        /* 轮 39：Force Dark 第二道闸（API 29+）——WebView 实例上显式退出，
         * 与主题里的 android:forceDarkAllowed=false 双保险（MIUI 深色模式也吃这套开关）。 */
        if (Build.VERSION.SDK_INT >= 29 && bridge != null && bridge.getWebView() != null) {
            bridge.getWebView().setForceDarkAllowed(false);
        }

        /* 轮 347 · 真·全屏（edge-to-edge）——修用户实报的「图1/图2 上下都有空隙」。
         * 轮 322 的监听给 decorView 加了系统栏 padding，同时又把 insets 原样返回，
         * WebView 里的 env(safe-area-inset-*) 也拿到了同样的高度 → 页面自己又让了一次：
         *   顶部 = 状态栏 ×2（截图里内容比状态栏低了整整一条），
         *   底部 = 导航栏 ×2（TabBar/输入条下面多一条空白）。
         * 现在：
         *   · decorView 不再加 padding，窗口直接铺到状态栏/导航栏下面；
         *   · insets 仍然返回给 WebView（Chromium 的 env() 需要它），
         *     同时把真实值写成 --sat / --sab 给网页（比 env 稳，老内核也能用）；
         *   · --sys-bottom 固定 0：WebView 底就是窗口底，键盘高度不用再扣导航栏
         *     （轮 324 的减法只对「WebView 被导航栏顶上去」的老布局成立）。
         * 键盘让位仍由网页 --kb-h 负责（轮 322 的结论不变，见 keyboardInset.js）。 */
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);

        decor = getWindow().getDecorView();
        ViewCompat.setOnApplyWindowInsetsListener(decor, (v, insets) -> {
            Insets bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            boolean imeVisible = insets.isVisible(WindowInsetsCompat.Type.ime());
            /* 键盘弹起时导航栏被顶掉，bars.bottom 会变 0 —— 这时网页的输入条已经靠
               --kb-h 让到键盘上沿，安全区底部必须归零，否则会多一条导航栏高的缝。 */
            final int sab = imeVisible ? 0 : bars.bottom;
            pushSafeArea(bars.top, sab);
            return insets;
        });
        ViewCompat.requestApplyInsets(decor);

        /* SPA 刷新 / 整页重载后 documentElement 的内联变量会丢；页面可见时补推一次。 */
        if (bridge != null) {
            bridge.addWebViewListener(new WebViewListener() {
                @Override
                public void onPageCommitVisible(WebView view, String url) {
                    super.onPageCommitVisible(view, url);
                    lastSafe[0] = -1;
                    lastSafe[1] = -1;
                    ViewCompat.requestApplyInsets(decor);
                }
            });
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        /* 从后台回来时系统栏高度可能变（旋转 / 分屏）；强制重推一次。 */
        lastSafe[0] = -1;
        lastSafe[1] = -1;
        if (decor != null) ViewCompat.requestApplyInsets(decor);
    }

    /* 把「状态栏 / 导航栏真实高度」告诉网页层（CSS px，与 env() 同一口径）。
     * 网页里 --sat / --sab 的默认值是 env(safe-area-inset-*)，这里只是更可靠的覆盖。
     * 值没变不重复推；页面重载后由 onPageCommitVisible / onResume 重置后再推。 */
    private void pushSafeArea(int topPx, int bottomPx) {
        if (bridge == null || bridge.getWebView() == null) return;
        float density = getResources().getDisplayMetrics().density;
        if (density <= 0) return;
        final int top = Math.round(Math.max(0, topPx) / density);
        final int bottom = Math.round(Math.max(0, bottomPx) / density);
        if (top == lastSafe[0] && bottom == lastSafe[1]) return;
        lastSafe[0] = top;
        lastSafe[1] = bottom;
        /* 现场诊断：别的机型若报「还有缝 / 被系统栏压住」，这一行 + 网页里的
           window.__kbInfo 就能定位是哪个数不对。 */
        android.util.Log.d("WpInsets", "safe-area top=" + top + " bottom=" + bottom
            + " (pad=" + topPx + "/" + bottomPx + "px, density=" + density + ")");
        final WebView wv = bridge.getWebView();
        wv.post(() -> wv.evaluateJavascript(
            "var r=document.documentElement.style;" +
            "r.setProperty('--sat','" + top + "px');" +
            "r.setProperty('--sab','" + bottom + "px');" +
            "r.setProperty('--sys-bottom','0px')", null));
    }
}
