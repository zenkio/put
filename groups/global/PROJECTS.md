# Project Registry

This file is the shared discovery index for all project workspaces.

## Canonical Project Homes

- `jambutter`
  - Owner chat: `jambutter-project`
  - Canonical path: `/workspace/project/groups/jambutter-project/projects/jambutter`
  - Legacy alias (main chat only): `/workspace/group/projects/jambutter`
  - Primary docs: `/workspace/project/groups/jambutter-project/projects/jambutter/docs`

- `violin-practice-app`
  - Owner chat: `main`
  - Canonical path: `/workspace/project/groups/main/projects/violin-practice-app`

## Rules

- Treat canonical path as source of truth.
- Use legacy alias only for backward compatibility.
- Store project docs inside each project repository (`docs/`) so context travels with code.
