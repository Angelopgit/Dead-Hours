# World textures

The streets, houses and interiors use PBR texture sets (color, normal, and a packed
AO/roughness/metal map) compressed to KTX2, in `client/public/textures/world/`. The game
picks a tier by the Texture quality setting:

| Quality | Color | Normal | AO/roughness | Used by |
| --- | --- | --- | --- | --- |
| High | 1024 | 1024 | 512 | High preset |
| Medium | 512 | 512 | 256 | Medium, Low and Phone presets |
| Low | 256 | none | none | Texture quality set to Low |

If the files can't be loaded (the single-file build, or a device that can't transcode Basis),
the game keeps its canvas-drawn textures, so nothing breaks.

## Rebuilding

```sh
node client/tools/textures/generate.mjs        # author the 15 sets as PNG (client/tools/textures/src, not committed)
node client/tools/textures/fetch-cc0.mjs       # optional: swap in Poly Haven CC0 photo sets where reachable
node client/tools/textures/encode.mjs          # compress to KTX2 tiers + manifest.json (uses npx basisu@1.16.3)
```

`generate.mjs` builds every set procedurally, with seamless tiling, height-derived normals
and cavity AO. Its color maps are detail maps that the material tint multiplies, which is
how one siding set covers the blue, green, gray and beige houses.

`fetch-cc0.mjs` replaces brick, asphalt, sidewalk, concrete, grass, dirt, gravel, wood floor,
tile, fence, roof and metal with photo-scanned CC0 sets from Poly Haven. Their `_diff`, `_nor_gl`
and `_arm` maps line up with our color, normal and ORM layout, and the script marks them as
full color so the game drops the tint. It was written on a machine that could not reach
Poly Haven, so it checks each asset id through the Poly Haven API and keeps the generated set
whenever an id is missing.
