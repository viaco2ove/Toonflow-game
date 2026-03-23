# Selector Strategy

## Prefer user-facing selectors
Use `get_by_role` for buttons, links, and inputs.
Use `get_by_label` for form fields.
Use `get_by_text` for visible text.
Use `get_by_test_id` when there is no stable user-facing selector.

## Add test ids when needed
Add `data-testid` attributes in the app when possible.
Keep test ids stable and descriptive.

## Avoid brittle selectors
Avoid long CSS chains, `nth-child`, and dynamic class names.
Avoid XPath unless no other option exists.

## Wait for stable states
Wait for a selector to be `attached` or `visible` before asserting.
Prefer `wait_for_selector` or `locator.wait_for` over fixed sleeps.

## Examples
```python
page.get_by_role("button", name="Save").click()
page.get_by_label("Email").fill("user@example.com")
page.get_by_test_id("dashboard-title").wait_for(state="visible")
```
