#!/usr/bin/env python3
"""Manage offline AI image assets for html-ppt decks.

This tool supports the two-round workflow:
1. First pass: write an image manifest, save prompts, and generate SVG placeholders.
2. Second pass: verify manually/API-generated images placed in images/generated/.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any


MANIFEST_NAME = "image_manifest.json"
PROMPTS_NAME = "image_prompts.md"


def _deck_dir(raw: str) -> Path:
    path = Path(raw).expanduser().resolve()
    if path.is_file():
        path = path.parent
    return path


def _images_dir(deck_dir: Path) -> Path:
    return deck_dir / "images"


def _manifest_path(deck_dir: Path) -> Path:
    return _images_dir(deck_dir) / MANIFEST_NAME


def _prompts_path(deck_dir: Path) -> Path:
    return _images_dir(deck_dir) / PROMPTS_NAME


def _safe_id(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_-]+", "_", value.strip()).strip("_")
    return cleaned or "image"


def _parse_dimensions(dimensions: str | None, aspect_ratio: str | None) -> tuple[int, int]:
    if dimensions:
        match = re.match(r"^\s*(\d+)\s*[xX×]\s*(\d+)\s*$", str(dimensions))
        if match:
            return int(match.group(1)), int(match.group(2))

    ratio = aspect_ratio or "16:9"
    if ratio == "1:1":
        return 1080, 1080
    if ratio == "9:16":
        return 1080, 1920
    if ratio == "3:4":
        return 1242, 1660
    if ratio == "4:3":
        return 1600, 1200
    return 1920, 1080


def _default_manifest(deck_dir: Path) -> dict[str, Any]:
    return {
        "version": 1,
        "deck": deck_dir.name,
        "assets": [],
    }


def init_deck(deck_dir: Path) -> None:
    images = _images_dir(deck_dir)
    (images / "placeholders").mkdir(parents=True, exist_ok=True)
    (images / "generated").mkdir(parents=True, exist_ok=True)

    manifest_path = _manifest_path(deck_dir)
    if not manifest_path.exists():
        manifest_path.write_text(
            json.dumps(_default_manifest(deck_dir), ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    prompts_path = _prompts_path(deck_dir)
    if not prompts_path.exists():
        prompts_path.write_text(
            "# Image Generation Prompts\n\n"
            f"> Project: {deck_dir.name}\n"
            f"> Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n"
            "No image assets declared yet. Add entries to `image_manifest.json`, then run:\n\n"
            "```bash\n"
            f"python3 scripts/image_assets.py placeholder {deck_dir}\n"
            "```\n",
            encoding="utf-8",
        )

    print(f"initialized: {images}")


def load_manifest(deck_dir: Path) -> dict[str, Any]:
    path = _manifest_path(deck_dir)
    if not path.exists():
        raise FileNotFoundError(f"Manifest not found: {path}. Run `image_assets.py init <deck_dir>` first.")
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"Manifest must be a JSON object: {path}")
    if data.get("version") != 1:
        raise ValueError("Unsupported image_manifest.json version. Expected version=1.")
    if not isinstance(data.get("assets"), list):
        raise ValueError("Manifest must contain an `assets` array.")
    return data


def normalize_asset(asset: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(asset, dict):
        raise ValueError("Each asset entry must be an object.")

    asset_id = _safe_id(str(asset.get("id") or Path(str(asset.get("filename", "image.png"))).stem))
    filename = str(asset.get("filename") or f"{asset_id}.png")
    placeholder = str(asset.get("placeholder") or f"placeholders/{asset_id}.svg")
    final_path = str(asset.get("final_path") or f"generated/{filename}")
    aspect_ratio = str(asset.get("aspect_ratio") or "16:9")
    dimensions = str(asset.get("dimensions") or "")
    width, height = _parse_dimensions(dimensions, aspect_ratio)

    return {
        "id": asset_id,
        "filename": filename,
        "placeholder": placeholder,
        "final_path": final_path,
        "dimensions": dimensions or f"{width}x{height}",
        "aspect_ratio": aspect_ratio,
        "type": str(asset.get("type") or "Background"),
        "purpose": str(asset.get("purpose") or asset_id.replace("_", " ")),
        "status": str(asset.get("status") or "pending"),
        "prompt": str(asset.get("prompt") or ""),
        "negative_prompt": str(asset.get("negative_prompt") or "text, watermark, blurry, low quality"),
        "alt": str(asset.get("alt") or asset.get("purpose") or asset_id.replace("_", " ")),
        "_width": width,
        "_height": height,
    }


def write_prompts(deck_dir: Path, manifest: dict[str, Any]) -> None:
    assets = [normalize_asset(asset) for asset in manifest.get("assets", [])]
    lines = [
        "# Image Generation Prompts",
        "",
        f"> Project: {manifest.get('deck') or deck_dir.name}",
        f"> Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        "",
        "## Image List Overview",
        "",
        "| # | Filename | Type | Dimensions | Status |",
        "|---|----------|------|------------|--------|",
    ]

    if not assets:
        lines.append("| - | - | - | - | No assets declared |")
    else:
        for index, asset in enumerate(assets, start=1):
            lines.append(
                f"| {index} | `{asset['filename']}` | {asset['type']} | {asset['dimensions']} | {asset['status']} |"
            )

    for index, asset in enumerate(assets, start=1):
        lines.extend([
            "",
            f"### Image {index}: {asset['filename']}",
            "",
            "| Attribute | Value |",
            "| --------- | ----- |",
            f"| Purpose | {asset['purpose']} |",
            f"| Type | {asset['type']} |",
            f"| Dimensions | {asset['dimensions']} ({asset['aspect_ratio']}) |",
            f"| Placeholder | `images/{asset['placeholder']}` |",
            f"| Final path | `images/{asset['final_path']}` |",
            "",
            "**Prompt**:",
            asset["prompt"] or "(fill prompt in image_manifest.json)",
            "",
            "**Negative Prompt**:",
            asset["negative_prompt"],
            "",
            "**Alt Text**:",
            f"> {asset['alt']}",
        ])

    _prompts_path(deck_dir).write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def _placeholder_svg(asset: dict[str, Any]) -> str:
    width = int(asset["_width"])
    height = int(asset["_height"])
    title = html.escape(asset["purpose"])
    asset_id = html.escape(asset["id"])
    dimensions = html.escape(asset["dimensions"])
    prompt = html.escape(asset["prompt"][:180] + ("..." if len(asset["prompt"]) > 180 else ""))

    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-label="{title}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#eef4ff"/>
      <stop offset="55%" stop-color="#f7fbff"/>
      <stop offset="100%" stop-color="#dbe8ff"/>
    </linearGradient>
    <pattern id="grid" width="80" height="80" patternUnits="userSpaceOnUse">
      <path d="M 80 0 L 0 0 0 80" fill="none" stroke="#9bb8e8" stroke-width="1" opacity="0.35"/>
    </pattern>
  </defs>
  <rect width="{width}" height="{height}" fill="url(#bg)"/>
  <rect width="{width}" height="{height}" fill="url(#grid)"/>
  <rect x="{width * 0.08:.0f}" y="{height * 0.18:.0f}" width="{width * 0.84:.0f}" height="{height * 0.64:.0f}" rx="28" fill="#ffffff" opacity="0.72" stroke="#4472C4" stroke-width="4" stroke-dasharray="18 14"/>
  <text x="{width * 0.5:.0f}" y="{height * 0.42:.0f}" text-anchor="middle" font-family="Inter, Noto Sans SC, sans-serif" font-size="{max(28, width // 32)}" font-weight="700" fill="#1f3f7a">AI image placeholder</text>
  <text x="{width * 0.5:.0f}" y="{height * 0.50:.0f}" text-anchor="middle" font-family="Inter, Noto Sans SC, sans-serif" font-size="{max(20, width // 54)}" fill="#2f3b52">{asset_id} · {dimensions}</text>
  <text x="{width * 0.5:.0f}" y="{height * 0.58:.0f}" text-anchor="middle" font-family="Inter, Noto Sans SC, sans-serif" font-size="{max(18, width // 64)}" fill="#52637f">{title}</text>
  <text x="{width * 0.5:.0f}" y="{height * 0.68:.0f}" text-anchor="middle" font-family="Inter, Noto Sans SC, sans-serif" font-size="{max(14, width // 86)}" fill="#72819a">{prompt}</text>
</svg>
"""


def generate_placeholders(deck_dir: Path) -> None:
    init_deck(deck_dir)
    manifest = load_manifest(deck_dir)
    assets = [normalize_asset(asset) for asset in manifest.get("assets", [])]
    write_prompts(deck_dir, manifest)

    for asset in assets:
        placeholder_path = _images_dir(deck_dir) / asset["placeholder"]
        placeholder_path.parent.mkdir(parents=True, exist_ok=True)
        placeholder_path.write_text(_placeholder_svg(asset), encoding="utf-8")
        print(f"placeholder: {placeholder_path}")

    print(f"prompts: {_prompts_path(deck_dir)}")


def verify(deck_dir: Path) -> int:
    manifest = load_manifest(deck_dir)
    assets = [normalize_asset(asset) for asset in manifest.get("assets", [])]
    images = _images_dir(deck_dir)

    missing: list[str] = []
    present: list[str] = []
    for asset in assets:
        final_path = images / asset["final_path"]
        if final_path.exists():
            present.append(str(final_path))
        else:
            missing.append(str(final_path))

    print(f"deck: {deck_dir}")
    print(f"manifest: {_manifest_path(deck_dir)}")
    print(f"assets: {len(assets)}")
    print(f"present: {len(present)}")
    for path in present:
        print(f"  OK      {path}")
    print(f"missing: {len(missing)}")
    for path in missing:
        print(f"  MISSING {path}")

    return 0 if not missing else 2


def main() -> None:
    parser = argparse.ArgumentParser(description="Manage html-ppt AI image assets.")
    sub = parser.add_subparsers(dest="command", required=True)

    for name in ("init", "placeholder", "verify"):
        p = sub.add_parser(name)
        p.add_argument("deck_dir", help="Deck directory or index.html path")

    args = parser.parse_args()
    deck_dir = _deck_dir(args.deck_dir)

    try:
        if args.command == "init":
            init_deck(deck_dir)
            return
        if args.command == "placeholder":
            generate_placeholders(deck_dir)
            return
        if args.command == "verify":
            sys.exit(verify(deck_dir))
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
