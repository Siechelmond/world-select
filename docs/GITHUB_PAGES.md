# GitHub Pages workflow — legacy / inactive

World Select is currently deployed through **Cloudflare Pages**, not GitHub Pages.

The historical GitHub Pages workflow is retained only for reference under:

`.github/workflows/deploy-pages.yml.disabled`

That directory intentionally does not use GitHub's special `.github/` path, so the workflow is **not executed** by GitHub Actions.

## Current deployment model

- Application repository: `world-select`
- Runtime/deployment target: Cloudflare Pages
- Server-side provider routes: `functions/api/`
- Cloudflare environment variables/secrets remain managed in Cloudflare and are never stored in this repository.

The archived workflow must not be activated unless deployment strategy is explicitly changed later.
