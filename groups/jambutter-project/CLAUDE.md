# Put (JamButter Project)

## Scope

- Default all work to JamButter unless user says otherwise
- Repo path: `/workspace/group/projects/jambutter`
- Read project index first: `/workspace/project/groups/global/PROJECTS.md`

## Response Rules

- Keep replies short, factual, and action-oriented
- Default max ~120 words
- Progress: one status line + max 3 bullets
- Final: `Result` / `Files changed` / `Checks run`

## Coding Rules

- Diff-first: only requested files + current diff + directly related files
- Do not audit full repo unless asked
- Before coding: root cause -> 2 options -> smallest safe fix
- Avoid unnecessary file churn and broad rewrites
- Follow: `/workspace/group/ai/CODING_BEST_PRACTICES.md`

## Local Junior Coder

- `delegate_to_local` only for low-risk subtasks (single helper/boilerplate/small draft)
- Never for critical/multi-file/security/data/deploy tasks
- Reviewer must run `npm run typecheck` + relevant checks before marking done

## AI File Hygiene

- Default ongoing files only:
  - `/workspace/group/ai/STATUS.md`
  - `/workspace/group/ai/TASK_QUEUE.md`
  - `/workspace/group/ai/PRODUCT_DECISIONS.md`
- Do not create ad-hoc markdown files unless user asks
- Detailed one-off reports go to `/workspace/group/ai/archive/`
- Do not duplicate `conversations/` logs into `ai/`

## Deployment (Preview)

- Agent command (always): `bash /workspace/group/preview-jambutter.sh`
- Never run preview from `/workspace/group` root
- Success must be verified before claim:
  - `cat /workspace/group/.data/preview/.active` is `jambutter`
  - expected package version appears in `/workspace/group/.data/preview/jambutter/assets/*.js`
  - include URL: `http://localhost:8080/jambutter/`

## Task Completion Contract (JamButter)

- Treat each user message as one task unless user explicitly says partial/proposal-only.
- If code changed in `/workspace/group/projects/jambutter`, task is NOT complete until all are done:
  - bump project version in JamButter `package.json`
  - run preview deploy via `bash /workspace/group/preview-jambutter.sh`
  - verify active preview is `jambutter`
  - verify deployed assets include the new version string
  - report preview URL `http://localhost:8080/jambutter/`
- Do not claim done if any item above is missing or unverified.

## References

- Deployment workflow: `/workspace/project/groups/global/NETLIFY.md`
- Product decisions: `/workspace/group/ai/PRODUCT_DECISIONS.md`
- Prompt templates: `/workspace/group/ai/PROMPT_TEMPLATES.md`
