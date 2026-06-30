# Air T2

Static QR-broadcast transfer demo for screen-to-camera data exchange.

## GitHub Pages Deploy

This repo is already set up for GitHub Pages via GitHub Actions.

### 1. Push the branch

The workflow deploys on pushes to:

- `feature/web-application-support`

### 2. Enable Pages in GitHub

In the GitHub repo:

1. Open `Settings`
2. Open `Pages`
3. Under `Build and deployment`, choose `Source: GitHub Actions`

### 3. Wait for the workflow

After the workflow finishes, the site URL should be:

- `https://sambuaneesh.github.io/air-transfer/`

If GitHub gives a different Pages URL in the Actions output, use that exact URL.

## Local Dev

```bash
npm install
npm run dev
```

## Why Pages

GitHub Pages serves over HTTPS, which is a secure origin. That gives camera access a much better chance of working on mobile than plain LAN HTTP.
