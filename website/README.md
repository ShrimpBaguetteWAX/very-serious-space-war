# Very Serious Space War — map viewer

Reads the `map` table from the `veryseriousx` contract on WAX mainnet and draws
the stored grid.

## Run

```powershell
powershell -ExecutionPolicy Bypass -File .\serve.ps1
```

Then open http://127.0.0.1:4321/ — pass `-port NNNN` to serve.ps1 to change it.

It has to be served over `http://`. Opening `index.html` from disk fails twice
over: WharfKit loads as an ES module (blocked by the `file://` origin) and the
WAX RPC calls need a real origin for CORS.

## What is on the page

- **Wallet** — WAX Cloud or Anchor via WharfKit. The session is restored on
  reload. Reading the map signs nothing; the wallet only identifies you.
- **Endpoint picker** — the ten endpoints are probed in parallel on load with the
  exact request the app makes (POST + `application/json`, so the CORS preflight
  is exercised). Only nodes that answered are listed, sorted by round trip. The
  choice persists in `localStorage`; the status dot re-probes on click.
- **Map** — pan by dragging, zoom with the wheel or the `+ / −` buttons, `Fit` to
  reset. **Chunks** overlays the 10 × 10 chunk boundaries.
- **Refresh** — re-reads the whole table through the current endpoint.
- **Chunk inspector** — click any tile to see the chunk holding it, its
  `grid_index`, and the chunk laid out in `tile_info` order with the clicked tile
  marked. This is the quickest way to confirm the contract stored the tiles in
  the order it was meant to.

## How the map is decoded

The contract stores 10 × 10 chunks keyed by `row * 10000 + column` of the
chunk's top-left tile, with `tile_info` in row-major order — `[0]` is the
top-left tile, `[99]` the bottom-right.

Nothing in `app.js` hard-codes 200 × 200 or a chunk size of 10. The chunk size
comes from `tile_info.length` and the map extent from the largest `grid_index`
present, so a contract that later stores a different map size still renders.

One consequence: if `createmap` ever stops exactly on a chunk-row boundary, the
derived extent shrinks with it rather than showing voids — the **Grid** figure is
the tell (200 × 180 instead of 200 × 200). A run that stops mid-row does show the
gap, both as voids on the map and as a warning under the stats.

## How value is drawn

**Not with colour.** The map is a circuit board and each tile is a node on it;
value is how far that node is energised, strictly cumulatively:

| v | | |
|---|---|---|
| 1 | Dark | nothing drawn at all |
| 2 | Trace | a dim core |
| 3 | Circuit | + short traces off the core |
| 4 | Wired | traces run to the cell edge, ink at full brightness |
| 5 | Nexus | + containment ring |

Because a wired node runs its traces all the way to the cell boundary, two
adjacent ones meet and form a continuous run of light — rich regions draw
themselves as circuit networks with nothing in the code asking them to.

Worth reads as *more light, more connection*, not as a hue and not as a numeral.
Colour stays free for ownership and factions, and the map still works for a
colour-blind player.

## Rendering

Two levels of detail, and only what is on screen is ever touched.

`visibleRange()` gives the on-screen tile rectangle. Above `DETAIL_MIN_SCALE`
(9px per tile) the renderer lays the deck and lattice down in bulk for the whole
visible slab — they are identical on every cell — then every visible node writes
its geometry into a handful of shared `Path2D` buckets. The frame is lit in **9
draw calls regardless of tile count**: a glow is a wide dim stroke under a narrow
bright one, and doing that per tile would be thousands of state changes a frame.
`v = 1` writes nothing, which is 41% of the live map for free.

Below that threshold, or above a hard 14,000-tile ceiling (a 4K window at the
same zoom is triple the work), it blits a 1px-per-tile bitmap instead — and only
the visible slice of it. That bitmap is the amount of light a node *would* put out, blurred slightly so neighbouring rich tiles pool into one halo. It is an
honest mipmap of the near view rather than a second encoding: what glows zoomed
out is what is densely built zoomed in.

Renders are coalesced into one `requestAnimationFrame` — `pointermove` fires far
more often than the display refreshes, and without it a drag queues several full
redraws per frame and throws most of them away.

The deck palette is defined once as `--deck` / `--ink` in `styles.css` and read
back at boot, so the map, the legend swatches and the inspector cannot drift
apart. `--deck-void` is *no chunk stored*.
