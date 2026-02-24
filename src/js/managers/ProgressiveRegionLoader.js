/**
 * ProgressiveRegionLoader.js
 *
 * Camera-driven region loading for VirtualTerrainStore. Loads regions around
 * the camera and preloads neighboring regions in the background.
 */

import { DatabaseManager } from "./DatabaseManager";
import { REGION_SIZE, worldToRegion, getRegionsInRadius } from "./VirtualTerrainStore";

const LOAD_RADIUS_BLOCKS = 50;  // 50×50 block load area around camera
const PRELOAD_RADIUS_BLOCKS = 80; // Preload slightly beyond for smooth movement
const THROTTLE_MS = 500;

export function createProgressiveLoader(virtualStore, getCameraPosition, onRegionsLoaded) {
    let lastCameraRegion = null;
    let lastLoadTime = 0;
    let loadQueue = [];

    async function loadRegion(regionKey) {
        const data = await DatabaseManager.getTerrainRegion(regionKey);
        return data;
    }

    async function processLoadQueue() {
        if (loadQueue.length === 0) return;
        const [rx, ry, rz] = loadQueue.shift();
        const regionKey = `${rx},${ry},${rz}`;
        try {
            await virtualStore.ensureRegionLoaded(rx, ry, rz);
            if (typeof onRegionsLoaded === "function") onRegionsLoaded();
        } catch (_) {}
        if (loadQueue.length > 0) {
            requestIdleCallback(processLoadQueue, { timeout: 100 });
        }
    }

    function ensureLoadRegion(rx, ry, rz) {
        const key = `${rx},${ry},${rz}`;
        if (virtualStore.hasRegion(key)) return;
        if (loadQueue.some(([a, b, c]) => a === rx && b === ry && c === rz)) return;
        loadQueue.push([rx, ry, rz]);
        if (loadQueue.length === 1) {
            requestIdleCallback(processLoadQueue, { timeout: 50 });
        }
    }

    function update() {
        const pos = getCameraPosition?.();
        if (!pos || typeof pos.x !== "number") return;

        const now = performance.now();
        if (now - lastLoadTime < THROTTLE_MS) return;

        const { rx, ry, rz } = worldToRegion(pos.x, pos.y, pos.z);
        const currentKey = `${rx},${ry},${rz}`;
        if (lastCameraRegion === currentKey) return;
        lastCameraRegion = currentKey;
        lastLoadTime = now;

        const loadRegions = getRegionsInRadius(rx, ry, rz, LOAD_RADIUS_BLOCKS);
        const preloadRegions = getRegionsInRadius(rx, ry, rz, PRELOAD_RADIUS_BLOCKS);
        const loadSet = new Set(loadRegions.map((r) => `${r.rx},${r.ry},${r.rz}`));
        const preloadSet = new Set(preloadRegions.map((r) => `${r.rx},${r.ry},${r.rz}`));

        for (const r of loadRegions) {
            ensureLoadRegion(r.rx, r.ry, r.rz);
        }
        requestIdleCallback(
            () => {
                for (const r of preloadRegions) {
                    if (!loadSet.has(`${r.rx},${r.ry},${r.rz}`)) {
                        ensureLoadRegion(r.rx, r.ry, r.rz);
                    }
                }
            },
            { timeout: 200 }
        );
    }

    return {
        update,
        ensureRegionLoaded: (rx, ry, rz) => virtualStore.ensureRegionLoaded(rx, ry, rz),
    };
}
