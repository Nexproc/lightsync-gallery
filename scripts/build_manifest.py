#!/usr/bin/env python3
"""Generate manifest.json (dimensions, dates, LQIPs) directly from an image folder."""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import glob
import io
import json
import re
from pathlib import Path
from typing import Any
from PIL import Image


def extract_exif_or_xmp_datetime(im: Image.Image, raw_head: bytes) -> str | None:
    exif = im.getexif()
    if exif:
        ifd = exif.get_ifd(0x8769) if hasattr(exif, "get_ifd") else {}
        raw_dt = ifd.get(36867) or ifd.get(36868) or exif.get(306)
        if raw_dt:
            cleaned = str(raw_dt).strip().replace(":", "-", 2).replace(" ", "T", 1)
            if len(cleaned) >= 10 and cleaned[:4].isdigit():
                return cleaned[:19]

    match = re.search(
        rb'(?:DateCreated|CreateDate)[=">]+([0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2})',
        raw_head,
    )
    if match:
        return match.group(1).decode("ascii", errors="ignore").replace(" ", "T", 1)
    return None


def extract_xmp_rating(raw_head: bytes) -> int | None:
    match = re.search(rb'xmp:Rating="([^"]+)"|<xmp:Rating>([^<]+)</xmp:Rating>', raw_head)
    if not match:
        return None
    val = (match.group(1) or match.group(2)).decode("utf-8", errors="ignore")
    try:
        return int(val)
    except ValueError:
        return None


def make_lqip_and_color(im: Image.Image) -> tuple[str, str]:
    thumb = im.copy()
    thumb.thumbnail((36, 36), Image.Resampling.LANCZOS)
    if thumb.mode != "RGB":
        thumb = thumb.convert("RGB")
    buf = io.BytesIO()
    thumb.save(buf, format="WEBP", quality=68)
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")

    px = thumb.resize((1, 1), Image.Resampling.BOX).getpixel((0, 0))
    dom_hex = f"#{px[0]:02x}{px[1]:02x}{px[2]:02x}"
    return f"data:image/webp;base64,{b64}", dom_hex


def format_date_labels(day_key: str, multi_year: bool = False) -> tuple[str, str]:
    try:
        parsed = dt.date.fromisoformat(day_key)
        short_fmt = "%b %d, '%y" if multi_year else "%b %d"
        return parsed.strftime(short_fmt), parsed.strftime("%B %-d, %Y")
    except ValueError:
        return day_key, day_key


def finalize_manifest_from_records(
    raw_photos: list[dict[str, Any]],
    *,
    base_url: str = "./3k_exports",
    remote_manifest_url: str = "",
    title: str = "",
    subtitle: str = "",
    curator: str = "",
    explicit_heroes: set[str] | None = None,
) -> dict[str, Any]:
    raw_photos.sort(key=lambda item: (item["timestamp"], item["id"]))

    explicit = explicit_heroes or set()
    has_rated = any((p.get("_rating") or 0) >= 4 for p in raw_photos)

    for idx, p in enumerate(raw_photos):
        rating = p.pop("_rating", None)
        if explicit:
            p["hero"] = p["id"] in explicit
        elif has_rated:
            p["hero"] = bool(rating is not None and rating >= 4)
        else:
            p["hero"] = idx % 6 == 0

    seen_dates: list[str] = []
    for p in raw_photos:
        if p["date"] not in seen_dates:
            seen_dates.append(p["date"])

    years = {d[:4] for d in seen_dates if len(d) >= 4}
    multi_year = len(years) > 1

    chapters = []
    for d_key in seen_dates:
        label, full_date = format_date_labels(d_key, multi_year=multi_year)
        day_count = sum(1 for p in raw_photos if p["date"] == d_key)
        chapters.append(
            {
                "date": d_key,
                "label": label,
                "fullDate": full_date,
                "count": day_count,
            }
        )

    date_range = ""
    if chapters:
        first_full = chapters[0]["fullDate"]
        last_full = chapters[-1]["fullDate"]
        date_range = first_full if first_full == last_full else f"{first_full} – {last_full}"

    collection_obj: dict[str, Any] = {
        "assetBaseUrl": base_url.rstrip("/"),
        "totalPhotos": len(raw_photos),
        "dateRange": date_range,
    }
    if title:
        collection_obj["title"] = title
    if subtitle:
        collection_obj["subtitle"] = subtitle
    if curator:
        collection_obj["curator"] = curator
    if remote_manifest_url:
        collection_obj["remoteManifestUrl"] = remote_manifest_url

    return {
        "collection": collection_obj,
        "chapters": chapters,
        "photos": raw_photos,
    }


def inspect_image_bytes(
    data: bytes,
    filename: str,
    fallback_iso_ts: str,
) -> dict[str, Any]:
    stem = Path(filename).stem
    raw_head = data[:65536]
    with Image.open(io.BytesIO(data)) as im:
        width, height = im.size
        exif_dt = extract_exif_or_xmp_datetime(im, raw_head)
        lqip, dom_color = make_lqip_and_color(im)

    iso_ts = exif_dt or fallback_iso_ts
    day_key = iso_ts[:10]
    rating = extract_xmp_rating(raw_head)

    return {
        "id": stem,
        "filename": filename,
        "timestamp": iso_ts,
        "date": day_key,
        "width": width,
        "height": height,
        "aspect": round(width / height, 5),
        "orientation": "landscape" if width >= height else "portrait",
        "dominantColor": dom_color,
        "lqip": lqip,
        "_rating": rating,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--images-dir",
        type=Path,
        required=True,
        help="Directory containing exported .jpg/.webp photographs",
    )
    parser.add_argument(
        "--drive-metadata-json",
        type=Path,
        default=None,
        help="Optional JSON file from Drive listing to supply createdTime/modifiedTime when EXIF is stripped",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=Path(__file__).resolve().parent.parent / "manifest.json",
        help="Output manifest.json path",
    )
    parser.add_argument(
        "--base-url",
        "--asset-base-url",
        dest="base_url",
        default="./3k_exports",
        help="Public base URL where images are hosted (e.g. https://storage.googleapis.com/<bucket>/3k_exports)",
    )
    parser.add_argument(
        "--remote-manifest-url",
        default="",
        help="Optional live GCS manifest.json URL for zero-rebuild updates on GitHub Pages",
    )
    parser.add_argument("--title", default="", help="Optional collection title")
    parser.add_argument("--subtitle", default="", help="Optional collection subtitle")
    parser.add_argument("--curator", default="", help="Optional photographer credit")
    parser.add_argument(
        "--heroes",
        default="",
        help="Optional comma-separated file stems to mark as Hero highlights",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    explicit_heroes = {s.strip() for s in args.heroes.split(",") if s.strip()}

    drive_ts_by_name: dict[str, str] = {}
    if args.drive_metadata_json and args.drive_metadata_json.exists():
        items = json.loads(args.drive_metadata_json.read_text(encoding="utf-8"))
        for item in items:
            raw_t = (
                (item.get("imageMediaMetadata") or {}).get("time")
                or item.get("modifiedTime")
                or item.get("createdTime")
            )
            if raw_t and "name" in item:
                s = str(raw_t).strip().replace(" ", "T", 1)
                if len(s) >= 10 and s[4:5] == ":" and s[7:8] == ":":
                    s = s.replace(":", "-", 2)
                drive_ts_by_name[item["name"]] = s[:19]

    patterns = ["*.jpg", "*.JPG", "*.jpeg", "*.JPEG", "*.webp", "*.WEBP"]
    all_paths: list[Path] = []
    for pat in patterns:
        all_paths.extend(Path(p) for p in glob.glob(str(args.images_dir / pat)))
    paths = sorted(set(all_paths))

    raw_photos: list[dict[str, Any]] = []
    for path in paths:
        fallback_dt = drive_ts_by_name.get(path.name)
        if not fallback_dt:
            mtime = dt.datetime.fromtimestamp(path.stat().st_mtime, tz=dt.timezone.utc)
            fallback_dt = mtime.strftime("%Y-%m-%dT%H:%M:%S")
        raw_photos.append(inspect_image_bytes(path.read_bytes(), path.name, fallback_dt))

    manifest = finalize_manifest_from_records(
        raw_photos,
        base_url=args.base_url,
        remote_manifest_url=args.remote_manifest_url,
        title=args.title,
        subtitle=args.subtitle,
        curator=args.curator,
        explicit_heroes=explicit_heroes,
    )

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(
        f"Wrote {args.out} ({len(manifest['photos'])} photos across {len(manifest['chapters'])} date groups)"
    )


if __name__ == "__main__":
    main()
