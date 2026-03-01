# JamButter Navigation Bar Issue Analysis

**Date:** 2026-02-21
**Issue:** Navigation bar works locally but breaks on Netlify production

## Project Architecture

### Framework & Build Setup
- **Framework:** React Router 7.12.0 (SPA mode)
- **Build Tool:** Vite 7.1.7
- **Styling:** Tailwind CSS 4.1.18 with @tailwindcss/vite plugin
- **Deployment:** Netlify (static site hosting)
- **Config:** `react-router.config.ts` has `ssr: false` (SPA mode)

### Navigation Implementation
**File:** `/app/components/layout/Navigation.tsx`

The navigation is a **bottom navigation bar** that:
- Uses `md:hidden` Tailwind class to hide on tablets/desktop (>= 768px)
- Fixed position at bottom of screen
- Contains 5 navigation items (Home, Timer, Tuner, Beat, Settings)
- Uses React Router's `useLocation()` and `useNavigate()` hooks

**AppLayout wraps navigation:**
```tsx
{/* Bottom navigation - mobile only */}
<div className="md:hidden">
  <Navigation />
</div>
```

### Build Configuration
- Build output: `build/client`
- SPA mode with client-side routing
- Netlify redirects: `/* -> /index.html` (status 200)

## CSS Analysis

✅ **Media queries ARE present in built CSS** - Found:
```css
@media(min-width:48rem){.md\:hidden{display:none}}
```

✅ **All responsive Tailwind classes are compiled** (md:block, md:flex, md:hidden, etc.)

## Root Cause Analysis

### Most Likely: CSS Specificity or Ordering Issue

The CSS IS being generated correctly, so the issue is likely:

1. **Another style is overriding `display: none`**
   - Check for conflicting styles with higher specificity
   - Inline styles might override
   - Another class might set `display: block !important`

2. **CSS loading timing issue**
   - In SPA mode, CSS might load after React renders
   - Navigation flashes visible before CSS hides it
   - Netlify CDN might serve CSS slower than JS

3. **Browser caching on Netlify**
   - Old CSS cached by Netlify CDN
   - New JS using new class names, old CSS doesn't have them
   - Asset hashing should prevent this but worth checking

4. **Tailwind 4.x specificity changes**
   - Tailwind 4.x uses CSS layers (@layer)
   - Layer ordering might differ between dev and prod
   - Some styles might escape the layer system

## Recommended Solutions (Priority Order)

### Solution 1: Add CSS Safelist (Safest)
Force Tailwind to always include these classes:

```ts
// tailwind.config.ts
export default {
  content: ['./app/**/*.{js,jsx,ts,tsx}'],
  safelist: [
    'md:hidden',
    'md:block', 
    'md:flex'
  ],
  // ...
} satisfies Config
```

### Solution 2: Use Media Query Wrapper Component
Create a more explicit responsive wrapper:

```tsx
// components/ui/MediaQuery.tsx
export function HiddenAboveMd({ children }: { children: React.ReactNode }) {
  return (
    <div className="block md:hidden">
      {children}
    </div>
  );
}

// In AppLayout.tsx
<HiddenAboveMd>
  <Navigation />
</HiddenAboveMd>
```

### Solution 3: Add Inline Style Fallback
Quick defensive fix:

```tsx
<div 
  className="md:hidden"
  style={{ display: window.innerWidth < 768 ? 'block' : 'none' }}
>
  <Navigation />
</div>
```

### Solution 4: JavaScript-based Responsive (Most Reliable)
Use a media query hook instead of CSS:

```tsx
// hooks/useMediaQuery.ts
import { useState, useEffect } from 'react';

export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(false);
  
  useEffect(() => {
    const media = window.matchMedia(query);
    setMatches(media.matches);
    
    const listener = (e: MediaQueryListEvent) => setMatches(e.matches);
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, [query]);
  
  return matches;
}

// In AppLayout.tsx
const isMobile = useMediaQuery('(max-width: 767px)');

return (
  <>
    {isMobile && <Navigation />}
  </>
);
```

## Investigation Steps

1. **Inspect live site** - Open DevTools on Netlify deployment
   - Check if `md:hidden` class exists on the element
   - Check computed styles
   - Verify CSS file loaded
   - Check for conflicting styles

2. **Test local production build**:
   ```bash
   cd /workspace/group/projects/jambutter
   npm run build
   npx serve build/client
   # Test on http://localhost:3000
   ```

3. **Compare CSS files** - Download production CSS from Netlify and compare with local build

4. **Check Netlify deploy logs** - Look for build warnings or CSS generation issues

## Summary

The navigation bar is properly implemented with `md:hidden` Tailwind class, and the CSS IS being generated correctly in the build output. The issue is most likely:

1. **CSS specificity conflict** - Another style overriding the hidden state
2. **CSS loading timing** - CSS loads after React renders in SPA mode  
3. **CDN caching** - Netlify serving stale CSS
4. **Tailwind 4.x quirk** - New @layer system behaving differently in production

**Recommended immediate fix:** Add Solution 1 (safelist) + Solution 4 (JS-based) as belt-and-suspenders approach. The JS solution is most reliable for ensuring mobile-only visibility.
