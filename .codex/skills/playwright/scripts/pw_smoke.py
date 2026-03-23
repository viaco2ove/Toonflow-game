#!/usr/bin/env python3
"""
Run lightweight checks on a URL using Playwright.

Example:
  python scripts/pw_smoke.py https://example.com --title-contains Example --text-contains "Get started"
"""

import argparse
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a Playwright smoke check")
    parser.add_argument("url", help="Target URL")
    parser.add_argument("--title-contains", dest="title_contains", help="Expected title text")
    parser.add_argument(
        "--text-contains",
        action="append",
        default=[],
        help="Text that must appear (repeatable)",
    )
    parser.add_argument(
        "--selector",
        action="append",
        default=[],
        help="Selector that must exist (repeatable)",
    )
    parser.add_argument("--visible", action="store_true", help="Require elements to be visible")
    parser.add_argument("--screenshot", help="Capture a screenshot to this path")
    parser.add_argument("--full-page", action="store_true", help="Capture full page screenshot")
    parser.add_argument("--width", type=int, default=1280, help="Viewport width")
    parser.add_argument("--height", type=int, default=720, help="Viewport height")
    parser.add_argument(
        "--wait-for",
        dest="wait_for",
        help="Selector to wait for before checks",
    )
    parser.add_argument(
        "--wait-until",
        choices=["load", "domcontentloaded", "networkidle"],
        default="load",
        help="When to consider navigation finished",
    )
    parser.add_argument("--timeout", type=int, default=30000, help="Timeout in ms")
    parser.add_argument("--headed", action="store_true", help="Run in headed mode")
    parser.add_argument("--slow-mo", type=int, default=0, help="Slow down actions in ms")
    return parser.parse_args()


def wait_for_locator(locator, state: str, timeout: int) -> bool:
    try:
        locator.first.wait_for(state=state, timeout=timeout)
        return True
    except PlaywrightTimeoutError:
        return False


def run() -> int:
    args = parse_args()
    errors: list[str] = []

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

            if args.title_contains:
                title = page.title()
                if args.title_contains not in title:
                    errors.append(
                        f"Title does not contain '{args.title_contains}'. Actual: '{title}'"
                    )

            state = "visible" if args.visible else "attached"

            for text in args.text_contains:
                locator = page.get_by_text(text, exact=False)
                if not wait_for_locator(locator, state=state, timeout=args.timeout):
                    errors.append(f"Text not found: {text}")

            for selector in args.selector:
                locator = page.locator(selector)
                if not wait_for_locator(locator, state=state, timeout=args.timeout):
                    errors.append(f"Selector not found: {selector}")

            if args.screenshot:
                out_path = Path(args.screenshot)
                out_path.parent.mkdir(parents=True, exist_ok=True)
                page.screenshot(path=str(out_path), full_page=args.full_page)

            context.close()
            browser.close()
    except PlaywrightTimeoutError as exc:
        print(f"Timeout: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 2

    if not (args.title_contains or args.text_contains or args.selector):
        print("Warning: No checks provided.", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(run())
