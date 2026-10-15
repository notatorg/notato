# Screenshot storage

New browser and mobile captures prefer WebP at quality 85 (0.85 in the browser), but keep PNG whenever it is smaller. Compression runs after privacy masks and annotations have been drawn. It does not reduce full capture dimensions or change the privacy rules. WebP is lossy, so fine text and edges can differ slightly from PNG.

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

- Screenshots are content-addressed by the server, so identical bytes share one stored asset. Full screenshots, crops and thumbnails have independent content hashes; identical bytes share one object. Legacy screenshots remain readable.
- SDK and board note lists and event streams use `?fields=summary`; the store projects those rows before they leave the database. The list retains screenshot metadata, while full diagnostics and agent steps are fetched only when requested. This reduces read payloads, not the size of the stored diagnostic record.
- Local queues keep compressed bytes rather than an extra uncompressed copy. Bundles avoid deflating already-compressed images again.
- Existing screenshot switches and capture-size limits still apply. Turn screenshots off when only text is needed.
- Removing a note or project cleans up only assets that no remaining record references. A shared asset must not disappear because one note is deleted.

Retention, quotas and backups belong to the operator's storage policy. This change does not expire notes, lower plan allowances, or reduce backup coverage. An optional crop-only mode and transcoding older PNGs would need separate product decisions and migration work.

## One upload, reusable crop

When `/config` advertises `derivedScreenshots: true`, live SDK captures upload the full masked screenshot and store a pixel rectangle at `context.screenshot.cropRect`. They skip the second full-resolution image capture/encode/upload. Old servers, test mode and offline bundles continue to receive real crop assets, so this is a negotiated optimisation rather than a required protocol upgrade.

The server generates the full-size WebP crop and a WebP thumbnail fitting inside 240×160 pixels, once, from bytes already in the upload. They are stored as `screenshots.crop` and `screenshots.thumbnail`. Opening an inbox downloads only thumbnails; a cold agent crop request downloads the stored crop rather than the original and does no image processing. Keeping a small compressed crop is usually cheaper than repeatedly transferring originals or spending server CPU reconstructing crops. Both derivative sizes count towards storage accounting and follow the existing reference checks, deletion and backup paths. Failed derivative generation never discards a valid note.

The board loads previews in the inbox and full diagnostics only when a note is opened. In detail, a canvas draws the crop from the already-loaded full image; it makes no second crop request. Enlarging the screenshot also draws the already-loaded pixels, avoiding another original-image download. MCP sends full and crop images by default; explicit crop-only requests read the stored crop. Authenticated `GET /annotations/:id/screenshot?view=thumbnail|crop` uses fixed presets and checks access to the live note before reading any cached bytes. Responses remain private with no browser/CDN caching.

A missing legacy thumbnail or crop can be reconstructed on demand. Such fallback views are held only in process RAM, for 60 seconds with an 8 MiB/128-entry budget. Rendering is serial, with at most eight pending distinct views, 25 MiB input and 16 million pixel limits. The renderer uses Bun's built-in image codec and a PNG pixel bridge, so the compiled CLI needs no system image tools or native Node addons. A source Bun runtime without `Bun.Image` advertises no support; SDKs retain the legacy path. Render failures fall back to existing images where available. Cached bytes can survive deletion until their TTL, but every request requires a live authorised note reference.

For the same dashboard fixture, a 720×480 full-resolution crop was 16,910 bytes; its 240×160 preview was 2,642 bytes (84.4% smaller). The thumbnail adds 2,642 stored bytes, but an inbox fetch uses that instead of the 16,910-byte crop or 46,536-byte original. The SDK avoids uploading the crop; the full-size crop remains stored for agent delivery. Actual savings depend on the image and crop size. Existing screenshots are never rewritten automatically.
