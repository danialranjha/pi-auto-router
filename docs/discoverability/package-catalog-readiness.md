# Pi package catalog readiness

## What I completed

- Added stronger Pi/package-discovery metadata in `package.json`
  - clearer `description`
  - Pi-specific/router-specific `keywords`
  - `pi.image` preview metadata
- Created preview asset at `docs/preview.png`
- Verified the preview asset is a valid PNG (`1280x640`)
- Fixed npm package contents so runtime `src/` files are included in the published tarball
- Verified npm packaging shape with `npm pack --dry-run`
- Confirmed the npm package name `pi-auto-router` is currently unclaimed
- Opened a draft discoverability PR to `qualisero/awesome-pi-agent`
  - PR: `https://github.com/qualisero/awesome-pi-agent/pull/64`
  - evidence file: `docs/discoverability/external-pr-evidence.md`

## Evidence

### `package.json`
- has `keywords` including `pi-package`
- has a `pi` manifest with `extensions`
- now has:

```json
"pi": {
  "extensions": ["./index.ts"],
  "image": "https://raw.githubusercontent.com/danialranjha/pi-auto-router/main/docs/preview.png"
}
```

### Packaging dry-run

`npm pack --dry-run` currently includes:
- `README.md`
- `CHANGELOG.md`
- `LICENSE`
- `auto-router.routes.example.json`
- `index.ts`
- `package.json`
- `src/*.ts` runtime files required by `index.ts`

Dry-run result:
- package name: `pi-auto-router`
- tarball: `pi-auto-router-0.2.0.tgz`
- total files: `30`
- package size: ~79.8 kB

### Preview asset
- file: `docs/preview.png`
- format: `PNG`
- size: `1280x640`

## Things I could not complete directly

### 1) Publish to npm
Reason: requires your npm account/package ownership and publish credentials.

### 2) Make the Pi package catalog actually pick up the package
Reason: depends on npm publication and public package indexing outside this repo.

### 3) Set GitHub topics on the repository
Reason: requires repository settings access in the GitHub web UI.

### 4) Ensure the `pi.image` URL is live
Reason: it will only resolve after you commit and push `docs/preview.png` and the updated `package.json` to the default branch.

### 5) Final compatibility decision on package peer dependency namespace
Reason: this repo currently imports `@mariozechner/*` Pi packages, while current Pi docs reference `@earendil-works/*`. I did not change runtime imports without a dedicated compatibility pass.

### 6) End-to-end install verification from the public npm registry
Reason: I can verify tarball shape locally, but I cannot verify the real `pi install npm:pi-auto-router` path until you publish the package.

## Recommended next user steps

1. Commit and push the current repo changes.
2. Add GitHub topics manually:
   - `pi-package`
   - `pi-agent`
   - `pi-coding-agent`
   - `llm-router`
   - `model-router`
   - `multi-provider`
   - `failover`
3. Review `docs/preview.png`; replace it if you want a more polished visual.
4. Publish to npm:
   - `npm login`
   - `npm publish`
5. After publish, verify install path:
   - `pi install npm:pi-auto-router`
6. Check whether the package appears on `https://pi.dev/packages`.
7. After publish, verify the real install path in Pi:
   - `pi install npm:pi-auto-router`
8. Decide whether you want a follow-up compatibility pass to migrate from `@mariozechner/*` to `@earendil-works/*` imports/peer dependencies.
9. Review and eventually mark ready / merge the awesome-list PR:
   - `https://github.com/qualisero/awesome-pi-agent/pull/64`

## Recommended next assistant steps (if you want me to continue later)

- do a dedicated Pi compatibility audit for `@mariozechner/*` vs `@earendil-works/*`
- improve the preview image
- do one more README conversion pass tuned for npm/package-catalog visitors
- prepare release notes for the first npm publication
