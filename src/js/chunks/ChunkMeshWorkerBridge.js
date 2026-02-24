/**
 * ChunkMeshWorkerBridge.js
 * Prepares data for and communicates with ChunkMeshWorker.
 * Builds blockConfig and uvTable from BlockTypeRegistry and BlockTextureAtlas.
 */

import { getBlockTypes } from "../managers/BlockTypesManager";
import BlockTextureAtlas from "../blocks/BlockTextureAtlas";
import { CHUNK_SIZE } from "./ChunkConstants";

const EXTENDED = CHUNK_SIZE + 2;

let workerInstance = null;
let blockConfigCache = null;
let uvTableCache = null;
let nextId = 0;
const pending = new Map();

function getWorker() {
    if (!workerInstance) {
        try {
            workerInstance = new Worker(
                new URL("../workers/ChunkMeshWorker.js", import.meta.url)
            );
            workerInstance.onmessage = (e) => {
                const { type, id, result, error } = e.data;
                const resolve = pending.get(id);
                if (resolve) {
                    pending.delete(id);
                    if (type === "result") resolve({ ok: true, result });
                    else resolve({ ok: false, error });
                }
            };
            workerInstance.onerror = (err) => {
                pending.forEach((resolve) => resolve({ ok: false, error: String(err) }));
                pending.clear();
            };
        } catch (e) {
            console.warn("[ChunkMeshWorker] Failed to create worker:", e);
            return null;
        }
    }
    return workerInstance;
}

function buildBlockConfig() {
    if (blockConfigCache) return blockConfigCache;
    const config = {};
    try {
        const all = getBlockTypes?.() || [];
        for (const bt of all) {
            if (!bt || !bt.id) continue;
            const faces = bt.faces || ["left", "right", "top", "bottom", "front", "back"];
            const textureKey = {};
            const isTransparent = {};
            for (const f of faces) {
                try {
                    const path = bt.getTexturePath?.(f) || bt.textureUris?.[f] || "";
                    textureKey[f] = path || "error";
                    isTransparent[f] = bt.isFaceTransparent?.(f) ?? false;
                } catch (_) {
                    textureKey[f] = "error";
                    isTransparent[f] = false;
                }
            }
            config[bt.id] = {
                id: bt.id,
                isLiquid: !!bt.isLiquid,
                isTrimesh: !!bt.isTrimesh,
                faces,
                textureKey,
                isTransparent,
            };
        }
        blockConfigCache = config;
    } catch (e) {
        console.warn("[ChunkMeshWorker] buildBlockConfig error:", e);
    }
    return config;
}

function buildUvTable() {
    if (uvTableCache) return uvTableCache;
    const table = {};
    const corners = [[0, 0], [0, 1], [1, 0], [1, 1]];
    try {
        const atlas = BlockTextureAtlas.instance;
        if (!atlas) return table;
        const config = buildBlockConfig();
        const paths = new Set(["error", "./assets/blocks/error.png"]);
        for (const cfg of Object.values(config)) {
            for (const path of Object.values(cfg.textureKey || {})) {
                if (path) paths.add(path);
            }
        }
        for (const path of paths) {
            table[path] = {};
            for (const [u, v] of corners) {
                const uv = atlas.getTextureUVCoordinateSync?.(path, [u, v]);
                if (uv) table[path][`${u},${v}`] = uv;
            }
        }
        uvTableCache = table;
    } catch (e) {
        console.warn("[ChunkMeshWorker] buildUvTable error:", e);
    }
    return table;
}

export function invalidateWorkerCache() {
    blockConfigCache = null;
    uvTableCache = null;
}

export function canUseWorker(chunk, chunkManager) {
    if (!chunk._blocks || chunk._blocks.length !== CHUNK_SIZE ** 3) return false;
    for (let i = 0; i < chunk._blocks.length; i++) {
        const bid = chunk._blocks[i];
        if (!bid) continue;
        const cfg = buildBlockConfig()[bid];
        if (!cfg || cfg.isTrimesh) return false;
        const rot = chunk._blockRotations?.get(i);
        if (rot && rot > 0) return false;
        const shape = chunk._blockShapes?.get(i);
        if (shape && shape !== "cube") return false;
    }
    return true;
}

export function buildPaddedBlocks(chunk, chunkManager) {
    const padded = new Uint16Array(EXTENDED ** 3);
    const { x: ox, y: oy, z: oz } = chunk.originCoordinate;

    const getBlock = (gx, gy, gz) => {
        const lx = gx - ox;
        const ly = gy - oy;
        const lz = gz - oz;
        if (lx >= 0 && lx < CHUNK_SIZE && ly >= 0 && ly < CHUNK_SIZE && lz >= 0 && lz < CHUNK_SIZE) {
            return chunk._blocks[lx + CHUNK_SIZE * (ly + CHUNK_SIZE * lz)] || 0;
        }
        if (chunkManager?.getGlobalBlockId) {
            return chunkManager.getGlobalBlockId({ x: gx, y: gy, z: gz }) || 0;
        }
        return 0;
    };

    for (let ex = 0; ex < EXTENDED; ex++) {
        for (let ey = 0; ey < EXTENDED; ey++) {
            for (let ez = 0; ez < EXTENDED; ez++) {
                const gx = ox + ex - 1;
                const gy = oy + ey - 1;
                const gz = oz + ez - 1;
                const idx = ex + EXTENDED * (ey + EXTENDED * ez);
                padded[idx] = getBlock(gx, gy, gz);
            }
        }
    }
    return padded;
}

export function buildMeshesInWorker(chunk, chunkManager) {
    const w = getWorker();
    if (!w) return null;

    const paddedBlocks = buildPaddedBlocks(chunk, chunkManager);
    const blockConfig = buildBlockConfig();
    const uvTable = buildUvTable();

    const rotations = {};
    if (chunk._blockRotations) {
        for (const [idx, rot] of chunk._blockRotations) {
            if (rot > 0) return null;
            rotations[idx] = rot;
        }
    }

    const data = {
        originX: chunk.originCoordinate.x,
        originY: chunk.originCoordinate.y,
        originZ: chunk.originCoordinate.z,
        paddedBlocks,
        blockConfig,
        uvTable,
        rotations: Object.keys(rotations).length ? rotations : undefined,
    };

    return new Promise((resolve) => {
        const id = ++nextId;
        pending.set(id, resolve);
        w.postMessage({ type: "build", id, data });
    });
}
