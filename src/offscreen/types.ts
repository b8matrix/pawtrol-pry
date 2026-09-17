export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
  confidence?: number;
  label?: string;
  kind?: string;
  /** Which detector produced the box: "yunet", "facedetector", "heuristic", "ppocr", "dom". */
  source?: string;
}

export interface VisualDetection {
  kind: string;
  box?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  confidence: number;
  label: string;
  source?: string;
}

export interface RedactionVerification {
  verified: boolean;
  regionsChecked: number;
  regionsRedacted: number;
  leakedPatterns: string[];
  confidence: number;
  summary: string;
  timestamp: number;
  ocrRan?: boolean;
  leakedText?: string;
}

export interface PipelineTimings {
  detection: number;
  ocr: number;
  masking: number;
  verification: number;
  total: number;
}

export type ExecutionBackend = "WebGPU" | "WASM";

export interface ProcessedScreenshotResult {
  redactedDataUrl: string;
  detections: VisualDetection[];
  redactedCount: number;
  processingTimeMs: number;
  verification: RedactionVerification;
  timings: PipelineTimings;
  backend: ExecutionBackend;
}
