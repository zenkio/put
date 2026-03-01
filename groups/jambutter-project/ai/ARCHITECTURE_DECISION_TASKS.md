# Architecture Decision: Exercise Sections & Tasks

**Date:** 2026-03-01
**Status:** ✅ Implemented - Core algorithm complete, integration pending
**Priority:** CRITICAL - Core app value proposition

## Problem Statement

JamButter currently uses flat exercise items without detailed guidance. Users see "Warm-up - 5 min" but don't know:
- What specific actions to take
- Step-by-step instructions
- How to adapt when practice time is limited (15 min vs 60 min)

**Example issue:** Beginner sees "ABRSM Grade 1 Warm-up - 5 min" but has no idea what tasks to do in those 5 minutes.

## Solution: Hierarchical Task System

### Architecture

```
ExerciseSection (e.g., "Warm-up")
  └─ ExerciseTask[] (e.g., "Tune violin", "Check posture", "G string practice")
      ├─ duration: base time
      ├─ instruction: step-by-step guidance
      ├─ priority: essential | recommended | optional
      ├─ minDuration / maxDuration: scaling bounds
      └─ variations: practice variation config
```

### Key Components

1. **ExerciseSection** - High-level practice component
   - Replaces current flat ExerciseItem
   - Contains array of tasks
   - Total duration = sum of included tasks (adaptive)

2. **ExerciseTask** - Individual timed activity
   - Clear instruction text shown to user
   - Priority-based inclusion (essential/recommended/optional)
   - Time scaling (min/max duration bounds)

3. **Time Allocation Algorithm** - Smart task selection
   - Always includes "essential" tasks (tuning, posture)
   - Adds "recommended" tasks as time permits
   - Scales durations proportionally
   - Adds "optional" tasks only with extra time

### Example: Beginner Violin Warm-up

**Total available: 8 tasks, 9 min base duration**

**15-min practice (4 min warmup):**
- ✓ Tune violin (1 min) [essential]
- ✓ Posture check (1 min) [essential]
- ✓ G string (1 min) [recommended]
- ✓ D string (1 min) [recommended]
- ⊘ A string [recommended] - skipped
- ⊘ E string [optional] - skipped
- ⊘ Finger placement [recommended] - skipped
- ⊘ Bow hold review [optional] - skipped

**45-min practice (8 min warmup):**
- ✓ Tune violin (1.3 min) [essential] - scaled up
- ✓ Posture check (1.3 min) [essential] - scaled up
- ✓ G string (1.2 min) [recommended]
- ✓ D string (1.2 min) [recommended]
- ✓ A string (1.2 min) [recommended]
- ✓ Finger placement (1.1 min) [recommended]
- ⊘ E string [optional] - still skipped
- ⊘ Bow hold review [optional] - still skipped

**60-min practice (10 min warmup):**
- All tasks included, durations scaled up to max

## Pedagogical Research

Based on:
- **ABRSM Violin Syllabus 2024-2027**
- **Suzuki Method** pedagogy
- **Simon Fischer** "Basics" and "Practice"
- Professional violin/piano teaching experience

### Professional Task Breakdown Principles

**Warm-up structure:**
1. Instrument preparation (tuning) - ESSENTIAL
2. Posture check - ESSENTIAL for injury prevention
3. Open strings / basic technique - RECOMMENDED for tone
4. Finger placement review - RECOMMENDED for intonation
5. Bow technique review - OPTIONAL (extension work)

**Scale practice structure:**
1. Slow practice for intonation - ESSENTIAL
2. Separate bows at tempo - RECOMMENDED
3. Slurred bows - RECOMMENDED
4. Speed building - OPTIONAL

## Files Created

### Core System
- `app/data/exercise-tasks.ts` - Data model & allocation algorithm
- `app/data/professional-exercises.ts` - Pedagogically sound task breakdowns
- `scripts/test-time-allocation.js` - Algorithm validation

### Examples Implemented
- ✅ Beginner Violin Warm-up (8 tasks)
- ✅ Grade 1 Violin Scales (7 tasks)
- ✅ Beginner Piano Warm-up (4 tasks)

## Next Steps

### 1. Data Migration
- [ ] Update ExerciseItem interface to support tasks array
- [ ] Migrate all ABRSM exercises to new format
- [ ] Add professional task breakdowns for all grades (1-5)
- [ ] Add professional task breakdowns for all instruments

### 2. UI Integration
- [ ] Update Plan page to show section duration dynamically
- [ ] Show task count in exercise cards ("5 tasks, 8-12 min")
- [ ] Update Edit & Config modal to show tasks list

### 3. Practice Flow
- [ ] **CRITICAL:** Update practise page for task-by-task progression
  - Show current task name
  - Display task instruction
  - Timer counts down task duration
  - Auto-advance to next task
  - Progress: "Task 3 of 7"
- [ ] Apply time allocation when starting practice session
- [ ] Show adapted plan to user ("Based on 30 min, 6 tasks selected")

### 4. User Configuration
- [ ] Allow users to set preferred practice duration
- [ ] Show estimated task selection before starting
- [ ] Allow manual task skip (with note: won't count for achievements)

## Testing Required

- [ ] 15-min practice plan (minimal time)
- [ ] 30-min practice plan (standard)
- [ ] 45-min practice plan (extended)
- [ ] 60+ min practice plan (comprehensive)
- [ ] Edge case: 5-min plan (only essentials)
- [ ] Edge case: 90-min plan (all tasks + extensions)

## Success Metrics

**User value:**
- Users know exactly what to do in each practice session
- Practice adapts intelligently to available time
- Beginners receive clear, step-by-step guidance
- Advanced players get comprehensive task breakdowns

**Technical:**
- Algorithm maintains time constraints (never exceeds available time)
- Essential tasks always included
- Proportional time scaling works correctly
- Backward compatibility maintained

## Risks & Mitigation

**Risk:** Too complex for users
**Mitigation:** Start with beginner exercises, test with real users

**Risk:** Tasks too prescriptive
**Mitigation:** Allow task skipping, keep priority system flexible

**Risk:** Time allocation too rigid
**Mitigation:** Build user preference system, allow manual adjustments

## Status

- ✅ Architecture designed
- ✅ Core algorithm implemented
- ✅ Algorithm validated (passing tests)
- ✅ Example sections created (3 professional breakdowns)
- ⏳ UI integration pending
- ⏳ Full data migration pending
- ⏳ Practice flow implementation pending

**Next immediate action:** Integrate with practise page to show task-by-task progression.
