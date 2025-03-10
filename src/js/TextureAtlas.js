import * as THREE from 'three';

// Texture Atlas Manager for block textures
export class TextureAtlas {
  constructor(options = {}) {
    this.atlas = null;           // The THREE.Texture for the atlas
    this.atlasSize = 2048;       // Size of atlas texture (power of 2)
    this.blockSize = 64;         // Size of individual block texture
    this.padding = 1;            // Padding between textures
    this.gridSize = Math.floor(this.atlasSize / (this.blockSize + this.padding * 2)); // Number of textures per row/column
    this.blockUVs = new Map();   // Maps blockId to UV coordinates
    this.textureLoadPromises = []; // Array of promises for loading textures
    this.atlasCanvas = document.createElement('canvas');
    this.atlasCanvas.width = this.atlasSize;
    this.atlasCanvas.height = this.atlasSize;
    this.atlasContext = this.atlasCanvas.getContext('2d');
    this.usedSlots = new Set();  // Track used slots
    
    // Texture quality settings
    this.mipmappingEnabled = options.mipmappingEnabled !== undefined ? options.mipmappingEnabled : true;
    this.anisotropyLevel = options.anisotropyLevel || 16; // Default to high quality
    this.mipmapQuality = options.mipmapQuality || 'high'; // 'none', 'low', 'medium', 'high'
  }

  // Initialize the texture atlas with block types
  async initialize(blockTypes, options = {}) {
    // Override settings with any passed options
    if (options.mipmappingEnabled !== undefined) this.mipmappingEnabled = options.mipmappingEnabled;
    if (options.anisotropyLevel) this.anisotropyLevel = options.anisotropyLevel;
    if (options.mipmapQuality) this.mipmapQuality = options.mipmapQuality;
    
    console.log('Initializing texture atlas with', blockTypes.length, 'block types');
    console.log(`Texture settings: mipmapping=${this.mipmappingEnabled}, quality=${this.mipmapQuality}, anisotropy=${this.anisotropyLevel}`);
    
    this.atlasContext.fillStyle = 'rgba(255, 0, 255, 0.5)'; // Default color (magenta semi-transparent)
    this.atlasContext.fillRect(0, 0, this.atlasSize, this.atlasSize);
    
    // Load all textures in parallel
    for (const blockType of blockTypes) {
      if (blockType.isMultiTexture) {
        // For multi-texture blocks, load each side texture
        const sides = ['px', 'nx', 'py', 'ny', 'pz', 'nz']; // +x, -x, +y, -y, +z, -z
        for (const side of sides) {
          const textureUri = blockType.sideTextures[side] || blockType.textureUri;
          this.addTextureToLoad(blockType.id, textureUri, side);
        }
      } else {
        // For single texture blocks, use the same texture for all sides
        this.addTextureToLoad(blockType.id, blockType.textureUri);
      }
    }
    
    // Wait for all textures to load
    await Promise.all(this.textureLoadPromises);
    
    // Create the THREE texture from the canvas
    this.atlas = new THREE.CanvasTexture(this.atlasCanvas);
    this.atlas.wrapS = THREE.ClampToEdgeWrapping;
    this.atlas.wrapT = THREE.ClampToEdgeWrapping;
    
    // Always use nearest filter for magnification to preserve pixel art look
    this.atlas.magFilter = THREE.NearestFilter;
    
    // Set minification filter based on quality setting
    if (!this.mipmappingEnabled) {
      // No mipmapping - just use nearest filter
      this.atlas.minFilter = THREE.NearestFilter;
      this.atlas.generateMipmaps = false;
    } else {
      // Set filter based on quality
      switch (this.mipmapQuality) {
        case 'low':
          this.atlas.minFilter = THREE.NearestMipmapNearestFilter;
          break;
        case 'medium':
          this.atlas.minFilter = THREE.LinearMipmapNearestFilter;
          break;
        case 'high':
        default:
          this.atlas.minFilter = THREE.LinearMipmapLinearFilter; // Trilinear filtering
          break;
      }
      this.atlas.generateMipmaps = true;
    }
    
    // Set anisotropic filtering level if available
    const renderer = THREE.WebGLRenderer ? new THREE.WebGLRenderer() : null;
    const maxAnisotropy = renderer ? renderer.capabilities.getMaxAnisotropy() : 1;
    this.atlas.anisotropy = Math.min(this.anisotropyLevel, maxAnisotropy);
    
    console.log(`Texture atlas created with mipmapping=${this.mipmappingEnabled}, quality=${this.mipmapQuality}, anisotropy=${this.atlas.anisotropy}`);
    
    return this.atlas;
  }
  
  // Add a texture to be loaded
  addTextureToLoad(blockId, textureUri, side = null) {
    const promise = new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      
      img.onload = () => {
        const slotId = this.getNextAvailableSlot();
        if (slotId === -1) {
          console.error('Texture atlas full - cannot add more textures');
          reject(new Error('Texture atlas full'));
          return;
        }
        
        const x = (slotId % this.gridSize) * (this.blockSize + this.padding * 2) + this.padding;
        const y = Math.floor(slotId / this.gridSize) * (this.blockSize + this.padding * 2) + this.padding;
        
        // Draw the texture to the canvas
        this.atlasContext.drawImage(img, x, y, this.blockSize, this.blockSize);
        
        // Calculate UV coordinates (0-1 range)
        const uvLeft = x / this.atlasSize;
        const uvTop = y / this.atlasSize;
        const uvRight = (x + this.blockSize) / this.atlasSize;
        const uvBottom = (y + this.blockSize) / this.atlasSize;
        
        // Store UV coordinates for this block/side
        const key = side ? `${blockId}_${side}` : `${blockId}`;
        this.blockUVs.set(key, {
          left: uvLeft,
          top: uvTop,
          right: uvRight,
          bottom: uvBottom
        });
        
        resolve();
      };
      
      img.onerror = () => {
        console.error(`Failed to load texture: ${textureUri}`);
        reject(new Error(`Failed to load texture: ${textureUri}`));
      };
      
      // Set image source - handle data URIs and regular URLs
      if (textureUri.startsWith('data:')) {
        img.src = textureUri;
      } else {
        img.src = `${process.env.PUBLIC_URL}/${textureUri.replace(/^\.\//, '')}`;
      }
    });
    
    this.textureLoadPromises.push(promise);
  }
  
  // Get the next available slot in the atlas
  getNextAvailableSlot() {
    const maxSlots = this.gridSize * this.gridSize;
    for (let i = 0; i < maxSlots; i++) {
      if (!this.usedSlots.has(i)) {
        this.usedSlots.add(i);
        return i;
      }
    }
    return -1; // Atlas is full
  }
  
  // Get UV coordinates for a specific block
  getUVsForBlock(blockId, side = null) {
    const key = side ? `${blockId}_${side}` : `${blockId}`;
    return this.blockUVs.get(key) || this.blockUVs.get(`${blockId}`);
  }
  
  // Get the THREE.Texture atlas
  getAtlasTexture() {
    return this.atlas;
  }
}

// Create batch-friendly chunk mesh builder with greedy meshing
export class ChunkMeshBuilder {
  constructor(textureAtlas) {
    this.textureAtlas = textureAtlas;
    this.maxBlocksPerBatch = 10000; // Maximum number of blocks per batch
    this.transparentBlocks = new Set(['minecraft:glass', 'minecraft:water', 'minecraft:leaves']); // Add more transparent blocks as needed
    this.useGreedyMeshing = true; // Enable greedy meshing by default
    this.enableLod = true; // Enable Level of Detail
    this.lodDistances = [3, 6, 10, 16]; // Chunk distances for different LOD levels
    this.lodScales = [1, 2, 4, 8]; // Corresponding detail reduction factors
  }
  
  // Toggle greedy meshing
  setGreedyMeshing(enabled) {
    this.useGreedyMeshing = enabled;
  }
  
  // Toggle LOD
  setLodEnabled(enabled) {
    this.enableLod = enabled;
  }
  
  // Set LOD distance thresholds
  setLodDistances(distances, scales) {
    if (distances.length !== scales.length) {
      console.error("LOD distances and scales arrays must have the same length");
      return;
    }
    this.lodDistances = distances;
    this.lodScales = scales;
  }
  
  // Determine LOD level based on distance from camera
  getLodLevel(chunkKey, camera) {
    // Parse chunk coordinates
    const [cx, cy, cz] = chunkKey.split(',').map(Number);
    
    // Calculate camera position in chunk coordinates
    const cameraChunkX = Math.floor(camera.position.x / 32);
    const cameraChunkY = Math.floor(camera.position.y / 32);
    const cameraChunkZ = Math.floor(camera.position.z / 32);
    
    // Calculate chunk distance (in chunk units)
    const distanceInChunks = Math.sqrt(
      Math.pow(cx - cameraChunkX, 2) +
      Math.pow(cy - cameraChunkY, 2) +
      Math.pow(cz - cameraChunkZ, 2)
    );
    
    // Find appropriate LOD level
    for (let i = 0; i < this.lodDistances.length; i++) {
      if (distanceInChunks <= this.lodDistances[i]) {
        return i;
      }
    }
    
    // Default to highest LOD level if beyond all thresholds
    return this.lodDistances.length - 1;
  }
  
  // Build optimized mesh for a chunk with LOD support
  buildChunkMesh(chunksBlocks, blockTypes, chunkKey, camera) {
    console.time('buildChunkMesh');
    
    // Determine LOD level based on distance
    const lodLevel = this.enableLod && camera ? this.getLodLevel(chunkKey, camera) : 0;
    const lodScale = this.lodScales[lodLevel];
    
    const blockTypeMap = new Map();
    blockTypes.forEach(blockType => {
      blockTypeMap.set(blockType.id, blockType);
    });
    
    // First pass: Create a 3D grid of blocks for quick neighbor lookups
    const blockGrid = new Map();
    const blockData = new Map();
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    
    // Fill the grid and find bounds
    for (const posKey in chunksBlocks) {
      const [x, y, z] = posKey.split(',').map(Number);
      const blockId = chunksBlocks[posKey];
      const blockType = blockTypeMap.get(blockId);
      
      if (!blockType) continue;
      
      // Apply LOD filtering - only include blocks that align with the LOD grid
      if (lodScale > 1) {
        // Skip blocks that don't align with the LOD grid
        if ((x % lodScale !== 0) || (y % lodScale !== 0) || (z % lodScale !== 0)) {
          continue;
        }
      }
      
      // Store block in grid for neighbor lookups
      blockGrid.set(posKey, {
        id: blockId,
        type: blockType,
        isTransparent: this.isTransparent(blockType)
      });
      
      // Track bounds for optimization
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      maxZ = Math.max(maxZ, z);
      
      // Store block data for later processing
      blockData.set(posKey, {
        x, y, z,
        id: blockId,
        type: blockType,
        isTransparent: this.isTransparent(blockType),
        visibleFaces: [] // Will be filled in second pass
      });
    }
    
    if (blockData.size === 0) {
      console.timeEnd('buildChunkMesh');
      return null;
    }
    
    // Define face directions for neighbor checks
    const faceDirections = [
      { name: 'pz', dir: [0, 0, 1], normal: [0, 0, 1], axis: 2 },    // front (+z)
      { name: 'nz', dir: [0, 0, -1], normal: [0, 0, -1], axis: 2 },  // back (-z)
      { name: 'py', dir: [0, 1, 0], normal: [0, 1, 0], axis: 1 },    // top (+y)
      { name: 'ny', dir: [0, -1, 0], normal: [0, -1, 0], axis: 1 },  // bottom (-y)
      { name: 'px', dir: [1, 0, 0], normal: [1, 0, 0], axis: 0 },    // right (+x)
      { name: 'nx', dir: [-1, 0, 0], normal: [-1, 0, 0], axis: 0 }   // left (-x)
    ];
    
    // Second pass: Determine which faces are visible
    let visibleFaceCount = 0;
    let skippedBlockCount = 0;
    
    for (const [posKey, block] of blockData.entries()) {
      const { x, y, z, type, isTransparent } = block;
      let hasVisibleFace = false;
      
      // Check each face direction
      for (const face of faceDirections) {
        const nx = x + face.dir[0];
        const ny = y + face.dir[1];
        const nz = z + face.dir[2];
        const neighborKey = `${nx},${ny},${nz}`;
        const neighbor = blockGrid.get(neighborKey);
        
        // Face is visible if:
        // 1. No neighbor exists, OR
        // 2. Neighbor is transparent AND current block is not transparent
        const isVisible = !neighbor || (neighbor.isTransparent && !isTransparent);
        
        if (isVisible) {
          hasVisibleFace = true;
          block.visibleFaces.push(face);
          visibleFaceCount++;
        }
      }
      
      // If block has no visible faces, mark for skipping
      if (!hasVisibleFace) {
        skippedBlockCount++;
        block.skip = true;
      }
    }
    
    console.log(`Visible faces: ${visibleFaceCount}, Skipped blocks: ${skippedBlockCount}`);
    
    // Prepare buffers for geometry
    const positions = [];
    const normals = [];
    const uvs = [];
    const indices = [];
    let vertexCount = 0;
    
    // If using greedy meshing, use that algorithm
    if (this.useGreedyMeshing) {
      this.buildGreedyMesh(
        blockData, 
        blockGrid,
        faceDirections,
        { minX, minY, minZ, maxX, maxY, maxZ },
        positions, normals, uvs, indices,
        blockTypeMap
      );
    } else {
      // Third pass: Generate geometry for visible faces (non-greedy)
      let processedFaces = 0;
      for (const [posKey, block] of blockData.entries()) {
        if (block.skip) continue;
        
        const { x, y, z, type, visibleFaces } = block;
        
        // Add visible faces to geometry
        for (const face of visibleFaces) {
          this.addFace(
            x, y, z, 
            type, 
            face, 
            positions, normals, uvs, indices, 
            vertexCount
          );
          vertexCount += 4; // 4 vertices per face
          processedFaces++;
        }
      }
      console.log(`Generated geometry for ${processedFaces} faces (non-greedy)`);
    }
    
    // Early exit if no geometry
    if (positions.length === 0) {
      console.timeEnd('buildChunkMesh');
      return null;
    }
    
    // Create geometry from buffers
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    
    // Create mesh
    const material = new THREE.MeshStandardMaterial({
      map: this.textureAtlas.getAtlasTexture(),
      side: THREE.FrontSide,
      transparent: true,
      alphaTest: 0.1
    });
    
    const mesh = new THREE.Mesh(geometry, material);
    console.timeEnd('buildChunkMesh');
    return mesh;
  }
  
  // Build a greedy meshed geometry
  buildGreedyMesh(blockData, blockGrid, faceDirections, bounds, positions, normals, uvs, indices, blockTypeMap) {
    console.time('greedyMesh');
    const { minX, minY, minZ, maxX, maxY, maxZ } = bounds;
    
    // Size of the 3D grid
    const sizeX = maxX - minX + 1;
    const sizeY = maxY - minY + 1;
    const sizeZ = maxZ - minZ + 1;
    
    // Used for tracking merged faces
    let vertexCount = 0;
    let processedQuads = 0;
    
    // For each face direction, build a 2D grid and merge adjacent faces
    for (const faceDir of faceDirections) {
      const { name: faceName, dir, normal, axis } = faceDir;
      
      // Determine which dimensions to iterate based on face direction
      let width, height, depth;
      let xIndex, yIndex, zIndex;
      
      // Configure iteration based on axis (the axis that face normal points along)
      if (axis === 0) { // X-axis faces (left, right)
        width = sizeY;
        height = sizeZ;
        depth = sizeX;
        xIndex = 1; // Y is width
        yIndex = 2; // Z is height
        zIndex = 0; // X is depth
      } else if (axis === 1) { // Y-axis faces (top, bottom)
        width = sizeX;
        height = sizeZ;
        depth = sizeY;
        xIndex = 0; // X is width
        yIndex = 2; // Z is height
        zIndex = 1; // Y is depth
      } else { // Z-axis faces (front, back)
        width = sizeX;
        height = sizeY;
        depth = sizeZ;
        xIndex = 0; // X is width
        yIndex = 1; // Y is height
        zIndex = 2; // Z is depth
      }
      
      // For each layer along the face normal direction (depth)
      for (let d = 0; d < depth; d++) {
        // Create a 2D mask of visible faces
        const mask = Array(width * height).fill(null);
        
        // Fill the mask with block data for visible faces
        for (let h = 0; h < height; h++) {
          for (let w = 0; w < width; w++) {
            // Convert 2D + depth to 3D coordinates
            let x = minX, y = minY, z = minZ;
            
            if (axis === 0) { // X face
              x += d;
              y += w;
              z += h;
            } else if (axis === 1) { // Y face
              x += w;
              y += d;
              z += h;
            } else { // Z face
              x += w;
              y += h;
              z += d;
            }
            
            // Skip if outside bounds
            if (x < minX || x > maxX || y < minY || y > maxY || z < minZ || z > maxZ) {
              continue;
            }
            
            const posKey = `${x},${y},${z}`;
            const block = blockData.get(posKey);
            
            // Skip if no block or block is skipped
            if (!block || block.skip) continue;
            
            // Check if this face is visible
            const hasFace = block.visibleFaces.some(f => f.name === faceName);
            if (!hasFace) continue;
            
            // Store block info in mask
            mask[w + h * width] = {
              x, y, z,
              blockId: block.id,
              textureId: block.id // Using blockId as textureId for now, could be more specific with textures
            };
          }
        }
        
        // Now perform greedy meshing on the 2D mask
        // This merges adjacent faces with the same texture
        
        // Track which positions have been merged already
        const merged = new Set();
        
        // For each position in the mask
        for (let h = 0; h < height; h++) {
          for (let w = 0; w < width; w++) {
            const index = w + h * width;
            
            // Skip if no block or already merged
            if (!mask[index] || merged.has(index)) continue;
            
            const blockInfo = mask[index];
            const { textureId } = blockInfo;
            
            // Try to expand in width direction as far as possible
            let currentWidth = 1;
            while (
              w + currentWidth < width && 
              mask[index + currentWidth] && 
              !merged.has(index + currentWidth) && 
              mask[index + currentWidth].textureId === textureId
            ) {
              currentWidth++;
            }
            
            // Try to expand in height direction as far as possible
            let currentHeight = 1;
            let canExpandHeight = true;
            
            while (canExpandHeight && h + currentHeight < height) {
              // Check if an entire row can be added
              for (let dx = 0; dx < currentWidth; dx++) {
                const checkIndex = (w + dx) + (h + currentHeight) * width;
                if (
                  !mask[checkIndex] || 
                  merged.has(checkIndex) || 
                  mask[checkIndex].textureId !== textureId
                ) {
                  canExpandHeight = false;
                  break;
                }
              }
              
              if (canExpandHeight) {
                currentHeight++;
              }
            }
            
            // Mark all cells in the merged quad as processed
            for (let dy = 0; dy < currentHeight; dy++) {
              for (let dx = 0; dx < currentWidth; dx++) {
                merged.add((w + dx) + (h + dy) * width);
              }
            }
            
            // Create the merged quad
            const { x, y, z } = blockInfo;
            
            // Convert the 2D dimensions back to 3D for creating the quad
            let x1 = x, y1 = y, z1 = z;
            let x2 = x, y2 = y, z2 = z;
            
            if (axis === 0) { // X face
              // X is fixed, expand in Y and Z
              y2 = y1 + currentWidth - 1;
              z2 = z1 + currentHeight - 1;
            } else if (axis === 1) { // Y face
              // Y is fixed, expand in X and Z
              x2 = x1 + currentWidth - 1;
              z2 = z1 + currentHeight - 1;
            } else { // Z face
              // Z is fixed, expand in X and Y
              x2 = x1 + currentWidth - 1;
              y2 = y1 + currentHeight - 1;
            }
            
            // Add the merged quad to the geometry
            this.addQuad(
              x1, y1, z1,
              x2, y2, z2,
              textureId,
              dir,
              normal,
              positions, normals, uvs, indices,
              vertexCount
            );
            
            vertexCount += 4; // 4 vertices per quad
            processedQuads++;
          }
        }
      }
    }
    
    console.log(`Generated ${processedQuads} merged quads with greedy meshing`);
    console.timeEnd('greedyMesh');
  }
  
  // Add a quad spanning from (x1,y1,z1) to (x2,y2,z2)
  addQuad(x1, y1, z1, x2, y2, z2, blockId, dir, normal, positions, normals, uvs, indices, vertexOffset) {
    // Get block UVs
    let blockUVs = this.textureAtlas.getUVsForBlock(blockId, getFaceName(dir));
    if (!blockUVs) {
      blockUVs = this.textureAtlas.getUVsForBlock(blockId);
      if (!blockUVs) return; // Skip if no UVs available
    }
    
    // Create vertices for the quad based on the face direction
    let vertices = [];
    
    // X faces
    if (dir[0] !== 0) {
      const x = dir[0] > 0 ? x1 + 1 : x1;
      vertices = [
        [x, y1, z1],
        [x, y2 + 1, z1],
        [x, y2 + 1, z2 + 1],
        [x, y1, z2 + 1]
      ];
    }
    // Y faces
    else if (dir[1] !== 0) {
      const y = dir[1] > 0 ? y1 + 1 : y1;
      vertices = [
        [x1, y, z1],
        [x1, y, z2 + 1],
        [x2 + 1, y, z2 + 1],
        [x2 + 1, y, z1]
      ];
    }
    // Z faces
    else if (dir[2] !== 0) {
      const z = dir[2] > 0 ? z1 + 1 : z1;
      vertices = [
        [x1, y1, z],
        [x2 + 1, y1, z],
        [x2 + 1, y2 + 1, z],
        [x1, y2 + 1, z]
      ];
    }
    
    // Add vertices
    for (const vertex of vertices) {
      positions.push(vertex[0], vertex[1], vertex[2]);
      normals.push(normal[0], normal[1], normal[2]);
    }
    
    // Calculate width and height of the quad
    const width = Math.abs(x2 - x1) + 1;
    const height = Math.abs(y2 - y1) + 1;
    const depth = Math.abs(z2 - z1) + 1;
    
    // Calculate UV coordinates with repetition based on quad size
    if (dir[0] !== 0) { // X face - repeat UVs by Y and Z dimension
      uvs.push(
        blockUVs.left, blockUVs.bottom, // bottom-left
        blockUVs.left, blockUVs.top * height, // top-left
        blockUVs.right * depth, blockUVs.top * height, // top-right
        blockUVs.right * depth, blockUVs.bottom // bottom-right
      );
    } else if (dir[1] !== 0) { // Y face - repeat UVs by X and Z dimension
      uvs.push(
        blockUVs.left, blockUVs.bottom, // bottom-left
        blockUVs.left, blockUVs.top * depth, // top-left
        blockUVs.right * width, blockUVs.top * depth, // top-right
        blockUVs.right * width, blockUVs.bottom // bottom-right
      );
    } else { // Z face - repeat UVs by X and Y dimension
      uvs.push(
        blockUVs.left, blockUVs.bottom, // bottom-left
        blockUVs.right * width, blockUVs.bottom, // bottom-right
        blockUVs.right * width, blockUVs.top * height, // top-right
        blockUVs.left, blockUVs.top * height // top-left
      );
    }
    
    // Add indices (two triangles per quad)
    const baseVertex = vertexOffset;
    indices.push(
      baseVertex, baseVertex + 1, baseVertex + 2,
      baseVertex, baseVertex + 2, baseVertex + 3
    );
  }
  
  // Check if a block type is transparent
  isTransparent(blockType) {
    if (!blockType) return false;
    
    // Check name if it's a string
    if (typeof blockType === 'string') {
      return this.transparentBlocks.has(blockType);
    }
    
    // Check block name property
    const name = blockType.name?.toLowerCase() || '';
    
    // Check if block type name contains any transparent block identifiers
    return this.transparentBlocks.has(blockType.name) ||
           name.includes('glass') ||
           name.includes('water') ||
           name.includes('leaves') ||
           name.includes('ice');
  }
  
  // Add a single face to the geometry (for non-greedy meshing)
  addFace(x, y, z, blockType, face, positions, normals, uvs, indices, vertexOffset) {
    // Get vertices for this face
    let vertices;
    
    switch(face.name) {
      case 'pz': // front (+z)
        vertices = [
          [x, y, z+1], [x+1, y, z+1], 
          [x+1, y+1, z+1], [x, y+1, z+1]
        ];
        break;
      case 'nz': // back (-z)
        vertices = [
          [x+1, y, z], [x, y, z], 
          [x, y+1, z], [x+1, y+1, z]
        ];
        break;
      case 'py': // top (+y)
        vertices = [
          [x, y+1, z], [x, y+1, z+1], 
          [x+1, y+1, z+1], [x+1, y+1, z]
        ];
        break;
      case 'ny': // bottom (-y)
        vertices = [
          [x, y, z+1], [x, y, z], 
          [x+1, y, z], [x+1, y, z+1]
        ];
        break;
      case 'px': // right (+x)
        vertices = [
          [x+1, y, z], [x+1, y, z+1], 
          [x+1, y+1, z+1], [x+1, y+1, z]
        ];
        break;
      case 'nx': // left (-x)
        vertices = [
          [x, y, z+1], [x, y, z], 
          [x, y+1, z], [x, y+1, z+1]
        ];
        break;
    }
    
    // Get UVs for this block face
    const blockId = typeof blockType === 'object' ? blockType.id : blockType;
    let blockUVs = this.textureAtlas.getUVsForBlock(blockId, face.name);
    
    if (!blockUVs) {
      // If no specific UVs, use default UVs
      const defaultUVs = this.textureAtlas.getUVsForBlock(blockId);
      if (!defaultUVs) return; // Skip if no UVs available
      
      blockUVs = defaultUVs;
    }
    
    // Add vertices
    for (const vertex of vertices) {
      positions.push(vertex[0], vertex[1], vertex[2]);
      normals.push(face.normal[0], face.normal[1], face.normal[2]);
    }
    
    // Add UVs (clockwise order)
    uvs.push(
      blockUVs.left, blockUVs.bottom,
      blockUVs.right, blockUVs.bottom,
      blockUVs.right, blockUVs.top,
      blockUVs.left, blockUVs.top
    );
    
    // Add indices (two triangles per face)
    const baseVertex = vertexOffset;
    indices.push(
      baseVertex, baseVertex + 1, baseVertex + 2,
      baseVertex, baseVertex + 2, baseVertex + 3
    );
  }
}

// Helper function to get face name from direction
function getFaceName(dir) {
  if (dir[0] > 0) return 'px';
  if (dir[0] < 0) return 'nx';
  if (dir[1] > 0) return 'py';
  if (dir[1] < 0) return 'ny';
  if (dir[2] > 0) return 'pz';
  if (dir[2] < 0) return 'nz';
  return '';
}

// Helper for chunk loading queue management
export class ChunkLoadManager {
  constructor(onChunkLoaded) {
    this.loadQueue = [];
    this.processingChunks = new Set();
    this.maxConcurrentLoads = 4;
    this.onChunkLoaded = onChunkLoaded;
    this.isProcessing = false;
  }
  
  // Add a chunk to the load queue
  addChunkToQueue(chunkKey, priority = 0) {
    // Skip if already processing or queued
    if (this.processingChunks.has(chunkKey)) return;
    
    // Check if already in queue, remove if so
    const existingIndex = this.loadQueue.findIndex(item => item.chunkKey === chunkKey);
    if (existingIndex >= 0) {
      this.loadQueue.splice(existingIndex, 1);
    }
    
    // Add to queue with priority
    this.loadQueue.push({ chunkKey, priority });
    
    // Sort queue by priority (higher priority first)
    this.loadQueue.sort((a, b) => b.priority - a.priority);
    
    // Start processing if not already
    if (!this.isProcessing) {
      this.processQueue();
    }
  }
  
  // Process the queue
  async processQueue() {
    if (this.loadQueue.length === 0 || this.processingChunks.size >= this.maxConcurrentLoads) {
      this.isProcessing = false;
      return;
    }
    
    this.isProcessing = true;
    
    // Process up to maxConcurrentLoads chunks
    while (this.loadQueue.length > 0 && this.processingChunks.size < this.maxConcurrentLoads) {
      const { chunkKey } = this.loadQueue.shift();
      this.processingChunks.add(chunkKey);
      
      // Process chunk (don't await here to allow parallel processing)
      this.processChunk(chunkKey).then(() => {
        this.processingChunks.delete(chunkKey);
        this.processQueue(); // Process next chunk when done
      });
    }
  }
  
  // Process a single chunk
  async processChunk(chunkKey) {
    try {
      await this.onChunkLoaded(chunkKey);
    } catch (error) {
      console.error(`Error processing chunk ${chunkKey}:`, error);
    }
  }
  
  // Clear the queue
  clearQueue() {
    this.loadQueue = [];
    this.processingChunks.clear();
    this.isProcessing = false;
  }
} 