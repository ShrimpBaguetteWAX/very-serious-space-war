// Very Serious Space War — sector chart
//
// WharfKit is ESM-only (no UMD build, no `window.Wharf`), which is why this file
// must load with <script type="module">. Bare specifiers resolve through the
// import map in index.html.

import { SessionKit, Chains } from '@wharfkit/session'
import WebRenderer from '@wharfkit/web-renderer'
import { WalletPluginAnchor } from '@wharfkit/wallet-plugin-anchor'
import { WalletPluginCloudWallet } from '@wharfkit/wallet-plugin-cloudwallet'

// ── Config ────────────────────────────────────────────────────────────────

// Carried over from the SpaceyShooty site, where each of these was verified from
// a browser with the exact request this app makes: POST /v1/chain/get_table_rows
// with `Content-Type: application/json`, which triggers a CORS preflight. That
// distinction matters — several nodes answer GET with `access-control-allow-
// origin: *` but do not handle the OPTIONS preflight, so a server-side probe
// passes them and the browser still refuses.
//
// Known-good from curl but REJECTED by the browser, do not re-add without
// retesting in a browser: wax.greymass.com, wax.eu.eosamsterdam.net,
// hyperion.wax.eosrio.io, wax-public.neftyblocks.com, api.wax.greeneosio.com.
const ENDPOINTS = [
    'https://wax.blacklusion.io',
    'https://api.waxsweden.org',
    'https://wax.eosdac.io',
    'https://wax.api.eosnation.io',
    'https://waxapi.ledgerwise.io',
    'https://api.wax.bountyblok.io',
    'https://api.hivebp.io',
    'https://wax.eosphere.io',
    'https://wax.eosusa.io',
    'https://api.wax.detroitledger.tech',
]

const STORAGE_KEY = 'vssw.endpoint'

function initialEndpoint() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY)
        if (saved && ENDPOINTS.includes(saved)) return saved
    } catch { /* storage can be blocked; fall through */ }
    return ENDPOINTS[0]
}

const CHAIN = { id: Chains.WAX.id, url: initialEndpoint() }
const CONTRACT = 'veryseriousx'
const APP_NAME = 'Very Serious Space War'

// The contract stores the grid as chunks keyed by (row * 10000 + column) of the
// chunk's top-left tile. Nothing else in this file assumes a 200x200 map or a
// 10x10 chunk — both are derived from what the table actually returns.
const INDEX_STRIDE = 10000

// 400 chunks of 100 tiles is ~500KB of JSON. Asking for all of it in one request
// is what makes a node time out or truncate, so it is paged and stitched.
// The board is 400 chunks, and a node returns all 400 in one response - 575KB
// in about the same wall time it took to answer a page of 100, so four requests
// were four round trips bought for nothing. The loop below still follows `more`,
// so a node that caps the limit lower just pages as it used to.
const PAGE_ROWS = 400
const MAX_PAGES = 40     // 16,000 chunks; a runaway `more` flag cannot spin forever

// A node that has started refusing needs to be left alone, not hammered.
const RATE_LIMIT_PAUSE_MS = 60000

// How often the map view asks whether anything has happened. This is the cheap
// question - the roster, a few hundred bytes - not the expensive one.
const MAP_POLL_MS = 5000

// And the floor on how often it acts on the answer. Re-reading the board is
// 575KB, so a busy game where somebody moves every few seconds must not turn
// into 575KB every few seconds.
const MAP_RELOAD_MIN_MS = 15000

// A transaction that is accepted is not a row you can read yet - the block has
// to land. Poll for the row rather than guessing a fixed delay.
const SPAWN_CONFIRM_MS = 25000
const SPAWN_POLL_MS = 1500

// Mirrors POWER_SCALE in the contract. Banked power is held at 100x so the
// figure on screen moves every second rather than every twentieth.
const POWER_SCALE = 100

// Mirrors SPAWN_GRACE_SECONDS. Inside this many seconds of a launch, the
// contract banks an arrival from the launch rather than from when they signed,
// so the opening minute is a race against each other rather than against the
// clock. Shown, not enforced, on this side.
const SPAWN_GRACE_SECONDS = 60

// Mirrors NEUTRAL_TILE_COST. What an unclaimed tile charges per point of its
// value in the game's FIRST minute — v=1 costs 25, v=5 costs 125 — with that
// much again added for every minute the game has been running. Must match the
// contract or the attack panel quotes a price the chain will not honour.
const NEUTRAL_TILE_COST = 25
const NEUTRAL_COST_PER_MINUTE_DIVISOR = 60

// Mirrors INTEREST_PER_CENT_DIVISOR. Interest compounds once a second; the RATE
// is a config value, not a constant — see economy() below.
const INTEREST_PER_CENT_DIVISOR = 100

// Browser clocks drift; banked power is measured against chain time.
const CLOCK_SYNC_MS = 120000

const MIN_SCALE = 0.25
const MAX_SCALE = 64

// Pixels per tile the map opens at. Comfortably above DETAIL_MIN_SCALE, so a
// node's full circuit is drawn the moment the page lands rather than the
// simplified core.
const DEFAULT_SCALE = 17

// Pixels per tile below which the per-tile renderer is dropped for the density
// blit. Under this a node's traces are sub-pixel, so the detail is invisible and
// the draw calls are pure cost.
const DETAIL_MIN_SCALE = 9

// A hard ceiling on top of that. Measured against the live map's distribution,
// a node averages a handful of path segments, so this keeps a frame bounded.
// The scale threshold alone is not enough: it is a per-tile limit and the tile
// COUNT is what actually costs, so a 4K window at the same zoom would be three
// times the work.
const DETAIL_MAX_TILES = 14000

// ── Session ───────────────────────────────────────────────────────────────

const sessionKit = new SessionKit({
    appName: APP_NAME,
    chains: [CHAIN],
    ui: new WebRenderer(),
    walletPlugins: [new WalletPluginCloudWallet(), new WalletPluginAnchor()],
})

const state = {
    session: null,
    account: null,

    // The selected games_t row, and the list behind the lobby. A game IS a
    // scope on chain, so until one is picked there is no map to read - every
    // map and players query below is scoped by state.game.game_name.
    game: null,
    games: [],
    config: null,      // one row: how often a game starts, how long it is kept
    tracking: null,    // one row: when the last game started, next game's name

    chunks: [],        // raw rows from the `map` table
    cells: null,       // Uint8Array, width * height, 0 = no chunk stored
    codes: null,       // Uint16Array of the `c` field, same layout
    width: 0,
    height: 0,
    chunkSize: 10,     // derived from tile_info.length
    counts: [0, 0, 0, 0, 0, 0],   // tally per value, index 0 = void
    selected: null,    // {row, col} of the clicked tile
    healthy: [],

    // color_id -> { hex, ink, names[] }. A tile's `c` IS its owner's color_id;
    // that is the only tile-to-owner link there is, since the players table
    // stores no coordinates.
    byColor: new Map(),
    players: [],

    // Set while a captured region is being played back onto the map. Null the
    // rest of the time, which is the fast path every draw checks first.
    reveal: null,

    // One entry per named holding: where to write the owner's name and how much
    // room there is for it. Rebuilt only when the map changes.
    labels: [],
}

// Value is NOT carried by colour. The map is a circuit board and every tile is a
// node on it; a higher value is a node energised further — dark cell, a dim core,
// a core running short traces, a node wired all the way into the grid, and
// finally a nexus under full load. Strictly cumulative: every tier keeps what the
// one below it had. Worth reads as "more light, more
// connection", not as a different hue and not as a number, which keeps colour
// free for ownership and factions and keeps the map legible for a colour-blind
// player.
// How much light a fully drawn node puts out, per value. The far-zoom bitmap is
// literally this, so the two levels of detail agree: a region that looks bright
// zoomed out is the region that is densely built when you zoom in.
const INK_DENSITY = [0, .05, .20, .38, .60, .92]

// Read out of CSS once at boot so the map and the minimap cannot drift apart.
const MAT = {}

// Tolerant on purpose. The CSS tokens are always `#rrggbb`, but hex_color comes
// off chain and the contract accepts 6 or 8 digits with the `#` optional, so
// this has to take all four shapes.
function hexToRgb(hex) {
    const s = String(hex || '').replace('#', '')
    if (s.length < 6) return [0, 0, 0]
    return [
        parseInt(s.slice(0, 2), 16),
        parseInt(s.slice(2, 4), 16),
        parseInt(s.slice(4, 6), 16),
    ]
}

// A player's colour, expanded into the same three inks the map material uses, so
// an owned node is drawn by exactly the same routine as an unowned one.
function inkFromHex(hex) {
    const [r, g, b] = hexToRgb(hex)
    const lift = (t) => `rgb(${Math.round(r + (255 - r) * t)}, ` +
                        `${Math.round(g + (255 - g) * t)}, ` +
                        `${Math.round(b + (255 - b) * t)})`
    return {
        rgb: [r, g, b],
        ink: `rgb(${r}, ${g}, ${b})`,
        inkHot: lift(.55),
        inkDim: `rgb(${Math.round(r * .55)}, ${Math.round(g * .55)}, ${Math.round(b * .55)})`,
    }
}

function readPalette() {
    const styles = getComputedStyle(document.documentElement)
    const get = (name) => styles.getPropertyValue(name).trim()
    MAT.deck = get('--deck')
    MAT.deckLine = get('--deck-line')
    MAT.void = get('--deck-void')
    MAT.ink = get('--ink')
    MAT.inkHot = get('--ink-hot')
    MAT.inkDim = get('--ink-dim')
    MAT.bloom = get('--ink-bloom')

    MAT.deckRgb = hexToRgb(MAT.deck || '#000000')
    MAT.inkRgb = hexToRgb(MAT.ink || '#ffffff')
}

// One node's geometry, appended to shared Path2D buckets rather than drawn.
//
// Everything on this map is a line of light, and light is expensive to fake per
// object: a glow is a wide dim stroke under a narrow bright one, which is two
// state changes and two strokes. Doing that per tile would be thousands of state
// changes a frame. Instead every visible node writes its geometry into a handful
// of shared paths, and the whole frame is lit with about six strokes total.
//
// `v = 1` writes nothing at all. A dark cell should look dark, and it is 41% of
// the live map — the single biggest saving in the renderer.
function traceNode(paths, px, py, s, v) {
    if (v < 2) return

    const cx = px + s / 2
    const cy = py + s / 2
    const unit = s / 2

    // Under ~15px the ring and the traces collapse into a smudge, so the node
    // degrades to a single mark whose size carries the value instead.
    if (s < 15) {
        const r = s * (.09 + .038 * v)
        const p = v >= 4 ? paths.hot : paths.dim
        p.moveTo(cx + r, cy)
        p.arc(cx, cy, r, 0, Math.PI * 2)
        return
    }

    const core = unit * (.15 + .038 * v)

    // Traces. From `4` up the node is wired into the grid: the spurs run all the
    // way to the cell edge, so two adjacent wired nodes meet at the boundary and
    // form one continuous run of light. Rich regions draw themselves as circuit
    // networks with no logic asking them to.
    if (v >= 3) {
        const reach = v >= 4 ? unit : unit * .58
        const p = v >= 4 ? paths.traceHot : paths.trace
        p.moveTo(cx - core, cy); p.lineTo(cx - reach, cy)
        p.moveTo(cx + core, cy); p.lineTo(cx + reach, cy)
        p.moveTo(cx, cy - core); p.lineTo(cx, cy - reach)
        p.moveTo(cx, cy + core); p.lineTo(cx, cy + reach)
    }

    // Containment ring, top tier only. The build-out has to be strictly
    // cumulative or the read breaks: an earlier draft gave `2` a ring that `3`
    // then lost, and a tier that takes an element away does not look like more.
    // A nexus is core + traces + ring, every rung of the ladder still present.
    if (v >= 5) {
        const r = unit * .74
        paths.ringHot.moveTo(cx + r, cy)
        paths.ringHot.arc(cx, cy, r, 0, Math.PI * 2)
    }

    // The core, a rotated square — machined, not organic.
    const p = v >= 4 ? paths.hot : (v === 2 ? paths.dim : paths.mid)
    p.moveTo(cx, cy - core)
    p.lineTo(cx + core, cy)
    p.lineTo(cx, cy + core)
    p.lineTo(cx - core, cy)
    p.closePath()
}

const newPaths = () => ({
    trace: new Path2D(), traceHot: new Path2D(),
    ringHot: new Path2D(),
    dim: new Path2D(), mid: new Path2D(), hot: new Path2D(),
})

// Lights the buckets. Each pass is a wide dim stroke for the bloom, then the
// mark itself on top — the whole frame in a fixed number of draws, whether there
// are ten nodes on screen or ten thousand.
function paintPaths(g, paths, s, ink = MAT) {
    const w = Math.max(1, s * .05)
    g.lineCap = 'round'

    // Bloom.
    g.strokeStyle = ink.ink
    g.globalAlpha = .12
    g.lineWidth = w * 4
    g.stroke(paths.traceHot)
    g.stroke(paths.ringHot)
    g.stroke(paths.hot)

    // Traces.
    g.globalAlpha = .32
    g.lineWidth = w
    g.strokeStyle = ink.inkDim
    g.stroke(paths.trace)

    g.globalAlpha = .8
    g.strokeStyle = ink.ink
    g.stroke(paths.traceHot)

    // Nexus rings.
    g.globalAlpha = .75
    g.lineWidth = Math.max(1, w * .8)
    g.strokeStyle = ink.ink
    g.stroke(paths.ringHot)

    // Cores, dimmest tier to brightest.
    g.globalAlpha = .5
    g.fillStyle = ink.inkDim
    g.fill(paths.dim)

    g.globalAlpha = .85
    g.fillStyle = ink.ink
    g.fill(paths.mid)

    g.globalAlpha = 1
    g.fillStyle = ink.inkHot
    g.fill(paths.hot)
}

// ── DOM ───────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id)

const loginScreen = $('loginScreen')
const mapScreen = $('mapScreen')
const statusMessage = $('statusMessage')
const statusDot = $('statusDot')
const waxCloudBtn = $('waxCloudBtn')
const anchorBtn = $('anchorBtn')
const connectWalletBtn = $('connectWalletBtn')

// Topbar, not lobby: it is the way OUT of a sector, so it lives with the other
// chrome and is declared with it.
const lobbyBtn = $('lobbyBtn')

const endpointSelect = $('endpointSelect')
const endpointDot = $('endpointDot')
const endpointPing = $('endpointPing')

const canvasWrap = $('canvasWrap')
const canvas = $('mapCanvas')
const canvasCtx = canvas.getContext('2d')

// The scene — everything except the two cursor outlines — is painted into an
// offscreen copy and blitted from there. It only needs repainting when the view
// or the data changes, which is what makes hovering cheap: moving the pointer
// used to rebuild the deck, the lattice, every node, every territory with its
// blurred outline, every label AND the minimap, at pointer-event rate, purely to
// move a one-tile box.
const scene = document.createElement('canvas')
const sceneCtx = scene.getContext('2d')

// Labels live on their own surface rather than in the scene, because they and
// the map go stale for completely different reasons.
//
// The map changes when the view or the data changes. The labels change for that
// too, but ALSO every second, because the banked figure under each name climbs.
// With one layer that second-by-second update was retracing every visible tile —
// up to 14,000 of them, fourteen path operations each — to move a few digits.
//
// Two layers, and the tick repaints text onto a transparent sheet and blits it
// over a map nobody touched. Compositing is source-over either way, so the
// result is pixel-for-pixel what drawing straight onto the scene produced.
const labelLayer = document.createElement('canvas')
const labelCtx = labelLayer.getContext('2d')

// Whichever surface is being painted right now. Every draw routine writes
// through this, so redirecting it at the offscreen canvas needs no other change.
let ctx = canvasCtx
let sceneDirty = true
let labelsDirty = true

const mapOverlay = $('mapOverlay')
const overlayText = $('overlayText')

const zoomInBtn = $('zoomInBtn')
const zoomOutBtn = $('zoomOutBtn')
const zoomRead = $('zoomRead')
const fitBtn = $('fitBtn')

const hud = $('hud')
const hudRow = $('hudRow'), hudCol = $('hudCol')
const hudOwner = $('hudOwner')
const namesBtn = $('namesBtn')

const refreshBtn = $('refreshBtn')
const gapWarning = $('gapWarning')
const minimap = $('minimap')
const minimapCtx = minimap.getContext('2d')

const cmdState = $('cmdState')
const cmdActive = $('cmdActive')
const cmdDeploy = $('cmdDeploy')
const cmdSwatch = $('cmdSwatch')
const cmdName = $('cmdName')
const cmdPower = $('cmdPower')
const cmdScore = $('cmdScore')
const cmdTiles = $('cmdTiles')
const cmdBank = $('cmdBank')
const cmdBankBar = $('cmdBankBar')
const cmdBankCap = $('cmdBankCap')
const cmdBankRate = $('cmdBankRate')

const attackPanel = $('attackPanel')
const atkState = $('atkState')
const atkTarget = $('atkTarget')
const atkControls = $('atkControls')
const atkPower = $('atkPower')
const atkPowerRead = $('atkPowerRead')
const atkHint = $('atkHint')
const attackBtn = $('attackBtn')

const cmdUsername = $('cmdUsername')
const cmdTile = $('cmdTile')
const cmdTilePower = $('cmdTilePower')
const cmdHint = $('cmdHint')
const spawnBtn = $('spawnBtn')

const toastEl = $('errorToast')

// ── Feedback ──────────────────────────────────────────────────────────────

let toastTimer
function toast(message, kind, { sticky = false } = {}) {
    toastEl.textContent = message
    toastEl.className = `toast is-${kind}`
    toastEl.hidden = false
    clearTimeout(toastTimer)
    if (!sticky) toastTimer = setTimeout(() => { toastEl.hidden = true }, 5000)
}
const showError = (m) => toast(m, 'error')
const showInfo = (m) => toast(m, 'info')
// Sticky: a pending toast has to outlive the confirmation wait, so it is
// replaced by the outcome rather than timed out from under it.
const showPending = (m) => toast(m, 'pending', { sticky: true })
const hideToast = () => { toastEl.hidden = true }

function setStatus(message, kind = '') {
    statusMessage.textContent = message
    statusDot.className = `dot${kind ? ` is-${kind}` : ''}`
}

function isUserCancel(error) {
    const m = String(error?.message ?? '').toLowerCase()
    return m.includes('cancel') || m.includes('rejected') || m.includes('closed')
}

// Antelope buries the useful text a few levels down.
function readableError(error) {
    const detail = error?.details?.[0]?.message
        ?? error?.error?.details?.[0]?.message
        ?? error?.message
        ?? 'Unknown error'
    return String(detail).replace(/^assertion failure with message:\s*/i, '')
}

// ── Endpoint picker ───────────────────────────────────────────────────────

const hostOf = (url) => url.replace(/^https?:\/\//, '')
const PROBE_TIMEOUT = 4000

// Probe with the exact request the app makes — POST + application/json, which
// forces a CORS preflight. A bare GET would pass on nodes the browser later
// refuses, which is how a dead endpoint ends up in the list.
async function probeEndpoint(url, timeoutMs = PROBE_TIMEOUT) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    const t0 = performance.now()
    try {
        const res = await fetch(`${url}/v1/chain/get_table_rows`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                // `colors` rather than `map`: the map lives in a per-game scope
                // now, so reading it at the contract's own scope proves nothing
                // about the node. colors is contract-wide and has been there
                // since before any of this, so a probe against it also survives
                // the deploy that introduces the games tables.
                json: true, code: CONTRACT, scope: CONTRACT, table: 'colors', limit: 1,
            }),
            signal: ctrl.signal,
        })
        if (!res.ok) return null
        const data = await res.json()
        if (!Array.isArray(data.rows)) return null
        return { url, ms: Math.round(performance.now() - t0) }
    } catch {
        return null
    } finally {
        clearTimeout(timer)
    }
}

const probeAll = async () =>
    (await Promise.all(ENDPOINTS.map((u) => probeEndpoint(u))))
        .filter(Boolean)
        .sort((a, b) => a.ms - b.ms)

function pingClass(ms) {
    return 'endpoint-ping ' + (ms < 250 ? 'is-fast' : ms < 700 ? 'is-mid' : 'is-slow')
}

function showPing(ms) {
    endpointDot.className = 'net-dot'
    endpointPing.textContent = `${ms}ms`
    endpointPing.className = pingClass(ms)
}

// Only healthy nodes are listed — offering one that is down just invites a
// failed switch.
// A native select shows its chosen option's text when closed, so a latency in
// the option label is the same number as the readout beside it - printed twice,
// a foot apart. The selected option therefore drops its figure and lets the
// coloured readout carry it; the others keep theirs, since comparing them is
// the entire reason for opening the list.
function labelEndpoints() {
    for (const o of endpointSelect.options) {
        const host = hostOf(o.value)
        o.textContent = o.value === CHAIN.url ? host : `${host} · ${o.dataset.ms}ms`
    }
}

function buildEndpointList(healthy) {
    endpointSelect.innerHTML = ''
    for (const { url, ms } of healthy) {
        const o = document.createElement('option')
        o.value = url
        // Kept on the element so relabelling never has to go looking for the
        // measurement again.
        o.dataset.ms = String(ms)
        endpointSelect.appendChild(o)
    }
    endpointSelect.value = CHAIN.url
    labelEndpoints()
    endpointSelect.disabled = healthy.length < 2
    endpointSelect.title = `${healthy.length} of ${ENDPOINTS.length} endpoints responding`
}

function applyEndpoint(url) {
    CHAIN.url = url
    try {
        sessionKit.setEndpoint(CHAIN.id, url)   // signing follows reads
    } catch (error) {
        console.error('setEndpoint failed:', error)
    }
}

// Picks the fastest responding node on load. A node chosen by hand wins if it is
// still healthy, so an explicit choice is not overridden every reload.
async function initEndpoints() {
    endpointDot.className = 'net-dot is-checking'
    endpointPing.textContent = '···'
    endpointPing.className = 'endpoint-ping'
    endpointSelect.innerHTML = '<option>checking…</option>'
    endpointSelect.disabled = true

    const healthy = await probeAll()
    state.healthy = healthy

    if (!healthy.length) {
        endpointSelect.innerHTML = '<option>no endpoint</option>'
        endpointDot.className = 'net-dot is-down'
        endpointPing.textContent = 'offline'
        endpointPing.className = 'endpoint-ping is-slow'
        showError('No RPC endpoint responded. Check your connection and reload.')
        return
    }

    let preferred = null
    try { preferred = localStorage.getItem(STORAGE_KEY) } catch { /* blocked */ }

    const chosen = healthy.find((h) => h.url === preferred) ?? healthy[0]
    applyEndpoint(chosen.url)
    buildEndpointList(healthy)
    showPing(chosen.ms)

    const down = ENDPOINTS.length - healthy.length
    console.log(
        `Endpoints: ${healthy.length}/${ENDPOINTS.length} up` +
        (down ? ` (${down} hidden)` : '') +
        ` — using ${hostOf(chosen.url)} at ${chosen.ms}ms`,
    )
}

endpointSelect.addEventListener('change', async () => {
    applyEndpoint(endpointSelect.value)
    labelEndpoints()
    try { localStorage.setItem(STORAGE_KEY, CHAIN.url) } catch { /* non-fatal */ }

    endpointDot.className = 'net-dot is-checking'
    endpointPing.textContent = '···'

    const result = await probeEndpoint(CHAIN.url)
    if (!result) {
        endpointDot.className = 'net-dot is-down'
        endpointPing.textContent = 'down'
        endpointPing.className = 'endpoint-ping is-slow'
        showError(`${hostOf(CHAIN.url)} stopped responding — pick another.`)
        return
    }

    const opt = [...endpointSelect.options].find((o) => o.value === CHAIN.url)
    if (opt) opt.dataset.ms = String(result.ms)

    showPing(result.ms)
    showInfo(`Switched to ${hostOf(CHAIN.url)} (${result.ms}ms)`)

    // A fresh node clears any pause the old one imposed, then the map is re-read
    // through it — otherwise the switch looks like it did nothing.
    rateLimitedUntil = 0
    if (state.session) await loadMap()
})

// Re-probe on demand; also recovers the list if endpoints came back.
endpointDot.addEventListener('click', (e) => {
    e.preventDefault()
    initEndpoints()
})
endpointDot.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); initEndpoints() }
})

// ── Chain reads ───────────────────────────────────────────────────────────

let rateLimitedUntil = 0
const isRateLimited = () => Date.now() < rateLimitedUntil

// Returns null when the read failed, never an empty array. The difference
// matters: a rejected request is not the same as a table with no rows, and
// treating one as the other would blank a perfectly good map.
async function getPage(opts) {
    try {
        const res = await fetch(`${CHAIN.url}/v1/chain/get_table_rows`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                json: true, code: CONTRACT, scope: CONTRACT, ...opts,
            }),
        })

        if (res.status === 429 || res.status === 503) {
            rateLimitedUntil = Date.now() + RATE_LIMIT_PAUSE_MS
            console.warn(
                `[rpc] ${hostOf(CHAIN.url)} answered ${res.status}; ` +
                `pausing reads for ${RATE_LIMIT_PAUSE_MS / 1000}s`,
            )
            return null
        }

        if (!res.ok) return null
        return await res.json()
    } catch (error) {
        console.error('Table read failed:', error)
        return null
    }
}

// Which scope the per-game tables are read from. `map` and `players` are
// stored under the game's name; `colors`, `games`, `config` and `tracking` are
// contract-wide and keep the default.
const gameScope = () => state.game?.game_name ?? CONTRACT

// Walks the whole `map` table with the pagination cursor.
async function fetchMapChunks(onProgress) {
    const rows = []
    let lower

    for (let page = 0; page < MAX_PAGES; page++) {
        const opts = { table: 'map', scope: gameScope(), limit: PAGE_ROWS }
        if (lower !== undefined) opts.lower_bound = lower

        const data = await getPage(opts)
        if (!data) return null

        rows.push(...(data.rows ?? []))
        onProgress?.(rows.length)

        if (!data.more || !data.next_key) return rows
        // `next_key` is the first key NOT yet returned, so it is used as-is.
        lower = data.next_key
    }

    console.warn(`Stopped after ${MAX_PAGES} pages; the table may be larger.`)
    return rows
}

// Small tables, one page each. `scope` defaults to the contract for the tables
// that are contract-wide; per-game ones are asked for explicitly.
async function fetchTable(table, scope = CONTRACT) {
    const data = await getPage({ table, scope, limit: 500 })
    return data ? (data.rows ?? []) : null
}

// The palette, read once and kept. It is 200 rows and 7.7KB, it is contract-wide
// rather than per game, and only an admin action changes it - so re-reading it
// on every map refresh was the same bytes over and over.
//
// Going stale is close to harmless: buildByColor falls back to the hex a player
// carries in their own row, so a colour added after this was read still draws
// correctly for anybody holding it. What a stale palette costs is a colour
// nobody has taken yet, which nothing on the map shows.
let colorCache = null

async function fetchColors() {
    if (colorCache) return colorCache

    const rows = await fetchTable('colors')
    if (rows) colorCache = rows

    return rows
}

// One row rather than the roster. The confirmation loops after a spawn or an
// attack only ever look at the sender's own row, and they look up to sixteen
// times - reading everybody's to find one is the wrong shape for that, and gets
// worse as a game fills up.
async function fetchPlayer(wallet, scope) {
    const data = await getPage({
        table: 'players', scope,
        lower_bound: wallet, upper_bound: wallet, limit: 1,
    })

    if (!data) return null
    return data.rows?.[0] ?? null
}

// Everything about the roster that only a chain event can change. Banked power
// is deliberately absent: it climbs every second on its own, and including it
// would make every poll look like news.
//
// This is a proxy for "has the map moved", and it is a sound one. Taking a tile
// always writes the taker's row - power, tiles_owned and the accrual stamp - and
// spawning adds one. So a board that changed cannot leave this unchanged. The
// converse is not exactly true: an attack that took nothing still stamps the
// attacker, so the map is occasionally re-read for no visible change, which
// costs a request and shows the same picture.
function playersSignature(rows) {
    return rows
        .map((p) => [p.wallet, p.color_id, p.power, p.tiles_owned, p.last_power_update].join(':'))
        .join('|')
}

// Builds the color_id -> owner lookup the renderer works from.
function buildByColor(colorRows, playerRows) {
    const byColor = new Map()

    for (const c of colorRows) {
        const id = Number(c.color_id)
        byColor.set(id, { hex: c.hex_color, ink: inkFromHex(c.hex_color), names: [] })
    }

    for (const p of playerRows) {
        const id = Number(p.color_id)

        // A player carries their own copy of the hex, so a claim still renders
        // correctly even if the colour was deleted from the palette afterwards.
        if (!byColor.has(id)) {
            byColor.set(id, { hex: p.hex_color, ink: inkFromHex(p.hex_color), names: [] })
        }

        byColor.get(id).names.push(p.username)
    }

    state.byColor = byColor
    state.players = playerRows
}

// ── Grid assembly ─────────────────────────────────────────────────────────

// Turns the chunk rows into one flat grid. Chunk size and map extent are both
// derived from the data rather than assumed, so a contract that later stores a
// different map size still renders.
function buildGrid(rows) {
    if (!rows.length) {
        return { cells: null, codes: null, width: 0, height: 0, chunkSize: 10, counts: [0, 0, 0, 0, 0, 0] }
    }

    const tileCount = rows[0].tile_info?.length ?? 100
    const chunkSize = Math.max(1, Math.round(Math.sqrt(tileCount)))

    let maxRow = 0
    let maxCol = 0
    for (const row of rows) {
        const idx = Number(row.grid_index)
        maxRow = Math.max(maxRow, Math.floor(idx / INDEX_STRIDE))
        maxCol = Math.max(maxCol, idx % INDEX_STRIDE)
    }

    const height = maxRow + chunkSize
    const width = maxCol + chunkSize

    const cells = new Uint8Array(width * height)
    const codes = new Uint16Array(width * height)
    const counts = [0, 0, 0, 0, 0, 0]

    for (const row of rows) {
        const idx = Number(row.grid_index)
        const originRow = Math.floor(idx / INDEX_STRIDE)
        const originCol = idx % INDEX_STRIDE
        const tiles = row.tile_info ?? []

        // tile_info is row-major inside the chunk: [0] is the top-left tile and
        // the last entry is the bottom-right one.
        for (let i = 0; i < tiles.length; i++) {
            const y = originRow + Math.floor(i / chunkSize)
            const x = originCol + (i % chunkSize)
            if (y >= height || x >= width) continue

            const v = Number(tiles[i].v) || 0
            cells[y * width + x] = v
            codes[y * width + x] = Number(tiles[i].c) || 0
            if (v >= 0 && v <= 5) counts[v]++
        }
    }

    // Tiles no chunk covered are void, and they are worth counting — a partial
    // createmap (one that ran out of CPU part-way) shows up here first.
    counts[0] = width * height - counts.slice(1).reduce((a, b) => a + b, 0)

    return { cells, codes, width, height, chunkSize, counts }
}

// ── Density bitmap ────────────────────────────────────────────────────────
// The far-zoom level of detail: one offscreen canvas at exactly 1px per tile.
// Below a few pixels per tile a socket's ring and struts are sub-pixel, so the
// whole field collapses to a single blit.
//
// A pixel here is the amount of ink the detailed renderer would lay down on that
// tile, so this is an honest mipmap of the socket view rather than a second,
// separate encoding: the regions that glow when zoomed out are exactly the
// regions that are densely built when you zoom in.
//
// A blurred copy is added on top so neighbouring rich tiles pool into one halo.
// That is what turns a scatter of bright dots into readable veins, and it is the
// whole reason to look at the map zoomed out at all.

const bitmap = document.createElement('canvas')
const bitmapCtx = bitmap.getContext('2d')

function paintBitmap() {
    const { cells, width, height } = state
    if (!cells || !width || !height) return

    bitmap.width = width
    bitmap.height = height

    const n = width * height
    const density = new Float32Array(n)
    for (let i = 0; i < n; i++) density[i] = INK_DENSITY[cells[i]] ?? 0

    // Separable 5-tap box blur, run once per load rather than per frame.
    const blur = new Float32Array(n)
    const tmp = new Float32Array(n)
    const R = 2

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let sum = 0
            for (let k = -R; k <= R; k++) {
                sum += density[y * width + Math.min(width - 1, Math.max(0, x + k))]
            }
            tmp[y * width + x] = sum / (R * 2 + 1)
        }
    }
    for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) {
            let sum = 0
            for (let k = -R; k <= R; k++) {
                sum += tmp[Math.min(height - 1, Math.max(0, y + k)) * width + x]
            }
            blur[y * width + x] = sum / (R * 2 + 1)
        }
    }

    const image = bitmapCtx.createImageData(width, height)
    const data = image.data
    const [dr, dg, db] = MAT.deckRgb
    const [ir, ig, ib] = MAT.inkRgb

    const codes = state.codes

    for (let i = 0; i < n; i++) {
        const o = i * 4

        if (!cells[i]) {
            data[o] = 10; data[o + 1] = 12; data[o + 2] = 16; data[o + 3] = 255
            continue
        }

        // The tile's own ink, plus the pooled glow of its neighbourhood.
        let t = Math.min(1, density[i] + blur[i] * .55)

        // A claimed tile is painted toward its owner's colour rather than the
        // material's, and is floored so a claim on a dark tile — which carries
        // almost no ink of its own — does not disappear at this zoom.
        const owner = codes && codes[i] ? state.byColor.get(codes[i]) : null
        const [tr, tg, tb] = owner ? owner.ink.rgb : [ir, ig, ib]
        if (owner) t = Math.max(t, .45)

        data[o] = dr + (tr - dr) * t
        data[o + 1] = dg + (tg - dg) * t
        data[o + 2] = db + (tb - db) * t
        data[o + 3] = 255
    }

    bitmapCtx.putImageData(image, 0, 0)
}

// ── View transform ────────────────────────────────────────────────────────

const view = { scale: 1, ox: 0, oy: 0 }
let showNames = true
let hover = null       // {row, col} under the cursor
let dpr = 1

function sizeCanvas() {
    dpr = window.devicePixelRatio || 1
    const rect = canvasWrap.getBoundingClientRect()
    canvas.width = Math.max(1, Math.round(rect.width * dpr))
    canvas.height = Math.max(1, Math.round(rect.height * dpr))
}

const cssWidth = () => canvas.width / dpr
const cssHeight = () => canvas.height / dpr

// The whole map in the frame with a small margin. This doubles as the zoom
// floor: there is nothing to see beyond the map, so zooming out past this would
// only shrink it into a void.
function fitScale() {
    if (!state.width) return MIN_SCALE
    const pad = 26
    return Math.max(MIN_SCALE, Math.min(
        (cssWidth() - pad * 2) / state.width,
        (cssHeight() - pad * 2) / state.height,
    ))
}

function fitView() {
    if (!state.width) return
    view.scale = fitScale()
    centreOnTile(state.width / 2, state.height / 2)
}

// The landing view. Fitting all 200x200 into the frame puts every tile at ~3px,
// which is below the level of detail where a socket exists at all — the
// map opens close enough that the terrain is actually legible, and `Fit` is
// there for whoever wants the whole sector.
function defaultView() {
    if (!state.width) return
    // Floored at the fit scale rather than MIN_SCALE: on a frame small enough
    // that 17px per tile would not fill it, clampView would override this anyway.
    view.scale = Math.min(MAX_SCALE, Math.max(fitScale(), DEFAULT_SCALE))
    centreOnTile(state.width / 2, state.height / 2)
}

function centreOnTile(col, row) {
    view.ox = cssWidth() / 2 - col * view.scale
    view.oy = cssHeight() / 2 - row * view.scale
    clampView()
    render()
}

// Keeps at least a corner of the map on screen, so a hard drag cannot fling the
// terrain out of the frame and leave an empty viewport with no way back but Fit.
function clampView() {
    // Every path that moves the view lands here, so the zoom floor is enforced
    // here too — that covers the window being resized larger, which changes what
    // "fits" without anyone touching the zoom.
    const floor = fitScale()
    if (view.scale < floor) view.scale = floor

    const w = state.width * view.scale
    const h = state.height * view.scale

    // The map's own edges are the limit. While it is bigger than the frame it
    // must cover the frame completely, so panning stops dead at each border
    // rather than dragging empty space into view. Once it is smaller than the
    // frame — zoomed out at or past Fit — there is nothing to pan to, so it is
    // pinned to the centre instead.
    view.ox = w <= cssWidth()
        ? (cssWidth() - w) / 2
        : Math.min(0, Math.max(cssWidth() - w, view.ox))

    view.oy = h <= cssHeight()
        ? (cssHeight() - h) / 2
        : Math.min(0, Math.max(cssHeight() - h, view.oy))
}

// Zoom about a fixed point in CSS pixels, so the tile under the cursor stays put.
function zoomAt(factor, px, py) {
    // Floors at the fit scale, not at MIN_SCALE. If this computed a smaller
    // scale than clampView will allow, the offsets below would be derived from a
    // scale that then gets overridden, and the view would jump.
    const next = Math.min(MAX_SCALE, Math.max(fitScale(), view.scale * factor))
    if (next === view.scale) return
    view.ox = px - (px - view.ox) * (next / view.scale)
    view.oy = py - (py - view.oy) * (next / view.scale)
    view.scale = next
    clampView()
    render()
}

const zoomCentre = (factor) => zoomAt(factor, cssWidth() / 2, cssHeight() / 2)

function tileAt(px, py) {
    const col = Math.floor((px - view.ox) / view.scale)
    const row = Math.floor((py - view.oy) / view.scale)
    if (row < 0 || col < 0 || row >= state.height || col >= state.width) return null
    return { row, col }
}

// ── Render ────────────────────────────────────────────────────────────────

// Rendering is coalesced into one frame. A pointermove fires far more often than
// the display refreshes, and without this a drag would queue several full
// redraws per frame and throw most of them away.
let frameQueued = false

// Anything that changed the view or the data. Repaints both layers - labels are
// positioned in view coordinates, so a pan moves them as surely as it moves the
// map.
function render() {
    sceneDirty = true
    labelsDirty = true
    renderCursor()
}

// Only the figures under the names moved. Repaints the text sheet and leaves the
// map alone, which is the whole point of their being separate.
function renderLabels() {
    labelsDirty = true
    renderCursor()
}

// Only the cursor moved. Reuses the cached scene, so this is a blit and two
// stroked rectangles rather than a rebuild of the entire map.
function renderCursor() {
    if (frameQueued) return
    frameQueued = true
    requestAnimationFrame(() => { frameQueued = false; draw() })
}

// The tiles actually on screen, clamped to the grid. Everything outside this is
// never touched: at the default zoom that is ~1,500 tiles drawn out of 40,000.
function visibleRange() {
    const r0 = Math.max(0, Math.floor((0 - view.oy) / view.scale))
    const c0 = Math.max(0, Math.floor((0 - view.ox) / view.scale))
    const r1 = Math.min(state.height - 1, Math.ceil((cssHeight() - view.oy) / view.scale))
    const c1 = Math.min(state.width - 1, Math.ceil((cssWidth() - view.ox) / view.scale))
    return { r0, c0, r1, c1, empty: r1 < r0 || c1 < c0 }
}

let lastDrawn = 0     // tiles painted in the last frame, for the readout
let titledFor = -1    // what lastDrawn was when the tooltip was last written

function draw() {
    // Both layers track the canvas, and both are checked - sizing one without
    // the other would leave the text sheet at its 300x150 default and blit a
    // fraction of it over the map.
    if (scene.width !== canvas.width || scene.height !== canvas.height
        || labelLayer.width !== canvas.width || labelLayer.height !== canvas.height) {
        scene.width = canvas.width
        scene.height = canvas.height
        labelLayer.width = canvas.width
        labelLayer.height = canvas.height
        sceneDirty = true
        labelsDirty = true
    }

    if (sceneDirty) {
        ctx = sceneCtx
        paintScene()
        ctx = canvasCtx
        sceneDirty = false

        // The minimap only shows the view rectangle and the territories, so it
        // changes exactly when the scene does — never on a hover, and no longer
        // once a second either.
        drawMinimap()
    }

    if (labelsDirty) {
        ctx = labelCtx
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.clearRect(0, 0, labelLayer.width, labelLayer.height)
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        drawLabels()
        ctx = canvasCtx
        labelsDirty = false
    }

    canvasCtx.setTransform(1, 0, 0, 1, 0, 0)
    canvasCtx.clearRect(0, 0, canvas.width, canvas.height)
    canvasCtx.drawImage(scene, 0, 0)
    canvasCtx.drawImage(labelLayer, 0, 0)
    canvasCtx.setTransform(dpr, 0, 0, dpr, 0, 0)

    if (!state.width) return

    // Drawn live rather than baked into either layer: these are the only two
    // things that move while the view is still.
    if (state.selected) drawTileOutline(state.selected, MAT.inkHot, 2)
    if (hover) drawTileOutline(hover)

    // Only when the figure in it actually changed. Two toLocaleString calls and
    // a concatenation on every pointermove is not much, but it is not nothing
    // either, and nothing reads this until the pointer stops on the control.
    if (lastDrawn !== titledFor) {
        titledFor = lastDrawn
        zoomRead.title =
            `${lastDrawn.toLocaleString()} of ${(state.width * state.height).toLocaleString()} ` +
            `tiles drawn — the rest is culled`
    }
}

function paintScene() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssWidth(), cssHeight())

    if (!state.width) return

    const w = state.width * view.scale
    const h = state.height * view.scale

    // Seat the map on a dark bed so its edge is visible against the frame.
    ctx.fillStyle = 'rgba(0, 0, 0, .55)'
    ctx.fillRect(view.ox - 1, view.oy - 1, w + 2, h + 2)

    const range = visibleRange()
    if (!range.empty) {
        const tiles = (range.r1 - range.r0 + 1) * (range.c1 - range.c0 + 1)
        if (view.scale >= DETAIL_MIN_SCALE && tiles <= DETAIL_MAX_TILES) drawTiles(range)
        else drawDensity(range)
    }


    ctx.strokeStyle = 'rgba(34, 224, 255, .5)'
    ctx.lineWidth = 1
    ctx.strokeRect(view.ox - .5, view.oy - .5, w + 1, h + 1)
}

// Near zoom: the deck laid down in bulk, then one socket per visible cell.
function drawTiles({ r0, c0, r1, c1 }) {
    const { cells, width, height } = state
    const s = view.scale

    const x0 = view.ox + c0 * s
    const y0 = view.oy + r0 * s
    const w = (c1 - c0 + 1) * s
    const h = (r1 - r0 + 1) * s

    // Plate and lattice are identical on every cell, so they go down as one fill
    // and one path for the whole slab rather than a fill and a stroke per tile.
    ctx.fillStyle = MAT.deck
    ctx.fillRect(x0, y0, w, h)

    // Voids are the exception and get punched back out — but only on a map that
    // actually has any, which a complete one does not.
    if (state.counts[0] > 0) {
        ctx.fillStyle = MAT.void
        for (let row = r0; row <= r1; row++) {
            for (let col = c0; col <= c1; col++) {
                if (!cells[row * width + col]) {
                    ctx.fillRect(view.ox + col * s, view.oy + row * s, s + 1, s + 1)
                }
            }
        }
    }

    ctx.strokeStyle = MAT.deckLine
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let col = c0; col <= c1 + 1; col++) {
        const px = Math.round(view.ox + col * s) + .5
        ctx.moveTo(px, y0)
        ctx.lineTo(px, y0 + h)
    }
    for (let row = r0; row <= r1 + 1; row++) {
        const py = Math.round(view.oy + row * s) + .5
        ctx.moveTo(x0, py)
        ctx.lineTo(x0 + w, py)
    }
    ctx.stroke()

    // Every visible node writes into shared paths; the frame is then lit in one
    // fixed set of strokes rather than one per tile. Claimed tiles are bucketed
    // by owner colour, so the cost is a fixed set per DISTINCT COLOUR on screen
    // — a handful — rather than per owned tile.
    const paths = newPaths()
    const owned = new Map()
    const codes = state.codes

    // Tiles caught mid-flip, collected on the same pass and burned in after the
    // territories so the flash sits on top of its own new colour.
    const flashes = []

    // Hoisted. A reveal runs for well under a second after an attack and never
    // otherwise, so the ordinary frame should not pay for two function calls on
    // each of a few thousand tiles.
    const revealing = state.reveal !== null

    let lastCid = -1
    let lastOwner = null

    for (let row = r0; row <= r1; row++) {
        const py = view.oy + row * s
        for (let col = c0; col <= c1; col++) {
            const i = row * width + col
            const px = view.ox + col * s
            const cid = codes ? (revealing ? shownCode(i) : codes[i]) : 0

            // Territory is contiguous, so consecutive tiles nearly always share
            // a colour. Remembering the last one answers almost every lookup
            // without touching the Map.
            if (cid !== lastCid) {
                lastCid = cid
                lastOwner = cid ? state.byColor.get(cid) : null
            }
            const owner = lastOwner

            if (revealing) {
                const flash = flashAt(i)
                if (flash > 0) flashes.push(px, py, flash)
            }

            if (!owner) {
                traceNode(paths, px, py, s, cells[i])
                continue
            }

            let bucket = owned.get(cid)
            if (!bucket) {
                bucket = { ink: owner.ink, at: [], edge: new Path2D(), paths: newPaths() }
                owned.set(cid, bucket)
            }

            bucket.at.push(px, py)

            // Only the sides facing something ELSE become border. An edge shared
            // with the same colour is interior and is left out — that is what
            // turns a grid of outlined cells into one outlined territory.
            //
            // Tested against `codes`, not against the visible slab, so a holding
            // running past the edge of the viewport is not given a false border
            // where the screen happens to stop.
            const e = bucket.edge

            if (row === 0 || codes[i - width] !== cid) {
                e.moveTo(px, py); e.lineTo(px + s, py)
            }
            if (row + 1 >= height || codes[i + width] !== cid) {
                e.moveTo(px, py + s); e.lineTo(px + s, py + s)
            }
            if (col === 0 || codes[i - 1] !== cid) {
                e.moveTo(px, py); e.lineTo(px, py + s)
            }
            if (col + 1 >= width || codes[i + 1] !== cid) {
                e.moveTo(px + s, py); e.lineTo(px + s, py + s)
            }

            traceNode(bucket.paths, px, py, s, cells[i])
        }
    }

    paintPaths(ctx, paths, s)

    // shadowBlur is context-wide, so the whole ownership pass is bracketed
    // rather than each stroke unset by hand.
    ctx.save()

    for (const bucket of owned.values()) {
        // A flat wash over the whole holding. Every cell is filled, so the
        // interior reads as one region of colour rather than as tiling.
        ctx.shadowBlur = 0
        ctx.fillStyle = bucket.ink.ink
        ctx.globalAlpha = .2

        for (let k = 0; k < bucket.at.length; k += 2) {
            ctx.fillRect(bucket.at[k], bucket.at[k + 1], s + 1, s + 1)
        }

        // The silhouette, lit. A wide soft pass builds the bloom, a narrow
        // bright one keeps the boundary crisp on top of it.
        ctx.globalAlpha = .5
        ctx.shadowColor = bucket.ink.ink
        ctx.shadowBlur = Math.max(6, s * .5)
        ctx.strokeStyle = bucket.ink.ink
        ctx.lineWidth = Math.max(2, s * .12)
        ctx.stroke(bucket.edge)

        ctx.globalAlpha = 1
        ctx.shadowBlur = 0
        ctx.strokeStyle = bucket.ink.inkHot
        ctx.lineWidth = Math.max(1, s * .05)
        ctx.stroke(bucket.edge)

        paintPaths(ctx, bucket.paths, s, bucket.ink)
    }

    ctx.restore()

    // The moment of capture. Drawn last so it sits over the new owner's colour,
    // and in near-white rather than the owner's ink so a flip reads the same
    // whoever made it.
    if (flashes.length) {
        ctx.fillStyle = MAT.inkHot

        for (let k = 0; k < flashes.length; k += 3) {
            ctx.globalAlpha = flashes[k + 2] * .75
            ctx.fillRect(flashes[k], flashes[k + 1], s + 1, s + 1)
        }
    }

    ctx.globalAlpha = 1

    lastDrawn = (r1 - r0 + 1) * (c1 - c0 + 1)
}

// Far zoom: blit only the visible slice of the density field, not the whole plate.
// drawImage would clip the rest anyway, but handing the compositor a 200x200
// source when 40x30 of it is on screen is work for nothing.
function drawDensity({ r0, c0, r1, c1 }) {
    const sw = c1 - c0 + 1
    const sh = r1 - r0 + 1

    ctx.imageSmoothingEnabled = false
    ctx.drawImage(
        bitmap,
        c0, r0, sw, sh,
        view.ox + c0 * view.scale,
        view.oy + r0 * view.scale,
        sw * view.scale,
        sh * view.scale,
    )

    lastDrawn = sw * sh
}

// The cursor is a light box, not an outline: a bloom pass under a bright rule,
// so it belongs to the same world as the nodes it is picking out.
function drawTileOutline({ row, col }, colour = MAT.inkHot, weight = 1.2) {
    const size = Math.max(view.scale, 3)
    const x = view.ox + col * view.scale - .5
    const y = view.oy + row * view.scale - .5

    ctx.strokeStyle = MAT.ink
    ctx.globalAlpha = .18
    ctx.lineWidth = 5
    ctx.strokeRect(x, y, size + 1, size + 1)

    ctx.globalAlpha = 1
    ctx.strokeStyle = colour
    ctx.lineWidth = weight
    ctx.strokeRect(x, y, size + 1, size + 1)
}

function updateZoomRead() {
    zoomRead.textContent = `${view.scale.toFixed(view.scale < 10 ? 1 : 0)}×`
}

// ── Interaction ───────────────────────────────────────────────────────────

let panning = null

canvas.addEventListener('pointerdown', (e) => {
    if (!state.width) return
    canvas.setPointerCapture(e.pointerId)
    panning = { x: e.offsetX, y: e.offsetY, ox: view.ox, oy: view.oy, moved: false }
})

canvas.addEventListener('pointermove', (e) => {
    if (!state.width) return

    if (panning) {
        const dx = e.offsetX - panning.x
        const dy = e.offsetY - panning.y
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
            panning.moved = true
            canvas.classList.add('is-panning')
        }
        view.ox = panning.ox + dx
        view.oy = panning.oy + dy
        clampView()
        render()
        return
    }

    const tile = tileAt(e.offsetX, e.offsetY)
    if (sameTile(tile, hover)) return
    hover = tile
    updateHud()
    renderCursor()
})

canvas.addEventListener('pointerup', (e) => {
    const wasPan = panning?.moved
    panning = null
    canvas.classList.remove('is-panning')

    // A drag that panned is not a click; only a still pointer selects a tile.
    if (wasPan || !state.width) return
    const tile = tileAt(e.offsetX, e.offsetY)
    if (!tile) return

    // Clicking the tile that is ALREADY selected commits the attack. First click
    // aims, second fires — so a sustained assault does not mean travelling to
    // the side panel between every strike. The button stays as the deliberate
    // route, and runAttack applies the same gate whichever way it is reached.
    if (sameTile(tile, state.selected)) {
        runAttack()
        return
    }

    state.selected = tile
    renderCommander()
    render()
})

canvas.addEventListener('pointercancel', () => {
    panning = null
    canvas.classList.remove('is-panning')
})

canvas.addEventListener('pointerleave', () => {
    hover = null
    hud.hidden = true
    renderCursor()
})

canvas.addEventListener('wheel', (e) => {
    if (!state.width) return
    e.preventDefault()
    zoomAt(e.deltaY < 0 ? 1.18 : 1 / 1.18, e.offsetX, e.offsetY)
    updateZoomRead()
}, { passive: false })

const sameTile = (a, b) => (!a && !b) || (!!a && !!b && a.row === b.row && a.col === b.col)

function updateHud() {
    if (!hover) { hud.hidden = true; return }
    const { row, col } = hover
    const i = row * state.width + col
    const v = state.cells[i]

    hud.hidden = false
    hudRow.textContent = row
    hudCol.textContent = col
    const cid = v === 0 ? 0 : state.codes[i]
    const owner = cid ? state.byColor.get(cid) : null

    // Colours are reused once every one is held, so a colour can map to more
    // than one player — which makes a tile's owner genuinely ambiguous from the
    // client's side. Say so rather than picking one and looking authoritative.
    hudOwner.textContent = !owner || !owner.names.length
        ? '—'
        : owner.names.length === 1
            ? owner.names[0]
            : `${owner.names[0]} +${owner.names.length - 1}`

    hudOwner.style.color = owner ? owner.ink.ink : ''

}

zoomInBtn.addEventListener('click', () => { zoomCentre(1.3); updateZoomRead() })
zoomOutBtn.addEventListener('click', () => { zoomCentre(1 / 1.3); updateZoomRead() })
fitBtn.addEventListener('click', () => { fitView(); updateZoomRead() })

namesBtn.addEventListener('click', () => {
    showNames = !showNames
    namesBtn.setAttribute('aria-pressed', String(showNames))
    render()
})

let resizeTimer
window.addEventListener('resize', () => {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => {
        if (mapScreen.hidden) return

        // Hold the tile that was under the centre of the frame. Re-fitting on
        // every resize would throw away wherever the player had navigated to,
        // which is maddening on a window drag.
        const cx = (cssWidth() / 2 - view.ox) / view.scale
        const cy = (cssHeight() / 2 - view.oy) / view.scale

        sizeCanvas()
        sizeMinimap()
        if (state.width) centreOnTile(cx, cy)
        updateZoomRead()
    }, 120)
})

// ── Side panels ───────────────────────────────────────────────────────────

function renderStats() {
    // Every chunk that should exist for the extent the data implies, against
    // what actually came back. A createmap that died part-way through its 400
    // emplaces shows up as a gap here before you notice it on the map.
    //
    // Caveat: extent is derived from the chunks present, so a run that stopped
    // exactly on a chunk-row boundary shrinks the map rather than leaving voids,
    // and no warning fires.
    const perSide = state.chunkSize
    const expected = state.width
        ? (state.width / perSide) * (state.height / perSide)
        : 0

    if (expected && state.chunks.length < expected) {
        const missing = Math.round(expected - state.chunks.length)
        gapWarning.hidden = false
        gapWarning.textContent =
            `${missing} of ${Math.round(expected)} chunks are missing — the stored map ` +
            `is incomplete. Voids are drawn in the darkest tier.`
    } else {
        gapWarning.hidden = true
    }
}



// ── Load ──────────────────────────────────────────────────────────────────

// What the board watcher compares against, written by loadMap and read by the
// poll further down. Declared here, above the function that assigns them, so the
// order the two happen to run in is not what keeps this working.
let lastPlayersSig = null
let lastMapReadAt = 0
let mapPolling = false

let loading = false

async function loadMap({ keepView = false, focus = null } = {}) {
    if (loading) return false

    // Nothing to read without one: the map table is scoped by game name, and a
    // scope of nothing would read the contract's own, which holds no map.
    if (!state.game) return false

    loading = true

    // The overlay is for having nothing to look at, not for having something
    // that is about to change. Once a map is on screen a refresh happens behind
    // it, with the button spinner as the only tell, and the difference is
    // animated in when it arrives.
    const quiet = state.width > 0
    const before = state.codes ? Uint16Array.from(state.codes) : null
    refreshBtn.disabled = true
    refreshBtn.classList.add('is-busy')

    if (isRateLimited()) {
        const secs = Math.ceil((rateLimitedUntil - Date.now()) / 1000)
        showError(`${hostOf(CHAIN.url)} is rate limiting — retry in ${secs}s or switch node.`)
        loading = false
        refreshBtn.disabled = false
        refreshBtn.classList.remove('is-busy')
        return false
    }

    if (!quiet) {
        mapOverlay.hidden = false
        overlayText.textContent = 'Reading chain'
    }

    const rows = await fetchMapChunks((n) => {
        if (!quiet) overlayText.textContent = `Reading chain — ${n} chunks`
    })

    if (!rows) {
        mapOverlay.hidden = false
        overlayText.textContent = 'Read failed'
        mapOverlay.querySelector('.spinner')?.setAttribute('hidden', '')
        showError(`Could not read the map from ${hostOf(CHAIN.url)}. Try another endpoint.`)
        loading = false
        refreshBtn.disabled = false
        refreshBtn.classList.remove('is-busy')
        return false
    }

    mapOverlay.querySelector('.spinner')?.removeAttribute('hidden')

    // Ownership. A failed read here is not fatal — the map still draws, just
    // with every tile unclaimed — so it does not get the early return the map
    // read does.
    if (!quiet) overlayText.textContent = 'Reading players'
    const [colorRows, playerRows] = await Promise.all([
        fetchColors(),
        fetchTable('players', gameScope()),
        refreshGame(),
    ])
    buildByColor(colorRows ?? [], playerRows ?? [])

    // What the poll below compares against. Set here rather than in the poll so
    // that the two can never disagree about which roster is the one on screen.
    if (playerRows) {
        lastPlayersSig = playersSignature(playerRows)
        lastMapReadAt = Date.now()
    }

    const built = buildGrid(rows)
    Object.assign(state, built, { chunks: rows })

    // A selection from the previous map may no longer be inside the new one.
    if (state.selected
        && (state.selected.row >= state.height || state.selected.col >= state.width)) {
        state.selected = null
    }

    buildLabels()
    renderStats()
    renderCommander()

    // Only worth playing back onto a map that was already on screen; the first
    // load has nothing to animate away from.
    if (quiet) startReveal(before, state.codes, focus)

    if (!rows.length) {
        mapOverlay.hidden = false
        overlayText.textContent = 'This sector has no map stored'
        mapOverlay.querySelector('.spinner')?.setAttribute('hidden', '')
        render()
    } else {
        paintBitmap()
        mapOverlay.hidden = true
        sizeCanvas()
        sizeMinimap()
        if (keepView) render()
        else defaultView()
        updateZoomRead()
    }

    loading = false
    refreshBtn.disabled = false
    refreshBtn.classList.remove('is-busy')

    console.log(
        `Map: ${rows.length} chunks, ${state.width}×${state.height}, ` +
        `chunk ${state.chunkSize}×${state.chunkSize}`,
    )

    return true
}

refreshBtn.addEventListener("click", async () => {
    // Only announce a refresh that actually happened - loadMap has already
    // raised its own toast for the failure cases.
    const ok = await loadMap({ keepView: true })
    if (ok) showInfo(state.chunks.length ? "Map refreshed" : "No map stored yet")
})

// ── Watching the board ────────────────────────────────────────────────────
//
// Other people are playing. Their advances can land anywhere, and until this
// existed the only way to see one was to press Refresh or attack something
// yourself - so the map was a photograph presented as a window.
//
// Reading the board on a timer would be honest but expensive: 575KB every few
// seconds, whether or not anything moved. So the timer asks the cheap question
// instead. The roster is a few hundred bytes and no tile can change hands
// without writing to it, so comparing it says whether the board is worth
// re-reading - and in a quiet game the answer is almost always no.
//
// When the answer is yes, loadMap plays the difference in rather than snapping
// to it, which is the same animation an attack of your own gets.

async function pollMap() {
    if (mapScreen.hidden || !state.game) return

    // Anything already reading, animating or waiting on a wallet owns the map
    // for the moment.
    if (mapPolling || loading || attacking || spawning || state.reveal) return

    // A backgrounded tab is not being watched by anybody. Nothing here is worth
    // a request until it is on screen again.
    if (document.visibilityState === 'hidden') return

    if (isRateLimited()) return

    mapPolling = true

    try {
        const rows = await fetchTable('players', gameScope())

        // Quiet about failure. This is nobody's request, so a flaky answer
        // should leave the board alone rather than raise a toast.
        if (!rows) return

        if (playersSignature(rows) === lastPlayersSig) return

        // Something moved. Hold off if the board was read moments ago - the
        // signature stays different, so the next poll will pick it up as soon as
        // the floor allows.
        if (Date.now() - lastMapReadAt < MAP_RELOAD_MIN_MS) return

        await loadMap({ keepView: true })
    } finally {
        mapPolling = false
    }
}

setInterval(pollMap, MAP_POLL_MS)

// Coming back to the tab should not mean waiting out the interval.
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') pollMap()
})

// ── Wallet ────────────────────────────────────────────────────────────────

waxCloudBtn.addEventListener('click', () => connect('cloudwallet'))
anchorBtn.addEventListener('click', () => connect('anchor'))
connectWalletBtn.addEventListener('click', () => {
    if (state.session) disconnect()
    else if (mapScreen.hidden) connect()
})

function setWalletButtons(busy) {
    waxCloudBtn.disabled = busy
    anchorBtn.disabled = busy
}

async function connect(walletPlugin) {
    setWalletButtons(true)
    setStatus('Waiting for wallet…', 'busy')

    try {
        // `walletPlugin` is the plugin id; omitting it shows WharfKit's picker.
        const { session } = await sessionKit.login(walletPlugin ? { walletPlugin } : {})

        state.session = session
        state.account = String(session.actor)

        setStatus('Connected', 'ok')
        setConnectedChrome(true)
        await enterLobby()
    } catch (error) {
        if (isUserCancel(error)) {
            setStatus('Cancelled')
        } else {
            console.error('Login failed:', error)
            showError(readableError(error))
            setStatus('Login failed', 'error')
        }
        state.session = null
        state.account = null
        setConnectedChrome(false)
    } finally {
        setWalletButtons(false)
    }
}

async function disconnect() {
    try {
        if (state.session) await sessionKit.logout(state.session)
    } catch (error) {
        console.error('Logout failed:', error)
    }

    Object.assign(state, {
        session: null, account: null,
        game: null, games: [], config: null, tracking: null,
        chunks: [], cells: null, codes: null,
        width: 0, height: 0, selected: null,
        counts: [0, 0, 0, 0, 0, 0],
        byColor: new Map(), players: [], labels: [],
    })

    hover = null
    hud.hidden = true
    cmdUsername.value = ''
    renderStats()
    renderCommander()
    drawMinimap()

    setConnectedChrome(false)
    loadCommander()
    lobbyBtn.hidden = true
    mapScreen.hidden = true
    lobbyScreen.hidden = true
    loginScreen.hidden = false
    setStatus('Ready')
}

async function restoreSession() {
    try {
        const session = await sessionKit.restore()
        if (!session) return

        state.session = session
        state.account = String(session.actor)
        setConnectedChrome(true)
        await enterLobby()
    } catch (error) {
        console.error('Session restore failed:', error)
    }
}

function setConnectedChrome(connected) {
    const label = connectWalletBtn.querySelector('.btn-label')
    connectWalletBtn.classList.toggle('is-connected', connected)
    label.textContent = connected ? state.account : 'Connect Wallet'
    connectWalletBtn.title = connected
        ? `Connected as ${state.account} — click to disconnect`
        : 'Connect a WAX wallet'
}

// enterMap used to open the chart straight from a wallet connect. It cannot any
// more: a game is a scope, and until one is chosen there is nothing to read.
// The lobby picks it; enterGame, over in the lobby module, opens the chart.

// ── Minimap ───────────────────────────────────────────────────────────────
// The whole sector, drawn from the same density bitmap the far-zoom view blits.
// Nothing is recomputed for it - it is one drawImage plus the viewport
// rectangle, which is why it can be repainted on every frame of a pan.

let miniDpr = 1

function sizeMinimap() {
    miniDpr = window.devicePixelRatio || 1
    const rect = minimap.getBoundingClientRect()
    if (!rect.width) return
    minimap.width = Math.max(1, Math.round(rect.width * miniDpr))
    minimap.height = Math.max(1, Math.round(rect.height * miniDpr))
}

function drawMinimap() {
    const w = minimap.width / miniDpr
    const h = minimap.height / miniDpr

    minimapCtx.setTransform(miniDpr, 0, 0, miniDpr, 0, 0)
    minimapCtx.clearRect(0, 0, w, h)

    if (!state.width || !bitmap.width) return

    // The map is square in practice but the panel need not be, so it is fitted
    // rather than stretched.
    const scale = Math.min(w / state.width, h / state.height)
    const mw = state.width * scale
    const mh = state.height * scale
    const ox = (w - mw) / 2
    const oy = (h - mh) / 2

    minimapCtx.imageSmoothingEnabled = false
    minimapCtx.drawImage(bitmap, 0, 0, state.width, state.height, ox, oy, mw, mh)

    // What the main view is currently looking at.
    const vx = ox + (-view.ox / view.scale) * scale
    const vy = oy + (-view.oy / view.scale) * scale
    const vw = (cssWidth() / view.scale) * scale
    const vh = (cssHeight() / view.scale) * scale

    minimapCtx.strokeStyle = MAT.inkHot
    minimapCtx.lineWidth = 1
    minimapCtx.strokeRect(
        Math.max(ox, vx) + .5,
        Math.max(oy, vy) + .5,
        Math.min(mw, vw), Math.min(mh, vh))

    // The selected tile, so a deploy target stays findable while you pan away.
    if (state.selected) {
        const sx = ox + state.selected.col * scale
        const sy = oy + state.selected.row * scale
        minimapCtx.fillStyle = MAT.inkHot
        minimapCtx.fillRect(sx - 1.5, sy - 1.5, 4, 4)
    }
}

// Screen point on the minimap -> tile coordinate on the map.
function minimapTile(px, py) {
    const w = minimap.width / miniDpr
    const h = minimap.height / miniDpr
    const scale = Math.min(w / state.width, h / state.height)
    const ox = (w - state.width * scale) / 2
    const oy = (h - state.height * scale) / 2

    return {
        col: Math.min(state.width - 1, Math.max(0, (px - ox) / scale)),
        row: Math.min(state.height - 1, Math.max(0, (py - oy) / scale)),
    }
}

let miniDragging = false

function jumpTo(e) {
    if (!state.width) return
    const t = minimapTile(e.offsetX, e.offsetY)
    centreOnTile(t.col, t.row)
}

minimap.addEventListener('pointerdown', (e) => {
    miniDragging = true
    minimap.setPointerCapture(e.pointerId)
    jumpTo(e)
})
minimap.addEventListener('pointermove', (e) => { if (miniDragging) jumpTo(e) })
minimap.addEventListener('pointerup', () => { miniDragging = false })
minimap.addEventListener('pointercancel', () => { miniDragging = false })


// ── Commander ─────────────────────────────────────────────────────────────

// The connected wallet's row from `players`, or null if they have not spawned.
function myPlayer() {
    if (!state.account) return null
    return state.players.find((p) => p.wallet === state.account) ?? null
}

function tileValue(sel) {
    if (!sel || !state.cells) return 0
    return state.cells[sel.row * state.width + sel.col]
}

// Declared above renderCommander because that reads it - a `let` used before
// its declaration is a temporal-dead-zone throw, not a hoisted undefined.
let spawning = false

function renderCommander() {
    const me = myPlayer()

    cmdActive.hidden = !me
    cmdDeploy.hidden = !!me

    if (me) {
        cmdState.textContent = 'deployed'
        cmdName.textContent = me.username
        cmdSwatch.style.background = me.hex_color
        cmdSwatch.style.color = me.hex_color
        // Shown at POWER_SCALE, which makes this figure the INCOME the bank
        // takes per minute — the same units as everything else on the panel.
        // Not the whole rate any more: the bank also compounds 1% of itself
        // every ten seconds, so what it actually gains per minute depends on
        // how full it already is. The meter below shows that; this is the floor
        // under it. The raw field stays raw; only the display is scaled.
        cmdPower.textContent = (Number(me.power) * POWER_SCALE).toLocaleString()
        cmdScore.textContent = Number(me.score).toLocaleString()
        cmdTiles.textContent = Number(me.tiles_owned).toLocaleString()
        renderAttack()
        return
    }

    attackPanel.hidden = true

    cmdState.textContent = 'not deployed'

    const sel = state.selected
    const v = tileValue(sel)

    cmdTile.textContent = sel ? `${sel.row}, ${sel.col}` : 'none selected'
    cmdTilePower.textContent = sel ? v : '—'

    // Every reason the button can be unavailable, resolved in the order the
    // player would fix them, so the hint always names the next thing to do.
    const claimed = sel && state.codes
        ? state.codes[sel.row * state.width + sel.col] !== 0
        : false

    const name = cmdUsername.value.trim()

    let blocked = null
    if (!state.width) blocked = 'Waiting for the map.'
    else if (!sel) blocked = 'Click a tile on the map to choose where to deploy.'
    else if (claimed) blocked = 'That tile is already claimed. Pick another.'
    else if (!name) blocked = 'Choose a call sign.'
    // A name set before the limit existed, or carried in by the prefill, can be
    // longer than the field would let anybody type.
    else if (name.length > MAX_USERNAME_LENGTH)
        blocked = `A call sign is at most ${MAX_USERNAME_LENGTH} characters.`

    spawnBtn.disabled = !!blocked || spawning
    cmdHint.textContent = blocked ?? `Ready to deploy at ${sel.row}, ${sel.col}.`
    cmdHint.classList.toggle('is-ready', !blocked)
}

cmdUsername.addEventListener('input', renderCommander)

spawnBtn.addEventListener('click', async () => {
    const sel = state.selected
    const username = cmdUsername.value.trim()

    if (!state.session || !sel || !username || spawning) return

    if (gameOver()) {
        showInfo('This sector has already been won.')
        return
    }

    spawning = true
    renderCommander()
    showPending('Waiting for wallet…')

    try {
        await state.session.transact({
            action: {
                account: CONTRACT,
                name: 'spawn',
                authorization: [state.session.permissionLevel],
                data: {
                    game_name: gameScope(),
                    wallet: state.account,
                    username,
                    row: sel.row,
                    col: sel.col,
                },
            },
        })

        // A transaction that is accepted is not yet a row you can read - the
        // block has to land first. Poll for our own row rather than guessing at
        // a fixed delay, which either reports too early or waits for no reason.
        showPending('Deploying…')

        const until = Date.now() + SPAWN_CONFIRM_MS
        let confirmed = false

        while (Date.now() < until) {
            await new Promise((r) => setTimeout(r, SPAWN_POLL_MS))

            if (await fetchPlayer(state.account, gameScope())) {
                confirmed = true
                break
            }
        }

        spawning = false

        // Focused on the claimed tile so the single new cell flashes where it
        // actually landed.
        await loadMap({ keepView: true, focus: sel })

        if (confirmed) showInfo(`Deployed as ${username}`)
        else showInfo('Deploy sent — it has not shown up on this node yet.')
    } catch (error) {
        spawning = false
        if (isUserCancel(error)) {
            hideToast()
        } else {
            console.error('Spawn failed:', error)
            showError(readableError(error))
        }
        renderCommander()
    }
})

// ── Combat ────────────────────────────────────────────────────────────────

// Contract timestamps are UTC but carry no zone marker, so they parse as local
// time unless the Z is put back.
const chainSeconds = (t) => Math.floor(new Date(`${t}Z`).getTime() / 1000)

// Banked power accrues against CHAIN time. Using the browser clock instead
// would silently over- or under-estimate by however far it has drifted, and an
// over-estimate turns into a rejected transaction the player cannot explain.
let clockOffsetMs = 0

async function syncClock() {
    try {
        const t0 = Date.now()
        const res = await fetch(`${CHAIN.url}/v1/chain/get_info`, { method: 'POST' })
        if (!res.ok) return
        const info = await res.json()
        const rtt = Date.now() - t0
        const chainNow = new Date(`${info.head_block_time}Z`).getTime() + rtt / 2
        clockOffsetMs = Date.now() - chainNow
    } catch (error) {
        console.error('Clock sync failed:', error)
    }
}

const chainNowSeconds = () => Math.floor((Date.now() - clockOffsetMs) / 1000)

// The ceiling on a bank and the rate it compounds at are config_t's, not
// constants, so that tuning them does not mean a rebuild and a redeploy of a
// contract holding live games.
//
// Returns null rather than guessing when the row has not been read. A default
// invented here that differed from the chain's would not fail loudly — it would
// quote prices the chain rejects, which is the one failure this whole file is
// arranged to avoid. Callers show what is stored instead of projecting it
// forward, which is wrong by a few seconds rather than wrong by a rule.
//
// In practice it is always there: the lobby reads it, and there is no way into
// a game that does not go through the lobby.
function economy() {
    const c = state.config
    if (!c) return null

    return {
        capBase: Number(c.power_cap_base),
        capMultiple: Number(c.power_cap_multiple),
        interestPercent: Number(c.interest_percent),
    }
}

// Mirrors effective_power() in the contract exactly. The contract is still the
// authority - this only decides what the UI offers.
// The ceiling, on its own. Callers that draw the bank as a proportion need the
// same number bankedPower clamps to - having each work it out separately is what
// let the meter keep a pre-scale cap and sit pinned at full.
function powerCap(p) {
    const e = economy()
    if (!e) return Number(p.accumulated_power)

    // A floor everyone gets, plus a share that scales with what they hold. The
    // floor is already in banked-power units; the multiple is not, since power
    // is stored raw and banks are held at POWER_SCALE.
    return e.capBase + Number(p.power) * e.capMultiple * POWER_SCALE
}

// Banked power is a loop now rather than a formula, and the map wants the same
// player's figure once per label — up to three times for a large holding, on
// every frame of a pan. The answer cannot change more than once a second, so it
// is remembered for exactly that long.
//
// Keyed on the roster row ITSELF rather than on a string built from its fields.
// The row is the thing that goes stale: a fresh read after an attack produces
// new objects, so their entries are new too, and the old ones are collected
// along with the rows. That is the same invalidation the string key bought, for
// no concatenation and no hashing — and this runs per label per frame.
const bankMemo = new WeakMap()

function bankedPower(p, atSeconds = chainNowSeconds()) {
    const hit = bankMemo.get(p)

    if (hit !== undefined) {
        if (hit.at !== atSeconds) {
            hit.at = atSeconds
            hit.value = computeBankedPower(p, atSeconds)
        }
        return hit.value
    }

    const value = computeBankedPower(p, atSeconds)
    bankMemo.set(p, { at: atSeconds, value })

    return value
}

function computeBankedPower(p, atSeconds) {
    const e = economy()
    if (!e) return Number(p.accumulated_power)

    const power = Number(p.power)
    const then = chainSeconds(p.last_power_update)
    const seconds = atSeconds > then ? atSeconds - then : 0

    const cap = powerCap(p)

    let bank = Number(p.accumulated_power)
    if (bank >= cap) return cap

    const income = Math.floor(power * POWER_SCALE / 60)

    // Two things stop this running for as long as the player has been away.
    //
    // The cap is the usual one, and it arrives fast — income and cap both scale
    // with power, so the time to fill a bank hardly moves across the range of
    // powers. Across every config the contract will accept, the worst case is
    // 2,371 iterations. Worth being sure of: this runs for every labelled
    // territory on every frame, which is why the caller memoises it by the
    // second.
    //
    // The stall check is the other. A bank that did not move this second cannot
    // move next second either, so it will never reach the cap — power zero
    // against a non-zero cap floor is exactly that shape.
    for (let i = 0; i < seconds; i++) {
        const before = bank

        bank += income
        bank += Math.floor(bank * e.interestPercent / INTEREST_PER_CENT_DIVISOR)

        if (bank >= cap) return cap
        if (bank === before) break
    }

    return bank
}

// Everything the attack panel needs, derived from whatever tile is selected.
//
// The player may click ANY tile. What they are really choosing is a COLOUR; the
// strike itself has to land somewhere that touches their own territory, so the
// tile of that colour nearest the click is resolved here and that is what goes
// into the action.
//
// Clicking their OWN colour is the exception, and it is not a mistake — it is
// an order to expand. The contract reads it that way too, and the tile clicked
// matters only for being theirs, so it goes into the action unchanged.
function resolveAttack(sel) {
    const me = myPlayer()

    if (!me) return { ok: false, reason: 'Deploy before attacking.' }
    if (!sel || !state.cells) return { ok: false, reason: 'Select a tile to inspect or attack.' }

    const { width, height, cells, codes } = state
    const mine = Number(me.color_id)
    const target = codes[sel.row * width + sel.col]

    // ── expansion ────────────────────────────────────────────────────────
    //
    // Every direction at once, so there is no nearest tile to find — only
    // whether there is any open ground left against the border at all, and what
    // the cheapest piece of it costs. The contract works outward from the whole
    // territory in order of distance, so the cheapest tile touching it is the
    // first thing an expansion can afford.
    if (target === mine) {
        let cheapest = 0

        for (let r = 0; r < height && cheapest !== 1; r++) {
            for (let c = 0; c < width; c++) {
                const i = r * width + c
                if (codes[i] !== 0) continue

                const touches =
                    (c > 0 && codes[i - 1] === mine) ||
                    (c + 1 < width && codes[i + 1] === mine) ||
                    (r > 0 && codes[i - width] === mine) ||
                    (r + 1 < height && codes[i + width] === mine)

                if (!touches) continue

                const v = cells[i]
                if (!cheapest || v < cheapest) cheapest = v

                // Nothing on the board is cheaper than a v=1 tile, so the scan
                // can stop the moment it finds one.
                if (cheapest === 1) break
            }
        }

        return {
            ok: true,
            expanding: true,
            attackable: cheapest > 0,
            reason: cheapest > 0 ? null : 'No open ground borders your territory.',
            target,
            targetName: 'Open ground',
            owner: null,
            entry: sel,
            entryValue: cheapest,
        }
    }

    // Nearest tile of the target colour that shares an edge with something the
    // player holds. Squared distance, so no square roots for a comparison.
    let best = null
    let bestD = Infinity

    for (let r = 0; r < height; r++) {
        for (let c = 0; c < width; c++) {
            const i = r * width + c
            if (codes[i] !== target) continue

            const touches =
                (c > 0 && codes[i - 1] === mine) ||
                (c + 1 < width && codes[i + 1] === mine) ||
                (r > 0 && codes[i - width] === mine) ||
                (r + 1 < height && codes[i + width] === mine)

            if (!touches) continue

            const dr = r - sel.row
            const dc = c - sel.col
            const d = dr * dr + dc * dc

            if (d < bestD) { bestD = d; best = { row: r, col: c } }
        }
    }

    let owner = null
    let targetName = 'Unclaimed'

    if (target !== 0) {
        owner = state.players.find((p) => Number(p.color_id) === target)
        if (!owner) return { ok: false, reason: 'That colour belongs to no player.' }
        targetName = owner.username
    }

    // Describing a target and being able to hit one are separate questions.
    // Clicking a rival on the far side of the map should still tell you what you
    // are looking at - what they are banking, how much ground they hold, what a
    // tile of theirs costs - even though there is nowhere to strike from.
    const attackable = !!best

    const reason = best
        ? null
        : target === 0
            ? 'No unclaimed tile borders your territory.'
            : 'Nothing of theirs borders your territory — no way in from here.'

    // Everything here is STATIC for as long as the selection holds, which is
    // what makes it safe to cache. Defence is not - a defender banks power by
    // the second - so it is left to currentDefense() rather than frozen in.
    return {
        ok: true,
        expanding: false,
        attackable,
        reason,
        target,
        targetName,
        owner,
        entry: best,
        entryValue: best ? cells[best.row * width + best.col] : 0,
    }
}

// What empty ground charges per point of tile value, right now. It rises by the
// base rate again every minute the game has been running, so unclaimed space
// stops being the one thing that gets relatively cheaper while every bank in
// the game compounds.
function neutralRate() {
    if (!state.game) return NEUTRAL_TILE_COST

    const started = chainSeconds(state.game.game_started)
    const now = chainNowSeconds()
    const minutes = now > started
        ? Math.floor((now - started) / NEUTRAL_COST_PER_MINUTE_DIVISOR)
        : 0

    return NEUTRAL_TILE_COST * (minutes + 1)
}

// Mirrors attack() in the contract exactly. If the two ever disagree the panel
// quotes a cost the chain will not honour, and the player sees a transaction
// fail for no visible reason.
function currentDefense(r) {
    if (!r.owner) return r.entryValue * neutralRate()

    const tiles = Number(r.owner.tiles_owned)
    return tiles > 0 ? Math.floor(bankedPower(r.owner) / tiles) : 0
}

let attacking = false
let lastResolved = null

function renderAttack() {
    const me = myPlayer()

    attackPanel.hidden = !me
    if (!me) return

    const r = resolveAttack(state.selected)
    lastResolved = r.ok ? r : null

    if (!r.ok) {
        atkState.textContent = 'no target'
        atkTarget.textContent = '—'
        atkControls.hidden = true
        atkHint.textContent = r.reason
        atkHint.classList.remove('is-ready')
        attackBtn.disabled = true
        return
    }

    atkState.textContent = r.expanding
        ? 'expand'
        : r.target === 0
            ? 'neutral'
            : r.attackable ? 'player' : 'out of reach'

    atkTarget.textContent = r.targetName

    atkControls.hidden = !r.attackable

    if (!r.attackable) {
        atkHint.textContent = r.reason
        atkHint.classList.remove('is-ready')
        attackBtn.disabled = true
        return
    }

    renderAttackGate()
}

// The half of the panel that MOVES. Your bank fills by the second and so does
// the defender's, so a target that was unaffordable when it was picked can
// become affordable while you sit and look at it — the button has to notice on
// its own rather than waiting for the selection to change.
//
// Deliberately cheap: it reuses the cached target and never re-runs
// resolveAttack, which scans the whole grid to find the nearest border tile and
// has no business running once a second.
function renderAttackGate() {
    const me = myPlayer()
    const r = lastResolved

    if (!me || !r) return

    const bank = bankedPower(me)
    const defense = currentDefense(r)

    if (!r.attackable) return

    atkPower.disabled = bank < 1
    atkPowerRead.textContent = `${commitPercent()}%`
    paintCommitSlider()

    const commit = commitPower(bank)

    let blocked = null
    if (bank < 1) blocked = 'No power banked yet.'
    else if (commit < defense) {
        blocked = r.expanding
            ? `Needs at least ${defense.toLocaleString()} to take the cheapest tile going.`
            : `Needs at least ${defense.toLocaleString()} to take one tile.`
    }

    attackBtn.disabled = !!blocked || attacking

    if (blocked) {
        atkHint.textContent = blocked
        atkHint.classList.remove('is-ready')
    } else {
        atkHint.textContent = `Committing up to ${commit.toLocaleString()}`
        atkHint.classList.add('is-ready')
    }
}

// The slider is a SHARE of the bank, not an amount of it. That is what makes it
// stable: the bank grows every second, so an absolute figure the player set goes
// stale immediately and the old slider had to chase its own ceiling to stay
// sensible. A percentage just keeps meaning the same thing.
const commitPercent = () => Number(atkPower.value)

const commitPower = (bank) =>
    Math.max(1, Math.floor(bank * commitPercent() / 100))

// The track left of the knob is filled in the knob's own colour. A range input
// cannot do that on its own - there is no progress pseudo-element in Chromium
// or WebKit - so the track carries a gradient and this moves its stop.
//
// One writer, so the CSS fallback and the markup's value= can never be the
// thing that is right while the control shows something else.
function paintCommitSlider() {
    atkPower.style.setProperty('--fill', String(commitPercent()))
}

atkPower.addEventListener('input', () => {
    atkPowerRead.textContent = `${commitPercent()}%`
    paintCommitSlider()
    renderAttackGate()
})

// Named rather than inline, because the button is no longer the only way in -
// clicking a tile that is already selected fires the same attack.
async function runAttack() {
    const me = myPlayer()
    const r = lastResolved

    if (!state.session || !me || !r || !r.attackable || attacking) return

    const bank = bankedPower(me)
    const commit = commitPower(bank)

    // Same gate the button honours, so the map-click route cannot send an attack
    // the panel would have refused.
    if (bank < 1 || commit < currentDefense(r)) return

    if (gameOver()) {
        showInfo('This sector has already been won.')
        return
    }

    attacking = true
    renderAttack()
    showPending('Waiting for wallet…')

    try {
        await state.session.transact({
            action: {
                account: CONTRACT,
                name: 'attack',
                authorization: [state.session.permissionLevel],
                data: {
                    game_name: gameScope(),
                    wallet: state.account,
                    row: r.entry.row,
                    col: r.entry.col,
                    power_to_use: commit,
                },
            },
        })

        showPending('Resolving…')

        // The map is what changes, so the confirmation watches the tile that was
        // struck rather than guessing at a delay.
        const until = Date.now() + SPAWN_CONFIRM_MS
        let settled = false

        while (Date.now() < until) {
            await new Promise((res) => setTimeout(res, SPAWN_POLL_MS))

            const mine = await fetchPlayer(state.account, gameScope())

            if (mine && chainSeconds(mine.last_power_update) >= chainNowSeconds() - 120) {
                settled = true
                break
            }
        }

        attacking = false

        // Focused on the strike point, so the playback sweeps outward from where
        // the attack landed - the same order the cascade took the tiles in.
        await loadMap({ keepView: true, focus: r.entry })

        const now = myPlayer()
        if (settled && now) {
            showInfo(`Attack resolved — you hold ${Number(now.tiles_owned).toLocaleString()} tiles.`)
        } else {
            showInfo('Attack sent — it has not shown up on this node yet.')
        }
    } catch (error) {
        attacking = false
        if (isUserCancel(error)) {
            hideToast()
        } else {
            console.error('Attack failed:', error)
            showError(readableError(error))
        }
        renderAttack()
    }
}

attackBtn.addEventListener('click', runAttack)

// Banked power moves on its own, so the panel ticks rather than waiting for the
// next chain read. Cheap: arithmetic on one row, no network.
setInterval(() => {
    if (mapScreen.hidden) return

    const me = myPlayer()
    if (!me) return

    const bank = bankedPower(me)
    const cap = powerCap(me)

    cmdBank.textContent = bank.toLocaleString()

    // The ceiling, and the rate the bank compounds at. Both come off the config
    // row rather than being fixed, so there is nowhere else a player could learn
    // them — and the rate is what decides whether sitting on a bank is worth
    // anything at all.
    //
    // Written only when they change. Neither moves except on a setconfig or a
    // conquest, and this runs once a second forever.
    const capText = `cap ${cap.toLocaleString()}`
    if (cmdBankCap.textContent !== capText) cmdBankCap.textContent = capText

    const e = economy()
    const rateText = e ? `+${e.interestPercent}% / sec` : '—'
    if (cmdBankRate.textContent !== rateText) cmdBankRate.textContent = rateText

    const pct = cap > 0 ? Math.min(100, bank / cap * 100) : 0
    cmdBankBar.style.width = `${pct}%`
    cmdBankBar.classList.toggle('is-full', cap > 0 && bank >= cap)

    // Re-gate, not just re-slide. Both banks fill while you sit and look at a
    // target, so the button has to become available on its own the moment the
    // numbers allow it. Cheap: the cached target is reused, no grid rescan.
    if (!attacking && !attackPanel.hidden && lastResolved) {
        renderAttackGate()
    }

    // The map has to be redrawn too, or the figures under the territory names
    // freeze until something else happens to trigger a frame — a hover, a pan.
    // That is exactly why they only seemed to move for whoever was selected: the
    // panel was ticking and the map was not.
    //
    // Two gates before it, though, because this is once a second forever.
    //
    // Only the LABELS are repainted, never the map underneath, which is the
    // reason they sit on their own layer.
    //
    // And only when a figure on screen would actually differ. Banks stop at the
    // cap, and past that every digit is the one already drawn — on a settled
    // board that turns this tick into a comparison and nothing else.
    //
    // Not gated on showNames: turning names off leaves the figures, and a
    // figure that has stopped climbing is worse than no figure at all.
    if (!state.reveal && labelFiguresMoved()) {
        renderLabels()
    }
}, 1000)

// ── Territory labels ──────────────────────────────────────────────────────
//
// Naming a region on a map is really the problem of finding a point INSIDE it
// to write at. A centroid is the obvious answer and the wrong one: territory
// here is grown by conquest and is routinely crescent-shaped or split around an
// island, and the centroid of a crescent lies in the sea.
//
// So each connected holding gets its "pole of inaccessibility" - the tile
// furthest from any edge of that holding. Found by flooding inward from the
// border: the last tile reached is the deepest. That is O(tiles) and lands the
// name in the fattest part of the shape, which is also where there is room for
// it.

// Below this a holding is a skirmish, not a territory, and labelling it just
// litters the map.
const MIN_LABEL_TILES = 20

// A split empire deserves more than one label, but not one per scrap.
const MAX_LABELS_PER_PLAYER = 3

function buildLabels() {
    state.labels = []

    const { width, height, codes } = state
    if (!width || !codes) return

    const seen = new Uint8Array(width * height)
    const byOwner = new Map()

    const DR = [0, 0, 1, -1]
    const DC = [1, -1, 0, 0]

    for (let start = 0; start < codes.length; start++) {
        const cid = codes[start]
        if (!cid || seen[start]) continue

        const owner = state.byColor.get(cid)
        if (!owner || !owner.names.length) { seen[start] = 1; continue }

        // Flood the whole connected holding.
        const cells = [start]
        seen[start] = 1

        for (let k = 0; k < cells.length; k++) {
            const j = cells[k]
            const r = (j / width) | 0
            const c = j % width

            for (let d = 0; d < 4; d++) {
                const rr = r + DR[d]
                const cc = c + DC[d]
                if (rr < 0 || cc < 0 || rr >= height || cc >= width) continue

                const t = rr * width + cc
                if (seen[t] || codes[t] !== cid) continue

                seen[t] = 1
                cells.push(t)
            }
        }

        if (cells.length < MIN_LABEL_TILES) continue

        if (!byOwner.has(cid)) byOwner.set(cid, [])
        byOwner.get(cid).push({ cid, owner, cells })
    }

    for (const holdings of byOwner.values()) {
        holdings.sort((a, b) => b.cells.length - a.cells.length)

        for (const h of holdings.slice(0, MAX_LABELS_PER_PLAYER)) {
            const anchor = poleOfInaccessibility(h.cells)
            if (!anchor) continue

            state.labels.push({
                row: anchor.row,
                col: anchor.col,
                depth: anchor.depth,
                tiles: h.cells.length,
                text: h.owner.names.length === 1
                    ? h.owner.names[0]
                    : `${h.owner.names[0]} +${h.owner.names.length - 1}`,
                ink: h.owner.ink,

                // The row itself, not a snapshot of its bank — the figure drawn
                // under the name is recomputed each frame so it ticks up on the
                // map the same way it does in the panel.
                player: state.players.find((p) => Number(p.color_id) === h.cid) ?? null,
            })
        }
    }

    // Biggest first, so if two labels ever collide the more significant one is
    // drawn last and wins the overlap.
    state.labels.sort((a, b) => a.tiles - b.tiles)
}

// Multi-source flood inward from the holding's border. Returns the deepest tile
// and how deep it is, which doubles as a measure of how much room the name has.
function poleOfInaccessibility(cells) {
    const { width, height, codes } = state

    const member = new Set(cells)
    const depth = new Map()
    let frontier = []

    const DR = [0, 0, 1, -1]
    const DC = [1, -1, 0, 0]

    for (const j of cells) {
        const r = (j / width) | 0
        const c = j % width

        let edge = false
        for (let d = 0; d < 4 && !edge; d++) {
            const rr = r + DR[d]
            const cc = c + DC[d]

            // Falling off the map counts as an edge; a name pressed against the
            // border reads no better than one in the sea.
            if (rr < 0 || cc < 0 || rr >= height || cc >= width) edge = true
            else if (!member.has(rr * width + cc)) edge = true
        }

        if (edge) { depth.set(j, 1); frontier.push(j) }
    }

    // A holding with no border at all cannot happen, but an empty frontier would
    // spin forever, so it is guarded rather than assumed.
    if (!frontier.length) return null

    let deepestAt = 1
    let deepestSet = [...frontier]

    while (frontier.length) {
        const next = []

        for (const j of frontier) {
            const r = (j / width) | 0
            const c = j % width
            const d0 = depth.get(j)

            for (let d = 0; d < 4; d++) {
                const rr = r + DR[d]
                const cc = c + DC[d]
                if (rr < 0 || cc < 0 || rr >= height || cc >= width) continue

                const t = rr * width + cc
                if (!member.has(t) || depth.has(t)) continue

                depth.set(t, d0 + 1)
                next.push(t)

                if (d0 + 1 > deepestAt) { deepestAt = d0 + 1; deepestSet = [t] }
                else if (d0 + 1 === deepestAt) deepestSet.push(t)
            }
        }

        frontier = next
    }

    // A broad shape has a whole plateau of equally deep tiles, and taking
    // whichever one the flood happened to reach first drags the name off to one
    // side. Take the deep tile nearest the middle of that plateau instead - it
    // is still a member, so it can never land outside the holding.
    let mr = 0, mc = 0
    for (const j of deepestSet) { mr += (j / width) | 0; mc += j % width }
    mr /= deepestSet.length
    mc /= deepestSet.length

    let best = deepestSet[0]
    let bestD = Infinity

    for (const j of deepestSet) {
        const dr = ((j / width) | 0) - mr
        const dc = (j % width) - mc
        const d = dr * dr + dc * dc
        if (d < bestD) { bestD = d; best = j }
    }

    return { row: (best / width) | 0, col: best % width, depth: deepestAt }
}

// Whether any banked figure a label shows has changed since it was last drawn.
//
// bankedPower is memoised by the second, so this asks each PLAYER once however
// many labels they hold, and a capped bank answers from the first line of the
// loop without iterating at all.
function labelFiguresMoved() {
    let moved = false

    for (const label of state.labels) {
        if (!label.player) continue

        const figure = bankedPower(label.player)

        if (label.figure !== figure) {
            label.figure = figure
            moved = true
        }
    }

    return moved
}

function drawLabels() {
    if (!state.labels.length) return

    const s = view.scale

    // Tied to zoom so a name sits with its territory, but clamped: unclamped it
    // is either unreadable when zoomed out or absurd when zoomed in.
    const font = Math.max(13, Math.min(30, s * 1.15))
    const subFont = font * .74

    // save/restore because shadow and letter spacing are context-wide state.
    // Leaving either set would put a coloured bloom on the cursor box and the
    // map border drawn after this.
    ctx.save()

    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.lineJoin = 'round'

    // Three passes, dark to bright, and the same three for a name as for a
    // figure — which is why they are one function rather than two copies.
    //
    // 1. A heavy dark stroke punches a hole in the circuitry underneath, so the
    //    text is never read against a field of lit nodes.
    // 2. Two shadowed fills in the owner's colour. Canvas has no additive
    //    blending, so the bloom is built by stacking the same draw — one pass
    //    reads as a soft edge, two as something lit from within.
    // 3. The core, unshadowed and pale, so the letterforms stay crisp instead of
    //    dissolving into their own glow.
    const stack = (text, x, y, size, ink, strokeScale) => {
        ctx.shadowBlur = 0
        ctx.lineWidth = Math.max(4, size * strokeScale)
        ctx.strokeStyle = 'rgba(0, 3, 6, .95)'
        ctx.strokeText(text, x, y)

        ctx.shadowColor = ink.ink
        ctx.shadowBlur = size * .95
        ctx.fillStyle = ink.ink
        ctx.fillText(text, x, y)
        ctx.fillText(text, x, y)

        ctx.shadowBlur = 0
        ctx.fillStyle = ink.inkHot
        ctx.fillText(text, x, y)
    }

    // Tracked out to match the display voice used everywhere else in the
    // interface. Engines without it ignore the property, which costs nothing.
    const nameFont = () => {
        ctx.font = `700 ${font}px 'Chakra Petch', system-ui, sans-serif`
        ctx.letterSpacing = `${(font * .1).toFixed(1)}px`
    }
    const figureFont = () => {
        ctx.font = `700 ${subFont}px 'Share Tech Mono', ui-monospace, monospace`
        ctx.letterSpacing = `${(subFont * .05).toFixed(1)}px`
    }

    for (const label of state.labels) {
        // A name needs the holding to be thick enough to sit in. A one-tile
        // tendril is not a territory to be labelled however long it is.
        if (label.depth < 2) continue

        const x = view.ox + (label.col + .5) * s
        const y = view.oy + (label.row + .5) * s

        if (x < -160 || y < -50 || x > cssWidth() + 160 || y > cssHeight() + 50) continue

        // Banked power, recomputed here rather than stored, so it climbs on the
        // map in step with the panel.
        const figure = label.player ? bankedPower(label.player).toLocaleString() : null

        // Names off leaves the figures. They are two different questions — whose
        // territory this is, and what they can bring to bear — and wanting the
        // map uncluttered by the first is no reason to lose the second.
        if (!showNames) {
            if (!figure) continue
            if (label.depth * 2 * s < subFont * 1.5) continue

            figureFont()
            stack(figure, x, y, subFont, label.ink, .5)
            continue
        }

        if (label.depth * 2 * s < font * 1.5) continue

        // The figure only joins the name when there is vertical room for a
        // second line.
        const sub = figure && label.depth * 2 * s >= font * 2.9 ? figure : null

        // With two lines the pair is centred on the anchor rather than the name
        // alone, otherwise the block sits visibly high in its territory.
        const ty = sub ? y - font * .38 : y

        nameFont()
        stack(label.text.toUpperCase(), x, ty, font, label.ink, .46)

        if (sub) {
            figureFont()
            stack(sub, x, ty + font * 1.02, subFont, label.ink, .5)
        }
    }

    ctx.restore()
}

// ── Reveal ────────────────────────────────────────────────────────────────
//
// A refresh that redrew the whole map at once made an attack look like a page
// load rather than like something happening. So the difference between the old
// grid and the new one is played back instead: each captured tile holds its old
// owner until its turn, then flips with a flash.
//
// The order is a breadth-first walk from the tile that was struck, over the
// changed tiles only - which is the same order the contract's cascade took them
// in, so what you watch is the attack replaying rather than an arbitrary wipe.

const REVEAL_MS = 650      // how long the whole front takes to sweep through
const FLASH_MS = 280       // how long one tile stays lit after it flips
const REVEAL_MAX_MS = 1400 // a huge conquest still has to finish promptly

function startReveal(before, after, focus) {
    state.reveal = null

    if (!before || !after || before.length !== after.length) return

    const { width } = state
    const changed = []

    for (let i = 0; i < after.length; i++) {
        if (before[i] !== after[i]) changed.push(i)
    }

    if (!changed.length) return

    const pending = new Set(changed)
    const delay = new Map()

    // Start from the struck tile when there is one and it actually changed;
    // otherwise from any changed tile, which is what happens when the map moved
    // because somebody else attacked while we were looking at it.
    const entry = focus ? focus.row * width + focus.col : -1
    let seed = pending.has(entry) ? entry : changed[0]

    let step = 0
    let frontier = [seed]
    pending.delete(seed)
    delay.set(seed, 0)

    const DR = [0, 0, 1, -1]
    const DC = [1, -1, 0, 0]

    while (frontier.length) {
        step++
        const next = []

        for (const j of frontier) {
            const r = (j / width) | 0
            const c = j % width

            for (let d = 0; d < 4; d++) {
                const t = (r + DR[d]) * width + (c + DC[d])
                if (!pending.has(t)) continue

                pending.delete(t)
                delay.set(t, step)
                next.push(t)
            }
        }

        frontier = next
    }

    // Anything the walk could not reach was not part of this cascade - a rival's
    // capture landing in the same refresh. Those flip at once rather than being
    // folded into a sweep they had nothing to do with.
    for (const j of pending) delay.set(j, 0)

    // Steps are turned into milliseconds only now, so the sweep takes about the
    // same wall-clock time whether it crossed three tiles or three hundred.
    const span = Math.min(REVEAL_MAX_MS, REVEAL_MS)
    const perStep = step > 0 ? span / step : 0

    for (const [j, s] of delay) delay.set(j, s * perStep)

    state.reveal = {
        old: before,
        delay,
        start: performance.now(),
        total: span + FLASH_MS,
        elapsed: 0,
    }

    animateReveal()
}

function animateReveal() {
    const rv = state.reveal
    if (!rv) return

    rv.elapsed = performance.now() - rv.start

    if (rv.elapsed >= rv.total) {
        state.reveal = null
        render()
        return
    }

    // draw() directly rather than render(): render coalesces through a frame
    // flag meant for input bursts, and this loop already runs once per frame.
    // Both layers are dirtied by hand because tiles are changing colour under
    // the names as well as under the map.
    sceneDirty = true
    labelsDirty = true
    draw()
    requestAnimationFrame(animateReveal)
}

// The owner a tile should be DRAWN as right now. Mid-reveal a tile that has not
// had its turn yet is still shown under its previous owner.
function shownCode(i) {
    const rv = state.reveal
    if (!rv) return state.codes[i]

    const d = rv.delay.get(i)
    if (d === undefined) return state.codes[i]

    return rv.elapsed < d ? rv.old[i] : state.codes[i]
}

// 1 at the instant a tile flips, falling to 0 over FLASH_MS. Zero for every
// tile that is not currently flipping, which is almost all of them.
function flashAt(i) {
    const rv = state.reveal
    if (!rv) return 0

    const d = rv.delay.get(i)
    if (d === undefined) return 0

    const t = rv.elapsed - d
    if (t < 0 || t > FLASH_MS) return 0

    return 1 - t / FLASH_MS
}

// ── The lobby ─────────────────────────────────────────────────────────────
//
// A game is a scope on chain. Its map and its roster live under the game's
// name, not the contract's, so there is no longer one map for the site to open
// into — something has to choose a scope first, and this is it.
//
// Three tables feed this view, all of them contract-wide:
//
//   games      every game ever launched. Rows are never erased, so this is the
//              history as well as the list of what is playable now.
//   config     how often a game starts, and how long one is kept.
//   tracking   when the last game started, and the name the next already has.
//
// The countdown is arithmetic on `tracking` plus `config`, not a poll. The due
// moment is known the instant the schedule is read, so the clock runs locally
// against chain time and the chain is only asked again when something actually
// changes.

const LOBBY_TICK_MS = 1000

// How often the lobby re-reads the chain on its own. Anyone can send launchgame,
// so a game can appear without this browser having done anything, and a lobby
// that only updates when you press Refresh is a lobby that quietly lies.
const LOBBY_POLL_MS = 10000

// Config is written by setconfig and by nothing else, so it is read once and
// then only occasionally re-checked rather than fetched alongside every other
// read. Not cached forever, though: it prices every bank on screen, and a
// setconfig landing while somebody is playing would otherwise leave them
// quoting figures the chain has stopped honouring until they reloaded the page.
const CONFIG_MAX_AGE_MS = 300000
let configReadAt = 0

// Resolves immediately, and without a request, unless the copy has aged out.
async function fetchConfigIfStale() {
    if (state.config && Date.now() - configReadAt < CONFIG_MAX_AGE_MS) return state.config

    const rows = await fetchTable('config')

    if (rows) {
        state.config = rows[0] ?? null
        configReadAt = Date.now()
    }

    return state.config
}

const lobbyScreen = $('lobbyScreen')
const gameList = $('gameList')
const currentList = $('currentList')
const currentSection = $('currentSection')
const previousSection = $('previousSection')
const lobbySub = $('lobbySub')
const lobbyCount = $('lobbyCount')
const lobbyEmpty = $('lobbyEmpty')
const lobbyRefreshBtn = $('lobbyRefreshBtn')
const launchCard = document.querySelector('.launch-card')
const launchClock = $('launchClock')
const launchNote = $('launchNote')
const launchBtn = $('launchBtn')

const opState = $('opState')
const opWhen = $('opWhen')
const opElapsed = $('opElapsed')
const opPlayers = $('opPlayers')
const opGrace = $('opGrace')
const opWin = $('opWin')

// A finished game is finished, not paused: the contract refuses further spawns
// and attacks so the winner's record cannot be overwritten afterwards. Worth
// knowing on this side too, or the only feedback is a rejected transaction.
const gameOver = () => !!(state.game && state.game.winner_wallet)

// ── Formatting ────────────────────────────────────────────────────────────

// Names are minted as name(sec_since_epoch), so most of the 13 base32 characters
// are leading dots and the string is an identifier rather than something to read.
// The launch time is the label everywhere a game is named. The raw name appears
// only in the open sector's panel, where it is worth having because it IS the
// scope key and the map seed - the thing you would paste into a table query.
function gameLabel(row) {
    const d = new Date(chainSeconds(row.game_started) * 1000)
    return d.toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })
}

function fmtSpan(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) seconds = 0

    const d = Math.floor(seconds / 86400)
    const h = Math.floor(seconds % 86400 / 3600)
    const m = Math.floor(seconds % 3600 / 60)
    const s = Math.floor(seconds % 60)

    if (d > 0) return `${d}d ${String(h).padStart(2, '0')}h`
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    return `${m}:${String(s).padStart(2, '0')}`
}

// ── Schedule ──────────────────────────────────────────────────────────────

// The second the next game becomes launchable, or 0 when nothing has ever been
// launched — with no tracking row there is no interval to have elapsed, so the
// first game is due immediately. Mirrors launchgame()'s own reasoning.
function dueSeconds() {
    if (!state.config) return null
    if (!state.tracking) return 0

    return chainSeconds(state.tracking.last_game_start)
        + Number(state.config.new_game_seconds)
}

// Set for as long as a read is in flight, so the background poll can stand
// aside rather than race whatever opened the lobby or pressed Refresh.
let lobbyFetching = false

async function fetchLobby() {
    lobbyFetching = true

    try {
        const [games, trk] = await Promise.all([
            fetchTable('games'),
            fetchTable('tracking'),
            fetchConfigIfStale(),
        ])

        // A failed read is not an empty table. Blanking the list on a flaky node
        // would look exactly like every game having been retired.
        if (!games) return false

        state.games = games
        state.tracking = trk?.[0] ?? null

        return true
    } finally {
        lobbyFetching = false
    }
}

// Everything the lobby actually draws from, as one string. The poll compares it
// before and after a read and only rebuilds when something moved.
//
// Not an optimisation for its own sake: renderGames replaces the cards, which
// throws away whatever the pointer was over and whatever had focus. Doing that
// every ten seconds to redraw an identical list would make the page feel like it
// was fighting you.
function gamesSignature(rows) {
    return rows
        .map((g) => [g.game_name, g.players_spawned, g.winner_wallet,
                     g.winner_username, g.seconds_to_win, g.tables_cleaned].join(':'))
        .join('|')
}

let lastGamesSig = null

async function pollLobby() {
    // Only while it is on screen, and never on top of a read already running.
    if (lobbyScreen.hidden || lobbyFetching || launching) return

    // Nobody is looking at a backgrounded tab.
    if (document.visibilityState === 'hidden') return

    // A node that has started refusing is being left alone by every other read;
    // a poll on a timer should not be the one that keeps knocking.
    if (isRateLimited()) return

    // Flagged for the same reason fetchLobby flags itself: whatever else wants
    // to read the lobby should wait rather than interleave with this.
    lobbyFetching = true

    try {
        // One table, not three. The other two only move when this one does:
        // tracking advances when a game launches, which puts a row in here, and
        // config changes only when an admin acts - which the age check below picks
        // up on its own schedule.
        //
        // Quietly: a background read that fails should leave the last good list on
        // screen, not raise a toast at somebody who did not ask for anything.
        const rows = await fetchTable('games')
        if (!rows) return

        const sig = gamesSignature(rows)
        const configAged = Date.now() - configReadAt > CONFIG_MAX_AGE_MS

        if (sig === lastGamesSig && !configAged) return

        // Something did move, so now it is worth asking about the rest.
        const [trk] = await Promise.all([
            fetchTable('tracking'),
            fetchConfigIfStale(),
        ])

        state.games = rows
        if (trk) state.tracking = trk[0] ?? null

        lastGamesSig = sig

        renderLobby()
    } finally {
        lobbyFetching = false
    }
}

setInterval(pollLobby, LOBBY_POLL_MS)

// ── Rendering ─────────────────────────────────────────────────────────────

// An interval as somebody would say it out loud, rather than as it is stored.
// 3,600 is "every hour", not "every 1 hours" and certainly not "every 3600s".
function everyPhrase(seconds) {
    if (seconds % 3600 === 0) {
        const h = seconds / 3600
        return h === 1 ? 'every hour' : `every ${h} hours`
    }
    if (seconds % 60 === 0) {
        const m = seconds / 60
        return m === 1 ? 'every minute' : `every ${m} minutes`
    }
    return `every ${seconds} seconds`
}

// Same for the grace window. Derived rather than written out, so that changing
// the contract's constant cannot leave the lobby promising a minute that is no
// longer a minute.
function gracePhrase(seconds) {
    if (seconds === 60) return 'first minute'
    if (seconds % 60 === 0) return `first ${seconds / 60} minutes`
    return `first ${seconds} seconds`
}

function renderSchedule() {
    if (!state.config) {
        lobbySub.textContent =
            'No schedule is set yet, so no game can start.'
        launchCard.classList.remove('is-due')
        launchClock.textContent = '—'
        launchNote.textContent = 'No schedule configured yet — an admin has to run setconfig.'
        launchBtn.disabled = true
        return
    }

    lobbySub.textContent =
        `A new game launches ${everyPhrase(Number(state.config.new_game_seconds))}. ` +
        `Spawn within the ${gracePhrase(SPAWN_GRACE_SECONDS)} to not have any disadvantage.`

    const due = dueSeconds()
    const left = due - chainNowSeconds()
    const ready = left <= 0

    launchCard.classList.toggle('is-due', ready)
    launchClock.textContent = ready ? 'READY' : fmtSpan(left)

    const every = fmtSpan(Number(state.config.new_game_seconds))

    // The name the schedule has minted is deliberately absent. It is a base32
    // uint64 and it told a player nothing they could use - the same reason it
    // came off the Game panel.
    launchNote.textContent = ready
        ? (state.tracking
            ? 'Sector is ready. Anyone can launch it!'
            : 'No sector has launched yet. Anyone can launch the first!')
        : `A new sector every ${every}.`

    // Not an admin control. launchgame takes no special authority — whoever
    // sends it pays the CPU for generating the map — so the only thing gating
    // this button is having a wallet attached to sign with.
    launchBtn.disabled = !ready || !state.session || launching
}

// Which game is the one being played. Not simply the newest row: the contract
// has a precise notion of it — the game whose start matches tracking's
// last_game_start — and cleanup already refuses to retire that one. Borrowing
// the same test means the lobby and the chain cannot disagree about which game
// is current, and it correctly ignores a game an admin started off the rota.
//
// A game that has been won is no longer current, whatever the rota says. There
// is nothing left to play, so it belongs with the history.
function currentGame(rows) {
    if (!state.tracking) return null

    const started = chainSeconds(state.tracking.last_game_start)

    return rows.find((g) =>
        chainSeconds(g.game_started) === started
        && !g.winner_wallet
        && !g.tables_cleaned) ?? null
}

function gameCard(row, isCurrent) {
    const won = !!row.winner_wallet
    const retired = row.tables_cleaned

    const card = document.createElement('button')
    card.type = 'button'
    card.className = 'game-card' + (isCurrent ? ' is-current' : '')

    // Retired is not a filter, it is a state. cleanup drops the map and the
    // roster but keeps the games row, so the entry survives with nothing left
    // behind it to open — say so rather than hiding the history.
    card.disabled = retired
    card.title = retired
        ? 'Retired — the map and roster for this sector have been cleared'
        : isCurrent ? 'Join the game in progress' : 'Open this sector'

    const id = document.createElement('div')
    id.innerHTML = '<span class="game-title"></span>'
    id.querySelector('.game-title').textContent = gameLabel(row)

    if (won) {
        // Built rather than interpolated: a username is whatever a player typed
        // at spawn, so it reaches this list from the chain as untrusted text and
        // never goes near innerHTML.
        const by = document.createElement('span')
        by.className = 'game-won'
        by.append('Won by ')

        const who = document.createElement('b')
        // The wallet is the identity of record; the username is a label beside
        // it. Falling back keeps the line meaningful rather than trailing off if
        // a row ever carries a blank one.
        who.textContent = row.winner_username || row.winner_wallet
        by.append(who)

        id.append(by)
    }

    // Only a live game's clock is still moving. A won one stopped at the moment
    // it was won and the contract recorded how long that took; a retired one has
    // no end time on chain, so the honest figure is its age rather than a run
    // length invented here.
    const ticking = !won && !retired

    const stats = document.createElement('div')
    stats.className = 'game-stats'
    stats.innerHTML =
        '<span><em>COMMANDERS</em><b class="js-commanders"></b></span>' +
        '<span><em class="js-agelabel"></em><b class="js-age"></b></span>'

    stats.querySelector('.js-commanders').textContent = Number(row.players_spawned).toLocaleString()
    stats.querySelector('.js-agelabel').textContent =
        won ? 'WON IN' : retired ? 'AGE' : 'RUNNING'

    const age = stats.querySelector('.js-age')
    if (ticking) age.classList.add('js-tick')
    age.textContent = won
        ? fmtSpan(Number(row.seconds_to_win))
        : fmtSpan(chainNowSeconds() - chainSeconds(row.game_started))

    // The tick reads the start off the element rather than re-deriving which row
    // this was, so re-sorting the list can never shift a figure onto the wrong
    // card.
    age.dataset.start = String(chainSeconds(row.game_started))

    const flag = document.createElement('span')
    flag.className = 'game-flag ' + (won ? 'is-won' : retired ? '' : 'is-live')
    flag.textContent = won ? 'Won' : retired ? 'Retired' : 'Live'

    card.append(id, stats, flag)
    card.addEventListener('click', () => enterGame(row))

    return card
}

function renderGames() {
    // Newest first. Rows are keyed by the game's name, whose value is a
    // timestamp, so the table's own order is chronological — but sorting on the
    // recorded start is the thing actually meant, and it survives a game that
    // was started by hand with a name of its own choosing.
    const rows = [...state.games].sort(
        (a, b) => chainSeconds(b.game_started) - chainSeconds(a.game_started),
    )

    const current = currentGame(rows)
    const previous = rows.filter((g) => g !== current)

    currentSection.hidden = !current
    currentList.replaceChildren(...(current ? [gameCard(current, true)] : []))

    // Hidden only when empty. The markup leaves it visible, so this is the only
    // thing that ever conceals it.
    previousSection.hidden = previous.length === 0
    gameList.replaceChildren(...previous.map((g) => gameCard(g, false)))

    lobbyCount.textContent = previous.length ? String(previous.length) : ''

    lobbyEmpty.hidden = rows.length > 0
}

function renderLobby() {
    renderSchedule()
    renderGames()
}

// The opening window, while it is open. Seconds are counted against CHAIN time
// like everything else here — a browser clock running fast would otherwise
// close the notice while the contract was still granting the grace.
function renderGrace() {
    const g = state.game

    if (!g || g.winner_wallet) {
        opGrace.hidden = true
        return
    }

    const elapsed = chainNowSeconds() - chainSeconds(g.game_started)
    const left = SPAWN_GRACE_SECONDS - elapsed

    if (left <= 0) {
        opGrace.hidden = true
        return
    }

    opGrace.hidden = false
    opGrace.replaceChildren(
        'Opening minute — deploy now and you bank from the launch, not from when you arrive. ',
    )

    const b = document.createElement('b')
    b.textContent = `${Math.min(left, SPAWN_GRACE_SECONDS)}s left`
    opGrace.append(b)
}

// Which game the chart is showing, as the time it started. The name it is
// scoped by never appears: it is a base32 uint64 the schedule minted, which is
// the right key for a table query and no use at all to somebody playing.
function renderOp() {
    const g = state.game
    if (!g) return

    opWhen.textContent = gameLabel(g)
    opPlayers.textContent = Number(g.players_spawned).toLocaleString()
    opElapsed.textContent = fmtSpan(chainNowSeconds() - chainSeconds(g.game_started))

    renderGrace()

    const won = !!g.winner_wallet

    opState.textContent = won ? 'Won' : 'Live'
    opState.classList.toggle('is-live', !won)
    opState.classList.toggle('chip-muted', won)

    opWin.hidden = !won
    if (won) {
        opWin.textContent =
            `${g.winner_username} took the whole sector in ${fmtSpan(Number(g.seconds_to_win))}.`
    }
}

// Re-reads the open game's own row. A win is written by the attack that causes
// it, so the row the map view is holding goes stale at exactly the moment it
// matters most. Called from loadMap, which already runs after every action that
// could have changed it.
async function refreshGame() {
    if (!state.game) return

    // The config comes along, but through the same age check the lobby uses, so
    // it costs a request only when its copy has actually aged out.
    const [rows] = await Promise.all([
        fetchTable('games'),
        fetchConfigIfStale(),
    ])

    if (!rows) return

    const fresh = rows.find((g) => g.game_name === state.game.game_name)
    if (!fresh) return

    state.games = rows
    state.game = fresh
    renderOp()
}

// ── Moving between the two views ──────────────────────────────────────────

async function enterLobby() {
    state.game = null

    loginScreen.hidden = true
    mapScreen.hidden = true
    lobbyScreen.hidden = false
    lobbyBtn.hidden = true

    lobbyRefreshBtn.disabled = true
    launchClock.textContent = '—'
    launchNote.textContent = 'Reading schedule…'

    const ok = await fetchLobby()
    lobbyRefreshBtn.disabled = false

    if (!ok) {
        showError(`Could not read the game list from ${hostOf(CHAIN.url)}. Try another endpoint.`)
        return
    }

    // So the poll does not immediately think it has news.
    lastGamesSig = gamesSignature(state.games)

    renderLobby()

    // Reads the wallet, so it is not held up by the game list.
    loadCommander()
}

async function enterGame(row) {
    // Without it nothing on the map can be priced — banks, caps, what an attack
    // costs. Better to say so here than to open a chart quoting figures the
    // chain will not honour.
    if (!state.config) {
        showError('No economy configured yet — an admin has to run setconfig.')
        return
    }

    state.game = row

    lobbyScreen.hidden = true
    loginScreen.hidden = true
    mapScreen.hidden = false
    lobbyBtn.hidden = false

    renderOp()

    // Cleared first, so every game starts from the CURRENT perm name. Carrying
    // the field over from the last game would mean a name changed in the lobby
    // since then never took, and they would deploy under the old one. If they
    // have already spawned here the deploy form is hidden and none of this shows.
    cmdUsername.value = ''

    renderCommander()
    prefillDeployName()

    // A lobby read that failed leaves nothing to prefill from, so ask again
    // rather than making somebody retype a name they have already set. Not
    // awaited - the map should not wait on it, and prefillDeployName is written
    // to arrive late.
    if (state.session && !permRow) {
        fetchPerm(state.account).then((row) => {
            if (!row) return
            permRow = row
            prefillDeployName()
        })
    }

    // Neither canvas has a size until it is actually laid out, so both are
    // measured after the view is on screen, not before.
    sizeCanvas()
    sizeMinimap()
    await loadMap()
}

// Only offered from inside a sector. On the lobby it would point at the page
// you are already on, and before a wallet is attached there is no lobby to go
// back to.
lobbyBtn.addEventListener('click', () => { enterLobby() })

lobbyRefreshBtn.addEventListener('click', async () => {
    lobbyRefreshBtn.disabled = true
    const ok = await fetchLobby()
    lobbyRefreshBtn.disabled = false

    if (!ok) {
        showError('Could not read the game list.')
        return
    }

    lastGamesSig = gamesSignature(state.games)
    renderLobby()
})

// ── Launching ─────────────────────────────────────────────────────────────

let launching = false

launchBtn.addEventListener('click', async () => {
    if (!state.session || launching) return

    launching = true
    renderSchedule()
    showPending('Waiting for wallet…')

    try {
        await state.session.transact({
            action: {
                account: CONTRACT,
                name: 'launchgame',
                authorization: [state.session.permissionLevel],
                // No arguments by design: the name came from tracking, the seed
                // IS that name, and the timing is config's. There is nothing
                // here for the caller to choose, which is what makes it safe to
                // leave open to anyone.
                data: {},
            },
        })

        // Generating a 200x200 map is 400 rows of writes, so the block this
        // lands in takes a moment. Poll for the game rather than guessing at a
        // delay — and poll for a game we did not already know about, since the
        // name is minted on chain and cannot be predicted from here.
        showPending('Generating sector…')

        const known = new Set(state.games.map((g) => g.game_name))
        const until = Date.now() + SPAWN_CONFIRM_MS
        let fresh = null

        while (Date.now() < until) {
            await new Promise((r) => setTimeout(r, SPAWN_POLL_MS))

            if (!await fetchLobby()) continue

            fresh = state.games.find((g) => !known.has(g.game_name))
            if (fresh) break
        }

        launching = false
        renderLobby()

        if (fresh) {
            showInfo('Sector generated')
            await enterGame(fresh)
        } else {
            showInfo('Launch sent — it has not shown up on this node yet.')
        }
    } catch (error) {
        launching = false
        renderSchedule()

        if (isUserCancel(error)) showInfo('Launch cancelled')
        else {
            console.error('Launch failed:', error)
            showError(readableError(error))
        }
    }
})

// ── The clock ─────────────────────────────────────────────────────────────
//
// One interval for both views, because both are showing the same thing: time
// passing against the chain's clock, not the browser's. Nothing here touches
// the network.

setInterval(() => {
    if (!lobbyScreen.hidden) {
        renderSchedule()

        // The per-card ages, without rebuilding the list. Replacing the DOM once
        // a second would throw away hover and focus for the sake of two digits.
        const now = chainNowSeconds()

        // Both lists — the current game has a clock too.
        for (const el of lobbyScreen.querySelectorAll('.js-tick')) {
            el.textContent = fmtSpan(now - Number(el.dataset.start))
        }

        return
    }

    if (!mapScreen.hidden && state.game && !state.game.winner_wallet) {
        opElapsed.textContent =
            fmtSpan(chainNowSeconds() - chainSeconds(state.game.game_started))

        // Cheap once it has closed: one subtraction and a hidden flag that is
        // already set.
        renderGrace()
    }
}, LOBBY_TICK_MS)

// ── The commander ─────────────────────────────────────────────────────────
//
// The one part of a player that survives a game. It lives in the perm table,
// which cleanup never touches, and it holds the name they deploy under and the
// crew.worlds NFT they field.
//
// Two sources, deliberately. Ownership is read from the CHAIN, because that is
// what the contract checks and the two must not disagree. Names and artwork
// come from AtomicAssets' own API, because a card's picture is IPFS-serialised
// inside its template and decoding that in the browser would mean carrying a
// copy of the schema format around.
//
// The API is a convenience, never an authority: setcommander re-reads the asset
// from atomicassets itself, so the worst a wrong answer here can do is offer a
// choice the chain then refuses.

const CREW_COLLECTION = 'alien.worlds'
const CREW_SCHEMA = 'crew.worlds'

const ATOMIC_API = 'https://wax.api.atomicassets.io/atomicassets/v1'

// Alien Worlds run their own IPFS gateway, and for Alien Worlds art it is the
// one source that actually has everything: measured across every card in this
// wallet it served 30 of 30, where the public gateways managed 29 and left one
// card timing out however long it was given. Their content, their pins.
const CREW_GATEWAY = 'ipfs.alienworlds.io/ipfs'

// Through a resizing proxy first, because the originals average 655KB for
// something drawn a couple of hundred pixels wide - 19MB against half a
// megabyte for a wallet of forty cards. The proxy is a convenience though, not
// the source, so anything it cannot serve falls straight back to the gateway
// itself: slower and heavier, but a picture rather than an empty frame.
const CREW_THUMB = (hash, size = 260) =>
    `https://images.weserv.nl/?url=${CREW_GATEWAY}/${encodeURIComponent(hash)}&w=${size}&output=webp`

const CREW_FULL = (hash) => `https://${CREW_GATEWAY}/${encodeURIComponent(hash)}`

// One <img> per card, lazily, and with somewhere to go when the proxy is down.
// The flag is what stops a second failure from looping between the two.
function crewImage(hash, alt) {
    const img = document.createElement('img')

    img.loading = 'lazy'
    img.decoding = 'async'
    img.alt = alt ?? ''
    img.src = CREW_THUMB(hash)

    img.addEventListener('error', () => {
        if (img.dataset.fellBack) return
        img.dataset.fellBack = '1'
        img.src = CREW_FULL(hash)
    })

    return img
}

const permName = $('permName')
const permScore = $('permScore')
const permSaveBtn = $('permSaveBtn')
const crewArt = $('crewArt')
const crewArtEmpty = $('crewArtEmpty')
const crewName = $('crewName')
const crewBoost = $('crewBoost')
const crewGrid = $('crewGrid')
const crewCount = $('crewCount')
const crewHint = $('crewHint')

// Mirrors MAX_USERNAME_LENGTH. The inputs carry maxlength too, but that only
// stops TYPING past it - a name already on chain from before the limit, or one
// put into the field by the prefill, arrives whatever length it is. So the
// buttons check as well, and refuse rather than letting the chain do it.
const MAX_USERNAME_LENGTH = 15

// Mirrors DEFAULT_SCORE_BOOST. A boost is 1 + rarity + shine, and a value the
// table does not name adds nothing - so a card matching neither is worth exactly
// what fielding none is worth.
const DEFAULT_SCORE_BOOST = 1

// What the chain says, and what the player has changed it to but not yet saved.
let permRow = null

// match -> multiplier, read from the scoreboost table. The contract scans that
// table by string; a Map is the same lookup with the scan done once.
let boostTable = new Map()
let crewTemplates = []
let pickedAssetId = '0'
let savingPerm = false

// ── Reading ───────────────────────────────────────────────────────────────

async function fetchPerm(wallet) {
    const data = await getPage({
        table: 'perm', scope: CONTRACT,
        lower_bound: wallet, upper_bound: wallet, limit: 1,
    })

    if (!data) return null
    return data.rows?.[0] ?? null
}

// The boost table, as the contract will read it when the choice is saved.
//
// Duplicated match strings are possible and the contract takes the FIRST row it
// meets, walking in index order - so this keeps the first and ignores the rest,
// or the panel would quote a price the chain does not.
async function fetchBoosts() {
    const rows = await fetchTable('scoreboost')
    if (!rows) return null

    const map = new Map()

    for (const r of [...rows].sort((a, b) => Number(a.index) - Number(b.index))) {
        if (!map.has(r.match)) map.set(r.match, Number(r.score_multiplier))
    }

    return map
}

// The same sum commander_boost does on chain: 1 + rarity + shine, with anything
// the table does not name contributing nothing.
function boostOf(card) {
    if (!card) return DEFAULT_SCORE_BOOST

    return DEFAULT_SCORE_BOOST
        + (boostTable.get(card.rarity) ?? 0)
        + (boostTable.get(card.shine) ?? 0)
}

// Every crew.worlds card the wallet holds, folded down to one entry per
// TEMPLATE. A wallet with four hundred cards has about thirty different ones,
// and the boost is a property of the template rather than of the copy - so
// picking is choosing a card, not choosing which duplicate to field.
async function fetchCrew(wallet) {
    const byTemplate = new Map()

    for (let page = 1; page <= 6; page++) {
        const url = `${ATOMIC_API}/assets?owner=${encodeURIComponent(wallet)}`
            + `&collection_name=${CREW_COLLECTION}&schema_name=${CREW_SCHEMA}`
            + `&page=${page}&limit=1000&order=asc&sort=asset_id`

        let batch
        try {
            const res = await fetch(url)
            if (!res.ok) return null
            batch = (await res.json()).data
        } catch (error) {
            console.error('Crew read failed:', error)
            return null
        }

        if (!Array.isArray(batch)) return null

        for (const asset of batch) {
            const id = asset.template?.template_id
            if (!id) continue

            if (!byTemplate.has(id)) {
                byTemplate.set(id, {
                    templateId: String(id),
                    // The first copy seen is the one that gets fielded. Any of
                    // them would do; the contract only cares that the wallet
                    // holds THIS asset id.
                    assetId: String(asset.asset_id),
                    name: asset.name || `Template ${id}`,
                    img: asset.data?.img || null,

                    // What the boost is keyed on. Both belong to the template,
                    // which is why one entry per template can carry them.
                    shine: asset.data?.shine ?? null,
                    rarity: asset.data?.rarity ?? null,

                    held: 0,
                })
            }

            byTemplate.get(id).held++
        }

        if (batch.length < 1000) break
    }

    // Best first, because that is the question being asked. Name breaks a tie,
    // so the order is stable rather than however the wallet happened to enumerate.
    return [...byTemplate.values()].sort((a, b) =>
        boostOf(b) - boostOf(a) || a.name.localeCompare(b.name))
}

// ── Drawing ───────────────────────────────────────────────────────────────

const pickedTemplate = () =>
    crewTemplates.find((t) => t.assetId === pickedAssetId) ?? null

function renderCrewCurrent() {
    const picked = pickedTemplate()

    // The caption stays and the image is added beside it, so a card whose art
    // will not load shows its name in the frame rather than an empty box.
    crewArt.classList.toggle('is-empty', !picked)
    crewArt.replaceChildren(crewArtEmpty)
    crewArtEmpty.textContent = picked ? picked.name : 'No commander'

    if (picked?.img) crewArt.append(crewImage(picked.img, picked.name))

    crewName.textContent = picked ? picked.name : 'No commander'

    // The boost of what is SELECTED, worked out here rather than read from the
    // perm row - the row still holds what was last saved, so picking a card and
    // reading that back would show the old card's multiplier until the save
    // landed. This is what the contract will store.
    //
    // The figure and its label are separate elements so the number can carry the
    // size without the word going with it.
    const figure = document.createElement('b')
    figure.textContent = `${boostOf(picked)}×`

    crewBoost.replaceChildren(figure, 'score')
}

function renderCrewGrid() {
    crewGrid.replaceChildren()

    // Fielding nothing is a real choice and the default one, so it is a tile
    // like any other rather than a way to undo.
    const none = document.createElement('button')
    none.type = 'button'
    none.className = 'crew-tile is-none' + (pickedAssetId === '0' ? ' is-picked' : '')
    none.title = 'Field no commander'
    none.addEventListener('click', () => {
        pickedAssetId = '0'
        renderCommanderPanel()
    })
    crewGrid.append(none)

    for (const t of crewTemplates) {
        const tile = document.createElement('button')
        tile.type = 'button'
        tile.className = 'crew-tile' + (t.assetId === pickedAssetId ? ' is-picked' : '')
        const parts = [t.name, `${boostOf(t)}× score`]
        if (t.shine) parts.push(t.shine)
        if (t.rarity) parts.push(t.rarity)
        if (t.held > 1) parts.push(`${t.held} held`)

        tile.title = parts.join(' · ')

        if (t.img) tile.append(crewImage(t.img, t.name))

        // What it is worth, on the card itself. Choosing between forty of these
        // is choosing a multiplier, and having to click each one to find out
        // makes the picker a guessing game.
        const mult = document.createElement('b')
        mult.className = 'crew-mult'
        mult.textContent = `${boostOf(t)}×`
        tile.append(mult)

        if (t.held > 1) {
            const n = document.createElement('em')
            n.textContent = String(t.held)
            tile.append(n)
        }

        tile.addEventListener('click', () => {
            pickedAssetId = t.assetId
            renderCommanderPanel()
        })

        crewGrid.append(tile)
    }
}

function renderCommanderPanel() {
    const connected = !!state.session

    permName.disabled = !connected
    permScore.textContent = permRow
        ? `${Number(permRow.score).toLocaleString()} lifetime score`
        : ''

    renderCrewCurrent()
    renderCrewGrid()

    crewCount.textContent = crewTemplates.length
        ? `${crewTemplates.length} card${crewTemplates.length === 1 ? '' : 's'}`
        : ''

    // Nothing to save until something differs from what the chain holds.
    const name = permName.value.trim()

    const changed = !permRow
        || name !== permRow.username
        || pickedAssetId !== String(permRow.commander_asset_id)

    const tooLong = name.length > MAX_USERNAME_LENGTH

    permSaveBtn.disabled = !connected || !name || tooLong || !changed || savingPerm

    if (tooLong) {
        crewHint.textContent = `A call sign is at most ${MAX_USERNAME_LENGTH} characters.`
        crewHint.classList.add('is-warn')
    }
}

// The deploy field in a game starts from the name they set in the lobby. Only
// when it is empty: overwriting something somebody is halfway through typing
// would be worse than not filling it at all.
//
// Called from both ends because the two race. Entering a game usually finds the
// perm row already read, but a slow node can land it after the map view is
// open, so the read fills the field too.
function prefillDeployName() {
    if (!permRow?.username) return
    if (cmdUsername.value.trim()) return

    cmdUsername.value = permRow.username
    renderCommander()
}

// ── Loading ───────────────────────────────────────────────────────────────

async function loadCommander() {
    if (!state.session) {
        permRow = null
        crewTemplates = []
        pickedAssetId = '0'
        permName.value = ''
        crewHint.textContent = 'Connect a wallet to choose one.'
        crewHint.classList.remove('is-warn')
        renderCommanderPanel()
        return
    }

    crewHint.textContent = 'Reading your wallet…'
    crewHint.classList.remove('is-warn')

    permRow = await fetchPerm(state.account)

    // Nothing on chain yet means they have never spawned. The panel still works
    // - saving is what creates the row, and they pay for it either way.
    permName.value = permRow?.username ?? ''
    pickedAssetId = permRow ? String(permRow.commander_asset_id) : '0'

    // Before the cards, because folding them sorts by boost and every tile
    // shows one.
    boostTable = await fetchBoosts() ?? new Map()

    const crew = await fetchCrew(state.account)

    if (!crew) {
        crewTemplates = []
        crewHint.textContent = 'Could not read your NFTs just now. You can still set a name.'
        crewHint.classList.add('is-warn')
    } else {
        crewTemplates = crew
        crewHint.classList.remove('is-warn')
        crewHint.textContent = crew.length
            ? (boostTable.size
                ? 'Pick a card to field. Best multiplier first.'
                : 'Pick a card to field. No boosts are configured yet, so every card is 1×.')
            : 'No crew.worlds cards in this wallet. Fielding none costs you nothing.'
    }

    // A card that was equipped and has since left the wallet is no longer on
    // offer, and pretending otherwise would let them save something the chain
    // refuses. Say so rather than silently resetting.
    if (pickedAssetId !== '0' && crew && !pickedTemplate()) {
        crewHint.textContent = 'The card you had equipped is no longer in this wallet.'
        crewHint.classList.add('is-warn')
    }

    renderCommanderPanel()
    prefillDeployName()
}

permName.addEventListener('input', renderCommanderPanel)

// ── Saving ────────────────────────────────────────────────────────────────

permSaveBtn.addEventListener('click', async () => {
    if (!state.session || savingPerm) return

    const username = permName.value.trim()
    if (!username) return

    savingPerm = true
    renderCommanderPanel()
    showPending('Waiting for wallet…')

    try {
        await state.session.transact({
            action: {
                account: CONTRACT,
                name: 'setcommander',
                authorization: [state.session.permissionLevel],
                data: {
                    wallet: state.account,
                    username,
                    commander_asset_id: pickedAssetId,
                },
            },
        })

        showPending('Saving…')

        // The row is what changed, so that is what is watched. A first save also
        // creates it, which is why an absent row counts as not settled yet.
        const until = Date.now() + SPAWN_CONFIRM_MS
        let settled = false

        while (Date.now() < until) {
            await new Promise((r) => setTimeout(r, SPAWN_POLL_MS))

            const row = await fetchPerm(state.account)

            if (row && row.username === username
                && String(row.commander_asset_id) === pickedAssetId) {
                permRow = row
                settled = true
                break
            }
        }

        savingPerm = false
        renderCommanderPanel()

        showInfo(settled ? 'Commander saved' : 'Sent — it has not shown up on this node yet.')
    } catch (error) {
        savingPerm = false
        renderCommanderPanel()

        if (isUserCancel(error)) showInfo('Cancelled')
        else {
            console.error('Save failed:', error)
            showError(readableError(error))
        }
    }
})

// ── Boot ──────────────────────────────────────────────────────────────────

console.log(`${APP_NAME} — contract ${CONTRACT}`)

readPalette()
setStatus('Ready')
setConnectedChrome(false)

// Endpoints first: everything downstream reads the chain, so there is no point
// restoring a session against a node that is not answering.
;(async () => {
    await initEndpoints()

    // Banked power is measured against chain time, so the offset has to be known
    // before any of it is shown. Re-synced periodically because a browser clock
    // drifts, and an over-estimate here becomes a rejected attack.
    await syncClock()
    setInterval(syncClock, CLOCK_SYNC_MS)

    await restoreSession()
})()
