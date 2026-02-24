
export const CHUNK_SIZE = 16;
export const CHUNK_BLOCK_CAPACITY = 4096; // Fixed capacity for chunks (16x16x16)
export const FRUSTUM_CULLING_DISTANCE = 50; // Chunk streaming: 50 block radius

/** Enable virtual terrain when project uses region format (auto-detected on load) */
export const USE_VIRTUAL_TERRAIN = true;
export const MAX_SELECTION_DISTANCE = 256; // Maximum distance for block selection (in blocks)

export const THRESHOLD_FOR_PLACING = 0.4; // Minimum distance for block placement (in world units)

export const MAX_IMPORT_SIZE_X = 500;
export const MAX_IMPORT_SIZE_Y = 500;
export const MAX_IMPORT_SIZE_Z = 500;
export const DEFAULT_IMPORT_SIZE = 500;
export const CENTER_IMPORTS_AT_ORIGIN = true;

const selectionDistance = 256; // Permanently set to maximum value
export const getSelectionDistance = () => selectionDistance;

let viewDistance = FRUSTUM_CULLING_DISTANCE; // Store the current value
export const getViewDistance = () => viewDistance;
export const setViewDistance = (distance) => {
    const newDistance = Math.max(32, Math.min(5000, distance)); // Clamp between 32 and 5000
    viewDistance = newDistance;
    return newDistance;
};

/**
 * Compute a sensible view distance based on world dimensions.
 * Smaller worlds need less view distance; larger worlds cap at 5000.
 * @param width - World width in blocks
 * @param length - World length in blocks
 * @param height - World height in blocks (default 64)
 * @returns Recommended view distance in blocks
 */
export const computeViewDistanceForWorld = (
    width: number,
    length: number,
    height: number = 64
): number => {
    const worldDiagonal = Math.sqrt(
        width * width + length * length + height * height
    );
    return Math.min(5000, Math.max(48, worldDiagonal * 0.5));
};
