# Toonflow screen map

Use this map when converting the Toonflow Android app into Vue.

## 1. Main pages
- Home
  - Must show real recommendations or explicit empty state.
  - Must not fabricate stories or projects.
- Story hall
  - Show only published stories.
  - Search and filters must operate on persisted stories.
- Create story
  - Start from a new draft, not from a cached old story.
  - Split world, characters, chapters, narration, and debug settings.
- Chapter editor
  - Chapter background, opening speaker, opening line, content, and end condition are real fields.
  - Editing a chapter must write back to the same persisted story.
- Play screen
  - Use the same story data that was saved by the editor.
  - Debug mode must not persist changes.
- Chat history / played stories
  - Account-level list.
  - Show project/story/chapter metadata from persisted data.
- My / Settings
  - Account avatar and account settings live here.
  - Must not reuse story avatar state.

## 2. Resource ownership
- Account avatar -> account scope
- Player avatar -> story scope
- NPC avatars -> story scope
- Story cover -> story scope
- Chapter background -> chapter scope
- Voice binding -> role scope
- Draft/published flag -> story scope
- Debug cache -> session scope only

## 3. Non-negotiable parity
- No story means no random story recommendation card.
- No split “文生图 / 图生图” buttons; one entry, reference image decides mode.
- No fake project switcher on pages that do not need it.
- No placeholder cards pretending to be persisted content.
- Editing published content must return it to draft flow.

## 4. Migration order
1. Data model
2. Persistence
3. Page structure
4. Interactions
5. Styling

## 5. Verification
- Reload after restart.
- Reopen after reinstall.
- Switch account and verify separation.
- Create, edit, publish, recover, and debug one story end to end.
