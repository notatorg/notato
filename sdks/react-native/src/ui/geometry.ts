import { Platform, StatusBar } from "react-native";

export { onScreen, overlaps, type Point, type Rect, sameRect, toRect } from "./rect.ts";

/**
 * The room the status bar and the home indicator take, estimated: React Native has no API for the safe areas without
 * react-native-safe-area-context, which Notato does not make apps install.
 */
export const INSETS = Platform.select({
    ios: { top: 59, bottom: 34 },
    default: { top: (StatusBar.currentHeight ?? 24) + 8, bottom: 48 },
});
