module.exports = {
    dependency: {
        platforms: {
            android: {
                sourceDir: "./android",
                packageImportPath: "import dev.notato.imagecodec.NotatoImageCodecPackage;",
                packageInstance: "new NotatoImageCodecPackage()",
            },
            ios: { podspecPath: "./NotatoImageCodec.podspec" },
        },
    },
};
