# Wedding World V3 — Master Implementation Prompt

## Status and precedence

This document consolidates the original Wedding World V2.0 specification and the subsequent product, map, gameplay, lifecycle, and technology decisions agreed on November 5, 2026.

Use this document as the standalone source of requirements. It supersedes conflicting earlier prompts, including requirements to use Colyseus and to retain wedding data after completion. Explicit user decisions take precedence over prototype defaults.

Implement the product progressively. Keep it runnable after each phase. Do not represent planned features, simulated visitors, or untested capacity as working functionality.

## 1. Product vision

Build a browser-based, multiplayer, three-dimensional wedding world for desktop and mobile.

The experience is a connected public wedding park where players can explore cultural districts, encounter real public ceremonies, participate in permitted activities, and continue to another wedding.

Mandatory principles:

- One logical public world with five culturally distinct districts: Vietnam, Japan, South Korea, India, and Italy.
- All players begin as temporary guests.
- No account registration, persistent player profiles, or permanent wedding history.
- A central Wedding Registrar NPC handles wedding registration.
- Both participants must explicitly consent before a wedding event is created and made shareable.
- Weddings take place at public venues in the world.
- Friends may form a temporary wedding group and accept family or friend roles before the ceremony.
- Movement and interactions inside a venue are restricted by area permissions.
- The server owns movement validity, roles, scheduling, ceremony state, and completion.
- Guests may move freely through public paths and permitted viewing areas, join late, and leave at any time.
- Watching a ceremony must not force a cinematic camera or an unskippable guest cutscene.
- Event data remains valid during the event and is deleted when the event ends or is cancelled.

## 2. Mandatory technology stack

### Frontend

- Three.js for 3D rendering.
- TypeScript for application and game code.
- Vite for development and frontend builds.
- Browser WebSocket connections to the Python backend.
- GLB/glTF assets, with Blender as an asset-authoring tool where appropriate.
- Client-side certificate preview and PDF/PNG export from server-issued completion evidence.

### Backend

- Python for application services and authoritative game logic.
- FastAPI for HTTP endpoints and WebSocket handling.
- Uvicorn as the ASGI server.
- asyncio for connection handling and scheduled game updates.
- Redis for temporary event/session coordination, queues, venue reservations, and shared state when needed.
- Docker Compose for the initial backend and Redis deployment.
- pytest for backend verification, plus a WebSocket load client and browser tests where appropriate.

Colyseus is replaced by the Python multiplayer implementation. Do not introduce a Node.js game server as a hidden dependency. Node.js-based frontend build tools are acceptable.

FastAPI provides transport and HTTP infrastructure, not a complete multiplayer engine. Implement state synchronization, interest management, authoritative simulation, reconnect handling, and zone transfers explicitly.

Start with one modular Python application and one authoritative game process. Organize modules around guest sessions, world simulation, wedding groups, wedding coordination, and invitations/keepsakes. Split processes only when required by measured load or the distributed implementation phase.

Do not assume that adding Uvicorn workers shares Python memory or automatically distributes a world. CPU-heavy work must not block the network/game event loop.

## 3. Authoritative multiplayer model

### Client responsibilities

- Rendering, camera control, animation playback, and effects.
- Input collection and responsive local movement prediction.
- Interpolation of remote players and reconciliation with authoritative corrections.
- User interfaces, invitation sharing, and local keepsake export.

### Server responsibilities

- Validate input, movement speed, collisions, allowed paths, and area access.
- Maintain authoritative positions and event participation.
- Validate consent, invitations, group membership, roles, and stage access.
- Own queue ordering, reservations, ready checks, ceremony transitions, and completion.
- Reject forged role changes, position updates, completion requests, and unauthorized interactions.

Use simplified collision and traversability data suitable for the map. Client visual geometry and server collision/access data must come from compatible map definitions so they do not disagree about doors, boundaries, or walkable routes.

Use approximately 20 simulation updates per second as an initial tuning target, not a performance guarantee. Rendering runs independently. Separate simulation frequency, input frequency, and state broadcast frequency.

Implement sequence numbers, bounded message sizes/rates, backpressure handling, and authoritative snapshots for reconnects and late arrivals. Discard superseded movement updates rather than allowing an unbounded backlog. Use a versioned protocol with compact binary movement/state messages; control messages may use JSON.

## 4. Overall world masterplan

### 4.1 Connected spatial structure

The world consists of:

1. A central Meeting Plaza.
2. A continuous, bidirectional public promenade connecting all five districts.
3. Direct public shortcuts between each district and the plaza.
4. Public ceremony compounds attached to the promenade.
5. Landscape buffers and reserved land for additional public stages.

Relative positions are fictional game-map positions, not a representation of real-world geography:

| Position | District |
| --- | --- |
| West | Vietnam |
| Northwest | Japan |
| Northeast | South Korea |
| East | India |
| South | Italy |

The complete promenade connects Vietnam ↔ Japan ↔ South Korea ↔ India ↔ Italy ↔ Vietnam. Players may travel either way and need not return to the plaza between visits.

### 4.2 Meeting Plaza

Include:

- Distributed arrival points around the plaza edge.
- The Wedding Registrar NPC in a recessed interaction area beside the main circulation path.
- A global wedding directory with event status, district, assigned venue when available, and directions.
- An invitation preparation/share point for mutually consenting couples.
- Seating, an introductory photo spot, and a recognizable central tree or landmark.
- Visible routes to each district.

Keep NPC interaction groups out of crossroads. Guests arriving through a wedding invitation may enter the destination district directly rather than passing through the plaza.

### 4.3 District transitions

| Connection | Transitional landscape |
| --- | --- |
| Vietnam–Japan | Bamboo garden, bridge, and timber paths |
| Japan–South Korea | Stone garden, low planting, and resting space |
| South Korea–India | Flower garden and paved courtyard |
| India–Italy | Flower pergolas and low terraced gardens |
| Italy–Vietnam | Waterside promenade |

Use consistent world lighting, weather, and readable navigation. Change planting and materials gradually. Concentrate culturally specific motifs within their district boundaries.

Transitions must preserve physical path continuity. They must not be unexplained teleports or require players to cross a ceremony. Place a visible destination gate or directional landmark at the end of each main path segment.

### 4.4 Initial blockout dimensions

These are prototype targets to verify with a playable 3D blockout, not final measurements or capacity claims:

| Element | Initial target |
| --- | --- |
| Full five-district world extent | Approximately 500–550 meters across |
| Central plaza | Approximately 60–70 meters in diameter |
| Main promenade | Approximately 6–8 meters wide |
| Secondary public paths | Approximately 3–4 meters wide |
| One ceremony compound | Approximately 50 × 70 meters, including preparation and post-ceremony spaces |

At an assumed walking speed of roughly 4 meters/second, aim for approximately 20–30 seconds from the plaza to a district entrance. Adjust distances after testing orientation, mobile controls, sightlines, and crowd circulation.

Provide step-free routes and adequate camera clearance. Every usable doorway must have a purpose and an accessible connection. Decorative buildings must not present misleading usable entrances.

## 5. Shared district and venue layout

Each district has distinct architecture and geometry but a consistent functional sequence:

District entrance → public reception forecourt → preparation → ready-check area → ceremonial entrance/procession → ceremony → congratulations → public reception/photo garden → promenade.

| Space | Contents and purpose | Connection |
| --- | --- | --- |
| District/venue gate | District identity, stage identifiers, directions, event program | Reception forecourt |
| Public reception forecourt | Event board, social space, wedding-group meeting point | Public viewing route or authorized preparation route |
| Preparation rooms for both sides | Clothing, ceremony props, role gathering | Ready-check and procession route |
| Ready-check area | Couple gathering positions and 60-second confirmation interface | Ceremony entrance after both confirmations |
| Procession/entrance route | Culture-specific approach inside the compound | Authoritative ceremony positions |
| Ceremony stage | Couple, officiating NPC, relevant props, controlled role participation | Side exit and congratulations area |
| Priority seating | Two groups associated with the couple's two sides | Controlled aisles and designated ceremony access |
| Public viewing area | Seating/standing behind priority rows, side viewing terrace | Late-arrival path and public exit |
| Reception and photo garden | Socializing, dancing, photographs, keepsake access | A second public connection to the promenade |

Additional rules:

- Public bypass paths remain open while ceremonies run.
- Public circulation must not cross between the couple and front-row family seating.
- Preparation rooms primarily serve the next assigned wedding. Other queued couples may explore or gather in public areas.
- Priority seating has finite capacity: parents nearest the ceremony, siblings next, then approved friends within the venue limit.
- Provide separate routes for public viewing and controlled ceremony entry. Shared public junctions must remain outside the active ritual area.
- Keep reception sound separated or attenuated so it does not overwhelm the next ceremony.
- Place public Stage B/C expansion sites along existing circulation, with their own identifiable entrances and sufficient preparation/seating space.
- Reserved expansion land must not be represented as an active, implemented venue.

## 6. District designs and culturally distinct programs

Do not implement five copies of one generic ceremony with different colors.

Each district needs its own architecture, costume references, props, dialogue, animations, ceremony configuration, guest activities, invitation art, and certificate design.

Research and document the particular traditions represented. Treat religious ceremonies respectfully, provide symbolic representations, and do not claim authentic religious officiation or universal national practice.

### 6.1 Vietnam

Spatial sequence:

Betel-and-areca-themed entrance → brick reception courtyard → preparation rooms for both sides → short procession route → ceremonial house and ancestral-respect courtyard → waterside reception garden → photo garden.

Design:

- Courtyard architecture, red/gold wedding decoration, wedding gate, ceremonial altar, decorative gift trays, and Vietnamese-inspired banquet space.
- Preparation rooms flank the forecourt.
- The ceremonial house anchors the main sightline.
- Family seating is closest to the ceremony; ordinary guests use the rear courtyard and side veranda.
- The bamboo-garden exit continues toward Japan; the waterside connection leads toward Italy.

Program:

1. Guest gathering and role preparation.
2. Symbolic betrothal-gift presentation and procession.
3. Symbolic ancestral respect and gratitude to family.
4. Couple acknowledgment/commitment.
5. Congratulations and the scheduled group photograph.
6. Optional public reception activities.

Actions include carrying trays, joining the procession, respectful bows, congratulations, petals, and photographs. Use researched ao dai and wedding clothing references. Specify the cultural/regional inspiration rather than claiming one universal Vietnamese ceremony.

### 6.2 Japan

Spatial sequence:

District gate → reception garden → preparation house → gently winding garden procession → wooden ceremonial platform → social veranda → photo garden → stone-garden transition to South Korea.

Design:

- Shrine-inspired timber architecture, garden paths, ceremonial approach, and traditional garden.
- Public paths run beside the procession near the venue rather than through it.
- Side verandas allow observation without entry to the ritual route.
- Put photo gathering points beyond the ceremony entrance to prevent entrance congestion.

Program:

1. Gathering and formal procession.
2. Symbolic purification.
3. Symbolic san-san-kudo cup exchange.
4. Wedding commitment.
5. Closing procession, congratulations, and scheduled photographs.

Use researched traditional attire, including shiromuku-inspired clothing. Clearly describe this as a selected Shinto-style inspiration, not every Japanese wedding.

### 6.3 South Korea

Spatial sequence:

District gate → outer gathering courtyard → preparation wings → inner courtyard and ceremony table → congratulations veranda → reception courtyard → photo veranda → flower-garden transition to India.

Design:

- Hanok-inspired wings frame the courtyard.
- Place the ceremony table and folding screens at its focal end.
- Family seating is near the table; public viewing occupies the rear court and covered side circulation.
- A side bypass connects the outer forecourt to the reception area.

Program:

1. Gathering.
2. Jeonallye-inspired wooden goose presentation.
3. Gyobaerye bow exchange.
4. Hapgeullye symbolic cup sharing.
5. Couple acknowledgment, congratulations, and scheduled photographs.
6. Celebration; optional Pyebaek-inspired activity where culturally appropriate.

Research attire such as hwarot/wonsam and samogwandae. Document the selected Honrye references.

### 6.4 India

Spatial sequence:

Floral gate → procession assembly courtyard → clothing/garland preparation → mandap → dance and reception courtyard → photo garden → pergola transition to Italy.

Design:

- Use a clearly selected Rajasthan-inspired Hindu wedding tradition.
- Include floral garlands, rich textiles, a decorated mandap, and a procession assembly space.
- Provide a clearly controlled mandap boundary, family seating nearby, and public viewing outside it.
- Separate the dance courtyard acoustically from the ritual area.

Program:

1. Procession and couple arrival.
2. Jaimala garland exchange.
3. Symbolic sacred-fire ceremony.
4. Pheras/Saptapadi-inspired vows and steps consistent with the specific tradition selected.
5. Blessings, congratulations, and scheduled photographs.
6. Optional dance celebration.

Do not invent sacred chants, turn sacred actions into disruptive challenges, or present this as the only Indian wedding style.

### 6.5 Italy

Spatial sequence:

Garden gate → villa preparation wing → garden aisle between seating → civil-style ceremony platform → reception/cake/gift courtyard → photo pergola → waterside promenade back to Vietnam.

Design:

- A villa forms the backdrop to an axial garden ceremony.
- Late arrivals use paths outside the seating rows.
- Place cake, favors, dining, and dancing beside the ceremony garden.
- Keep the aisle controlled during the entrance procession.

Program:

1. Guest arrival and couple entrance.
2. Officiant introduction and vows.
3. Ring exchange.
4. Congratulations and scheduled group photograph.
5. Optional cake, bomboniere/confetti favor interaction, and reception dancing.

Confetti here means sugared almonds. Do not substitute paper confetti as the cultural favor or describe local practices as universal Italian requirements.

## 7. Temporary wedding groups and roles

After mutual wedding consent, allow the couple to create an event-scoped group and invite friends before the ceremony.

Supported roles:

- Father and mother for each side.
- Brothers, sisters, and other sibling roles.
- Friends.

The couple assigns or approves a role, and the invited player accepts it. Guests cannot self-grant a role or priority access. Public wedding links never grant privileged membership by themselves.

Requirements:

- Roles are scoped to one wedding event and temporary guest session.
- Validate capacity before confirming a priority place; do not promise unlimited reserved seating.
- Enforce assigned seats/areas and ceremony actions on the server.
- A role grants only the access needed for that role and phase.
- Permit stage entry only when the ceremony calls that role, followed by return to the designated area.
- Freeze or safely validate role changes once the ceremony begins.
- Missing family/friend roles must not block the wedding. Optional guest actions must not delay the schedule.
- End group memberships and role privileges when the wedding ends or is cancelled.

## 8. Movement permissions and non-disruption

| Area | Permission |
| --- | --- |
| Promenade, public forecourt, public reception | All guests, subject to capacity |
| Public viewing rows, side terraces, overflow viewing | Ordinary guests |
| Priority seats and controlled preparation spaces | Approved group members according to role and phase |
| Active ritual stage/procession | Couple, relevant NPCs, and explicitly called roles |

Validate bounds, access, and interactions on the authoritative server. Prevent walking onto the stage, blocking the procession, pushing performers, triggering other players' ceremony actions, or using disruptive effects in protected areas.

Provide appropriate congratulations/emotes with cooldowns. Guest-to-guest collisions must not allow physical obstruction of ceremonies. Keep public arrival/exit paths usable throughout the ceremony.

When access is revoked, provide an exit and, if necessary, place remaining occupants at a designated public position. Do not leave players trapped behind a gate or inside a now-forbidden area.

## 9. Scheduling, timing, and readiness

### 9.1 Initial Vietnam slot

Use a 10-minute stage slot:

| Segment | Duration |
| --- | --- |
| Both-participant ready check | Up to 60 seconds |
| Main ceremony, including congratulations and scheduled group photograph | 8 minutes |
| Exit and turnover | 1 minute |

Suggested internal eight-minute program: one minute entrance, four minutes cultural actions, one minute commitment, two minutes congratulations/group photograph.

Preparation, group formation, clothing selection, and invitation sharing happen before the slot. Optional social reception activities happen outside the ritual stage and do not extend its reservation.

Other districts may use a distinct, configured program duration. Advertise its full slot duration and schedule against that duration. Do not force culturally different programs into identical choreography or silently shorten accepted ceremonies when demand increases.

### 9.2 Mandatory ready-check rule

- When the couple's turn arrives, open a server-timed 60-second confirmation window.
- Both participants must confirm within that window and satisfy the venue's readiness conditions.
- Missing either confirmation at the deadline cancels the wedding, even if the other participant confirmed.
- Release the reservation, remove the cancelled event from queues/directories, invalidate its invitation/group privileges, and call the next eligible couple.
- A cancelled couple must register again for a new event.
- Friends' presence or confirmations are not prerequisites.
- A client countdown is informational; the server deadline decides the outcome.

Active disconnect behavior must be bounded and documented. Reconnects restore the current authoritative phase. Never silently reset a ceremony or award completion without satisfying the server's required participation/commitment conditions.

### 9.3 Queue management

- Coordinate queues per district/compatible venue, with one authoritative owner for reservations.
- Prevent double registration, double acceptance, double booking, and stale-worker transitions.
- Show estimated start information only when supportable.
- Let queued couples explore and notify them when they must return.
- Offer a different available venue/time without silently moving a couple to another cultural district.
- Separate audience capacity from wedding throughput: overflow viewing addresses spectators, additional public stages address ceremony demand.
- At a ten-minute slot, one stage has a theoretical ceiling of six weddings/hour before operational losses. Do not treat this as measured throughput.

## 10. Event states and immediate cleanup

Support these validated states:

`DRAFT → INVITE_PENDING → QUEUED → VENUE_ASSIGNED → READY_CHECK → CEREMONY_ACTIVE → COMPLETED`

Allow `CANCELLED` or `EXPIRED` from appropriate nonterminal states. Validate every transition; make duplicate commands harmless. Missing/deleted events must return an expired/unavailable outcome and must never be recreated by a delayed command.

`COMPLETED`, `CANCELLED`, and `EXPIRED` are finalization outcomes, not retained public wedding records.

### Completion ordering

1. Validate authoritative completion.
2. Create and send signed completion evidence to the couple, and notify connected participants of completion.
3. Revoke event-scoped access and move remaining restricted-area occupants into public circulation where necessary.
4. Release the venue into its turnover state; keep only venue availability/cooldown information needed for the next booking.
5. Remove the event, invitation mapping, queue entries, temporary group, roles, related messages, and references from shared/in-memory stores.

Do not wait indefinitely for a download acknowledgment before cleanup. Cancellation/expiry performs cleanup without issuing a completion certificate.

### Retention rules

- Event data is valid throughout its queued/active lifetime; TTLs must not expire a healthy ceremony mid-event.
- Use bounded session/event liveness and expiry handling to clean up abandoned events.
- Explicitly delete event data at completion/cancellation. A future TTL is only a fallback, not the normal end-of-event deletion mechanism.
- Do not retain a post-completion retrieval window, public completed-event page, permanent group, or wedding history.
- Do not accidentally retain copies in Redis Streams, retries, caches, or application logs after event cleanup.
- Preserve unrelated temporary guest sessions so players can continue exploring.
- Local keepsakes deliberately saved by players are outside server event retention.

After deletion, an old public link displays a generic expired/unavailable invitation message. Do not claim to distinguish completed from cancelled events using records that have already been deleted.

## 11. Shareable invitations

Create one unique public event and invitation only after both participants consent.

Temporary event fields include:

- Wedding ID and random public slug.
- Couple nicknames and district.
- Assigned venue when available.
- Queue, readiness, and ceremony state.
- Reliable estimated start information where available.

Public URL format: `https://your-domain.example/w/{publicSlug}`.

Never place session secrets, role credentials, or private access tokens in this public URL.

The mobile-first invitation page needs branding, couple names, district-specific decoration, venue/status, Join Wedding, Copy Link, device sharing where supported, and an optional QR code.

Serve social preview metadata from Python: `og:title`, `og:description`, `og:image`, and `og:url`. Use country-appropriate preview artwork and avoid retaining event-specific preview assets after cleanup.

Join flow:

1. Load the invitation and resolve its current state.
2. Ask for a temporary nickname if needed.
3. Connect to the shared world.
4. For an unassigned queued event, arrive at the district forecourt.
5. For an assigned/active event, route to that venue's public arrival point.
6. Apply priority access only if the temporary session has approved membership.
7. Offer a synchronized viewing area if the physical venue is full.

Handle invalid, deleted, cancelled, or expired links gracefully without login.

## 12. Virtual wedding certificates

Only authoritative successful completion enables a commemorative certificate.

Python signs a completion payload, preferably using Ed25519 with a server-held private key. The browser uses this payload for a responsive preview, printable A4 PDF, and high-resolution PNG. Support Vietnamese Unicode fonts and district-specific layouts.

Include branding, Virtual Wedding Certificate title, both nicknames, district, completion date/time, unique event reference, and optional offline-verifiable signature data.

Include exactly:

> Virtual ceremony keepsake. For entertainment only. Not a legal marriage certificate.

Never imitate government seals, official signatures, or identity documents. A signature verifies game-issued data, not real-world marriage status.

Do not permanently upload generated keepsakes. After immediate server cleanup, export is available only from completion evidence already received by the client or deliberately saved locally. Explain the delivery limitation: a player disconnected during completion may miss the payload and cannot retrieve it later from a deleted server record.

## 13. Camera system

Implement four modes:

- `THIRD_PERSON`: default follow camera, smooth orbit, adjustable zoom, collision avoidance.
- `FIRST_PERSON`: eye-level view, hide obstructing local character geometry, mouse/touch rotation, pitch limits.
- `ISOMETRIC`: elevated three-quarter perspective with rotation and zoom.
- `CINEMATIC_SPECTATOR`: optional ceremony viewpoints, smooth transitions, bounded camera positions, optional photo mode.

Controls: V cycles normal modes, C toggles available spectator mode, and mobile has accessible camera controls. Provide configurable transitions and reduced-motion support.

Camera movement never changes authoritative player position, grants area access, or changes wedding state. Spectator cameras must respect venue boundaries and must not require all guests to enter cinematic mode.

## 14. Crowd management and distributed scaling

100,000 concurrent worldwide connections is a long-term objective, not an initial capacity claim.

Never place the entire target population in one process, one simulation zone, or one fully synchronized crowd.

Design progressive support for edge routing, guest presence, spatial zone ownership, district scheduling, invitation delivery, event announcements, CDN assets, and operational metrics.

At the distributed stage:

- Partition the plaza and districts across Python processes as required by measured load.
- Give each zone and event a single authoritative owner.
- Use atomic reservations/transitions and ownership fencing so an expired owner cannot continue writing after takeover.
- Route WebSocket sessions to the correct owner; multiple generic ASGI workers are not a world partitioning strategy.
- Make zone handoff preserve guest identity, avatar, invitations, role membership, wedding registration, and current event phase.
- Use a transfer protocol that prevents duplicate presence/control and recovers from interrupted handoffs.
- Keep high-frequency movement in the owning process. Redis is not the per-frame movement broadcast bus for every avatar.
- Use Redis shared state for coordination and atomic decisions. Pub/Sub notifications are best-effort hints; recover from current authoritative state after missed messages.
- Limit global announcements and detailed avatar visibility. Aggregate reactions where useful.

Implement spatial interest management, nearby subscriptions, client prediction, interpolation, avatar LOD, bandwidth limits, prioritized updates, density controls, and adaptive synchronization rates.

When a venue reaches tested capacity, direct additional guests to public viewing terraces or lightweight synchronized spectator views. All views observe the same Wedding ID, participants, phase, and server timeline. Do not create separate copies of a wedding with independent outcomes.

Public Stage A/B/C venues are real locations on the shared map, not private per-wedding rooms. Preserve invited groups together where capacity permits; do not promise unlimited priority admission.

## 15. Interface and accessibility requirements

Provide:

- CameraModeSelector and CameraSettingsPanel.
- GlobalWeddingDirectory and directional guidance.
- WeddingInvitationPreview, SharePanel, and LandingPage.
- WeddingEventStatus and ReadyCheckPanel.
- WeddingGroupPanel, RoleInvitation, and RoleAssignment controls.
- VenueProgramBoard and clear access/capacity feedback.
- CeremonySpectatorUI.
- VirtualCertificatePreview and CertificateDownloadPanel.

Use district-specific visual identities with consistent interaction patterns. Avoid generic dashboard styling for the game experience. Support desktop/mobile controls, accessible labels, readable contrast, loading states, meaningful errors, reduced motion, and recovery after disconnection.

## 16. Acceptance tests

Implement tests with each relevant phase rather than deferring correctness until the final scaling phase.

### World and permissions

1. Public routes connect the plaza, district entrances, viewing areas, receptions, and exits without requiring traversal of an active stage.
2. The full five-district promenade is continuous and bidirectional when those districts are implemented.
3. Initial playable areas have a complete usable circulation loop; unfinished districts are clearly inaccessible rather than fake functional areas.
4. Ordinary guests cannot enter priority seating or ritual zones by modifying client position/messages.
5. Approved roles receive only their event- and phase-specific permissions.
6. Capacity checks prevent overbooking priority seating; missing optional roles do not block a ceremony.
7. Access revocation and finalization cannot trap players in restricted spaces.

### Events and groups

8. Mutual consent creates exactly one event and public invitation; repeated requests do not duplicate them.
9. Role assignment requires couple approval and invitee acceptance.
10. Possession of a public invitation alone grants no priority role.
11. Both participants must confirm within 60 seconds; zero or one confirmations cancel the event and free the venue.
12. Concurrent registration/reservation attempts cannot double-book a stage.
13. Late guests observe the current phase rather than restarting it.
14. Two independent venues/districts can run ceremonies simultaneously.
15. Reconnect and handoff preserve authoritative state without duplicate players or event actions.

### Cleanup, invitations, and certificates

16. Public invitations work without an account and route to the correct district/venue or waiting forecourt.
17. Queued, assigned, ready-check, and active states display correctly while data exists.
18. Completion/cancellation removes event records, public mappings, groups, roles, pending event messages, and queue references.
19. Old links return a generic expired/unavailable state after cleanup.
20. Deleted event requests cannot recreate data or restore privileges.
21. Successful completion issues verifiable evidence; clients cannot forge it and cancelled events receive none.
22. Received evidence supports A4 PDF and PNG export, appropriate decoration, Unicode, and the required disclaimer.
23. Export from already received client evidence still works after server event deletion; post-deletion server recovery is not promised.

### Cameras and performance

24. All four camera modes work on their intended platforms without changing authoritative movement or event state.
25. Guest cinematic viewing is optional and cannot bypass protected-area rules.
26. Snapshot recovery works after missed notifications or reconnects.
27. Slow clients do not cause unbounded send queues or stall other players/the simulation.
28. Multi-process tests demonstrate coordination and routing explicitly; tests must not assume shared Python memory.

Load-test progressively at 20, 100, 1,000, 10,000, and eventually 100,000 CCU only as infrastructure permits. Measure connection success/latency, movement latency, CPU/RAM, outbound bandwidth, event delay, queue correctness, start-time deviation, handoff failures, invitation delivery, ceremony synchronization, client FPS, and reconnection behavior.

Distinguish synthetic connection counts from realistic moving/interacting guests and from actual browser rendering. Report hardware, scenario, population distribution, limitations, and observed results. Never claim untested capacity.

## 17. Implementation sequence and deliverables

1. **Phase A:** Playable Vietnam blockout, plaza connection, a complete local public circulation loop, movement, and camera modes. Preserve planned expansion connections.
2. **Phase B:** Python authoritative multiplayer, real temporary guests, collision/access checks, and registrar interaction.
3. **Phase C:** Mutual consent, temporary wedding groups/roles, queues, reservations, 60-second ready check, and the Vietnam ceremony.
4. **Phase D:** Public invitation landing/share flow, direct event routing, and cleanup behavior.
5. **Phase E:** Signed completion evidence and local PDF/PNG keepsakes compatible with immediate event deletion.
6. **Phase F:** Researched additional districts, distinct ceremony programs, and the completed world promenade.
7. **Phase G:** Multi-process zone ownership, handoff, coordinated venues, and synchronized overflow viewing.
8. **Phase H:** Continued optimization and progressively larger distributed load tests.

Perform small functional/performance checks throughout all phases. Keep each phase runnable. Clearly separate working features from future plans.

Deliver working source code, appropriate automated tests, pinned dependencies, setup/run instructions, environment configuration documentation, asset provenance/cultural references, and an honest implementation report.

Do not replace missing functionality with fake online players, misleading counters, disconnected mockups, or unsupported scalability claims.
