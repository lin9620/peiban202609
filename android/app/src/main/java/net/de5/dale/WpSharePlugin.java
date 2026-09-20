package net.de5.dale;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;

/**
 * WpShare：把分享卡片（PNG dataURL）交到安卓系统分享面板。
 * 为什么必须有个原生插件：Capacitor 的 WebView 没有配置 DownloadListener，
 * 网页那套 `<a download>` 在 App 里点了没有任何反应（用户实测「生成分享图片功能没有用」）。
 * 走 ACTION_SEND + FileProvider：不需要存储权限（文件放在 cacheDir，路径已在
 * res/xml/file_paths.xml 的 <cache-path> 里放行），用户在分享面板里自己选
 * 「保存到相册 / 发微信 / 发 QQ」等，与原生 App 行为一致。
 */
@CapacitorPlugin(name = "WpShare")
public class WpSharePlugin extends Plugin {

    @PluginMethod
    public void shareImage(PluginCall call) {
        String data = call.getString("data", "");
        String fileName = call.getString("fileName", "warm-paws-card.png");
        if (data == null || data.length() == 0) {
            call.reject("wp-share-empty-data");
            return;
        }
        try {
            /* 支持完整 dataURL（data:image/png;base64,xxx）或纯 base64 */
            String b64 = data.contains(",") ? data.substring(data.indexOf(',') + 1) : data;
            byte[] bytes = Base64.decode(b64, Base64.DEFAULT);

            Context ctx = bridge.getContext();
            File dir = new File(ctx.getCacheDir(), "wp-share");
            if (!dir.exists()) dir.mkdirs();
            File out = new File(dir, fileName);
            FileOutputStream fos = new FileOutputStream(out);
            fos.write(bytes);
            fos.close();

            Uri uri = FileProvider.getUriForFile(
                    ctx, ctx.getPackageName() + ".fileprovider", out);

            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType("image/png");
            send.putExtra(Intent.EXTRA_STREAM, uri);
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(send, null);
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(chooser);

            JSObject ret = new JSObject();
            ret.put("shared", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("wp-share-failed: " + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()));
        }
    }
}
