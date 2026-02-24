import { useState, useEffect, useCallback, useRef } from "react";
import type SeedGeneratorTool from "../tools/SeedGeneratorTool";
import {
    DEFAULT_SETTINGS,
    SIZE_PRESETS,
} from "../tools/SeedGeneratorTool";
import { seedStringToNumber, deriveWorldFromSeed } from "../utils/SeedDerivation";
import { computePreviewData } from "../utils/TerrainGenerator";

interface Props {
    seedGeneratorTool: SeedGeneratorTool | undefined;
    isCompactMode?: boolean;
}

// Simple 5-color palette: blue, green, grey, white, sand
const PREVIEW_COLORS: Record<string, [number, number, number]> = {
    blue: [21, 101, 192],   // water
    green: [74, 150, 66],   // land
    grey: [120, 120, 130],  // mountain/stone
    white: [255, 255, 255], // snow
    sand: [210, 180, 120],  // beach/desert
};

function HeightmapPreview({ seed, width, length, maxHeight = 64 }: { seed: string; width: number; length: number; maxHeight?: number }) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const maxDim = 200;
    useEffect(() => {
        const c = canvasRef.current;
        if (!c || width < 1 || length < 1) return;
        const seedNum = seedStringToNumber(seed);
        const settings = deriveWorldFromSeed(seed, { width, length, maxHeight });
        const { blockY, biomeMap, seaLevel } = computePreviewData(settings, seedNum);

        const snowY = seaLevel + 20;

        const ctx = c.getContext("2d");
        if (!ctx) return;
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
                    const hasWaterNeighbor = (() => {
                        for (let dz = -1; dz <= 1 && dz + z >= 0 && dz + z < length; dz++)
                            for (let dx = -1; dx <= 1 && dx + x >= 0 && dx + x < width; dx++)
                                if ((dx || dz) && blockY[(z + dz) * width + (x + dx)] < seaLevel) return true;
                        return false;
                    })();
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
    }, [seed, width, length, maxHeight]);
    const scale = Math.min(1, maxDim / Math.max(width, length));
    return (
        <canvas
            ref={canvasRef}
            width={width}
            height={length}
            style={{ width: width * scale, height: length * scale, imageRendering: "pixelated" }}
            className="rounded border border-white/10 block"
            title="1:1 topography preview"
        />
    );
}

const FAV_KEY = "seedgen_favorites";
const MAX_FAVORITES = 12;

function loadFavorites(): string[] {
    try {
        const s = localStorage.getItem(FAV_KEY);
        return s ? JSON.parse(s) : [];
    } catch { return []; }
}

function saveFavorites(fav: string[]) {
    localStorage.setItem(FAV_KEY, JSON.stringify(fav.slice(-MAX_FAVORITES)));
}

const SIZE_LABELS: Record<keyof typeof SIZE_PRESETS, string> = {
    pocket: "Pocket (80×80)",
    standard: "Standard (120×120)",
    expansive: "Expansive (200×200)",
    custom: "Custom",
};

export default function SeedGeneratorToolOptionsSection({
    seedGeneratorTool,
}: Props) {
    const [seed, setSeed] = useState(DEFAULT_SETTINGS.seed);
    const [sizePreset, setSizePreset] = useState<keyof typeof SIZE_PRESETS>(
        DEFAULT_SETTINGS.sizePreset ?? "standard"
    );
    const [customWidth, setCustomWidth] = useState(String(DEFAULT_SETTINGS.width));
    const [customLength, setCustomLength] = useState(String(DEFAULT_SETTINGS.length));
    const [customMaxHeight, setCustomMaxHeight] = useState(String(DEFAULT_SETTINGS.maxHeight));
    const [hollowWorld, setHollowWorld] = useState(false);
    const [clearMap, setClearMap] = useState(DEFAULT_SETTINGS.clearMap);

    const [isGenerating, setIsGenerating] = useState(false);
    const [progressMessage, setProgressMessage] = useState("");
    const [progressPercent, setProgressPercent] = useState(0);
    const [etaSeconds, setEtaSeconds] = useState<number | null>(null);
    const startTimeRef = useRef<number | null>(null);
    const [favorites, setFavorites] = useState<string[]>(() => loadFavorites());

    const syncToTool = useCallback(() => {
        if (!seedGeneratorTool) return;
        let width = 120, length = 120, maxHeight = 64;
        if (sizePreset === "custom") {
            width = Math.max(10, Math.min(500, parseInt(customWidth, 10) || 120));
            length = Math.max(10, Math.min(500, parseInt(customLength, 10) || 120));
            maxHeight = Math.max(32, Math.min(256, parseInt(customMaxHeight, 10) || 64));
        } else {
            const p = SIZE_PRESETS[sizePreset];
            if (p) ({ width, length, maxHeight } = p);
        }
        seedGeneratorTool.updateSettings({
            seed,
            sizePreset,
            width,
            length,
            maxHeight,
            clearMap,
            hollowWorld,
        });
    }, [seedGeneratorTool, seed, sizePreset, customWidth, customLength, customMaxHeight, clearMap, hollowWorld]);

    useEffect(() => {
        syncToTool();
    }, [syncToTool]);

    useEffect(() => {
        if (!seedGeneratorTool) return;
        const listener = (message: string, percent: number) => {
            setProgressMessage(message);
            setProgressPercent(percent);
            if (percent > 5 && percent < 95) {
                const now = Date.now();
                if (!startTimeRef.current) startTimeRef.current = now;
                const elapsed = (now - startTimeRef.current) / 1000;
                const eta = Math.round((elapsed / percent) * (100 - percent));
                setEtaSeconds(eta);
            } else {
                setEtaSeconds(null);
            }
            if (percent >= 100 || percent < 0) {
                setIsGenerating(false);
                startTimeRef.current = null;
            }
        };
        seedGeneratorTool.addProgressListener(listener);
        return () => seedGeneratorTool.removeProgressListener(listener);
    }, [seedGeneratorTool]);

    const handleGenerate = async () => {
        if (!seedGeneratorTool || isGenerating) return;
        syncToTool();
        setIsGenerating(true);
        setProgressPercent(0);
        setProgressMessage("Starting generation...");
        setEtaSeconds(null);
        startTimeRef.current = null;
        await seedGeneratorTool.generateWorldFromSeed();
    };

    const handleRandomSeed = () => {
        const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        const len = 4 + Math.floor(Math.random() * 6);
        let s = "";
        for (let i = 0; i < len; i++) {
            s += chars[Math.floor(Math.random() * chars.length)];
        }
        setSeed(s);
    };

    const handleAddFavorite = () => {
        const s = seed.trim() || "0";
        if (!s) return;
        const next = [...new Set([s, ...favorites.filter((f) => f !== s)])].slice(-MAX_FAVORITES);
        setFavorites(next);
        saveFavorites(next);
    };

    const handleRemoveFavorite = (fav: string) => {
        const next = favorites.filter((f) => f !== fav);
        setFavorites(next);
        saveFavorites(next);
    };

    if (!seedGeneratorTool) {
        return (
            <div className="text-xs text-[#F1F1F1]/60">
                Seed generator tool not initialised...
            </div>
        );
    }

    const inputClass =
        "w-full px-2 py-1 text-xs rounded bg-white/10 border border-white/10 text-[#F1F1F1] outline-none focus:border-white/30";
    const labelClass = "text-xs text-[#F1F1F1]/80 whitespace-nowrap";
    const sectionTitleClass =
        "text-xs font-semibold text-[#F1F1F1]/60 uppercase tracking-wide mt-2 mb-1";

    return (
        <div className="flex flex-col gap-3">
            {/* Seed - the main input */}
            <div>
                <span className={sectionTitleClass}>Seed</span>
                <p className="text-[10px] text-[#F1F1F1]/50 mb-1">
                    Same seed = same map for everyone (deterministic)
                </p>
                <div className="flex gap-1 mt-1">
                    <input
                        type="text"
                        value={seed}
                        onChange={(e) => setSeed(e.target.value)}
                        placeholder="e.g. Hytopia, a1b2, MyWorld42"
                        className={inputClass + " flex-1 font-mono"}
                    />
                    <button
                        onClick={handleRandomSeed}
                        className="px-2 py-1 text-sm rounded bg-white/10 hover:bg-white/20 border border-white/10 text-[#F1F1F1] transition-colors"
                        title="Random seed"
                    >
                        &#127922;
                    </button>
                    <button
                        onClick={() => {
                            navigator.clipboard?.writeText(seed);
                        }}
                        className="px-2 py-1 text-sm rounded bg-white/10 hover:bg-white/20 border border-white/10 text-[#F1F1F1] transition-colors"
                        title="Copy seed"
                    >
                        &#128203;
                    </button>
                </div>
                <div className="mt-2 flex items-center gap-2">
                    <HeightmapPreview
                        seed={seed}
                        width={sizePreset === "custom" ? Math.max(10, Math.min(500, parseInt(customWidth, 10) || 120)) : (SIZE_PRESETS[sizePreset]?.width ?? 120)}
                        length={sizePreset === "custom" ? Math.max(10, Math.min(500, parseInt(customLength, 10) || 120)) : (SIZE_PRESETS[sizePreset]?.length ?? 120)}
                        maxHeight={sizePreset === "custom" ? Math.max(32, Math.min(256, parseInt(customMaxHeight, 10) || 64)) : (SIZE_PRESETS[sizePreset]?.maxHeight ?? 64)}
                    />
                    <span className="text-[10px] text-[#F1F1F1]/50">Preview</span>
                </div>
                <button
                    onClick={handleAddFavorite}
                    className="mt-1 text-[10px] text-[#F1F1F1]/60 hover:text-[#F1F1F1]"
                >
                    ★ Add to favorites
                </button>
                {favorites.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                        {favorites.map((fav) => (
                            <span
                                key={fav}
                                className="inline-flex items-center gap-0.5 rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-[#F1F1F1]/80"
                            >
                                <span onClick={() => setSeed(fav)} className="cursor-pointer hover:text-white">{fav}</span>
                                <button type="button" onClick={() => handleRemoveFavorite(fav)} className="text-[#F1F1F1]/50 hover:text-red-400" title="Remove">×</button>
                            </span>
                        ))}
                    </div>
                )}
            </div>

            {/* Size preset + custom */}
            <div>
                <span className={sectionTitleClass}>World Size</span>
                <div className="grid grid-cols-2 gap-1 mt-1">
                    {(Object.keys(SIZE_PRESETS) as Array<keyof typeof SIZE_PRESETS>).map((key) => (
                        <button
                            key={key}
                            onClick={() => {
                                setSizePreset(key);
                                const p = SIZE_PRESETS[key as keyof typeof SIZE_PRESETS];
                                if (p) {
                                    setCustomWidth(String(p.width));
                                    setCustomLength(String(p.length));
                                    setCustomMaxHeight(String(p.maxHeight));
                                }
                            }}
                            className={`px-2 py-1.5 text-xs rounded border transition-colors ${
                                sizePreset === key
                                    ? "bg-green-600/40 border-green-500/50 text-white"
                                    : "bg-white/10 border-white/10 text-[#F1F1F1]/80 hover:bg-white/20"
                            }`}
                        >
                            {SIZE_LABELS[key]}
                        </button>
                    ))}
                </div>
                {sizePreset === "custom" && (
                    <div className="grid grid-cols-3 gap-1 mt-2">
                        <div>
                            <label className={labelClass}>X</label>
                            <input
                                type="number"
                                min={10}
                                max={500}
                                value={customWidth}
                                onChange={(e) => setCustomWidth(e.target.value)}
                                onKeyDown={(e) => { if (e.key === "0") { e.stopPropagation(); e.nativeEvent?.stopImmediatePropagation?.(); } }}
                                data-ignore-camera-hotkey
                                className={inputClass}
                            />
                        </div>
                        <div>
                            <label className={labelClass}>Z</label>
                            <input
                                type="number"
                                min={10}
                                max={500}
                                value={customLength}
                                onChange={(e) => setCustomLength(e.target.value)}
                                onKeyDown={(e) => { if (e.key === "0") { e.stopPropagation(); e.nativeEvent?.stopImmediatePropagation?.(); } }}
                                data-ignore-camera-hotkey
                                className={inputClass}
                            />
                        </div>
                        <div>
                            <label className={labelClass}>Y</label>
                            <input
                                type="number"
                                min={32}
                                max={256}
                                value={customMaxHeight}
                                onChange={(e) => setCustomMaxHeight(e.target.value)}
                                onKeyDown={(e) => { if (e.key === "0") { e.stopPropagation(); e.nativeEvent?.stopImmediatePropagation?.(); } }}
                                data-ignore-camera-hotkey
                                className={inputClass}
                            />
                        </div>
                        {(parseInt(customWidth, 10) > 350 || parseInt(customLength, 10) > 350) && (
                            <p className="text-[10px] text-amber-400/90 mt-1">
                                Large worlds (400×400+) may need significant memory. If generation fails, try 200×200.
                            </p>
                        )}
                    </div>
                )}
            </div>

            {/* Controls */}
            <div className="border-t border-white/10 pt-2 flex flex-col gap-2">
                <div className="flex items-center justify-between">
                    <span className={labelClass}>Clear map first</span>
                    <input
                        type="checkbox"
                        checked={clearMap}
                        onChange={(e) => setClearMap(e.target.checked)}
                        className="w-4 h-4 rounded bg-white/10 border-white/10 checked:bg-green-500 checked:border-green-500"
                    />
                </div>
                <div className="flex items-center justify-between">
                    <span className={labelClass} title="Large caves & hollow underground to reduce block count">Hollow world</span>
                    <input
                        type="checkbox"
                        checked={hollowWorld}
                        onChange={(e) => setHollowWorld(e.target.checked)}
                        className="w-4 h-4 rounded bg-white/10 border-white/10 checked:bg-green-500 checked:border-green-500"
                    />
                </div>

                <button
                    onClick={handleGenerate}
                    disabled={isGenerating}
                    className={`w-full py-2 text-sm font-semibold rounded transition-colors ${
                        isGenerating
                            ? "bg-gray-600 text-gray-400 cursor-not-allowed"
                            : "bg-green-600 hover:bg-green-700 text-white cursor-pointer"
                    }`}
                >
                    {isGenerating ? "Generating..." : "Generate World"}
                </button>

                {/* Progress bar */}
                {isGenerating && (
                    <div>
                        <div className="text-xs text-[#F1F1F1]/60 mb-1">
                            {progressMessage}
                            {etaSeconds != null && etaSeconds > 0 && (
                                <span className="ml-1 text-[#F1F1F1]/40">~{etaSeconds}s left</span>
                            )}
                        </div>
                        <div className="w-full h-2 bg-white/10 rounded overflow-hidden">
                            <div
                                className="h-full bg-green-500 transition-all duration-200"
                                style={{
                                    width: `${Math.max(0, progressPercent)}%`,
                                }}
                            />
                        </div>
                    </div>
                )}

                {!isGenerating && progressPercent >= 100 && (
                    <div className="text-xs text-green-400">
                        {progressMessage}
                    </div>
                )}
                {!isGenerating && progressPercent < 0 && (
                    <div className="text-xs text-red-400">
                        {progressMessage}
                    </div>
                )}
            </div>
        </div>
    );
}
