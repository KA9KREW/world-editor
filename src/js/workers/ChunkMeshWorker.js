/**
 * ChunkMeshWorker.js
 * Web Worker for chunk mesh generation. Offloads CPU-heavy mesh building from main thread.
 * Handles standard cube blocks with face culling and precomputed UVs.
 */
/* eslint-disable no-restricted-globals */

const CHUNK_SIZE = 16;
const EXTENDED = 18; // CHUNK_SIZE + 2 for neighbor padding
const FACE_SHADE_TOP = 1.0;
const FACE_SHADE_SIDE = 0.8;
const FACE_SHADE_BOTTOM = 0.5;

const FACE_NAMES = ["left", "right", "top", "bottom", "front", "back"];
const FACE_NORMALS = {
    left: [-1, 0, 0],
    right: [1, 0, 0],
    top: [0, 1, 0],
    bottom: [0, -1, 0],
    front: [0, 0, 1],
    back: [0, 0, -1],
};

// Quad vertices: 4 corners with pos and uv (local 0-1)
const FACE_QUADS = {
    left: { normal: [-1, 0, 0], verts: [[0, 1, 0, 0, 1], [0, 0, 0, 0, 0], [0, 1, 1, 1, 1], [0, 0, 1, 1, 0]] },
    right: { normal: [1, 0, 0], verts: [[1, 1, 1, 0, 1], [1, 0, 1, 0, 0], [1, 1, 0, 1, 1], [1, 0, 0, 1, 0]] },
    top: { normal: [0, 1, 0], verts: [[0, 1, 1, 1, 1], [1, 1, 1, 0, 1], [0, 1, 0, 1, 0], [1, 1, 0, 0, 0]] },
    bottom: { normal: [0, -1, 0], verts: [[1, 0, 1, 1, 0], [0, 0, 1, 0, 0], [1, 0, 0, 1, 1], [0, 0, 0, 0, 1]] },
    front: { normal: [0, 0, 1], verts: [[0, 0, 1, 0, 0], [1, 0, 1, 1, 0], [0, 1, 1, 0, 1], [1, 1, 1, 1, 1]] },
    back: { normal: [0, 0, -1], verts: [[1, 0, 0, 0, 0], [0, 0, 0, 1, 0], [1, 1, 0, 0, 1], [0, 1, 0, 1, 1]] },
};

function getFaceShade(face) {
    if (face === "top") return FACE_SHADE_TOP;
    if (face === "bottom") return FACE_SHADE_BOTTOM;
    return FACE_SHADE_SIDE;
}

function buildChunkMesh(data) {
    const { originX, originY, originZ, paddedBlocks, blockConfig, uvTable, rotations } = data;
    const solidPositions = [];
    const solidNormals = [];
    const solidUvs = [];
    const solidColors = [];
    const solidIndices = [];
    const liquidPositions = [];
    const liquidNormals = [];
    const liquidUvs = [];
    const liquidColors = [];
    const liquidIndices = [];

    const getBlockAt = (ex, ey, ez) => {
        if (ex < 0 || ex >= EXTENDED || ey < 0 || ey >= EXTENDED || ez < 0 || ez >= EXTENDED) return 0;
        const idx = ex + EXTENDED * (ey + EXTENDED * ez);
        return paddedBlocks[idx] || 0;
    };

    const getUv = (blockId, face, u, v) => {
        const cfg = blockConfig[blockId];
        if (!cfg) return [0, 0];
        const key = cfg.textureKey?.[face] || cfg.textureKey?.top || "error";
        const uvKey = `${u},${v}`;
        const table = uvTable[key];
        if (table && table[uvKey]) return table[uvKey];
        return [0, 0];
    };

    const getRotation = (lx, ly, lz) => {
        if (!rotations) return 0;
        const idx = lx + CHUNK_SIZE * (ly + CHUNK_SIZE * lz);
        return rotations[idx] || 0;
    };

    for (let y = 0; y < CHUNK_SIZE; y++) {
        for (let z = 0; z < CHUNK_SIZE; z++) {
            for (let x = 0; x < CHUNK_SIZE; x++) {
                const ex = x + 1;
                const ey = y + 1;
                const ez = z + 1;
                const blockId = getBlockAt(ex, ey, ez);
                if (!blockId) continue;

                const cfg = blockConfig[blockId];
                if (!cfg || cfg.isTrimesh) continue;

                const globalX = originX + x;
                const globalY = originY + y;
                const globalZ = originZ + z;
                const rotation = getRotation(x, y, z);
                if (rotation !== 0) continue;

                for (const face of cfg.faces || FACE_NAMES) {
                    const normal = FACE_NORMALS[face] || FACE_QUADS[face]?.normal;
                    if (!normal) continue;
                    const dnx = Math.round(normal[0]);
                    const dny = Math.round(normal[1]);
                    const dnz = Math.round(normal[2]);
                    const neighborId = getBlockAt(ex + dnx, ey + dny, ez + dnz);
                    const neighborCfg = blockConfig[neighborId];
                    if (neighborCfg && !neighborCfg.isTrimesh) {
                        const blocksFace = !neighborCfg.isTransparent?.[face];
                        const sameLiquid = neighborCfg.isLiquid && neighborCfg.id === blockId;
                        if (neighborCfg.isLiquid ? sameLiquid : blocksFace) continue;
                    }

                    const quad = FACE_QUADS[face];
                    if (!quad) continue;

                    const shade = getFaceShade(face);
                    const r = shade;
                    const g = shade;
                    const b = shade;
                    const a = 1;

                    const isLiquid = cfg.isLiquid;
                    const positions = isLiquid ? liquidPositions : solidPositions;
                    const normals = isLiquid ? liquidNormals : solidNormals;
                    const uvs = isLiquid ? liquidUvs : solidUvs;
                    const colors = isLiquid ? liquidColors : solidColors;
                    const indices = isLiquid ? liquidIndices : solidIndices;
                    const ndx = positions.length / 3;

                    for (const v of quad.verts) {
                        const vx = globalX + v[0];
                        const vy = globalY + v[1];
                        const vz = globalZ + v[2];
                        positions.push(vx, vy, vz);
                        normals.push(normal[0], normal[1], normal[2]);
                        const uv = getUv(blockId, face, v[3], v[4]);
                        uvs.push(uv[0], uv[1]);
                        colors.push(r, g, b, a);
                    }
                    indices.push(ndx, ndx + 1, ndx + 2, ndx + 2, ndx + 1, ndx + 3);
                }
            }
        }
    }

    return {
        solid: { positions: solidPositions, normals: solidNormals, uvs: solidUvs, colors: solidColors, indices: solidIndices },
        liquid: { positions: liquidPositions, normals: liquidNormals, uvs: liquidUvs, colors: liquidColors, indices: liquidIndices },
    };
}

self.onmessage = function (e) {
    const { type, id, data } = e.data;
    try {
        if (type === "build") {
            const result = buildChunkMesh(data);
            self.postMessage({ type: "result", id, result });
        } else {
            self.postMessage({ type: "error", id, error: `Unknown: ${type}` });
        }
    } catch (err) {
        self.postMessage({ type: "error", id, error: String(err.message || err) });
    }
};
