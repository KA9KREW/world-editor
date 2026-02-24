/**
 * VirtualTerrainStore.js
 *
 * Region-based virtual terrain for massive worlds (10k×10k+). Uses packed
 * Uint16Array per region (no object properties) to avoid "too many properties
 * to enumerate" with billions of blocks.
 */

import {
    REGION_SIZE as PACKER_REGION_SIZE,
    REGION_VOLUME,
    worldToRegionIndex,
    packRegion,
    fromStoredFormat,
    toStoredFormat,
    iteratePackedRegion,
} from "../utils/BlockRegionPacker";

export const REGION_SIZE = PACKER_REGION_SIZE;
const DEFAULT_MAX_REGIONS = 48; // ~16MB at 64³; reduced for lower memory
const REGION_KEY_PREFIX = "r:";

function regionKey(rx, ry, rz) {
    return `${rx},${ry},${rz}`;
}

function blockToRegion(x, y, z) {
    return {
        rx: Math.floor(x / REGION_SIZE),
        ry: Math.floor(y / REGION_SIZE),
        rz: Math.floor(z / REGION_SIZE),
    };
}

function posToKey(x, y, z) {
    return `${x},${y},${z}`;
}

function keyToPos(key) {
    const parts = key.split(",").map(Number);
    return parts.length >= 3 ? { x: parts[0], y: parts[1], z: parts[2] } : null;
}

function parseRegionKey(rk) {
    const parts = rk.split(",").map(Number);
    return parts.length >= 3 ? { rx: parts[0], ry: parts[1], rz: parts[2] } : null;
}

/**
 * LRU cache for terrain regions. Evicts least-recently-used regions
 * when capacity is exceeded.
 */
class RegionLRUCache {
    constructor(maxRegions) {
        this.maxRegions = maxRegions;
        this.cache = new Map(); // key -> { data, lastAccess }
    }

    get(key) {
        const entry = this.cache.get(key);
        if (!entry) return undefined;
        entry.lastAccess = performance.now();
        return entry.data;
    }

    set(key, data, onEvict) {
        if (this.cache.has(key)) {
            const e = this.cache.get(key);
            e.data = data;
            e.lastAccess = performance.now();
            return;
        }
        while (this.cache.size >= this.maxRegions) {
            let oldestKey = null;
            let oldestTime = Infinity;
            for (const [k, v] of this.cache) {
                if (v.lastAccess < oldestTime) {
                    oldestTime = v.lastAccess;
                    oldestKey = k;
                }
            }
            if (oldestKey !== null) {
                const evicted = this.cache.get(oldestKey);
                this.cache.delete(oldestKey);
                if (typeof onEvict === "function") onEvict(oldestKey, evicted.data);
            }
        }
        this.cache.set(key, { data, lastAccess: performance.now() });
    }

    has(key) {
        return this.cache.has(key);
    }

    delete(key) {
        return this.cache.delete(key);
    }

    keys() {
        return [...this.cache.keys()];
    }

    get size() {
        return this.cache.size;
    }
}

/**
 * VirtualTerrainStore - region-based terrain with LRU cache.
 */
export class VirtualTerrainStore {
    constructor(options = {}) {
        this.maxRegions = options.maxRegions ?? DEFAULT_MAX_REGIONS;
        this.regions = new RegionLRUCache(this.maxRegions);
        this.dirtyRegions = new Set();
        this.loadRegion = options.loadRegion ?? (async () => ({}));
        this.saveRegion = options.saveRegion ?? (async () => {});
        this._totalBlockCount = 0;
        this._blockCountStale = true;
    }

    _getRegionKey(rx, ry, rz) {
        return regionKey(rx, ry, rz);
    }

    _ensureRegion(rx, ry, rz) {
        const key = this._getRegionKey(rx, ry, rz);
        let data = this.regions.get(key);
        if (!data) {
            data = { packed: new Uint16Array(REGION_VOLUME), rx, ry, rz };
            this.regions.set(key, data, (evictedKey, evictedData) => {
                if (this.dirtyRegions.has(evictedKey)) {
                    const stored = toStoredFormat(evictedData.rx, evictedData.ry, evictedData.rz, evictedData.packed);
                    this.saveRegion(evictedKey, stored).catch(() => {});
                    this.dirtyRegions.delete(evictedKey);
                }
            });
        }
        return data;
    }

    /**
     * Sync get - returns block from cache only. Returns 0 (air) if not loaded.
     */
    getBlock(x, y, z) {
        const { rx, ry, rz } = blockToRegion(x, y, z);
        const data = this._ensureRegion(rx, ry, rz);
        const idx = worldToRegionIndex(x, y, z, rx, ry, rz);
        return idx >= 0 ? (data.packed[idx] || 0) : 0;
    }

    /**
     * Sync get - returns undefined if region not in cache (not yet loaded).
     */
    getBlockIfLoaded(x, y, z) {
        const { rx, ry, rz } = blockToRegion(x, y, z);
        const regionKey = this._getRegionKey(rx, ry, rz);
        const data = this.regions.get(regionKey);
        if (!data) return undefined;
        const idx = worldToRegionIndex(x, y, z, rx, ry, rz);
        return idx >= 0 ? (data.packed[idx] || 0) : 0;
    }

    /**
     * Sync set - creates region in cache if needed, marks dirty.
     */
    setBlock(x, y, z, blockId) {
        const { rx, ry, rz } = blockToRegion(x, y, z);
        const data = this._ensureRegion(rx, ry, rz);
        const idx = worldToRegionIndex(x, y, z, rx, ry, rz);
        if (idx >= 0) data.packed[idx] = blockId ? blockId : 0;
        this.dirtyRegions.add(this._getRegionKey(rx, ry, rz));
        this._blockCountStale = true;
    }

    /**
     * Remove block (set to air).
     */
    removeBlock(x, y, z) {
        this.setBlock(x, y, z, 0);
    }

    /**
     * Batch set blocks. Accepts Record<string, number>.
     */
    setBlocks(blocks) {
        for (const posKey in blocks) {
            if (!Object.prototype.hasOwnProperty.call(blocks, posKey)) continue;
            const p = keyToPos(posKey);
            if (p) this.setBlock(p.x, p.y, p.z, blocks[posKey]);
        }
    }

    /**
     * Bulk load from full terrain object (e.g. seed generation). Groups by region, uses packed format.
     */
    bulkLoad(terrainData) {
        if (!terrainData || typeof terrainData !== "object") return;
        this.clear();
        const regionMap = new Map(); // rk -> { [posKey]: blockId } for packing
        for (const posKey in terrainData) {
            if (!Object.prototype.hasOwnProperty.call(terrainData, posKey)) continue;
            const blockId = terrainData[posKey];
            if (!blockId) continue;
            const p = keyToPos(posKey);
            if (!p) continue;
            const { rx, ry, rz } = blockToRegion(p.x, p.y, p.z);
            const rk = regionKey(rx, ry, rz);
            if (!regionMap.has(rk)) regionMap.set(rk, { rx, ry, rz, blocks: {} });
            regionMap.get(rk).blocks[posKey] = blockId;
        }
        for (const [rk, { rx, ry, rz, blocks }] of regionMap) {
            const packed = packRegion(blocks, rx, ry, rz);
            const data = { packed, rx, ry, rz };
            this.regions.set(rk, data, (evictedKey, evictedData) => {
                if (this.dirtyRegions.has(evictedKey)) {
                    const stored = toStoredFormat(evictedData.rx, evictedData.ry, evictedData.rz, evictedData.packed);
                    this.saveRegion(evictedKey, stored).catch(() => {});
                    this.dirtyRegions.delete(evictedKey);
                }
            });
            this.dirtyRegions.add(rk);
        }
        this._blockCountStale = true;
    }

    /**
     * Bulk load from pre-packed region map (e.g. RegionBlockStore.getRegionsForBulkLoad()).
     * Avoids building a giant terrainData object.
     */
    bulkLoadFromRegions(regionMap) {
        if (!regionMap || typeof regionMap !== "object") return;
        this.clear();
        for (const [rk, r] of regionMap) {
            if (!r || !r.packed) continue;
            const data = { packed: r.packed, rx: r.rx, ry: r.ry, rz: r.rz };
            this.regions.set(rk, data, (evictedKey, evictedData) => {
                if (this.dirtyRegions.has(evictedKey)) {
                    const stored = toStoredFormat(evictedData.rx, evictedData.ry, evictedData.rz, evictedData.packed);
                    this.saveRegion(evictedKey, stored).catch(() => {});
                    this.dirtyRegions.delete(evictedKey);
                }
            });
            this.dirtyRegions.add(rk);
        }
        this._blockCountStale = true;
    }

    /**
     * Batch remove blocks.
     */
    removeBlocks(keys) {
        for (const posKey of keys) {
            const p = keyToPos(posKey);
            if (p) this.removeBlock(p.x, p.y, p.z);
        }
    }

    /**
     * Load a region from persistence. Accepts legacy or packed format.
     */
    async ensureRegionLoaded(rx, ry, rz) {
        const key = this._getRegionKey(rx, ry, rz);
        if (this.regions.has(key)) return;
        const raw = await this.loadRegion(key);
        const parsed = fromStoredFormat(raw, key);
        if (parsed) {
            const data = { packed: parsed.packed, rx: parsed.rx, ry: parsed.ry, rz: parsed.rz };
            this.regions.set(key, data, (evictedKey, evictedData) => {
                if (this.dirtyRegions.has(evictedKey)) {
                    const stored = toStoredFormat(evictedData.rx, evictedData.ry, evictedData.rz, evictedData.packed);
                    this.saveRegion(evictedKey, stored).catch(() => {});
                    this.dirtyRegions.delete(evictedKey);
                }
            });
            this._blockCountStale = true;
        }
    }

    /**
     * Iterate blocks in batches without building a full snapshot (avoids OOM for large worlds).
     */
    async getBlocksInBatches(batchSize, fn) {
        let batch = [];
        for (const rk of this.regions.keys()) {
            const data = this.regions.get(rk);
            if (!data || !data.packed) continue;
            const pr = parseRegionKey(rk);
            if (!pr) continue;
            for (const [posKey, blockId] of iteratePackedRegion(data.packed, pr.rx, pr.ry, pr.rz)) {
                batch.push([posKey, blockId]);
                if (batch.length >= batchSize) {
                    const result = fn(batch);
                    if (result && typeof result.then === "function") await result;
                    batch = [];
                }
            }
        }
        if (batch.length > 0) {
            const result = fn(batch);
            if (result && typeof result.then === "function") await result;
        }
    }

    /**
     * Get all blocks currently in loaded regions (snapshot for chunk system).
     * Builds object by iterating packed data - no Object.entries on huge objects.
     */
    getLoadedBlocksSnapshot() {
        const out = {};
        for (const rk of this.regions.keys()) {
            const data = this.regions.get(rk);
            if (!data || !data.packed) continue;
            const pr = parseRegionKey(rk);
            if (!pr) continue;
            for (const [posKey, blockId] of iteratePackedRegion(data.packed, pr.rx, pr.ry, pr.rz)) {
                out[posKey] = blockId;
            }
        }
        return out;
    }

    /**
     * Get array of block keys only (for proxy ownKeys - avoids building full snapshot object).
     */
    getLoadedBlocksKeys() {
        const keys = [];
        for (const rk of this.regions.keys()) {
            const data = this.regions.get(rk);
            if (!data || !data.packed) continue;
            const pr = parseRegionKey(rk);
            if (!pr) continue;
            for (const [posKey] of iteratePackedRegion(data.packed, pr.rx, pr.ry, pr.rz)) {
                keys.push(posKey);
            }
        }
        return keys;
    }

    /**
     * Get blocks in axis-aligned bounds (for chunk meshing).
     */
    getBlocksInBounds(minX, minY, minZ, maxX, maxY, maxZ) {
        const out = {};
        const minR = blockToRegion(minX, minY, minZ);
        const maxR = blockToRegion(maxX, maxY, maxZ);
        for (let rx = minR.rx; rx <= maxR.rx; rx++) {
            for (let ry = minR.ry; ry <= maxR.ry; ry++) {
                for (let rz = minR.rz; rz <= maxR.rz; rz++) {
                    const key = this._getRegionKey(rx, ry, rz);
                    const data = this.regions.get(key);
                    if (!data || !data.packed) continue;
                    for (const [posKey, blockId] of iteratePackedRegion(data.packed, rx, ry, rz)) {
                        const p = keyToPos(posKey);
                        if (!p) continue;
                        if (p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY && p.z >= minZ && p.z <= maxZ) {
                            out[posKey] = blockId;
                        }
                    }
                }
            }
        }
        return out;
    }

    /**
     * Persist all dirty regions.
     */
    async flushDirtyRegions() {
        const toSave = [...this.dirtyRegions];
        for (const key of toSave) {
            const data = this.regions.get(key);
            if (data && data.packed) {
                const stored = toStoredFormat(data.rx, data.ry, data.rz, data.packed);
                await this.saveRegion(key, stored);
            }
            this.dirtyRegions.delete(key);
        }
    }

    /**
     * Clear all in-memory data.
     */
    clear() {
        this.regions = new RegionLRUCache(this.maxRegions);
        this.dirtyRegions.clear();
        this._totalBlockCount = 0;
        this._blockCountStale = true;
    }

    getLoadedRegionKeys() {
        return this.regions.keys();
    }

    hasRegion(regionKey) {
        return this.regions.has(regionKey);
    }

    getBlockCountApprox() {
        if (!this._blockCountStale) return this._totalBlockCount;
        let n = 0;
        for (const rk of this.regions.keys()) {
            const data = this.regions.get(rk);
            if (!data || !data.packed) continue;
            const pr = parseRegionKey(rk);
            if (!pr) continue;
            for (const [,] of iteratePackedRegion(data.packed, pr.rx, pr.ry, pr.rz)) n++;
        }
        this._totalBlockCount = n;
        this._blockCountStale = false;
        return n;
    }

    /**
     * Get set of block IDs in use (avoids building full snapshot).
     */
    async getUsedBlockIds() {
        const ids = new Set();
        await this.getBlocksInBatches(5000, (batch) => {
            for (const [, blockId] of batch) {
                const id = typeof blockId === "number" ? blockId : parseInt(String(blockId), 10);
                if (!isNaN(id) && id > 0) ids.add(id);
            }
        });
        return ids;
    }

    /**
     * Create a Proxy-compatible object for terrainRef.current compatibility.
     * Supports: obj["x,y,z"], obj["x,y,z"] = id, delete obj["x,y,z"], Object.keys(obj).
     */
    asProxy() {
        const self = this;
        return new Proxy(
            {},
            {
                get(_, prop) {
                    if (prop === "then" || prop === "toJSON") return undefined;
                    if (prop === "getBlocksInBatches") return (batchSize, fn) => self.getBlocksInBatches(batchSize, fn);
                    if (typeof prop !== "string") return undefined;
                    const p = keyToPos(prop);
                    if (!p) return undefined;
                    return self.getBlock(p.x, p.y, p.z) || undefined;
                },
                set(_, prop, value) {
                    if (typeof prop !== "string") return true;
                    const p = keyToPos(prop);
                    if (!p) return true;
                    self.setBlock(p.x, p.y, p.z, value);
                    return true;
                },
                deleteProperty(_, prop) {
                    if (typeof prop !== "string") return true;
                    const p = keyToPos(prop);
                    if (!p) return true;
                    self.removeBlock(p.x, p.y, p.z);
                    return true;
                },
                has(_, prop) {
                    if (typeof prop !== "string") return false;
                    const p = keyToPos(prop);
                    if (!p) return false;
                    const v = self.getBlock(p.x, p.y, p.z);
                    return v !== 0 && v !== undefined;
                },
                ownKeys(_) {
                    return self.getLoadedBlocksKeys();
                },
                getOwnPropertyDescriptor(_, prop) {
                    if (typeof prop !== "string") return undefined;
                    const p = keyToPos(prop);
                    if (!p) return undefined;
                    const v = self.getBlock(p.x, p.y, p.z);
                    if (v === 0 || v === undefined) return undefined;
                    return { configurable: true, enumerable: true, value: v, writable: true };
                },
            }
        );
    }
}

export function worldToRegion(x, y, z) {
    return blockToRegion(x, y, z);
}

export function getRegionsInRadius(cx, cy, cz, radiusBlocks) {
    const radius = Math.ceil(radiusBlocks / REGION_SIZE);
    const out = [];
    for (let rx = -radius; rx <= radius; rx++) {
        for (let ry = -radius; ry <= radius; ry++) {
            for (let rz = -radius; rz <= radius; rz++) {
                if (rx * rx + ry * ry + rz * rz <= radius * radius) {
                    out.push({ rx: cx + rx, ry: cy + ry, rz: cz + rz });
                }
            }
        }
    }
    return out;
}
