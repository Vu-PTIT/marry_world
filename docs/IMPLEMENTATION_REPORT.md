# Implementation report

Verified through November 6, 2026 against `WEDDING_WORLD_V3_MASTER_PROMPT.md`.

## Delivered scope

This workspace contains a runnable stylized multiplayer prototype. The browser
uses TypeScript, Three.js and Vite; Python FastAPI owns movement, sessions,
permissions, reservations, ceremony timing, completion and deletion. There is no
account system, permanent wedding database or fabricated online population.

| Prompt phase | Current implementation |
| --- | --- |
| A: playable world | Central plaza, Vietnam garden, public circulation, desktop/touch movement and four cameras. |
| B: authoritative multiplayer | Real temporary WebSocket guests, validated movement, collision/access rules, registrar and reconnects. |
| C: wedding lifecycle | Explicit mutual consent, approved and accepted roles, finite places, FIFO reservations, 60-second both-ready check and required ceremony actions. |
| D: invitations | Temporary public links, Python social metadata, mobile landing/share flow, district arrival, existing-session resume and generic expired responses. |
| E: keepsakes | Server Ed25519 completion evidence, browser verification, five certificate layouts, local A4 PDF, 2480 × 3508 PNG and evidence JSON. |
| F: five districts | Vietnam, Japan, South Korea, India and Italy; distinct architecture, attire, programs, gestures and reception activities; completed connecting promenade. |
| G: process partition | Experimental six-process motion ownership on one host, Redis leases/fencing, interrupted handoff recovery and synchronized optional overflow cameras. |
| H: measurement | Reproducible moving-client load runner; local 20- and 100-client measurements below. Larger distributed populations remain untested. |

Each district currently has one functioning Stage A. The art uses original
stylized environments and an original skinned guest GLB with ten animation clips.
The model/UI upgrade is described below. Cultural choices represent selected
traditions; sources and asset/font
licenses are recorded in [Culture and assets](CULTURE_AND_ASSETS.md).

## Model and UI upgrade · November 5, 2026

- Replaced the original block characters with an original rounded guest model:
  an actually loaded GLB, 18 joints, ten animation clips, one body material and
  8,884 body triangles. Cloned guests have independent skeletons and appearance
  colors. Clothing follows chest/head joints; ritual props follow the right hand.
- Added a live 3D appearance preview and 44px appearance choices. Reworked both
  desktop and phone HUDs with a collapsible contextual panel, a camera menu,
  readable ceremony controls, and directory focus handling.
- Reworked the world map with landmarks, the current public route and walking
  estimates. Added photo mode, explicit exit, local PNG download, and movement
  input reset on modal, blur, pointer cancellation and disconnect transitions.
  Two-finger movement/orbit ownership is exercised with real browser touch input.
- Added branching trees, petalled flowers, benches, lamps, path edging, roof
  ridges/trim, latticework and local venue details across all five districts.
  Lantern sway respects reduced motion. The subsequent map/movement refinement
  below updates foliage visibility and static batching.
- Re-ran all **43 backend tests**, the complete browser wedding and the dedicated
  desktop/phone upgrade checks. Verified loaded rig/animation, independent clones,
  ordinary walking, all three normal cameras, touch cancellation, map routes,
  estimates, directory input/focus and photo export. No JavaScript errors were
  observed in the passing runs. Production bundle verification is recorded in
  `artifacts/upgrade/production-checks.json`.

The build passes. Vite emits a size warning for the current main approximately 796kB
minified chunk (208kB gzip). The guest GLB is 1.69MB. Crowd rendering and physical
phone performance still need measurement. These changes keep the existing map
permissions, full ceremony durations, consent, role and deletion behavior.

## Map and movement refinement · November 6, 2026

The user selected a warm, soft, romantic palette. All five environments now use
clearer ivory paths, dusty rose/terracotta architecture, warm timber, quiet greens
and muted water. Curved roof shells have tile courses and structural details;
India uses fabric canopies for both the main stage and preparation pavilions.
The villa has a closed gable and arched door. Tree variants, a ring fountain,
registrar awning, ponds and visible lantern supports were added or refined.
Paving is above the grass. Public geometry and all access boundaries remain the same.

The measured cause of uneven walking was that prediction advanced only on a
network send, then immediately reconciled on each snapshot. Walking now advances
every render frame, independently of network sends. Recent inputs are replayed
over snapshot age, and drift correction converges through the collision map.
Other guests use a 150ms interpolation buffer. A monotonic server clock filters
metadata arrival jitter. The server supplies the actual choreography deadline;
the couple follows authoritative poses during entrance and seven steps. Routes
remove redundant grid turns only after checking each straight segment.
Keyboard/touch steering cancels navigation without a false arrival message.
Blur, hidden tabs and disconnects clear the route and held input. New routes from
a dialog start after its close cleanup, keeping that cleanup from cancelling them.

Tree crowns use instancing (2,243 instances in the inspected world). Other static
surfaces share vertex-colored material batches in 32m cells. Offscreen guests
and guides are culled using a conservative 1.65m radius; sampled vertices from all
ten clips stayed within 1.165m of its center. Whole occluding trees fade together
using MSAA alpha coverage, so walking past a tree no longer shortens the
camera orbit. Architecture collision still controls the camera distance.
The browser without antialiasing uses an alpha-test fallback. Both modes were
visually inspected with an actual tree in front of the character, with no shader
errors. Whole-tree fading avoids grain and cut surfaces in individual crowns.

### Measured walking result

Actual HTTP/WebSocket guests, native RTX 3050 laptop GPU, 1440 × 900 desktop and
390 × 844 phone viewport emulation. Continuous W or actual browser touch joystick
input for 3.5 seconds; first 0.7 seconds excluded from steady movement statistics.
One moving guest, no rendered crowd. Spawn orientation differs between runs, so
draw counts are observations rather than a controlled geometry benchmark.

| Metric | Desktop before → final | Phone viewport before → final |
| --- | ---: | ---: |
| Mean rendered speed | 4.503 → 4.500 m/s | 4.509 → 4.498 m/s |
| Speed standard deviation | 1.420 → 0.126 m/s | 1.457 → 0.117 m/s |
| Speed p05–p95 | 2.826–6.416 → 4.293–4.691 m/s | 2.727–6.457 → 4.339–4.673 m/s |
| Prediction frames with no step while holding input | 85 → 0 | 89 → 0 |
| Frame time p95 | 18.2 → 17.2 ms | 18.2 → 17.1 ms |
| Observed draw calls | 300 → 137 | 129 → 54 |
| Observed triangles | 345,262 → 384,288 | 211,110 → 167,976 |

Rendered speed variation fell by about 91% in these samples. The richer scenery
can increase triangle count; fewer draw calls do not establish performance on a
physical phone. Another run delayed incoming WebSocket messages by 110ms:
speed standard deviation was 0.155/0.158 m/s and frame p95 17.1/17.0ms. This is
receive-delay injection, not a measured WAN or packet-loss test.

The real public journey to Japan completed in 36.38 seconds without a teleport,
0.191m from the destination, with 0.113m difference from the latest server position.
Model inspection found no WebGL console or browser errors. **44 backend tests**,
**11 frontend movement test groups**, the complete browser wedding and the built
desktop/phone flows passed. Full physical-phone, crowd, thermal and WAN tests
remain outstanding. Sources and decisions are recorded in section 11 of the
[experience plan](UX_MAP_ANIMATION_PLAN.md).

## Guest outfits and botanical identity — November 6, 2026

Entry now offers female/dress and male/suit with a live model preview, six
clothing swatches and a custom hex color picker. The initial female outfit is
ivory; choosing male before customizing color defaults to navy. Changing the
outfit preserves a customized color. Skin is independent of clothing color.
Validated appearance metadata is visible to nearby guests and survives a
temporary-session reconnect; it does not affect roles or ceremony permissions.

Both original GLBs retain 18 joints and 10 animation clips. The suit adds a
shirt, lapels, bow tie, pocket square, cuffs and dress shoes (7,985 triangles,
1,528,288 bytes). The dress adds a pleated skirt with matching hem, waist bow,
necklace, earrings and a bun (10,384 triangles, 1,960,568 bytes). The registrar
and five officiants use these models with district attire. Geometry/color
changes leave each character's skeleton and animation mixer independent.

Nine botanical silhouettes distinguish the gardens: palms/bamboo, blossom,
pine/ginkgo, gulmohar, cypress/olive, and central magnolia. They keep instanced
crowns and the existing whole-tree camera-occlusion handling. Promenades use
staggered paving joints, shallow edge bands and flush gate junctions. Roadside
trunks are skipped wherever the shared navigation map permits walking.

`scripts.appearance_check` passed desktop and phone viewport selection, custom
colors, two-client replication, reload/reconnect, independent models and all
clip bounds. Both models' measured animated radius fits the 1.65m culling bound.
The real public walk to Japan finished in 39.21 seconds, 0.196m from the target,
with 0.055m difference from the latest authority position and no browser/shader
errors. The map checker now waits for dialog-close navigation before sampling
the route. The backend suite has **45 passing tests**, including appearance
validation and reconnect; the **11 movement groups** also pass.

The final production bundle passed desktop/phone entry, both actual GLB files,
camera/settings, reduced-motion, map/ETA, keyboard/touch route cancellation,
directory and PNG photo export with no JavaScript errors. The browser UI suite
also passed simultaneous touch movement/orbit. Its single-guest render sample
reported 60 FPS on the RTX 3050 laptop for both viewports; this is not a physical
phone or crowd benchmark. The final main bundle is 795.80kB minified / 220.18kB
gzip and retains Vite's existing chunk-size warning.

Screenshots and the appearance report are in `artifacts/appearance/`. Physical
phone GPU performance remains unmeasured; phone checks emulate a viewport on
the laptop. Earlier movement benchmark numbers above predate this art update.

## Event and privacy behavior

- A private proposal creates no public wedding. Both participants must explicitly
  consent before an event, queue entry or invitation exists.
- Family/friend membership needs couple approval and separate invitee acceptance.
  Public links grant no membership. The prototype caps priority places at 16,
  with at most eight per side; permissions depend on the event and current phase.
- Both participants must reach the ready circle and confirm within 60 seconds.
  Missing readiness or a required couple action cancels the ceremony. Optional
  family roles do not block completion.
- Server-controlled entrance choreography and India's seven-step action run on
  the authoritative timeline. Ordinary spectators retain their own movement and
  camera choices. Overflow observes the same event and its actual participants.
- Completion validates actions and signs evidence, then removes the event,
  invitation, roles, queue entries and pending event messages. Cancellation and
  expiry also delete them, without certificates. Unrelated guest sessions remain.
- Keepsakes are generated locally from evidence already delivered to the couple.
  A participant disconnected during completion may miss the evidence; there is
  no post-deletion server recovery. Refreshing also loses unsaved evidence.
- Certificates contain the exact required entertainment disclaimer. Signatures
  attest game-issued data and have no legal marriage status. Offline verification
  requires an independently trusted public key.

## Verification results

| Check | Observed result |
| --- | --- |
| Backend suite | **45 passed** with `python -m pytest -q`. |
| Movement logic | **11 groups passed**: 30/60/120 FPS, delayed/jittered snapshots, monotonic clock, turns/stops, collision/access, relocations, remote interpolation and six public routes. |
| Actual map journey | Five model close views and animation bounds checked; full public route to Japan completed in 36.38s without a teleport; no browser/console errors. |
| TypeScript and production bundle | `npm run build` passed, including TypeScript checking. |
| Python-served production app | Bundled assets, real WebSocket guest entry, absent development hooks, healthy authority and expired invitation HTTP 410 passed on port 8000; no browser errors. |
| Desktop/mobile browser smoke | Entry, independent sessions, desktop walking, touch movement pad, directory, map and three normal cameras passed; no browser errors. Mobile viewport: 390 × 844; desktop: 1440 × 900. |
| Complete browser wedding | Mutual consent, no premature event, SSR invitation, accepted role, public-link isolation, existing-session resume, both-ready controls, couple/optional-role actions, live camera enter/exit, signed downloads and immediate cleanup passed; no browser errors. |
| All five certificate layouts | Valid evidence accepted; tampered payload and wrong public key rejected. All PNGs measured 2480 × 3508 and were visually reviewed. |
| A4 PDF | Export rendered with Poppler and visually checked. One A4 page; Vietnamese names and exact disclaimer readable. |
| Multiprocess tests | Six actual spawned zone processes; fenced ownership, interrupted transfer, identity/role/event/phase preservation and remote spectator subscriptions covered. Redis operations use a TCP fakeredis Lua emulator in tests. |
| Dependency audits | npm audit, production pip-audit and development pip-audit reported zero known advisories at verification time. `pip check` found no broken requirements. |
| Container configuration | `docker compose config --quiet` passed. Docker daemon was unavailable, so image build and Compose runtime were not verified. |

The complete browser ceremony uses an isolated test authority. Its harness
positions fixture participants and advances the actual configured ceremony
clock; consent, roles, ready actions and ceremony actions use the browser UI.
Normal movement is checked separately. Production programs keep their full
durations and expose no test completion, teleport or clock endpoint.

The backend suite covers the five program outcomes, route connectivity,
protected areas, consent/idempotency, roles/seats, readiness/timeouts, simultaneous
districts, deletion, forged/stale messages, reconnects, bounded transport,
ownership fencing and handoff. One Starlette/httpx TestClient deprecation warning
remains in the test tooling.

### Browser graphics sample

After the model/UI upgrade, the dedicated browser runner reported **60 FPS**
in both its desktop and phone viewport samples, using ANGLE Direct3D11 on an
**NVIDIA GeForce RTX 3050 6GB Laptop GPU**. Desktop viewport: 1440 × 900,
389 draw calls and 393,336 triangles. Phone viewport: 390 × 844, 109 draw calls
and 202,556 triangles. The samples contain a small number of actual connected
guests, with different camera positions and fields of view. The phone sample
uses the same laptop GPU; it does **not** measure a phone GPU.

The default general browser smoke runner forces SwiftShader for reproducibility;
`PLAYWRIGHT_NATIVE_GPU=1` allows the native GPU. The upgrade runner records its
actual renderer and results in `artifacts/upgrade/checks.json`. These local
samples establish neither crowded-event capacity nor low-end/physical mobile
performance. Phone validation uses browser device emulation.

## Local moving-client load measurements

Hardware: Windows 11 build 26200, Intel Family 6 Model 151 Stepping 2, eight
physical/twelve logical CPU cores, 19.78 GiB RAM, Python 3.12.14. Both clients and
server ran on the same laptop over loopback.

Scenario: one authoritative world, temporary memory, Redis disabled, no active
weddings, synthetic guests concentrated near the plaza and sending normalized
movement input at 25 Hz. These are actual HTTP/WebSocket sessions and real
acknowledgements, but they do not run browser rendering. Load-test session limits
are raised only in the isolated test server. This is a short local test.

| Metric | 20 moving clients | 100 moving clients |
| --- | ---: | ---: |
| Connections accepted / attempted | 20 / 20 | 100 / 100 |
| Connection failures | 0 | 0 |
| Measurement duration | 15.24 s | 31.03 s |
| Movement acknowledgement p50 / p95 | 48.73 / 60.50 ms | 67.32 / 110.92 ms |
| Movement acknowledgement samples | 2,399 | 24,463 |
| Control round trip p50 / p95 | 4.59 / 6.66 ms | 28.49 / 68.39 ms |
| Control samples | 100 | 1,000 |
| Simulation work p50 / p95 | 0.76 / 2.80 ms | 11.57 / 21.47 ms |
| Maximum simulation work | 2.89 ms | 56.60 ms |
| Measured simulation cadence | 20.01 Hz | 19.24 Hz |
| Aggregate outbound application payload | 153.37 KiB/s | 3,161.80 KiB/s |
| Snapshot messages received | 2,414 | 25,497 |
| Largest visible guest count | 20 | 96 |
| Mean server CPU, one-core scale | 7.29% | 39.68% |
| Peak summed server RSS | 66.24 MiB | 81.16 MiB |

CPU and memory include the Windows virtualenv launcher and its actual Python
child, not two independent world authorities. Application payload counts exclude
TCP/WebSocket/TLS framing and include the warm-up interval. At 100 clients the
maximum tick exceeded the 50 ms target budget, and cadence fell below 20 Hz.
The configured 500-session admission cap is not a measured capacity claim.

Active-event throughput, invitation delivery under load, ceremony start
deviation, handoff failure rates under load, long soaks, WAN latency and
multi-host behavior have **not** been measured. The physical audience limit of
40 and priority limit of 16 are provisional rules, not proven crowd rendering
capacity. There is no 1,000-, 10,000- or 100,000-CCU result.

Reproduce the measured scenarios with:

```powershell
.\.venv\Scripts\python.exe -m scripts.load_check --clients 20 --seconds 15
.\.venv\Scripts\python.exe -m scripts.load_check --clients 100 --seconds 30
```

## Current operational limits

The default deployment has one gateway/world authority. The optional six motion
workers communicate over local IPC while the gateway retains identity, events
and scheduling. This demonstrates separate-process ownership and handoff; it is
not a multi-host edge routing or regional deployment. It does not automatically
restart crashed zone workers or restore live ceremonies after authority loss.
An expired owner fails closed, and a replacement authority abandons old events.

The Docker setup uses Redis without disk persistence. Tests do not substitute for
a real Redis/container failure exercise. Public hosting, HTTPS/WSS, reverse-proxy
configuration, production monitoring and external social-crawler checks remain
deployment work; no public domain was deployed here. Local invitation URLs work
only where the local server is reachable.

Further product work includes complete production art/animation, Stage B/C
compounds when justified, advance calendar booking if desired, stronger crowd
and bandwidth tuning, physical mobile testing and progressively larger measured
distributed trials. Current reservation scheduling covers the live FIFO queue,
with alternative free gardens offered through a fresh consent flow. PDF exports
are image-based A4 pages, without selectable text or tagged PDF accessibility.

## Where to inspect the evidence

`artifacts/` is ignored and contains local QA outputs, not application history:

- `browser-smoke-result.json` and desktop/mobile screenshots.
- `production-smoke-result.json` and `production-world.png` for the built app.
- `ceremony-browser-result.json`, live ceremony screenshots and deliberate test
  downloads `certificate-vietnam.pdf`, `.png` and `.json`.
- `certificate-layout-result.json` and five certificate layout PNGs.
- `native-render-check.json`, `load-20.json` and `load-100.json`.
- `upgrade/checks.json`, `upgrade/production-checks.json` and the upgraded
  desktop/phone screenshots, district previews and saved photographs.
- `movement-rework/before.json`, `final.json`, `final-delay.json` and raw motion
  traces (the final mask rendering is recorded in `final-clean.json`);
  `map-checks.json` for the actual public journey and `model-checks.json`
  for the final close model inspection. Screenshots show the warm palette.
- `movement-rework/occlusion-checks.json` and off/on images for foreground-tree
  visibility with native MSAA and a browser context without antialiasing.
- `python-audit-patched.json` and `python-dev-audit.json` for the final Python
  dependency audits. Earlier audit files, if present, predate dependency fixes.

Run instructions, configuration and verification commands are in
[README](../README.md); protocol, cleanup and ownership details are in
[Architecture](ARCHITECTURE.md).
