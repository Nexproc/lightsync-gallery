#!/usr/bin/env python3
"""Generate manifest.json (dimensions, dates, hero flags, WebP LQIPs) for lightsync-gallery."""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import glob
import io
import json
import re
from pathlib import Path
from PIL import Image

# Optional date & title defaults for exports without embedded EXIF DateTimeOriginal
DATE_OVERRIDES: dict[str, tuple[str, str, str]] = {
    "NIK28558": ("2026-09-01T20:14:00", "2026-09-01", "Ceremonial Bowl & Wood"),
    "NIK28564": ("2026-09-01T20:42:00", "2026-09-01", "Butterfly Citrus Coupe"),
    "NIK38891": ("2026-09-06T21:18:00", "2026-09-06", "Tall Crimson Highball"),
    "NIK38964": ("2026-09-07T21:50:00", "2026-09-07", "Smoked Old Fashioned"),
}

SESSION_TITLES: dict[str, str] = {
    "NIK39096": "Entrance Brass Plaque",
    "NIK39097": "Menu & Pleated Lamp",
    "NIK39099": "Rocks Glass by Lamplight",
    "NIK39100": "Garnish by Table Glow",
    "NIK39101": "Fireside Grin",
    "NIK39102": "Portrait in Warm Amber",
    "NIK39103": "Sideward Glance",
    "NIK39105": "King Cube Coupe I",
    "NIK39106": "King Cube Coupe II",
    "NIK39107": "Ruby Snifter & Shade",
    "NIK39108": "Spiced Coupe & Brass Lamp",
    "NIK39109": "The Illuminated Backbar I",
    "NIK39110": "The Illuminated Backbar II",
    "NIK39112": "Profile in Chiaroscuro",
    "NIK39115": "Ambient Light Portrait",
    "NIK39116": "Twilight Votive & Window",
}

CHAPTER_META: dict[str, dict[str, str]] = {
    "2026-09-01": {
        "label": "Sep 01",
        "fullDate": "September 1, 2026",
        "title": "Opening Pours",
        "subtitle": "Tabletop studies on stone and linen",
    },
    "2026-09-06": {
        "label": "Sep 06",
        "fullDate": "September 6, 2026",
        "title": "Late Afternoon Highball",
        "subtitle": "Long shadows across veined marble",
    },
    "2026-09-07": {
        "label": "Sep 07",
        "fullDate": "September 7, 2026",
        "title": "Amber & Ice",
        "subtitle": "Low-key spirit study",
    },
    "2026-11-11": {
        "label": "Nov 11",
        "fullDate": "November 11, 2026",
        "title": "November Evening",
        "subtitle": "Portraits, brass table lamps, and cocktails after dusk",
    },
}

DEFAULT_HERO_IDS = {
    "NIK39096",
    "NIK28564",
    "NIK38891",
    "NIK39102",
    "NIK39108",
    "NIK39109",
    "NIK39115",
}


def extract_exif_datetime(im: Image.Image) -> str | None:
    exif = im.getexif()
    if not exif:
        return None
    ifd = exif.get_ifd(0x8769) if hasattr(exif, "get_ifd") else {}
    raw_dt = ifd.get(36867) or exif.get(306)
    if not raw_dt:
        return None
    return str(raw_dt).strip().replace(":", "-", 2).replace(" ", "T", 1)


def extract_xmp_rating(path: Path) -> int | None:
    head = path.read_bytes()[:65536]
    match = re.search(rb'xmp:Rating="([^"]+)"|<xmp:Rating>([^<]+)</xmp:Rating>', head)
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


def format_chapter_fallback(day_key: str) -> dict[str, str]:
    try:
        parsed = dt.date.fromisoformat(day_key)
        return {
            "label": parsed.strftime("%b %d"),
            "fullDate": parsed.strftime("%B %-d, %Y"),
            "title": parsed.strftime("%B %-d"),
            "subtitle": "",
        }
    except ValueError:
        return {
            "label": day_key[5:],
            "fullDate": day_key,
            "title": day_key,
            "subtitle": "",
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
        "--out",
        type=Path,
        default=Path(__file__).resolve().parent.parent / "manifest.json",
        help="Output manifest.json path",
    )
    parser.add_argument(
        "--base-url",
        default="./3k_exports",
        help="Public base URL where images are hosted (e.g. https://storage.googleapis.com/<bucket>/3k_exports)",
    )
    parser.add_argument(
        "--remote-manifest-url",
        default="",
        help="Optional live GCS manifest.json URL for zero-rebuild updates on GitHub Pages",
    )
    parser.add_argument("--title", default="After Hours", help="Collection title")
    parser.add_argument(
        "--subtitle",
        default="Evening portraits and tabletop studies.",
        help="Collection subtitle",
    )
    parser.add_argument("--curator", default="Nick Titcombe", help="Photographer credit")
    parser.add_argument(
        "--heroes",
        default="",
        help="Optional comma-separated file stems to mark as Hero highlights",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    hero_set = (
        {s.strip() for s in args.heroes.split(",") if s.strip()}
        if args.heroes
        else DEFAULT_HERO_IDS
    )

    patterns = ["*.jpg", "*.JPG", "*.jpeg", "*.JPEG", "*.webp", "*.WEBP"]
    all_paths: list[Path] = []
    for pat in patterns:
        all_paths.extend(Path(p) for p in glob.glob(str(args.images_dir / pat)))
    paths = sorted(set(all_paths))

    photos = []
    for idx, path in enumerate(paths):
        stem = path.stem
        with Image.open(path) as im:
            width, height = im.size
            exif_dt = extract_exif_datetime(im)
            lqip, dom_color = make_lqip_and_color(im)

        rating = extract_xmp_rating(path)
        if stem in DATE_OVERRIDES:
            iso_ts, day_key, title = DATE_OVERRIDES[stem]
        elif exif_dt:
            iso_ts = exif_dt
            day_key = exif_dt[:10]
            title = SESSION_TITLES.get(stem, stem)
        else:
            ts = dt.datetime(2026, 11, 11, 20, 0, 0) + dt.timedelta(minutes=idx * 4)
            iso_ts = ts.strftime("%Y-%m-%dT%H:%M:%S")
            day_key = "2026-11-11"
            title = SESSION_TITLES.get(stem, stem)

        is_hero = (rating is not None and rating >= 4) or (stem in hero_set)

        photos.append(
            {
                "id": stem,
                "filename": path.name,
                "title": title,
                "timestamp": iso_ts,
                "date": day_key,
                "width": width,
                "height": height,
                "aspect": round(width / height, 5),
                "orientation": "landscape" if width >= height else "portrait",
                "hero": is_hero,
                "dominantColor": dom_color,
                "lqip": lqip,
            }
        )

    photos.sort(key=lambda item: (item["timestamp"], item["id"]))

    seen_dates: list[str] = []
    for p in photos:
        if p["date"] not in seen_dates:
            seen_dates.append(p["date"])

    chapters = []
    for d_key in seen_dates:
        meta = CHAPTER_META.get(d_key, format_chapter_fallback(d_key))
        day_photos = [p for p in photos if p["date"] == d_key]
        chapters.append(
            {
                "date": d_key,
                "label": meta["label"],
                "fullDate": meta["fullDate"],
                "title": meta["title"],
                "subtitle": meta["subtitle"],
                "count": len(day_photos),
            }
        )

    date_range = ""
    if seen_dates:
        first_m = CHAPTER_META.get(seen_dates[0], format_chapter_fallback(seen_dates[0]))["fullDate"]
        last_m = CHAPTER_META.get(seen_dates[-1], format_chapter_fallback(seen_dates[-1]))["fullDate"]
        date_range = first_m if first_m == last_m else f"{first_m} – {last_m}"

    collection_obj: dict[str, object] = {
        "title": args.title,
        "curator": args.curator,
        "subtitle": args.subtitle,
        "dateRange": date_range,
        "assetBaseUrl": args.base_url.rstrip("/"),
        "totalPhotos": len(photos),
    }
    if args.remote_manifest_url:
        collection_obj["remoteManifestUrl"] = args.remote_manifest_url

    manifest = {
        "collection": collection_obj,
        "chapters": chapters,
        "photos": photos,
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"Wrote {args.out} ({len(photos)} photos across {len(chapters)} chapters)")


if __name__ == "__main__":
    main()
