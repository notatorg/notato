# Changelog

Every Notato package is released together, at the same version: see [the releases](https://github.com/notatorg/notato/releases).

## 0.2.0

- Two declarations from the build win over the options in code: `--dart-define=NOTATO_ENABLED=true` (or `false`) switches Notato on or off, over `enabled` and the choice remembered from an earlier launch, and `--dart-define=NOTATO_SERVER=…` sets the server, which gets the `token` as one set in code does. A release build that declares neither is as before.

## 0.1.1

- The composer opens as soon as a widget is picked; its screenshots are taken behind it, and the toolbar and pins stay on screen.
- Pins follow their widgets frame by frame as the app scrolls, and are looked for again only once it is still: no more stutter while scrolling with pins on screen.
- Sheets slide and fade between each other, and the composer, toasts, the hint and pins animate in and out. The toolbar fades away while a note is written and folds smoothly. Reduce Motion is respected.
- Cheaper: a rebuilt screen is not read again through the widget inspector, the theme is built once, and pins redraw on their own.

## 0.1.0

- First release of Notato for Flutter: the toolbar, picking a widget with its file and line, screenshots, notes sent to a Notato server, and pins that follow the agent's work live.
