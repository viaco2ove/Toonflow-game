# Forbidden patterns

Never do these when using `android-to-web`.

## 1. Structural mistakes
- Do not put all logic into one giant Vue file.
- Do not merge unrelated scopes into one state object.
- Do not create new pages or buttons without Android evidence.

## 2. Data mistakes
- Do not use demo data on real pages.
- Do not let temporary preview data overwrite persisted data.
- Do not share one field for account, story, and chapter data.

## 3. Parity mistakes
- Do not invent split buttons when Android uses one entry point.
- Do not keep fake cards when the Android screen is empty-state driven.
- Do not replace published data with draft cache.

## 4. Delivery mistakes
- Do not claim completion without source locations and target files.
- Do not hide gaps.
- Do not finish before persistence, reload, and isolation are checked.
