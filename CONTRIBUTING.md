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

`npm run test:live` drives the real Claude Code and spends real usage. Run the page and the browser
test only against a test server started with its own `XDG_CONFIG_HOME` and `XDG_DATA_HOME` on a port
other than 7717, never against an installed copy.

## Changes

- Keep a change to one purpose and say why in the pull request.
- Add or update tests for behaviour you change; `npm run check && npm test && npm run build` must pass.
- Update `docs/wiki/` when behaviour changes, and add a line to `CHANGELOG.md`.
- Masthead never handles credentials and never bundles a private copy of Claude Code; changes that
  would are not accepted.

By contributing you agree that your contribution is licensed under the MIT licence of this project.
Please follow the [code of conduct](CODE_OF_CONDUCT.md).
