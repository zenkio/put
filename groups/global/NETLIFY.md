# Preview & Netlify Deployment (Global)

This is the shared reference for every project before touching preview or Netlify deployment. Follow it first, then add project-specific URLs or commands inside each group’s workspace.

1. **Build locally** (usually `npm run build`) from the project root.
2. **Deploy to the local preview** directory before anything else:
   - Preferred: run the project preview deploy script (e.g. JamButter: `npm run preview` from `/workspace/group/projects/jambutter`).
   - Manual fallback: copy `build/client` into `/workspace/group/.data/preview/<project-name>` and set `/workspace/group/.data/preview/.active`.
   - Verify preview at `http://localhost:8080/` and confirm active project via `http://localhost:8080/_projects`.
3. **Wait for explicit confirmation** (from the project chat or owner) that the preview looks good.
4. **Only then deploy to Netlify** (usually via the project’s deploy script, e.g., `node deploy.cjs` in JamButter).
5. **If Netlify is stale or assets fail**, re-run the deploy script and confirm the new URL matches the preview before announcing it.

Keep this file in sync; all groups should read it before building/deploying.
