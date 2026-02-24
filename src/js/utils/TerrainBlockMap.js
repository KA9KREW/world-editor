/**
 * TerrainBlockMap.js - Maps terrain generation contexts to the full block set
 *
 * Uses all available terrain blocks for richer worlds. Each category lists
 * block names in priority order; first available wins. Names use fuzzy match
 * (blockTypes.find(b => b.name.includes(name))).
 */

/** Stone layer variants (y > 16). Weight = approximate probability. */
export const STONE_VARIANTS = [
    { name: "stone", weight: 80 },
    { name: "andesite", weight: 5 },
    { name: "granite", weight: 5 },
    { name: "diorite", weight: 5 },
    { name: "cobblestone", weight: 4 },
    { name: "smooth-stone", weight: 1 },
];

/** Deepslate layer variants (y <= 16). */
export const DEEPSLATE_VARIANTS = [
    { name: "deepslate", weight: 85 },
    { name: "cobbled-deepslate", weight: 12 },
    { name: "cobblestone", weight: 3 },
];

/** Surface blocks per biome. First match wins. */
export const SURFACE_BY_BIOME = {
    desert: ["sand"],
    savanna: ["sand", "sand-wet"],
    snowy_plains: ["grass-snow-block", "snow"],
    snowy_forest: ["grass-snow-block", "snow"],
    snowy_taiga: ["grass-snow-block", "snow"],
    swamp: ["grass-block", "grass"],
    jungle: ["grass-flower-block", "grass-block", "grass"],
    taiga: ["grass-block-pine", "grass-block", "grass"],
    plains: ["grass-flower-block", "grass-block", "grass"],
    cherry_grove: ["grass-flower-block", "grass-block", "grass"],
    forest: ["grass-block", "grass"],
    poplar_forest: ["grass-block", "grass"],
    ocean: ["sand", "sand-wet"],
};

/** Subsurface (dirt/sand) per biome. */
export const SUBSURFACE_BY_BIOME = {
    desert: ["sand"],
    savanna: ["sand", "dirt"],
    snowy_plains: ["grass-snow-block", "snow", "dirt"],
    snowy_forest: ["grass-snow-block", "snow", "dirt"],
    snowy_taiga: ["grass-snow-block", "snow", "dirt"],
    swamp: ["dirt"],
    jungle: ["dirt"],
    taiga: ["dirt"],
    plains: ["dirt"],
    cherry_grove: ["dirt"],
    forest: ["dirt"],
    poplar_forest: ["dirt"],
    ocean: ["sand"],
};

/** Rocky surface outcrops (cobblestone, stone-bricks, etc.) when rockValue high. */
export const ROCKY_SURFACE = [
    "cobblestone",
    "stone",
    "stone-bricks",
    "mossy-cobblestone",
];

/** Mountain / snowy transition - stone mix (no snow-rocky to avoid streaky mantle). */
export const MOUNTAIN_STONE = [
    "stone",
    "cobblestone",
    "andesite",
    "granite",
];

/** Swamp / wet areas - mossy variants. */
export const MOSSY_VARIANTS = [
    "mossy-cobblestone",
    "mossy-stone-bricks",
    "cobblestone",
];

/** Near lava / magma. */
export const LAVA_NEARBY = [
    "magma-block",
    "lava-stone",
    "stone",
];

/** Sand/desert variants. */
export const SAND_VARIANTS = [
    "sand",
    "sand-wet",
    "sandstone",
];

/** Savanna / plains accent (hay, etc.). */
export const PLAINS_ACCENT = [
    "hay-block",
    "grass-block",
    "dirt",
];

/** Tree config: log and leaf blocks per biome. */
export const TREE_BY_BIOME = {
    forest: { log: "oak-log", leaf: "oak-leaves" },
    taiga: { log: "spruce-log", leaf: "spruce-leaves" },
    plains: { log: "birch-log", leaf: "birch-leaves" },
    savanna: { log: "oak-log", leaf: "dark-oak-leaves" },
    jungle: { log: "oak-log", leaf: "jungle-leaves" },
    swamp: { log: "oak-log", leaf: "dark-oak-leaves" },
    snowy_forest: { log: "spruce-log", leaf: "spruce-leaves" },
    snowy_taiga: { log: "spruce-log", leaf: "spruce-leaves" },
    snowy_plains: { log: "birch-log", leaf: "spruce-leaves" },
    poplar_forest: { log: "birch-log", leaf: "birch-leaves" },
    cherry_grove: { log: "birch-log", leaf: "cherry-leaves" },
};

/** Required blocks that must resolve (fallback chain). */
export const REQUIRED_KEYS = [
    "stone", "deepslate", "dirt", "grass", "sand", "snow", "water", "lava",
    "oak-log", "oak-leaves", "spruce-log", "spruce-leaves", "birch-log", "birch-leaves",
    "coal-ore", "iron-ore", "gold-ore", "diamond-ore",
];

/**
 * Resolve block ID from blockTypes (Record<string, id>).
 * @param {object} blockTypes - Pre-built { name: id } map
 * @param {string|string[]} names - Block name or array (first match)
 * @returns {number} Block ID or 0
 */
export function resolveBlock(blockTypes, names) {
    const arr = Array.isArray(names) ? names : [names];
    for (const n of arr) {
        const id = blockTypes[n] ?? blockTypes[String(n).toLowerCase().replace(/\s+/g, "-")];
        if (id) return id;
    }
    return 0;
}

/**
 * Pick from weighted variants using rng(). Returns block name.
 */
export function pickWeighted(variants, rng) {
    const total = variants.reduce((s, v) => s + (v.weight ?? 1), 0);
    let r = rng() * total;
    for (const v of variants) {
        r -= v.weight ?? 1;
        if (r <= 0) return v.name;
    }
    return variants[variants.length - 1]?.name ?? "stone";
}
