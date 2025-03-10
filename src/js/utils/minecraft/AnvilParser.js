/* global BigInt */
import { NBTParser } from './NBTParser';

export class AnvilParser {
	constructor(options = {}) {
		this.minX = Infinity;
		this.minY = Infinity;
		this.minZ = Infinity;
		this.maxX = -Infinity;
		this.maxY = -Infinity;
		this.maxZ = -Infinity;
		// Use a more memory-efficient data structure
		this.blocks = {}; // Changed from chunks array to blocks object
		this.blockTypes = new Set();
		this.blockCount = 0;
		this.worldVersion = null;
		
		// Options for memory optimization
		this.options = {
			// Filter out non-solid blocks to reduce memory usage
			excludeTransparentBlocks: options.excludeTransparentBlocks ?? true,
			// Load only specific region bounds
			regionBounds: options.regionBounds || null, // {minX, minZ, maxX, maxZ}
			// Maximum number of blocks to load (0 = unlimited)
			maxBlocks: options.maxBlocks || 0,
			// Y-level boundaries to restrict vertical loading
			minY: options.minY !== undefined ? options.minY : -64,
			maxY: options.maxY !== undefined ? options.maxY : 320,
			// X/Z coordinates filtering (absolute block coordinates)
			filterByCoordinates: options.filterByCoordinates ?? false,
			minX: options.minX !== undefined ? options.minX : -1000,
			maxX: options.maxX !== undefined ? options.maxX : 1000,
			minZ: options.minZ !== undefined ? options.minZ : -1000,
			maxZ: options.maxZ !== undefined ? options.maxZ : 1000,
			// Block types to include (if empty, include all)
			includeBlocks: options.includeBlocks || [],
			// Chunk sampling factor (1 = every chunk, 2 = every other chunk, etc.)
			chunkSamplingFactor: options.chunkSamplingFactor || 1
		};
		
		// Common transparent/unimportant blocks to filter out
		this.transparentBlocks = new Set([
			'minecraft:air', 'minecraft:cave_air', 'minecraft:void_air',
			'minecraft:glass', 'minecraft:glass_pane',
			'minecraft:water', 'minecraft:bubble_column', 'minecraft:lava',
			'minecraft:grass', 'minecraft:tall_grass', 'minecraft:seagrass', 'minecraft:tall_seagrass',
			'minecraft:torch', 'minecraft:wall_torch',
			'minecraft:light'
		]);
		
		// Initialize counters for skipped chunks
		this.skippedChunks = {
			yBounds: 0,
			xzBounds: 0,
			regionBounds: 0
		};
	}

	// Check Minecraft world version from level.dat
	checkWorldVersion(levelDatBuffer) {
		try {
			const nbtData = NBTParser.parse(levelDatBuffer);
			const dataVersion = nbtData.Data?.DataVersion || nbtData.DataVersion;
			
			this.worldVersion = dataVersion;
			console.log(`World Data Version: ${dataVersion}`);

			// Minecraft 1.21 is Data Version 3953
			if (dataVersion === 3953) {
				console.log('World is fully compatible with Minecraft 1.21');
				return true;
			} else if (dataVersion > 3953) {
				console.log('World is from a newer version than 1.21. May not be fully compatible.');
				return false;
			} else {
				console.log(`World is from an older version (Data Version ${dataVersion}). Needs updating to 1.21.`);
				return false;
			}
		} catch (e) {
			console.error('Error parsing level.dat:', e);
			return false;
		}
	}

	// Function to check world version from a ZIP file
	async checkWorldVersionFromZip(zipFiles) {
		// Find level.dat in the ZIP
		const levelDatFile = Object.keys(zipFiles).find(file => file.endsWith('level.dat'));
		if (!levelDatFile) {
			console.error('level.dat not found in ZIP');
			return false;
		}

		const buffer = zipFiles[levelDatFile]; // Get buffer from ZIP
		return this.checkWorldVersion(buffer);
	}

	// Check if region is within the specified bounds
	isRegionInBounds(regionX, regionZ) {
		if (!this.options.regionBounds) return true;
		const { minX, minZ, maxX, maxZ } = this.options.regionBounds;
		return regionX >= minX && regionX <= maxX && regionZ >= minZ && regionZ <= maxZ;
	}

	// Check if we should continue processing based on block count limit
	shouldContinueProcessing() {
		return this.options.maxBlocks === 0 || this.blockCount < this.options.maxBlocks;
	}

	parseRegionFile(buffer, regionX, regionZ, debug = false) {
		try {
			// Skip regions outside the specified bounds
			if (!this.isRegionInBounds(regionX, regionZ)) {
				console.log(`Skipping region (${regionX}, ${regionZ}) - outside region bounds`);
				this.skippedChunks.regionBounds++;
				return;
			}
			
			// Early X/Z coordinate filtering - check if this region has any overlap with our coordinate filter
			if (this.options.filterByCoordinates) {
				// Each region is 512x512 blocks (32 chunks x 16 blocks)
				const regionBlockMinX = regionX * 512;
				const regionBlockMaxX = regionBlockMinX + 511;
				const regionBlockMinZ = regionZ * 512;
				const regionBlockMaxZ = regionBlockMinZ + 511;
				
				// Check if the region's block range overlaps with our filter range
				if (regionBlockMaxX < this.options.minX || regionBlockMinX > this.options.maxX ||
					regionBlockMaxZ < this.options.minZ || regionBlockMinZ > this.options.maxZ) {
					console.log(`Skipping region (${regionX}, ${regionZ}) - outside X/Z coordinate filter`);
					this.skippedChunks.xzBounds++;
					return;
				}
				
				if (debug) {
					console.log(`Region (${regionX}, ${regionZ}) has blocks in X range ${regionBlockMinX}-${regionBlockMaxX}, Z range ${regionBlockMinZ}-${regionBlockMaxZ}`);
					console.log(`Which overlaps with filter X range ${this.options.minX}-${this.options.maxX}, Z range ${this.options.minZ}-${this.options.maxZ}`);
				}
			}

			console.log(`Parsing region file (${regionX}, ${regionZ}), buffer size: ${buffer.byteLength} bytes`);
			if (!buffer || buffer.byteLength < 8192) {
				console.warn(`Region file is too small (${buffer.byteLength} bytes)`);
				return;
			}
			
			const view = new DataView(buffer);
			let chunksProcessed = 0;
			let chunksSuccessful = 0;
			let chunksSkippedDueToYBounds = 0;
			let chunksSkippedDueToXZBounds = 0;
			
			// Process chunks with sampling factor
			for (let localZ = 0; localZ < 32; localZ += this.options.chunkSamplingFactor) {
				for (let localX = 0; localX < 32; localX += this.options.chunkSamplingFactor) {
					// Check if we've reached the block limit
					if (!this.shouldContinueProcessing()) {
						console.log(`Reached block limit (${this.options.maxBlocks}), stopping processing`);
						return;
					}
					
					const chunkX = regionX * 32 + localX;
					const chunkZ = regionZ * 32 + localZ;
					
					// Early X/Z filter at chunk level before even reading chunk data
					if (this.options.filterByCoordinates) {
						// Each chunk is 16x16 blocks
						const chunkMinBlockX = chunkX * 16;
						const chunkMaxBlockX = chunkMinBlockX + 15;
						const chunkMinBlockZ = chunkZ * 16;
						const chunkMaxBlockZ = chunkMinBlockZ + 15;
						
						// Skip chunks that are completely outside our X/Z coordinate range
						if (chunkMaxBlockX < this.options.minX || chunkMinBlockX > this.options.maxX ||
							chunkMaxBlockZ < this.options.minZ || chunkMinBlockZ > this.options.maxZ) {
							if (debug) console.log(`Skipping chunk (${chunkX}, ${chunkZ}) - outside X/Z filter range`);
							chunksSkippedDueToXZBounds++;
							this.skippedChunks.xzBounds++;
							continue;
						}
					}
					
					const index = localX + localZ * 32;
					const locationOffset = index * 4;
					if (locationOffset + 4 > buffer.byteLength) {
						console.warn(`Location offset out of bounds: ${locationOffset}`);
						continue;
					}
					const offset = view.getUint32(locationOffset) >>> 8;
					const sectorCount = view.getUint8(locationOffset + 3);
					if (offset === 0 || sectorCount === 0) continue;
					try {
						chunksProcessed++;
						const chunkData = this.readChunkData(buffer, offset * 4096);
						if (chunkData) {
							if (debug) console.log(`Chunk keys: ${Object.keys(chunkData)}`);
							
							// Early Y-bound filtering: Check if any sections in this chunk are within our Y bounds
							const hasValidSections = this.hasValidYSections(chunkData);
							if (!hasValidSections) {
								chunksSkippedDueToYBounds++;
								this.skippedChunks.yBounds++;
								continue;
							}
							
							this.processChunk(chunkData, chunkX, chunkZ, debug);
							chunksSuccessful++;
						}
					} catch (e) {
						console.warn(`Error processing chunk at (${localX}, ${localZ}):`, e);
					}
				}
			}
			
			// Garbage collection hint
			if (global.gc) {
				global.gc();
			}
			
			console.log(`Region (${regionX}, ${regionZ}): Processed ${chunksProcessed} chunks, successful: ${chunksSuccessful}, skipped due to Y-bounds: ${chunksSkippedDueToYBounds}, skipped due to X/Z bounds: ${chunksSkippedDueToXZBounds}`);
			console.log(`Total blocks added: ${this.blockCount}`);
		} catch (e) {
			console.error(`Failed to parse region file (${regionX}, ${regionZ}):`, e);
		}
	}

	readChunkData(buffer, offset) {
		try {
			const view = new DataView(buffer);
			if (offset + 5 >= buffer.byteLength) {
				console.warn('Invalid chunk offset or data length');
				return null;
			}
			const length = view.getUint32(offset, false);
			if (length <= 0 || offset + 5 + length > buffer.byteLength) {
				console.warn('Invalid chunk length:', length, 'buffer size:', buffer.byteLength);
				return null;
			}
			const compressionType = view.getUint8(offset + 4);
			const compressedData = buffer.slice(offset + 5, offset + 5 + length - 1);
			const nbtData = NBTParser.parse(compressedData);
			
			// Check chunk data version
			if (nbtData.DataVersion && !this.worldVersion) {
				this.worldVersion = nbtData.DataVersion;
				console.log(`Detected world version from chunk: ${this.worldVersion}`);
				
				// Check compatibility with Minecraft 1.21 (Data Version 3953)
				if (this.worldVersion === 3953) {
					console.log('Chunk format is compatible with Minecraft 1.21');
				} else if (this.worldVersion > 3953) {
					console.log('Chunk format is from a newer version than 1.21. May not be fully compatible.');
				} else {
					console.log(`Chunk format is from an older version (Data Version ${this.worldVersion}). May need updating.`);
				}
			}
			
			return nbtData;
		} catch (e) {
			console.warn('Error processing chunk data:', e);
			return null;
		}
	}

	processChunk(chunkData, chunkX, chunkZ, debug = false) {
		try {
			if (debug) {
				console.log(`Processing chunk (${chunkX}, ${chunkZ})`);
				console.log('Chunk top-level keys:', Object.keys(chunkData));
				console.log('Chunk DataVersion:', chunkData.DataVersion || 'Not found');
			}
			
			if (chunkData.sections && Array.isArray(chunkData.sections)) {
				if (debug) {
					console.log(`Found ${chunkData.sections.length} sections`);
				}
				
				for (const section of chunkData.sections) {
					if (!section.block_states) {
						if (debug) console.log(`Section at Y=${section.Y} has no block_states. Keys: ${Object.keys(section)}`);
						continue;
					}
					
					const y = section.Y ?? section.y ?? null;
					if (y === null) {
						console.warn('Section has no Y coordinate');
						continue;
					}
					
					// Skip sections outside of Y bounds
					if (y * 16 < this.options.minY || y * 16 > this.options.maxY) {
						continue;
					}
					
					if (debug) {
						console.log(`Section Y=${y}, block_states keys: ${Object.keys(section.block_states)}`);
					}
					
					this.processModern121Section(section, chunkX, chunkZ, y);
				}
			} else {
				console.warn('No sections array found in chunk data. Available keys:', Object.keys(chunkData));
			}
		} catch (e) {
			console.error('Error processing chunk:', e);
		}
	}

	processModern121Section(section, chunkX, chunkZ, sectionY) {
		try {
			const blockStatesCompound = section.block_states;
			if (!blockStatesCompound) {
				return;
			}
			const palette = blockStatesCompound.palette;
			const blockStates = blockStatesCompound.data;

			if (!palette) {
				return;
			}

			// Precompute block names from palette
			const blockNames = palette.map(entry => typeof entry === 'string' ? entry : entry.Name);
			
			// Filter out non-included block types
			const includedBlockIndices = new Set();
			for (let i = 0; i < blockNames.length; i++) {
				const blockName = blockNames[i];
				
				// Skip transparent blocks if option is enabled
				if (this.options.excludeTransparentBlocks && this.transparentBlocks.has(blockName)) {
					continue;
				}
				
				// Skip blocks not in the include list (if specified)
				if (this.options.includeBlocks.length > 0 && !this.options.includeBlocks.includes(blockName)) {
					continue;
				}
				
				includedBlockIndices.add(i);
			}
			
			// Skip section if no blocks are included
			if (includedBlockIndices.size === 0) {
				return;
			}

			if (!blockStates) {
				// Handle single-state section (no data array)
				if (palette.length === 1) {
					const blockName = blockNames[0];
					
					// Skip if the block type is filtered out
					if (!includedBlockIndices.has(0)) {
						return;
					}
					
					// Add a single object to represent the entire section instead of individual blocks
					// This saves memory for homogenous sections
					this.addSectionBlock(chunkX * 16, sectionY * 16, chunkZ * 16, 16, 16, 16, blockName);
				}
				return;
			}

			// Normal case: process block states with data array
			const bitsPerBlock = Math.max(4, Math.ceil(Math.log2(palette.length)));
			const blocksPerLong = Math.floor(64 / bitsPerBlock);
			const mask = (1n << BigInt(bitsPerBlock)) - 1n;
			let blockIndex = 0;
			
			// Process blocks in chunks to save memory
			const blockChunkSize = 64; // Process 64 blocks at a time
			const blockData = [];
			
			for (let longIndex = 0; longIndex < blockStates.length; longIndex++) {
				const value = BigInt(blockStates[longIndex]);
				for (let i = 0; i < blocksPerLong && blockIndex < 4096; i++) {
					const stateIndex = Number((value >> BigInt(i * bitsPerBlock)) & mask);
					
					// Skip blocks not in the included list
					if (includedBlockIndices.has(stateIndex)) {
						const blockName = blockNames[stateIndex];
						const y = Math.floor(blockIndex / 256);
						const z = Math.floor((blockIndex % 256) / 16);
						const x = blockIndex % 16;
						
						blockData.push({
							x: chunkX * 16 + x,
							y: sectionY * 16 + y,
							z: chunkZ * 16 + z,
							type: blockName
						});
						
						// Process block data in chunks to reduce memory pressure
						if (blockData.length >= blockChunkSize) {
							for (const block of blockData) {
								this.addBlock(block.x, block.y, block.z, block.type);
							}
							blockData.length = 0; // Clear the array
						}
					}
					blockIndex++;
				}
			}
			
			// Process any remaining blocks
			for (const block of blockData) {
				this.addBlock(block.x, block.y, block.z, block.type);
			}
		} catch (e) {
			console.error('Error processing modern section:', e);
		}
	}
	
	// Add a block representing an entire section (space optimization for homogenous sections)
	addSectionBlock(x, y, z, width, height, depth, blockName) {
		this.minX = Math.min(this.minX, x);
		this.minY = Math.min(this.minY, y);
		this.minZ = Math.min(this.minZ, z);
		this.maxX = Math.max(this.maxX, x + width - 1);
		this.maxY = Math.max(this.maxY, y + height - 1);
		this.maxZ = Math.max(this.maxZ, z + depth - 1);
		
		// Use a special format for section blocks
		const key = `section:${x},${y},${z},${width},${height},${depth}`;
		this.blocks[key] = { type: blockName, isSection: true, width, height, depth };
		this.blockTypes.add(blockName);
		// Count as if we added width*height*depth individual blocks
		this.blockCount += width * height * depth;
	}

	addBlock(x, y, z, blockName) {
		this.minX = Math.min(this.minX, x);
		this.minY = Math.min(this.minY, y);
		this.minZ = Math.min(this.minZ, z);
		this.maxX = Math.max(this.maxX, x);
		this.maxY = Math.max(this.maxY, y);
		this.maxZ = Math.max(this.maxZ, z);
		
		// Use a string key for the coordinates to save memory
		const key = `${x},${y},${z}`;
		this.blocks[key] = { type: blockName };
		this.blockTypes.add(blockName);
		this.blockCount++;
	}

	getWorldData() {
		// Convert blocks object to chunks array for backward compatibility
		const chunks = [];
		
		// Process regular blocks
		for (const key in this.blocks) {
			if (key.startsWith('section:')) {
				// Expand section blocks into individual blocks
				const [prefix, x, y, z, width, height, depth] = key.split(':')[1].split(',');
				const blockData = this.blocks[key];
				const startX = parseInt(x);
				const startY = parseInt(y);
				const startZ = parseInt(z);
				const blockWidth = parseInt(width);
				const blockHeight = parseInt(height);
				const blockDepth = parseInt(depth);
				
				// Only add the corner blocks and a few scattered blocks from the section
				// to prevent excessive memory usage while maintaining compatibility
				const positions = [
					[startX, startY, startZ], // Corner 1
					[startX + blockWidth - 1, startY, startZ], // Corner 2
					[startX, startY, startZ + blockDepth - 1], // Corner 3
					[startX + blockWidth - 1, startY, startZ + blockDepth - 1], // Corner 4
					[startX, startY + blockHeight - 1, startZ], // Corner 5
					[startX + blockWidth - 1, startY + blockHeight - 1, startZ], // Corner 6
					[startX, startY + blockHeight - 1, startZ + blockDepth - 1], // Corner 7
					[startX + blockWidth - 1, startY + blockHeight - 1, startZ + blockDepth - 1], // Corner 8
				];
				
				// Add evenly spaced blocks within the section to represent it
				const spacing = Math.max(2, Math.floor(Math.cbrt(blockWidth * blockHeight * blockDepth / 100)));
				for (let dx = 0; dx < blockWidth; dx += spacing) {
					for (let dy = 0; dy < blockHeight; dy += spacing) {
						for (let dz = 0; dz < blockDepth; dz += spacing) {
							positions.push([startX + dx, startY + dy, startZ + dz]);
						}
					}
				}
				
				// Add each position to the chunks array
				for (const [posX, posY, posZ] of positions) {
					if (posX < startX + blockWidth && posY < startY + blockHeight && posZ < startZ + blockDepth) {
						chunks.push({
							x: posX,
							y: posY,
							z: posZ,
							type: blockData.type
						});
					}
				}
			} else {
				// Regular block, split the key to get x,y,z
				const [x, y, z] = key.split(',').map(Number);
				const blockData = this.blocks[key];
				chunks.push({
					x,
					y,
					z,
					type: blockData.type
				});
			}
		}
		
		return {
			blockTypes: Array.from(this.blockTypes),
			blocks: this.blocks, // Keep the new format
			chunks: chunks, // Add back the old format for compatibility
			bounds: {
				minX: this.minX,
				minY: this.minY,
				minZ: this.minZ,
				maxX: this.maxX,
				maxY: this.maxY,
				maxZ: this.maxZ
			},
			worldVersion: this.worldVersion,
			totalBlocks: this.blockCount,
			// Include filtering statistics
			filterStats: {
				chunksSkipped: {
					...this.skippedChunks,
					total: this.skippedChunks.yBounds + this.skippedChunks.xzBounds + this.skippedChunks.regionBounds
				},
				filters: {
					yRange: [this.options.minY, this.options.maxY],
					coordsFiltering: this.options.filterByCoordinates,
					xRange: [this.options.minX, this.options.maxX],
					zRange: [this.options.minZ, this.options.maxZ]
				}
			}
		};
	}

	debugChunkStructure(chunkData, prefix = '', maxDepth = 3, currentDepth = 0) {
		if (currentDepth > maxDepth) return;
		if (!chunkData || typeof chunkData !== 'object') {
			console.log(`${prefix}Value: ${chunkData}`);
			return;
		}
		if (Array.isArray(chunkData)) {
			console.log(`${prefix}Array with ${chunkData.length} items`);
			if (chunkData.length > 0 && currentDepth < maxDepth) {
				const sampleSize = Math.min(3, chunkData.length);
				for (let i = 0; i < sampleSize; i++) {
					console.log(`${prefix}  [${i}]:`);
					this.debugChunkStructure(chunkData[i], `${prefix}    `, maxDepth, currentDepth + 1);
				}
				if (chunkData.length > sampleSize) {
					console.log(`${prefix}  ... (${chunkData.length - sampleSize} more items)`);
				}
			}
			return;
		}
		const keys = Object.keys(chunkData);
		console.log(`${prefix}Object with ${keys.length} keys: ${keys.join(', ')}`);
		if (currentDepth < maxDepth) {
			for (const key of keys) {
				console.log(`${prefix}  ${key}:`);
				this.debugChunkStructure(chunkData[key], `${prefix}    `, maxDepth, currentDepth + 1);
			}
		}
	}

	// Check if a chunk has any sections within our Y bounds
	hasValidYSections(chunkData) {
		if (!chunkData.sections || !Array.isArray(chunkData.sections)) {
			return false;
		}
		
		// Early quick check if any sections fall within our Y bounds
		for (const section of chunkData.sections) {
			const y = section.Y ?? section.y ?? null;
			if (y === null) continue;
			
			// Calculate the Y range of this section (each section is 16 blocks tall)
			const minSectionY = y * 16;
			const maxSectionY = minSectionY + 15;
			
			// Check if this section overlaps with our Y bounds
			if (maxSectionY >= this.options.minY && minSectionY <= this.options.maxY) {
				return true;
			}
		}
		
		return false;
	}
}