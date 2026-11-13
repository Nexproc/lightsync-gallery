#!/usr/bin/env python3
"""Generate manifest.json (dimensions, dates, ratings, focal points, LQIPs) from an image folder."""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import glob
import io
import json
import math
import re
import sqlite3
from pathlib import Path
from typing import Any
from PIL import Image, ImageFilter


RAW_AND_SIDECAR_EXTS = {
    ".xmp",
    ".cr3",
    ".cr2",
    ".dng",
    ".nef",
    ".arw",
    ".raf",
    ".orf",
    ".rw2",
    ".jpg",
    ".jpeg",
}


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
        rb'(?:DateCreated|CreateDate|DateTimeOriginal)[=">]+([0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2})',
        raw_head,
    )
    if match:
        return match.group(1).decode("ascii", errors="ignore").replace(" ", "T", 1)
    return None


def extract_capture_timestamp_from_bytes(raw_head: bytes) -> str | None:
    xmp_match = re.search(
        rb'(?:exif:DateTimeOriginal|photoshop:DateCreated|xmp:CreateDate)[=">]+([0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2})',
        raw_head,
    )
    if xmp_match:
        return xmp_match.group(1).decode("ascii", errors="ignore").replace(" ", "T", 1)

    exif_ascii = re.search(
        rb"([12][0-9]{3}:[01][0-9]:[0-3][0-9] [0-2][0-9]:[0-5][0-9]:[0-5][0-9])",
        raw_head,
    )
    if exif_ascii:
        return (
            exif_ascii.group(1)
            .decode("ascii", errors="ignore")
            .replace(":", "-", 2)
            .replace(" ", "T", 1)
        )
    return None


def extract_xmp_rating(raw_bytes: bytes) -> int | None:
    match = re.search(
        rb'xmp:Rating="([^"]+)"|<xmp:Rating>([^<]+)</xmp:Rating>',
        raw_bytes,
    )
    if not match:
        return None
    val = (match.group(1) or match.group(2)).decode("utf-8", errors="ignore").strip()
    try:
        parsed = int(float(val))
        return max(-1, min(5, parsed))
    except ValueError:
        return None


def _sensor_to_display_point(sx: float, sy: float, orientation: int) -> tuple[float, float]:
    x = max(0.0, min(1.0, sx))
    y = max(0.0, min(1.0, sy))
    if orientation == 2:
        return 1.0 - x, y
    if orientation == 3:
        return 1.0 - x, 1.0 - y
    if orientation == 4:
        return x, 1.0 - y
    if orientation == 5:
        return y, x
    if orientation == 6:
        return 1.0 - y, x
    if orientation == 7:
        return 1.0 - y, 1.0 - x
    if orientation == 8:
        return y, 1.0 - x
    return x, y


def _sensor_to_display_box(
    top: float, left: float, bottom: float, right: float, orientation: int
) -> tuple[float, float, float, float]:
    dx0, dy0 = _sensor_to_display_point(left, top, orientation)
    dx1, dy1 = _sensor_to_display_point(right, bottom, orientation)
    return min(dy0, dy1), min(dx0, dx1), max(dy0, dy1), max(dx0, dx1)


def _local_tag(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag.split(":", 1)[-1]


def _elem_crs_map(elem: Any) -> dict[str, str]:
    fields: dict[str, str] = {}
    for k, v in elem.attrib.items():
        fields[_local_tag(k)] = v.strip()
    for child in elem:
        if len(child) == 0 and child.text:
            fields[_local_tag(child.tag)] = child.text.strip()
    return fields


def extract_xmp_focal_point(raw_bytes: bytes) -> list[float] | None:
    """Extract normalized [fx%, fy%] subject focal point from Adobe Camera Raw / Lightroom XMP masks."""
    if b"MaskGroupBasedCorrections" not in raw_bytes:
        return None

    import xml.etree.ElementTree as ET

    text = raw_bytes.decode("utf-8", errors="ignore")
    xml_match = re.search(r"<x:xmpmeta\b.*?</x:xmpmeta>|<rdf:RDF\b.*?</rdf:RDF>", text, flags=re.DOTALL)
    xml_str = xml_match.group(0) if xml_match else text
    try:
        root = ET.fromstring(xml_str)
    except ET.ParseError:
        return None

    doc_fields: dict[str, str] = {}
    mask_dicts: list[dict[str, str]] = []
    for elem in root.iter():
        fmap = _elem_crs_map(elem)
        if not fmap:
            continue
        what = fmap.get("What", "")
        if what.startswith("Mask/"):
            mask_dicts.append(fmap)
        else:
            for k in ("Orientation", "HasCrop", "CropTop", "CropLeft", "CropBottom", "CropRight"):
                if k in fmap and k not in doc_fields:
                    doc_fields[k] = fmap[k]

    try:
        orientation = int(doc_fields.get("Orientation", "1"))
    except ValueError:
        orientation = 1

    dt, dl, db, dr = 0.0, 0.0, 1.0, 1.0
    if doc_fields.get("HasCrop", "").lower() in ("true", "1"):
        def _crop_val(name: str, default: float) -> float:
            try:
                return float(doc_fields[name]) if name in doc_fields else default
            except ValueError:
                return default

        ct = _crop_val("CropTop", 0.0)
        cl = _crop_val("CropLeft", 0.0)
        cb = _crop_val("CropBottom", 1.0)
        cr = _crop_val("CropRight", 1.0)
        dt, dl, db, dr = _sensor_to_display_box(ct, cl, cb, cr, orientation)

    candidates: list[tuple[float, float]] = []

    # Priority 1: Non-inverted AI Subject / Object / People masks (Mask/Image with ReferencePoint)
    for m in mask_dicts:
        if m.get("What") != "Mask/Image":
            continue
        if m.get("MaskActive", "true").lower() == "false":
            continue
        if m.get("MaskInverted", "false").lower() == "true":
            continue
        sub_raw = m.get("MaskSubType", "1")
        sub_type = int(sub_raw) if sub_raw.isdigit() else 1
        # Exclude Sky masks (MaskSubType == 2)
        if sub_type == 2:
            continue
        ref_m = re.match(r"^([0-9.+-]+)\s+([0-9.+-]+)$", m.get("ReferencePoint", ""))
        if ref_m:
            sx, sy = float(ref_m.group(1)), float(ref_m.group(2))
            dx, dy = _sensor_to_display_point(sx, sy, orientation)
            candidates.append((dx, dy))

    # Priority 2: Non-inverted radial subject spotlights (Flipped="true", MaskInverted="false")
    if not candidates:
        for m in mask_dicts:
            if m.get("What") != "Mask/CircularGradient":
                continue
            if m.get("MaskActive", "true").lower() == "false":
                continue
            if m.get("MaskInverted", "false").lower() == "true":
                continue
            if m.get("Flipped", "true").lower() == "false":
                continue
            if all(k in m for k in ("Top", "Left", "Bottom", "Right")):
                try:
                    mt = float(m["Top"])
                    ml = float(m["Left"])
                    mb = float(m["Bottom"])
                    mr = float(m["Right"])
                except ValueError:
                    continue
                bt, bl, bb, br = _sensor_to_display_box(mt, ml, mb, mr, orientation)
                if (br - bl) < 0.85 and (bb - bt) < 0.85:
                    candidates.append(((bl + br) * 0.5, (bt + bb) * 0.5))

    if not candidates:
        return None

    avg_x = sum(p[0] for p in candidates) / len(candidates)
    avg_y = sum(p[1] for p in candidates) / len(candidates)

    crop_x = (avg_x - dl) / max(1e-4, dr - dl)
    crop_y = (avg_y - dt) / max(1e-4, db - dt)
    fx = round(max(8.0, min(92.0, crop_x * 100.0)), 1)
    fy = round(max(8.0, min(90.0, crop_y * 100.0)), 1)
    return [fx, fy]


def compute_subject_focal_point(im: Image.Image) -> list[float]:
    """Compute normalized [fx%, fy%] optical-focus & midtone subject centroid."""
    rgb = im.convert("RGB")
    rgb.thumbnail((320, 320), Image.Resampling.LANCZOS)
    w, h = rgb.size
    if w < 8 or h < 8:
        return [50.0, 44.0]

    gray = rgb.convert("L")
    g0 = gray.filter(ImageFilter.GaussianBlur(radius=0.5))
    g1 = gray.filter(ImageFilter.GaussianBlur(radius=1.6))
    g_broad = gray.filter(ImageFilter.GaussianBlur(radius=7.0))

    px_rgb = rgb.load()
    px0 = g0.load()
    px1 = g1.load()
    px_b = g_broad.load()

    scores = [[0.0] * w for _ in range(h)]
    max_s = 1e-6

    for y in range(h):
        ny = (y + 0.5) / h
        by = min(1.0, min(ny, 1.0 - ny) / 0.08)
        prior_y = math.exp(-((ny - 0.44) ** 2) / (2.0 * (0.28 ** 2)))
        row = scores[y]
        for x in range(w):
            nx = (x + 0.5) / w
            bx = min(1.0, min(nx, 1.0 - nx) / 0.08)
            prior_x = math.exp(-((nx - 0.50) ** 2) / (2.0 * (0.30 ** 2)))

            hf = abs(px0[x, y] - px1[x, y]) / 255.0
            local_lum = px_b[x, y] / 255.0
            r, g, b = px_rgb[x, y]
            lum_px = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0

            if local_lum > 0.80 or lum_px > 0.86:
                tone_gate = 0.08
            elif local_lum < 0.04:
                tone_gate = 0.15
            else:
                tone_gate = 1.0

            norm_focus = hf / math.sqrt(local_lum + 0.22)
            s = (norm_focus ** 1.5) * tone_gate * bx * by * (0.35 + 0.65 * prior_x * prior_y)
            row[x] = s
            if s > max_s:
                max_s = s

    sal = Image.new("L", (w, h))
    sal.putdata(
        [int(min(255, round(scores[y][x] / max_s * 255.0))) for y in range(h) for x in range(w)]
    )
    win = max(5, int(round(min(w, h) * 0.15)))
    cluster = sal.filter(ImageFilter.BoxBlur(win))
    vals = list(cluster.getdata())
    max_v = max(vals) if vals else 0
    if max_v <= 2:
        return [50.0, 44.0]

    thresh = max_v * 0.72
    wx = wy = wsum = 0.0
    px_c = cluster.load()
    for y in range(h):
        for x in range(w):
            v = px_c[x, y]
            if v >= thresh:
                wt = (v - thresh + 1.0) ** 2
                wx += ((x + 0.5) / w) * wt
                wy += ((y + 0.5) / h) * wt
                wsum += wt

    fx = (wx / wsum) * 100.0 if wsum > 0 else 50.0
    fy = (wy / wsum) * 100.0 if wsum > 0 else 44.0
    return [round(max(18.0, min(82.0, fx)), 1), round(max(18.0, min(78.0, fy)), 1)]


def _load_ratings_from_lrcat(lrcat_path: Path) -> dict[str, int]:
    ratings: dict[str, int] = {}
    if not lrcat_path.exists() or not lrcat_path.is_file():
        return ratings
    uri = f"file:{lrcat_path.resolve()}?mode=ro"
    try:
        conn = sqlite3.connect(uri, uri=True, timeout=5.0)
        try:
            conn.execute("PRAGMA query_only = ON")
            cur = conn.execute(
                """
                SELECT COALESCE(f.baseName, ''), COALESCE(f.idx_filename, ''), i.rating
                FROM Adobe_images i
                LEFT JOIN AgLibraryFile f ON i.rootFile = f.id_local
                WHERE i.rating IS NOT NULL
                """
            )
            for base_name, idx_filename, raw_rating in cur.fetchall():
                stem = str(base_name).strip() or Path(str(idx_filename)).stem
                if not stem:
                    continue
                try:
                    r = int(round(float(raw_rating)))
                except (TypeError, ValueError):
                    continue
                prev = ratings.get(stem)
                if prev is None or r > prev:
                    ratings[stem] = r
        finally:
            conn.close()
    except sqlite3.Error:
        pass
    return ratings


def _sidecar_sort_key(path: Path) -> tuple[int, float, str]:
    rev_m = re.match(r"^rev_(\d+)", path.stem, flags=re.IGNORECASE)
    rev_num = int(rev_m.group(1)) if rev_m else 999999
    try:
        mtime = path.stat().st_mtime
    except OSError:
        mtime = 0.0
    return (rev_num, mtime, str(path))


def _extract_sidecar_stem(path: Path) -> str:
    m = re.match(r"^rev_\d+(?:_(.+))?$", path.stem, flags=re.IGNORECASE)
    if m:
        return m.group(1) if m.group(1) else path.parent.name
    return path.stem


def load_photo_sidecar_metadata(
    source_dir: Path | None, lrcat_path: Path | None = None
) -> dict[str, dict[str, Any]]:
    """Scan XMP sidecars, RAW headers, and .lrcat catalogs for timestamps, ratings, and XMP focal points."""
    meta_by_stem: dict[str, dict[str, Any]] = {}

    lrcat_candidates: list[Path] = []
    if lrcat_path and lrcat_path.exists():
        if lrcat_path.is_dir():
            lrcat_candidates.extend(sorted(lrcat_path.rglob("*.lrcat")))
        else:
            lrcat_candidates.append(lrcat_path)

    if source_dir and source_dir.exists():
        if source_dir.is_file() and source_dir.suffix.lower() == ".lrcat":
            lrcat_candidates.append(source_dir)
        elif source_dir.is_dir():
            all_files: list[Path] = []
            for p in source_dir.rglob("*"):
                if not p.is_file():
                    continue
                suf = p.suffix.lower()
                if suf == ".lrcat":
                    lrcat_candidates.append(p)
                elif suf in RAW_AND_SIDECAR_EXTS:
                    all_files.append(p)

            # Process RAWs first, then XMP sidecars in ascending revision/mtime order so latest XMP wins
            raw_files = [p for p in all_files if p.suffix.lower() != ".xmp"]
            xmp_files = sorted(
                (p for p in all_files if p.suffix.lower() == ".xmp"),
                key=_sidecar_sort_key,
            )

            for path in raw_files:
                stem = _extract_sidecar_stem(path)
                entry = meta_by_stem.setdefault(stem, {})
                if "timestamp" in entry:
                    continue
                try:
                    with path.open("rb") as fh:
                        head = fh.read(131072)
                    ts = extract_capture_timestamp_from_bytes(head)
                    if ts:
                        entry["timestamp"] = ts
                except OSError:
                    continue

            for path in xmp_files:
                stem = _extract_sidecar_stem(path)
                entry = meta_by_stem.setdefault(stem, {})
                try:
                    raw_xmp = path.read_bytes()
                except OSError:
                    continue
                ts = extract_capture_timestamp_from_bytes(raw_xmp[:131072])
                if ts:
                    entry["timestamp"] = ts
                rating = extract_xmp_rating(raw_xmp)
                if rating is not None:
                    entry["rating"] = rating
                fp = extract_xmp_focal_point(raw_xmp)
                if fp is not None:
                    entry["focalPoint"] = fp

    for cat in lrcat_candidates:
        for stem, r in _load_ratings_from_lrcat(cat).items():
            entry = meta_by_stem.setdefault(stem, {})
            # Prefer explicit XMP rating if higher or when XMP lacked a positive rating
            if entry.get("rating") is None or r > entry["rating"]:
                entry["rating"] = r

    return meta_by_stem


def resolve_stem_sidecar_metadata(
    stem: str, meta_by_stem: dict[str, dict[str, Any]]
) -> dict[str, Any]:
    if not meta_by_stem:
        return {}
    base_stem = re.sub(r"_v\d+$", "", stem, flags=re.IGNORECASE)
    lower_index = {k.lower(): v for k, v in meta_by_stem.items()}
    merged: dict[str, Any] = {}
    for candidate in (base_stem, stem):
        exact = meta_by_stem.get(candidate) or lower_index.get(candidate.lower())
        if exact:
            merged.update(exact)
    return merged


def load_capture_timestamps_from_dir(source_dir: Path | None) -> dict[str, str]:
    meta = load_photo_sidecar_metadata(source_dir)
    return {stem: m["timestamp"] for stem, m in meta.items() if "timestamp" in m}


def resolve_stem_capture_timestamp(stem: str, capture_map: dict[str, str]) -> str | None:
    if not capture_map:
        return None
    if stem in capture_map:
        return capture_map[stem]
    base_stem = re.sub(r"_v\d+$", "", stem, flags=re.IGNORECASE)
    return capture_map.get(base_stem)


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
    raw_photos.sort(key=lambda item: (item["timestamp"], item["id"]), reverse=True)

    explicit = explicit_heroes or set()
    ratings_present: list[int] = []
    for p in raw_photos:
        r = p.get("_rating") if "_rating" in p else p.get("rating")
        if isinstance(r, (int, float)) and r > 0:
            ratings_present.append(int(r))

    max_rating = max(ratings_present, default=0)
    highlight_min_rating = 4 if any(r >= 4 for r in ratings_present) else max_rating

    for idx, p in enumerate(raw_photos):
        raw_r = p.pop("_rating", None)
        if raw_r is None:
            raw_r = p.get("rating")
        if isinstance(raw_r, (int, float)) and int(raw_r) > 0:
            p["rating"] = int(raw_r)
        else:
            p.pop("rating", None)

        r_val = p.get("rating")
        if explicit:
            p["hero"] = p["id"] in explicit
        elif highlight_min_rating > 0:
            p["hero"] = bool(r_val is not None and r_val >= highlight_min_rating)
        elif "hero" in p:
            p["hero"] = bool(p["hero"])
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
        chronological = sorted(chapters, key=lambda c: c["date"])
        first_full = chronological[0]["fullDate"]
        last_full = chronological[-1]["fullDate"]
        date_range = first_full if first_full == last_full else f"{first_full} – {last_full}"

    collection_obj: dict[str, Any] = {
        "assetBaseUrl": base_url.rstrip("/"),
        "totalPhotos": len(raw_photos),
        "dateRange": date_range,
    }
    if max_rating > 0:
        collection_obj["maxRating"] = max_rating
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
    explicit_capture_ts: str | None = None,
    sidecar_meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    stem = Path(filename).stem
    raw_head = data[:262144]
    meta = sidecar_meta or {}

    with Image.open(io.BytesIO(data)) as im:
        width, height = im.size
        exif_dt = extract_exif_or_xmp_datetime(im, raw_head)
        lqip, dom_color = make_lqip_and_color(im)
        saliency_fp = compute_subject_focal_point(im)

    iso_ts = exif_dt or explicit_capture_ts or meta.get("timestamp") or fallback_iso_ts
    day_key = iso_ts[:10]

    embedded_rating = extract_xmp_rating(raw_head)
    rating = embedded_rating if embedded_rating is not None else meta.get("rating")

    embedded_fp = extract_xmp_focal_point(raw_head)
    focal_point = meta.get("focalPoint") or embedded_fp or saliency_fp

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
        "focalPoint": focal_point,
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
        "--exif-from-dir",
        type=Path,
        default=None,
        help="Optional directory of original RAWs, .xmp sidecars, or .lrcat catalog to recover capture dates, star ratings, and AI mask focal points",
    )
    parser.add_argument(
        "--lrcat",
        type=Path,
        default=None,
        help="Optional path to a Lightroom Classic .lrcat SQLite catalog for star ratings",
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
    parser.add_argument(
        "--exclude",
        default="",
        help="Optional comma-separated file stems or filenames to exclude from the collection",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    explicit_heroes = {s.strip() for s in args.heroes.split(",") if s.strip()}
    excluded_stems = {Path(s.strip()).stem for s in args.exclude.split(",") if s.strip()}

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

    sidecar_meta_map = load_photo_sidecar_metadata(args.exif_from_dir, args.lrcat)

    patterns = ["*.jpg", "*.JPG", "*.jpeg", "*.JPEG", "*.webp", "*.WEBP"]
    all_paths: list[Path] = []
    for pat in patterns:
        all_paths.extend(Path(p) for p in glob.glob(str(args.images_dir / pat)))
    paths = sorted(set(all_paths))

    raw_photos: list[dict[str, Any]] = []
    for path in paths:
        if path.stem in excluded_stems:
            continue
        fallback_dt = drive_ts_by_name.get(path.name)
        if not fallback_dt:
            mtime = dt.datetime.fromtimestamp(path.stat().st_mtime, tz=dt.timezone.utc)
            fallback_dt = mtime.strftime("%Y-%m-%dT%H:%M:%S")
        meta = resolve_stem_sidecar_metadata(path.stem, sidecar_meta_map)
        raw_photos.append(
            inspect_image_bytes(
                path.read_bytes(),
                path.name,
                fallback_dt,
                meta.get("timestamp"),
                meta,
            )
        )

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
    rated_cnt = sum(1 for p in manifest["photos"] if p.get("rating"))
    print(
        f"Wrote {args.out} ({len(raw_photos)} photos across {len(manifest['chapters'])} capture dates, {rated_cnt} rated)"
    )


if __name__ == "__main__":
    main()
