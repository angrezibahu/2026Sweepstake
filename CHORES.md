# Chores — WC2026 Sweepstake

A running checklist for keeping the Kewford South sweepstake site healthy
during the tournament and afterwards. Tick things off as you go.

## One-time setup (do once, before the tournament)

- [ ] Add the `FOOTBALL_DATA_API_TOKEN` repo secret so results auto-update
      (Settings → Secrets and variables → Actions). See `RESULTS_AUTOMATION.md`.
- [ ] Confirm GitHub Pages is enabled and the `deploy.yml` workflow is green.
- [ ] Run the draw via the `?admin=true` panel and **Export Data** as a backup.
- [ ] Check the social-share image (`poster.png`) referenced by `og:image` in
      `index.html` actually exists in the repo and renders when the link is shared.

## During the tournament (recurring)

- [ ] Spot-check `results.json` / `tracker-state.json` updated after each matchday
      (the workflow runs hourly — see the Actions tab for failures).
- [ ] Fix any wrong or late scores via `manual-results.json` or the admin panel
      (manual overrides win over the API).
- [ ] Watch for group-decided-by-rare-tiebreaker cases (head-to-head, fair-play,
      drawing of lots) — these aren't automated; set stage by hand if one happens.
- [ ] Keep the "spots gone" badge (`index.html`) accurate if entries change.
- [ ] Verify the PWA still installs / works offline after any deploy (`sw.js`).

## After the tournament

- [ ] Confirm the final winner + top-3 are reflected in the bracket.
- [ ] Pay out prizes (🥇 £50 / 🥈 £25 / 🥉 £15) and settle the Kewford South kitty.
- [ ] Export final data as an archive snapshot.

## Code / repo maintenance (nice-to-have)

- [ ] Bump the service-worker cache version in `sw.js` whenever assets change,
      so returning visitors don't get stale files.
- [ ] Add a short "how to run locally" note to a README (e.g. `python -m http.server`).
- [ ] Consider a basic test for `scripts/update_results.py` (standings +
      qualification logic) so a feed change can't silently break the bracket.
- [ ] Periodically re-check `schedule.json` kickoff times against the official
      fixtures in case of venue/time changes.
