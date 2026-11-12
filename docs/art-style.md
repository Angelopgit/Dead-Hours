# Art style: realistic low poly

How the things you hold, fight and drive are modeled. The world's look and the words are in [style.md](style.md); how it is lit and drawn is in [rendering.md](rendering.md).

## The idea

Low poly, but of a real thing. A model here should pass two tests: its black silhouette is recognizable as the real object, and under the torch its surfaces read as what they are made of. Detail is spent on proportion, edges and material, not on triangle count.

1. **Measure first.** Every gun, car and body starts from the real one's published dimensions (the services' technical manuals, makers' spec sheets, body measurement surveys), written into the model as millimetres from a datum (`drawn()` in `client/src/weapons/WeaponModels.ts`). `npm run check:models` holds each rebuilt model within 2% of the real length.
2. **Trace the side view.** The main parts are the real outline, extruded (`plate`), not boxes laid end to end. Round things are lofted through their real steps (`loft`): a barrel has its shoulders, a handguard its ribs.
3. **Every edge has a chamfer.** A real edge is never a perfect corner; a 1 to 3 mm chamfer is what catches the lamp and separates one part from the next. Curved parts are smooth around and crisp at each step.
4. **Parts are made of something.** One mesh carries each part's roughness and metalness per vertex (`SURF`, `patchSurf`): anodized aluminium, parkerized steel, polymer, rubber and wood sit in one draw call and answer the light differently.
5. **Wear where hands and holsters reach.** Chamfers lose their finish in patches (the `edge` attribute); under a paint finish the gun's own color shows through.
6. **Parts sit in each other's shade.** Occlusion is baked into the vertices when a model is built (`bakeOcclusion`), so a magazine darkens its well and a rail its receiver. No texture, no download.
7. **Shape before texture.** A shared 256² map of grain and handling scratches exists (`detailTexture`, made from arithmetic at start) but stays off the guns: one more texture read per pixel cost a tenth of the frame when aiming in the software renderer, for a detail seen only under a torch. Turn it on per material once it is measured on a real GPU.

The kit is `client/src/rendering/Solid.ts` and `SurfShader.ts`. Models stay code: the character creator, the body sliders, severed limbs and attachments all rebuild meshes while the game runs, which imported files could not do.

## Budgets

Sized for the worst street: 90 zombies, four survivors and their guns, on a phone.

| Asset | Triangles | Draw calls | Texture memory | Far version |
| --- | --- | --- | --- | --- |
| Held gun | 4,500 | 5 (body, magazine, action, lit sights) | none | none: at most 8 are ever drawn |
| Melee weapon | 1,500 | 3 | none | none |
| Survivor | 11,000 | 3 | none (vertex color, fabric pattern in the shader) | none: at most 4 |
| Zombie | 4,200 average over the 30 looks, 6,500 heaviest | 2 | shared 32³ noise | lite decay shader on Phone and Low |
| Drivable car | 6,000 | 3 (body, glass, lettering) | none | parked cars stay in the static batches |

A full street is 90 x 4,200 = 380k zombie triangles; everything else on this page together stays under 60k. `npm run check:models` fails when a model goes over.

## Proof

- `npm run check:models`: budgets, and each gun's length against the real one.
- `/dev/models.html?gun=ar`: the same four cameras for every model (flat side view to lay over a dimension drawing, two quarters by day, two under the night's lamp and torch). Before and after shots come from these.
- `npm run check:sights`, `check:melee`, `check:vehicles`: the hands, sights and seats still fit.
- Frame cost is measured before and after on `/dev/fp.html` (the gun in hand, over the shoulder and down the sights) and `/dev/zbench.html` (a street of zombies), old tree against new on two dev servers.

## Rebuilt so far

| Model | From | Before | After |
| --- | --- | --- | --- |
| M4A1 | TM 9-1005-319-10: 838 mm stock out, 368 mm barrel | 556 triangles, 960 mm (15% long) | 3,158 triangles, 838 mm, 3 draw calls as before |
| M17 (and the pair) | TM 9-1005-470-10: 203 mm long, 140 mm tall | 144 triangles, 190 mm, 180 mm tall, the grip raked forward | 1,366 triangles, 203 mm, 142 mm tall |
| MP5A2 | HK operator's manual: 680 mm, 225 mm barrel | 464 triangles, 680 mm | 1,710 triangles, 680 mm |
| Remington 870 Police | 978 mm with the 18 inch barrel, 356 mm length of pull | 172 triangles, 995 mm | 1,586 triangles, 979 mm |
| Mk 14 Mod 0 | 889 mm with the stock run in; drawn pulled out 90 mm (979 mm), which is my arithmetic from the M14's 337 mm length of pull, not a published figure | 308 triangles, 985 mm | 3,106 triangles with its scope, 981 mm |
| M249 | TM 9-1005-201-10: 1,041 mm, 465 mm barrel | 484 triangles, 1,201 mm (15% long) | 1,930 triangles, 1,043 mm |
| SCAR-H | 965 mm with the stock out, 406 mm barrel | 308 triangles, 933 mm | 2,274 triangles, 962 mm |
| M107 | TM 9-1005-239-10: 1,448 mm, 737 mm barrel | 420 triangles, 1,500 mm | 2,460 triangles, 1,448 mm |
| RPG-7 | 950 mm launcher, 40 mm bore | 536 triangles, a 1,220 mm launcher with the trigger grip behind the plain one | 1,516 triangles, 950 mm, grips the right way round |
| LR-338 | ours: nothing to measure | 480 triangles | 2,092 triangles, same length and hold |
| Survivors and zombies | body survey medians scaled to the survivor's height (recalled figures, not a looked-up table): head 13% smaller (`HEAD_K` 0.8), feet 12% longer (`FOOT_LENGTH`), thighs 12% fuller (`LEG_UP`), hips 9% wider (`pelvisK`) | head about 30% large, shoe 13.6% of the height | shoe 15.5% of the height; triangle counts unchanged |
| Sedan, police car | hard points kept (4.4 m body, 2.7 m wheelbase, 1.86 m wide); outline of a mid-90s American sedan | 824 triangles, a box on octagons | 2,900 triangles, 1 draw call as before |
| Faces, heads and hands | one sculpted face surface in `HeadSculpt.ts` (brow ridge, eye sockets, nose with nostrils, lips, chin, jaw line, cheek hollows) in place of a ball with a box nose; eyeballs set in the sockets under real lids (a second lid mesh shuts them to blink); an oval head 12% larger than the last pass (`HEAD_K` 0.9, which had shrunk it too far), on shoulders 2.5 cm lower, 2 cm narrower each side and sloped (`SHOULDER_Y`, `SHOULDER_X`, `shoulderK`); four jointed fingers and a thumb. Zombies: sunken sockets, torn cheeks, missing lips over bared teeth, a jaw that hangs, clouded eyes with a pinprick of light, grey dead skin tones, long clawed fingers, uneven arms and a slumped spine; clothes muted and muddied; skin and cloth mottled by smooth noise, not a tint per triangle | man 4,332 triangles, woman 8,492; zombies 3,941 average, 6,184 heaviest | man 6,688, woman 10,248 (the survivor budget is 11,000 since this pass); zombies 4,161 average, 6,102 heaviest |
| Armored truck | hard points kept (6.2 m on a 4.4 m wheelbase, 2.4 m wide, 1 m wheels, the cab ahead of the front axle); the faceted hull, ports and vision blocks of an armored rescue truck, no one real model | 856 triangles, three axles drawn over two that drive | 5,518 triangles, 1 draw call plus glass and lettering as before |

Measured in the software renderer (SwiftShader, 1280x720, no GPU on the build machine, so read these as relative): the M4 over the shoulder costs 5% more of the frame than the old one, and 31% more down the sights, where the slimmer rifle also hides less of the arms behind it. The star flash and barrel smoke use the particle pools already in the scene. Models are code, so the download grew by the source of the kit and the outlines only.

Every gun is now drawn this way. Overall lengths are the published ones; where each part sits along a gun (how far the trigger is from the breech, how tall a receiver is) is from memory of the real thing, not from a drawing laid under the model, so `/dev/models.html?gun=…&view=0` is the page to hold against one. Building them to real proportions moved the sights and the hands: the M17's sights sit lower, over a slimmer slide, the 870's support hand is a full stroke ahead of the receiver, the left hand is on the RPG's rear grip, and the eye sits further up the Mk 14, M249, SCAR and M107, whose stocks are their real, shorter length. `check:sights` passes on all of them. One of its cases reads the clock (the camera's sway), so a case within a cell of its limit can fail one run in several; the MP5's angled grip was the one, and its handguard was deepened to clear it.

The rifle scope fitting, and the scopes on the M107 and the LR-338, are one lofted shape (`scope()`): eyepiece, tube, turrets, objective bell, two rings.

Not measured again: frame cost. The heaviest of these is the Mk 14 at 3,106 triangles, under the M4 that was timed.

## Effects on cars and blood

- Exhaust: a running engine puffs from its tailpipe (now drawn on the sedan and the truck), pale and slow at idle, more and greyer under throttle, left behind as the car pulls away, red in the brake lights, and a few dark puffs when the starter catches. It uses the cigarette and barrel smoke pool, so it adds no draw call and stops 38 m from the camera. `/dev/cars.html?only=exhaust` (`&power=1`, `&brake=1`, `&truck=1`).
- Crash damage: each crash loud enough to hear pushes in the end the car was rolling toward, up to 30 cm on a sedan and 14 cm on the truck, across the body ahead of the wheels and below the glass. The paint dulls and scrapes to steel at the corners, and past a hard hit one lamp on that end goes dark; the other always stays, so the beams and brake lights still have a lamp. It is the same merged mesh with its vertices moved, undone when the night ends. Looks only: collision, beams and the fuel fire are as before. `/dev/cars.html?only=damage&crash=3`.
- Blood lands wet and dries: bright red with a highlight along the edge nearest the eye, drying dark brown from its thin edges in, a spatter in 22 seconds and a pool in 60. Real blood takes minutes for a drop and an hour or more for a pool; a night is short. It is the same instanced decal draw, with four more texture reads per pixel of a mark. `/dev/blood.html` shows five ages side by side.

What these do not do: dents are not sent to someone who joins after the crash (they see a clean car until the next one), the wet highlight is a share of the light already on the ground, so it cannot be brighter than the street lets it, and none of this has been timed on a real GPU.

## Next

- Hold each side view against a dimension drawing and correct the part positions.
- Optics, suppressors and grips are still boxes and plain tubes, apart from the scope.
- Cars: broken glass and bullet holes on the body; dents for late joiners.
- Zombies and survivors: skin, cloth and wound detail on the surfaces.
