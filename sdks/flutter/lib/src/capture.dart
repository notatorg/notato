import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/rendering.dart';
import 'package:flutter_image_compress/flutter_image_compress.dart';

import 'annotation.dart';

/// A picture of a repaint boundary as it is now, at the screen's pixel ratio, or null when it cannot be taken.
Future<ui.Image?> grab(RenderRepaintBoundary boundary, double pixelRatio) async {
  try {
    return await boundary.toImage(pixelRatio: pixelRatio);
  } catch (_) {
    return null;
  }
}

/// A compressed image, or part of it (`crop`, in image pixels). Prefers WebP, with PNG for unsupported encoders or smaller files.
/// The image stays the caller's to dispose of;
/// what is made on the way is disposed of here.
Future<Shot?> pngOf(ui.Image image, String id, {Rect? crop, Map<String, int>? cropRect}) async {
  var out = image;
  if (crop != null) {
    final src = crop.intersect(Offset.zero & Size(image.width.toDouble(), image.height.toDouble()));
    if (src.isEmpty || src.width < 1 || src.height < 1) return null;
    final recorder = ui.PictureRecorder();
    Canvas(recorder).drawImageRect(image, src, Offset.zero & src.size, Paint());
    final picture = recorder.endRecording();
    try {
      out = await picture.toImage(src.width.round(), src.height.round());
    } finally {
      picture.dispose();
    }
  }
  try {
    final data = await out.toByteData(format: ui.ImageByteFormat.png);
    if (data == null) return null;
    final png = data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
    final encoded = await compressScreenshot(png, out.width, out.height);
    return Shot(
      id: id,
      bytes: encoded.bytes,
      width: out.width,
      height: out.height,
      mime: encoded.mime,
      cropRect: cropRect,
    );
  } finally {
    if (!identical(out, image)) out.dispose();
  }
}

/// Compression only sees the finished, masked image. It may never prevent a note from being captured.
Future<({Uint8List bytes, String mime})> compressScreenshot(
  Uint8List png,
  int width,
  int height, {
  Future<Uint8List> Function(Uint8List, int, int)? encoder,
}) async {
  try {
    final webp = await (encoder ?? _encodeWebp)(png, width, height);
    if (webp.isNotEmpty && webp.length < png.length && _webpSize(webp) == (width, height)) {
      return (bytes: webp, mime: 'image/webp');
    }
  } catch (_) {
    // Includes desktop platforms without a WebP encoder and older app binaries missing the native plugin.
  }
  return (bytes: png, mime: 'image/png');
}

Future<Uint8List> _encodeWebp(Uint8List png, int width, int height) => FlutterImageCompress.compressWithList(
  png,
  format: CompressFormat.webp,
  quality: 85,
  minWidth: width,
  minHeight: height,
  autoCorrectionAngle: false,
);

(int, int)? _webpSize(Uint8List bytes) {
  if (bytes.length < 25 ||
      String.fromCharCodes(bytes.sublist(0, 4)) != 'RIFF' ||
      String.fromCharCodes(bytes.sublist(8, 12)) != 'WEBP') {
    return null;
  }
  final data = ByteData.sublistView(bytes);
  for (var at = 12; at + 8 <= bytes.length;) {
    final size = data.getUint32(at + 4, Endian.little);
    if (at + 8 + size > bytes.length) return null;
    final tag = String.fromCharCodes(bytes.sublist(at, at + 4));
    if (tag == 'VP8X' && size >= 10) {
      int u24(int offset) => bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
      return (u24(at + 12) + 1, u24(at + 15) + 1);
    }
    if (tag == 'VP8L' && size >= 5 && bytes[at + 8] == 0x2f) {
      final dims = data.getUint32(at + 9, Endian.little);
      return ((dims & 0x3fff) + 1, ((dims >> 14) & 0x3fff) + 1);
    }
    if (tag == 'VP8 ' && size >= 10 && bytes[at + 11] == 0x9d && bytes[at + 12] == 0x01 && bytes[at + 13] == 0x2a) {
      return (data.getUint16(at + 14, Endian.little) & 0x3fff, data.getUint16(at + 16, Endian.little) & 0x3fff);
    }
    at += 8 + size + (size & 1);
  }
  return null;
}
