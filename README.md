# Very Serious Space War

On a scale of 1 to serious — it's probably very.

A territory-control game on WAX. This repository holds the **map viewer**: the
site served at
[shrimpbaguettewax.github.io/very-serious-space-war](https://shrimpbaguettewax.github.io/very-serious-space-war/).

The contract it reads is `veryseriousx` on WAX mainnet. Its source lives in a
separate private repository; the deployed ABI and code are readable from the
chain like any other account's.

## Running it locally

```powershell
powershell -ExecutionPolicy Bypass -File .\website\serve.ps1
```

Then open http://127.0.0.1:4321/.

It has to be served over `http://` — opening `index.html` from disk fails twice
over, since WharfKit loads as an ES module (blocked by the `file://` origin) and
the WAX RPC calls need a real origin for CORS.

There is no build step. The site is plain HTML, CSS and one ES module; WharfKit
comes from esm.sh at runtime through the import map. That is also why the Pages
workflow installs nothing — it uploads `website/` as it stands.

## What is in here

- `website/` — the site. [Its README](website/README.md) covers the wallet and
  endpoint handling, how the map is decoded from the contract's chunk layout,
  why value is drawn as light rather than colour, and how the renderer keeps a
  40,000-tile map to nine draw calls a frame.
- `.github/workflows/pages.yml` — the deploy. Pages can only serve a repo's root
  or its `/docs`, and the site lives in `website/`, so it publishes through
  Actions rather than renaming the folder to suit the host.

## A note on the economy

The viewer reimplements the contract's `effective_power` so it can quote what an
attack will cost before sending it. Those two must agree to the unit, or the
panel offers an attack the chain rejects and the player sees a failure with no
visible cause.

The harness that proves it (`tools/parity.js`) lives with the contract, since it
needs both sides. It reads this repository's `app.js` from a sibling checkout.
