# Playwright Recipes

## Table of contents
- Screenshot a page
- Smoke check a page
- Login flow pattern
- File download pattern
- Debug a flaky step
- Collect a trace

## Screenshot a page
Use `scripts/pw_screenshot.py` for quick evidence.
Add `--full-page` for full length captures.
Add `--wait-for "css=header"` to wait for a stable element.

Example:
```bash
python scripts/pw_screenshot.py https://example.com output/playwright/example.png --full-page --wait-for "header"
```

## Smoke check a page
Use `scripts/pw_smoke.py` to validate content and elements.
Combine title, text, and selector checks in one run.

Example:
```bash
python scripts/pw_smoke.py https://example.com \
  --title-contains Example \
  --text-contains "Get started" \
  --selector "data-test=hero"
```

## Login flow pattern
Use a dedicated test file when a flow spans multiple pages.
Keep the flow linear and assert on a post-login element.

Example:
```python
from playwright.sync_api import sync_playwright

def test_login():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.goto("https://example.com/login")
        page.get_by_label("Email").fill("user@example.com")
        page.get_by_label("Password").fill("secret")
        page.get_by_role("button", name="Sign in").click()
        page.wait_for_selector("data-test=dashboard")
        page.screenshot(path="output/playwright/login.png", full_page=True)
        browser.close()
```

## File download pattern
Use `expect_download` to wait for the file.
Save the downloaded file into `output/playwright/`.

Example:
```python
with page.expect_download() as download_info:
    page.get_by_role("button", name="Export").click()

download = download_info.value
download.save_as("output/playwright/export.csv")
```

## Debug a flaky step
Run headed with `--headed` and slow actions with `--slow-mo 200`.
Wait for a stable selector or `networkidle` before asserting.
Capture a screenshot on failure for evidence.

## Collect a trace
Start tracing before the flow and stop after the assertion.
Store traces under `output/playwright/`.

Example:
```python
context.tracing.start(screenshots=True, snapshots=True, sources=True)
# run the flow
context.tracing.stop(path="output/playwright/trace.zip")
```
