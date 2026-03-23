# Android to Vue parity checklist

Use this checklist before and after each migration.

## 1. Page parity
- Identify the Android page or dialog.
- Identify the Vue route, page, panel, or modal.
- Confirm the same user entry point exists.
- Confirm the same exit path exists.

## 2. Field parity
- List every field shown on Android.
- Map each field to a Vue state field or store field.
- Verify default values match.
- Verify save, reload, and edit-back behavior match.

## 3. Behavior parity
- Confirm real data is loaded, not static mock data.
- Confirm buttons do the same action as Android.
- Confirm retry, refresh, cancel, and back behavior.
- Confirm destructive actions and recoverable actions are separated.

## 4. Persistence parity
- Confirm whether the data is account-level, project-level, story-level, chapter-level, or temporary.
- Confirm storage path or backend endpoint.
- Confirm reload after restart or reinstall returns the same persisted result.
- Confirm temporary preview data cannot overwrite persisted data.

## 5. Resource isolation
- Account avatar must not equal story avatar.
- Story cover must not equal chapter background.
- Draft must not equal published.
- Debug cache must not leak into saved content.

## 6. Required output format
When implementing a migration, produce:
1. Android source locations
2. Vue target files
3. Data model changes
4. API changes
5. Known gaps or remaining differences

If any parity item is missing, call it out explicitly before finishing.
