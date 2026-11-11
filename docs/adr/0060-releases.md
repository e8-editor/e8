# 0060. Releases

Status: accepted · 2026-11-06

## Context

Until now E8 has been built from source by the people working on it. [ADR 0059](0059-packages-are-git-repositories.md) moves the ports into repositories of their own, each running its ERT tests in CI with `e8 --batch`, so a package repository needs an E8 to download, of a known version, on the machines CI runs on. A user who wants E8 without a Rust toolchain needs the same. The repository has no CI at all yet.

Agreed on 2026-11-06, and recorded since only as a note: releases on GitHub, a Homebrew tap later, an update check that is opt-in and never silent, and no binary that replaces itself until E8 is signed and notarised.

## Options considered

1. **cargo-dist.** It generates a release workflow, installers and a Homebrew formula from `Cargo.toml`. It does a lot well, but it is a tool to install and keep in step with, and its generated workflow is long and rewritten on each upgrade. For two binaries on two platforms, more than is needed.
2. **A workflow of our own.** On a version tag, GitHub Actions builds the binaries for each platform, packs each into a tarball with a checksum, and makes a GitHub Release of them. It is about a hundred lines, with nothing to install, and is easy to read and change. Chosen.
3. **No releases, CI building from source.** Each package repository would check out and build E8, at 10 to 20 minutes a run, and pin it by commit rather than by version. That is too slow, and it gives no versions to require.

## Decision

A release is a tag `vX.Y.Z` on `main` matching the workspace version in `Cargo.toml`. `.github/workflows/release.yml` runs after each merge to `main` that changes more than the docs, and:

- builds `e8` (the terminal editor, and `--batch`) and `e8-mcp` in release mode, on V8, for `aarch64-apple-darwin` (Apple silicon) and `x86_64-unknown-linux-gnu` (Linux, as CI runs on);
- runs `e8 --batch` once, to check that the binary starts and its packages load;
- packs each platform's binaries with `LICENSE` into `e8-X.Y.Z-TARGET.tar.gz`, with a `.sha256` beside it;
- if the version has no tag yet, waits for the tests on the same commit (`test.yml`, which runs on `main`, not on pull requests) to pass, then tags the commit and makes the GitHub Release, its notes generated from the pull requests merged since the last one.

So a merge that bumps the version releases it, with nothing more to do, and every other merge builds without releasing: a broken release build shows on `main` before a release is wanted, and the build cache that release builds restore stays warm, as a tag's build can use only caches made on `main`. Pull requests are not built: a version bump cannot break the build, and the tests already wait for `main`. Pushing a tag by hand still releases, after building that tag and refusing a tag that does not match the version; running the workflow by hand builds any branch without releasing.

Releases were made by pushing a tag until 0.3.1. The workflow built again on the tag, from a cold cache, ten to fifteen minutes after the pull request that bumped the version had waited as long for the same build.

A Homebrew tap, [`e8-editor/homebrew-tap`](https://github.com/e8-editor/homebrew-tap), installs a release: `brew install e8-editor/tap/e8` gives `e8` and `e8-mcp` on Apple silicon and Linux, and `E8.app` on macOS. A workflow in the tap rewrites the formula from the newest release each day, with the tap's own token, so a release needs nothing more here. Homebrew downloads with `curl`, so macOS does not quarantine the app, and it opens without a Developer ID: confirmed on 2026-11-06 on a Mac that did not build it.

To release: bump `version` in the workspace `Cargo.toml` in a pull request and merge it. The same pull request changes each crate's version of the others in `crates/*/Cargo.toml`, `Cargo.lock` (`cargo update -w`) and the version `packages/e8.d.ts` names at its top (`UPDATE_TYPES=1 cargo test -p e8-script`). If the workflow fails at making the GitHub Release, as 0.5.3's did with an HTTP 500 from GitHub, `gh run rerun --failed` finishes it from the builds already made. The version is what `e8-version` reports and what a package's manifest compares with ([ADR 0059](0059-packages-are-git-repositories.md)), so it changes when the script API changes in a way a package would notice, as well as at each release.

Left for later, each when it is wanted:

- **Signing the app.** Since 0.2.1 the macOS release carries `E8.app`, signed ad hoc as `make app` signs it. macOS opens it when `curl` or Homebrew fetched it, but quarantines it when a browser did, and then asks the user to override Gatekeeper; a Developer ID and notarisation would end that, at $99 a year.
- **Intel Macs, Linux on ARM and Windows.** A line in the workflow's matrix each, once someone needs them.
- **The update check**: `check-for-updates`, opt-in, at most daily, through a `urlRetrieve` native in the script API, never in `e8-core`.
- **An action for package repositories**, `setup-e8`, which downloads a release onto CI's PATH. It comes with the package template ([ADR 0059](0059-packages-are-git-repositories.md)).

## Consequences

- Package repositories can test against a released E8, and pin the version they test.
- Anyone can try the terminal editor without building it.
- While the repository is private, its releases can be downloaded only with a token that can read it. Package repositories in the organisation can be given one, but users cannot, so releases are for users only once the repository is public.
- A release builds on GitHub's machines, not this one, so a change that breaks the Linux build is found there. The workflow's pull request build is the first time E8 has been built on Linux at all.
- Binaries are not signed. A macOS binary downloaded by a browser is quarantined, though one fetched with `curl` or by CI is not; signing waits for the GUI app's Developer ID.

## Dependencies introduced

None. The workflow uses GitHub's own actions (`actions/checkout`, `actions/cache`, `actions/upload-artifact`, `actions/download-artifact`) and the `gh` command the runners have.
