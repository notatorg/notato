# Releasing

Everything is released together, at one version: the `notato` command and server, every npm package, the Swift package, the Android libraries, the .NET MAUI package, the Docker image and the website. "SDK 0.3 works with server 0.3" is then the whole compatibility story.

## A release

```bash
bun scripts/version.ts 0.3.0     # writes 0.3.0 into every manifest and version constant
git commit -am "Release 0.3.0"
git tag v0.3.0
git push origin main v0.3.0
```

The tag starts [`release.yml`](.github/workflows/release.yml). It checks that the tag is the version every package says, builds and smoke-tests the binary on each platform, then builds every package. Each registry only gets an upload when its switch is on, so with every switch off a tag is a complete dry run: `npm publish --dry-run`, the Docker image built but not pushed, the Maven bundle and the NuGet package uploaded as workflow artifacts, and the website built.

A pre-release (`0.3.0-rc.1`) works the same way: npm gets it under the `next` tag and Docker does not move `latest`.

## The switches

Repository variables (Settings › Secrets and variables › Actions › Variables), each set to `true` to publish there:

| Variable         | Publishes                                                     | Needs                                                                                             |
| ---------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `PUBLISH_NPM`    | `notato`, `@notato/cli-*`, and every public workspace package | secret `NPM_TOKEN`                                                                                |
| `PUBLISH_DOCKER` | `ghcr.io/notatorg/notato`                                     | nothing more                                                                                      |
| `PUBLISH_MAVEN`  | `dev.notato:notato-android` and `dev.notato:notato-compose`   | secrets `MAVEN_CENTRAL_USERNAME`, `MAVEN_CENTRAL_PASSWORD`, `SIGNING_KEY`, `SIGNING_KEY_PASSWORD` |
| `PUBLISH_NUGET`  | `Notato.Maui`                                                 | secret `NUGET_API_KEY`                                                                            |
| `PUBLISH_PUB`    | `notato` on pub.dev (Flutter)                                 | automated publishing turned on for the package on pub.dev (below)                                 |
| `PUBLISH_SITE`   | the website and docs, on GitHub Pages                         | Pages' source set to GitHub Actions                                                               |
| `PUBLISH_GITHUB` | a GitHub release with the binaries and the extension zip      | nothing more                                                                                      |

SwiftPM has no switch: it reads `Package.swift` at the tag, so pushing the tag is the Swift release.

## Before the first one

- **npm.** Create the `notato` organisation on npmjs.com (it owns the `@notato` scope; `notato` and `@notato/*` were free in October 2026) and an automation token for `NPM_TOKEN`. Packages are published with provenance, which needs the repository to be public.
- **Docker.** After the first push, make the `notato` package public under the organisation's packages.
- **Maven Central.** Make an account on the [Central Portal](https://central.sonatype.com) and verify the `dev.notato` namespace. That takes a DNS record on `notato.dev`: without that domain, verify `io.github.notatorg` instead and set `GROUP` in `sdks/android/gradle.properties` to it. Generate a user token (`MAVEN_CENTRAL_USERNAME` and `MAVEN_CENTRAL_PASSWORD`), and a GPG key whose public half is on keys.openpgp.org (`SIGNING_KEY` is the ASCII-armoured private key, `SIGNING_KEY_PASSWORD` its passphrase). `./gradlew publishAllPublicationsToStagingRepository` in `sdks/android` writes the same bundle locally.
- **NuGet.** An API key scoped to pushing `Notato.*`; reserving the `Notato.` prefix is worth asking for.
- **pub.dev.** The first version goes up by hand (`flutter pub publish` in `sdks/flutter`, signed in as the account that should own it; a verified publisher is better). Then, on the package's admin page, turn on automated publishing from GitHub Actions for `notatorg/notato` with the tag pattern `v{{version}}`: the release job publishes with the workflow's own identity, and no secret is needed. `notato` was free on pub.dev in October 2026.
- **Swift.** Nothing; adding the repository to the Swift Package Index is optional.

## Where the metadata lives

Each registry reads its own file, and [`scripts/repo.test.ts`](scripts/repo.test.ts) checks that they agree:

- The repository URL (`https://github.com/notatorg/notato`): `REPO_URL` in [`scripts/repo.ts`](scripts/repo.ts) for npm, `POM_*` in [`sdks/android/gradle.properties`](sdks/android/gradle.properties), [`sdks/dotnet/Directory.Build.props`](sdks/dotnet/Directory.Build.props), [`site/docs.ts`](site/docs.ts), the Dockerfile.
- The licence (MIT, [LICENSE](LICENSE)): `common` in [`scripts/build-release.ts`](scripts/build-release.ts), `POM_LICENSE_*`, `PackageLicenseExpression`.
- The version: every place [`scripts/version.ts`](scripts/version.ts) lists.
