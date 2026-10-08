plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "dev.notato.sample"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.notato.sample"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        viewBinding = false
    }
}

kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

dependencies {
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.material3)
    implementation(libs.activity.compose)
    implementation(libs.appcompat)
    implementation(libs.material)
    implementation(libs.androidx.core.ktx)
    debugImplementation(libs.compose.ui.tooling)

    // Debug builds only, as an app would have it: what the sample's own code asks of Notato is in src/debug, and
    // src/release has the same names doing nothing, so a release build has no Notato at all.
    debugImplementation(project(":notato-compose"))
}
