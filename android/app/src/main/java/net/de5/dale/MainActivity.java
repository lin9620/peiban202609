package net.de5.dale;

import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;
import androidx.appcompat.app.AppCompatDelegate;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
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
    }
}

