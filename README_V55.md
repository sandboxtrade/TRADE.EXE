# TRADE.EXE v55 — Design Polish

v55 is a visual/UX pass on top of the modular v54 architecture. Market math, storage rules and transports are intentionally unchanged.

## What changed

- Rebuilt the dark palette around `#030303` with quieter surfaces and borders.
- Reduced visual noise: flatter surfaces, tighter radii, fewer bright fills.
- LONG/SHORT actions now use dark semantic tints instead of full saturated button fills.
- Rebalanced desktop lobby into a centered workstation layout with a fixed 80px rail and a capped 1500px content canvas.
- Improved desktop spacing for balance, Free Market, level, modes, session stats, equity curve and recent sessions.
- Added explicit semantic CSS classes for major dashboard and terminal regions instead of styling important blocks through fragile Tailwind font-size selectors.
- Increased desktop widths for profile/setup/result screens so they no longer feel like a phone column on a monitor.
- Tightened auth fields, tabs, controls and footer actions.
- Polished the trading terminal: quieter header/panel, better metric separators, cleaner chart toolbar, denser position strip and restrained toast/order styling.
- Removed a dead theme constant/comment block left in `features/market.js`.
- Updated reduced-motion behavior and animation timings.

## Structure

Runtime files are at repository root (`app/`, `core/`, `features/`, `i18n/`, `storage/`, `ui/`).
Editable source lives under `source/`.

After editing source:

```bash
npm run build
npm test
```

For GitHub Pages upload the whole runtime structure, not only `index.html` and `app.js`.

## Validation

- TypeScript/JSX build: PASS
- `engine-smoke.mjs`: PASS
- `storage-smoke.mjs`: PASS
- `node --check` for generated JS modules: PASS

## Intentionally unchanged

- Local/client-authoritative balance and sessions remain prototype behavior until server migration.
- React and Tailwind are still loaded from CDN/import-map infrastructure.
- Free Market is still local rather than a true shared 24/7 server market.
