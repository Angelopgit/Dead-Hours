// Swaps generated sets for photo-scanned CC0 sets from Poly Haven (polyhaven.com, CC0 1.0), when this
// machine can reach api.polyhaven.com and dl.polyhaven.org. Then run encode.mjs.
//   node client/tools/textures/fetch-cc0.mjs [key,key]
// Poly Haven's 1k JPGs map one to one onto our sets: _diff -> color, _nor_gl -> normal (OpenGL, +Y),
// _arm -> orm (AO, roughness, metal). These sets are full color, so the game drops the material tint
// for them (sources.json marks them colored). Siding, plaster and carpet stay generated on purpose:
// one grayscale set is tinted into several house colors.
//
// Note: written while the build machine had no route to Poly Haven, so the asset ids below come from
// the library's catalogue and the script checks each one through the API before downloading.
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SRC = path.join(HERE, 'src');
const ONLY = process.argv[2] ? new Set(process.argv[2].split(',')) : null;

/** Our set -> Poly Haven texture ids to try, best first. */
const PICKS = {
  brick: ['red_brick_03', 'red_brick', 'brick_wall_001'],
  asphalt: ['asphalt_02', 'asphalt_01', 'aerial_asphalt_01'],
  sidewalk: ['concrete_floor_02', 'concrete_pavement'],
  concrete: ['concrete_wall_008', 'concrete_floor_worn_001'],
  grass: ['aerial_grass_rock', 'forest_ground_04'],
  dirt: ['brown_mud_leaves_01', 'dirt_floor'],
  gravel: ['gravel_floor', 'gravel_concrete'],
  wood: ['wood_floor', 'laminate_floor_02', 'wood_floor_deck'],
  tile: ['floor_tiles_06', 'square_floor_tiles'],
  fence: ['weathered_planks', 'wood_planks'],
  roof: ['roof_tiles', 'clay_roof_tiles'],
  metal: ['rusty_metal_02', 'corrugated_iron'],
};

async function json(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'dead-hours-texture-fetch' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
async function download(url, file) {
  const r = await fetch(url, { headers: { 'User-Agent': 'dead-hours-texture-fetch' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}

const sourcesFile = path.join(SRC, 'sources.json');
const sources = fs.existsSync(sourcesFile) ? JSON.parse(fs.readFileSync(sourcesFile, 'utf8')) : {};
for (const [key, ids] of Object.entries(PICKS)) {
  if (ONLY && !ONLY.has(key)) continue;
  let done = false;
  for (const id of ids) {
    try {
      const files = await json(`https://api.polyhaven.com/files/${id}`);
      const url = (map) => files[map]?.['1k']?.jpg?.url;
      const maps = { color: url('Diffuse'), normal: url('nor_gl'), orm: url('arm') };
      if (!maps.color || !maps.normal || !maps.orm) continue;
      const dir = path.join(SRC, key);
      fs.mkdirSync(dir, { recursive: true });
      for (const [map, u] of Object.entries(maps)) {
        await download(u, path.join(dir, `${map}.jpg`));
        fs.rmSync(path.join(dir, `${map}.png`), { force: true });
      }
      sources[key] = { from: `polyhaven:${id}`, colored: true };
      console.log(key, '<-', id);
      done = true;
      break;
    } catch (e) {
      console.warn(key, id, String(e.message ?? e));
    }
  }
  if (!done) console.warn(key, 'kept generated');
}
fs.writeFileSync(sourcesFile, JSON.stringify(sources, null, 2) + '\n');
