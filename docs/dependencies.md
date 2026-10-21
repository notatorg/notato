# Stable dependency baseline

Reviewed against the upstream registries on 21 October 2026. Application version numbers still move together through the separate release process; updating dependencies does not publish a Notato release.

| Area | Stable baseline |
| --- | --- |
| JavaScript runtime and tooling | Bun 1.4.3, Node 26.12.1, TypeScript 7.0.2, Biome 2.6.2, Vite 8.3.5, Vitest 5.0.5, Wrangler 4.151.3 |
| Web SDKs and boards | React 19.3.1, Angular 22.2.3, Happy DOM 21.0.4 |
| React Native SDK and example | React Native 0.88.0, Expo 58.0.16, view-shot 6.1.1; the example has its own npm lockfile |
| Full server | Better Auth 1.7.12, pg 8.23.1, Nodemailer 10.1.7, AWS S3 client 3.1154.0, PGlite 0.5.10 |
| .NET | SDK 10.0.402, workload set 10.0.402.1, MAUI Controls 10.0.110, Microsoft.Extensions 10.0.13, Aspire 13.6.2 |
| .NET supporting libraries | SkiaSharp 4.153.1, Microsoft.NET.Test.Sdk 18.11.0, xUnit 2.9.3, Visual Studio adapter 4.0.1, JsonSchema.Net 9.4.1 |
| Android | AGP 9.4.1, Gradle 9.8.2, Kotlin 2.4.21, Temurin 27, Android SDK 37.2, build tools 37.0.0, Compose BOM 2026.09.00 |
| Android libraries | Coroutines 1.11.0, serialization 1.12.0, core-ktx 1.19.1, activity-compose 1.13.0, appcompat 1.8.0, Material 1.14.0 |
| Flutter | Flutter 3.47.7 stable / Dart 3.13.5; archive 4.5.2, HTTP 1.6.0, image-compress 2.5.1, path-provider 2.1.6, share-plus 13.3.1 |
| Swift | libwebp-Xcode 1.6.0; CI selects stable Xcode 27.1 (build 27A9275) explicitly |
| Containers | Dockerfile frontend 1.28.0, Bun 1.4.3, Debian trixie-slim, PostgreSQL 18.6, SeaweedFS 4.48, Mailpit 1.31.6, Caddy 2.11.7, cloudflared 2026.10.2 |

Npm versions were checked against the [npm registry](https://registry.npmjs.org/), .NET packages against [NuGet](https://api.nuget.org/v3/index.json), Android packages against [Google Maven](https://maven.google.com/) and [Maven Central](https://repo.maven.apache.org/maven2/), and Dart packages against [pub.dev](https://pub.dev/). Tool and image versions were checked against their maintainers' stable release metadata and Docker manifests. Container images and workflow actions keep immutable digests or commit pins.

## Compatibility constraints

- Angular 22.2.3 requires TypeScript `>=6.0 <6.1`; its example uses the latest stable compatible TypeScript 6.0.3. The other TypeScript programs use 7.0.2.
- The `vite7` alias is a deliberate Vite 7 compatibility test fixture, at 7.3.7. Production development and example builds use Vite 8.3.5.
- Flutter's stable SDK and plugins constrain some transitive packages, including `test_api`, `material_color_utilities` and `cross_file`. Keep their resolved supported versions rather than overriding them outside the upstream constraints.
- Peer dependency ranges, minimum deployment targets and Swift's tools-version declaration describe consumer compatibility; they are not requests to install old packages. The development dependencies, samples and lockfiles use the stable baseline above.
- The optional preview-only MAUI DevFlow sample integration is excluded from the stable baseline. It has no stable upstream package release.

The current MAUI Apple workloads require Xcode 27.1 to link sample applications. A Mac with Xcode 27.0 can compile the libraries and run their managed tests but cannot finish the current iOS or Mac Catalyst sample builds. CI uses GitHub's managed Xcode runner with `DEVELOPER_DIR` pointing at the stable 27.1 installation; the directory's historical Release Candidate name carries the same build number as Apple's general release.

## Verification and upgrades

Run the checks in [CONTRIBUTING](../CONTRIBUTING.md). Native SDKs, examples and Docker images need their own builds in addition to the JavaScript suite. Use disposable data and ports other than 4747.

For a database major change, exercise a real dump and restore as well as the fresh-stack smoke test. The bundled [PostgreSQL 17-to-18 upgrade](../deploy/self-hosted/docs/postgres-upgrade.md) keeps the old volume for rollback. Updating the image tag never converts existing database files.

Dependabot covers Bun workspaces, the independently locked Expo example, NuGet, both Gradle builds, Flutter, Swift, workflow actions and the deployment images. Routine update PRs target `develop`. Review SDK/toolchain compatibility, regenerate lockfiles and verify immutable pins before promoting a release to `main`.
