# Contributing

Thanks for helping! This project has **zero runtime dependencies** (Node built-ins only) — please keep it that way.

## Setup

```sh
git clone https://github.com/fab-agent/community && cd community
npm test        # node:test, Node 22+
npm run check   # syntax check
```

Link the plugin into Herdr for manual testing: `herdr plugin install ./` (or your clone path). The Worker lives in `server/`; copy `server/wrangler.example.jsonc` to `server/wrangler.jsonc` and fill in your own D1 id.

## Pull requests

1. Open an issue first for anything larger than a small fix.
2. Branch from `main`; `main` is protected, so changes go through a PR with passing CI.
3. Add or update tests in `test/` for behaviour changes (server and client).
4. Keep input sanitisation intact: anything shown in a terminal must go through `clean`/`oneLine`.
5. Update the README (and bump `version` in `herdr-plugin.toml` for releases).

## Security

Report vulnerabilities privately — see [SECURITY.md](SECURITY.md).

By contributing you agree that your work is licensed under the [MIT License](LICENSE) and that you follow the [Code of Conduct](CODE_OF_CONDUCT.md).
