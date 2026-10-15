package dev.notato.imagecodec;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.util.Base64;
import android.view.Window;
import android.view.WindowManager;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import java.io.ByteArrayOutputStream;

public class NotatoImageCodecModule extends ReactContextBaseJavaModule {
    public NotatoImageCodecModule(ReactApplicationContext context) { super(context); }
    @Override public String getName() { return "NotatoImageCodec"; }

    /** Whether the app's window is marked never to be captured (FLAG_SECURE), which a drawn screenshot ignores. */
    @ReactMethod
    public void isWindowSecure(Promise promise) {
        try {
            Activity activity = getReactApplicationContext().getCurrentActivity();
            Window window = activity == null ? null : activity.getWindow();
            promise.resolve(window != null
                && (window.getAttributes().flags & WindowManager.LayoutParams.FLAG_SECURE) != 0);
        } catch (Exception error) {
            promise.resolve(false);
        }
    }

    @ReactMethod
    @SuppressWarnings("deprecation")
    public void encodeWebP(String base64, Promise promise) {
        Bitmap bitmap = null;
        try {
            if (base64.length() > 45 * 1024 * 1024) { promise.resolve(null); return; }
            byte[] png = Base64.decode(base64, Base64.DEFAULT);
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(png, 0, png.length, bounds);
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0 ||
                (long) bounds.outWidth * bounds.outHeight > 16000000) { promise.resolve(null); return; }
            bitmap = BitmapFactory.decodeByteArray(png, 0, png.length);
            if (bitmap == null) { promise.resolve(null); return; }
            Bitmap.CompressFormat format = Build.VERSION.SDK_INT >= 30
                ? Bitmap.CompressFormat.WEBP_LOSSY : Bitmap.CompressFormat.WEBP;
            try (ByteArrayOutputStream stream = new ByteArrayOutputStream()) {
                if (!bitmap.compress(format, 85, stream) || stream.size() <= 0 || stream.size() >= png.length) {
                    promise.resolve(null);
                } else {
                    promise.resolve(Base64.encodeToString(stream.toByteArray(), Base64.NO_WRAP));
                }
            }
        } catch (Exception error) {
            promise.resolve(null);
        } finally {
            if (bitmap != null) bitmap.recycle();
        }
    }
}
