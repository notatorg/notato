import 'dart:ui' as ui;

import 'package:flutter/rendering.dart';

import 'annotation.dart';

/// A picture of a repaint boundary as it is now, at the screen's pixel ratio, or null when it cannot be taken.
Future<ui.Image?> grab(RenderRepaintBoundary boundary, double pixelRatio) async {
  try {
    return await boundary.toImage(pixelRatio: pixelRatio);
  } catch (_) {
    return null;
  }
}

/// A PNG of an image, or of part of it (`crop`, in the image's pixels). The image stays the caller's to dispose of;
/// what is made on the way is disposed of here.
Future<Shot?> pngOf(ui.Image image, String id, {Rect? crop}) async {
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
    return Shot(id: id, bytes: data.buffer.asUint8List(), width: out.width, height: out.height);
  } finally {
    if (!identical(out, image)) out.dispose();
  }
}
