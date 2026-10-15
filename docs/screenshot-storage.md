# Screenshot storage

New browser and mobile captures prefer WebP at quality 85 (0.85 in the browser), but keep PNG whenever it is smaller. Compression runs after privacy masks and annotations have been drawn. It does not reduce existing capture dimensions, remove the crop, or change the privacy rules. WebP is lossy, so fine text and edges can differ slightly from PNG.

A missing or failed encoder falls back to PNG. Native encoders receive freshly rendered pixels and do not copy camera metadata. The reference's `mime`, upload media type and bundle filename describe the bytes actually sent. The server already accepts both formats; there is no protocol migration or minimum server upgrade for WebP.

## Platforms

| SDK | Encoder | Installation |
| --- | --- | --- |
| Browser, React, Angular | Browser canvas | Automatic; `screenshotPlugin({ format: "png" })` opts into PNG |
| Swift | libwebp 1.6 through SwiftPM | Resolve the package and rebuild |
| Android Views and Compose | Android Bitmap WebP encoder | Rebuild with the updated SDK |
| .NET MAUI | SkiaSharp | Restore NuGet packages and rebuild; unsupported runtimes fall back to PNG |
| Flutter | flutter_image_compress | `flutter pub get`, then rebuild; unsupported platforms, including macOS WebP, keep PNG |
| React Native | Bundled native module; Android Bitmap / iOS SDWebImageWebPCoder and libwebp | Autolink, install iOS pods, then rebuild. Expo Go and binaries built without the module keep PNG |

React Native's encoder adds no Expo dependency. Projects without it still capture and send PNG; a JavaScript-only update does not require a new native binary to keep working. An Expo development build can include the native module. Android's module follows the app's React Native Gradle configuration and requires API 24 or later, like the supported SDK setup.

Existing PNG captures are not rewritten. Every SDK reads its old queue and bundle format alongside new WebP captures. Test mode and a local SQLite developer server use the same formats as a shared server.

## Measured examples

Two non-sensitive local fixtures encoded with libwebp at quality 85, unchanged dimensions:

| Fixture | PNG bytes | WebP bytes | Reduction |
| --- | ---: | ---: | ---: |
| Dashboard 404 screenshot | 211,072 | 46,536 | 78.0% |
| Repository mascot illustration | 234,855 | 26,394 | 88.8% |

These are examples, not promised savings. A small flat crop can be smaller as PNG, which is why each capture compares both. Smaller uploads reduce stored bytes and bytes transferred whenever an image is fetched. They add encoding work on the device and an encoder dependency to native builds.

## Other storage and transfer controls

- Screenshots are content-addressed by the server, so identical bytes share one stored asset. The full screenshot and crop remain independently addressable.
- SDK note lists use `?fields=summary`; the store projects those rows before they leave the database. The list retains screenshot metadata, while full diagnostics and agent steps are fetched only when requested. This reduces read payloads, not the size of the stored diagnostic record.
- Local queues keep compressed bytes rather than an extra uncompressed copy. Bundles avoid deflating already-compressed images again.
- Existing screenshot switches and capture-size limits still apply. Turn screenshots off when only text is needed.
- Removing a note or project cleans up only assets that no remaining record references. A shared asset must not disappear because one note is deleted.

Retention, quotas and backups belong to the operator's storage policy. This change does not expire notes, lower plan allowances, or reduce backup coverage. Thumbnails, an optional crop-only mode, and transcoding older PNGs could save more, but need separate product decisions and migration work.
