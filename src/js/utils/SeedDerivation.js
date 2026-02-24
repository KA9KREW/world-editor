/**
 * SeedDerivation.js - Transform a seed string into world parameters
 *
 * Deterministic: same seed = same world on any machine. Size comes from user
 * choice (preset or custom); terrain style, biomes, caves, ores derive from seed.
 */

const BIOMES = [
    "desert", "forest", "plains", "snowy_plains", "snowy_forest", "snowy_taiga",
    "swamp", "savanna", "jungle", "poplar_forest", "cherry_grove", "ocean",
];

/** Deterministic hash - same input always yields same output (any JS engine). */
function hashStr(s) {
    let h = 0;
    const str = String(s);
    for (let i = 0; i < str.length; i++) {
        h = ((h * 31) + str.charCodeAt(i)) >>> 0;
    }
    return h;
}

function derive(seed, key) {
    const h = hashStr(String(seed) + key);
    return (h >>> 0) / 4294967296;
}

function deriveInt(seed, key, min, max) {
    const u = derive(seed, key);
    return min + Math.floor(u * (max - min + 1));
}

/**
 * Derive world parameters from a seed. Size MUST come from overrides (preset or custom).
 * @param {string} seed - Any string (e.g. "Hytopia", "a1b2")
 * @param {object} overrides - { width, length, maxHeight?, clearMap? } - REQUIRED for size
 */
export function deriveWorldFromSeed(seed, overrides = {}) {
    const s = String(seed || "0").trim() || "0";
    const d = (key) => derive(s, key);

    // Size: MUST come from overrides (user picks preset or custom)
    const width = Math.max(10, Math.min(overrides.width ?? 120, 500));
    const length = Math.max(10, Math.min(overrides.length ?? 120, 500));
    const maxHeight = Math.max(32, Math.min(overrides.maxHeight ?? 64, 256));

    // Climate: seed defines temp/humidity bias
    const tempBias = d("temp");
    const humidBias = d("humid");
    const tempOffset = (tempBias - 0.5) * 0.4;
    const humidOffset = (humidBias - 0.5) * 0.3;

    // Terrain: rolling hills, mountains - bias AWAY from flat
    const roughness = 0.8 + d("rough") * 0.8;         // 0.8–1.6 (more variation)
    const flatness = d("flat") * 0.5;                 // 0–0.5 max (never too flat)
    const amplitude = 1.0 + d("amp") * 1.2;           // 1.0–2.2 (taller terrain)

    // Biome palette: at least 3 LAND biomes per seed (never emphasize ocean)
    const LAND_BIOMES = BIOMES.filter((b) => b !== "ocean");
    const biomeEmphasis = {};
    const pickCount = Math.max(3, 3 + Math.floor(d("biomeCount") * 4));
    const shuffled = [...LAND_BIOMES].sort((a, b) => {
        const ha = hashStr(s + "b" + a) >>> 0;
        const hb = hashStr(s + "b" + b) >>> 0;
        return ha !== hb ? ha - hb : a.localeCompare(b);
    });
    // Always include plains in top 3 for flow; ensure variety (plains, forest, mountains/snow/savanna etc)
    const mustInclude = ["plains"];
    const ordered = [...new Set([...mustInclude.filter((b) => shuffled.includes(b)), ...shuffled])];
    for (let i = 0; i < Math.min(pickCount, ordered.length); i++) {
        biomeEmphasis[ordered[i]] = 1.2 + d("boost" + i) * 0.5;  // 1.2–1.7x weight
    }

    // Mountains: most seeds get small mountains for natural flow
    const mountainRoll = d("mount");
    const mountainEnabled = mountainRoll > 0.25;
    const mountainSize = mountainEnabled ? 0.15 + (mountainRoll - 0.25) * 1.0 : 0;
    const snowHeight = 40 + Math.floor(d("snow") * 20);

    // Caves & ores
    const caveFactor = 0.5 + d("cave") * 0.6;        // 0.5–1.1
    const hollowWorld = overrides.hollowWorld === true || (overrides.hollowWorld !== false && d("hollow") > 0.7); // 30% of seeds get hollow
    const oreRarity = 0.78 - d("ore") * 0.2;         // 0.78–0.58 (higher = more ores)
    const generateOres = d("oresOn") > 0.02;         // 98% of seeds get ores (was 0.15 → 85%)

    // Water level: bias lower for more land; avoid water worlds
    const seaLevelOffset = (d("sea") - 0.5) * 4 - 2;  // -3..+1 (tilt toward lower sea)
    const baseSea = Math.floor(maxHeight * 0.42);     // ~42% of world height (more land)
    const seaLevel = Math.max(28, Math.min(maxHeight - 12, baseSea + Math.round(seaLevelOffset)));

    // Scale: finer noise for rolling hills, multiple octaves handle detail
    const scale = 0.025 + d("scale") * 0.02;         // 0.025–0.045 (lower = larger features)
    const terrainBlend = 0.25 + d("blend") * 0.35;   // 0.25–0.6
    const elevationExponent = 1.4 + d("elevExp") * 0.6;  // 1.4–2.0 (flat valleys, peaked mountains)

    return {
        width,
        length,
        maxHeight,
        seaLevel,
        mantleThicknessFactor: 0.9 + d("mantle") * 0.4,
        cobblestoneFeatures: d("cobble") > 0.25,
        terrainComplexity: 2 + Math.floor(d("complex") * 5),
        biomeToggles: Object.fromEntries(BIOMES.map((b) => [b, true])),
        scale,
        baseScale: scale,
        basePersistence: 0.45 + d("persist") * 0.15,
        baseAmplitude: amplitude,
        smoothing: 0.6 + d("smooth") * 0.3,
        terrainBlend,
        flatnessFactor: flatness,
        roughness,
        temperature: 0.5 + tempOffset,
        temperatureOffset: tempOffset,
        humidityOffset: humidOffset,
        biomeEmphasis,
        riverFreq: 0.03 + d("river") * 0.06,
        generateOres,
        oreRarity,
        caveDensityFactor: hollowWorld ? 2.8 : caveFactor,
        hollowWorld,
        mountainRange: {
            enabled: mountainEnabled,
            size: mountainSize,
            height: mountainEnabled ? 20 + Math.floor(mountainSize * 40) : 0,
            snowCap: mountainEnabled,
            snowHeight,
        },
        clearMap: overrides.clearMap !== false,
        isCompletelyFlat: false,
        elevationExponent,
        landBias: 0.12 + d("landBias") * 0.1,  // 0.12–0.22 lift heightmap to reduce water
    };
}

/**
 * Convert seed string to numeric seed for RNG. Deterministic across all JS engines.
 */
export function seedStringToNumber(seed) {
    const s = String(seed || "0").trim() || "0";
    let acc = 0;
    for (let i = 0; i < s.length; i++) {
        acc = ((acc * 31 + s.charCodeAt(i)) >>> 0);
    }
    return acc;
}
