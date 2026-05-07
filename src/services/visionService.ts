
import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";

let handLandmarker: HandLandmarker | null = null;
let currentModelPath: string | null = null;

export const getHandLandmarker = async (modelPath?: string) => {
  const targetPath = modelPath || "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
  
  if (handLandmarker && currentModelPath === targetPath) return handLandmarker;

  // If already exists but path is different, close it first
  if (handLandmarker) {
    handLandmarker.close();
    handLandmarker = null;
  }

  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
  );

  handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: targetPath,
      delegate: "GPU"
    },
    runningMode: "VIDEO",
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });

  currentModelPath = targetPath;
  return handLandmarker;
};
