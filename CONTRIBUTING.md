# Contributing

Thank you for helping. Read [AGENTS.md](AGENTS.md) first: it holds the working rules for people and
agents alike, and [docs/wiki/Home.md](docs/wiki/Home.md) explains how the code works.

## Set-up

```sh
git clone https://github.com/Luxorium/masthead
cd masthead
npm ci                   # a plain install: the build tools need their optional platform packages
npm run check            # type-check server and page
npm test                 # unit tests, no Claude account needed
npm run build
```

`npm run test:live` drives the real Claude Code and spends real usage. The browser test runs with
`node scripts/ci-e2e.mjs` after `npm run build` (it needs `npx playwright-core install chromium` once):
it starts its own server on the fake backend with fresh data folders and a free port, as CI does.
Never point a test at an installed copy or at port 7717.

## Changes

- Keep a change to one purpose and say why in the pull request.
- Add or update tests for behaviour you change; `npm run check && npm test && npm run test:web && npm run build` must pass.
- Update `docs/wiki/` when behaviour changes, and add a line to `CHANGELOG.md`.
- Masthead never handles credentials and never bundles a private copy of Claude Code; changes that
  would are not accepted.

## Making a release (maintainers)

1. On `next`: `CHANGELOG.md` has a section whose heading is exactly `## <version>` (for example
   `## 0.2.0`); it becomes the release notes. Set the same version in `package.json` (and
   `package-lock.json`, with `npm version <version> --no-git-tag-version`) and in `shared/protocol.ts`.
2. CI is green on that commit. Merge `next` into `main`.
3. Tag the merge with `v<version>` and push the tag: `git tag v0.2.0 && git push origin v0.2.0`.
4. `.github/workflows/release.yml` then checks that the tag matches `package.json`, runs the checks
   and tests, packs the package, installs it once, and creates the GitHub release with the `.tgz` and
   `SHA256SUMS` attached. A tag with a hyphen (`v0.2.0-beta.3`) makes a pre-release; any other tag
   makes the release marked latest. It never publishes to npm.
5. Check the release page: the `.tgz` installs with
   `npm install -g --os=none --cpu=none <its download URL>`.

By contributing you agree that your contribution is licensed under the MIT licence of this project.
Please follow the [code of conduct](CODE_OF_CONDUCT.md).
