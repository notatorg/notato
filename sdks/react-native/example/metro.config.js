// The example runs @notato/react-native from its source (../src), as an app would run the published package. Metro
// watches that folder, and the SDK's imports of React and React Native resolve to this app's own copies: two Reacts in
// one app is the classic React Native monorepo crash.
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const sdk = path.resolve(__dirname, "..");
const sdkSource = path.join(sdk, "src");
// fflate is the package's own dependency, which an app installing it gets; here the app has its own copy.
const SHARED = [
    "react",
    "react-native",
    "react-native-view-shot",
    "expo-file-system",
    "expo-sharing",
    "fflate",
];

const config = getDefaultConfig(__dirname);
config.watchFolders = [...(config.watchFolders ?? []), sdkSource];
config.resolver.resolveRequest = (context, moduleName, platform) => {
    if (moduleName === "@notato/react-native")
        return { type: "sourceFile", filePath: path.join(sdkSource, "index.ts") };
    if (moduleName === "@notato/react-native/expo")
        return { type: "sourceFile", filePath: path.join(sdkSource, "expo.ts") };
    const shared = SHARED.some((name) => moduleName === name || moduleName.startsWith(`${name}/`));
    if (shared && context.originModulePath.startsWith(sdkSource))
        return context.resolveRequest(
            { ...context, originModulePath: path.join(__dirname, "index.ts") },
            moduleName,
            platform
        );
    return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
