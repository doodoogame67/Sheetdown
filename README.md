# Sheetdown

Firefox extension that replaces the Pokemon Showdown UI (play.pokemonshowdown.com and *.psim.us)
with a spreadsheet, and runs a Showdex-style damage calculator inside it.

## Install

Firefox only runs signed extensions permanently. Pick one:

1. Quick test (removed when Firefox restarts): `about:debugging#/runtime/this-firefox` ->
   "Load Temporary Add-on..." -> select `sheetdown.xpi` (or `dist/manifest.json`).
2. Permanent, regular Firefox: sign it yourself for free as an unlisted add-on.
   Get API keys at https://addons.mozilla.org/developers/addon/api/key/ then:
   `npx web-ext sign -s dist --channel unlisted --api-key=... --api-secret=...`
   Install the signed .xpi it downloads by dragging it onto a Firefox window.
3. Firefox Developer Edition / Nightly / ESR: set `xpinstall.signatures.required` to `false`
   in `about:config`, then drag `sheetdown.xpi` onto the window.

## Use

- Summary sheet: pick a format, double-click Find. Team formats use teams you already saved in
  Showdown's teambuilder (open it with Alt+Shift+S).
- Each battle opens as its own sheet tab. Click (or Enter) a move's damage cell to use that
  move on that target; double-click a Switch cell to switch. Tera/Mega/Dynamax are TRUE/FALSE cells.
- Formula bar + Enter sends chat or commands (`/timer on`) to the current battle.
- Alt+Shift+S: toggle the real Showdown UI. Alt+Shift+Q: panic sheet with fake budget numbers.

## Calculator

Uses @smogon/calc (same engine as Showdex). Your side uses exact stats from the server.
Opponent sets are filled from pkmn.github.io presets (randbats roles or Smogon sets), picking the
set that best matches revealed moves; revealed item/ability/tera override the preset.
Shows damage ranges and KO chances both directions, speed vs the opponent's full speed range,
weather, terrain, screens, tailwind, boosts, status, Ruin abilities, Protosynthesis/Quark Drive.

## Build

    npm install
    node build.mjs        # writes dist/
