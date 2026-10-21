# Contributing to KeyVault

Thanks for helping. KeyVault holds people's secrets, so a few rules matter more here than in most projects.

## Principles

1. **No runtime dependencies.** Everything in `bin/`, `src/` and `ui/` uses Node's standard library and the browser's built-in APIs. Every dependency is someone else's code running next to people's API keys. Dev dependencies for testing are fine.
2. **No network calls.** No analytics, update checks, fonts, CDNs or "phone home" of any kind. The UI's Content Security Policy must keep `default-src 'none'` and `connect-src 'self'`.
3. **Agents never see values.** No `/agent/*` route or MCP tool may return a key value, and anything that returns process output or logs must pass through the redactor.
4. **No build step.** Plain JavaScript that runs as written. People should be able to read exactly what they are running.
5. **Plain English.** Error messages and UI text should tell a non-developer what happened and what to do next.

## Getting started

```sh
git clone https://github.com/RangerOneSpace/keyvault.git
cd keyvault
npm install
KEYVAULT_HOME=./.dev-vault node bin/keyvault.js serve
```

Using a separate `KEYVAULT_HOME` keeps your real vault out of the way while you work.

## Tests

```sh
npm test               # unit and integration tests
npx playwright test    # browser tests
```

Please add tests with your change. Security-relevant changes need a test that fails without the fix. If you change the port or Docker code, add parser tests with real sample output from the platform you touched, since we cannot run every OS in CI.

## Pull requests

- Keep them focused: one change per pull request.
- Describe what you changed and why, and how you tested it.
- Update the README if behaviour or commands change, and add a line to `CHANGELOG.md`.

## Reporting security issues

Please do not open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).
