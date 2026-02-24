/**
 * BlockRegionPacker.js - Compact binary format for terrain regions
 *
 * Replaces Record<string, number> (one property per block → "too many properties")
 * with a single Uint16Array per region. Index = localX + localZ*S + localY*S*S.
 * Enables billions of blocks without hitting JS object property limits.
 */

export const REGION_SIZE = 64;

export function localIndex(lx, ly, lz) {
    return lx + REGION_SIZE * (lz + REGION_SIZE * ly);
}

/** World coords → flat index in region, or -1 if out of bounds */
export function worldToRegionIndex(x, y, z, rx, ry, rz) {
    const lx = x - rx * REGION_SIZE;
    const ly = y - ry * REGION_SIZE;
    const lz = z - rz * REGION_SIZE;
    if (lx < 0 || lx >= REGION_SIZE || ly < 0 || ly >= REGION_SIZE || lz < 0 || lz >= REGION_SIZE) return -1;
    return localIndex(lx, ly, lz);
}

export const REGION_VOLUME = REGION_SIZE * REGION_SIZE * REGION_SIZE;

function worldToLocal(x, y, z, rx, ry, rz) {
    return {
        lx: x - rx * REGION_SIZE,
        ly: y - ry * REGION_SIZE,
        lz: z - rz * REGION_SIZE,
    };
}

/**
 * Pack sparse block object to Uint16Array. Zero = air (not stored in sparse format).
 * @param {Record<string, number>} blocks - "x,y,z" -> blockId
 * @param {number} rx - region X
 * @param {number} ry - region Y
 * @param {number} rz - region Z
 * @returns {Uint16Array} Dense array of block IDs
 */
export function packRegion(blocks, rx, ry, rz) {
    const data = new Uint16Array(REGION_VOLUME);
    const baseX = rx * REGION_SIZE;
    const baseY = ry * REGION_SIZE;
    const baseZ = rz * REGION_SIZE;
    for (const posKey in blocks) {
        if (!Object.prototype.hasOwnProperty.call(blocks, posKey)) continue;
        const id = blocks[posKey];
        if (!id) continue;
        const parts = posKey.split(",").map(Number);
        if (parts.length < 3) continue;
        const [x, y, z] = parts;
        const { lx, ly, lz } = worldToLocal(x, y, z, rx, ry, rz);
        if (lx < 0 || lx >= REGION_SIZE || ly < 0 || ly >= REGION_SIZE || lz < 0 || lz >= REGION_SIZE) continue;
        data[localIndex(lx, ly, lz)] = id;
    }
    return data;
}

/**
 * Unpack Uint16Array to sparse Record. Skips air (0).
 * @param {Uint16Array} data
 * @param {number} rx
 * @param {number} ry
 * @param {number} rz
 * @returns {Record<string, number>}
 */
export function unpackRegion(data, rx, ry, rz) {
    const out = {};
    const baseX = rx * REGION_SIZE;
    const baseY = ry * REGION_SIZE;
    const baseZ = rz * REGION_SIZE;
    for (let ly = 0; ly < REGION_SIZE; ly++) {
        for (let lz = 0; lz < REGION_SIZE; lz++) {
            for (let lx = 0; lx < REGION_SIZE; lx++) {
                const id = data[localIndex(lx, ly, lz)];
                if (id) out[`${baseX + lx},${baseY + ly},${baseZ + lz}`] = id;
            }
        }
    }
    return out;
}

/**
 * Iterate non-air blocks from packed region. Yields [posKey, blockId].
 * Avoids building a full object - no property enumeration.
 */
export function* iteratePackedRegion(packed, rx, ry, rz) {
    const baseX = rx * REGION_SIZE;
    const baseY = ry * REGION_SIZE;
    const baseZ = rz * REGION_SIZE;
    for (let i = 0; i < packed.length; i++) {
        const id = packed[i];
        if (!id) continue;
        const lx = i % REGION_SIZE;
        const rem = Math.floor(i / REGION_SIZE);
        const lz = rem % REGION_SIZE;
        const ly = Math.floor(rem / REGION_SIZE);
        yield [`${baseX + lx},${baseY + ly},${baseZ + lz}`, id];
    }
}

/**
 * Detect if data is legacy format (object with string keys) or packed (has _v and d).
 * @param {*} data
 * @returns {boolean} true if packed format
 */
export function isPackedFormat(data) {
    return data && typeof data === "object" && data._v === 1 && data.d instanceof Uint16Array;
}

/**
 * Wrap packed array for storage. { _v: 1, d: Uint16Array }
 */
export function toStoredFormat(rx, ry, rz, data) {
    return { _v: 1, rx, ry, rz, d: data };
}

/**
 * Parse stored format. Accepts legacy { "x,y,z": id } or packed { _v: 1, d: Uint16Array, rx, ry, rz }.
 * @returns {{ packed: Uint16Array, rx: number, ry: number, rz: number } | null}
 */
export function fromStoredFormat(stored, regionKey) {
    if (!stored || typeof stored !== "object") return null;
    if (isPackedFormat(stored)) {
        const [rx, ry, rz] = (stored.rx != null ? `${stored.rx},${stored.ry},${stored.rz}` : regionKey).split(",").map(Number);
        return { packed: stored.d, rx: rx || 0, ry: ry || 0, rz: rz || 0 };
    }
    // Legacy: plain object, need region coords from key
    const parts = (regionKey || "").split(",").map(Number);
    if (parts.length < 3) return null;
    const [rx, ry, rz] = parts;
    const packed = packRegion(stored, rx, ry, rz);
    return { packed, rx, ry, rz };
}

/**
 * Region-based block store for generation. Avoids building a single object with millions of properties.
 * Use as a drop-in via asTerrainDataProxy() for TerrainGenerator.
 */
export class RegionBlockStore {
    constructor() {
        this.regions = new Map(); // rk -> { packed, rx, ry, rz }
    }

    _ensureRegion(rx, ry, rz) {
        const rk = `${rx},${ry},${rz}`;
        let r = this.regions.get(rk);
        if (!r) {
            r = { packed: new Uint16Array(REGION_VOLUME), rx, ry, rz };
            this.regions.set(rk, r);
        }
        return r;
    }

    set(x, y, z, blockId) {
        const rx = Math.floor(x / REGION_SIZE);
        const ry = Math.floor(y / REGION_SIZE);
        const rz = Math.floor(z / REGION_SIZE);
        const r = this._ensureRegion(rx, ry, rz);
        const idx = worldToRegionIndex(x, y, z, rx, ry, rz);
        if (idx >= 0) r.packed[idx] = blockId || 0;
    }

    get(x, y, z) {
        const rx = Math.floor(x / REGION_SIZE);
        const ry = Math.floor(y / REGION_SIZE);
        const rz = Math.floor(z / REGION_SIZE);
        const rk = `${rx},${ry},${rz}`;
        const r = this.regions.get(rk);
        if (!r) return 0;
        const idx = worldToRegionIndex(x, y, z, rx, ry, rz);
        return idx >= 0 ? r.packed[idx] || 0 : 0;
    }

    deleteBlock(x, y, z) {
        this.set(x, y, z, 0);
    }

    getBlockCount() {
        let n = 0;
        for (const [, r] of this.regions) {
            for (let i = 0; i < r.packed.length; i++) if (r.packed[i]) n++;
        }
        return n;
    }

    getRegionsForBulkLoad() {
        return this.regions;
    }
}

function keyToPos(key) {
    const parts = String(key).split(",").map(Number);
    return parts.length >= 3 ? { x: parts[0], y: parts[1], z: parts[2] } : null;
}

/**
 * Proxy that makes RegionBlockStore look like Record<string, number> for TerrainGenerator.
 */
export function asTerrainDataProxy(store) {
    return new Proxy(store, {
        get(target, prop) {
            if (prop === "then" || prop === "toJSON" || typeof prop !== "string") return undefined;
            const p = keyToPos(prop);
            return p ? target.get(p.x, p.y, p.z) || undefined : undefined;
        },
        set(target, prop, value) {
            if (typeof prop !== "string") return true;
            const p = keyToPos(prop);
            if (p) target.set(p.x, p.y, p.z, value);
            return true;
        },
        has(target, prop) {
            if (typeof prop !== "string") return false;
            const p = keyToPos(prop);
            return p ? !!target.get(p.x, p.y, p.z) : false;
        },
        deleteProperty(target, prop) {
            if (typeof prop !== "string") return true;
            const p = keyToPos(prop);
            if (p) target.deleteBlock(p.x, p.y, p.z);
            return true;
        },
    });
}

export default { packRegion, unpackRegion, isPackedFormat, toStoredFormat, fromStoredFormat, REGION_SIZE, REGION_VOLUME, worldToRegionIndex, localIndex, RegionBlockStore, asTerrainDataProxy };
