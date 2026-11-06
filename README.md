# Wedding World

A runnable, temporary multiplayer wedding park built from
`WEDDING_WORLD_V3_MASTER_PROMPT.md`. Five connected Three.js districts share one
authoritative Python world. Guests are real WebSocket connections; NPCs are
the registrar and venue guides. No accounts, fabricated visitors, or wedding history.

## Run locally

Requirements: Node.js 22.12+ (24 used here), Python 3.12+, a WebGL browser.
Use one Python authority. Redis is optional in the default mode.

The dependencies and `.venv` are already installed in this workspace. To start
both development processes after stopping any existing instances:

```powershell
npm run dev:all
```

Open **http://127.0.0.1:5173** for development. The launcher uses the local `.venv`
and `.env`. It launches Vite plus Python; all game logic runs in Python.

On a fresh Windows checkout:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend/requirements-dev.txt
npm ci
.\.venv\Scripts\python.exe scripts/setup_env.py
npm run dev:all
```

On macOS/Linux, use `python3 -m venv .venv` and `.venv/bin/python` in place of
the Windows Python paths. The Node launcher detects either layout. Python 3.12
is the tested version.

### Built app, invitations and social previews

```powershell
npm run build
.\.venv\Scripts\python.exe -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000 --workers 1 --ws-max-size 8192 --ws-max-queue 16 --no-access-log --env-file .env
```

Open **http://127.0.0.1:8000**. Python serves the built UI, assets, HTTP API,
WebSockets, and `/w/{slug}` social metadata from one origin. The Vite development
server proxies API/WebSockets; social crawlers should use the Python-served
built app. A localhost invitation is only reachable on this computer.

### Docker Compose

With Docker running, and ports 8000/6379 free as applicable:

```powershell
docker compose up --build
```

Open **http://localhost:8000**. Redis stays on the internal container network,
with persistence disabled. The app uses one Uvicorn worker and a non-root user.
`docker compose config --quiet` was verified here; container startup was not
tested because the Docker daemon was unavailable.

For public hosting, put this app behind an HTTPS/WSS reverse proxy, set
`PUBLIC_ORIGIN` and `ALLOWED_ORIGINS` to the actual public origin, and keep the
private completion key server-side. Serve both `/api` and `/ws` through that
origin. Configure trusted proxy addresses explicitly if enabling proxy headers.
Do not cache invitation/API responses or log guest tokens and request bodies.
No public host or domain has been deployed by this implementation.

## Try a wedding

1. Open two separate browser profiles, private windows, or devices. Each person
   chooses a temporary nickname, female/dress or male/suit, and a clothing color.
2. Walk to the registrar beside the central ring fountain, using the map or **Plan a wedding**.
   Exchange the six-character guest codes beside your nicknames.
3. One person chooses a district and explicitly consents. The other receives a
   separate consent request. A wedding and public invitation exist only after
   both agree.
4. Use **Our group** to invite temporary family/friend roles. Each invitee accepts
   separately. There are 16 priority places, at most eight per side.
5. When called, both people reach the ready circle and confirm within 60 seconds.
   From the plaza, the public route takes roughly half a minute. Missing either
   confirmation cancels the reservation and advances the queue.
6. The server guides the entrance procession. Complete each required couple
   action during its moment. Called optional roles may walk onto the stage and
   perform their gesture; missing optional roles never block the couple.
7. Successful completion sends signed evidence to the two connected browsers.
   Save the A4 PDF, high-resolution PNG, and optional evidence JSON before refresh.

Guests can follow a wedding from the directory, arrive through its public link,
walk away at any time, and choose their own camera. A public link grants no
family role. Full public rows offer an optional view of the same event timeline.
District reception activities are available in the separate reception gardens.

### Controls

| Action | Desktop | Mobile |
| --- | --- | --- |
| Walk | WASD / arrows / click a path | Movement pad or click a path |
| Walk to a destination | Map or directory | Map or directory |
| Orbit / look | Drag scene | Drag scene |
| Zoom | Mouse wheel / camera settings | Camera settings |
| Normal cameras | V or camera buttons | Camera buttons |
| Optional live ceremony view | C or camera button | Camera button |
| Registrar | E / click desk / Plan a wedding | Plan button / desk |
| Program | District board / directory | District board / directory |

Reduced motion follows the device preference and can be changed in settings.
Audio is an optional, quiet procedural chime enabled by the guest.

## Environment

Copy `.env.example` or run `scripts/setup_env.py`; the script creates a private
Ed25519 key without printing it. `.env` is ignored by version control and Docker.

| Variable | Purpose / default |
| --- | --- |
| `PUBLIC_ORIGIN` | Absolute URL for Python-generated social metadata. Default `http://localhost:8000`. |
| `ALLOWED_ORIGINS` | Exact comma-separated HTTP/WebSocket browser origin allowlist. Local 5173/8000 defaults. |
| `COMPLETION_PRIVATE_KEY` | Base64 of 32 private Ed25519 bytes. Empty generates a temporary boot key. Keep private. |
| `REDIS_URL` | Empty uses temporary memory; otherwise Redis URL for coordination. |
| `REDIS_PREFIX` | Namespace and local authority lock. Default `wedding-world`. |
| `WORLD_ZONE_WORKERS` | `0` default. `1` starts six experimental zone processes and requires Redis. |
| `MAX_GUESTS` | Bounded temporary session admission, default 500; a configured limit is not tested capacity. |
| `SESSION_RATE_LIMIT` | Arrivals per source IP per minute, default 30. Adjust for a controlled test/proxy environment. |
| `WEDDING_PYTHON` | Optional Python executable override for `npm run dev:all`. |

No refresh token, account database, analytics identifier, permanent wedding
record, or server-side keepsake upload is created. A session secret is held in
that tab's `sessionStorage` for reconnects. Session expiry is 120 seconds after
disconnect. Couples have 90 seconds to reconnect while queued/assigned and 45
seconds while active; both must be connected at successful completion.

Events are explicitly deleted at completion/cancellation/expiry. Venue cooldown
and unrelated temporary guests remain. Redis's 180-second TTL is a crash fallback,
refreshed while healthy. No post-event retrieval is available. A disconnected
participant can miss completion evidence. Old invitations return a generic 410,
without distinguishing completion from cancellation.

## Verify

```powershell
npm run build
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe -m scripts.browser_check
.\.venv\Scripts\python.exe scripts/upgrade_check.py
node scripts/movement_check.mjs
.\.venv\Scripts\python.exe -m scripts.map_check
.\.venv\Scripts\python.exe -m scripts.movement_profile --label current
.\.venv\Scripts\python.exe -m scripts.load_check --clients 20 --seconds 15
.\.venv\Scripts\python.exe -m scripts.load_check --clients 100 --seconds 30
```

Install a test browser with `.venv\Scripts\python.exe -m playwright install chromium`
if needed. `PLAYWRIGHT_CHROMIUM_EXECUTABLE` can select an existing Chromium.
Browser smoke checks expect the app on 5173 with Python on 8000. `TEST_URL`
overrides the smoke URL. They create genuine temporary test sessions.
`scripts.upgrade_check` also checks the loaded guest rig, independent cloned
skeletons/colors, live walking animation, two-finger input ownership, input
cancellation, camera choices, map routes and photo downloads. It uses the native
desktop GPU when available and records the renderer in `artifacts/upgrade/checks.json`.
Phone checks emulate a 390 × 844 viewport. Set `PLAYWRIGHT_NATIVE_GPU=1` to use
the same GPU preference with the other browser runners; their default is SwiftShader.

`movement_check.mjs` covers 30/60/120 FPS prediction, delayed authority, clock
jitter, turns/stops, collisions, permissions, relocations, remote interpolation
and public route shortening. `map_check` inspects all five actual environments,
checks animated culling bounds, and walks a full public route without a teleport.
Use `--models-only` for just the model inspection. `movement_profile` measures
frame pacing and rendered speed under continuous desktop/touch input; add
`--delay-ms 110` to delay incoming WebSocket messages. These native GPU checks
use phone viewport emulation, not physical mobile hardware or a rendered crowd.

The complete ceremony browser check needs Vite on 5173 and **port 8000 free**:

```powershell
.\.venv\Scripts\python.exe -m scripts.ceremony_check
```

It owns an isolated Python server. The harness positions fixtures and advances
its clock through the real configured program; there is no production testing
endpoint or shortened public ceremony. Screenshots, downloads, and JSON results
are written to the ignored `artifacts/` directory.

Load tests start an isolated server on port 8001 by default, raise its test-only
arrival limit, send 25 Hz movement input, and collect real acknowledgements. They
do not render browsers. Use `--url` only against an authorized test world.

For offline evidence verification:

```powershell
.\.venv\Scripts\python.exe -m scripts.verify_evidence downloaded-evidence.json --public-key YOUR_TRUSTED_BASE64_PUBLIC_KEY
```

Save the public key from `/api/config` during the event or publish it separately
for your deployment. The key inside an untrusted JSON file alone does not prove
who issued it. The signature verifies game completion data, with no legal status.

## Source map and current scope

- `src/`: rendering, prediction, four cameras, UI, invitation flow, local export.
- `shared/world.json`: geometry/access data and five ceremony programs used by both stacks.
- `backend/app/`: sessions, world rules, transport, signatures, Redis coordination, optional zone processes.
- `backend/tests/`: lifecycle, protocol, HTTP, fencing and real-process tests.
- `scripts/`: reproducible assets, browser checks, load client, setup and verification.
- [Architecture and protocol](docs/ARCHITECTURE.md)
- [Culture references and asset provenance](docs/CULTURE_AND_ASSETS.md)
- [Implementation report and measured limits](docs/IMPLEMENTATION_REPORT.md)

Phases A–F are runnable as a stylized playable prototype. Phase G is an
experimental one-host process partition; Phase H currently covers local 20/100
moving connection checks. Multi-host routing, automatic zone crash recovery,
additional Stage B/C compounds, large-scale crowd tuning, and 1,000–100,000 CCU
validation remain future work. The current original stylized art includes a
two loaded 18-joint guest GLBs (dress and suit), ten animation clips and procedural venue details.
Regenerate the character with `npm run assets:guest`; the source and asset
provenance are documented in [Culture and assets](docs/CULTURE_AND_ASSETS.md).

The entry preview offers six clothing swatches plus a custom color picker.
Clothing color does not change skin color. The selection is temporary session
state, shared with nearby guests and restored on reconnect. Venue NPCs use the
same upgraded models with district clothing. Botanical silhouettes now differ
across all five gardens and the magnolia-lined central plaza.
Check selection, replication, reconnect and both models' animation bounds with
`.\.venv\Scripts\python.exe -m scripts.appearance_check` while the app is running.
