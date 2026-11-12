# lightsync-gallery

Static single-page photography gallery designed for GitHub Pages (`https://nexproc.github.io/lightsync-gallery/`) backed by Google Cloud Storage (`3k_exports`).

## Features

- **Aspect-Preserving Auto-Layout:** Combines asymmetric Hero spreads (1 full-height highlight paired alongside 2 stacked companions) with zero-crop justified rows.
- **Proximity-Scaled Hero Carousel:** Opening cover crossfades featured photographs; carousel selectors smoothly double in size as the cursor approaches.
- **Date Navigation & Timeline Scrubber:** Sticky date pills and a right-edge timeline rail jump directly across shoot dates.
- **Progressive Blur-Up & Lazy Hydration:** Pre-allocates exact aspect boxes from `manifest.json` with inline 36px WebP placeholders and hydrates full-resolution masters via `IntersectionObserver`.
- **Fullscreen Zoom Lightbox & Favorites:** 1:1 cursor-panning zoom, keyboard navigation (`←`, `→`, `Z`, `F`, `Esc`), direct downloads, and local `Favorites` selection export.

---

## 1. Google Cloud Storage Setup

1. **Create a US-Regional Bucket** (eligible for Always Free tier + monthly GCP credits):
   ```bash
   export BUCKET="lightsync-gallery-media" # pick a globally unique name
   gcloud storage buckets create "gs://${BUCKET}" \
     --location=us-west1 \
     --uniform-bucket-level-access
   ```

2. **Allow Public Read for Gallery Assets & Apply CORS**:
   ```bash
   gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
     --member=allUsers \
     --role=roles/storage.objectViewer

   gcloud storage buckets update "gs://${BUCKET}" \
     --cors-file=scripts/gcs-cors.json
   ```

3. **Build `manifest.json` & Sync `3k_exports` to GCS**:
   ```bash
   python3 scripts/build_manifest.py \
     --images-dir /path/to/3k_exports \
     --base-url "https://storage.googleapis.com/${BUCKET}/3k_exports" \
     --remote-manifest-url "https://storage.googleapis.com/${BUCKET}/manifest.json" \
     --out manifest.json

   gcloud storage rsync /path/to/3k_exports "gs://${BUCKET}/3k_exports" \
     --cache-control="public, max-age=31536000, immutable"

   gcloud storage cp manifest.json "gs://${BUCKET}/manifest.json" \
     --cache-control="no-cache, max-age=0"
   ```

   Because `remoteManifestUrl` points to `gs://${BUCKET}/manifest.json`, future shoots synced to GCS appear live on GitHub Pages without needing a `git commit` or rebuild.

---

## 2. Enable GitHub Pages

1. Open **Settings → Pages** in this repository.
2. Under **Build and deployment → Source**, select **GitHub Actions** (uses [`.github/workflows/pages.yml`](.github/workflows/pages.yml)).
3. The gallery publishes to `https://nexproc.github.io/lightsync-gallery/`.
