import { seedStringToNumber, deriveWorldFromSeed } from "../utils/SeedDerivation";
import { computePreviewData } from "../utils/TerrainGenerator";

const PREVIEW_COLORS: Record<string, [number, number, number]> = {
    blue: [21, 101, 192],
    green: [74, 150, 66],
    grey: [120, 120, 130],
    white: [255, 255, 255],
    sand: [210, 180, 120],
};

/**
 * Generate the seed map preview as a data URL (same logic as HeightmapPreview).
 * Used for project thumbnails when a world is generated from seed.
 */
export function generateSeedPreviewDataUrl(
    seed: string,
    width: number,
    length: number,
    maxHeight = 64
): string {
    if (width < 1 || length < 1) return "";
    const seedNum = seedStringToNumber(seed);
    const settings = deriveWorldFromSeed(seed, { width, length, maxHeight });
    const { blockY, biomeMap, seaLevel } = computePreviewData(settings, seedNum);
    const snowY = seaLevel + 20;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = length;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";
    const img = ctx.createImageData(width, length);

    for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
            const i = z * width + x;
            const y = blockY[i];
            const biome = biomeMap[i];

            let r: number, g: number, b: number;
            if (biome === "ocean" || y < seaLevel) {
                [r, g, b] = PREVIEW_COLORS.blue;
            } else if (biome === "desert") {
                [r, g, b] = PREVIEW_COLORS.sand;
            } else if (y >= snowY) {
                [r, g, b] = PREVIEW_COLORS.white;
            } else if (y >= seaLevel + 12) {
                [r, g, b] = PREVIEW_COLORS.grey;
            } else {
                let hasWaterNeighbor = false;
                for (let dz = -1; dz <= 1 && dz + z >= 0 && dz + z < length; dz++)
                    for (let dx = -1; dx <= 1 && dx + x >= 0 && dx + x < width; dx++)
                        if ((dx || dz) && blockY[(z + dz) * width + (x + dx)] < seaLevel) {
                            hasWaterNeighbor = true;
                            break;
                        }
                [r, g, b] = hasWaterNeighbor ? PREVIEW_COLORS.sand : PREVIEW_COLORS.green;
            }

            const o = i * 4;
            img.data[o] = r;
            img.data[o + 1] = g;
            img.data[o + 2] = b;
            img.data[o + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL("image/png");
}

/**
 * Generate a thumbnail from a data URL image
 * @param dataUrl - Source image as data URL
 * @param maxWidth - Maximum width of thumbnail
 * @param maxHeight - Maximum height of thumbnail
 * @returns Thumbnail as data URL (JPEG)
 */
export async function generateThumbnail(
    dataUrl: string,
    maxWidth: number,
    maxHeight: number
): Promise<string> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            let width = img.width;
            let height = img.height;

            // Scale down to fit within max dimensions while maintaining aspect ratio
            if (width > maxWidth) {
                height = (maxWidth / width) * height;
                width = maxWidth;
            }
            if (height > maxHeight) {
                width = (maxHeight / height) * width;
                height = maxHeight;
            }

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;

            const ctx = canvas.getContext('2d');
            if (!ctx) {
                reject(new Error('Could not get canvas context'));
                return;
            }

            ctx.drawImage(img, 0, 0, width, height);
            resolve(canvas.toDataURL('image/jpeg', 0.7));
        };
        img.onerror = () => reject(new Error('Failed to load image'));
        img.src = dataUrl;
    });
}
