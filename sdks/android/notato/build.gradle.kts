plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "dev.notato.android"
    compileSdk = 37
    compileSdkMinor = 2
    buildToolsVersion = "37.0.0"

    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
        // What notes say made them (`environment.sdk`): the version in gradle.properties.
        buildConfigField("String", "NOTATO_VERSION", "\"${providers.gradleProperty("VERSION_NAME").get()}\"")
    }

    buildFeatures { buildConfig = true }

    publishing {
        singleVariant("release") {
            withSourcesJar()
            withJavadocJar()
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
    explicitApi()
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    testImplementation(libs.junit)
}

// dev.notato:notato-android: see gradle/publishing.gradle.kts.
apply(from = rootProject.file("gradle/publishing.gradle.kts"))
