# Low-Token Prompt Templates

Use these to reduce chat token cost while keeping execution quality.

## 1) Delta-Only Change Request

```text
Use /workspace/group/ai/PRODUCT_DECISIONS.md and /workspace/group/ai/STATUS.md as base context.
Only handle the delta below; do not restate old context.

Delta:
- <what changed / what I want now>

Output format (max 6 bullets):
- result
- files changed
- checks run
- blockers (if any)
```

## 2) Implement-Only Mode

```text
Implement now, no long report.
Constraints:
- no emojis overload
- no recap
- only final summary: Result / Files / Checks
Task:
- <task>
```

## 3) Review Existing Diff Only

```text
Review only current diff and directly related files.
Do not scan full repo.
Output:
- findings by severity
- exact file paths
- minimal fixes
```

## 4) Deploy Preview (Strict)

```text
Deploy preview with:
bash /workspace/group/preview-jambutter.sh

Then verify:
1) cat /workspace/group/.data/preview/.active == jambutter
2) package version exists in /workspace/group/.data/preview/jambutter/assets/*.js

Do not claim success unless both checks pass.
```

## 5) Ask For Small Plan, Then Execute

```text
Give a compact plan (max 5 bullets), then execute immediately.
No long narrative updates unless blocked.
```
