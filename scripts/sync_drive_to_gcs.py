#!/usr/bin/env python3
"""Replace existing GCS 3K exports with images from Google Drive and publish manifest.json.

Usage:
  1. Authorize Drive read + GCS access once:
       gcloud auth application-default login \
         --scopes="https://www.googleapis.com/auth/drive.readonly,https://www.googleapis.com/auth/devstorage.full_control"

  2. Wipe old GCS photos, stream all images from Drive 3k_exports -> gs://<BUCKET>/3k_exports,
     apply CORS, and upload manifest.json:
       python3 scripts/sync_drive_to_gcs.py --bucket YOUR_BUCKET_NAME
"""

from __future__ import annotations

import argparse
import base64
import concurrent.futures
import datetime as dt
import hashlib
import json
import mimetypes
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from build_manifest import (
    finalize_manifest_from_records,
    inspect_image_bytes,
    load_photo_sidecar_metadata,
    resolve_stem_sidecar_metadata,
)

DEFAULT_DRIVE_FOLDER_ID = "1v-MDctwhXwaa49xQb6az4_V6hhto8FSQ"
IMAGE_EXTENSIONS = (".jpg", ".jpeg", ".webp", ".png")


def find_gcloud_bin() -> str:
    import shutil

    found = shutil.which("gcloud")
    if found:
        return found
    candidate = Path.home() / "google-cloud-sdk" / "bin" / "gcloud"
    if candidate.exists():
        return str(candidate)
    return "gcloud"


def get_access_token(explicit_token: str = "") -> str:
    if explicit_token:
        return explicit_token.strip()
    env_tok = os.environ.get("GOOGLE_OAUTH_ACCESS_TOKEN", "").strip()
    if env_tok:
        return env_tok
    gcloud_bin = find_gcloud_bin()
    try:
        out = subprocess.check_output(
            [gcloud_bin, "auth", "application-default", "print-access-token"],
            stderr=subprocess.PIPE,
            text=True,
        ).strip()
        if out:
            return out
    except Exception:
        pass
    try:
        out = subprocess.check_output(
            [gcloud_bin, "auth", "print-access-token"],
            stderr=subprocess.PIPE,
            text=True,
        ).strip()
        if out:
            return out
    except Exception as exc:
        raise RuntimeError(
            "Unable to obtain Google access token. Run:\n"
            '  gcloud auth application-default login --scopes="https://www.googleapis.com/auth/drive.readonly,https://www.googleapis.com/auth/devstorage.full_control"'
        ) from exc
    raise RuntimeError("Empty access token from gcloud.")


QUOTA_PROJECT = ""


def detect_gcloud_project(explicit_project: str = "") -> str:
    if explicit_project:
        return explicit_project.strip()
    env_proj = os.environ.get("GOOGLE_CLOUD_PROJECT", "").strip()
    if env_proj:
        return env_proj
    try:
        out = subprocess.check_output(
            [find_gcloud_bin(), "config", "get-value", "project"],
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
        if out and out != "(unset)":
            return out
    except Exception:
        pass
    return ""


def base_headers(token: str) -> dict[str, str]:
    headers = {"Authorization": f"Bearer {token}"}
    if QUOTA_PROJECT:
        headers["X-Goog-User-Project"] = QUOTA_PROJECT
    return headers


def api_json(
    url: str,
    token: str,
    *,
    method: str = "GET",
    body: bytes | None = None,
    content_type: str = "application/json",
) -> dict[str, Any]:
    import time

    headers = base_headers(token)
    if body is not None:
        headers["Content-Type"] = content_type
    for attempt in range(3):
        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                raw = resp.read()
                return json.loads(raw.decode("utf-8")) if raw else {}
        except urllib.error.HTTPError as err:
            if err.code in (429, 500, 502, 503, 504) and attempt < 2:
                time.sleep(1.5 * (attempt + 1))
                continue
            detail = err.read().decode("utf-8", errors="replace")
            if err.code in (401, 403) and "drive" in url:
                raise RuntimeError(
                    f"Google Drive API returned HTTP {err.code}. Ensure Drive API & readonly scope are enabled:\n"
                    "  gcloud services enable drive.googleapis.com storage.googleapis.com\n"
                    '  gcloud auth application-default login --scopes="https://www.googleapis.com/auth/drive.readonly,https://www.googleapis.com/auth/devstorage.full_control"\n'
                    f"Details: {detail}"
                ) from err
            raise RuntimeError(f"HTTP {err.code} on {method} {url}: {detail}") from err
        except OSError:
            if attempt == 2:
                raise
            time.sleep(1.5 * (attempt + 1))
    return {}


def api_bytes(
    url: str,
    token: str,
    *,
    method: str = "GET",
    body: bytes | None = None,
    headers_extra: dict[str, str] | None = None,
) -> bytes:
    import time

    headers = base_headers(token)
    if headers_extra:
        headers.update(headers_extra)
    for attempt in range(3):
        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                return resp.read()
        except urllib.error.HTTPError as err:
            if err.code in (429, 500, 502, 503, 504) and attempt < 2:
                time.sleep(1.5 * (attempt + 1))
                continue
            raise
        except OSError:
            if attempt == 2:
                raise
            time.sleep(1.5 * (attempt + 1))
    return b""


def list_drive_images(folder_id: str, token: str) -> list[dict[str, Any]]:
    files: list[dict[str, Any]] = []
    page_token = ""
    query = f"'{folder_id}' in parents and trashed = false"
    fields = "nextPageToken,files(id,name,mimeType,size,md5Checksum,createdTime,modifiedTime,imageMediaMetadata)"

    while True:
        params = {
            "q": query,
            "pageSize": "1000",
            "fields": fields,
            "orderBy": "name",
            "supportsAllDrives": "true",
            "includeItemsFromAllDrives": "true",
        }
        if page_token:
            params["pageToken"] = page_token
        url = "https://www.googleapis.com/drive/v3/files?" + urllib.parse.urlencode(params)
        data = api_json(url, token)
        for f in data.get("files", []):
            name = f.get("name", "")
            mime = f.get("mimeType", "")
            if mime.startswith("image/") or name.lower().endswith(IMAGE_EXTENSIONS):
                files.append(f)
        page_token = data.get("nextPageToken", "")
        if not page_token:
            break
    return files


def list_local_images(local_dir: Path) -> list[Path]:
    if not local_dir.exists() or not local_dir.is_dir():
        raise RuntimeError(f"Local directory not found: {local_dir}")
    direct = sorted(
        (p for p in local_dir.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS),
        key=lambda p: p.name.lower(),
    )
    if direct:
        return direct
    seen_names: set[str] = set()
    nested: list[Path] = []
    for p in sorted(local_dir.rglob("*"), key=lambda x: str(x).lower()):
        if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS and p.name not in seen_names:
            seen_names.add(p.name)
            nested.append(p)
    return nested


def list_gcs_object_map(bucket: str, token: str) -> dict[str, tuple[int, str]]:
    objects: dict[str, tuple[int, str]] = {}
    page_token = ""
    while True:
        params: dict[str, str] = {
            "maxResults": "1000",
            "fields": "nextPageToken,items(name,size,md5Hash)",
        }
        if page_token:
            params["pageToken"] = page_token
        url = (
            f"https://storage.googleapis.com/storage/v1/b/{urllib.parse.quote(bucket, safe='')}/o?"
            + urllib.parse.urlencode(params)
        )
        data = api_json(url, token)
        for item in data.get("items", []):
            name = item.get("name")
            if name:
                try:
                    sz = int(item.get("size") or 0)
                except (TypeError, ValueError):
                    sz = 0
                objects[name] = (sz, str(item.get("md5Hash") or ""))
        page_token = data.get("nextPageToken", "")
        if not page_token:
            break
    return objects


def list_gcs_objects(bucket: str, token: str) -> list[str]:
    return list(list_gcs_object_map(bucket, token).keys())


def guess_image_mime(filename: str) -> str:
    ext = Path(filename).suffix.lower()
    if ext in (".jpg", ".jpeg"):
        return "image/jpeg"
    if ext == ".webp":
        return "image/webp"
    if ext == ".png":
        return "image/png"
    guessed, _ = mimetypes.guess_type(filename)
    return guessed or "image/jpeg"


def delete_gcs_object(bucket: str, obj_name: str, token: str) -> None:
    encoded_b = urllib.parse.quote(bucket, safe="")
    encoded_o = urllib.parse.quote(obj_name, safe="")
    url = f"https://storage.googleapis.com/storage/v1/b/{encoded_b}/o/{encoded_o}"
    req = urllib.request.Request(url, headers=base_headers(token), method="DELETE")
    try:
        with urllib.request.urlopen(req, timeout=60):
            pass
    except urllib.error.HTTPError as err:
        if err.code != 404:
            raise


def upload_gcs_object(
    bucket: str,
    obj_name: str,
    payload: bytes,
    content_type: str,
    cache_control: str,
    token: str,
) -> None:
    encoded_b = urllib.parse.quote(bucket, safe="")
    meta = json.dumps({"name": obj_name, "cacheControl": cache_control}).encode("utf-8")
    boundary = "===============lightsync_gcs_multipart=="
    body = (
        f"--{boundary}\r\n"
        "Content-Type: application/json; charset=UTF-8\r\n\r\n"
    ).encode("utf-8") + meta + (
        f"\r\n--{boundary}\r\n"
        f"Content-Type: {content_type}\r\n\r\n"
    ).encode("utf-8") + payload + f"\r\n--{boundary}--\r\n".encode("utf-8")

    url = f"https://storage.googleapis.com/upload/storage/v1/b/{encoded_b}/o?uploadType=multipart"
    api_bytes(
        url,
        token,
        method="POST",
        body=body,
        headers_extra={"Content-Type": f"multipart/related; boundary={boundary}"},
    )


def apply_bucket_cors(bucket: str, cors_path: Path, token: str) -> None:
    if not cors_path.exists():
        return
    cors_rules = json.loads(cors_path.read_text(encoding="utf-8"))
    encoded_b = urllib.parse.quote(bucket, safe="")
    url = f"https://storage.googleapis.com/storage/v1/b/{encoded_b}"
    api_json(url, token, method="PATCH", body=json.dumps({"cors": cors_rules}).encode("utf-8"))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bucket", required=True, help="Target GCS bucket name (without gs://)")
    parser.add_argument("--project", default="", help="Optional GCP project ID for API quota header")
    parser.add_argument(
        "--local-dir",
        "--images-dir",
        dest="local_dir",
        type=Path,
        default=None,
        help="Optional local directory of exported .jpg/.webp/.png images to sync directly to GCS (skips Google Drive)",
    )
    parser.add_argument(
        "--drive-folder-id",
        default=DEFAULT_DRIVE_FOLDER_ID,
        help=f"Google Drive folder ID when --local-dir is omitted (default: {DEFAULT_DRIVE_FOLDER_ID})",
    )
    parser.add_argument("--prefix", default="3k_exports", help="Object prefix inside GCS bucket")
    parser.add_argument("--workers", type=int, default=12, help="Parallel transfer workers")
    parser.add_argument(
        "--manifest-out",
        type=Path,
        default=Path(__file__).resolve().parent.parent / "manifest.json",
        help="Local manifest.json path to update",
    )
    parser.add_argument(
        "--exif-from-dir",
        type=Path,
        default=None,
        help="Optional directory of original RAWs, .xmp sidecars, or .lrcat catalog to supply capture dates, star ratings, and XMP mask focal points",
    )
    parser.add_argument(
        "--lrcat",
        type=Path,
        default=None,
        help="Optional Lightroom Classic .lrcat SQLite catalog path for star ratings",
    )
    parser.add_argument(
        "--heroes",
        default="",
        help="Optional comma-separated file stems to force as Highlights",
    )
    parser.add_argument(
        "--manifest-only",
        action="store_true",
        help="Update timestamps, star ratings, and XMP focal points in manifest.json and upload manifest.json to GCS without re-uploading images",
    )
    parser.add_argument(
        "--force-upload",
        action="store_true",
        help="Force re-uploading all images even when GCS already has matching MD5 and byte size",
    )
    parser.add_argument(
        "--exclude",
        default="",
        help="Optional comma-separated file stems or filenames to remove/exclude from GCS and manifest.json",
    )
    parser.add_argument("--access-token", default="", help="Optional OAuth2 access token")
    return parser.parse_args()


def main() -> None:
    global QUOTA_PROJECT
    args = parse_args()
    QUOTA_PROJECT = detect_gcloud_project(args.project)
    bucket = args.bucket.replace("gs://", "").strip("/")
    prefix = args.prefix.strip("/")
    token = get_access_token(args.access_token)
    excluded_stems = {Path(s.strip()).stem for s in args.exclude.split(",") if s.strip()}
    explicit_cli_heroes = {Path(s.strip()).stem for s in args.heroes.split(",") if s.strip()}

    sidecar_meta_map = load_photo_sidecar_metadata(args.exif_from_dir, args.lrcat)
    if args.exif_from_dir or args.lrcat:
        ts_cnt = sum(1 for m in sidecar_meta_map.values() if "timestamp" in m)
        rt_cnt = sum(1 for m in sidecar_meta_map.values() if m.get("rating"))
        fp_cnt = sum(1 for m in sidecar_meta_map.values() if "focalPoint" in m)
        print(
            f"      Loaded sidecar/catalog metadata: {ts_cnt} timestamps, {rt_cnt} star ratings, {fp_cnt} XMP mask focal points"
        )

    base_url = (
        f"https://storage.googleapis.com/{bucket}/{prefix}"
        if prefix
        else f"https://storage.googleapis.com/{bucket}"
    )
    remote_manifest_url = f"https://storage.googleapis.com/{bucket}/manifest.json"

    if args.manifest_only:
        if not args.manifest_out.exists():
            raise RuntimeError(f"Existing manifest not found: {args.manifest_out}")
        existing_manifest = json.loads(args.manifest_out.read_text(encoding="utf-8"))
        existing_coll = existing_manifest.get("collection") or {}
        records_existing = existing_manifest.get("photos") or []

        removed_filenames: list[str] = []
        filtered_existing: list[dict[str, Any]] = []
        for p in records_existing:
            fn = p.get("filename") or f"{p['id']}.jpg"
            stem = Path(fn).stem
            if stem in excluded_stems or p.get("id") in excluded_stems:
                removed_filenames.append(fn)
                continue
            filtered_existing.append(p)

        for fn in removed_filenames:
            obj_name = f"{prefix}/{fn}" if prefix else fn
            delete_gcs_object(bucket, obj_name, token)
        if removed_filenames:
            print(
                f"      Removed {len(removed_filenames)} excluded object(s) from gs://{bucket}/: {', '.join(removed_filenames)}"
            )

        updated_records: list[dict[str, Any]] = []
        for p in filtered_existing:
            rec = dict(p)
            stem = Path(rec.get("filename") or rec["id"]).stem
            meta = resolve_stem_sidecar_metadata(stem, sidecar_meta_map)
            if meta.get("timestamp"):
                rec["timestamp"] = meta["timestamp"]
                rec["date"] = meta["timestamp"][:10]
            if meta.get("rating") is not None:
                rec["_rating"] = meta["rating"]
            if meta.get("focalPoint") is not None:
                rec["focalPoint"] = meta["focalPoint"]
            updated_records.append(rec)

        manifest = finalize_manifest_from_records(
            updated_records,
            base_url=existing_coll.get("assetBaseUrl") or base_url,
            remote_manifest_url=existing_coll.get("remoteManifestUrl") or remote_manifest_url,
            title=existing_coll.get("title") or "",
            subtitle=existing_coll.get("subtitle") or "",
            curator=existing_coll.get("curator") or "",
            explicit_heroes=explicit_cli_heroes or None,
        )
        manifest_bytes = json.dumps(manifest, indent=2).encode("utf-8")
        args.manifest_out.write_text(manifest_bytes.decode("utf-8"), encoding="utf-8")
        upload_gcs_object(
            bucket,
            "manifest.json",
            manifest_bytes,
            "application/json; charset=UTF-8",
            "no-cache, max-age=0",
            token,
        )
        rated_total = sum(1 for p in manifest["photos"] if p.get("rating"))
        max_r = manifest["collection"].get("maxRating")
        top_cnt = (
            sum(1 for p in manifest["photos"] if p.get("rating") == max_r) if max_r else 0
        )
        print(
            f"Updated {args.manifest_out} and uploaded {remote_manifest_url} "
            f"({len(manifest['photos'])} photos across {len(manifest['chapters'])} capture dates; "
            f"{rated_total} rated, {top_cnt} at top {max_r or '-'}★ tier)."
        )
        return

    existing_coll: dict[str, Any] = {}
    if args.manifest_out.exists():
        try:
            existing_coll = json.loads(args.manifest_out.read_text(encoding="utf-8")).get("collection") or {}
        except Exception:
            existing_coll = {}

    local_files: list[Path] = []
    drive_files: list[dict[str, Any]] = []
    if args.local_dir is not None:
        print(f"[1/5] Scanning local directory {args.local_dir} ...")
        local_files = [
            p for p in list_local_images(args.local_dir) if p.stem not in excluded_stems
        ]
        if not local_files:
            print(f"No images found in local directory: {args.local_dir}", file=sys.stderr)
            sys.exit(1)
        source_filenames = {p.name for p in local_files}
        print(f"      Found {len(local_files)} local images.")
    else:
        print(f"[1/5] Listing Google Drive folder {args.drive_folder_id} ...")
        drive_files = [
            f
            for f in list_drive_images(args.drive_folder_id, token)
            if Path(f.get("name", "")).stem not in excluded_stems
        ]
        if not drive_files:
            print("No images found in Drive folder.", file=sys.stderr)
            sys.exit(1)
        source_filenames = {str(f["name"]) for f in drive_files}
        print(f"      Found {len(drive_files)} images in Drive.")

    desired_obj_names = {
        (f"{prefix}/{fn}" if prefix else fn) for fn in source_filenames
    }

    print(f"[2/5] Checking existing objects in gs://{bucket}/ ...")
    existing_map = list_gcs_object_map(bucket, token)
    to_delete = [
        name
        for name in existing_map
        if (name.startswith(f"{prefix}/") or name.lower().endswith(IMAGE_EXTENSIONS))
        and (args.force_upload or name not in desired_obj_names)
    ]
    if to_delete:
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
            list(pool.map(lambda n: delete_gcs_object(bucket, n, token), to_delete))
        for n in to_delete:
            existing_map.pop(n, None)
        print(f"      Removed {len(to_delete)} stale/replaced object(s) from gs://{bucket}/.")
    else:
        print(
            f"      {len(existing_map)} object(s) currently in gs://{bucket}/ (0 stale objects to remove)."
        )

    cors_file = Path(__file__).resolve().parent / "gcs-cors.json"
    print(f"[3/5] Applying CORS policy from {cors_file.name} ...")
    apply_bucket_cors(bucket, cors_file, token)

    total_items = len(local_files) if args.local_dir is not None else len(drive_files)
    src_label = f"local {args.local_dir}" if args.local_dir is not None else "Drive"
    print(f"[4/5] Syncing {total_items} {src_label} images -> gs://{bucket}/{prefix}/ ...")

    def _upload_if_changed(obj_name: str, img_bytes: bytes, mime: str) -> bool:
        if not args.force_upload:
            md5_b64 = base64.b64encode(hashlib.md5(img_bytes).digest()).decode("ascii")
            if existing_map.get(obj_name) == (len(img_bytes), md5_b64):
                return False
        upload_gcs_object(
            bucket,
            obj_name,
            img_bytes,
            mime,
            "public, max-age=31536000, immutable",
            token,
        )
        return True

    def transfer_local_one(path: Path) -> tuple[dict[str, Any], bool]:
        filename = path.name
        img_bytes = path.read_bytes()
        mtime = dt.datetime.fromtimestamp(path.stat().st_mtime, tz=dt.timezone.utc)
        fallback_iso = mtime.strftime("%Y-%m-%dT%H:%M:%S")
        meta = resolve_stem_sidecar_metadata(path.stem, sidecar_meta_map)
        record = inspect_image_bytes(
            img_bytes,
            filename,
            fallback_iso,
            meta.get("timestamp"),
            meta,
        )
        obj_name = f"{prefix}/{filename}" if prefix else filename
        uploaded = _upload_if_changed(obj_name, img_bytes, guess_image_mime(filename))
        return record, uploaded

    def transfer_drive_one(item: dict[str, Any]) -> tuple[dict[str, Any], bool]:
        file_id = item["id"]
        filename = item["name"]
        mime = item.get("mimeType") or guess_image_mime(filename)
        dl_url = f"https://www.googleapis.com/drive/v3/files/{file_id}?alt=media&supportsAllDrives=true"
        img_bytes = api_bytes(dl_url, token)

        raw_t = (
            (item.get("imageMediaMetadata") or {}).get("time")
            or item.get("modifiedTime")
            or item.get("createdTime")
            or "2026-01-01T00:00:00"
        )
        s_ts = str(raw_t).strip().replace(" ", "T", 1)
        if len(s_ts) >= 10 and s_ts[4:5] == ":" and s_ts[7:8] == ":":
            s_ts = s_ts.replace(":", "-", 2)
        fallback_iso = s_ts[:19]
        meta = resolve_stem_sidecar_metadata(Path(filename).stem, sidecar_meta_map)
        record = inspect_image_bytes(
            img_bytes,
            filename,
            fallback_iso,
            meta.get("timestamp"),
            meta,
        )

        obj_name = f"{prefix}/{filename}" if prefix else filename
        uploaded = _upload_if_changed(obj_name, img_bytes, mime)
        return record, uploaded

    records: list[dict[str, Any]] = []
    done_count = 0
    uploaded_count = 0
    skipped_count = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        if args.local_dir is not None:
            futures = [pool.submit(transfer_local_one, p) for p in local_files]
        else:
            futures = [pool.submit(transfer_drive_one, item) for item in drive_files]
        for fut in concurrent.futures.as_completed(futures):
            rec, was_uploaded = fut.result()
            records.append(rec)
            done_count += 1
            if was_uploaded:
                uploaded_count += 1
            else:
                skipped_count += 1
            if done_count % 25 == 0 or done_count == total_items:
                print(
                    f"      Processed {done_count}/{total_items} photos "
                    f"({uploaded_count} uploaded, {skipped_count} unchanged in GCS)..."
                )

    print(f"[5/5] Writing manifest.json and uploading to {remote_manifest_url} ...")
    manifest = finalize_manifest_from_records(
        records,
        base_url=base_url,
        remote_manifest_url=remote_manifest_url,
        title=existing_coll.get("title") or "",
        subtitle=existing_coll.get("subtitle") or "",
        curator=existing_coll.get("curator") or "",
        explicit_heroes=explicit_cli_heroes or None,
    )
    manifest_bytes = json.dumps(manifest, indent=2).encode("utf-8")
    args.manifest_out.write_text(manifest_bytes.decode("utf-8"), encoding="utf-8")
    upload_gcs_object(
        bucket,
        "manifest.json",
        manifest_bytes,
        "application/json; charset=UTF-8",
        "no-cache, max-age=0",
        token,
    )
    rated_total = sum(1 for p in manifest["photos"] if p.get("rating"))
    max_r = manifest["collection"].get("maxRating")
    top_cnt = sum(1 for p in manifest["photos"] if p.get("rating") == max_r) if max_r else 0
    print(
        f"Done! {len(records)} photos live at {base_url}/ "
        f"({uploaded_count} uploaded, {skipped_count} unchanged; "
        f"{rated_total} rated, {top_cnt} at top {max_r or '-'}★ tier)."
    )


if __name__ == "__main__":
    main()
