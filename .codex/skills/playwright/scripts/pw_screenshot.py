#!/usr/bin/env python3
"""
Capture a screenshot of a URL using Playwright.

Example:
  python scripts/pw_screenshot.py https://example.com output/playwright/example.png --full-page
"""

import argparse
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Capture a screenshot with Playwright")
    parser.add_argument("url", help="Target URL")
    parser.add_argument("out", help="Output path for the screenshot")
    parser.add_argument("--full-page", action="store_true", help="Capture full page")
    parser.add_argument("--width", type=int, default=1280, help="Viewport width")
    parser.add_argument("--height", type=int, default=720, help="Viewport height")
    parser.add_argument(
        "--wait-for",
        dest="wait_for",
        help="Selector to wait for before capture",
    )
    parser.add_argument(
        "--wait-until",
        choices=["load", "domcontentloaded", "networkidle"],
        default="load",
        help="When to consider navigation finished",
    )
    parser.add_argument("--timeout", type=int, default=30000, help="Timeout in ms")
    parser.add_argument(
        "--wait-ms",
        type=int,
        default=0,
        help="Extra wait time in ms after page load",
    )
    parser.add_argument("--headed", action="store_true", help="Run in headed mode")
    parser.add_argument("--slow-mo", type=int, default=0, help="Slow down actions in ms")
    return parser.parse_args()


def run() -> int:
    args = parse_args()
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=not args.headed, slow_mo=args.slow_mo)
            context = browser.new_context(
                viewport={"width": args.width, "height": args.height}
            )
            page = context.new_page()
            page.goto(args.url, wait_until=args.wait_until, timeout=args.timeout)
            if args.wait_for:
                page.wait_for_selector(args.wait_for, timeout=args.timeout, state="visible")
            if args.wait_ms:
                page.wait_for_timeout(args.wait_ms)
            page.screenshot(path=str(out_path), full_page=args.full_page)
            context.close()
            browser.close()
        return 0
    except PlaywrightTimeoutError as exc:
        print(f"Timeout: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(run())
