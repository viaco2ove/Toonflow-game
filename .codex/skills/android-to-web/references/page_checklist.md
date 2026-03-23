# Page checklist

Run this checklist for every page or dialog you migrate.

## A. Identify
- What Android screen is this?
- What is the Vue equivalent?
- What is the exact user entry point?

## B. State
- What data is persisted?
- What data is temporary?
- What data is account-scoped, story-scoped, or chapter-scoped?
- What must never be shared?

## C. Actions
- What buttons exist?
- What does each button do?
- Which actions save, publish, debug, discard, or navigate?

## D. Visual parity
- What fields and cards are visible?
- What is empty state versus real content?
- What should not appear on this page?

## E. Verification
- Can the page reload after restart with the same result?
- Can the page survive account switching?
- Can the page survive reinstall if data is persisted?
- Are draft and published behaviors separated?

## F. Completion
- List remaining differences.
- Mark incomplete if any behavior is faked or shared incorrectly.
