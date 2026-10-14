# Releasing

## Web SDK fixes only

A web SDK release publishes only `@notato/schema`, `@notato/core`, `@notato/browser`, `@notato/react` and `@notato/angular`. The CLI/server, other SDKs, website and Docker image retain their existing published versions. The root `notatoRelease` profile identifies this as a web SDK patch: only those five packages and the browser SDK stamp advance; CLI/native versions and install instructions stay at the published version. A full `bun scripts/version.ts <version>` clears the profile and aligns every component for a full release.

Work from the public developer branch. Never merge or push the private hosted repository's history to the public repository. The hosted service and account/billing implementation remain private. The SDK builder rejects a tree containing those private server modules.

```bash
# Advance only the five web package versions and browser stamp, and set
# package.json.notatoRelease = {"scope":"web-sdk","unchangedVersion":"0.2.0"}.
# Write the SDK-only changelog entry and align bun.lock.
bun run check
bun scripts/build-release.ts --web-sdks-only
bun scripts/verify-web-sdk-release.ts
# Test the packed artifacts in an isolated app against old local and private hosted servers.
# Commit only the reviewed public tree, then push a web SDK tag pointing to that commit:
git tag web-sdk-v0.2.1
git push origin web-sdk-v0.2.1
```

[release-web-sdks.yml](.github/workflows/release-web-sdks.yml) tests, builds and verifies the five packages before publishing in dependency order. Retry publication accepts already-published packages only when their registry integrity matches the built tarball. `PUBLISH_NPM=false` performs a dry run. A `web-sdk-v*` tag does not trigger the full-release workflow.

Do not use a plain `v*` tag for an SDK-only release: it starts the full release described below.

## Full release

A full release publishes every component at one version: the `notato` command and server, every npm package, the Swift package, the Android libraries, the .NET MAUI package, the Docker image and the website. "SDK 0.3 works with server 0.3" is then the whole compatibility story.

## A release

```bash
bun scripts/version.ts 0.3.0     # writes 0.3.0 into every manifest and version constant
# add a "## 0.3.0" entry to CHANGELOG.md and to sdks/flutter/CHANGELOG.md (pub.dev shows that one)
git commit -am "Release 0.3.0"
git tag v0.3.0
git push origin main v0.3.0
```

Every release has a changelog entry: [CHANGELOG.md](CHANGELOG.md) for everything, and the Flutter package's own for pub.dev. The tests and the tag both fail without them, and the CHANGELOG.md entry is the top of the GitHub release's notes, above GitHub's list of what was merged.

The tag starts [`release.yml`](.github/workflows/release.yml). It checks that the tag is the version every package says and that the changelogs have it, builds and smoke-tests the binary on each platform, then builds every package. Each registry only gets an upload when its switch is on, so with every switch off a tag is a complete dry run: `npm publish --dry-run`, the Docker image built but not pushed, the Maven bundle and the NuGet package uploaded as workflow artifacts, and the website built.

A pre-release (`0.3.0-rc.1`) works the same way: npm gets it under the `next` tag and Docker does not move `latest`.

## The switches

Repository variables (Settings › Secrets and variables › Actions › Variables), each set to `true` to publish there:

| Variable         | Publishes                                                     | Needs                                                                                             |
| ---------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `PUBLISH_NPM`    | `notato`, `@notato/cli-*`, and every public workspace package | secret `NPM_TOKEN`                                                                                |
| `PUBLISH_DOCKER` | `ghcr.io/notatorg/notato`                                     | nothing more                                                                                      |
| `PUBLISH_MAVEN`  | `dev.notato:notato-android` and `dev.notato:notato-compose`   | secrets `MAVEN_CENTRAL_USERNAME`, `MAVEN_CENTRAL_PASSWORD`, `SIGNING_KEY`, `SIGNING_KEY_PASSWORD` |
| `PUBLISH_NUGET`  | `Notato.Maui` and `Notato.Aspire`                             | variable `NUGET_USER` and a Trusted Publishing policy on nuget.org (below); no key                |
| `PUBLISH_PUB`    | `notato` on pub.dev (Flutter)                                 | automated publishing turned on for the package on pub.dev (below)                                 |
| `PUBLISH_SITE`   | the website and docs, on GitHub Pages                         | Pages' source set to GitHub Actions, and tags allowed to deploy (below)                           |
| `PUBLISH_GITHUB` | a GitHub release with the binaries and the extension zip      | nothing more                                                                                      |

SwiftPM has no switch: it reads `Package.swift` at the tag, so pushing the tag is the Swift release.

## Before the first one

- **npm.** Create the `notato` organisation on npmjs.com (it owns the `@notato` scope; `notato` and `@notato/*` were free in October 2026) and an automation token for `NPM_TOKEN`. Packages are published with provenance, which needs the repository to be public.
- **Docker.** After the first push, make the `notato` package public under the organisation's packages.
- **Maven Central.** Make an account on the [Central Portal](https://central.sonatype.com) and verify the `dev.notato` namespace. That takes a DNS record on `notato.dev`: without that domain, verify `io.github.notatorg` instead and set `GROUP` in `sdks/android/gradle.properties` to it. Generate a user token (`MAVEN_CENTRAL_USERNAME` and `MAVEN_CENTRAL_PASSWORD`), and a GPG key whose public half is on keys.openpgp.org (`SIGNING_KEY` is the ASCII-armoured private key, `SIGNING_KEY_PASSWORD` its passphrase). `./gradlew publishAllPublicationsToStagingRepository` in `sdks/android` writes the same bundle locally.
- **NuGet.** No API key: nuget.org trusts the release workflow itself. On nuget.org, under your account's **Trusted Publishing**, add a policy owned by the Notato organisation for repository owner `notatorg`, repository `notato` and workflow file `release.yml`, and set the repository variable `NUGET_USER` to your nuget.org username (the profile name, not the email). Reserving the `Notato.` prefix is worth asking for.
- **pub.dev.** The first version goes up by hand (`flutter pub publish` in `sdks/flutter`, signed in as the account that should own it; a verified publisher is better). Then, on the package's admin page, turn on automated publishing from GitHub Actions for `notatorg/notato` with the tag pattern `v{{version}}`: the release job publishes with the workflow's own identity, and no secret is needed. `notato` was free on pub.dev in October 2026.
- **Swift.** Nothing; adding the repository to the Swift Package Index is optional.
- **GitHub Pages.** Set Settings › Pages › Source to GitHub Actions. That creates a `github-pages` environment that only `main` may deploy to, and a release runs from its tag, so add a tag rule for `v*` under Settings › Environments › github-pages › Deployment branches and tags (`gh api -X POST repos/notatorg/notato/environments/github-pages/deployment-branch-policies -f name='v*' -f type=tag`).
- **GitHub.** Turn on private vulnerability reporting (Settings › Code security), which [SECURITY.md](SECURITY.md) sends reports to, and reported content (Settings › Moderation options), which the [code of conduct](CODE_OF_CONDUCT.md) relies on.

## Where the metadata lives

Each registry reads its own file, and [`scripts/repo.test.ts`](scripts/repo.test.ts) checks that they agree:

- The repository URL (`https://github.com/notatorg/notato`): `REPO_URL` in [`scripts/repo.ts`](scripts/repo.ts) for npm, `POM_*` in [`sdks/android/gradle.properties`](sdks/android/gradle.properties), [`sdks/dotnet/Directory.Build.props`](sdks/dotnet/Directory.Build.props), [`site/docs.ts`](site/docs.ts), the Dockerfile.
- The licence (MIT, [LICENSE](LICENSE)): `common` in [`scripts/build-release.ts`](scripts/build-release.ts), `POM_LICENSE_*`, `PackageLicenseExpression`.
- The version: every place [`scripts/version.ts`](scripts/version.ts) lists.
