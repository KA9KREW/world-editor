/**
 * TerrainGenerator.js - Hytopia terrain generation utility
 *
 * Generates Minecraft-style terrain with biomes, caves, rivers, lakes,
 * ore distribution, and biome-specific vegetation based on a seed value.
 * Hollow worlds: only topsoil layer (surface + subsurface), no rock or bedrock.
 */
import {
    generatePerlinNoise,
    generatePerlinNoise3D,
} from "./PerlinNoiseGenerator";
import { RegionBlockStore, asTerrainDataProxy, iteratePackedRegion } from "./BlockRegionPacker";
import {
    SURFACE_BY_BIOME,
    SUBSURFACE_BY_BIOME,
    ROCKY_SURFACE,
    MOUNTAIN_STONE,
    STONE_VARIANTS,
    DEEPSLATE_VARIANTS,
    TREE_BY_BIOME,
    pickWeighted,
    resolveBlock,
} from "./TerrainBlockMap";

// ---------------------------------------------------------------------------
// Biome → Block helpers (uses full block map)
// ---------------------------------------------------------------------------

function getSurfaceBlock(biome, blockTypes, rockValue, cobblestoneFeatures) {
    if (cobblestoneFeatures && rockValue > 0.85) {
        const id = resolveBlock(blockTypes, ROCKY_SURFACE);
        if (id) return id;
    }
    const list = SURFACE_BY_BIOME[biome] ?? SURFACE_BY_BIOME.plains;
    const id = resolveBlock(blockTypes, list);
    return id || blockTypes.stone;
}

function getSubSurfaceBlock(biome, blockTypes, depth) {
    const list = SUBSURFACE_BY_BIOME[biome] ?? ["dirt"];
    if (biome?.startsWith("snowy") && depth <= 1) {
        const id = resolveBlock(blockTypes, ["grass-snow-block", "snow", ...list]);
        if (id) return id;
    }
    const id = resolveBlock(blockTypes, list);
    return id || blockTypes.dirt;
}

function getStoneBlock(blockTypes, y, rng) {
    const DEEPSLATE_TRANSITION = 16;
    if (y <= DEEPSLATE_TRANSITION) {
        const name = pickWeighted(DEEPSLATE_VARIANTS, rng);
        return blockTypes[name] || blockTypes.deepslate || blockTypes.stone;
    }
    const name = pickWeighted(STONE_VARIANTS, rng);
    return blockTypes[name] || blockTypes.stone;
}

function getTreeConfig(biome, blockTypes, rng) {
    const t = TREE_BY_BIOME[biome] || { log: "oak-log", leaf: "oak-leaves" };
    const logId = blockTypes[t.log] || blockTypes["oak-log"] || blockTypes.stone;
    const leafId = blockTypes[t.leaf] || blockTypes["oak-leaves"] || blockTypes.stone;
    const probMap = { forest: 0.30, taiga: 0.28, plains: 0.08, savanna: 0.06, jungle: 0.35, swamp: 0.20, snowy_forest: 0.25, snowy_taiga: 0.28, snowy_plains: 0.05, poplar_forest: 0.25, cherry_grove: 0.22 };
    const prob = probMap[biome] ?? 0.20;
    const heightMap = { taiga: [6, 2], jungle: [7, 3], savanna: [5, 3], swamp: [4, 2], snowy_taiga: [6, 2], poplar_forest: [6, 3] };
    const [hBase, hRand] = heightMap[biome] ?? [5, 2];
    const radiusMap = { jungle: 3, savanna: 3, cherry_grove: 3 };
    const radius = radiusMap[biome] ?? 2;
    return { log: logId, leaf: leafId, height: hBase + Math.floor(rng() * hRand), radius, prob };
}

// ---------------------------------------------------------------------------
// Main generation
// ---------------------------------------------------------------------------

export function generateHytopiaWorld(
    settings,
    seedNum,
    blockTypes,
    progressCallback = null
) {
    const updateProgress = (message, progress) => {
        if (progressCallback) progressCallback(message, progress);
    };
    updateProgress("Starting seed-based world generation...", 0);

    // Seeded PRNG
    function mulberry32(a) {
        return function () {
            a |= 0;
            a = (a + 0x6d2b79f5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }
    const rng = mulberry32(seedNum);

    const maxHeight = settings.maxHeight ?? 64;
    const seaLevel = settings.seaLevel ?? Math.floor(maxHeight * 0.55);
    const width = settings.width;
    const length = settings.length;
    const startX = -Math.floor(width / 2);
    const startZ = -Math.floor(length / 2);

    const worldSettings = { ...settings, maxHeight };

    // -----------------------------------------------------------------------
    // 1. Heightmap (Minecraft/Hytale-style: multi-octave, elevation redistribution)
    // -----------------------------------------------------------------------
    updateProgress("Generating heightmap...", 5);

    const scale = settings.scale || 0.04;
    const continentalNoise = generatePerlinNoise(width, length, {
        octaveCount: 2, scale: scale * 0.4, persistence: 0.6, amplitude: 1.0, seed: seedNum,
    });
    const hillNoise = generatePerlinNoise(width, length, {
        octaveCount: 4, scale: scale * 1.5, persistence: 0.5, amplitude: 0.6, seed: seedNum + 1,
    });
    const detailNoise = generatePerlinNoise(width, length, {
        octaveCount: 6, scale: scale * 4, persistence: 0.45, amplitude: 0.25, seed: seedNum + 2,
    });
    const rockNoise = generatePerlinNoise(width, length, {
        octaveCount: 4, scale: settings.scale * 3, persistence: 0.6, amplitude: 0.4, seed: seedNum + 10,
    });
    const depthMap = generatePerlinNoise(width, length, {
        octaveCount: 2, scale: 0.018, persistence: 0.5, amplitude: 0.25, seed: seedNum + 6,
    });
    const riverValleyNoise = generatePerlinNoise(width, length, {
        octaveCount: 2, scale: (settings.riverFreq || 0.05) * 0.8, persistence: 0.5, amplitude: 1.0, seed: seedNum + 5,
    });

    const heightMap = new Float32Array(width * length);
    const flatFactor = settings.flatnessFactor || 0;
    const elevExp = settings.elevationExponent ?? 1.5;
    const amp = (settings.baseAmplitude ?? 1.0) * 0.5;
    const landBias = settings.landBias ?? 0.15;  // lift heightmap to reduce water worlds

    if (settings.isCompletelyFlat) {
        for (let i = 0; i < heightMap.length; i++) heightMap[i] = 0.25;
    } else {
        for (let i = 0; i < heightMap.length; i++) {
            const base = continentalNoise[i];
            const hill = hillNoise[i] * (1.0 - flatFactor);
            const detail = detailNoise[i] * (1.0 - flatFactor) * 0.5;
            const depth = depthMap[i] * (1.0 - flatFactor) * 0.2;
            const riverValley = Math.max(0, riverValleyNoise[i] - 0.45) * 2.5; // 0..1, low where rivers run
            const raw = (base + hill + detail) * (1.0 + depth) * amp;
            const carved = Math.max(0, raw - riverValley * 0.35); // carve river valleys
            const normalized = Math.max(0, Math.min(1, carved));
            const lifted = Math.min(1, normalized + landBias);  // bias toward land
            heightMap[i] = Math.pow(lifted, elevExp) * (1.0 - flatFactor) + 0.4 * flatFactor;
        }
    }

    // Smooth
    updateProgress("Smoothing heightmap...", 10);
    const smoothedHeightMap = new Float32Array(width * length);
    const sRadius = Math.floor(2 + (settings.terrainBlend || 0.5) * 2);
    const smoothing = settings.smoothing || 0.7;
    for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
            let total = 0, count = 0;
            for (let dz = -sRadius; dz <= sRadius; dz++) {
                for (let dx = -sRadius; dx <= sRadius; dx++) {
                    const nx = x + dx, nz = z + dz;
                    if (nx >= 0 && nx < width && nz >= 0 && nz < length) {
                        const d = Math.sqrt(dx * dx + dz * dz);
                        const w = 1 / (1 + d);
                        total += heightMap[nz * width + nx] * w;
                        count += w;
                    }
                }
            }
            smoothedHeightMap[z * width + x] =
                (total / count) * smoothing + heightMap[z * width + x] * (1 - smoothing);
        }
    }

    // Erosion (soften peaks, create natural drainage)
    updateProgress("Applying erosion...", 15);
    const roughness = settings.roughness || 1.0;
    const baseY = Math.max(4, seaLevel - 20);
    const heightRange = Math.min(maxHeight - 12, 48) * roughness;
    const erodedHeightMap = new Float32Array(width * length);
    for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
            const idx = z * width + x;
            if (settings.isCompletelyFlat) { erodedHeightMap[idx] = heightMap[idx]; continue; }
            let h = Math.floor(baseY + smoothedHeightMap[idx] * heightRange);
            for (let dz = -1; dz <= 1; dz++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = x + dx, nz = z + dz;
                    if (nx >= 0 && nx < width && nz >= 0 && nz < length) {
                        const nh = Math.floor(baseY + smoothedHeightMap[nz * width + nx] * heightRange);
                        if (nh < h - 1) h = Math.max(h - 1, nh + 1);
                    }
                }
            }
            erodedHeightMap[idx] = (h - baseY) / heightRange;
        }
    }

    const finalHeightMap = settings.isCompletelyFlat ? heightMap : erodedHeightMap;

    // -----------------------------------------------------------------------
    // 2. Climate & Biomes -- scale tuned for min 3 biomes per seed
    // -----------------------------------------------------------------------
    updateProgress("Generating biomes...", 20);

    const BIOME_SCALE = 0.028;
    const tempMap = generatePerlinNoise(width, length, {
        octaveCount: 1, scale: BIOME_SCALE, persistence: 0.5, amplitude: 1.0, seed: seedNum + 7,
    });
    const temperatureOffset = (settings.temperature || 0.5) - 0.5;
    const humidityMap = generatePerlinNoise(width, length, {
        octaveCount: 1, scale: BIOME_SCALE * 0.8, persistence: 0.5, amplitude: 1.0, seed: seedNum + 8,
    });

    const biomeMap = new Array(width * length);
    const biomeToggles = settings.biomeToggles || {};
    const isBiomeEnabled = (b) => biomeToggles[b] !== false;

    const fallbacks = {
        snowy_plains: ["snowy_forest", "snowy_taiga", "plains"],
        snowy_forest: ["snowy_taiga", "snowy_plains", "forest"],
        snowy_taiga: ["snowy_forest", "snowy_plains", "taiga"],
        plains: ["forest", "savanna"],
        forest: ["taiga", "plains", "jungle"],
        taiga: ["forest", "snowy_taiga", "plains"],
        swamp: ["forest", "jungle", "plains"],
        savanna: ["plains", "desert", "jungle"],
        jungle: ["forest", "swamp", "savanna"],
        desert: ["savanna", "plains"],
        poplar_forest: ["forest", "taiga"],
        cherry_grove: ["forest", "plains"],
    };
    const getFallback = (b) => {
        for (const fb of (fallbacks[b] || ["plains"])) {
            if (isBiomeEnabled(fb)) return fb;
        }
        return "plains";
    };

    const humidityOffset = settings.humidityOffset ?? 0;
    const biomeEmphasis = settings.biomeEmphasis || {};

    for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
            const idx = z * width + x;
            const temp = tempMap[idx] + temperatureOffset;
            const hum = humidityMap[idx] + humidityOffset;
            let biome;

            if (temp < 0.2) {
                biome = hum < 0.3 ? "snowy_plains" : hum < 0.6 ? "snowy_forest" : "snowy_taiga";
            } else if (temp < 0.4) {
                biome = hum < 0.3 ? "plains" : hum < 0.6 ? "forest" : "taiga";
            } else if (temp < 0.6) {
                biome = hum < 0.3 ? "plains" : hum < 0.6 ? "forest" : "swamp";
            } else if (temp < 0.8) {
                biome = hum < 0.3 ? "savanna" : hum < 0.6 ? "jungle" : "swamp";
            } else {
                biome = hum < 0.3 ? "desert" : hum < 0.6 ? "savanna" : "jungle";
            }

            if (!isBiomeEnabled(biome)) biome = getFallback(biome);

            // Special biome replacement for variety (seed-driven emphasis)
            const isForesty = ["forest", "taiga", "snowy_forest", "snowy_taiga"].includes(biome);
            const poplarBoost = (biomeEmphasis["poplar_forest"] || 1) - 1;
            const cherryBoost = (biomeEmphasis["cherry_grove"] || 1) - 1;
            if (isForesty) {
                if (temp < 0.5 && rng() < 0.3 + poplarBoost * 0.3 && isBiomeEnabled("poplar_forest")) biome = "poplar_forest";
                else if (temp >= 0.5 && rng() < 0.25 + cherryBoost * 0.3 && isBiomeEnabled("cherry_grove")) biome = "cherry_grove";
            }
            // Seed-emphasized biomes (min 3 per seed): chance to override for diversity
            const emphList = Object.entries(biomeEmphasis).filter(([, w]) => w > 1.1);
            for (const [eb, weight] of emphList) {
                if (eb === biome || !isBiomeEnabled(eb)) continue;
                const roll = rng();
                if (roll < (weight - 1) * 0.22) {
                    biome = eb;
                    break;
                }
            }

            biomeMap[idx] = biome;
        }
    }

    // Biome transition smoothing (soften boundaries)
    const biomeCopy = [...biomeMap];
    for (let z = 1; z < length - 1; z++) {
        for (let x = 1; x < width - 1; x++) {
            const idx = z * width + x;
            const center = biomeMap[idx];
            const neighbors = [];
            for (let dz = -1; dz <= 1; dz++)
                for (let dx = -1; dx <= 1; dx++)
                    if (dx || dz) neighbors.push(biomeMap[(z + dz) * width + (x + dx)]);
            const different = neighbors.filter((b) => b !== center);
            if (different.length > 0 && rng() < 0.2) {
                biomeCopy[idx] = different[Math.floor(rng() * different.length)];
            }
        }
    }
    for (let i = 0; i < biomeMap.length; i++) biomeMap[i] = biomeCopy[i];

    // -----------------------------------------------------------------------
    // 3. River & Lake noise
    // -----------------------------------------------------------------------
    const riverNoise = generatePerlinNoise(width, length, {
        octaveCount: 1, scale: 0.01 + (settings.riverFreq || 0.05),
        persistence: 0.5, amplitude: 1.0, seed: seedNum + 5,
    });
    const lakeNoise = generatePerlinNoise(width, length, {
        octaveCount: 1, scale: 0.02, persistence: 0.5, amplitude: 1.0, seed: seedNum + 9,
    });
    // Smooth lake noise
    const smoothedLakeNoise = new Float32Array(lakeNoise.length);
    for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
            let t = 0, c = 0;
            for (let dz = -2; dz <= 2; dz++) {
                for (let dx = -2; dx <= 2; dx++) {
                    const nx = x + dx, nz = z + dz;
                    if (nx >= 0 && nx < width && nz >= 0 && nz < length) {
                        const d = Math.sqrt(dx * dx + dz * dz);
                        const w = 1 / (1 + d);
                        t += lakeNoise[nz * width + nx] * w;
                        c += w;
                    }
                }
            }
            smoothedLakeNoise[z * width + x] = t / c;
        }
    }

    // -----------------------------------------------------------------------
    // 4. 3D Density Field & Block Placement
    // -----------------------------------------------------------------------
    updateProgress("Building terrain layers...", 25);

    const densityField = generate3DDensityField(
        width, maxHeight, length, worldSettings, seedNum, biomeMap, finalHeightMap, settings.isCompletelyFlat
    );

    updateProgress("Building world from density field...", 40);
    const blockStore = new RegionBlockStore();
    const terrainData = asTerrainDataProxy(blockStore);
    let blocksCount = 0;
    const hollowWorld = settings.hollowWorld === true;

    for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
            const worldX = startX + x;
            const worldZ = startZ + z;
            const biIdx = z * width + x;
            const biome = biomeMap[biIdx];
            const rv = rockNoise[biIdx];

            // Find surface
            let surfaceHeight = 0;
            for (let y = maxHeight - 1; y > 0; y--) {
                const di = z * width * maxHeight + y * width + x;
                const ai = z * width * maxHeight + (y + 1) * width + x;
                if (densityField[di] >= 0 && (y === maxHeight - 1 || densityField[ai] < 0)) {
                    surfaceHeight = y;
                    break;
                }
            }

            if (hollowWorld) {
                // Hollow: only topsoil (surface + 1–2 subsurface layers), no rock or bedrock
                const topsoilDepth = 2;
                for (let y = Math.max(0, surfaceHeight - topsoilDepth); y <= surfaceHeight; y++) {
                    const di = z * width * maxHeight + y * width + x;
                    if (densityField[di] < 0) continue;
                    if (y === surfaceHeight) {
                        terrainData[`${worldX},${y},${worldZ}`] = getSurfaceBlock(
                            biome, blockTypes, rv, settings.cobblestoneFeatures
                        );
                    } else {
                        terrainData[`${worldX},${y},${worldZ}`] = getSubSurfaceBlock(
                            biome, blockTypes, surfaceHeight - y
                        );
                    }
                    blocksCount++;
                }
            } else {
                // Normal: bedrock at y=0,1 + full terrain
                const bedrockId = blockTypes.deepslate || blockTypes["lava-stone"] || blockTypes.stone;
                terrainData[`${worldX},0,${worldZ}`] = bedrockId;
                terrainData[`${worldX},1,${worldZ}`] = bedrockId;
                blocksCount += 2;

                const mantleFactor = settings.mantleThicknessFactor || 1.0;
                const surfaceDepth = Math.max(1, Math.round(3 * mantleFactor));
                const stoneStartY = surfaceHeight - surfaceDepth;

                for (let y = 2; y < maxHeight; y++) {
                    const di = z * width * maxHeight + y * width + x;
                    if (densityField[di] < 0) continue;

                    if (y === surfaceHeight) {
                        terrainData[`${worldX},${y},${worldZ}`] = getSurfaceBlock(
                            biome, blockTypes, rv, settings.cobblestoneFeatures
                        );
                    } else if (y >= stoneStartY && y < surfaceHeight) {
                        terrainData[`${worldX},${y},${worldZ}`] = getSubSurfaceBlock(
                            biome, blockTypes, surfaceHeight - y
                        );
                    } else {
                        terrainData[`${worldX},${y},${worldZ}`] = getStoneBlock(blockTypes, y, rng);
                    }
                    blocksCount++;
                }
            }
        }

        if (z % Math.ceil(length / 10) === 0) {
            updateProgress(`Building terrain: ${Math.floor((z / length) * 100)}%`, 40 + (z / length) * 15);
        }
    }

    // -----------------------------------------------------------------------
    // 5. Water Bodies
    // -----------------------------------------------------------------------
    updateProgress("Creating water bodies...", 60);

    const waterMap = {};
    const surfaceHeightMap = {};
    const waterBedHeightMap = {};

    for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
            const worldX = startX + x, worldZ = startZ + z;
            const biome = biomeMap[z * width + x];
            let sh = 0;
            for (let y = maxHeight - 1; y > 0; y--) {
                const k = `${worldX},${y},${worldZ}`;
                if (terrainData[k] && terrainData[k] !== blockTypes["water-still"]) { sh = y; break; }
            }
            const k2 = `${worldX},${worldZ}`;
            surfaceHeightMap[k2] = sh;
            waterMap[k2] = biome === "ocean";
        }
    }

    // Water: only deep depressions get initial water (avoid flat seas)
    const deepWaterLevel = seaLevel - 4;
    for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
            const k = `${startX + x},${startZ + z}`;
            const h = surfaceHeightMap[k];
            if (h < deepWaterLevel) waterMap[k] = true;
        }
    }

    // Lakes: only in clear deep basins (strict - avoid flat water seas)
    for (let z = 2; z < length - 2; z++) {
        for (let x = 2; x < width - 2; x++) {
            const wX = startX + x, wZ = startZ + z;
            const k = `${wX},${wZ}`;
            if (waterMap[k] || surfaceHeightMap[k] > seaLevel - 1) continue;

            const lv = smoothedLakeNoise[z * width + x];
            if (lv < 0.88) continue;

            let minNeighbor = 999;
            for (let dz = -2; dz <= 2; dz++) {
                for (let dx = -2; dx <= 2; dx++) {
                    if (!dx && !dz) continue;
                    const nk = `${wX + dx},${wZ + dz}`;
                    const nh = surfaceHeightMap[nk];
                    if (nh !== undefined && nh < minNeighbor) minNeighbor = nh;
                }
            }
            if (surfaceHeightMap[k] < minNeighbor + 2 && surfaceHeightMap[k] < seaLevel - 2) {
                waterMap[k] = true;
            }
        }
    }

    // Flood fill (1 pass - minimal expansion to avoid flat water seas)
    for (let iter = 0; iter < 1; iter++) {
        const newW = { ...waterMap };
        for (let z = 1; z < length - 1; z++) {
            for (let x = 1; x < width - 1; x++) {
                const wX = startX + x, wZ = startZ + z;
                const k = `${wX},${wZ}`;
                if (waterMap[k] || surfaceHeightMap[k] > seaLevel) continue;
                let adj = false;
                for (let dz = -1; !adj && dz <= 1; dz++)
                    for (let dx = -1; !adj && dx <= 1; dx++) {
                        if (!dx && !dz) continue;
                        if (waterMap[`${wX + dx},${wZ + dz}`]) adj = true;
                    }
                if (adj && surfaceHeightMap[k] <= seaLevel) newW[k] = true;
            }
        }
        Object.assign(waterMap, newW);
    }

    // Place water blocks + beaches
    for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
            const wX = startX + x, wZ = startZ + z;
            const k = `${wX},${wZ}`;
            const sh = surfaceHeightMap[k];

            if (waterMap[k] && sh < seaLevel) {
                let bed = sh;
                let tt = sh, cc = 1;
                for (let dz = -1; dz <= 1; dz++)
                    for (let dx = -1; dx <= 1; dx++) {
                        if (!dx && !dz) continue;
                        const nk = `${wX + dx},${wZ + dz}`;
                        if (surfaceHeightMap[nk] !== undefined) { tt += surfaceHeightMap[nk]; cc++; }
                    }
                bed = Math.max(sh - 2, Math.floor(tt / cc));
                waterBedHeightMap[k] = bed;

                for (let y = bed + 1; y <= seaLevel; y++) {
                    terrainData[`${wX},${y},${wZ}`] = blockTypes["water-still"];
                    blocksCount++;
                }

                // Bottom material
                const depth = seaLevel - bed;
                terrainData[`${wX},${bed},${wZ}`] = depth > 3
                    ? (blockTypes["sand-wet"] || blockTypes.sand)
                    : blockTypes.sand;
            }

            // Beaches
            if (!waterMap[k]) {
                let adjW = false;
                for (let dz = -1; !adjW && dz <= 1; dz++)
                    for (let dx = -1; !adjW && dx <= 1; dx++) {
                        if (!dx && !dz) continue;
                        if (waterMap[`${wX + dx},${wZ + dz}`]) adjW = true;
                    }
                if (adjW && sh >= seaLevel - 2 && sh <= seaLevel + 1) {
                    terrainData[`${wX},${sh},${wZ}`] = blockTypes.sand;
                    if (rng() < 0.7 && sh > 1) terrainData[`${wX},${sh - 1},${wZ}`] = blockTypes.sand;
                    if (rng() < 0.4 && sh > 1) terrainData[`${wX},${sh - 2},${wZ}`] = blockTypes.sand;
                }
            }
        }
    }
    // Extend beaches one block inland
    for (let z = 1; z < length - 1; z++) {
        for (let x = 1; x < width - 1; x++) {
            const wX = startX + x, wZ = startZ + z;
            const k = `${wX},${wZ}`;
            if (waterMap[k]) continue;
            const sh = surfaceHeightMap[k];
            if (sh == null || sh < seaLevel - 1 || sh > seaLevel + 2) continue;
            let adjBeach = false;
            for (let dz = -1; !adjBeach && dz <= 1; dz++)
                for (let dx = -1; !adjBeach && dx <= 1; dx++) {
                    if (!dx && !dz) continue;
                    const nsh = surfaceHeightMap[`${wX + dx},${wZ + dz}`];
                    if (nsh != null && terrainData[`${wX + dx},${nsh},${wZ + dz}`] === blockTypes.sand) adjBeach = true;
                }
            if (adjBeach && rng() < 0.6) terrainData[`${wX},${sh},${wZ}`] = blockTypes.sand;
        }
    }

    // Rivers: water finds its level — fill to seaLevel (flat surface)
    for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
            const wX = startX + x, wZ = startZ + z;
            const k = `${wX},${wZ}`;
            if (waterMap[k]) continue;
            const rv = riverNoise[z * width + x];
            if (rv > 0.44 && rv < 0.56) {
                const h = surfaceHeightMap[k];
                if (h <= seaLevel) {
                    const rd = Math.min(2, Math.max(1, Math.floor((seaLevel - h) * 0.15) + 1));
                    const bed = Math.max(1, h - rd);
                    if (bed < h) {
                        for (let y = bed + 1; y <= h; y++) delete terrainData[`${wX},${y},${wZ}`];
                        for (let y = bed + 1; y <= seaLevel; y++) {
                            terrainData[`${wX},${y},${wZ}`] = blockTypes["water-still"];
                            blocksCount++;
                        }
                        terrainData[`${wX},${bed},${wZ}`] = blockTypes.sand;
                        waterMap[k] = true;
                        waterBedHeightMap[k] = bed;
                        for (let dx = -1; dx <= 1; dx++)
                            for (let dz = -1; dz <= 1; dz++) {
                                if (!dx && !dz) continue;
                                const nk = `${wX + dx},${wZ + dz}`;
                                if (!waterMap[nk] && surfaceHeightMap[nk] > 0 && surfaceHeightMap[nk] <= seaLevel + 2)
                                    terrainData[`${wX + dx},${surfaceHeightMap[nk]},${wZ + dz}`] = blockTypes.sand;
                            }
                    }
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // 6. Caves & Ores (Minecraft-style: carve caves first, then place ore veins)
    // -----------------------------------------------------------------------
    updateProgress("Carving caves...", 75);
    const smallCaveNoise = generatePerlinNoise3D(width, maxHeight, length, {
        octaveCount: 2, scale: 0.03, persistence: 0.5, amplitude: 1.0, seed: seedNum + 20,
    });
    const largeCaveNoise = generatePerlinNoise3D(width, maxHeight, length, {
        octaveCount: 2, scale: 0.06, persistence: 0.5, amplitude: 1.0, seed: seedNum + 21,
    });

    const caveFac = settings.caveDensityFactor ?? 1.0;
    const caveThresh = hollowWorld ? 0.38 : (0.68 - (caveFac - 0.5) * 0.25);
    const caveThreshL = hollowWorld ? 0.30 : Math.min(0.55, caveThresh - 0.05);

    // Hollow worlds: add mega-cave noise for large caverns
    let megaCaveNoise = null;
    if (hollowWorld) {
        megaCaveNoise = generatePerlinNoise3D(width, maxHeight, length, {
            octaveCount: 1, scale: 0.02, persistence: 0.5, amplitude: 1.0, seed: seedNum + 25,
        });
    }

    const stoneIds = new Set([
        blockTypes.stone, blockTypes.deepslate, blockTypes.andesite, blockTypes.granite,
        blockTypes.diorite, blockTypes.cobblestone, blockTypes["cobbled-deepslate"],
        blockTypes["smooth-stone"], blockTypes["mossy-cobblestone"],
        blockTypes["mossy-stone-bricks"], blockTypes["stone-bricks"],
    ].filter(Boolean));

    function isStone(block) {
        return block && stoneIds.has(block);
    }

    for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
            const wX = startX + x, wZ = startZ + z;
            const sh = surfaceHeightMap[`${wX},${wZ}`] || 0;

            for (let y = Math.min(sh - 2, maxHeight - 3); y > (hollowWorld ? -1 : 1); y--) {
                const bk = `${wX},${y},${wZ}`;
                const block = terrainData[bk];
                if (!block) continue;
                if (!hollowWorld && !isStone(block)) continue;

                const ni = z * width * maxHeight + y * width + x;
                const sv = smallCaveNoise[ni];
                const lv = largeCaveNoise[ni];
                let carve = (sv > caveThreshL && lv > caveThresh - 0.15) || sv > caveThresh || lv > caveThresh - 0.02;
                if (hollowWorld && megaCaveNoise && (megaCaveNoise[ni] > 0.35 || carve)) {
                    carve = true;
                }
                if (carve) {
                    delete terrainData[bk];
                }
            }
        }

        if (z % Math.ceil(length / 10) === 0) {
            updateProgress(`Carving caves: ${Math.floor((z / length) * 100)}%`, 75 + (z / length) * 2);
        }
    }

    // Minecraft-style ore veins: skip for hollow (no rock)
    if (settings.generateOres !== false && !hollowWorld) {
        updateProgress("Placing ore veins...", 78);
        const DEEPSLATE_ZONE = 16;
        const CHUNK_SIZE = 16;
        const rarity = settings.oreRarity ?? 0.78; // 0.58=common, 0.78=rare
        const oreMult = Math.max(0.5, 0.6 + (0.78 - rarity)); // more ores when rarity is lower

        const ORE_MULTIPLIER = 3;
        const oreConfigs = [
            { name: "coal", normal: "coal", deep: "deepslate-coal", attempts: Math.max(30, Math.floor(24 * oreMult * ORE_MULTIPLIER)), veinSize: 17, yMin: 4, yMax: 50 },
            { name: "iron", normal: "iron", deep: "deepslate-iron", attempts: Math.max(24, Math.floor(20 * oreMult * ORE_MULTIPLIER)), veinSize: 9, yMin: 4, yMax: 54 },
            { name: "gold", normal: "gold", deep: "deepslate-gold", attempts: Math.max(6, Math.floor(6 * oreMult * ORE_MULTIPLIER)), veinSize: 8, yMin: 4, yMax: 32 },
            { name: "diamond", normal: "diamond", deep: "deepslate-diamond", attempts: Math.max(6, Math.floor(5 * oreMult * ORE_MULTIPLIER)), veinSize: 6, yMin: 2, yMax: 18 },
            { name: "emerald", normal: "emerald", deep: "deepslate-emerald", attempts: Math.max(3, Math.floor(3 * oreMult * ORE_MULTIPLIER)), veinSize: 4, yMin: 12, yMax: 30 },
            { name: "ruby", normal: "ruby", deep: "deepslate-ruby", attempts: Math.max(3, Math.floor(3 * oreMult * ORE_MULTIPLIER)), veinSize: 5, yMin: 2, yMax: 16 },
            { name: "sapphire", normal: "sapphire", deep: "deepslate-sapphire", attempts: Math.max(3, Math.floor(3 * oreMult * ORE_MULTIPLIER)), veinSize: 5, yMin: 2, yMax: 18 },
        ];

        const chunkMinX = Math.floor(startX / CHUNK_SIZE);
        const chunkMaxX = Math.ceil((startX + width) / CHUNK_SIZE);
        const chunkMinZ = Math.floor(startZ / CHUNK_SIZE);
        const chunkMaxZ = Math.ceil((startZ + length) / CHUNK_SIZE);
        let veinAttempts = 0;

        function makeVeinRng(attemptId) {
            let s = (seedNum ^ (attemptId * 0x9e3779b9)) >>> 0;
            return function () {
                s = (s * 1103515245 + 12345) >>> 0;
                return s / 4294967296;
            };
        }

        for (const cfg of oreConfigs) {
            const oreIdNormal = blockTypes[cfg.normal];
            const oreIdDeep = blockTypes[cfg.deep] || oreIdNormal;
            if (!oreIdNormal) continue;

            for (let cz = chunkMinZ; cz < chunkMaxZ; cz++) {
                for (let cx = chunkMinX; cx < chunkMaxX; cx++) {
                    for (let a = 0; a < cfg.attempts; a++) {
                        veinAttempts++;
                        const attemptId = veinAttempts * 7919 + cx * 17 + cz * 13 + cfg.name.charCodeAt(0);
                        const prng = makeVeinRng(attemptId);

                        const baseX = cx * CHUNK_SIZE;
                        const baseZ = cz * CHUNK_SIZE;
                        const rx = Math.floor(prng() * CHUNK_SIZE);
                        const rz = Math.floor(prng() * CHUNK_SIZE);
                        const wX = baseX + rx;
                        const wZ = baseZ + rz;
                        const wY = cfg.yMin + Math.floor(prng() * (cfg.yMax - cfg.yMin + 1));

                        if (wX < startX || wX >= startX + width || wZ < startZ || wZ >= startZ + length) continue;
                        if (wY < 2 || wY >= maxHeight - 1) continue;

                        const centerKey = `${wX},${wY},${wZ}`;
                        const centerBlock = terrainData[centerKey];
                        if (!isStone(centerBlock)) continue;

                        const deep = wY <= DEEPSLATE_ZONE;
                        const oreId = deep ? oreIdDeep : oreIdNormal;

                        // Place vein: random-walk blob from center (Minecraft/Hytale style)
                        const placed = new Set([centerKey]);
                        terrainData[centerKey] = oreId;
                        let x = wX, y = wY, z = wZ;

                        for (let i = 0; i < cfg.veinSize - 1; i++) {
                            const dir = Math.floor(prng() * 6);
                            const dx = dir === 0 ? 1 : dir === 1 ? -1 : 0;
                            const dy = dir === 2 ? 1 : dir === 3 ? -1 : 0;
                            const dz = dir === 4 ? 1 : dir === 5 ? -1 : 0;
                            x += dx;
                            y += dy;
                            z += dz;

                            if (y < 2 || y >= maxHeight - 1) { x -= dx; y -= dy; z -= dz; continue; }
                            if (x < startX || x >= startX + width || z < startZ || z >= startZ + length) { x -= dx; y -= dy; z -= dz; continue; }

                            const key = `${x},${y},${z}`;
                            if (placed.has(key)) continue;
                            const b = terrainData[key];
                            if (!isStone(b)) continue;

                            placed.add(key);
                            terrainData[key] = oreId;
                        }
                    }
                }
            }
        }

        updateProgress("Ore veins placed", 80);
    }

    // Underground lava pools (skip for hollow)
    const lavaId = blockTypes.lava;
    if (lavaId && !hollowWorld) {
        const CHUNK = 16;
        const lavaAttempts = Math.max(2, Math.floor((width * length) / (CHUNK * CHUNK * 4)));
        let la = 0;
        for (let a = 0; a < lavaAttempts; a++) {
            la++;
            const prng = (() => {
                let s = (seedNum ^ (la * 0x9e3779b9)) >>> 0;
                return () => { s = (s * 1103515245 + 12345) >>> 0; return s / 4294967296; };
            })();
            const wX = startX + Math.floor(prng() * width);
            const wZ = startZ + Math.floor(prng() * length);
            const wY = 4 + Math.floor(prng() * 11);
            const centerKey = `${wX},${wY},${wZ}`;
            if (!isStone(terrainData[centerKey])) continue;
            terrainData[centerKey] = lavaId;
            for (let i = 0; i < 8; i++) {
                const dx = Math.floor(prng() * 3) - 1;
                const dy = Math.floor(prng() * 3) - 1;
                const dz = Math.floor(prng() * 3) - 1;
                const nx = wX + dx, ny = wY + dy, nz = wZ + dz;
                if (ny < 2 || ny >= maxHeight - 1) continue;
                const key = `${nx},${ny},${nz}`;
                if (isStone(terrainData[key])) terrainData[key] = lavaId;
            }
        }
    }

    // Underwater cleanup
    updateProgress("Smoothing underwater terrain...", 82);
    for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
            const wX = startX + x, wZ = startZ + z;
            const k = `${wX},${wZ}`;
            if (!waterMap[k] || !waterBedHeightMap[k]) continue;
            const bed = waterBedHeightMap[k];
            for (let y = bed - 1; y > 0; y--) {
                const bk = `${wX},${y},${wZ}`;
                if (!terrainData[bk]) continue;
                let adjB = 0, adjW = 0;
                for (let dz = -1; dz <= 1; dz++)
                    for (let dx = -1; dx <= 1; dx++) {
                        if (!dx && !dz) continue;
                        if (terrainData[`${wX + dx},${y},${wZ + dz}`]) adjB++;
                        if (waterMap[`${wX + dx},${wZ + dz}`]) adjW++;
                    }
                const hf = (y - 1) / bed;
                if (adjB <= Math.floor(2 + 3 * hf) && adjW >= 4) delete terrainData[bk];
            }
        }
    }

    // -----------------------------------------------------------------------
    // 7. Snow Caps on High Terrain
    // -----------------------------------------------------------------------
    updateProgress("Adding snow caps...", 84);
    const snowCapHeight = seaLevel + 20;
    for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
            const wX = startX + x, wZ = startZ + z;
            const sh = surfaceHeightMap[`${wX},${wZ}`] || 0;
            if (sh >= snowCapHeight) {
                for (let y = maxHeight - 1; y >= snowCapHeight; y--) {
                    const bk = `${wX},${y},${wZ}`;
                    if (terrainData[bk] && terrainData[bk] !== blockTypes["water-still"]) {
                        terrainData[bk] = blockTypes.snow;
                        for (let dy = 1; dy <= 2; dy++) {
                            const bk2 = `${wX},${y - dy},${wZ}`;
                            if (terrainData[bk2] === blockTypes.dirt ||
                                terrainData[bk2] === blockTypes["grass-block"] ||
                                terrainData[bk2] === blockTypes.grass)
                                terrainData[bk2] = blockTypes.stone;
                        }
                        break;
                    }
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // 8. Mountain Ranges (border mountains) - skip on small worlds to avoid huge borders
    // -----------------------------------------------------------------------
    const minDim = Math.min(width, length);
    const skipBorderMountains = minDim < 120;
    if (settings.mountainRange && settings.mountainRange.enabled && !skipBorderMountains) {
        updateProgress("Creating mountain ranges...", 86);
        const sizeFactor = Math.max(0.05, 1.0 - settings.mountainRange.size * 4.0);
        const mBaseH = settings.mountainRange.height * 2 * (1 + sizeFactor * 0.5);
        const snowH = settings.mountainRange.snowHeight * 1.5;
        const mWidth = Math.max(3, Math.min(Math.floor(width * 0.25 * sizeFactor), Math.floor(minDim * 0.08)));

        for (let z = 0; z < length; z++) {
            for (let x = 0; x < width; x++) {
                const wX = startX + x, wZ = startZ + z;
                const dE = Math.min(x, width - x - 1, z, length - z - 1);
                if (dE > mWidth) continue;

                let hf = Math.cos((dE / mWidth) * Math.PI * 0.5);
                // Corner boost
                const dW = x, dEr = width - x - 1, dN = z, dS = length - z - 1;
                const nW = dW <= mWidth, nE = dEr <= mWidth, nN = dN <= mWidth, nS = dS <= mWidth;
                let cb = 0;
                if ((nW && nN) || (nW && nS) || (nE && nN) || (nE && nS)) {
                    let d1, d2;
                    if (nW && nN) { d1 = dW; d2 = dN; }
                    else if (nW && nS) { d1 = dW; d2 = dS; }
                    else if (nE && nN) { d1 = dEr; d2 = dN; }
                    else { d1 = dEr; d2 = dS; }
                    cb = (1 - d1 / mWidth) * (1 - d2 / mWidth) * 0.4;
                }

                const bH = Math.floor(mBaseH * (hf + cb));
                const ridge = Math.cos(x * 0.2) * Math.sin(z * 0.15) * 6;
                const vf = (nW || nE) ? z / length : x / width;
                const edgeVar = Math.sin(vf * Math.PI * 4) * 5;
                const n1 = Math.sin(x * 0.8) * Math.cos(z * 0.8) * 2;
                const n2 = Math.cos(x * 0.3 + z * 0.2) * 2;
                const fH = Math.max(1, Math.floor(bH + ridge + edgeVar + n1 + n2));

                const k = `${wX},${wZ}`;
                const curH = surfaceHeightMap[k] || 0;
                if (fH <= 0 || curH >= fH) continue;

                for (let y = curH + 1; y <= fH; y++) {
                    if (settings.mountainRange.snowCap && y >= snowH - 5 && y === fH) {
                        terrainData[`${wX},${y},${wZ}`] = blockTypes.snow;
                    } else if (settings.mountainRange.snowCap && y >= snowH - 3 && y >= fH - 2 && rng() < 0.7) {
                        terrainData[`${wX},${y},${wZ}`] = getStoneBlock(blockTypes, y, rng);
                    } else if (settings.mountainRange.snowCap && y >= snowH - 8 && rng() < 0.3) {
                        terrainData[`${wX},${y},${wZ}`] = blockTypes.stone;
                    } else {
                        const name = MOUNTAIN_STONE[Math.floor(rng() * MOUNTAIN_STONE.length)];
                        terrainData[`${wX},${y},${wZ}`] = resolveBlock(blockTypes, name) || blockTypes.stone;
                    }
                    blocksCount++;
                }
                surfaceHeightMap[k] = fH;
            }
        }
    }

    // -----------------------------------------------------------------------
    // 9. Trees & Vegetation
    // -----------------------------------------------------------------------
    updateProgress("Adding trees and vegetation...", 90);

    const treeOffX = Math.floor(rng() * 5);
    const treeOffZ = Math.floor(rng() * 5);

    for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
            const wX = startX + x, wZ = startZ + z;
            const biome = biomeMap[z * width + x];

            if (biome === "desert" || biome === "ocean") continue;

            // Find current surface (post-water)
            let sh = 0;
            for (let y = maxHeight - 1; y >= 0; y--) {
                const bk = `${wX},${y},${wZ}`;
                if (terrainData[bk] && terrainData[bk] !== blockTypes["water-still"]) { sh = y; break; }
            }
            if (sh <= seaLevel || sh <= 0) continue;

            const surfBlock = terrainData[`${wX},${sh},${wZ}`];
            if (surfBlock === blockTypes.sand || surfBlock === blockTypes["sand-wet"] || surfBlock === blockTypes.sandstone) continue;

            const tc = getTreeConfig(biome, blockTypes, rng);

            // Grid-based placement with seeded offsets
            const gridSize = biome === "jungle" ? 4 : biome === "savanna" ? 7 : 5;
            if ((x + treeOffX) % gridSize !== 0 || (z + treeOffZ) % gridSize !== 0) continue;
            if (rng() >= tc.prob) continue;

            // Space check
            let canPlace = true;
            for (let ty = 1; ty <= tc.height + 2; ty++) {
                if (terrainData[`${wX},${sh + ty},${wZ}`]) { canPlace = false; break; }
            }
            if (!canPlace) continue;

            // Trunk
            for (let ty = 1; ty <= tc.height; ty++) {
                terrainData[`${wX},${sh + ty},${wZ}`] = tc.log;
                blocksCount++;
            }

            // Canopy
            for (let ly = tc.height - 1; ly <= tc.height + 1; ly++) {
                const lr = ly === tc.height ? tc.radius : tc.radius - 1;
                for (let lx = -lr; lx <= lr; lx++) {
                    for (let lz = -lr; lz <= lr; lz++) {
                        if (lx === 0 && lz === 0 && ly < tc.height) continue;
                        const dist = Math.sqrt(lx * lx + lz * lz + (ly - tc.height) * (ly - tc.height) * 0.5);
                        if (dist <= lr || (dist <= lr + 0.5 && rng() < 0.5)) {
                            const lk = `${wX + lx},${sh + ly},${wZ + lz}`;
                            if (!terrainData[lk]) {
                                terrainData[lk] = tc.leaf;
                                blocksCount++;
                    }
                }
            }
        }
    }

            // Random extra leaves
            for (let i = 0; i < 4; i++) {
                const lx = Math.floor(rng() * 5) - 2;
                const ly = tc.height + Math.floor(rng() * 3) - 1;
                const lz = Math.floor(rng() * 5) - 2;
                if (Math.abs(lx) <= tc.radius && Math.abs(lz) <= tc.radius &&
                    ly >= tc.height - 1 && ly <= tc.height + 1) {
                    const lk = `${wX + lx},${sh + ly},${wZ + lz}`;
                    if (!terrainData[lk]) { terrainData[lk] = tc.leaf; blocksCount++; }
                }
            }
        }
    }

    // Desert features: sandstone structures
    for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
            const wX = startX + x, wZ = startZ + z;
            const biome = biomeMap[z * width + x];
            if (biome !== "desert") continue;

            let sh = 0;
            for (let y = maxHeight - 1; y >= 0; y--) {
                if (terrainData[`${wX},${y},${wZ}`]) { sh = y; break; }
            }
            if (sh <= 0) continue;

            if (rng() < 0.04) {
                terrainData[`${wX},${sh + 1},${wZ}`] = blockTypes.sandstone;
                            blocksCount++;
                if (rng() < 0.3) {
                    for (let dx = -1; dx <= 1; dx++)
                        for (let dz = -1; dz <= 1; dz++)
                            if ((dx === 0 || dz === 0) && !(dx === 0 && dz === 0)) {
                                terrainData[`${wX + dx},${sh + 1},${wZ + dz}`] = blockTypes.sandstone;
                                                blocksCount++;
                                            }
                                        }
                                    }
                                }
                            }

    // Build sets of leaf and log block IDs so we don't place clutter on/in trees
    const leafIds = new Set();
    const logIds = new Set();
    for (const t of Object.values(TREE_BY_BIOME)) {
        if (blockTypes[t.leaf]) leafIds.add(blockTypes[t.leaf]);
        if (blockTypes[t.log]) logIds.add(blockTypes[t.log]);
    }
    for (const k of Object.keys(blockTypes)) {
        if (k.includes("leaves") && blockTypes[k]) leafIds.add(blockTypes[k]);
        if ((k.includes("-log") || k === "mushroom-stem") && blockTypes[k]) logIds.add(blockTypes[k]);
    }

    // Surface clutter: rocks, flowers, fallen logs (all non-desert/ocean land)
    for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
            const wX = startX + x, wZ = startZ + z;
            const biome = biomeMap[z * width + x];
            if (biome === "desert" || biome === "ocean") continue;
            if (rng() >= 0.08) continue;

            let sh = 0;
            for (let y = maxHeight - 1; y >= 0; y--) {
                const bk = `${wX},${y},${wZ}`;
                if (terrainData[bk] && terrainData[bk] !== blockTypes["water-still"]) { sh = y; break; }
            }
            if (sh <= seaLevel || sh <= 0) continue;
            const surf = terrainData[`${wX},${sh},${wZ}`];
            if (!surf || surf === blockTypes.sand || surf === blockTypes["sand-wet"] || surf === blockTypes.snow) continue;
            if (leafIds.has(surf) || logIds.has(surf)) continue;
            if (terrainData[`${wX},${sh + 1},${wZ}`]) continue;

            const roll = rng();
            if (roll < 0.35) {
                terrainData[`${wX},${sh + 1},${wZ}`] = blockTypes.cobblestone || blockTypes.stone;
            } else if (roll < 0.65) {
                terrainData[`${wX},${sh + 1},${wZ}`] = blockTypes["grass-flower"] || blockTypes["grass-flower-block"] || blockTypes.grass;
            } else if (roll < 0.85) {
                terrainData[`${wX},${sh + 1},${wZ}`] = blockTypes.grass;
            } else {
                const logId = blockTypes["oak-log"] || blockTypes["birch-log"];
                if (logId && rng() < 0.5) {
                    terrainData[`${wX},${sh + 1},${wZ}`] = logId;
                    if (rng() < 0.5 && !terrainData[`${wX + 1},${sh + 1},${wZ}`]) terrainData[`${wX + 1},${sh + 1},${wZ}`] = logId;
                }
            }
        }
    }

    // Swamp features: mushrooms
    for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
            const wX = startX + x, wZ = startZ + z;
            const biome = biomeMap[z * width + x];
            if (biome !== "swamp") continue;
            if (rng() >= 0.02) continue;

            let sh = 0;
            for (let y = maxHeight - 1; y >= 0; y--) {
                const bk = `${wX},${y},${wZ}`;
                if (terrainData[bk] && terrainData[bk] !== blockTypes["water-still"]) { sh = y; break; }
            }
            if (sh <= seaLevel) continue;
            const swampSurf = terrainData[`${wX},${sh},${wZ}`];
            if (leafIds.has(swampSurf) || logIds.has(swampSurf)) continue;

            // Small mushroom
            const mh = 3 + Math.floor(rng() * 2);
            let canPlace = true;
            for (let ty = 1; ty <= mh + 1; ty++)
                if (terrainData[`${wX},${sh + ty},${wZ}`]) { canPlace = false; break; }
            if (!canPlace) continue;

            for (let ty = 1; ty <= mh; ty++) {
                terrainData[`${wX},${sh + ty},${wZ}`] = blockTypes["mushroom-stem"] || blockTypes["oak-log"] || blockTypes.stone;
                blocksCount++;
            }
            const cap = rng() < 0.5 ? blockTypes["brown-mushroom-block"] : blockTypes["red-mushroom-block"];
            for (let dx = -1; dx <= 1; dx++)
                        for (let dz = -1; dz <= 1; dz++) {
                    const lk = `${wX + dx},${sh + mh + 1},${wZ + dz}`;
                    if (!terrainData[lk]) { terrainData[lk] = cap || blockTypes["oak-leaves"]; blocksCount++; }
                }
        }
    }

    // Frozen lakes in snowy biomes
    for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
            const wX = startX + x, wZ = startZ + z;
            const biome = biomeMap[z * width + x];
            if (!biome.startsWith("snowy_")) continue;
            const k = `${wX},${wZ}`;
            if (!waterMap[k]) continue;
            const iceKey = `${wX},${seaLevel},${wZ}`;
            if (terrainData[iceKey] === blockTypes["water-still"]) {
                terrainData[iceKey] = blockTypes.ice || blockTypes.snow;
            }
        }
    }

    // Deepslate crust passover: map deepslate to the underside of the terrain (2 blocks thick to seal gaps)
    updateProgress("Adding deepslate crust...", 98);
    const deepslateId = blockTypes.deepslate || blockTypes["cobbled-deepslate"] || blockTypes.stone;
    const colMinY = new Map(); // "x,z" -> lowest Y in that column
    for (const [, r] of blockStore.regions) {
        for (const [posKey] of iteratePackedRegion(r.packed, r.rx, r.ry, r.rz)) {
            const [px, py, pz] = posKey.split(",").map(Number);
            const k = `${px},${pz}`;
            const cur = colMinY.get(k);
            if (cur === undefined || py < cur) colMinY.set(k, py);
        }
    }
    for (const [k, minY] of colMinY) {
        const [px, pz] = k.split(",").map(Number);
        terrainData[`${px},${minY},${pz}`] = deepslateId;
        if (minY > 0) terrainData[`${px},${minY - 1},${pz}`] = deepslateId;
    }

    updateProgress(`World generation complete. Created ${blocksCount} blocks.`, 100);
    return { blockStore, terrainData };
}

// ---------------------------------------------------------------------------
// 3D Density Field
// ---------------------------------------------------------------------------
function generate3DDensityField(width, height, length, settings, seedNum, biomeMap, finalHeightMap, isFlat) {
    const densityField = new Float32Array(width * height * length);
    const seaLevel = settings.seaLevel ?? Math.floor(height * 0.55);
    const baseY = Math.max(4, seaLevel - 20);
    const heightRange = Math.min(height - 12, 48) * (settings.roughness || 1.0);

    const continentalnessNoise = generatePerlinNoise3D(width, height, length, {
        octaveCount: 2, scale: (settings.scale || 0.05) * 0.5,
        persistence: 0.7, amplitude: 1.0, seed: seedNum,
    });

    for (let z = 0; z < length; z++) {
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = z * width * height + y * width + x;
                const bIdx = z * width + x;
                const biome = biomeMap[bIdx];
                const rawH = finalHeightMap[bIdx];

                if (isFlat) {
                    const flatH = Math.round(16 + rawH * 32);
                    densityField[idx] = y < flatH ? 10.0 : -10.0;
                } else {
                    const targetSurface = baseY + rawH * heightRange;
                    let density = targetSurface - y;
                    if (biome === "desert") density += 0.5;
                    else if (biome === "forest" || biome === "jungle") density -= 0.5;
                    density += continentalnessNoise[idx] * 2.5 * (1.0 - (settings.flatnessFactor || 0));
                    if (y <= 1) density = 10.0;
                    densityField[idx] = density;
                }
            }
        }
    }
    return densityField;
}

/**
 * Compute preview data for seed map preview. Uses same heightmap + biome logic as full generator.
 * Returns block Y and biome per (x,z) for 1:1 topography preview.
 * @returns {{ blockY: Int32Array, biomeMap: string[], seaLevel: number, width: number, length: number }}
 */
export function computePreviewData(settings, seedNum) {
    const width = settings.width;
    const length = settings.length;
    const maxHeight = settings.maxHeight ?? 64;
    const seaLevel = settings.seaLevel ?? Math.floor(maxHeight * 0.55);
    const scale = settings.scale || 0.04;

    const continentalNoise = generatePerlinNoise(width, length, {
        octaveCount: 2, scale: scale * 0.4, persistence: 0.6, amplitude: 1.0, seed: seedNum,
    });
    const hillNoise = generatePerlinNoise(width, length, {
        octaveCount: 4, scale: scale * 1.5, persistence: 0.5, amplitude: 0.6, seed: seedNum + 1,
    });
    const detailNoise = generatePerlinNoise(width, length, {
        octaveCount: 6, scale: scale * 4, persistence: 0.45, amplitude: 0.25, seed: seedNum + 2,
    });
    const depthMap = generatePerlinNoise(width, length, {
        octaveCount: 2, scale: 0.018, persistence: 0.5, amplitude: 0.25, seed: seedNum + 6,
    });
    const riverValleyNoise = generatePerlinNoise(width, length, {
        octaveCount: 2, scale: (settings.riverFreq || 0.05) * 0.8, persistence: 0.5, amplitude: 1.0, seed: seedNum + 5,
    });

    const heightMap = new Float32Array(width * length);
    const flatFactor = settings.flatnessFactor || 0;
    const elevExp = settings.elevationExponent ?? 1.5;
    const amp = (settings.baseAmplitude ?? 1.0) * 0.5;
    const landBias = settings.landBias ?? 0.15;

    if (settings.isCompletelyFlat) {
        for (let i = 0; i < heightMap.length; i++) heightMap[i] = 0.25;
    } else {
        for (let i = 0; i < heightMap.length; i++) {
            const base = continentalNoise[i];
            const hill = hillNoise[i] * (1.0 - flatFactor);
            const detail = detailNoise[i] * (1.0 - flatFactor) * 0.5;
            const depth = depthMap[i] * (1.0 - flatFactor) * 0.2;
            const riverValley = Math.max(0, riverValleyNoise[i] - 0.45) * 2.5;
            const raw = (base + hill + detail) * (1.0 + depth) * amp;
            const carved = Math.max(0, raw - riverValley * 0.35);
            const normalized = Math.max(0, Math.min(1, carved));
            const lifted = Math.min(1, normalized + landBias);
            heightMap[i] = Math.pow(lifted, elevExp) * (1.0 - flatFactor) + 0.4 * flatFactor;
        }
    }

    const smoothedHeightMap = new Float32Array(width * length);
    const sRadius = Math.floor(2 + (settings.terrainBlend || 0.5) * 2);
    const smoothing = settings.smoothing || 0.7;
    for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
            let total = 0, count = 0;
            for (let dz = -sRadius; dz <= sRadius; dz++) {
                for (let dx = -sRadius; dx <= sRadius; dx++) {
                    const nx = x + dx, nz = z + dz;
                    if (nx >= 0 && nx < width && nz >= 0 && nz < length) {
                        const d = Math.sqrt(dx * dx + dz * dz);
                        const w = 1 / (1 + d);
                        total += heightMap[nz * width + nx] * w;
                        count += w;
                    }
                }
            }
            smoothedHeightMap[z * width + x] =
                (total / count) * smoothing + heightMap[z * width + x] * (1 - smoothing);
        }
    }

    const roughness = settings.roughness || 1.0;
    const baseY = Math.max(4, seaLevel - 20);
    const heightRange = Math.min(maxHeight - 12, 48) * roughness;
    const erodedHeightMap = new Float32Array(width * length);
    for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
            const idx = z * width + x;
            if (settings.isCompletelyFlat) { erodedHeightMap[idx] = heightMap[idx]; continue; }
            let h = Math.floor(baseY + smoothedHeightMap[idx] * heightRange);
            for (let dz = -1; dz <= 1; dz++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = x + dx, nz = z + dz;
                    if (nx >= 0 && nx < width && nz >= 0 && nz < length) {
                        const nh = Math.floor(baseY + smoothedHeightMap[nz * width + nx] * heightRange);
                        if (nh < h - 1) h = Math.max(h - 1, nh + 1);
                    }
                }
            }
            erodedHeightMap[idx] = (h - baseY) / heightRange;
        }
    }
    const finalHeightMap = settings.isCompletelyFlat ? heightMap : erodedHeightMap;

    const blockY = new Int32Array(width * length);
    for (let i = 0; i < blockY.length; i++) {
        blockY[i] = Math.floor(baseY + finalHeightMap[i] * heightRange);
    }

    const BIOME_SCALE = 0.028;
    const tempMap = generatePerlinNoise(width, length, {
        octaveCount: 1, scale: BIOME_SCALE, persistence: 0.5, amplitude: 1.0, seed: seedNum + 7,
    });
    const temperatureOffset = (settings.temperature || 0.5) - 0.5;
    const humidityMap = generatePerlinNoise(width, length, {
        octaveCount: 1, scale: BIOME_SCALE * 0.8, persistence: 0.5, amplitude: 1.0, seed: seedNum + 8,
    });
    const biomeToggles = settings.biomeToggles || {};
    const isBiomeEnabled = (b) => biomeToggles[b] !== false;
    const fallbacks = {
        snowy_plains: ["snowy_forest", "snowy_taiga", "plains"],
        snowy_forest: ["snowy_taiga", "snowy_plains", "forest"],
        snowy_taiga: ["snowy_forest", "snowy_plains", "taiga"],
        plains: ["forest", "savanna"],
        forest: ["taiga", "plains", "jungle"],
        taiga: ["forest", "snowy_taiga", "plains"],
        swamp: ["forest", "jungle", "plains"],
        savanna: ["plains", "desert", "jungle"],
        jungle: ["forest", "swamp", "savanna"],
        desert: ["savanna", "plains"],
        poplar_forest: ["forest", "taiga"],
        cherry_grove: ["forest", "plains"],
    };
    const getFallback = (b) => {
        for (const fb of (fallbacks[b] || ["plains"])) {
            if (isBiomeEnabled(fb)) return fb;
        }
        return "plains";
    };
    const biomeEmphasis = settings.biomeEmphasis || {};
    const humidityOffset = settings.humidityOffset ?? 0;

    const biomeMap = new Array(width * length);
    let rngState = (seedNum >>> 0) || 1;
    const rng = () => {
        rngState = (rngState + 0x6d2b79f5) | 0;
        let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
            const idx = z * width + x;
            const temp = tempMap[idx] + temperatureOffset;
            const hum = humidityMap[idx] + humidityOffset;
            let biome;
            if (temp < 0.2) biome = hum < 0.3 ? "snowy_plains" : hum < 0.6 ? "snowy_forest" : "snowy_taiga";
            else if (temp < 0.4) biome = hum < 0.3 ? "plains" : hum < 0.6 ? "forest" : "taiga";
            else if (temp < 0.6) biome = hum < 0.3 ? "plains" : hum < 0.6 ? "forest" : "swamp";
            else if (temp < 0.8) biome = hum < 0.3 ? "savanna" : hum < 0.6 ? "jungle" : "swamp";
            else biome = hum < 0.3 ? "desert" : hum < 0.6 ? "savanna" : "jungle";
            if (!isBiomeEnabled(biome)) biome = getFallback(biome);
            const isForesty = ["forest", "taiga", "snowy_forest", "snowy_taiga"].includes(biome);
            const poplarBoost = (biomeEmphasis["poplar_forest"] || 1) - 1;
            const cherryBoost = (biomeEmphasis["cherry_grove"] || 1) - 1;
            if (isForesty) {
                if (temp < 0.5 && rng() < 0.3 + poplarBoost * 0.3 && isBiomeEnabled("poplar_forest")) biome = "poplar_forest";
                else if (temp >= 0.5 && rng() < 0.25 + cherryBoost * 0.3 && isBiomeEnabled("cherry_grove")) biome = "cherry_grove";
            }
            for (const [eb, weight] of Object.entries(biomeEmphasis).filter(([, w]) => w > 1.1)) {
                if (eb === biome || !isBiomeEnabled(eb)) continue;
                if (rng() < ((weight - 1) * 0.22)) { biome = eb; break; }
            }
            biomeMap[idx] = biome;
        }
    }

    return { blockY, biomeMap, seaLevel, width, length };
}

export default { generateHytopiaWorld };
