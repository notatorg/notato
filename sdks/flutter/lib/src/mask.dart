import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';

/// Marks what is inside as private to Notato, or (`private: false`) its text fields as fine to record. It paints its
/// child and nothing else, in every build. The web SDK's `data-notato-mask`.
///
/// Private (the default): covered in screenshots, and none of its text recorded anywhere, not as its text or label and
/// not in its selector; a selector cannot find it by its text either. `false`: the text fields inside are recorded even
/// when `maskInputs` is on. Password fields (`obscureText`) stay masked either way, and a private mark around a `false`
/// one wins.
///
/// ```dart
/// NotatoMask(child: Text(user.email))
/// NotatoMask(private: false, child: TextField(decoration: InputDecoration(hintText: 'Search')))
/// ```
class NotatoMask extends SingleChildRenderObjectWidget {
  /// Marks [child] as private, or (`private: false`) its text fields as fine to record.
  const NotatoMask({super.key, this.private = true, super.child});

  /// Private: covered in screenshots and never recorded. False: the text fields inside are recorded.
  final bool private;

  @override
  RenderNotatoMask createRenderObject(BuildContext context) => RenderNotatoMask(private);

  @override
  void updateRenderObject(BuildContext context, RenderNotatoMask renderObject) => renderObject.isPrivate = private;
}

/// The render side of [NotatoMask]: screenshots find what to cover by it, and text is not read from under it.
class RenderNotatoMask extends RenderProxyBox {
  RenderNotatoMask(this.isPrivate);

  /// What [NotatoMask.private] says. Read only when Notato looks at the screen, so a change needs no repaint.
  bool isPrivate;
}
