import React, { useState, useCallback, useEffect } from "react";
import "../../css/AIAssistantPanel.css";

export const generateUniqueId = (): string => {
    return Date.now().toString(36) + Math.random().toString(36).substring(2);
};

export type RawSchematicType = {
    blocks: Record<string, number>;
    entities?: Array<{
        position: [number, number, number];
        entityName: string;
        rotation?: [number, number, number];
    }>;
};

export interface SchematicValue {
    prompt: string;
    schematic: RawSchematicType;
    timestamp: number;
}

export interface SchematicHistoryEntry extends SchematicValue {
    id: string;
}

const MIGRATION_MARKER_V2 = "schematicStoreMigrated_to_id_key_v2";

async function migrateSchematicStoreV2IfNeeded(
    db: IDBDatabase,
    STORES: { SCHEMATICS: string }
): Promise<void> {
    if (localStorage.getItem(MIGRATION_MARKER_V2) === "true") return;

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.SCHEMATICS, "readwrite");
        const store = tx.objectStore(STORES.SCHEMATICS);
        const itemsToMigrate: { oldKey: string; valueToConvert: RawSchematicType & { timestamp?: number } }[] = [];
        const cursorRequest = store.openCursor();

        cursorRequest.onsuccess = (event: any) => {
            const cursor = event.target?.result;
            if (cursor) {
                const val = cursor.value;
                if (typeof cursor.key === "string" && val?.prompt === undefined) {
                    itemsToMigrate.push({ oldKey: cursor.key, valueToConvert: val });
                }
                cursor.continue();
            } else {
                itemsToMigrate.forEach((item) => {
                    const newId = generateUniqueId();
                    const newVal: SchematicValue = {
                        prompt: item.oldKey,
                        schematic: item.valueToConvert,
                        timestamp: item.valueToConvert.timestamp || Date.now(),
                    };
                    store.delete(item.oldKey);
                    store.add(newVal, newId);
                });
                if (itemsToMigrate.length) localStorage.setItem(MIGRATION_MARKER_V2, "true");
                resolve();
            }
        };
        cursorRequest.onerror = () => reject(cursorRequest.error);
        tx.onerror = () => reject(tx.error);
    });
}

interface AIAssistantPanelProps {
    loadAISchematic: (schematic: RawSchematicType) => void;
    isVisible: boolean;
    isEmbedded?: boolean;
}

const AIAssistantPanel = ({
    loadAISchematic,
    isVisible,
    isEmbedded = false,
}: AIAssistantPanelProps) => {
    const [pasteJson, setPasteJson] = useState("");
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!isVisible) return;
        import("../managers/DatabaseManager").then(({ DatabaseManager, STORES }) =>
            DatabaseManager.getDBConnection().then((db) => migrateSchematicStoreV2IfNeeded(db, STORES))
        ).catch(console.error);
    }, [isVisible]);

    const handleLoad = useCallback(() => {
        setError(null);
        try {
            const parsed = JSON.parse(pasteJson.trim());
            const blocks = parsed.blocks && typeof parsed.blocks === "object" ? parsed.blocks : {};
            const entities = parsed.entities && Array.isArray(parsed.entities) ? parsed.entities : undefined;
            const hasBlocks = Object.keys(blocks).length > 0;
            const hasEntities = entities?.length > 0;
            if (hasBlocks || hasEntities) {
                loadAISchematic({ blocks, entities });
                setPasteJson("");
                const newId = generateUniqueId();
                import("../managers/DatabaseManager").then(({ DatabaseManager, STORES }) =>
                    DatabaseManager.saveData(STORES.SCHEMATICS, newId, {
                        prompt: "AI schematic",
                        schematic: { blocks, entities },
                        timestamp: Date.now(),
                    })
                ).then(() => window.dispatchEvent(new CustomEvent("schematicsDbUpdated"))).catch(() => {});
            } else {
                setError("JSON needs a 'blocks' object with at least one block.");
            }
        } catch {
            setError("Invalid JSON. Ask Cursor for a schematic and paste it here.");
        }
    }, [pasteJson, loadAISchematic]);

    if (!isVisible) return null;

    return (
        <div className={`ai-assistant-panel ${isEmbedded ? "embedded" : ""}`}>
            <p className="text-xs text-white/60 mb-2">
                Ask Cursor: &quot;Generate a schematic for [building] in world editor format&quot; — then paste the JSON below.
            </p>
            <textarea
                onKeyDown={(e) => e.stopPropagation()}
                className="p-2 w-full h-24 text-xs bg-black/20 rounded border border-white/10 focus:border-white/30 outline-none resize-none font-mono"
                value={pasteJson}
                onChange={(e) => { setPasteJson(e.target.value); setError(null); }}
                placeholder='{"blocks":{"0,0,0":17,"1,0,0":10},...}'
            />
            <button
                type="button"
                onClick={handleLoad}
                disabled={!pasteJson.trim()}
                className="ai-assistant-button mt-2"
            >
                Load Schematic
            </button>
            {error && <div className="ai-assistant-error mt-1">{error}</div>}
        </div>
    );
};

export default AIAssistantPanel;
