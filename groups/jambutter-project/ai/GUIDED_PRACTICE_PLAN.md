# Guided Practice Mode - Implementation Plan

**Date**: 2026-02-24
**Feature**: Transform Exercises into Interactive Instructor Mode
**Priority**: MVP Core Feature

---

## User Requirement

Child starts app → Selects violin + 45 min practice → App guides through:
1. "Let's do G string open notes" (voice)
2. Start sound effect
3. Timer runs for 1 minute
4. "Great! Now D string" (voice + encouragement)
5. Continue through all exercises

**Goal**: Make child feel like practicing with an instructor, not alone.

---

## Current State

**Exercise Component** (`app/components/exercises/Exercises.tsx`):
- Simple checkbox list of exercises
- Manual checkbox toggle
- No durations
- No automatic progression
- No voice guidance

**Exercise Data** (`app/data/instruments.ts`):
```typescript
interface Exercise {
  id: string;
  label: string;  // "Open strings (2 min)"
  category: string; // "Warm-up"
}
```

---

## Implementation Plan

### Phase 1: Data Model Enhancement

**Add duration field to Exercise interface**:
```typescript
interface Exercise {
  id: string;
  label: string;
  category: string;
  duration: number; // in minutes
  instruction?: string; // Voice instruction text
}
```

**Update all exercise data** with durations:
```typescript
{
  id: "open-strings-g",
  label: "G string open notes",
  category: "Warm-up",
  duration: 1,
  instruction: "Let's practice G string open notes"
}
```

### Phase 2: Guided Practice Mode Component

**New State**:
- `isGuidedMode: boolean` - Toggle guided mode on/off
- `currentExerciseIndex: number` - Which exercise is active
- `exerciseTimer: number` - Countdown for current exercise
- `isPracticing: boolean` - Practice session active

**UI States**:
1. **Setup Mode** - Select exercises to include
2. **Guided Mode** - Active practice with timer
3. **Complete Mode** - Session finished, celebration

### Phase 3: Voice Instructions

**Voice Events**:
1. **Exercise Start**: "Let's practice [exercise name]"
2. **Exercise Complete**: "Great job! Now let's do [next exercise]"
3. **Session Complete**: "Amazing practice session! You did all [X] exercises!"
4. **Halfway**: "You're halfway through, keep going!"

**Use Web Speech API** (already in CharacterContext):
```typescript
speak("Let's practice G string open notes", { pitch: 1.2, rate: 1.0 });
```

### Phase 4: Auto-Timer Integration

**Timer Behavior**:
- Start exercise → voice instruction → countdown from duration
- At 10 seconds left: "Almost done!"
- At 0 seconds: "Great!" → auto-advance to next
- Visual countdown (large numbers)
- Progress bar for current exercise

---

## File Changes

### 1. `app/data/instruments.ts`
- Add `duration` and `instruction` fields to Exercise interface
- Update all exercise data with durations
- Break down exercises with durations (e.g., "Open strings" → separate G, D, A, E)

### 2. `app/components/exercises/Exercises.tsx`
- Add guided mode state
- Add "Start Guided Practice" button
- Create guided mode UI (full screen recommended)
- Implement auto-timer per exercise
- Add voice instructions at key moments

### 3. New file: `app/components/exercises/GuidedPracticeMode.tsx`
- Isolated guided practice component
- Full-screen immersive experience
- Large timer display
- Current exercise instruction
- Next exercise preview
- Progress indicator (X of Y exercises)

---

## UX Flow

```
┌─────────────────────────────────────┐
│     Exercises (Checklist Mode)      │
│                                      │
│  [ ] Open strings G (1 min)         │
│  [ ] Open strings D (1 min)         │
│  [ ] Open strings A (1 min)         │
│  [ ] Open strings E (1 min)         │
│  [ ] Scales (5 min)                 │
│                                      │
│  [Start Guided Practice] 👆         │
└─────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────┐
│   Guided Practice - Exercise 1/5    │
│                                      │
│            [Character]               │
│     "Let's practice G string!"      │
│                                      │
│              ┌─────┐                │
│              │ 0:47│  ← Countdown   │
│              └─────┘                │
│                                      │
│   G String Open Notes 🎻            │
│                                      │
│  ████████░░░░░░░░░░ 53%             │
│                                      │
│  Next: D String Open Notes          │
│                                      │
│  [⏸ Pause]  [⏩ Skip]  [✕ Exit]    │
└─────────────────────────────────────┘
```

---

## Voice Script Examples

### Violin - Open Strings Warmup (4 min total)

1. **Start**:
   - Voice: "Hi! Ready to warm up? Let's start with open strings."
   - Sound: Chime ✨

2. **G String (1 min)**:
   - Voice: "First, let's play G string open notes. Nice and steady."
   - Timer: 1:00 countdown
   - At 0:10: "Almost done!"
   - At 0:00: "Great G string!"

3. **D String (1 min)**:
   - Voice: "Now let's do D string. Keep that bow straight!"
   - Timer: 1:00 countdown

4. **A String (1 min)**:
   - Voice: "Moving to A string. You're doing great!"

5. **E String (1 min)**:
   - Voice: "Last one - E string. Make it sing!"

6. **Complete**:
   - Voice: "Perfect warmup! Your violin sounds beautiful!"
   - Celebration animation

---

## Technical Considerations

### Timer Logic
```typescript
const [currentExercise, setCurrentExercise] = useState(0);
const [timeLeft, setTimeLeft] = useState(exercises[0].duration * 60); // seconds

useEffect(() => {
  if (!isPracticing) return;

  const interval = setInterval(() => {
    setTimeLeft(prev => {
      if (prev <= 1) {
        // Exercise complete
        handleExerciseComplete();
        return 0;
      }

      // Check for voice cues
      if (prev === 10) speak("Almost done!");

      return prev - 1;
    });
  }, 1000);

  return () => clearInterval(interval);
}, [isPracticing, currentExercise]);
```

### Auto-Advance
```typescript
const handleExerciseComplete = () => {
  playSuccess();
  speak("Great job!");

  if (currentExercise < exercises.length - 1) {
    // Move to next exercise
    setTimeout(() => {
      setCurrentExercise(prev => prev + 1);
      setTimeLeft(exercises[currentExercise + 1].duration * 60);
      speak(exercises[currentExercise + 1].instruction);
    }, 2000); // 2 second pause between exercises
  } else {
    // Practice complete
    handlePracticeComplete();
  }
};
```

---

## Success Criteria

✅ User can start guided practice with one tap
✅ Voice instructions play at start of each exercise
✅ Timer counts down automatically
✅ Auto-advances to next exercise
✅ Encouragement between exercises
✅ Child feels guided (not alone)
✅ Can pause/resume practice session
✅ Can skip exercise if needed
✅ Session completion celebration

---

## Next Steps

1. Update Exercise interface with duration/instruction
2. Add detailed exercise data for violin (MVP)
3. Create GuidedPracticeMode component
4. Integrate voice instructions
5. Test full flow
6. Add pause/skip controls
7. Add session summary at end

**Estimated Time**: 4-5 hours
**Version Target**: v0.5.0
