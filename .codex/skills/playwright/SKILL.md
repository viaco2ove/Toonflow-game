---
name: playwright
description: Playwright-based web UI automation for navigating pages, validating content, taking screenshots, and collecting basic diagnostics. Use when Codex needs to create or run Playwright scripts/tests for page access, smoke checks, screenshot capture, or lightweight E2E verification.
---

# Playwright Automation

## Overview
Use this skill to automate browser flows with Playwright and capture evidence.
Prefer the bundled scripts for quick checks and one-off screenshots.

## Decide the approach
- Use `scripts/pw_screenshot.py` for single-page screenshots or visual evidence.
- Use `scripts/pw_smoke.py` for lightweight validations (title, text, selectors).
- Write a dedicated test file when the flow spans multiple pages or needs many assertions.
- Save artifacts under `output/playwright/` unless the user requests another location.

## Quick start (Python)
- Install Playwright: `pip install playwright` and `playwright install`.
- Run a screenshot: `python scripts/pw_screenshot.py https://example.com output/playwright/example.png`.
- Run a smoke check: `python scripts/pw_smoke.py https://example.com --title-contains Example`.

## Write a focused test
- Start with `sync_playwright()` and keep each test minimal.
- Prefer `get_by_role`, `get_by_label`, or `get_by_test_id` selectors.
- Wait for deterministic signals (`wait_for_selector`, `wait_until=networkidle`) instead of `sleep`.
- Capture a screenshot or trace on failure when debugging.

## Use references
- See `references/recipes.md` for common workflows and examples.
- See `references/selectors.md` for selector strategy and stability tips.
