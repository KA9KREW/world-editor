import BaseTool from "./BaseTool";
import { generateHytopiaWorld } from "../utils/TerrainGenerator";
import { getBlockTypes } from "../managers/BlockTypesManager";
import { DatabaseManager, STORES } from "../managers/DatabaseManager";
import { generateSeedPreviewDataUrl } from "../utils/thumbnailUtils";
import { generateThumbnail } from "../utils/thumbnailUtils";
import { deriveWorldFromSeed, seedStringToNumber } from "../utils/SeedDerivation";
import { iteratePackedRegion } from "../utils/BlockRegionPacker";
import { exportGeneratedMapToZip, type ExportOptions } from "../ImportExport";
import {
    STONE_VARIANTS,
    DEEPSLATE_VARIANTS,
    SURFACE_BY_BIOME,
    SUBSURFACE_BY_BIOME,
    ROCKY_SURFACE,
    MOUNTAIN_STONE,
    MOSSY_VARIANTS,
    LAVA_NEARBY,
    SAND_VARIANTS,
    PLAINS_ACCENT,
    TREE_BY_BIOME,
} from "../utils/TerrainBlockMap";

/** Seed + size (preset or custom). Same seed = same map everywhere. */
export interface SeedGeneratorSettings {
    seed: string;
    width: number;
    length: number;
    maxHeight: number;
    sizePreset?: "pocket" | "standard" | "expansive" | "custom";
    clearMap: boolean;
    hollowWorld?: boolean;
}

export const AVAILABLE_BIOMES = [
    "desert",
    "forest",
    "plains",
    "snowy_plains",
    "snowy_forest",
    "snowy_taiga",
    "swamp",
    "savanna",
    "jungle",
    "poplar_forest",
    "cherry_grove",
    "ocean",
] as const;

export const SIZE_PRESETS = {
    pocket: { width: 80, length: 80, maxHeight: 64 },
    standard: { width: 120, length: 120, maxHeight: 64 },
    expansive: { width: 200, length: 200, maxHeight: 64 },
    custom: null,
} as const;

export const DEFAULT_SETTINGS: SeedGeneratorSettings = {
    seed: "Hytopia",
    width: 120,
    length: 120,
    maxHeight: 64,
    sizePreset: "standard",
    clearMap: true,
};

class SeedGeneratorTool extends BaseTool {
    generationOptions: SeedGeneratorSettings;
    isGenerating: boolean;
    progressMessage: string;
    progressPercent: number;
    terrainBuilderRef: any;
    terrainRef: any;

    private _onProgressListeners: Array<
        (message: string, percent: number) => void
    > = [];

    constructor(terrainBuilderProps: any) {
        super(terrainBuilderProps);
        this.name = "SeedGeneratorTool";
        this.tooltip = "Seed Generator: Create worlds from a seed value";

        if (terrainBuilderProps) {
            this.terrainRef = terrainBuilderProps.terrainRef;
            this.terrainBuilderRef = terrainBuilderProps.terrainBuilderRef;
        }

        this.generationOptions = { ...DEFAULT_SETTINGS };
        this.isGenerating = false;
        this.progressMessage = "";
        this.progressPercent = 0;
    }

    onActivate(): boolean {
        return true;
    }

    onDeactivate(): void {}

    updateSettings(newSettings: Partial<SeedGeneratorSettings>): void {
        Object.assign(this.generationOptions, newSettings);
    }

    addProgressListener(
        listener: (message: string, percent: number) => void
    ): void {
        this._onProgressListeners.push(listener);
    }

    removeProgressListener(
        listener: (message: string, percent: number) => void
    ): void {
        this._onProgressListeners = this._onProgressListeners.filter(
            (l) => l !== listener
        );
    }

    private notifyProgress(message: string, percent: number): void {
        this.progressMessage = message;
        this.progressPercent = percent;
        for (const listener of this._onProgressListeners) {
            listener(message, percent);
        }
    }

    findBlockTypeId(
        blockTypesList: any[],
        name: string
    ): number {
        const n = name.toLowerCase().replace(/\s+/g, "-");
        // Prefer exact match so "stone" doesn't match "cobblestone-snow"
        const exact = blockTypesList.find((b: any) => b.name && b.name.toLowerCase() === n);
        if (exact) return exact.id;
        const includes = blockTypesList.find((b: any) => b.name && b.name.toLowerCase().includes(n));
        if (includes) return includes.id;
        return blockTypesList[0]?.id || 1;
    }

    async generateWorldFromSeed(): Promise<Record<string, number> | null> {
        if (this.isGenerating) return null;

        const opts = this.generationOptions;

        if (!this.terrainBuilderRef || !this.terrainBuilderRef.current) {
            console.error("TerrainBuilder reference not available");
            return null;
        }

        this.isGenerating = true;
        this.notifyProgress("Deriving world from seed...", 0);

        const seedNum = seedStringToNumber(opts.seed);

        const settings: any = {
            ...deriveWorldFromSeed(opts.seed, {
                width: opts.width ?? 120,
                length: opts.length ?? 120,
                maxHeight: opts.maxHeight ?? 64,
                clearMap: opts.clearMap !== false,
                hollowWorld: opts.hollowWorld,
            }),
        };

        if (settings.clearMap) {
            await this.terrainBuilderRef.current.clearMap();
        }

        const blockTypesList = getBlockTypes();
        const find = (name: string) => this.findBlockTypeId(blockTypesList, name);

        const allNames = new Set<string>();
        [STONE_VARIANTS, DEEPSLATE_VARIANTS, ROCKY_SURFACE, MOUNTAIN_STONE, MOSSY_VARIANTS, LAVA_NEARBY, SAND_VARIANTS, PLAINS_ACCENT]
            .flat()
            .forEach((v: any) => allNames.add(typeof v === "string" ? v : v.name));
        Object.values(SURFACE_BY_BIOME).flat().forEach((n: string) => allNames.add(n));
        Object.values(SUBSURFACE_BY_BIOME).flat().forEach((n: string) => allNames.add(n));
        Object.values(TREE_BY_BIOME).forEach((t: any) => { allNames.add(t.log); allNames.add(t.leaf); });

        const blockTypes: Record<string, number> = {
            stone: find("stone"),
            deepslate: find("deepslate"),
            "cobbled-deepslate": find("cobbled-deepslate"),
            andesite: find("andesite"),
            granite: find("granite"),
            diorite: find("diorite"),
            "smooth-stone": find("smooth-stone"),
            dirt: find("dirt"),
            cobblestone: find("cobblestone"),
            "mossy-cobblestone": find("mossy-cobblestone"),
            "grass-block": find("grass-block"),
            "grass-block-pine": find("grass-block-pine"),
            "grass-flower-block": find("grass-flower-block"),
            "grass-flower-block-pine": find("grass-flower-block-pine"),
            "grass-snow-block": find("grass-snow-block"),
            grass: find("grass"),
            sand: find("sand"),
            "sand-wet": find("sand-wet"),
            sandstone: find("sandstone"),
            snow: find("snow"),
            "snow-rocky": find("snow-rocky"),
            "cobblestone-snow": find("cobblestone-snow"),
            ice: find("ice"),
            "water-still": find("water"),
            lava: find("lava"),
            "lava-stone": find("lava-stone"),
            "magma-block": find("magma-block"),
            "hay-block": find("hay-block"),
            "oak-log": find("oak-log"),
            "birch-log": find("birch-log"),
            "spruce-log": find("spruce-log"),
            "oak-leaves": find("oak-leaves"),
            "birch-leaves": find("birch-leaves"),
            "spruce-leaves": find("spruce-leaves"),
            "dark-oak-leaves": find("dark-oak-leaves"),
            "jungle-leaves": find("jungle-leaves"),
            "cherry-leaves": find("cherry-leaves"),
            "azalea-flowering-leaves": find("azalea-flowering-leaves"),
            "azalea-leaves": find("azalea-leaves"),
            coal: find("coal-ore"),
            iron: find("iron-ore"),
            gold: find("gold-ore"),
            diamond: find("diamond-ore"),
            emerald: find("emerald-ore"),
            ruby: find("ruby-ore"),
            sapphire: find("sapphire-ore"),
            "deepslate-coal": find("deepslate-coal-ore"),
            "deepslate-iron": find("deepslate-iron-ore"),
            "deepslate-gold": find("deepslate-gold-ore"),
            "deepslate-diamond": find("deepslate-diamond-ore"),
            "deepslate-emerald": find("deepslate-emerald-ore"),
            "deepslate-ruby": find("deepslate-ruby-ore"),
            "deepslate-sapphire": find("deepslate-sapphire-ore"),
            "mushroom-stem": find("mushroom-stem"),
            "brown-mushroom-block": find("brown-mushroom-block"),
            "red-mushroom-block": find("red-mushroom-block"),
            "stone-bricks": find("stone-bricks"),
            "mossy-stone-bricks": find("mossy-stone-bricks"),
        };

        try {
            const startTime = performance.now();

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const result: any = generateHytopiaWorld(
                settings,
                seedNum,
                blockTypes,
                (message: string, progress: number) => {
                    this.notifyProgress(message, progress);
                }
            );

            const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
            console.log(`World generation took ${elapsed}s`);

            if (result) {
                const { blockStore, terrainData } = result;
                const blockCount = blockStore ? blockStore.getBlockCount() : 0;
                this.notifyProgress("Applying terrain to scene...", 98);
                this.terrainBuilderRef.current.updateTerrainFromToolBar(
                    blockStore ? { _regions: blockStore.getRegionsForBulkLoad(), _blockCount: blockCount } : terrainData
                );

                setTimeout(() => this.forceSaveTerrain(blockStore ? null : terrainData), 1000);

                // Save seed as project name and seed preview as thumbnail (async, non-blocking)
                const pid = DatabaseManager.getCurrentProjectId?.();
                if (pid) {
                    const opts = this.generationOptions;
                    const seedName = (opts.seed || "").trim() || "Seed";
                    DatabaseManager.saveProjectName(pid, seedName).catch(() => {});
                    const w = opts.width ?? 120;
                    const l = opts.length ?? 120;
                    const h = opts.maxHeight ?? 64;
                    const previewUrl = generateSeedPreviewDataUrl(opts.seed, w, l, h);
                    if (previewUrl) {
                        generateThumbnail(previewUrl, 256, 144)
                            .then((thumbUrl) => DatabaseManager.saveProjectThumbnail(pid, thumbUrl))
                            .catch(() => {});
                    }
                }

                this.notifyProgress(
                    `Done! ${blockCount} blocks in ${elapsed}s`,
                    100
                );
                this.isGenerating = false;
                return terrainData;
            }
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            console.error("Error generating world:", error);
            this.notifyProgress(
                `Error: ${errMsg.includes("heap") || errMsg.includes("memory") ? "Out of memory. Try a smaller world size (e.g. 200×200)." : errMsg}`,
                -1
            );
        }

        this.isGenerating = false;
        return null;
    }

    /** Generate world and export directly to ZIP (no editor load). */
    async generateWorldToZip(exportOptions: ExportOptions): Promise<void> {
        if (this.isGenerating) return;
        const opts = this.generationOptions;
        if (!opts) return;

        this.isGenerating = true;
        this.notifyProgress("Generating world...", 0);
        const seedNum = seedStringToNumber(opts.seed);
        const settings: any = {
            ...deriveWorldFromSeed(opts.seed, {
                width: opts.width ?? 120,
                length: opts.length ?? 120,
                maxHeight: opts.maxHeight ?? 64,
                clearMap: false,
                hollowWorld: opts.hollowWorld,
            }),
        };

        const blockTypesList = getBlockTypes();
        const find = (name: string) => this.findBlockTypeId(blockTypesList, name);
        const allNames = new Set<string>();
        [STONE_VARIANTS, DEEPSLATE_VARIANTS, ROCKY_SURFACE, MOUNTAIN_STONE, MOSSY_VARIANTS, LAVA_NEARBY, SAND_VARIANTS, PLAINS_ACCENT]
            .flat()
            .forEach((v: any) => allNames.add(typeof v === "string" ? v : v.name));
        Object.values(SURFACE_BY_BIOME).flat().forEach((n: string) => allNames.add(n));
        Object.values(SUBSURFACE_BY_BIOME).flat().forEach((n: string) => allNames.add(n));
        Object.values(TREE_BY_BIOME).forEach((t: any) => { allNames.add(t.log); allNames.add(t.leaf); });

        const blockTypes: Record<string, number> = {
            stone: find("stone"),
            deepslate: find("deepslate"),
            "cobbled-deepslate": find("cobbled-deepslate"),
            andesite: find("andesite"),
            granite: find("granite"),
            diorite: find("diorite"),
            "smooth-stone": find("smooth-stone"),
            dirt: find("dirt"),
            cobblestone: find("cobblestone"),
            "mossy-cobblestone": find("mossy-cobblestone"),
            "grass-block": find("grass-block"),
            "grass-block-pine": find("grass-block-pine"),
            "grass-flower-block": find("grass-flower-block"),
            "grass-flower-block-pine": find("grass-flower-block-pine"),
            "grass-snow-block": find("grass-snow-block"),
            grass: find("grass"),
            sand: find("sand"),
            "sand-wet": find("sand-wet"),
            sandstone: find("sandstone"),
            snow: find("snow"),
            "snow-rocky": find("snow-rocky"),
            "cobblestone-snow": find("cobblestone-snow"),
            ice: find("ice"),
            "water-still": find("water"),
            lava: find("lava"),
            "lava-stone": find("lava-stone"),
            "magma-block": find("magma-block"),
            "hay-block": find("hay-block"),
            "oak-log": find("oak-log"),
            "birch-log": find("birch-log"),
            "spruce-log": find("spruce-log"),
            "oak-leaves": find("oak-leaves"),
            "birch-leaves": find("birch-leaves"),
            "spruce-leaves": find("spruce-leaves"),
            "dark-oak-leaves": find("dark-oak-leaves"),
            "jungle-leaves": find("jungle-leaves"),
            "cherry-leaves": find("cherry-leaves"),
            "azalea-flowering-leaves": find("azalea-flowering-leaves"),
            "azalea-leaves": find("azalea-leaves"),
            coal: find("coal-ore"),
            iron: find("iron-ore"),
            gold: find("gold-ore"),
            diamond: find("diamond-ore"),
            emerald: find("emerald-ore"),
            ruby: find("ruby-ore"),
            sapphire: find("sapphire-ore"),
            "deepslate-coal": find("deepslate-coal-ore"),
            "deepslate-iron": find("deepslate-iron-ore"),
            "deepslate-gold": find("deepslate-gold-ore"),
            "deepslate-diamond": find("deepslate-diamond-ore"),
            "deepslate-emerald": find("deepslate-emerald-ore"),
            "deepslate-ruby": find("deepslate-ruby-ore"),
            "deepslate-sapphire": find("deepslate-sapphire-ore"),
            "mushroom-stem": find("mushroom-stem"),
            "brown-mushroom-block": find("brown-mushroom-block"),
            "red-mushroom-block": find("red-mushroom-block"),
            "stone-bricks": find("stone-bricks"),
            "mossy-stone-bricks": find("mossy-stone-bricks"),
        };

        try {
            const result: any = generateHytopiaWorld(
                settings,
                seedNum,
                blockTypes,
                (msg: string, pct: number) => this.notifyProgress(msg, pct)
            );
            if (!result) {
                this.isGenerating = false;
                return;
            }

            const { blockStore } = result;
            let terrainData: Record<string, number> = {};
            if (blockStore) {
                for (const [, r] of blockStore.getRegionsForBulkLoad()) {
                    if (!r?.packed) continue;
                    const { rx, ry, rz } = r;
                    for (const [posKey, blockId] of iteratePackedRegion(r.packed, rx, ry, rz)) {
                        terrainData[posKey] = blockId;
                    }
                }
            } else {
                terrainData = result.terrainData || {};
            }

            this.notifyProgress("Writing map.json to ZIP...", 95);
            await exportGeneratedMapToZip(terrainData, exportOptions);
            this.notifyProgress("Done!", 100);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.notifyProgress(`Error: ${msg}`, -1);
            console.error("Generate to ZIP failed:", err);
        }
        this.isGenerating = false;
    }

    private async forceSaveTerrain(
        terrainData: Record<string, number> | null
    ): Promise<void> {
        if (!terrainData) return;
        let blockCount = 0;
        try { blockCount = Object.keys(terrainData).length; } catch (_) { return; }
        if (blockCount === 0) return;

        try {
            if (blockCount > 50000) {
                // Large worlds: already saved via VirtualTerrainStore.flushDirtyRegions in updateTerrainFromToolBar.
                // Avoid saveTerrainAsRegions (would OOM on millions of blocks).
                // Just refresh if needed.
            } else {
                await DatabaseManager.saveData(
                    STORES.TERRAIN,
                    "current",
                    terrainData
                );
            }
            if (this.terrainBuilderRef?.current?.refreshTerrainFromDB) {
                await this.terrainBuilderRef.current.refreshTerrainFromDB();
            }
        } catch (error) {
            console.error("Error force saving terrain:", error);
        }
    }

    dispose(): void {}
}

export default SeedGeneratorTool;
