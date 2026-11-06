# Cultural references and asset provenance

All five programs are selected, symbolic interpretations for a fictional park.
They do not claim to represent every wedding in a country, ethnicity, region,
religion or family. The in-game descriptions name their selected inspiration.
No sacred chants, legal officiation, government seals, or personal identity
documents are reproduced. A local cultural review is still appropriate before
presenting this prototype as an educational or commercial cultural experience.

## Vietnam

Selected Kinh family-wedding references include a red courtyard, áo dài-inspired
clothing, lacquered gift trays with betel/areca/tea/fruit references, gratitude to
family and ancestors, a couple promise, congratulations, and a group photograph.
The river garden offers a symbolic tea toast. Architecture and clothing are
original stylized geometry, with selected northern courtyard cues.

- [Vietnam National Authority of Tourism — Wedding Ceremony](https://vietnamtourism.vn/en/index.php/about/items/2448)
  describes gift exchange, family ceremonies and variation among communities.
- [Vietnam Tourism — Áo dài](https://vietnam.travel/things-to-do/ao-dai-vietnam/)
  provides clothing context.

## Japan

The garden procession, timber pavilion, ivory/charcoal/rose clothing references,
quiet reflection, symbolic cups and promise draw on selected Shinto-style
ceremonies. The game's stillness is expressly a nonreligious substitute, and the
cup animation does not perform a religious rite. A camellia/photo arrangement is
a fictional reception activity.

- [Japan tourism multilingual database — Meiji Jingu wedding description](https://www.mlit.go.jp/tagengo-db/H30-00540.html)
  documents procession, attire, cups and vows.
- [Meiji Jingu — wedding FAQ](https://www.meijijingu.or.jp/faq/?ca=3)
  distinguishes historical san-san-kudo and current shrine-specific cup practices.
  The game uses the label “san-san-kudo-inspired,” without claiming that all
  modern shrine weddings use an identical nine-sip sequence.
- [Meiji Kinenkan — Wedding](https://www.meijikinenkan.gr.jp/english/wedding/index.html)
  offers a venue's own account of its ceremony setting.

## South Korea

The hanok-inspired court uses a wooden-goose presentation, exchanged bows and
paired cups, drawing on selected Honrye references: Jeonallye, Gyobaerye and
Hapgeullye. Clothing choices refer to hwarot, wonsam and samogwandae silhouettes.
The reception blessing is symbolic and optional, not a complete paebaek ritual.

- [Korean Cultural Centre — traditional wedding explanation](https://india.korean-culture.org/en/1271/board/127/read/118177)
  describes goose presentation, bows and cups.
- [National Folk Museum of Korea — Hapgeullye](https://folkency.nfm.go.kr/kr/topic/detail/512)
  provides museum context for the cup ritual.
- [National Archives of Korea — marriage traditions](https://theme.archives.go.kr/next/koreaOfRecord/marriage.do)
  provides historical ceremony and clothing references.

## India

The selected Rajasthan-inspired Hindu program includes a floral mandap,
marigolds, lehenga/sherwani clothing references, a garland exchange, a decorative
light representing the fire setting, seven symbolic steps and a freely chosen
promise. The server moves the couple through seven steps after both choose the
action. The reception dance is separate from the ritual area. No sacred chants
are copied and no claim is made that all Indian weddings follow these rites.

- [Rajasthan Tourism — Customs](https://www.tourism.rajasthan.gov.in/customs.html)
  provides regional wedding and Saptapadi context.
- [INTACH intangible heritage archive — Pheras](https://icharchive.intach.org/Detail/objects/14756)
  provides a local account and reminds implementers that ritual forms differ.
  Seven *steps* in this game are not described as a universal count of circuits
  around a fire; Saptapadi and locally varying phere should not be conflated.

## Italy

The olive villa, garden aisle, original civil-style welcome, vows, symbolic ring
exchange, congratulations and reception are fictional game choreography, with
no legal or religious authority. The confetti favors refer to sugared almonds,
not paper confetti. The garden party is not presented as a universal Italian rite.

- [Italia.it — Abruzzo food traditions, including Sulmona confetti](https://www.italia.it/it/abruzzo/cosa-fare/prodotti-e-piatti-tipici-abruzzesi-la-guida)
  provides the regional confectionery reference.

## Original assets

| Asset | Source / method | Use |
| --- | --- | --- |
| Five gardens, paths, buildings, vegetation, furniture | Original procedural Three.js geometry in `src/scene.ts` | Curved roofs/canopies, villa details, staggered paving and flush junctions, instanced botanical silhouettes, planters, lamps, registrar awning and ring fountain |
| `public/models/guest.glb`, `guest-dress.glb` | Original models and keyframes authored in `src/avatar-model.ts`, exported by `scripts/generate_guest.mjs` | Suit: 7,985 triangles; dress: 10,384 triangles. Each has 18 joints, 10 animation clips and one body material |
| Guest preview and NPCs | The same original character source, with independent skeletons and appearance colors | Live 3D entry preview and venue guides |
| Clothing and gesture props | Original geometry in `src/scene.ts` | Selected attire silhouettes follow chest/head joints; ritual props attach to the right hand |
| `public/models/lantern.glb` | Original lathed-mesh GLB generated by `scripts/generate_assets.py` | Actually loaded with Three.js GLTFLoader |
| `public/art/*.png` | Original vector-like raster compositions generated by the same script | Shared district social-preview art; no event names baked in |
| Keepsake ornaments and five layouts | Original Canvas drawing in `src/certificate.ts` | Local PNG and image-based PDF |
| Ring emblem, favicon and line icons | Original SVG/path drawing in this project | UI branding and controls |
| Ambient sound | Original quiet sine-wave chord sequence synthesized through Web Audio | Optional, user enabled |

No downloaded architectural models, stock photos, copyrighted music, cloned
artist styles or third-party character packs are included. No Blender project
was needed for these procedural assets. Regenerate with
`python -m scripts.generate_assets` after installing development dependencies.
Regenerate the guest model with `npm run assets:guest`. It exports idle, walk,
wave, bow, gift presentation, cup, promise, celebration, dance and photo clips.
Three.js AnimationMixer blends these clips in play. The suit model is
1,528,288 bytes and the dress model is 1,960,568 bytes; their source also
supplies matching built-in fallbacks.
The resulting original work is part of this project; no separate outside asset
license is required.

The landscape choices are original stylized design directions: Vietnam uses
areca-like palms and bamboo; Japan uses cherry blossoms; Korea uses layered
pines and golden ginkgo; India uses flowering umbrella crowns inspired by
gulmohar; Italy uses cypress and silvery olive crowns. The central plaza has
magnolia-inspired white blossoms. These are simplified game silhouettes, not
botanically precise models or claims that a species is exclusive to a country.

## Bundled fonts and libraries

- DM Sans and Lora are distributed through the pinned Fontsource packages.
  Their SIL Open Font License texts are included under `public/licenses/`.
  Lora's Vietnamese glyph set is bundled for Unicode names on keepsakes.
- Three.js and jsPDF use MIT licenses; their package license files remain in
  installed dependencies. The root `package-lock.json` records dependencies.
- Runtime Python requirements and test tools are pinned in the backend files.
  See the implementation report for the dependency audit and tested versions.

The PDF is an A4 image of the rendered certificate, preserving Unicode visually.
It is not a tagged accessible PDF and its canvas-rendered text is not selectable.
The signed JSON separately preserves the original Unicode payload for offline
verification.
