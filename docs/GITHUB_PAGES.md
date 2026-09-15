# GitHub Pages deployment

World Select is configured as a static Next.js export for GitHub Pages.

## Repository isolation

This workflow is scoped to the `world-select` repository only. It does not access or deploy any other repository, Vercel project, database, or environment.

## Deployment path

For repository `Siechelmond/world-select`, the published project site is expected under:

`https://siechelmond.github.io/world-select/`

The exact Pages URL is reported by the `Deploy World Select to GitHub Pages` workflow after a successful deployment.

## One-time GitHub setting

In the repository, open:

`Settings -> Pages -> Build and deployment -> Source`

Choose **GitHub Actions**.

After that, a push to `main` triggers the Pages workflow automatically. The workflow can also be started manually from the Actions tab.

## Build behavior

- Next.js uses `output: "export"`.
- During GitHub Actions the app uses `/world-select` as its `basePath` and `assetPrefix`.
- The generated static site is written to `out/`.
- No database or server runtime is required for MVP v1.
- CesiumJS is currently loaded from jsDelivr in the browser.
- Earthquake data is fetched client-side from the public USGS GeoJSON feed.
