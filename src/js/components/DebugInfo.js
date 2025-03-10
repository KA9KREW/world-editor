import React, { useState, useEffect, useRef } from 'react';
import '../../css/DebugInfo.css';

const DebugInfo = ({ debugInfo, totalBlocks, totalEnvironmentObjects, terrainBuilderRef }) => {
  const [instancingEnabled, setInstancingEnabled] = useState(true);
  const [greedyMeshingEnabled, setGreedyMeshingEnabled] = useState(true);
  const [selectionDistance, setSelectionDistance] = useState(64); // Default to 64
  const [fps, setFps] = useState(0);
  const [frameTime, setFrameTime] = useState(0);
  const [maxFrameTime, setMaxFrameTime] = useState(0);
  const [showPerformanceDetails, setShowPerformanceDetails] = useState(false);
  const framesRef = useRef(0);
  const lastTimeRef = useRef(performance.now());
  const previousFrameTimeRef = useRef(performance.now());
  
  // Initialize state from TerrainBuilder on mount
  useEffect(() => {
    if (terrainBuilderRef && terrainBuilderRef.current) {
      setInstancingEnabled(terrainBuilderRef.current.getInstancingEnabled());
      
      if (terrainBuilderRef.current.getGreedyMeshingEnabled) {
        setGreedyMeshingEnabled(terrainBuilderRef.current.getGreedyMeshingEnabled());
      }
      
      // Initialize selection distance if available
      if (terrainBuilderRef.current.getSelectionDistance) {
        setSelectionDistance(terrainBuilderRef.current.getSelectionDistance());
      }
    }
  }, [terrainBuilderRef]);
  
  // FPS and frame time counter
  useEffect(() => {
    let frameId;
    
    const measureFps = () => {
      const now = performance.now();
      
      // Calculate frame time (time since last frame)
      const currentFrameTime = now - previousFrameTimeRef.current;
      previousFrameTimeRef.current = now;
      
      // Update frame time display (smoothed)
      setFrameTime(prev => 0.9 * prev + 0.1 * currentFrameTime);
      
      // Update max frame time (for spike detection)
      if (currentFrameTime > maxFrameTime && currentFrameTime < 1000) { // Ignore > 1s spikes (probably tab switching)
        setMaxFrameTime(currentFrameTime);
      }
      
      // Update FPS counter
      framesRef.current++;
      const elapsed = now - lastTimeRef.current;
      
      if (elapsed >= 1000) {
        // Update FPS every second
        setFps(Math.round((framesRef.current * 1000) / elapsed));
        framesRef.current = 0;
        lastTimeRef.current = now;
      }
      
      frameId = requestAnimationFrame(measureFps);
    };
    
    frameId = requestAnimationFrame(measureFps);
    
    // Set up a timer to reset max frame time every 5 seconds
    const maxTimeResetInterval = setInterval(() => {
      setMaxFrameTime(0);
    }, 5000);
    
    return () => {
      cancelAnimationFrame(frameId);
      clearInterval(maxTimeResetInterval);
    };
  }, [maxFrameTime]);

  const handleInstancingToggle = (e) => {
    const newValue = e.target.checked;
    setInstancingEnabled(newValue);
    
    if (terrainBuilderRef && terrainBuilderRef.current) {
      terrainBuilderRef.current.toggleInstancing(newValue);
    }
  };

  const handleGreedyMeshingToggle = (e) => {
    const newValue = e.target.checked;
    setGreedyMeshingEnabled(newValue);
    
    if (terrainBuilderRef && terrainBuilderRef.current) {
      terrainBuilderRef.current.toggleGreedyMeshing(newValue);
    }
  };
  
  const handleSelectionDistanceChange = (e) => {
    const newValue = parseInt(e.target.value);
    setSelectionDistance(newValue);
    
    if (terrainBuilderRef && terrainBuilderRef.current && terrainBuilderRef.current.setSelectionDistance) {
      terrainBuilderRef.current.setSelectionDistance(newValue);
    }
  };
  
  const togglePerformanceDetails = () => {
    setShowPerformanceDetails(!showPerformanceDetails);
  };
  
  const resetMaxFrameTime = () => {
    setMaxFrameTime(0);
  };

  return (
    <div className="debug-info">
      <div className="debug-row">
        <span className="debug-label">FPS:</span>
        <span className="debug-value">
          <b className={fps < 30 ? "fps-low" : fps < 50 ? "fps-medium" : "fps-high"}>
            {fps}
          </b>
        </span>
      </div>
      
      <div className="debug-row">
        <span className="debug-label">Frame Time:</span>
        <span className="debug-value">
          <b className={frameTime > 33 ? "fps-low" : frameTime > 20 ? "fps-medium" : "fps-high"}>
            {frameTime.toFixed(1)}ms
          </b>
        </span>
      </div>
      
      <div className="debug-row">
        <span className="debug-label">Max Frame:</span>
        <span className="debug-value">
          <b className={maxFrameTime > 100 ? "fps-low" : maxFrameTime > 50 ? "fps-medium" : "fps-high"}>
            {maxFrameTime.toFixed(1)}ms
          </b>
          <button className="small-button" onClick={resetMaxFrameTime} title="Reset max frame time">R</button>
        </span>
      </div>
      
      <div className="single-line"></div>
      <div className="debug-row">
        <span className="debug-label">Preview Position:</span>
        <span className="debug-value">
          x: <b>{(debugInfo?.preview?.x || 0).toFixed(1)}</b><br></br>
          y: <b>{(debugInfo?.preview?.y || 0).toFixed(1)}</b><br></br>
          z: <b>{(debugInfo?.preview?.z || 0).toFixed(1)}</b>
        </span> 
      </div>
      <div className="single-line"></div>
      <div className="debug-row">
        <span className="debug-label">Total Blocks:</span>
        <span className="debug-value">
          <b>{totalBlocks || 0}</b>
        </span>
      </div>
      <div className="single-line"></div>
      <div className="debug-row">
        <span className="debug-label">Total Env. Objects:</span>
        <span className="debug-value">
          <b>{totalEnvironmentObjects}</b>
        </span>
      </div>
      
      <div className="single-line"></div>
      <div className="debug-row performance-settings">
        <span className="debug-label" onClick={togglePerformanceDetails} style={{cursor: 'pointer'}}>
          Performance {showPerformanceDetails ? '▼' : '►'}
        </span>
        
        {showPerformanceDetails && (
          <div className="debug-value performance-toggles">
            <label className="toggle-label">
              <input 
                type="checkbox" 
                checked={instancingEnabled} 
                onChange={handleInstancingToggle}
              />
              Instanced Rendering
            </label>
            <label className="toggle-label">
              <input 
                type="checkbox" 
                checked={greedyMeshingEnabled} 
                onChange={handleGreedyMeshingToggle}
              />
              Greedy Meshing
            </label>
            
            <div className="slider-container">
              <span className="slider-label">Selection Distance: {selectionDistance}</span>
              <input
                type="range"
                min="16"
                max="128"
                step="8"
                value={selectionDistance}
                onChange={handleSelectionDistanceChange}
                className="range-slider"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default DebugInfo;
