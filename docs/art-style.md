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
7. **One shared detail map.** A 256² map of grain and handling scratches, made from arithmetic at start, tiles over every hard surface (`detailTexture`).

The kit is `client/src/rendering/Solid.ts` and `SurfShader.ts`. Models stay code: the character creator, the body sliders, severed limbs and attachments all rebuild meshes while the game runs, which imported files could not do.

## Budgets

Sized for the worst street: 90 zombies, four survivors and their guns, on a phone.

| Asset | Triangles | Draw calls | Texture memory | Far version |
| --- | --- | --- | --- | --- |
| Held gun | 4,500 | 5 (body, magazine, action, lit sights) | shared detail map, 0.35 MB with mips | none: at most 8 are ever drawn |
| Melee weapon | 1,500 | 3 | shared detail map | none |
| Survivor | 9,000 | 3 | none (vertex color, fabric pattern in the shader) | none: at most 4 |
| Zombie | 4,200 average over the 30 looks, 6,500 heaviest | 2 | shared 32³ noise | lite decay shader on Phone and Low |
| Drivable car | 6,000 | 3 (body, glass, lights) | shared detail map | parked cars stay in the static batches |

A full street is 90 x 4,200 = 380k zombie triangles; everything else on this page together stays under 60k. `npm run check:models` fails when a model goes over.

## Proof

- `npm run check:models`: budgets, and each gun's length against the real one.
- `/dev/models.html?gun=ar`: the same four cameras for every model (flat side view to lay over a dimension drawing, two quarters by day, two under the night's lamp and torch). Before and after shots come from these.
- `npm run check:sights`, `check:melee`, `check:vehicles`: the hands, sights and seats still fit.
- Frame cost is measured with the GPU timer on `/dev/zbench.html` and a pinned night view, before and after.

## Rebuilt so far

| Model | From | Before | After |
| --- | --- | --- | --- |
| M4A1 | TM 9-1005-319-10: 838 mm stock out, 368 mm barrel | 556 triangles, 960 mm (15% long) | 3,158 triangles, 838 mm |
