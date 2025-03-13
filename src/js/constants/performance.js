// Performance settings
export const PERFORMANCE_SETTINGS = {
  maxChunksPerFrame: 5,
  objectPooling: true,
  batchedGeometry: true,
  occlusionCulling: true,
  instancingEnabled: true,
  shadowDistance: 96,
};

// Environment instance meshing constant
export const ENVIRONMENT_INSTANCED_MESH_CAPACITY = 50000;

// Texture Atlas settings
export const TEXTURE_ATLAS_SETTINGS = {
  batchedChunkRebuilding: true,
  maxConcurrentChunkRebuilds: 8,
  prioritizeChunksByDistance: true,
  delayInitialRebuild: false,
  initialRebuildDelay: 0,
  useTextureAtlas: false,
};

// Flag to indicate that meshes need to be refreshed
let _meshesNeedRefresh = false;

// Create a meshesNeedsRefresh object that works as both property and function
export const meshesNeedsRefresh = function(value) {
  if (value !== undefined) {
    _meshesNeedRefresh = Boolean(value);
  }
  return _meshesNeedRefresh;
};

// Define a value property that can be set directly
Object.defineProperty(meshesNeedsRefresh, 'value', {
  get: function() { return _meshesNeedRefresh; },
  set: function(val) { _meshesNeedRefresh = Boolean(val); }
});

// Toggle instancing
export const toggleInstancing = (enabled) => {
  PERFORMANCE_SETTINGS.instancingEnabled = enabled;
  console.log(`Instancing set to ${enabled}`);
  return true;
};

export const getInstancingEnabled = () => PERFORMANCE_SETTINGS.instancingEnabled;

// Texture atlas settings getters/setters
export const getTextureAtlasSettings = () => TEXTURE_ATLAS_SETTINGS;

export const setTextureAtlasSetting = (setting, value) => {
  if (setting in TEXTURE_ATLAS_SETTINGS) {
    TEXTURE_ATLAS_SETTINGS[setting] = value;
    console.log(`Updated texture atlas setting: ${setting} = ${value}`);
    return true;
  }
  return false;
}; 