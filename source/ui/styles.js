const GLOBAL_CSS = `
:root {
  --tx-ease: cubic-bezier(.22,.85,.26,1);
  --tx-fast: 120ms;
  --tx-mid: 180ms;
  --tx-slow: 240ms;
  --tx-safe-top: env(safe-area-inset-top, 0px);
  --tx-safe-bottom: env(safe-area-inset-bottom, 0px);
  --tx-bg: #030303;
  --tx-surface: #070708;
  --tx-raised: #0A0A0B;
  --tx-hair: #171719;
  --tx-hair-strong: #252529;
  --tx-text: #F0EEE9;
  --tx-dim: #918D86;
  --tx-faint: #5D5A55;
  --tx-radius-sm: 7px;
  --tx-radius-md: 9px;
  --tx-radius-lg: 11px;
}

* { box-sizing: border-box; }
html, body, #root { width: 100%; min-height: 100%; background: var(--tx-bg); }
body {
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  -webkit-text-size-adjust: 100%;
  font-synthesis-weight: none;
}
button, input, textarea, select { font: inherit; }
button { -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
button:disabled { cursor: default; }
input, textarea { caret-color: var(--tx-text); }
input::placeholder, textarea::placeholder { color: var(--tx-faint); opacity: .82; }
button:focus-visible, select:focus-visible {
  outline: 1px solid rgba(240,238,233,.5);
  outline-offset: 3px;
}
input:focus-visible, textarea:focus-visible { outline: none; }

.ui-field {
  transition: border-color var(--tx-fast) var(--tx-ease), box-shadow var(--tx-fast) var(--tx-ease),
              background-color var(--tx-fast) var(--tx-ease);
}
.ui-field:focus-within {
  border-color: rgba(240,238,233,.30) !important;
  box-shadow: inset 0 0 0 1px rgba(240,238,233,.035);
}
.ui-safe-top { padding-top: max(18px, var(--tx-safe-top)); }
.ui-safe-bottom { padding-bottom: max(13px, var(--tx-safe-bottom)); }
.ui-hit { min-height: 44px; }
.ui-label {
  color: var(--tx-faint);
  font-size: 9px;
  letter-spacing: .12em;
  line-height: 1.25;
  font-weight: 500;
}
.ui-back {
  width: 42px; height: 42px; display: inline-flex; align-items: center; justify-content: center;
  border-radius: var(--tx-radius-md); color: var(--tx-text);
  background: #080809; border: 1px solid var(--tx-hair); box-shadow: none;
}
.ui-chip { background: #080809; border: 1px solid var(--tx-hair); color: var(--tx-dim); }
.ui-bottom-surface {
  background: rgba(3,3,3,.965);
  border-top: 1px solid var(--tx-hair);
  backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
}
.ui-scroll-pad { padding-bottom: calc(26px + var(--tx-safe-bottom)); }
.no-scrollbar { scrollbar-width: none; }
.no-scrollbar::-webkit-scrollbar { display: none; }

/* Shared v55 surface language. Most hierarchy comes from whitespace and one
   hairline, not from stacked grey cards. */
.tx-screen { background: var(--tx-bg) !important; }
.tx-mode-card, .tx-free-card, .tx-market-card, .tx-level-card, .tx-session-overview,
.tx-equity-card, .tx-recent-session, .tx-empty-sessions {
  box-shadow: none !important;
}
.tx-mode-card:hover, .tx-free-card:hover, .tx-market-card:hover, .tx-recent-session:hover {
  border-color: var(--tx-hair-strong) !important;
  background: #09090A !important;
}
.tx-free-card .tx-dot, .tx-dot { box-shadow: none !important; }

.rounded-2xl { border-radius: 10px !important; }
.rounded-xl { border-radius: 8px !important; }
.rounded-\[22px\], .rounded-\[20px\], .rounded-\[18px\] { border-radius: 10px !important; }
.rounded-\[16px\], .rounded-\[15px\], .rounded-\[14px\], .rounded-\[13px\] { border-radius: 8px !important; }

.tx-auth-wrap, .tx-form-wrap, .tx-form-footer, .tx-profile-wrap { width: 100%; }
.tx-field-control { background: #070708 !important; }
.tx-auth-tabs { background: #060607 !important; }

/* Mobile polish. Keep the app dense, but give the most important sections a
   predictable rhythm. */
@media (max-width: 1023px) {
  .tx-home-header { padding-bottom: 2px; }
  .tx-balance-block { padding-top: 2px; }
  .tx-free-card { background: #070708 !important; }
  .tx-mode-card { background: #070708 !important; }
  .tx-trade-header { min-height: 54px; }
  .tx-trade-main { background: #030303; }
  .tx-trade-panel { background: #050506 !important; }
}

/* ------------------------------- DESKTOP ---------------------------------
   The desktop app is a workstation, not a widened phone. */
@media (min-width: 1024px) {
  body { overflow: hidden; background: #030303; }
  .ui-safe-top { padding-top: 0; }
  .ui-safe-bottom { padding-bottom: 0; }

  /* ------------------------------- lobby -------------------------------- */
  .tx-lobby-shell {
    width: calc(100% - 80px) !important;
    max-width: none !important;
    margin-left: 80px !important;
    margin-right: 0 !important;
    padding: 0 clamp(30px, 3.1vw, 58px) 42px !important;
  }
  .tx-lobby-home {
    width: 100%;
    max-width: 1500px;
    margin: 0 auto;
    display: grid;
    grid-template-columns: minmax(0, 1.38fr) minmax(350px, .82fr);
    grid-template-areas:
      "header header"
      "balance free"
      "actions free"
      "modes level"
      "modes overview"
      "equity recent";
    column-gap: clamp(30px, 2.6vw, 46px);
    row-gap: 12px;
    align-items: stretch;
    padding: 30px 0 0 !important;
  }
  .tx-lobby-home > .tx-desk-full,
  .tx-lobby-home > .tx-desk-half { margin: 0 !important; }

  .tx-home-header {
    grid-area: header;
    min-height: 54px;
    margin-bottom: 8px !important;
    padding: 0 0 16px;
    border-bottom: 1px solid #141416;
  }
  .tx-home-header .tx-round-button {
    width: 36px !important; height: 36px !important; border-radius: 7px !important;
    background: transparent !important; border-color: #18181A !important; box-shadow: none !important;
  }
  .tx-home-header .tx-round-button:hover { background: #09090A !important; }

  .tx-balance-block { grid-area: balance; align-self: end; padding: 14px 0 12px; }
  .tx-balance-block > div:first-child { font-size: 9px !important; letter-spacing: .17em !important; }
  .tx-balance-value {
    font-size: clamp(46px, 4vw, 66px) !important;
    line-height: .98 !important;
    letter-spacing: -.045em !important;
    font-weight: 500 !important;
  }
  .tx-balance-sub { margin-top: 9px !important; font-size: 12px !important; }

  .tx-free-market-block { grid-area: free; min-width: 0; }
  .tx-free-card {
    height: 100%; min-height: 144px; padding: 19px 20px !important;
    border-radius: 9px !important; background: #060607 !important; border-color: #171719 !important;
  }
  .tx-free-card > .flex:first-child { align-items: flex-start !important; }
  .tx-free-card > .flex:last-child { margin-top: 20px !important; padding-top: 13px !important; }
  .tx-free-title { font-size: 22px !important; letter-spacing: -.02em !important; font-weight: 500 !important; }

  .tx-wallet-actions { grid-area: actions; align-self: start; gap: 7px !important; }
  .tx-wallet-action {
    height: 42px !important; min-height: 42px !important; border-radius: 7px !important;
    background: transparent !important; border-color: #171719 !important; box-shadow: none !important;
    justify-content: flex-start !important; padding: 0 13px !important;
  }
  .tx-wallet-action span { font-size: 10px !important; color: var(--tx-dim) !important; }
  .tx-wallet-action svg { width: 14px !important; height: 14px !important; }
  .tx-wallet-action:hover { background: #080809 !important; border-color: #26262A !important; }

  .tx-level-block { grid-area: level; min-width: 0; }
  .tx-level-card {
    height: 100%; margin: 0 !important; padding: 16px 18px !important;
    border-radius: 9px !important; background: #060607 !important; border-color: #171719 !important;
  }
  .tx-level-number { font-size: 29px !important; }
  .tx-level-best { font-size: 14px !important; }

  .tx-mode-list { grid-area: modes; min-width: 0; align-self: stretch; gap: 7px !important; }
  .tx-mode-card {
    min-height: 70px; border-radius: 8px !important; padding: 14px 16px !important;
    background: #060607 !important; border-color: #151517 !important; gap: 0 !important;
  }
  .tx-mode-badge { display: none !important; }
  .tx-mode-card > svg { margin-left: 18px; opacity: .62; }
  .tx-mode-card:hover > svg { opacity: 1; }

  .tx-session-overview {
    grid-area: overview; min-width: 0; margin: 0 !important; padding: 15px 18px !important;
    border-radius: 9px !important; background: #060607 !important; border-color: #171719 !important;
  }
  .tx-session-overview .grid { gap: 16px !important; }
  .tx-session-overview .grid > div + div { border-left: 1px solid #171719; padding-left: 16px; }
  .tx-stat-value { font-size: 16px !important; }

  .tx-equity-block { grid-area: equity; min-width: 0; }
  .tx-recent-block { grid-area: recent; min-width: 0; }
  .tx-notice-block { grid-column: 1 / -1; }
  .tx-equity-block > div:first-child,
  .tx-recent-block > div:first-child { margin-top: 0 !important; margin-bottom: 8px !important; }
  .tx-equity-block > div:last-child {
    padding: 16px 18px !important; border-radius: 9px !important;
    background: #060607 !important; border-color: #171719 !important;
  }
  .tx-equity-block svg { height: 145px !important; }
  .tx-empty-sessions {
    border-radius: 8px !important; background: #060607 !important; border-color: #151517 !important;
  }
  .tx-recent-block > .flex.flex-col { gap: 5px !important; }
  .tx-recent-block > .flex.flex-col > div {
    border-radius: 7px !important; background: transparent !important; border-color: #171719 !important;
    box-shadow: none !important; padding: 11px 12px !important;
  }

  .tx-lobby-shell .tx-in, .tx-lobby-shell .tx-pop {
    animation-name: tx-fade !important; animation-duration: 150ms !important;
  }

  /* ------------------------------ navigation ----------------------------- */
  .tx-lobby-nav {
    position: fixed; left: 0; top: 0; transform: none;
    width: 80px !important; max-width: 80px !important; height: 100vh;
    display: flex !important; flex-direction: column; justify-content: center; gap: 2px;
    padding: 18px 8px !important; border: 0 !important; border-right: 1px solid #141416 !important;
    border-radius: 0 !important; background: #040404; box-shadow: none; backdrop-filter: none;
    -webkit-backdrop-filter: none; z-index: 50;
  }
  .tx-lobby-nav button { min-height: 60px !important; border-radius: 7px; position: relative; }
  .tx-lobby-nav button:hover { background: #09090A; }
  .tx-lobby-nav button.tx-nav-active { background: #080809; }
  .tx-lobby-nav button.tx-nav-active::before {
    content: ""; position: absolute; left: -8px; top: 18px; bottom: 18px; width: 2px;
    background: #D8D3CA;
  }
  .tx-lobby-nav span { font-size: 8px !important; letter-spacing: .075em !important; }

  /* -------------------------- markets / ranking -------------------------- */
  .tx-markets-wrap, .tx-rank-wrap {
    width: calc(100% - 80px) !important; max-width: none !important;
    margin-left: 80px !important; margin-right: auto !important;
    padding: 32px clamp(30px, 3vw, 54px) !important;
  }
  .tx-markets-wrap > *, .tx-rank-wrap > * { max-width: 1450px; margin-left: auto; margin-right: auto; }
  .tx-markets-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px !important; }
  .tx-market-card { background: #060607 !important; border-color: #161618 !important; }

  /* -------------------------- forms / secondary -------------------------- */
  .tx-auth-wrap { max-width: 460px !important; margin-left: auto !important; margin-right: auto !important; }
  .tx-onboarding-wrap { max-width: 500px !important; }
  .tx-auth-actions { max-width: 460px !important; }
  .tx-form-wrap { max-width: 660px !important; margin-left: auto !important; margin-right: auto !important; padding-top: 30px !important; }
  .tx-form-footer { max-width: 660px !important; margin-left: auto !important; margin-right: auto !important; }
  .tx-form-footer.ui-bottom-surface { background: transparent !important; border-top: 0 !important; padding-bottom: 18px !important; }
  .tx-profile-wrap { max-width: 820px !important; margin-left: auto !important; margin-right: auto !important; padding-top: 30px !important; }
  .tx-profile-wrap .rounded-2xl, .tx-form-wrap .rounded-2xl { border-radius: 9px !important; }
  .tx-field-control { border-radius: 9px !important; }
  .tx-auth-tabs { border-radius: 9px !important; }

  /* --------------------------- trading terminal -------------------------- */
  .tx-trade-shell {
    width: 100% !important; max-width: none !important; margin: 0 !important;
    display: grid !important; grid-template-columns: minmax(0, 1fr) 366px;
    grid-template-rows: 58px minmax(0, 1fr) 48px;
    height: 100vh !important; background: #030303; border: 0;
  }
  .tx-trade-header {
    grid-column: 1 / -1; grid-row: 1; min-height: 58px; padding: 0 22px !important;
    border-bottom: 1px solid #151517; background: #040404;
  }
  .tx-trade-header > span { font-size: 10px !important; }
  .tx-trade-main {
    grid-column: 1; grid-row: 2; min-width: 0; min-height: 0;
    overflow-y: auto !important; overflow-x: hidden !important; background: #030303;
  }
  .tx-trade-panel {
    grid-column: 2; grid-row: 2; min-width: 0; min-height: 0; overflow-y: auto;
    padding: 18px !important; border-top: 0 !important; border-left: 1px solid #151517;
    background: #050506 !important;
  }
  .tx-trade-tabs {
    grid-column: 1 / -1; grid-row: 3; border-top-color: #151517 !important; background: #040404 !important;
  }
  .tx-trade-shell:not(:has(.tx-trade-panel)) .tx-trade-main { grid-column: 1 / -1; }
  .tx-trade-settings {
    position: absolute; right: 14px; top: 64px; width: 338px; margin: 0 !important; z-index: 45;
    border-radius: 9px !important; background: #080809 !important;
    box-shadow: 0 20px 70px rgba(0,0,0,.48) !important;
  }
  .tx-trade-panel .tx-sheet { position: relative; }
  .tx-trade-panel button { border-radius: 7px !important; box-shadow: none !important; }
  .tx-trade-panel input { font-size: 16px; }
  .tx-trade-main svg { shape-rendering: geometricPrecision; }
  .tx-price-row { padding: 15px 22px 0 !important; }
  .tx-price-value { font-size: 36px !important; letter-spacing: -.035em !important; }
  .tx-crowd-bar { padding-left: 22px !important; padding-right: 22px !important; }
  .tx-market-metrics {
    padding: 12px 22px 10px !important; gap: 0 !important;
    border-bottom: 1px solid #101012;
  }
  .tx-market-metrics > div { padding-right: 16px; }
  .tx-market-metrics > div + div { border-left: 1px solid #141416; padding-left: 16px; }
  .tx-chart-toolbar { padding: 10px 22px 4px !important; }
  .tx-chart-wrap { padding: 4px 14px 0 !important; }
  .tx-position-strip {
    padding: 9px 22px 12px !important; gap: 0 !important; border-top: 1px solid #101012;
  }
  .tx-position-strip > div { padding-right: 14px; }
  .tx-position-strip > div + div { border-left: 1px solid #141416; padding-left: 14px; }
  .tx-trade-toast { left: 0 !important; right: 366px !important; bottom: 62px !important; }
  .tx-trade-toast > div { border-radius: 7px !important; background: #080809 !important; }
  .tx-order-actions button { height: 58px !important; border-radius: 8px !important; }

  .ui-back { width: 40px; height: 40px; }
}

@media (min-width: 1280px) {
  .tx-lobby-home { grid-template-columns: minmax(0, 1.42fr) minmax(370px, .78fr); }
  .tx-trade-shell { grid-template-columns: minmax(0, 1fr) 378px; }
  .tx-trade-toast { right: 378px !important; }
}

@media (min-width: 1600px) {
  .tx-lobby-shell, .tx-markets-wrap, .tx-rank-wrap { padding-left: 54px !important; padding-right: 54px !important; }
  .tx-trade-shell { grid-template-columns: minmax(0, 1fr) 392px; }
  .tx-trade-settings { width: 362px; }
  .tx-trade-toast { right: 392px !important; }
}

@media (min-width: 1024px) and (max-height: 760px) {
  .tx-lobby-home { padding-top: 18px !important; row-gap: 9px; }
  .tx-home-header { min-height: 42px; margin-bottom: 0 !important; padding-bottom: 11px; }
  .tx-balance-block { padding-top: 2px; padding-bottom: 5px; }
  .tx-balance-value { font-size: 43px !important; }
  .tx-free-card { min-height: 126px; padding: 14px 16px !important; }
  .tx-free-card > .flex:last-child { margin-top: 10px !important; padding-top: 10px !important; }
  .tx-level-card { padding: 13px 15px !important; }
  .tx-level-card .mt-4 { margin-top: 9px !important; }
  .tx-mode-card { min-height: 64px; padding: 11px 14px !important; }
  .tx-session-overview { padding: 12px 15px !important; }
  .tx-equity-block > div:last-child { padding: 12px 15px !important; }
  .tx-equity-block svg { height: 106px !important; }
  .tx-lobby-nav button { min-height: 54px !important; }
}

@media (hover: hover) and (pointer: fine) {
  button:not(:disabled) { cursor: pointer; }
  .tap {
    transition: transform var(--tx-fast) var(--tx-ease), filter var(--tx-fast) var(--tx-ease),
                border-color var(--tx-fast) var(--tx-ease), background-color var(--tx-fast) var(--tx-ease),
                color var(--tx-fast) var(--tx-ease), opacity var(--tx-fast) var(--tx-ease);
  }
  .tap:hover { filter: brightness(1.045); }
  .tap:active { transform: scale(.995); }
}

@keyframes tx-fade-up { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
@keyframes tx-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes tx-pop { from { opacity: 0; transform: scale(.982); } to { opacity: 1; transform: scale(1); } }
@keyframes tx-draw { from { stroke-dashoffset: var(--len); } to { stroke-dashoffset: 0; } }
@keyframes tx-sheet { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
@keyframes tx-spin { to { transform: rotate(360deg); } }
@keyframes tx-slide-in { from { opacity: 0; transform: translateX(14px); } to { opacity: 1; transform: none; } }
@keyframes tx-slide-back { from { opacity: 0; transform: translateX(-14px); } to { opacity: 1; transform: none; } }
.tx-screen { animation: tx-fade-up var(--tx-slow) var(--tx-ease) both; }
.tx-in { animation: tx-fade-up var(--tx-mid) var(--tx-ease) both; }
.tx-fade { animation: tx-fade var(--tx-mid) var(--tx-ease) both; }
.tx-pop { animation: tx-pop var(--tx-mid) var(--tx-ease) both; }
.tx-sheet { animation: tx-sheet var(--tx-mid) var(--tx-ease) both; }
.tx-dot { opacity: .88; }
.tx-spin { animation: tx-spin 8s linear infinite; }
.tx-line { stroke-dasharray: var(--len); animation: tx-draw .55s ease-out both; }
.tx-slide { animation: tx-slide-in .34s var(--tx-ease) both; }
.tx-slide-back { animation: tx-slide-back .34s var(--tx-ease) both; }
.tap {
  transition: transform var(--tx-fast) var(--tx-ease), opacity var(--tx-fast) var(--tx-ease),
              background-color var(--tx-fast) var(--tx-ease), color var(--tx-fast) var(--tx-ease),
              border-color var(--tx-fast) var(--tx-ease);
}
.tap:active { transform: scale(.988); opacity: .94; }
button:not(:disabled):active { transform: scale(.996); }
button:disabled { opacity: .30; }

@media (prefers-reduced-motion: reduce) {
  .tx-screen,.tx-in,.tx-fade,.tx-pop,.tx-sheet,.tx-dot,.tx-line,.tx-spin,
  .tx-slide,.tx-slide-back { animation: none !important; }
  * { scroll-behavior: auto !important; }
}
`;

if (typeof document !== "undefined" && !document.getElementById("tx-css")) {
  const tag = document.createElement("style");
  tag.id = "tx-css";
  tag.textContent = GLOBAL_CSS;
  document.head.appendChild(tag);
}

const stagger = (i) => ({ animationDelay: `${i * 38}ms` });

export { GLOBAL_CSS, stagger };
