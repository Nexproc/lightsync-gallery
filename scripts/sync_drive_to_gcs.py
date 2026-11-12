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
import concurrent.futures
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from build_manifest import finalize_manifest_from_records, inspect_image_bytes

DEFAULT_DRIVE_FOLDER_ID = "1v-MDctwhXwaa49xQb6az4_V6hhto8FSQ"
IMAGE_EXTENSIONS = (".jpg", ".jpeg", ".webp", ".png")


def get_access_token(explicit_token: str = "") -> str:
    if explicit_token:
        return explicit_token.strip()
    env_tok = os.environ.get("GOOGLE_OAUTH_ACCESS_TOKEN", "").strip()
    if env_tok:
        return env_tok
    try:
        out = subprocess.check_output(
            ["gcloud", "auth", "application-default", "print-access-token"],
            stderr=subprocess.PIPE,
            text=True,
        ).strip()
        if out:
            return out
    except Exception:
        pass
    try:
        out = subprocess.check_output(
            ["gcloud", "auth", "print-access-token"],
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
            ["gcloud", "config", "get-value", "project"],
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
    fields = "nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime,imageMediaMetadata)"

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


def list_gcs_objects(bucket: str, token: str) -> list[str]:
    names: list[str] = []
    page_token = ""
    while True:
        params: dict[str, str] = {"maxResults": "1000", "fields": "nextPageToken,items(name)"}
        if page_token:
            params["pageToken"] = page_token
        url = (
            f"https://storage.googleapis.com/storage/v1/b/{urllib.parse.quote(bucket, safe='')}/o?"
            + urllib.parse.urlencode(params)
        )
        data = api_json(url, token)
        for item in data.get("items", []):
            if "name" in item:
                names.append(item["name"])
        page_token = data.get("nextPageToken", "")
        if not page_token:
            break
    return names


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
        "--drive-folder-id",
        default=DEFAULT_DRIVE_FOLDER_ID,
        help=f"Google Drive folder ID (default: {DEFAULT_DRIVE_FOLDER_ID})",
    )
    parser.add_argument("--prefix", default="3k_exports", help="Object prefix inside GCS bucket")
    parser.add_argument("--workers", type=int, default=12, help="Parallel transfer workers")
    parser.add_argument(
        "--manifest-out",
        type=Path,
        default=Path(__file__).resolve().parent.parent / "manifest.json",
        help="Local manifest.json path to update",
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

    print(f"[1/5] Listing Google Drive folder {args.drive_folder_id} ...")
    drive_files = list_drive_images(args.drive_folder_id, token)
    if not drive_files:
        print("No images found in Drive folder.", file=sys.stderr)
        sys.exit(1)
    print(f"      Found {len(drive_files)} images in Drive.")

    print(f"[2/5] Removing existing photos in gs://{bucket}/ ...")
    existing = list_gcs_objects(bucket, token)
    to_delete = [
        name
        for name in existing
        if name.startswith(f"{prefix}/") or name.lower().endswith(IMAGE_EXTENSIONS)
    ]
    if to_delete:
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
            list(pool.map(lambda n: delete_gcs_object(bucket, n, token), to_delete))
        print(f"      Deleted {len(to_delete)} old objects from gs://{bucket}/.")
    else:
        print("      Bucket already clean (0 existing image objects).")

    cors_file = Path(__file__).resolve().parent / "gcs-cors.json"
    print(f"[3/5] Applying CORS policy from {cors_file.name} ...")
    apply_bucket_cors(bucket, cors_file, token)

    print(f"[4/5] Streaming {len(drive_files)} Drive images -> gs://{bucket}/{prefix}/ ...")
    done_count = 0

    def transfer_one(item: dict[str, Any]) -> dict[str, Any]:
        file_id = item["id"]
        filename = item["name"]
        mime = item.get("mimeType") or "image/jpeg"
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
        record = inspect_image_bytes(img_bytes, filename, fallback_iso)

        obj_name = f"{prefix}/{filename}" if prefix else filename
        upload_gcs_object(
            bucket,
            obj_name,
            img_bytes,
            mime,
            "public, max-age=31536000, immutable",
            token,
        )
        return record

    records: list[dict[str, Any]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(transfer_one, item) for item in drive_files]
        for fut in concurrent.futures.as_completed(futures):
            records.append(fut.result())
            done_count += 1
            if done_count % 25 == 0 or done_count == len(drive_files):
                print(f"      Uploaded {done_count}/{len(drive_files)} photos...")

    base_url = (
        f"https://storage.googleapis.com/{bucket}/{prefix}"
        if prefix
        else f"https://storage.googleapis.com/{bucket}"
    )
    remote_manifest_url = f"https://storage.googleapis.com/{bucket}/manifest.json"

    print(f"[5/5] Writing manifest.json and uploading to {remote_manifest_url} ...")
    manifest = finalize_manifest_from_records(
        records,
        base_url=base_url,
        remote_manifest_url=remote_manifest_url,
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
    print(f"Done! {len(records)} photos live at {base_url}/")


if __name__ == "__main__":
    main()
