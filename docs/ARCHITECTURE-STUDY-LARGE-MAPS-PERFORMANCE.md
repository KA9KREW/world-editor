# Architecture Study: Large Maps, Latency & Performance

A research document comparing Hytale's approach to large worlds with the HYTOPIA World Editor's current architecture, plus concrete options for improvement.

---

## Part 1: How Hytale Handles Large Maps

### Rendering

| Technique | Hytale | Our Editor |
|-----------|--------|------------|
| Chunk-based loading | ✓ Variable sizes | ✓ Fixed 16³ |
| Hidden face culling | ✓ At mesh level | ✓ In Chunk.buildMeshes |
| LOD (Level of Detail) | ✓ Distant chunks = simplified geometry | ✗ None |
| View distance | 32 chunks default, 5–12 for stability | 256 blocks (~16 chunks) |
| Mesh generation | Likely worker threads | Worker exists but **disabled** (`USE_CHUNK_MESH_WORKER = false`) |

### Memory & Streaming

| Technique | Hytale | Our Editor |
|-----------|--------|------------|
| Predictive loading | Chunks in movement direction first | ProgressiveRegionLoader (region-based) |
| Background unloading | Distant chunks compressed → disk | Chunk eviction (delete from memory) |
| Memory pools | Pre-allocated objects | Some object pooling |
| Block storage | N/A (native) | VirtualTerrainStore: 64³ regions, LRU, Uint16Array |

### Hytale Takeaway

- **View distance drives memory** – Reducing from 32 to 5–12 chunks greatly improves stability.
- **Pre-generating** worlds avoids on-demand spikes.
- **Memory scales with player spread** – 4 players ≈ 8GB, 15–30 players ≈ 16–32GB.

---

## Part 2: Current World Editor Architecture

### Data Flow

```
TerrainGenerator (worker or main)
    ↓
RegionBlockStore (packed Uint16Array per 64³ region)
    ↓
VirtualTerrainStore.bulkLoadFromRegions()  OR  bulkLoad(terrainData)  ← OOM risk
    ↓
ChunkSystem.updateFromTerrainDataFromStore()  OR  updateFromTerrainData(terrainData)
    ↓
ChunkManager.updateChunks() → mesh build (main thread)
```

### Identified Bottlenecks

1. **Full object materialization**
   - `getCurrentTerrainData()` → `getLoadedBlocksSnapshot()` builds a full `Record<string, number>`.
   - `updateTerrainChunks(terrainData)` → `Object.entries(terrainData)`.
   - `SpatialGridManager.updateFromTerrain(terrainData)` → full iteration.
   - `FindReplaceTool`, `ReplaceTool`, `TerrainTool` assume `terrainRef.current` is a full object.
   - **Impact**: OOM or heavy GC on large worlds.

2. **Chunk mesh generation on main thread**
   - `USE_CHUNK_MESH_WORKER = false` in ChunkConstants.
   - Each chunk mesh build blocks the UI.
   - 8 chunks per batch, 6–20ms spacing → slow initial load.

3. **No LOD**
   - Distant chunks use full geometry.
   - GPU draw calls and triangles scale linearly with loaded chunks.

4. **Spatial hash for raycasting**
   - Rebuilds from full terrain when needed.
   - Can be costly for large worlds.

5. **Database persistence**
   - `saveTerrainAsRegions` iterates `Object.entries(terrainData)` – expects full object.
   - Large worlds rely on VirtualTerrainStore `flushDirtyRegions`, but many tools still assume full snapshot.

6. **Seed generation**
   - Runs on main thread (unless moved to worker).
   - Produces RegionBlockStore, which is good, but the path to VirtualTerrainStore + ChunkSystem can still trigger full snapshots in some flows.

---

## Part 3: Options for Improvement

### Option A: Incremental Improvements (Low Effort)

1. **Enable ChunkMeshWorker**  
   Set `USE_CHUNK_MESH_WORKER = true` and fix worker compatibility (e.g. non-cube blocks) so mesh build moves off main thread.

2. **Reduce default view distance**  
   Lower from 256 to 128 or 96, or make it hardware-adaptive (e.g. via GPU detection).

3. **Stricter use of VirtualTerrainStore**  
   - Prefer `updateTerrainChunksFromStore` over `updateTerrainChunks(terrainData)`.
   - Avoid `getLoadedBlocksSnapshot()`; add APIs that work on regions/batches.
   - Update tools to use `virtualStore.getBlock(x,y,z)` instead of `terrainRef.current["x,y,z"]`.

4. **Move TerrainGenerator to Web Worker**  
   Keep main thread responsive during seed generation.

### Option B: Converter + Hot-Load Bootstrap (Medium Effort)

**Idea**: Pre-process worlds into a compact, streamable format. The editor loads only what’s visible and streams more on demand.

```
[Raw World / Seed] 
    → Offline or background CONVERTER 
    → Pre-baked format (e.g. region files, heightmaps, LOD levels)
    → IndexedDB / CDN

[Editor Bootstrap]
    → Load only: camera region + metadata
    → Stream regions via fetch() or IDB
    → VirtualTerrainStore.ensureRegionLoaded(rx, ry, rz)
    → ChunkSystem builds meshes only for loaded regions
```

**Format options**:

- **Region files**: One file per 64³ region (packed Uint16Array, maybe compressed).
- **Chunk bundles**: Pre-meshed chunk geometry (binary) for instant display – trade-off: no edits until “unbaked.”
- **Hybrid**: Sparse block data in region format + optional precomputed LOD meshes for far chunks.

**Flow**:

1. **Convert** (CLI or build step):  
   `node scripts/convert-world.js input.json output/regions/`
2. **Serve** regions from static files or API.
3. **Editor** calls `ProgressiveRegionLoader`-style logic that fetches regions by `(rx,ry,rz)`.
4. **VirtualTerrainStore** stays as the in-memory cache; no full snapshot.

### Option C: New Rendering Pipeline (High Effort)

Aligned with Hytale-style techniques:

1. **LOD system**  
   - Far chunks: simplified meshes (e.g. merged, fewer vertices).  
   - Very far: impostors or heightmap-based terrain.

2. **Variable chunk size**  
   - Dense areas: 16³.  
   - Sparse: 32³ or 64³ “super-chunks” to reduce draw calls.

3. **Instanced rendering**  
   - Batch similar blocks (e.g. grass) into instanced draws instead of per-block geometry.

4. **Deferred / compute**  
   - GPU-based culling, LOD selection, or even mesh generation (WebGPU).

---

## Part 4: Recommended Path

### Phase 1 (1–2 weeks)

1. Enable `USE_CHUNK_MESH_WORKER` and resolve non-cube / worker issues.
2. Move TerrainGenerator to a Web Worker.
3. Add a configurable/default view distance (e.g. 128) and tie it to `GPUDetection` if available.

### Phase 2 (2–4 weeks)

1. Implement a **region-based converter**:
   - Input: Seed or exported `terrainData` / region dump.
   - Output: One file per region (e.g. `rx_ry_rz.bin` or `.json`).
2. Add **hot-load bootstrap**:
   - Editor starts with empty or minimal store.
   - `ProgressiveRegionLoader` (or similar) fetches regions by camera position.
   - VirtualTerrainStore + ChunkSystem never require a full snapshot.
3. Ensure all tools that need block data use `virtualStore.getBlock()` / `getBlocksInBounds()` instead of full `terrainData`.

### Phase 3 (4+ weeks)

1. Implement LOD for distant chunks.
2. Consider pre-baked LOD meshes in the converter for very large worlds.
3. Explore instanced rendering for repetitive blocks.

---

## Part 5: Files to Modify (Phase 1–2)

| File | Change |
|------|--------|
| `ChunkConstants.tsx` | `USE_CHUNK_MESH_WORKER = true`, reduce default view distance |
| `TerrainGenerator.js` | Invoke from Web Worker (new `TerrainGeneratorWorker.js`) |
| `SeedGeneratorTool.tsx` | Use worker for generation |
| `TerrainBuilderIntegration.js` | Prefer `updateTerrainChunksFromStore` where possible |
| `TerrainBuilder.tsx` | Ensure `getCurrentTerrainData` doesn’t build full snapshot for large worlds |
| `ProgressiveRegionLoader.js` | Add fetch/load from pre-converted region files |
| New: `scripts/convert-world-to-regions.js` | CLI converter |
| `FindReplaceTool`, `ReplaceTool`, `TerrainTool` | Use VirtualTerrainStore / getBlocksInBounds instead of full terrain |
| `DatabaseManager` | Ensure save path uses region iteration, not `Object.entries` on full object |

---

## References

- [Inside the Hytale Engine: Technical Deep Dive](https://hytalecharts.com/news/hytale-engine-technical-deep-dive)
- [Hytale Server Performance & Optimization](https://www.hytale-dev.com/server-setup/performance-optimization)
- [Hytale Developer Q&A Technical Insights](https://hytalemodding.dev/en/docs/established-information/developer-qa-insights)
