# A public garden for private little moments

The world itself is the entrance: a miniature riverside wedding courtyard fills
the viewport, with an unhurried invitation to enter at the left. In play, the
landscape stays visible around a small navigation bar, a folding map, and a
single task panel. The directory is a drawer, never the default view.

Palette: river `#b8d9ce`, pine `#244e43`, leaf `#789a6d`, paper `#fbf8ee`,
rose `#bd626a`, sunlight `#e9cf9b`. Lora provides the invitation voice; DM Sans
keeps controls clear. Both fonts are bundled; Lora includes Vietnamese glyphs
for names and local dates on exported keepsakes.

```
┌ brand                         guide / sound ┐
│                                            │
│ A little world.       playable garden      │
│ A moment together.    miniature             │
│ nickname + enter                           │
│                          place / district  │
└ five connected gardens       explore       ┘
```

The signature is the built garden, rather than repeated interface cards. Country
identities come from researched architecture, props, symbolic programs, and
keepsake compositions. Circulation and server access use the same map data.
Quiet UI colors leave room for red lacquer, timber, tiled courtyards, marigolds,
and a green Italian garden. Public observation never takes over the camera.

## Model and interface upgrade · November 5, 2026

Desktop and phone have equal priority. The entry has a live 3D guest preview and
six appearance choices with 44 × 44 CSS-pixel buttons. The guest uses a soft,
rounded silhouette, a face, articulated hands and shoes, and a shared 18-joint
rig. Ten original animation clips blend between walking, rest and the chosen
gesture. Nearby guest names appear above their heads; the player's own name
stays in the HUD.

The HUD puts location and social actions at the top, a small world map at the
left, and one collapsible contextual panel at the right. Phone exploration starts
with the panel folded; a ready check or active couple ceremony opens it. Camera
choices sit behind a labelled toggle. Consents and role invitations remain
prominent. Dialogs and the directory pause movement and clear held input;
directory focus stays inside its drawer until it closes.

The map uses the actual shared world coordinates, public routes, registrar
location and player marker. A selected route appears on the map. Destination
walking times use the current path length and configured walking speed; they
are estimates. The larger map pairs the park drawing with six destination rows.

Photo mode hides the HUD, stops voluntary walking, and leaves camera orbit and
zoom available. Saving exports the renderer's canvas. The mode offers an
explicit exit and Escape support. Server choreography remains authoritative.

World details include branching tree canopies, petalled flowers, slatted benches,
path edging and lamps, roof ridges and trim, timber latticework, district signs
and original local venue ornaments. Lanterns sway gently when reduced motion is
off. No new walkable or protected areas were introduced.

## Map, color and movement refinement · November 6, 2026

The selected direction is warm, soft and romantic: ivory paving, dusty rose,
terracotta, warm timber, quiet green foliage and muted blue-green water. Neutral
tone mapping and brighter hemisphere lighting retain readable shadows. The
entry guest preview uses the same light colors and tone mapping as the world.

The plaza's central fountain and interlocking rings occupy the existing blocked
landmark footprint. A striped registrar awning, layered tree crowns, Japanese
blossom trees, Italian cypresses and visible water edges improve orientation.
Curved Asian roof shells have tile courses, rafters and eaves; India's main and
preparation canopies use curved fabric surfaces and seams. The Italian villa has
a closed gable, an arched door, stone trim and shutters. Suspended lanterns have
visible supports. Grass is below the level paving, so the connecting paths show.

Static surfaces are merged with vertex colors in 32m cells. Repeated tree crowns
share geometry through instancing. Conservative guest bounds allow offscreen
characters and guides to be culled; all ten clips were checked against the bounds.
Whole foreground trees fade together when they cover the guest-to-camera view,
using MSAA alpha coverage and an alpha-test fallback without MSAA. Architectural
obstacles still shorten the orbit. Walking past a
tree no longer changes camera distance because of a foliage bounding sphere.

Local motion runs each frame; network sends run independently. Small corrections
converge gradually, other guests use timestamped interpolation, and animation
speed is smoothed. Routes retain the turns needed by walls and permissions while
removing unnecessary grid zigzags. Arrival uses the actual remaining distance.
