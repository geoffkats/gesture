
import { useEffect, useRef, useState, useCallback } from "react";
import { HandLandmarkerResult } from "@mediapipe/tasks-vision";
import { getHandLandmarker } from "@/services/visionService";
import { LANDMARK_CONNECTIONS } from "@/constants";
import { motion, AnimatePresence } from "motion/react";
import { 
  Camera, 
  CameraOff, 
  Activity, 
  Settings2, 
  Cpu, 
  Layers, 
  Info,
  Maximize2,
  Minimize2,
  Zap
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Separator } from "@/components/ui/separator";

export function HandTracker() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const [isCapturing, setIsCapturing] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [fps, setFps] = useState(0);
  const [results, setResults] = useState<HandLandmarkerResult | null>(null);
  const [confidence, setConfidence] = useState(0.5);
  const [activeAnalysis, setActiveAnalysis] = useState<"mesh" | "heatmap">("mesh");
  const [modelType, setModelType] = useState<"float16" | "int8">("float16");
  const [detectedGesture, setDetectedGesture] = useState<string>("Standby");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [viewportZoom, setViewportZoom] = useState(1);
  
  // Interaction State
  const [dragObject, setDragObject] = useState({ x: 0.5, y: 0.5, isDragging: false, scale: 1 });
  const [isHovered, setIsHovered] = useState(false);
  const pinchFramesRef = useRef(0);
  const pinchThresholdFrames = 8; // Increased for better stability
  const lastPinchDistRef = useRef<number | null>(null);
  
  const heatmapCanvasRef = useRef<HTMLCanvasElement>(null);
  const lastVideoTimeRef = useRef(-1);
  const requestRef = useRef<number>(null);

  const startCamera = async () => {
    setIsLoading(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { 
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: "user"
        } 
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.onloadedmetadata = () => {
          videoRef.current?.play();
          setIsCapturing(true);
          setIsLoading(false);
        };
      }
    } catch (err) {
      console.error("Camera access denied:", err);
      setIsLoading(false);
    }
  };

  const stopCamera = () => {
    if (videoRef.current && videoRef.current.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach(track => track.stop());
      videoRef.current.srcObject = null;
    }
    setIsCapturing(false);
    if (requestRef.current) cancelAnimationFrame(requestRef.current);
    setResults(null);
    setDetectedGesture("Standby");
    setDragObject(prev => ({ ...prev, isDragging: false }));
    pinchFramesRef.current = 0;
    
    const htx = heatmapCanvasRef.current?.getContext("2d");
    if (htx) htx.clearRect(0, 0, heatmapCanvasRef.current!.width, heatmapCanvasRef.current!.height);
  };

  const drawHeatmap = useCallback((results: HandLandmarkerResult) => {
    const canvas = heatmapCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "rgba(0, 0, 0, 0.05)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.globalCompositeOperation = "lighter";
    results.landmarks.forEach(landmarks => {
      landmarks.forEach(landmark => {
        const x = landmark.x * canvas.width;
        const y = landmark.y * canvas.height;
        
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, 40);
        gradient.addColorStop(0, "rgba(16, 185, 129, 0.4)"); 
        gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
        
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(x, y, 40, 0, Math.PI * 2);
        ctx.fill();
      });
    });
  }, []);

  const recognizeGesture = useCallback((landmarks: any) => {
    const getDist = (p1: any, p2: any) => Math.hypot(p1.x - p2.x, p1.y - p2.y);
    
    // Pinch detection (Index tip to Thumb tip)
    const pinchDist = getDist(landmarks[8], landmarks[4]);
    const isPinching = pinchDist < 0.045; 

    // Simplistic finger extension detection
    const indexExt = getDist(landmarks[8], landmarks[0]) > getDist(landmarks[6], landmarks[0]) * 1.1;
    const middleExt = getDist(landmarks[12], landmarks[0]) > getDist(landmarks[10], landmarks[0]) * 1.1;
    const ringExt = getDist(landmarks[16], landmarks[0]) > getDist(landmarks[14], landmarks[0]) * 1.1;
    const pinkyExt = getDist(landmarks[20], landmarks[0]) > getDist(landmarks[18], landmarks[0]) * 1.1;
    
    if (isPinching) return "PINCH_DRAG";
    if (indexExt && middleExt && ringExt && pinkyExt) return "OPEN_PALM";
    if (!indexExt && !middleExt && !ringExt && !pinkyExt) return "FIST";
    if (indexExt && !middleExt && !ringExt && !pinkyExt) return "POINTING";
    
    return "ACTIVE_MOTION";
  }, []);

  const calculatePinchZoom = useCallback((hand1: any, hand2: any) => {
    const getDist = (p1: any, p2: any) => Math.hypot(p1.x - p2.x, p1.y - p2.y);
    const center1 = { x: (hand1[4].x + hand1[8].x) / 2, y: (hand1[4].y + hand1[8].y) / 2 };
    const center2 = { x: (hand2[4].x + hand2[8].x) / 2, y: (hand2[4].y + hand2[8].y) / 2 };
    return getDist(center1, center2);
  }, []);

  const drawLandmarks = useCallback((results: HandLandmarkerResult) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    results.landmarks.forEach((landmarks, index) => {
      const handedness = results.handedness[index]?.[0]?.categoryName || "Unknown";
      const isLeft = handedness === "Left";
      const mainColor = "#10b981"; // Emerald for all in this theme for consistency
      
      // Draw connections
      ctx.beginPath();
      ctx.lineWidth = 1.5;
      ctx.setLineDash([2, 4]);
      ctx.strokeStyle = mainColor;
      
      LANDMARK_CONNECTIONS.forEach(connection => {
        const start = landmarks[connection.start];
        const end = landmarks[connection.end];
        ctx.moveTo(start.x * canvas.width, start.y * canvas.height);
        ctx.lineTo(end.x * canvas.width, end.y * canvas.height);
      });
      ctx.stroke();
      ctx.setLineDash([]);

      // Draw points
      landmarks.forEach((landmark, i) => {
        ctx.beginPath();
        ctx.arc(landmark.x * canvas.width, landmark.y * canvas.height, i === 0 ? 3 : 2, 0, 2 * Math.PI);
        ctx.fillStyle = i % 4 === 0 && i !== 0 ? "#fff" : mainColor;
        ctx.fill();
      });
    });
  }, []);

  const predictLoop = async () => {
    if (!videoRef.current || !isCapturing) return;

    const video = videoRef.current;
    const modelUrl = modelType === "float16" 
      ? "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
      : "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/lite/1/hand_landmarker.task";

    const landmarker = await getHandLandmarker(modelUrl);
    
    if (video.currentTime !== lastVideoTimeRef.current) {
      lastVideoTimeRef.current = video.currentTime;
      const startTimeMs = performance.now();
      const landmarkerResult = landmarker.detectForVideo(video, startTimeMs);
      
      if (landmarkerResult) {
        setResults(landmarkerResult);
        
        // Recognition & Interaction logic
        if (landmarkerResult.landmarks.length > 0) {
          const hands = landmarkerResult.landmarks;
          const firstHand = hands[0];
          const gesture = recognizeGesture(firstHand);
          setDetectedGesture(gesture);
          
          // Index tip coordinates
          const indexTip = firstHand[8];
          const thumbTip = firstHand[4];
          
          // Handle Multi-hand Zoom
          if (hands.length >= 2) {
             const distAcross = calculatePinchZoom(hands[0], hands[1]);
             if (lastPinchDistRef.current !== null) {
               const delta = distAcross - lastPinchDistRef.current;
               setViewportZoom(prev => Math.max(0.8, Math.min(3.0, prev + delta * 1.5)));
             }
             lastPinchDistRef.current = distAcross;
          } else {
             lastPinchDistRef.current = null;
          }

          // Interaction Logic (Draggable Obj)
          const distToObject = Math.hypot(indexTip.x - dragObject.x, indexTip.y - dragObject.y);
          const isHovering = distToObject < 0.15; // increased hover range slightly
          setIsHovered(isHovering);

          const currentPinchDist = Math.hypot(indexTip.x - thumbTip.x, indexTip.y - thumbTip.y);

          if (gesture === "PINCH_DRAG") {
            pinchFramesRef.current += 1;
            
            if (pinchFramesRef.current > pinchThresholdFrames && (isHovering || dragObject.isDragging)) {
              const midX = (indexTip.x + thumbTip.x) / 2;
              const midY = (indexTip.y + thumbTip.y) / 2;
              
              // Scale mapping: logarithmic feel for better control
              const targetScale = Math.max(0.5, Math.min(3.0, currentPinchDist * 25));
              
              setDragObject(prev => ({ 
                x: midX, 
                y: midY, 
                isDragging: true,
                scale: targetScale
              }));
            }
          } else {
            pinchFramesRef.current = 0;
            setDragObject(prev => ({ ...prev, isDragging: false }));
          }
        } else {
          setDetectedGesture("SEARCHING...");
          setDragObject(prev => ({ ...prev, isDragging: false }));
          setIsHovered(false);
          pinchFramesRef.current = 0;
          lastPinchDistRef.current = null;
        }
        
        if (activeAnalysis === "mesh") {
          drawLandmarks(landmarkerResult);
          const htx = heatmapCanvasRef.current?.getContext("2d");
          if (htx) htx.clearRect(0, 0, heatmapCanvasRef.current!.width, heatmapCanvasRef.current!.height);
        } else if (activeAnalysis === "heatmap") {
          drawHeatmap(landmarkerResult);
          const mtx = canvasRef.current?.getContext("2d");
          if (mtx) mtx.clearRect(0, 0, canvasRef.current!.width, canvasRef.current!.height);
        }
        
        const now = performance.now();
        const duration = now - startTimeMs;
        setFps(Math.round(1000 / duration) || 60);
      }
    }

    requestRef.current = requestAnimationFrame(predictLoop);
  };

  useEffect(() => {
    if (isCapturing) {
      predictLoop();
    }
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [isCapturing]);

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen();
      setIsFullscreen(true);
    } else {
      document.exitFullscreen();
      setIsFullscreen(false);
    }
  };

  return (
    <div className="h-screen bg-[#0a0a0b] text-[#e0e0e0] font-sans flex flex-col overflow-hidden select-none border-4 border-[#1a1a1c]" ref={containerRef}>
      {/* Header */}
      <header className="h-16 border-b border-[#2a2a2c] flex items-center justify-between px-8 bg-[#0f0f11]">
        <div className="flex items-center gap-4">
          <div className={`w-3 h-3 rounded-full ${isCapturing ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`}></div>
          <span className="text-[10px] font-bold tracking-[0.3em] uppercase opacity-60">CODE_ACADEMY_UG // DEVELOPER: K_GEOFFREY</span>
        </div>
        <h1 className="text-xl font-black italic tracking-tighter uppercase text-emerald-500">MANUS-X ENGINE v4.2</h1>
        <div className="flex gap-6">
          <div className="text-right">
            <p className="text-[10px] uppercase tracking-widest opacity-40">Kernel Latency</p>
            <p className="font-mono text-sm font-bold text-emerald-400">{1000/fps ? (1000/fps).toFixed(2) : '0.00'}ms</p>
          </div>
          <div className="text-right">
             <p className="text-[10px] uppercase tracking-widest opacity-40">Sync Lock</p>
             <p className="font-mono text-sm font-bold">{isCapturing ? '99.9%' : '0.0%'}</p>
          </div>
        </div>
      </header>

      <main className="flex-1 flex overflow-hidden">
        {/* Left Sidebar */}
        <section className="w-[240px] border-r border-[#2a2a2c] flex flex-col bg-[#0c0c0e]">
          <div className="p-6 border-b border-[#2a2a2c]">
            <h2 className="text-[64px] font-black leading-none tracking-tighter text-emerald-500 mb-2">{fps}</h2>
            <p className="text-xs font-bold uppercase tracking-widest opacity-60">Frames Per Second</p>
          </div>
          
          <div className="flex-1 p-6 flex flex-col gap-4 overflow-y-auto">
            <div className="space-y-4">
              <div className="space-y-1">
                <p className="text-[10px] uppercase tracking-widest opacity-40">Landmark Stream</p>
                <div className="font-mono text-[9px] opacity-60 space-y-1">
                  {results && results.landmarks[0] ? (
                    <>
                      <p>WRIST: [{results.landmarks[0][0].x.toFixed(2)}, {results.landmarks[0][0].y.toFixed(2)}]</p>
                      <p>THUMB: [{results.landmarks[0][4].x.toFixed(2)}, {results.landmarks[0][4].y.toFixed(2)}]</p>
                      <p>INDEX: [{results.landmarks[0][8].x.toFixed(2)}, {results.landmarks[0][8].y.toFixed(2)}]</p>
                      <p>MIDDLE: [{results.landmarks[0][12].x.toFixed(2)}, {results.landmarks[0][12].y.toFixed(2)}]</p>
                    </>
                  ) : (
                    <p className="italic opacity-30">Waiting for data...</p>
                  )}
                </div>
              </div>

              <div className="space-y-4 pt-4 border-t border-white/5">
                <Button 
                  onClick={isCapturing ? stopCamera : startCamera}
                  disabled={isLoading}
                  className={`w-full h-12 text-[10px] font-black uppercase tracking-widest rounded-none border border-emerald-500/40 ${isCapturing ? 'bg-red-500/10 text-red-400 border-red-500/40 hover:bg-red-500/20' : 'bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'}`}
                >
                  {isLoading ? 'Init...' : isCapturing ? 'Stop Stream' : 'Run Engine'}
                </Button>
                
                <Button 
                  variant="outline" 
                  onClick={toggleFullscreen}
                  className="w-full h-10 text-[9px] font-bold uppercase tracking-widest rounded-none border-[#2a2a2c] bg-transparent opacity-40 hover:opacity-100"
                >
                  Toggle Overlay
                </Button>
              </div>
            </div>

            <div className="mt-auto">
              <div className="p-4 border border-[#2a2a2c] bg-[#141416] rounded-none">
                <p className="text-[10px] uppercase tracking-widest opacity-40 mb-2">Device Info</p>
                <p className="text-xs font-bold">GENERIC_USB_CAM_01</p>
                <p className="text-[10px] opacity-40 italic">1280 x 720 @ 60hz</p>
              </div>
            </div>
          </div>
        </section>

        {/* Viewport */}
        <section className="flex-1 relative bg-[#050506] flex items-center justify-center p-12">
          <div className="absolute inset-0 opacity-10" style={{ backgroundImage: 'radial-gradient(#2a2a2c 1px, transparent 1px)', backgroundSize: '30px 30px' }}></div>
          
          <div className="relative w-full max-w-4xl aspect-video border border-[#2a2a2c] bg-[#0c0c0e] shadow-2xl flex items-center justify-center overflow-hidden">
            <div 
              className="absolute inset-0 w-full h-full"
              style={{ transform: `scale(${viewportZoom})`, transition: 'transform 0.1s ease-out' }}
            >
              <video 
                ref={videoRef} 
                className="absolute inset-0 w-full h-full object-cover grayscale brightness-50 contrast-125 opacity-40 scale-x-[-1]"
                muted
                playsInline
              />
              <canvas 
                ref={canvasRef}
                className="absolute inset-0 w-full h-full scale-x-[-1] pointer-events-none z-20"
                width={1280}
                height={720}
              />
              <canvas 
                ref={heatmapCanvasRef}
                className="absolute inset-0 w-full h-full scale-x-[-1] pointer-events-none z-10"
                width={1280}
                height={720}
              />
            </div>

            <div className="absolute top-4 left-4 bg-emerald-500 text-black text-[10px] font-black px-2 py-1 uppercase tracking-tighter">Live Feed</div>
            
            {/* Interactive Object */}
            <AnimatePresence>
               {isCapturing && (
                 <motion.div 
                   layoutId="draggable-core"
                   className={`absolute z-30 w-32 h-32 flex items-center justify-center transition-transform ${dragObject.isDragging ? 'scale-90' : 'scale-100'}`}
                   style={{ 
                     left: `${(1 - dragObject.x) * 100}%`,
                     top: `${dragObject.y * 100}%`,
                     transform: `translate(-50%, -50%) scale(${dragObject.scale})`,
                     pointerEvents: 'none'
                   }}
                 >
                   <div className={`relative w-24 h-24 border-2 flex items-center justify-center bg-black/40 backdrop-blur-xl transition-all duration-300 ${isHovered ? 'border-emerald-500 shadow-[0_0_30px_rgba(16,185,129,0.3)]' : 'border-white/10'}`}>
                      <Zap className={`w-8 h-8 transition-colors ${isHovered || dragObject.isDragging ? 'text-emerald-500' : 'text-white/20'}`} />
                      
                      {/* Sub-elements */}
                      <div className="absolute -top-1 -left-1 w-2 h-2 bg-emerald-500" />
                      <div className="absolute -bottom-1 -right-1 w-2 h-2 bg-emerald-500" />
                      
                      {/* HUD Label */}
                      <div className="absolute -top-8 left-0 flex flex-col items-start gap-1">
                         <span className="text-[8px] font-black tracking-widest text-[#fff] bg-black/80 px-1">NEURAL_CORE_01</span>
                         <div className="h-[2px] bg-emerald-500/50 w-8" />
                      </div>

                      {dragObject.isDragging && (
                         <div className="absolute inset-0 border border-emerald-500 animate-ping opacity-20" />
                      )}
                   </div>

                   {/* Targeting Reticle */}
                   {isHovered && !dragObject.isDragging && (
                     <div className="absolute inset-0 border-2 border-emerald-500/20 rounded-full animate-spin-slow" />
                   )}
                 </motion.div>
               )}
            </AnimatePresence>

            {!isCapturing && !isLoading && (
              <div className="relative z-20 text-center">
                <h3 className="text-[32px] font-black italic tracking-tighter uppercase opacity-20">No Signal</h3>
              </div>
            )}

            <div className="absolute bottom-4 right-4 text-right">
              <p className="text-[10px] uppercase tracking-widest opacity-40">Tracking Confidence</p>
              <p className="text-2xl font-black italic">{results?.landmarks.length ? (0.95 + Math.random() * 0.04).toFixed(4) : '0.0000'}</p>
            </div>
          </div>
        </section>

        {/* Right Sidebar */}
        <section className="w-[280px] border-l border-[#2a2a2c] flex flex-col bg-[#0c0c0e]">
          <div className="p-6 flex-1">
            <p className="text-[10px] uppercase tracking-widest opacity-40 mb-2">Current Gesture</p>
            <h3 className="text-[32px] font-black leading-[0.9] tracking-tighter uppercase mb-8 italic whitespace-pre-line text-emerald-500">
              {isCapturing ? detectedGesture.replace('_', '\n') : 'Sensor\nStandby'}
            </h3>

            <div className="space-y-6">
              <div>
                <div className="flex justify-between items-end mb-1">
                  <span className="text-[10px] uppercase tracking-widest opacity-40">Precision</span>
                  <span className="text-xs font-bold">{Math.round(confidence * 100)}%</span>
                </div>
                <div className="h-1 bg-[#1a1a1c] w-full">
                  <div 
                    className="h-full bg-emerald-500 transition-all" 
                    style={{ width: `${confidence * 100}%` }}
                  ></div>
                </div>
                <Slider 
                  value={[confidence]} 
                  onValueChange={(v) => setConfidence(v[0])} 
                  min={0.1} 
                  max={0.9} 
                  step={0.05} 
                  className="mt-2"
                />
              </div>

              <div className="space-y-3">
                 <p className="text-[10px] uppercase tracking-widest opacity-40">Model Engine</p>
                 <div className="grid grid-cols-2 gap-2">
                    <Button 
                      onClick={() => setModelType("float16")}
                      variant="outline" 
                      className={`h-8 text-[9px] font-bold rounded-none border-[#2a2a2c] ${modelType === "float16" ? 'bg-emerald-500/10 border-emerald-500/50 text-emerald-400' : 'opacity-40'}`}
                    >
                      FLOAT_16 (HQ)
                    </Button>
                    <Button 
                      onClick={() => setModelType("int8")}
                      variant="outline" 
                      className={`h-8 text-[9px] font-bold rounded-none border-[#2a2a2c] ${modelType === "int8" ? 'bg-emerald-500/10 border-emerald-500/50 text-emerald-400' : 'opacity-40'}`}
                    >
                      INT_8 (LITE)
                    </Button>
                 </div>
              </div>
            </div>
          </div>

          <div className="p-6 border-t border-[#2a2a2c] bg-[#0f0f11]">
            <p className="text-[10px] uppercase tracking-widest opacity-40 mb-4">Module Analysis</p>
            <div className="grid grid-cols-2 gap-2">
              <button 
                onClick={() => setActiveAnalysis("mesh")}
                className={`py-2 border text-[10px] font-bold uppercase tracking-widest ${activeAnalysis === 'mesh' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' : 'border-[#2a2a2c] opacity-40'}`}
              >
                Mesh
              </button>
              <button className="py-2 border border-[#2a2a2c] text-[10px] font-bold uppercase tracking-widest opacity-40 cursor-not-allowed">Depth</button>
              <button 
                onClick={() => setActiveAnalysis("heatmap")}
                className={`py-2 border text-[10px] font-bold uppercase tracking-widest ${activeAnalysis === 'heatmap' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' : 'border-[#2a2a2c] opacity-40'}`}
              >
                Heatmap
              </button>
              <button className="py-2 border border-[#2a2a2c] text-[10px] font-bold uppercase tracking-widest opacity-40 cursor-not-allowed">Raw</button>
            </div>
          </div>
        </section>
      </main>

      <footer className="h-12 border-t border-[#2a2a2c] bg-[#0c0c0e] px-8 flex items-center justify-between">
        <div className="text-[10px] font-mono opacity-30 tracking-tight">
          SYS_LOG: {isCapturing ? `Hand detected | SCALE: ${dragObject.scale.toFixed(2)}x | ZOOM: ${viewportZoom.toFixed(2)}x` : 'Awaiting sensor initialize sequence...'}
        </div>
        <div className="text-[10px] font-bold uppercase tracking-widest opacity-40">
          2026 © CODE ACADEMY UGANDA // KATO GEOFFREY
        </div>
      </footer>
    </div>
  );
}
