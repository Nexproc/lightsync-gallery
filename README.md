# lightsync-gallery

Static single-page photography gallery published via GitHub Pages (`https://www.nicktitcombe.com/lightsync-gallery/`) and backed by Google Cloud Storage (`3k_exports`).

## Features

- **Aspect-Preserving Auto-Layout:** Combines asymmetric Hero spreads (1 full-height highlight paired alongside 2 stacked companions) with zero-crop justified rows.
- **Proximity-Scaled Hero Carousel:** Full-bleed opening cover with carousel selectors that smoothly double in size as the cursor approaches.
- **Automatic Date Navigation:** Sticky date pills and a right-edge timeline rail appear automatically whenever multiple capture/export dates exist.
- **Progressive Blur-Up & Lazy Hydration:** Pre-allocates exact aspect boxes from `manifest.json` with inline 36px WebP placeholders and hydrates full-resolution masters via `IntersectionObserver`.
- **Fullscreen Zoom Lightbox & Local Favorites:** Cursor-panning zoom, keyboard navigation (`←`, `→`, `Z`, `F`, `Esc`), direct downloads, and browser-saved `Favorites` filtering.

---

## Sync Google Drive `3k_exports` → Google Cloud Storage

`scripts/sync_drive_to_gcs.py` wipes any previously uploaded images in your GCS bucket, streams all photographs directly from the Google Drive `3k_exports` folder (`1v-MDctwhXwaa49xQb6az4_V6hhto8FSQ`), applies `scripts/gcs-cors.json`, and uploads a fresh `manifest.json`.

1. **Authorize Drive read + GCS access once:**
   ```bash
   pip install Pillow
   gcloud auth application-default login \
     --scopes="https://www.googleapis.com/auth/drive.readonly,https://www.googleapis.com/auth/devstorage.full_control"
   ```

2. **Sync Drive folder → GCS bucket & update `manifest.json`:**
   ```bash
   export BUCKET="your-gcs-bucket-name"

   python3 scripts/sync_drive_to_gcs.py --bucket "$BUCKET"
   ```

3. **Commit `manifest.json` once** (so the repository points to `https://storage.googleapis.com/$BUCKET/manifest.json`):
   ```bash
   git add manifest.json
   git commit -m "Configure GCS bucket URL in manifest.json"
   git push
   ```
   After `remoteManifestUrl` is committed once, future syncs via `scripts/sync_drive_to_gcs.py --bucket "$BUCKET"` update the live gallery immediately without needing a new git commit.

4. **Sync Lightroom star ratings & XMP mask focal points (metadata-only, no image re-upload):**
   ```bash
   python3 scripts/sync_drive_to_gcs.py \
     --bucket "$BUCKET" \
     --manifest-only \
     --exif-from-dir /path/to/raws_or_finished_library \
     --lrcat /path/to/Lightroom\ Catalog.lrcat
   ```
   - **Hero Carousel:** Selects only top-rated photos (`maxRating`, e.g. `5★`) matching the viewer's screen orientation (landscape on desktop, portrait on phones) and anchors `object-position` to XMP AI mask `ReferencePoint` coordinates (or optical-focus saliency when no mask is present).
   - **Highlights Tab:** Filters to `4★+` photos.

---

## Local Folder Build (Optional)

If exporting directly from a local folder instead of Google Drive:

```bash
python3 scripts/build_manifest.py \
  --images-dir /path/to/3k_exports \
  --base-url "https://storage.googleapis.com/$BUCKET/3k_exports" \
  --remote-manifest-url "https://storage.googleapis.com/$BUCKET/manifest.json" \
  --out manifest.json
```
