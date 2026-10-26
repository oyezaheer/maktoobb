# Maktoobb

A local-first notes app where **every line is stamped with the moment you wrote it**.
It works offline in the browser and can sync across devices when you sign in.

**Live demo:** https://oyezaheer.github.io/maktoobb/

<!-- Add a screenshot: save it as docs/screenshot.png and uncomment the next line -->
<!-- ![Screenshot](docs/screenshot.png) -->

Inspired by the idea of interstitial journaling and by the app Notetime. This is an independent
learning project and shares no code with it.

## Features

- Automatic timestamp for every line, with two modes: freeze the time on Enter, or on the first keystroke
- `#tags` highlighted inline, tag filtering and search across all notes
- Paste images; paste many lines to split them into separate entries
- Multiple notes, newest-first option, milliseconds option, light and dark themes
- Export a note as text, or everything as JSON
- Works fully offline and without an account. Optional sign-in syncs notes across devices and browser tabs

## Tech stack

| Part | Choice |
|---|---|
| UI | React 18 (loaded from a CDN, no bundler) |
| Local storage | IndexedDB through Dexie |
| Cloud sync | Supabase: Postgres, Auth, Realtime, row-level security |
| Tests | Vitest, jsdom, fake-indexeddb, a simulated Supabase server |
| CI/CD | GitHub Actions, GitHub Pages |

## How sync works

- Local-first: the browser database is the source of truth, so typing never waits for the network.
- Every row has `updatedAt` and a `dirty` flag. After a change, dirty rows are pushed to Postgres.
- Conflicts: the edit with the later `updatedAt` wins. The same rule also runs inside Postgres as a trigger.
- Deletes are stored as marked rows ("tombstones") so that they can travel to other devices.
- Pull uses a cursor on the server's own timestamp, in pages, so each device only downloads what is new.
- Supabase Realtime pings other devices, and `BroadcastChannel` keeps tabs in the same browser in step.
- Security: the browser only holds the publishable key. Row-level security limits every user to their own rows.

## Tests

130 automated tests, written test-first for the core logic:

- Unit tests for timestamps, tags, grouping, search, export and the sync engine
- Integration tests drive the real page with simulated typing, pasting and several devices against a fake Supabase,
  including offline periods, edits made during a sync, account switching and database upgrades

```
npm install
npm test
```

## Run it locally

1. `npm install`
2. Create a Supabase project, run `supabase/schema.sql` in its SQL editor, and turn off "Confirm email" under
   Authentication -> Sign In / Providers -> Email (for development).
3. Copy `src/config.example.js` to `src/config.js` and fill in your project URL and publishable key.
4. `npm run build`, then `npx serve dist` and open http://localhost:3000

Without `src/config.js` the app still works, just without cloud sync.

## Deploy

Pushing to `main` runs the tests and publishes `dist/` to GitHub Pages (`.github/workflows/deploy.yml`).
Add `SUPABASE_URL` and `SUPABASE_KEY` as repository **variables** (Settings -> Secrets and variables -> Actions).

## Known limits

- Two devices editing the same line at nearly the same time: the later device clock wins.
- Images are stored inside the note rows, so many large pictures will be slow to sync.
- Free Supabase projects pause after a period of inactivity, so cloud sync in the demo may be paused.
  The app itself keeps working offline.

## License

MIT
