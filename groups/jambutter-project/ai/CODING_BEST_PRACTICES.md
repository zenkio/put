# JamButter Coding Best Practices

Purpose: keep code quality high, reduce unnecessary churn, and ship safely.

## 1) Change Strategy

- Fix root cause, not only symptoms.
- Choose the smallest safe change that satisfies acceptance criteria.
- Avoid touching unrelated files.
- Prefer incremental improvements over broad rewrites.

## 2) Readability

- Use clear names for functions/variables/components.
- Keep functions focused; avoid long multi-purpose blocks.
- Remove dead code and commented-out leftovers.
- Keep comments minimal and meaningful.

## 3) Type Safety and Data Handling

- Keep TypeScript strict and explicit where it matters.
- Validate external inputs and query params.
- Handle null/undefined and error paths intentionally.
- Avoid silent failures; return actionable errors.

## 4) Frontend (React/Remix) Quality

- Keep UI state predictable and localized when possible.
- Avoid duplicated state or conflicting derived values.
- Preserve accessibility basics (labels, semantics, keyboard flow).
- Ensure behavior works on both mobile and desktop.

## 5) Performance and Simplicity

- Avoid unnecessary renders and repeated heavy computations.
- Do not over-abstract early; keep solutions practical.
- Prefer simple data flow and explicit control paths.

## 6) Deployment Safety

- Verify build outputs before declaring deployment success.
- For preview deploy, confirm:
  - active project is correct
  - expected version is present in deployed assets

## 7) Verification Before Completion

- Run relevant checks for each change:
  - `npm run typecheck` (or equivalent)
  - targeted tests/build checks for touched features
- If checks cannot run, state that explicitly and why.

## 8) Review Checklist

- Does this solve the requested problem directly?
- Is any changed line unnecessary?
- Any obvious edge case or regression risk?
- Is there a smaller equivalent fix?
