package net.de5.dale;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        /* 自定义插件：分享卡片（ShareCard 的「保存 / 分享」按钮在 App 里走系统分享面板） */
        registerPlugin(WpSharePlugin.class);
    }
}

