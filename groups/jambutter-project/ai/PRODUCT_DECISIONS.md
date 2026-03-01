# JamButter Product Decisions

Purpose: keep stable product decisions in one place so future chats can reference this file instead of re-discussing context.

## Active Decisions

1. Preview deployment path
- Decision: preview deploy must target `/workspace/group/.data/preview/jambutter`.
- Why: non-main containers can always write there.
- How: use `bash /workspace/group/preview-jambutter.sh`.

2. Preview success criteria
- Decision: never claim preview deploy success without verification.
- Required checks:
  - `.active` equals `jambutter`
  - expected version string exists in `.data/preview/jambutter/assets/*.js`
  - share preview URL `http://localhost:8080/jambutter/`

3. Local junior coder policy
- Decision: local model (`qwen2.5-coder:3b`) is helper only.
- Allowed: low-risk subtasks (single helper/boilerplate/small draft).
- Not allowed: critical logic, multi-file, security/data/deploy changes.
- Verification required by reviewer: `typecheck` + relevant tests/build checks.

4. Routing preference for coding
- Decision: coding tasks route cloud-first.
- Order: `claude -> gemini -> openrouter -> local fallback`.

## Core Product Vision (2026-02-25)

**JamButter is a practice partner app** that helps children practice music with guidance and encouragement.

### Key Features & Priorities:

1. **Guided Practice (Core Feature)**
   - Main feature: step-by-step practice with voice instructions
   - Based on ABRSM grade system (user sets grade in settings)
   - Exercise plan page lists current practice content
   - Users can customize plan (add/remove exercises)
   - Users select practice duration per session
   - Daily practice time recorded and displayed in trend graph

2. **Practice Tools Integration**
   - Metronome integrated into guided practice sessions
   - Tuner integrated into guided practice sessions
   - Both tools available standalone for quick access

3. **Progress Tracking**
   - Record daily practice time
   - Show practice time trends in graph
   - Compare against user's daily goal (set in settings)
   - Track streak, XP, and level progression

4. **User Experience**
   - Header sticks at top for consistent navigation
   - Voice-enabled by default (natural TTS)
   - Mobile-optimized with hidden nav during guided practice
   - ABRSM grade determines exercise difficulty

## Current Version Targets

- App package version: `0.6.3` (as of 2026-02-25)
- Preview should reflect latest package version after deploy.

## Change Log

- 2026-02-25: added core product vision and feature priorities
- 2026-02-23: initialized unified decisions file.
