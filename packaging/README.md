# Packaging outlines (not published)

Drafts for package-manager listings. Nothing here is published, and none of it may be until the
gates in `docs/plans/0.2.0/PLAN.md` are cleared.
Every outline installs the package tarball attached to the GitHub release
(`https://github.com/Luxorium/masthead/releases/download/v<version>/luxorium-masthead-<version>.tgz`,
made by `.github/workflows/release.yml`; Masthead is not published to the npm registry) with `--os=none --cpu=none` (npm ignores `--omit=optional` for a global install (seen with npm 11.19.1 on Windows and 12.2.3 on Linux)), which skips the Agent SDK's private
Claude Code binary: Masthead always runs the person's own `claude`.

| File | For | Status |
|---|---|---|
| `homebrew/masthead.rb` | a Homebrew tap (`Luxorium/homebrew-tap`) | outline; `sha256` from the release's `SHA256SUMS` |
| `aur/PKGBUILD` | the Arch User Repository | outline; check against the Arch Node.js packaging guidelines before submitting |
| `scoop/masthead.json` | a Scoop bucket (Windows, no admin) | outline; untested on Windows |
| `masthead.desktop`, `masthead.svg` | the Linux launcher entry and icon used by `scripts/install.sh` | in use |

The package name inside the tarball is `@luxorium/masthead` (hence the asset name); it stays `"private": true` and is not on npm.
