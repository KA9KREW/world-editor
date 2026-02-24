# World Editor Performance Roadmap

A professional analysis of current bottlenecks and strategies for making the editor responsive at scale (80×80 and beyond).

---

## Current Architecture Snapshot

| Component | Where it runs | Notes |
|-----------|---------------|-------|
| Chunk mesh building | **Main thread** | `Chunk.buildMeshes()` - CPU-heavy |
| Terrain → chunk partitioning | **Main thread** | `Object.entries(terrainData)` iterates all blocks |
| Spatial hash | Worker (optional) | Falls back to main thread for large worlds |
| IndexedDB / VirtualTerrainStore | Main thread | Async I/O, but region iteration is sync |
| Three.js rendering | Main thread | GPU-bound once meshes exist |

**Key constants:**
- `CHUNKS_NUM_TO_BUILD_AT_ONCE`: 32 chunks per RAF cycle
- `_viewDistance`: 256 blocks (huge sphere of chunks)
- Chunk size: 16×16×16
- 80×80×64 world ≈ 200 chunks total; 256 view distance can demand many more

---

## Identified Bottlenecks

### 1. **Chunk mesh generation blocks the main thread**
- `Chunk.buildMeshes()` runs synchronously
- Per chunk: iterate 4096 blocks, neighbor lookups, face culling, lighting, UV lookup, vertex construction
- 32 chunks at once can easily take 50–200ms → frame drops, input lag

### 2. **Terrain-to-chunk conversion is O(n) and synchronous**
- `ChunkSystem.updateFromTerrainData()` does `Object.entries(terrainData)` over all blocks
- For 80×80×64 (~200k blocks) that’s one big iteration plus partitioning
- Blocks the main thread during initial load and bulk updates

### 3. **Excessive view distance**
- 256 blocks ≈ 512 blocks diameter sphere
- For 80×80 world that’s larger than the whole map
- More chunks queued than necessary, more memory, more mesh work

### 4. **No mesh generation in a Worker**
- All heavy CPU work runs on the main thread
- Browser can’t use a separate core for mesh building

### 5. **Spatial hash sometimes runs on main thread**
- Large worlds skip the worker and use direct processing
- `updateFromTerrain` + spatial hash can add noticeable lag

---

## Strategy Overview

| Approach | Effort | Impact | When to use |
|----------|--------|--------|-------------|
| **Quick wins** | Low | Medium | Immediate |
| **Worker-based meshing** | High | High | Core architecture |
| **Local server / backend** | Very high | Very high | Full rewrite |
| **Reduced view distance** | Low | Medium | Immediate |
| **Progressive / LOD** | Medium | High | Next phase |

---

## 1. Quick Wins (Implement Soon) ✅ IMPLEMENTED

### 1.1 Reduce default view distance for smaller worlds ✅

```ts
// terrain.tsx - computeViewDistanceForWorld(width, length, height)
// TerrainBuilder uses it when initChunkSystem: min(getViewDistance(), sensible)
const worldDiagonal = Math.sqrt(width*width + length*length + height*height);
const sensibleViewDistance = Math.min(256, Math.max(48, worldDiagonal * 0.5));
```

**Effect:** Fewer chunks to build and keep in memory. 80×80 world gets ~65 blocks view distance instead of 256.

### 1.2 Lower chunks per frame during bulk load ✅ (was 32, now 8)

```ts
// ChunkConstants.tsx
export const CHUNKS_NUM_TO_BUILD_AT_ONCE = 8;  // was 32
```

**Effect:** Smoother frames during load; chunks appear progressively instead of in bursts.

### 1.3 Reduce per-chunk mesh build throttle ✅

```ts
// ChunkManager._renderChunk - timeBetweenBuilds
const timeBetweenBuilds = this._renderChunkQueue.length > 10 ? 6 : 20;  // was 2 and 10
```

**Effect:** More spacing between heavy mesh builds, less frame stutter.

### 1.4 Use `requestIdleCallback` for low-priority mesh work ✅

Defer chunks far from the camera to idle time so interaction stays responsive.
Implemented in ChunkManager.processRenderQueue: far chunks (beyond 60% view distance) use requestIdleCallback; close chunks use RAF.

---

## 2. Chunk Mesh Workers (High Impact) – SCAFFOLD DONE

**Idea:** Move mesh generation to a Web Worker. Main thread only receives geometry data and creates Three.js meshes.

**Implemented (experimental, `USE_CHUNK_MESH_WORKER = false` by default):**
- `ChunkMeshWorker.js` – worker for cube blocks (no trimesh, no rotation, no custom shapes)
- `ChunkMeshWorkerBridge.js` – builds blockConfig and uvTable, manages worker
- Precomputed UV table from BlockTextureAtlas; block config from BlockTypeRegistry
- Enable via `ChunkConstants.USE_CHUNK_MESH_WORKER = true`

**Current limits:** Cube blocks only; no emissive lighting; no sky light; no rotated blocks.

**Flow:**
1. Main thread sends chunk block data (padded 18³) + blockConfig + uvTable to worker
2. Worker: face culling, vertex generation, precomputed UV lookup
3. Worker returns: `{ solid, liquid }` with positions, normals, uvs, colors, indices
4. Main thread: create `BufferGeometry` and mesh via ChunkMeshManager

**To expand:** Add trimesh, rotation, shapes, and lighting to worker.

---

## 3. Local Server / Backend (Your Idea)

**Concept:** Run a small local process that:
- Holds the terrain/block data
- Handles spatial queries, chunking, region loading
- Exposes a WebSocket or HTTP API
- The editor UI only fetches visible chunks and renders

**Pros:**
- Terrain logic fully off main thread
- Can use faster runtimes (Rust, Go, Node) for heavy work
- Easier to scale to very large worlds
- Clear separation: server = data + logic, client = rendering + UX

**Cons:**
- Much more complex architecture
- Deployment: users must run a local server or you host it
- Need a format/protocol for chunks, edits, save/load
- Likely a 2–3 month project for a minimal version

**Recommendation:** Treat as a long-term option. It fits well if you plan 1000×1000+ worlds, multiplayer, or plugins. For 80×80–500×500, Worker-based meshing is usually enough.

---

## 4. Other Improvements

### 4.1 Level-of-detail (LOD) for distant chunks

- Far chunks: lower resolution (e.g. 32×32×32 “super chunks”) or simplified meshes
- Near chunks: full 16×16×16 detail
- Similar to Minecraft and other voxel engines

### 4.2 Instanced rendering for repeated blocks

- Single mesh + many instances instead of one mesh per chunk
- Best for uniform terrain; less ideal for varied blocks
- Can cut draw calls and GPU work significantly

### 4.3 Stream chunk partitioning instead of full iteration ✅

- Avoid `Object.entries(terrainData)` over the whole map
- Use `VirtualTerrainStore.getBlocksInBatches()` and partition into chunks incrementally
- Emit chunks as they’re ready instead of one big pass

### 4.4 Cache texture UVs ✅

- UV lookups during mesh build are expensive
- Precompute a block+face → UV mapping and reuse it
- Reduces per-vertex work in `Chunk.buildMeshes()`

### 4.5 Frustum culling and occlusion

- Ensure chunks outside the camera frustum are not built or drawn
- For indoor/cave scenes, occlusion culling can skip hidden chunks
- Three.js helps with frustum culling; occlusion needs extra logic

---

## 5. Suggested Implementation Order

1. **Week 1 – Quick wins** ✅ DONE
   - Reduce `CHUNKS_NUM_TO_BUILD_AT_ONCE` to 8
   - Scale view distance by world size
   - Add `requestIdleCallback` for deferred chunks

2. **Weeks 2–4 – Chunk mesh worker**
   - Extract mesh generation into a Worker
   - Precompute or simplify UV/texture handling for the worker
   - Measure frame times and load times before/after

3. **Months 2–3 – Progressive loading and LOD**
   - Stream chunk partitioning from VirtualTerrainStore
   - Optional LOD for distant chunks

4. **Long term – Local server**
   - Only if you need 1000×1000+ worlds, multiplayer, or a plugin ecosystem

---

## 6. No Need for a New Language

Languages like Rust or C++ can be faster, but:

- The main issue is **where** work runs (main thread vs worker) and **how much** work is done (chunk count, view distance), not raw JS speed.
- Web Workers are JavaScript and can already use multiple cores.
- A local server can be in any language (Rust, Go, Node) and communicates with the editor via standard APIs.
- Rewriting the editor in another language is a huge undertaking with limited payoff compared to architectural changes.

---

## 7. Summary

| Fix | Effort | Impact |
|-----|--------|--------|
| Reduce chunks/frame, scale view distance | Low | Smoother load, better for small worlds |
| Chunk mesh in Web Worker | High | Biggest win for responsiveness |
| Local server | Very high | Best for very large / multiplayer worlds |
| LOD, instancing, streaming | Medium | Additional gains |

**Bottom line:** Focus first on Worker-based mesh generation and tuning chunk build rate / view distance. A local server is a strong option for very large worlds or multiplayer, but not required for good performance at 80×80–500×500.
