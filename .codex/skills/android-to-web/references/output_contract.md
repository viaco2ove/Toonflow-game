# Output contract

When using this skill, the response or implementation plan must be concrete.

## Must include
- Android source locations
- Vue target files
- Data model changes
- API changes
- Remaining gaps or differences

## Must avoid
- Vague promises without files or paths
- “先做个 demo 再说”
- “样式差不多就行”
- “逻辑以后再补”
- Hidden shared state across account/story/debug scopes

## Preferred implementation shape
- One page or one flow per pass
- Small components over giant files
- Pure data mapping over copy-pasted UI
- Persisted state over temporary UI state

## Acceptance rule
If a screen still depends on fake data, mark it incomplete.
If a feature still shares state with an unrelated scope, mark it incomplete.
If the Android behavior cannot be explained by a target file and a data path, mark it incomplete.
