# JamButter Development Plan & Roadmap

**Date**: 2026-02-21
**Current Version**: v0.3.1
**Preview URL**: http://192.168.1.143:8080/jambutter/
**Status**: ✅ Character System Complete, Ready for Next Phase

---

## 📊 Current State Summary

### ✅ **Completed Features (v0.3.1)**

**Character System** - 100% Complete:
- ✅ 6 SVG characters created (Buttery + 5 instrument buddies)
- ✅ Character context for global state management
- ✅ Voice prompt system (Web Speech API)
- ✅ 50+ contextual messages
- ✅ Full integration across all 4 main screens:
  - Timer: Instrument buddy with practice encouragement
  - Tuner: Instrument buddy with tuning guidance
  - Metronome: Bongo character with rhythm messages
  - Exercises: Instrument buddy with completion encouragement
- ✅ Speech bubble component with typing animation
- ✅ Custom CSS animations (float, sway, bounce, pulse)
- ✅ Reduced motion support
- ✅ Version footer in Settings showing v0.3.1

**Core Features** (Pre-existing):
- ✅ Practice timer with presets
- ✅ Tuner with reference tones
- ✅ Metronome with time signatures
- ✅ Exercise checklist by instrument
- ✅ Progress tracking (XP, streaks, daily goals)
- ✅ Basic achievement system
- ✅ Settings (instrument, theme, sound, voice)
- ✅ Multi-instrument support (violin, piano, guitar)

---

## 🎯 **NEXT DEVELOPMENT PHASES**

---

## **PHASE 1: Core User Experience** (Week 1)

### **Task 2.1: Home Screen Quick Practice**
**Priority**: 🔥 Critical
**Time**: 2 hours
**Version**: v0.4.0

**Goal**: Make starting practice effortless

**Implementation**:

1. **Quick Start Buttons** (45 min)
   ```tsx
   // Add to app/routes/home.tsx
   <div className="grid grid-cols-3 gap-4">
     <QuickStartButton duration={5} label="Quick Warmup" />
     <QuickStartButton duration={15} label="Practice" />
     <QuickStartButton duration={30} label="Deep Session" />
   </div>
   ```
   - Large, colorful buttons
   - Navigate to timer with pre-set duration
   - Different colors for visual hierarchy

2. **Today's Progress Card** (45 min)
   ```tsx
   // Pull from localStorage
   const todayMinutes = useLocalStorage('jambutter-today-minutes', 0);
   const dailyGoal = useLocalStorage('jambutter-daily-goal', 30);
   const streak = calculateStreak();

   <Card>
     <ProgressBar value={todayMinutes} max={dailyGoal} />
     <div>🔥 {streak} Day Streak!</div>
     <div>Today: {todayMinutes} / {dailyGoal} min</div>
   </Card>
   ```

3. **Buttery Welcome** (30 min)
   ```tsx
   const getGreeting = () => {
     const hour = new Date().getHours();
     if (hour < 12) return "Good morning! Ready to practice?";
     if (hour < 17) return "Good afternoon! Let's make music!";
     if (hour < 21) return "Evening practice time!";
     return "Late night session? You're dedicated!";
   };

   <Character character="buttery" message={getGreeting()} />
   ```

**Files to Create/Modify**:
- `app/routes/home.tsx` - Main changes
- `app/components/home/QuickStartButton.tsx` - New component
- `app/utils/timeGreeting.ts` - Helper for time-based messages

**Success Metrics**:
- Reduced clicks to start practice (1 click instead of 3+)
- Streak visibility increases engagement

---

### **Task 2.2: Metronome Visual Enhancement**
**Priority**: ⭐ High
**Time**: 2.5 hours
**Version**: v0.4.1

**Goal**: Professional-grade metronome with visual feedback

**Implementation**:

1. **Tap Tempo** (1.5 hours)
   ```tsx
   const [tapTimes, setTapTimes] = useState<number[]>([]);

   const handleTap = () => {
     const now = Date.now();
     const newTaps = [...tapTimes, now].slice(-4); // Keep last 4
     setTapTimes(newTaps);

     if (newTaps.length >= 2) {
       const intervals = newTaps.slice(1).map((t, i) => t - newTaps[i]);
       const avgInterval = intervals.reduce((a, b) => a + b) / intervals.length;
       const calculatedBpm = Math.round(60000 / avgInterval);
       setBpm(calculatedBpm);
     }

     // Reset after 3 seconds
     setTimeout(() => setTapTimes([]), 3000);
   };
   ```

2. **Pulsing Visual Indicator** (1 hour)
   ```tsx
   <div className="relative w-48 h-48 mx-auto">
     <div
       className={`
         absolute inset-0 rounded-full border-8
         transition-all duration-100
         ${isPlaying && currentBeat === 0
           ? 'bg-butter scale-110'
           : 'bg-toast scale-90'}
       `}
     />
     <div className="absolute inset-0 flex items-center justify-center">
       <span className="text-4xl font-bold">{currentBeat + 1}</span>
     </div>
   </div>
   ```

**Files to Modify**:
- `app/components/metronome/Metronome.tsx`

---

## **PHASE 2: Engagement & Motivation** (Week 2)

### **Task 3: Progress Page Redesign**
**Priority**: ⭐ High
**Time**: 3 hours
**Version**: v0.5.0

**Goal**: Visualize progress to maintain motivation

**Implementation**:

1. **Weekly Practice Chart** (1.5 hours)
   ```tsx
   // Simple CSS bar chart
   const last7Days = getLast7DaysData();

   <div className="flex items-end gap-2 h-48">
     {last7Days.map((day) => (
       <div
         key={day.date}
         className="flex-1 bg-toast rounded-t-lg"
         style={{ height: `${(day.minutes / dailyGoal) * 100}%` }}
       >
         <div className="text-xs text-center">{day.minutes}</div>
       </div>
     ))}
   </div>
   ```

2. **Streak Calendar** (1 hour)
   ```tsx
   // Last 30 days mini calendar
   <div className="grid grid-cols-7 gap-1">
     {last30Days.map((day) => (
       <div className={`
         w-8 h-8 rounded flex items-center justify-center text-xs
         ${day.practiced ? 'bg-success text-white' : 'bg-cream-dark'}
       `}>
         {day.practiced ? '✓' : day.dayNumber}
       </div>
     ))}
   </div>
   ```

3. **Achievement Preview** (30 min)
   ```tsx
   const nextAchievement = getNextAchievement();

   <Card>
     <h3>Next Achievement</h3>
     <ProgressBar
       value={nextAchievement.current}
       max={nextAchievement.target}
     />
     <p>{nextAchievement.description}</p>
   </Card>
   ```

**Files to Modify**:
- `app/routes/progress.tsx`
- `app/utils/progressCalculations.ts` - New helper

---

### **Task 4: Exercise Library Expansion**
**Priority**: ⭐ Medium
**Time**: 2.5 hours
**Version**: v0.5.1

**Goal**: More comprehensive practice structure

**Implementation**:

1. **Add 30 New Exercises** (1.5 hours)
   - Update `app/data/instruments.ts`
   - Add 10 exercises per instrument
   - Include difficulty levels, time estimates

2. **Exercise Details Modal** (1 hour)
   ```tsx
   interface ExerciseDetail {
     id: string;
     description: string;
     difficulty: 'beginner' | 'intermediate' | 'advanced';
     estimatedMinutes: number;
     benefits: string[];
     tips: string[];
   }
   ```

**Files to Modify**:
- `app/data/instruments.ts`
- `app/components/exercises/ExerciseDetailModal.tsx` - New

---

## **PHASE 3: Polish & Optimization** (Week 3)

### **Task 5: Mobile Optimization**
**Priority**: ⭐ High
**Time**: 2 hours
**Version**: v0.6.0

**Checklist**:
- [ ] Test on iPhone SE (375px)
- [ ] Test on iPhone 14 Pro (393px)
- [ ] Test on iPad (768px)
- [ ] Fix any overflow issues
- [ ] Test landscape orientation
- [ ] Optimize character SVG rendering
- [ ] Lazy load heavy components
- [ ] Check bundle size (`npm run build`)

---

### **Task 6: Achievement System v2**
**Priority**: ⭐ Medium
**Time**: 2.5 hours
**Version**: v0.6.1

**New Achievements** (15 total):

**Practice Milestones**:
- First Practice (1 min)
- Warmup Warrior (10 hours)
- Practice Pro (50 hours)
- Music Master (100 hours)
- Legend (500 hours)

**Streak Achievements**:
- Week Strong (7 days)
- Monthly Maestro (30 days)
- Hundred Days (100 days)
- Year of Music (365 days)

**Time-Based**:
- Early Bird (practice before 9am)
- Night Owl (practice after 9pm)
- Weekend Warrior (Sat+Sun)
- Birthday Jam (practice on birthday)

**Skill-Based**:
- Scale Master (complete all scales)
- Tempo King (120+ BPM metronome)
- Exercise Completionist (all exercises)

**Implementation**:
```tsx
// app/contexts/AchievementsContext.tsx
const NEW_ACHIEVEMENTS = [
  {
    id: 'week-strong',
    name: 'Week Strong',
    description: 'Practice 7 days in a row',
    icon: '🔥',
    xpReward: 100,
    rarity: 'common',
    check: (stats) => stats.currentStreak >= 7
  },
  // ... more achievements
];
```

---

## **PHASE 4: Advanced Features** (Future)

### **Task 7: Real Pitch Detection Tuner**
**Priority**: 🔮 Future
**Time**: 4-5 hours

**Algorithm**: Autocorrelation or YIN for pitch detection

### **Task 8: Practice Recording**
**Priority**: 🔮 Future
**Time**: 3-4 hours

**Feature**: Record practice sessions, playback

### **Task 9: Social Features**
**Priority**: 🔮 Future
**Time**: 5+ hours

**Features**:
- Parent dashboard
- Share achievements
- Practice challenges

---

## 📅 **RECOMMENDED EXECUTION SCHEDULE**

### **Week 1: Core UX**
- **Mon**: Task 2.1 - Home Screen (2h) → Deploy v0.4.0
- **Tue**: Task 2.2 - Metronome Visual (2.5h) → Deploy v0.4.1
- **Wed-Thu**: Testing, bug fixes, user feedback
- **Fri**: Documentation, planning next week

### **Week 2: Engagement**
- **Mon**: Task 3 - Progress Page (3h) → Deploy v0.5.0
- **Tue-Wed**: Task 4 - Exercise Expansion (2.5h) → Deploy v0.5.1
- **Thu-Fri**: Testing, refinement

### **Week 3: Polish**
- **Mon-Tue**: Task 5 - Mobile Optimization (2h) → Deploy v0.6.0
- **Wed**: Task 6 - Achievements (2.5h) → Deploy v0.6.1
- **Thu-Fri**: Final testing, production deployment planning

---

## 🎯 **START HERE: Task 2.1 - Home Screen Quick Practice**

**Why this task first?**
1. ✅ Highest user impact (first screen they see)
2. ✅ Reduces friction to start practicing
3. ✅ Quick to implement (2 hours)
4. ✅ Builds on existing timer feature
5. ✅ Non-breaking addition
6. ✅ Immediate value for users

**Ready to start?** I can begin implementing Task 2.1 right now.

---

## 📦 **Deployment Checklist** (For Each Task)

Before deploying each version:

1. **Build**: `npm run build`
2. **Verify**: Check bundle size, no errors
3. **Deploy Preview**: Copy to `/workspace/project/data/preview/jambutter`
4. **Test**: Verify on preview URL
5. **Version Bump**: Update `package.json`
6. **Document**: Update CHANGELOG or notes
7. **Netlify** (when ready): `npm run deploy`

---

## 🔄 **Version Strategy**

- **Patch** (0.X.Y): Bug fixes, small tweaks
  - Example: 0.3.1 → 0.3.2
- **Minor** (0.X.0): New features
  - Example: 0.3.1 → 0.4.0 (Home screen)
- **Major** (X.0.0): Breaking changes, major redesign
  - Example: 0.6.1 → 1.0.0 (Public release)

**Target**: Reach v1.0.0 in 3-4 weeks

---

## 📊 **Success Metrics to Track**

As you implement features, consider tracking:

- **Engagement**: Sessions per user per week
- **Retention**: 7-day, 30-day active users
- **Feature Usage**: % using timer, metronome, tuner, exercises
- **Streaks**: Average streak length, % with 7+ day streak
- **Achievements**: Unlock rate, most common achievements
- **Practice Time**: Average session length, total practice time

---

**Ready to proceed?** Let me know if you want to:
1. ✅ Start Task 2.1 (Home Screen) now
2. 🔄 Review/modify the plan first
3. 📋 Focus on a different task

I'm ready to begin implementation!
