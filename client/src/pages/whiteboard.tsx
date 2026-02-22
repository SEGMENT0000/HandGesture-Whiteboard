import { useEffect, useRef, useState, useCallback } from "react";
import {
  Pencil,
  MousePointer,
  Hand,
  Eraser,
  Trash2,
  Palette,
  Undo2,
  WandSparkles,
  Settings2,
  Sun,
  Moon,
  Grid3x3,
  Ruler,
  Crosshair,
} from "lucide-react";
import { getStrokePoints } from "perfect-freehand";

type GestureState = "idle" | "drawing" | "erasing";
type InputMode = "hand" | "mouse";
type ToolMode = "draw" | "erase";
type ShapeKind = "line" | "rectangle" | "square" | "triangle" | "circle" | "ellipse" | "arrow";
type ThemePreset = "midnight" | "light" | "paper" | "ocean";

interface Point {
  x: number;
  y: number;
}

interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface Stroke {
  id?: number;
  points: Point[];
  color: string;
  width: number;
  bbox?: BBox;
  renderPoints?: Point[];
  originalPoints?: Point[];
  originalRenderPoints?: Point[];
  corrected?: boolean;
  shapeKind?: ShapeKind;
}

interface ShapeDetectionResult {
  kind: ShapeKind;
  points: Point[];
  confidence: number;
}

interface ShapePreview {
  strokeId: number;
  kind: ShapeKind;
  points: Point[];
  confidence: number;
  color: string;
  width: number;
}

declare global {
  interface Window {
    Hands: any;
    Camera: any;
  }
}

const COLORS = [
  "#f8f7f2",
  "#f72c5b",
  "#ffb347",
  "#ffe66d",
  "#29d391",
  "#1e90ff",
  "#7a5cff",
  "#ff7ac7",
];

const COLOR_NAMES: Record<string, string> = {
  "#f8f7f2": "Ivory",
  "#f72c5b": "Rose",
  "#ffb347": "Amber",
  "#ffe66d": "Lemon",
  "#29d391": "Mint",
  "#1e90ff": "Blue",
  "#7a5cff": "Indigo",
  "#ff7ac7": "Pink",
};

const THEME_PRESETS: Record<
  ThemePreset,
  {
    label: string;
    background: string;
    overlayTop: string;
    overlayLeft: string;
    overlayRight: string;
    gridColor: string;
    isDark: boolean;
  }
> = {
  midnight: {
    label: "Midnight",
    background: "#0b0c12",
    overlayTop: "rgba(84,109,255,0.18)",
    overlayLeft: "rgba(255,89,146,0.12)",
    overlayRight: "rgba(46,216,163,0.12)",
    gridColor: "rgba(255,255,255,0.05)",
    isDark: true,
  },
  light: {
    label: "Light",
    background: "#eff3fb",
    overlayTop: "rgba(84,109,255,0.12)",
    overlayLeft: "rgba(255,89,146,0.07)",
    overlayRight: "rgba(46,216,163,0.08)",
    gridColor: "rgba(20,26,40,0.06)",
    isDark: false,
  },
  paper: {
    label: "Paper",
    background: "#f4ecdc",
    overlayTop: "rgba(84,109,255,0.08)",
    overlayLeft: "rgba(215,120,92,0.08)",
    overlayRight: "rgba(59,160,120,0.08)",
    gridColor: "rgba(36,40,48,0.07)",
    isDark: false,
  },
  ocean: {
    label: "Ocean",
    background: "#07171f",
    overlayTop: "rgba(84,109,255,0.16)",
    overlayLeft: "rgba(41,167,187,0.12)",
    overlayRight: "rgba(46,216,163,0.11)",
    gridColor: "rgba(255,255,255,0.045)",
    isDark: true,
  },
};

const computeBBox = (points: Point[]): BBox => {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }

  return { minX, minY, maxX, maxY };
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const distanceBetween = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

const pathLength = (points: Point[]) => {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += distanceBetween(points[i - 1], points[i]);
  }
  return len;
};

const clonePoints = (points: Point[]) => points.map((p) => ({ x: p.x, y: p.y }));

const cloneStroke = (stroke: Stroke): Stroke => ({
  ...stroke,
  points: clonePoints(stroke.points),
  renderPoints: stroke.renderPoints ? clonePoints(stroke.renderPoints) : undefined,
  originalPoints: stroke.originalPoints ? clonePoints(stroke.originalPoints) : undefined,
  originalRenderPoints: stroke.originalRenderPoints ? clonePoints(stroke.originalRenderPoints) : undefined,
  bbox: stroke.bbox ? { ...stroke.bbox } : undefined,
});

const dedupeConsecutivePoints = (points: Point[], threshold = 0.7) => {
  if (points.length < 2) return points.slice();
  const out: Point[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    if (distanceBetween(points[i], out[out.length - 1]) >= threshold) {
      out.push(points[i]);
    }
  }
  return out;
};

const perpendicularDistance = (p: Point, a: Point, b: Point) => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const den = Math.hypot(dx, dy);
  if (den < 1e-6) return distanceBetween(p, a);
  const num = Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x);
  return num / den;
};

const douglasPeucker = (points: Point[], epsilon: number): Point[] => {
  if (points.length < 3) return points.slice();

  let maxDist = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], points[0], points[points.length - 1]);
    if (d > maxDist) {
      maxDist = d;
      index = i;
    }
  }

  if (maxDist > epsilon) {
    const left = douglasPeucker(points.slice(0, index + 1), epsilon);
    const right = douglasPeucker(points.slice(index), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [points[0], points[points.length - 1]];
};

const polygonArea = (points: Point[]) => {
  if (points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    sum += p.x * q.y - q.x * p.y;
  }
  return Math.abs(sum) * 0.5;
};

const pointToSegmentDistance = (p: Point, a: Point, b: Point) => {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = p.x - a.x;
  const apy = p.y - a.y;
  const abLen2 = abx * abx + aby * aby;
  if (abLen2 < 1e-8) return Math.hypot(apx, apy);
  const t = clamp((apx * abx + apy * aby) / abLen2, 0, 1);
  const qx = a.x + abx * t;
  const qy = a.y + aby * t;
  return Math.hypot(p.x - qx, p.y - qy);
};

const meanDistanceToPolyline = (points: Point[], polyline: Point[]) => {
  if (points.length === 0 || polyline.length < 2) return Number.POSITIVE_INFINITY;
  let total = 0;
  for (const p of points) {
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < polyline.length - 1; i++) {
      const d = pointToSegmentDistance(p, polyline[i], polyline[i + 1]);
      if (d < best) best = d;
    }
    total += best;
  }
  return total / points.length;
};

const estimateCornerCount = (points: Point[], minTurnRad = 0.58, minEdge = 8) => {
  if (points.length < 3) return 0;
  let count = 0;
  for (let i = 0; i < points.length; i++) {
    const prev = points[(i - 1 + points.length) % points.length];
    const curr = points[i];
    const next = points[(i + 1) % points.length];

    const v1x = curr.x - prev.x;
    const v1y = curr.y - prev.y;
    const v2x = next.x - curr.x;
    const v2y = next.y - curr.y;
    const d1 = Math.hypot(v1x, v1y);
    const d2 = Math.hypot(v2x, v2y);
    if (d1 < minEdge || d2 < minEdge) continue;

    const cos = clamp((v1x * v2x + v1y * v2y) / (d1 * d2), -1, 1);
    const turn = Math.PI - Math.acos(cos);
    if (turn >= minTurnRad) count++;
  }
  return count;
};

const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

const convexHull = (points: Point[]): Point[] => {
  if (points.length < 3) return points.slice();
  const pts = points
    .slice()
    .sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));

  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  upper.pop();
  lower.pop();
  return lower.concat(upper);
};

const sortClockwise = (points: Point[]) => {
  const center = {
    x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
    y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
  };
  return points
    .slice()
    .sort(
      (a, b) =>
        Math.atan2(a.y - center.y, a.x - center.x) -
        Math.atan2(b.y - center.y, b.x - center.x),
    );
};

const buildEllipsePoints = (cx: number, cy: number, rx: number, ry: number, segments: number) => {
  const out: Point[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    out.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) });
  }
  return out;
};

const preprocessShapePoints = (rawPoints: Point[]) => {
  const deduped = dedupeConsecutivePoints(rawPoints, 0.8);
  if (deduped.length < 6) return deduped;

  const pfInput = deduped.map((p) => [p.x, p.y] as [number, number]);
  const strokePoints = getStrokePoints(pfInput, {
    size: 8,
    thinning: 0,
    smoothing: 0.45,
    streamline: 0.35,
    simulatePressure: false,
  });

  const out: Point[] = [];
  for (let i = 0; i < strokePoints.length; i++) {
    const pt = strokePoints[i].point;
    const next = { x: pt[0], y: pt[1] };
    if (out.length === 0 || distanceBetween(next, out[out.length - 1]) > 0.8) {
      out.push(next);
    }
  }
  return out.length >= 6 ? out : deduped;
};

class OneEuroFilter {
  private minCutoff: number;
  private beta: number;
  private dCutoff: number;

  private xHat = 0;
  private dxHat = 0;
  private tPrev: number | null = null;
  private initialized = false;

  constructor(options?: { minCutoff?: number; beta?: number; dCutoff?: number }) {
    this.minCutoff = options?.minCutoff ?? 1.0;
    this.beta = options?.beta ?? 0.02;
    this.dCutoff = options?.dCutoff ?? 1.0;
  }

  reset(x: number, tMs: number) {
    this.xHat = x;
    this.dxHat = 0;
    this.tPrev = tMs;
    this.initialized = true;
  }

  filter(x: number, tMs: number) {
    if (!this.initialized || this.tPrev === null) {
      this.reset(x, tMs);
      return x;
    }

    const dt = clamp((tMs - this.tPrev) / 1000, 1 / 240, 0.5);
    const dx = (x - this.xHat) / dt;

    // Filter the derivative to estimate velocity.
    const aD = this.alpha(this.dCutoff, dt);
    this.dxHat = aD * dx + (1 - aD) * this.dxHat;

    // Adapt cutoff based on speed (less lag when moving fast).
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dxHat);
    const aX = this.alpha(cutoff, dt);
    this.xHat = aX * x + (1 - aX) * this.xHat;

    this.tPrev = tMs;
    return this.xHat;
  }

  private alpha(cutoff: number, dt: number) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
}


export default function Whiteboard() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const mainCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  
  const [gestureState, setGestureState] = useState<GestureState>("idle");
  const [cursorPosition, setCursorPosition] = useState<Point | null>(null);
  const [isHandDetected, setIsHandDetected] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [currentColor, setCurrentColor] = useState(COLORS[0]);
  const [recentColors, setRecentColors] = useState<string[]>([COLORS[0]]);
  const [paletteHoverColor, setPaletteHoverColor] = useState<string | null>(null);
  const [hoveredColorIndex, setHoveredColorIndex] = useState<number | null>(null);
  const [currentWidth, setCurrentWidth] = useState(4);
  const [hideInstructions, setHideInstructions] = useState(false);
  const [inputMode, setInputMode] = useState<InputMode>("hand");
  const [tool, setTool] = useState<ToolMode>("draw");
  const [isMobile, setIsMobile] = useState(false);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [smoothingLevel, setSmoothingLevel] = useState(8); // 0..10
  const smoothingRef = useRef(smoothingLevel);
  const [widthDynamics, setWidthDynamics] = useState(0.25); // 0..1
  const widthDynamicsRef = useRef(widthDynamics);
  const [shapeAssistEnabled, setShapeAssistEnabled] = useState(true);
  const shapeAssistEnabledRef = useRef(shapeAssistEnabled);
  const [shapeSensitivity, setShapeSensitivity] = useState(0.62); // 0..1
  const shapeSensitivityRef = useRef(shapeSensitivity);
  const [predictionMs, setPredictionMs] = useState(14); // 0..24
  const predictionMsRef = useRef(predictionMs);
  const [showGrid, setShowGrid] = useState(true);
  const [showRulers, setShowRulers] = useState(false);
  const [showCenterGuides, setShowCenterGuides] = useState(false);
  const [themePreset, setThemePreset] = useState<ThemePreset>(() => {
    const saved = typeof window !== "undefined" ? window.localStorage.getItem("x_whiteboard_theme_v1") : null;
    return saved && saved in THEME_PRESETS ? (saved as ThemePreset) : "midnight";
  });
  const [canUndo, setCanUndo] = useState(false);

  const strokesRef = useRef<Stroke[]>([]);
  const currentStrokeRef = useRef<Point[]>([]);
  const currentRenderStrokeRef = useRef<Point[]>([]);
  const currentWidthRef = useRef(4);
  const currentColorRef = useRef(COLORS[0]);
  const dprRef = useRef(1);
  const sizeRef = useRef({ width: 0, height: 0 });
  const offsetRef = useRef({ left: 0, top: 0 });
  const lastPointRef = useRef<Point | null>(null);
  const strokeFilterRef = useRef<{ x: OneEuroFilter; y: OneEuroFilter } | null>(null);
  const lastPointTimeRef = useRef<number | null>(null);
  const isDrawingRef = useRef(false);
  const gestureStateRef = useRef<GestureState>("idle");
  const animationFrameRef = useRef<number | null>(null);
  const drawPendingRef = useRef(false);
  const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const offscreenCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const baseDirtyRef = useRef(true);
  const colorHoverTimeRef = useRef<number>(0);
  const lastColorIndexRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number>(0);
  const frameSkipRef = useRef<number>(0);
  const cursorRafRef = useRef<number | null>(null);
  const pendingCursorRef = useRef<Point | null>(null);
  const cursorPositionRef = useRef<Point | null>(null);
  const predictedPointRef = useRef<Point | null>(null);
  const lastCursorCommitTimeRef = useRef<number>(0);
  const themePresetRef = useRef<ThemePreset>(themePreset);
  const pinchActiveRef = useRef(false);
  const handSendBusyRef = useRef(false);
  const handInferenceIntervalRef = useRef(50);
  const handSendCostMsRef = useRef(50);
  const handResultsHandlerRef = useRef<(results: any) => void>(() => {});
  const mediaPipeLoadPromiseRef = useRef<Promise<void> | null>(null);
  const isHandDetectedRef = useRef(false);
  const hideInstructionsRef = useRef(false);
  const hoveredColorIndexRef = useRef<number | null>(null);
  const liveSmoothCounterRef = useRef(0);
  const lastHandSeenTimeRef = useRef(0);
  const lastHandSendAtRef = useRef(0);
  const shapeDetectionTimerRef = useRef<number | null>(null);
  const shapePreviewTimerRef = useRef<number | null>(null);
  const shapeIdleHandleRef = useRef<number | null>(null);
  const shapePreviewRef = useRef<ShapePreview | null>(null);
  const strokeIdCounterRef = useRef(1);
  const shapeDetectionCacheRef = useRef<Map<number, ShapeDetectionResult | null>>(new Map());
  const shiftPressedRef = useRef(false);
  const disableShapeForStrokeRef = useRef(false);
  const eraseSessionActiveRef = useRef(false);
  const historyPastRef = useRef<Stroke[][]>([]);
  const historyFutureRef = useRef<Stroke[][]>([]);

  const MIN_WIDTH = 2;
  const MAX_WIDTH = 12;
  const DEFAULT_BACKGROUND = THEME_PRESETS.midnight.background;
  const COLOR_HOVER_DURATION = 600;
  const ERASE_RADIUS = 25;
  const FRAME_SKIP = 1;
  const MAX_SEGMENT = 5.1;
  const MAX_INTERPOLATION_STEPS = 7;
  const HAND_INFERENCE_INTERVAL_MS = 50;
  const PINCH_ON = 0.09;
  const PINCH_OFF = 0.115;
  const MICRO_MOVEMENT = 0.62;
  const SHAPE_DETECTION_DELAY_MS = 500;
  const SHAPE_PREVIEW_MS = 240;
  const HISTORY_LIMIT = 100;

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768);
    };
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  useEffect(() => {
    smoothingRef.current = smoothingLevel;
    strokeFilterRef.current = null;
  }, [smoothingLevel]);

  useEffect(() => {
    widthDynamicsRef.current = widthDynamics;
  }, [widthDynamics]);

  useEffect(() => {
    shapeAssistEnabledRef.current = shapeAssistEnabled;
  }, [shapeAssistEnabled]);

  useEffect(() => {
    shapeSensitivityRef.current = shapeSensitivity;
  }, [shapeSensitivity]);

  useEffect(() => {
    predictionMsRef.current = predictionMs;
  }, [predictionMs]);

  useEffect(() => {
    currentColorRef.current = currentColor;
  }, [currentColor]);

  useEffect(() => {
    currentWidthRef.current = currentWidth;
  }, [currentWidth]);

  useEffect(() => {
    isHandDetectedRef.current = isHandDetected;
  }, [isHandDetected]);

  useEffect(() => {
    hideInstructionsRef.current = hideInstructions;
  }, [hideInstructions]);

  useEffect(() => {
    hoveredColorIndexRef.current = hoveredColorIndex;
  }, [hoveredColorIndex]);

  const setGestureStateIfChanged = useCallback((next: GestureState) => {
    if (gestureStateRef.current === next) return;
    gestureStateRef.current = next;
    setGestureState(next);
  }, []);

  const selectColor = useCallback((next: string) => {
    setCurrentColor(next);
    currentColorRef.current = next;
    setRecentColors((prev) => {
      const without = prev.filter((c) => c !== next);
      return [next, ...without].slice(0, 10);
    });
  }, []);



  const PALETTE_SIZE = isMobile ? 30 : 42;
  const PALETTE_GAP = isMobile ? 6 : 10;
  const paletteRows = Math.ceil(COLORS.length / 4);
  const paletteWidth = (4 * PALETTE_SIZE) + (3 * PALETTE_GAP);
  const paletteHeight = (paletteRows * PALETTE_SIZE) + ((paletteRows - 1) * PALETTE_GAP) + (inputMode === "mouse" ? 48 : 0) + 18;

  const getPalettePosition = useCallback(() => {
    const x = Math.max(16, (containerSize.width - paletteWidth) / 2);
    const y = Math.max(16, containerSize.height - paletteHeight - 132);
    return { x, y };
  }, [containerSize.height, containerSize.width, paletteHeight, paletteWidth]);

  const getPinchDistance = useCallback((landmarks: any[]): number => {
    if (!landmarks || landmarks.length < 9) return 0.03;
    const thumbTip = landmarks[4];
    const indexTip = landmarks[8];
    return Math.sqrt(
      Math.pow(thumbTip.x - indexTip.x, 2) +
      Math.pow(thumbTip.y - indexTip.y, 2)
    );
  }, []);

  const isPinching = useCallback((landmarks: any[]) => {
    const distance = getPinchDistance(landmarks);
    if (distance < PINCH_ON) {
      pinchActiveRef.current = true;
    } else if (distance > PINCH_OFF) {
      pinchActiveRef.current = false;
    }
    return pinchActiveRef.current;
  }, [getPinchDistance]);

  const isNearPalette = useCallback((point: Point): number | null => {
    if (!paletteOpen) return null;
    const palettePos = getPalettePosition();
    for (let i = 0; i < COLORS.length; i++) {
      const colorX = palettePos.x + (i % 4) * (PALETTE_SIZE + PALETTE_GAP) + PALETTE_SIZE / 2;
      const colorY = palettePos.y + Math.floor(i / 4) * (PALETTE_SIZE + PALETTE_GAP) + PALETTE_SIZE / 2;
      const distance = Math.sqrt(
        Math.pow(point.x - colorX, 2) +
        Math.pow(point.y - colorY, 2)
      );
      if (distance < PALETTE_SIZE / 2 + 15) {
        return i;
      }
    }
    return null;
  }, [getPalettePosition, PALETTE_SIZE, PALETTE_GAP, paletteOpen]);

  const drawSpline = (ctx: CanvasRenderingContext2D, points: Point[]) => {
    if (points.length < 2) return;

    // Use Catmull-Rom to Bezier conversion for smooth curves that pass through points.
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);

    if (points.length === 2) {
      ctx.lineTo(points[1].x, points[1].y);
      return;
    }

    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i - 1] ?? points[i];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[i + 2] ?? p2;

      // Catmull-Rom to Bezier conversion (centripetal-like with tension=1/6)
      const c1x = p1.x + (p2.x - p0.x) / 6;
      const c1y = p1.y + (p2.y - p0.y) / 6;
      const c2x = p2.x - (p3.x - p1.x) / 6;
      const c2y = p2.y - (p3.y - p1.y) / 6;

      ctx.bezierCurveTo(c1x, c1y, c2x, c2y, p2.x, p2.y);
    }
  };

  const drawPolyline = (ctx: CanvasRenderingContext2D, points: Point[]) => {
    if (points.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
  };


  const downsamplePoints = (points: Point[], maxPoints: number) => {
    if (points.length <= maxPoints) return points;
    const stride = Math.ceil(points.length / maxPoints);
    const out: Point[] = [];
    for (let i = 0; i < points.length; i += stride) {
      out.push(points[i]);
    }
    if (out[out.length - 1] !== points[points.length - 1]) {
      out.push(points[points.length - 1]);
    }
    return out;
  };

  const movingAveragePoints = (points: Point[], radius: number): Point[] => {
    if (points.length < 3 || radius <= 0) return points;
    const out: Point[] = [];
    for (let i = 0; i < points.length; i++) {
      let sx = 0;
      let sy = 0;
      let count = 0;
      const from = Math.max(0, i - radius);
      const to = Math.min(points.length - 1, i + radius);
      for (let j = from; j <= to; j++) {
        sx += points[j].x;
        sy += points[j].y;
        count++;
      }
      out.push({ x: sx / count, y: sy / count });
    }
    return out;
  };

  const smoothForLive = (points: Point[]) => {
    if (points.length < 3) return points;

    const level = smoothingRef.current; // 0..10
    const maxPoints = Math.round(90 + level * 10); // 90..190
    const radius = level >= 8 ? 2 : 1;
    const spaced = downsamplePoints(points, maxPoints);
    const pass1 = movingAveragePoints(spaced, radius);
    return movingAveragePoints(pass1, radius);
  };

  const smoothForRender = (points: Point[]) => {
    if (points.length < 3) return points;

    const level = smoothingRef.current; // 0..10
    const passes = level >= 8 ? 2 : 1;
    let output = points.slice();
    for (let i = 0; i < passes; i++) {
      output = movingAveragePoints(output, 1);
    }

    // Keep density high; apply at most one light corner pass.
    if (level >= 7 && output.length >= 6) {
      const cap = Math.min(2200, output.length * 2 + 2);
      output = chaikin(output, 1, cap);
    }

    return output;
  };

  const finalizeRenderPoints = (rawPoints: Point[], livePoints: Point[]) => {
    if (livePoints.length > 1) {
      let output = clonePoints(livePoints);
      if (output.length >= 6) {
        // One ultra-light cleanup pass to avoid commit-time corner artifacts.
        output = movingAveragePoints(output, 1);
      }
      return output;
    }
    return smoothForRender(rawPoints);
  };

  // Chaikin corner-cutting smoothing (with optional point cap for performance)
  const chaikin = (pts: Point[], iterations: number, maxPoints?: number) => {
    if (!pts || pts.length < 2) return pts;
    let output = pts.slice();
    const cap = maxPoints ?? Number.POSITIVE_INFINITY;

    for (let it = 0; it < iterations; it++) {
      const next: Point[] = [];
      next.push(output[0]);
      for (let i = 0; i < output.length - 1; i++) {
        const p0 = output[i];
        const p1 = output[i + 1];
        const q = { x: 0.75 * p0.x + 0.25 * p1.x, y: 0.75 * p0.y + 0.25 * p1.y };
        const r = { x: 0.25 * p0.x + 0.75 * p1.x, y: 0.25 * p0.y + 0.75 * p1.y };
        next.push(q, r);
      }
      next.push(output[output.length - 1]);
      output = next.length > cap ? downsamplePoints(next, cap) : next;
    }

    return output;
  };

  const createStrokeFilters = () => {
    const level = smoothingRef.current / 10;
    const minCutoff = clamp(0.78 - level * 0.55, 0.14, 0.78);
    const beta = clamp(0.055 - level * 0.04, 0.008, 0.055);
    return {
      x: new OneEuroFilter({ minCutoff, beta, dCutoff: 1.0 }),
      y: new OneEuroFilter({ minCutoff, beta, dCutoff: 1.0 }),
    };
  };

  const detectAutoShape = useCallback((rawPoints: Point[], sensitivity: number): ShapeDetectionResult | null => {
    const points = preprocessShapePoints(rawPoints);
    if (points.length < 6) return null;

    const bbox = computeBBox(points);
    const width = Math.max(1, bbox.maxX - bbox.minX);
    const height = Math.max(1, bbox.maxY - bbox.minY);
    const diag = Math.hypot(width, height);
    if (diag < 36) return null;

    const start = points[0];
    const end = points[points.length - 1];
    const closeDistance = distanceBetween(start, end);
    const closeTol = Math.max(20, diag * (0.22 + (1 - sensitivity) * 0.12));
    const closed = closeDistance <= closeTol;

    const strokeLen = pathLength(points);
    const candidates: ShapeDetectionResult[] = [];
    const minConfidence = clamp(0.48 + sensitivity * 0.24, 0.48, 0.72);

    const directLen = Math.max(1, distanceBetween(start, end));
    const straightness = strokeLen / directLen;
    let maxDist = 0;
    let totalDist = 0;
    for (const p of points) {
      const d = perpendicularDistance(p, start, end);
      if (d > maxDist) maxDist = d;
      totalDist += d;
    }
    const meanDist = totalDist / points.length;
    const lineFit = clamp(
      1 - meanDist / Math.max(3, diag * (0.04 + (1 - sensitivity) * 0.03)),
      0,
      1,
    );
    const lineStraight = clamp(1 - (straightness - 1) / 0.45, 0, 1);
    const lineConf = lineFit * 0.65 + lineStraight * 0.35;
    if (!closed && lineConf >= 0.46 && maxDist < Math.max(10, diag * 0.18)) {
      candidates.push({ kind: "line", points: [start, end], confidence: lineConf });
    }

    if (!closed) {
      const simplified = douglasPeucker(points, Math.max(2.5, diag * 0.03));
      if (simplified.length >= 4) {
        const tip = simplified[simplified.length - 1];
        const wingA = simplified[simplified.length - 2];
        const wingB = simplified[simplified.length - 3];
        const shaftStart = simplified[0];
        const headA = distanceBetween(tip, wingA);
        const headB = distanceBetween(tip, wingB);
        const shaftLen = distanceBetween(shaftStart, tip);
        const v1x = wingA.x - tip.x;
        const v1y = wingA.y - tip.y;
        const v2x = wingB.x - tip.x;
        const v2y = wingB.y - tip.y;
        const den = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
        const angleDeg =
          den > 1e-6 ? (Math.acos(clamp((v1x * v2x + v1y * v2y) / den, -1, 1)) * 180) / Math.PI : 0;
        const headMid = { x: (wingA.x + wingB.x) * 0.5, y: (wingA.y + wingB.y) * 0.5 };
        const midShaftDist = pointToSegmentDistance(headMid, shaftStart, tip);
        const arrowFit =
          clamp(1 - Math.abs(angleDeg - 62) / 52, 0, 1) * 0.45 +
          clamp(1 - midShaftDist / Math.max(5, diag * 0.1), 0, 1) * 0.3 +
          clamp(1 - meanDist / Math.max(4, diag * 0.06), 0, 1) * 0.25;
        if (
          headA > diag * 0.04 &&
          headB > diag * 0.04 &&
          headA < shaftLen * 0.65 &&
          headB < shaftLen * 0.65 &&
          shaftLen > diag * 0.35 &&
          arrowFit >= 0.56
        ) {
          candidates.push({
            kind: "arrow",
            points: [shaftStart, tip, wingA, tip, wingB],
            confidence: arrowFit,
          });
        }
      }
    }

    if (closed) {
      let body = points.slice();
      if (distanceBetween(body[0], body[body.length - 1]) < Math.max(8, diag * 0.05)) {
        body = body.slice(0, -1);
      }
      if (body.length >= 5) {
        const loop = [...body, body[0]];
        const area = polygonArea(body);
        const fillRatio = area / Math.max(width * height, 1);
        const perimeter = pathLength(loop);
        const compactness = (4 * Math.PI * area) / Math.max(perimeter * perimeter, 1);

        const simplified = douglasPeucker(
          body.concat(body[0]),
          Math.max(1.8, diag * (0.017 + (1 - sensitivity) * 0.02)),
        );
        let simplifiedClosed = simplified;
        if (simplifiedClosed.length > 1) {
          const first = simplifiedClosed[0];
          const last = simplifiedClosed[simplifiedClosed.length - 1];
          if (distanceBetween(first, last) < Math.max(4, diag * 0.03)) {
            simplifiedClosed = simplifiedClosed.slice(0, -1);
          }
        }
        const corners = estimateCornerCount(
          simplifiedClosed.length >= 3 ? simplifiedClosed : body,
          0.5,
          Math.max(6, diag * 0.045),
        );

        const rectPoints = [
          { x: bbox.minX, y: bbox.minY },
          { x: bbox.maxX, y: bbox.minY },
          { x: bbox.maxX, y: bbox.maxY },
          { x: bbox.minX, y: bbox.maxY },
          { x: bbox.minX, y: bbox.minY },
        ];
        const rectErr = meanDistanceToPolyline(body, rectPoints) / Math.max(diag, 1);
        const rectConf =
          clamp(1 - rectErr / (0.19 + (1 - sensitivity) * 0.16), 0, 1) * 0.62 +
          clamp(1 - Math.abs(fillRatio - 0.72) / 0.48, 0, 1) * 0.18 +
          clamp(1 - Math.abs(corners - 4) / 4, 0, 1) * 0.2;
        if (rectConf >= 0.42) {
          const ratio = width / Math.max(height, 1);
          const squareConf = rectConf * clamp(1 - Math.abs(1 - ratio) / (0.22 + (1 - sensitivity) * 0.24), 0, 1);
          if (squareConf >= rectConf - 0.05 && squareConf >= 0.46) {
            candidates.push({ kind: "square", points: rectPoints, confidence: squareConf });
          } else {
            candidates.push({ kind: "rectangle", points: rectPoints, confidence: rectConf });
          }
        }

        const hull = convexHull(body);
        let triangleBase: Point[] | null = null;
        if (hull.length === 3) {
          triangleBase = sortClockwise(hull);
        } else if (hull.length > 3) {
          let a = hull[0];
          let b = hull[1];
          let maxAB = 0;
          for (let i = 0; i < hull.length; i++) {
            for (let j = i + 1; j < hull.length; j++) {
              const d = distanceBetween(hull[i], hull[j]);
              if (d > maxAB) {
                maxAB = d;
                a = hull[i];
                b = hull[j];
              }
            }
          }
          let c = hull[0];
          let maxArea2 = -1;
          for (const p of hull) {
            const area2 = Math.abs(cross(a, b, p));
            if (area2 > maxArea2) {
              maxArea2 = area2;
              c = p;
            }
          }
          triangleBase = sortClockwise([a, b, c]);
        }

        if (triangleBase) {
          const triangleClosed = [triangleBase[0], triangleBase[1], triangleBase[2], triangleBase[0]];
          const triangleErr = meanDistanceToPolyline(body, triangleClosed) / Math.max(diag, 1);
          const triangleConf =
            clamp(1 - triangleErr / (0.23 + (1 - sensitivity) * 0.2), 0, 1) * 0.65 +
            clamp(1 - Math.abs(fillRatio - 0.5) / 0.45, 0, 1) * 0.2 +
            clamp(1 - Math.abs(corners - 3) / 3, 0, 1) * 0.15;
          if (triangleConf >= 0.42) {
            candidates.push({ kind: "triangle", points: triangleClosed, confidence: triangleConf });
          }
        }

        const cx = body.reduce((sum, p) => sum + p.x, 0) / body.length;
        const cy = body.reduce((sum, p) => sum + p.y, 0) / body.length;
        const distances = body.map((p) => Math.hypot(p.x - cx, p.y - cy));
        const meanRadius = distances.reduce((sum, d) => sum + d, 0) / distances.length;
        const variance =
          distances.reduce((sum, d) => {
            const diff = d - meanRadius;
            return sum + diff * diff;
          }, 0) / distances.length;
        const stdNorm = Math.sqrt(variance) / Math.max(meanRadius, 1);

        const rx = width * 0.5;
        const ry = height * 0.5;
        let radialErr = Number.POSITIVE_INFINITY;
        if (rx > 8 && ry > 8) {
          let sum = 0;
          for (const p of body) {
            const nx = (p.x - (bbox.minX + rx)) / rx;
            const ny = (p.y - (bbox.minY + ry)) / ry;
            sum += Math.abs(Math.hypot(nx, ny) - 1);
          }
          radialErr = sum / body.length;
        }

        const aspect = width / Math.max(height, 1);
        const circleConf =
          clamp(1 - stdNorm / (0.22 + (1 - sensitivity) * 0.16), 0, 1) * 0.55 +
          clamp(1 - Math.abs(aspect - 1) / (0.2 + (1 - sensitivity) * 0.3), 0, 1) * 0.2 +
          clamp((compactness - 0.45) / 0.5, 0, 1) * 0.25;
        if (circleConf >= 0.45) {
          const r = (rx + ry) * 0.5;
          candidates.push({
            kind: "circle",
            points: buildEllipsePoints(bbox.minX + rx, bbox.minY + ry, r, r, 72),
            confidence: circleConf,
          });
        }

        const ellipseConf =
          clamp(1 - radialErr / (0.23 + (1 - sensitivity) * 0.22), 0, 1) * 0.7 +
          clamp((compactness - 0.32) / 0.55, 0, 1) * 0.3;
        if (ellipseConf >= 0.46) {
          candidates.push({
            kind: "ellipse",
            points: buildEllipsePoints(bbox.minX + rx, bbox.minY + ry, rx, ry, 72),
            confidence: ellipseConf,
          });
        }
      }
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => b.confidence - a.confidence);
    const best = candidates[0];
    if (best.confidence < minConfidence) return null;
    if (candidates.length > 1) {
      const second = candidates[1];
      const confidenceGap = best.confidence - second.confidence;
      const requiredGap = 0.07 + (1 - sensitivity) * 0.05;
      if (confidenceGap < requiredGap && best.confidence < minConfidence + 0.12) {
        return null;
      }
    }
    return best;
  }, []);



  const drawCanvas = useCallback(() => {
    const offscreenCanvas = offscreenCanvasRef.current;
    const offscreenCtx = offscreenCtxRef.current;
    const ctx = mainCtxRef.current;
    if (!ctx) return;
    if (!offscreenCanvas || !offscreenCtx) return;

    const dpr = dprRef.current || 1;

    // Re-render the base layer (all committed strokes) only when it changes.
    if (baseDirtyRef.current) {
      const theme = THEME_PRESETS[themePresetRef.current] ?? THEME_PRESETS.midnight;
      offscreenCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      offscreenCtx.fillStyle = theme.background || DEFAULT_BACKGROUND;
      offscreenCtx.fillRect(0, 0, sizeRef.current.width, sizeRef.current.height);

      offscreenCtx.lineCap = "round";
      offscreenCtx.lineJoin = "round";

      for (const stroke of strokesRef.current) {
        if (stroke.points.length < 2) continue;
        const renderPoints =
          stroke.renderPoints ??
          (stroke.renderPoints = stroke.corrected ? stroke.points : smoothForRender(stroke.points));

        offscreenCtx.strokeStyle = stroke.color;
        offscreenCtx.lineWidth = stroke.width;
        if (stroke.corrected) {
          drawPolyline(offscreenCtx, renderPoints);
        } else {
          drawSpline(offscreenCtx, renderPoints);
        }
        offscreenCtx.stroke();
      }

      baseDirtyRef.current = false;
    }

    // Copy base layer to screen.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(offscreenCanvas, 0, 0);

    // Draw current in-progress stroke on top.
    const currentStroke = currentStrokeRef.current;
    const renderCurrent = currentRenderStrokeRef.current;
    if (renderCurrent.length === 1) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = currentColorRef.current;
      ctx.beginPath();
      ctx.arc(currentStroke[0].x, currentStroke[0].y, currentWidthRef.current / 2, 0, Math.PI * 2);
      ctx.fill();
    } else if (renderCurrent.length > 1) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = currentColorRef.current;
      ctx.lineWidth = currentWidthRef.current;

      const livePoints = renderCurrent.length > 260 ? downsamplePoints(renderCurrent, 260) : renderCurrent;
      drawSpline(ctx, livePoints);
      ctx.stroke();

      const predicted = predictedPointRef.current;
      if (predicted) {
        const tail = livePoints[livePoints.length - 1];
        if (tail) {
          ctx.beginPath();
          ctx.globalAlpha = 0.35;
          ctx.moveTo(tail.x, tail.y);
          ctx.lineTo(predicted.x, predicted.y);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
    }

    const preview = shapePreviewRef.current;
    if (preview) {
      const now = performance.now();
      const pulse = 0.4 + 0.35 * (0.5 + 0.5 * Math.sin(now / 90));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = `rgba(255,255,255,${0.82 + pulse * 0.16})`;
      ctx.lineWidth = Math.max(2.5, preview.width * 1.03);
      ctx.shadowBlur = 16;
      ctx.shadowColor = `rgba(84,109,255,${0.35 + pulse * 0.2})`;
      ctx.setLineDash([12, 8]);
      ctx.lineDashOffset = -((now / 28) % 40);
      drawPolyline(ctx, preview.points);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
      ctx.shadowBlur = 0;
      ctx.shadowColor = "transparent";
    }
  }, []);

  const scheduleDraw = useCallback(() => {
    if (drawPendingRef.current) return;
    drawPendingRef.current = true;
    animationFrameRef.current = requestAnimationFrame(() => {
      drawPendingRef.current = false;
      drawCanvas();
      if (shapePreviewRef.current) {
        scheduleDraw();
      }
    });
  }, [drawCanvas]);

  useEffect(() => {
    themePresetRef.current = themePreset;
    window.localStorage.setItem("x_whiteboard_theme_v1", themePreset);
    baseDirtyRef.current = true;
    scheduleDraw();
  }, [themePreset, scheduleDraw]);

  const updateHistoryFlags = useCallback(() => {
    setCanUndo(historyPastRef.current.length > 0);
  }, []);

  const cloneStrokeList = useCallback((list: Stroke[]) => {
    const out: Stroke[] = new Array(list.length);
    for (let i = 0; i < list.length; i++) {
      out[i] = cloneStroke(list[i]);
    }
    return out;
  }, []);

  const restoreSnapshot = useCallback((snapshot: Stroke[]) => {
    strokesRef.current = cloneStrokeList(snapshot);
    currentStrokeRef.current = [];
    currentRenderStrokeRef.current = [];
    predictedPointRef.current = null;
    liveSmoothCounterRef.current = 0;
    lastPointRef.current = null;
    strokeFilterRef.current = null;
    isDrawingRef.current = false;
    disableShapeForStrokeRef.current = false;
    eraseSessionActiveRef.current = false;
    setGestureStateIfChanged("idle");
    shapeDetectionCacheRef.current.clear();
    shapePreviewRef.current = null;
    baseDirtyRef.current = true;
    scheduleDraw();
    updateHistoryFlags();
  }, [cloneStrokeList, scheduleDraw, setGestureStateIfChanged, updateHistoryFlags]);

  const pushUndoSnapshot = useCallback(() => {
    historyPastRef.current.push(cloneStrokeList(strokesRef.current));
    if (historyPastRef.current.length > HISTORY_LIMIT) {
      historyPastRef.current.shift();
    }
    historyFutureRef.current = [];
    updateHistoryFlags();
  }, [HISTORY_LIMIT, cloneStrokeList, updateHistoryFlags]);

  const undoLastAction = useCallback(() => {
    const previous = historyPastRef.current.pop();
    if (!previous) return;

    historyFutureRef.current.push(cloneStrokeList(strokesRef.current));
    restoreSnapshot(previous);
  }, [cloneStrokeList, restoreSnapshot]);

  const redoLastAction = useCallback(() => {
    const next = historyFutureRef.current.pop();
    if (!next) return;

    historyPastRef.current.push(cloneStrokeList(strokesRef.current));
    restoreSnapshot(next);
  }, [cloneStrokeList, restoreSnapshot]);

  const clearShapeTimers = useCallback(() => {
    if (shapeDetectionTimerRef.current !== null) {
      window.clearTimeout(shapeDetectionTimerRef.current);
      shapeDetectionTimerRef.current = null;
    }
    if (shapePreviewTimerRef.current !== null) {
      window.clearTimeout(shapePreviewTimerRef.current);
      shapePreviewTimerRef.current = null;
    }
    if (shapeIdleHandleRef.current !== null) {
      const cancelIdle = (window as any).cancelIdleCallback as ((handle: number) => void) | undefined;
      if (cancelIdle) {
        cancelIdle(shapeIdleHandleRef.current);
      } else {
        window.clearTimeout(shapeIdleHandleRef.current);
      }
      shapeIdleHandleRef.current = null;
    }
  }, []);

  const applyShapeCorrection = useCallback((strokeId: number, result: ShapeDetectionResult) => {
    const stroke = strokesRef.current.find((s) => s.id === strokeId);
    if (!stroke) return;

    pushUndoSnapshot();

    const originalPoints = clonePoints(stroke.points);
    const originalRenderPoints = clonePoints(stroke.renderPoints ?? smoothForRender(stroke.points));
    const correctedPoints = clonePoints(result.points);

    stroke.originalPoints = originalPoints;
    stroke.originalRenderPoints = originalRenderPoints;
    stroke.points = correctedPoints;
    stroke.renderPoints = correctedPoints;
    stroke.corrected = true;
    stroke.shapeKind = result.kind;
    stroke.bbox = computeBBox(correctedPoints);

    baseDirtyRef.current = true;
    scheduleDraw();
  }, [pushUndoSnapshot, scheduleDraw, smoothForRender]);

  const queueShapeDetection = useCallback((strokeId: number, pointsForDetection: Point[]) => {
    if (!shapeAssistEnabledRef.current || disableShapeForStrokeRef.current) {
      return;
    }

    clearShapeTimers();
    shapeDetectionTimerRef.current = window.setTimeout(() => {
      const detectTask = () => {
        shapeIdleHandleRef.current = null;

        if (!shapeAssistEnabledRef.current) return;
        if (shapeDetectionCacheRef.current.has(strokeId)) return;

        const result = detectAutoShape(pointsForDetection, shapeSensitivityRef.current);
        shapeDetectionCacheRef.current.set(strokeId, result ?? null);
        if (!result) return;

        const targetStroke = strokesRef.current.find((s) => s.id === strokeId);
        if (!targetStroke) return;

        shapePreviewRef.current = {
          strokeId,
          kind: result.kind,
          points: clonePoints(result.points),
          confidence: result.confidence,
          color: targetStroke.color,
          width: targetStroke.width,
        };
        scheduleDraw();

        shapePreviewTimerRef.current = window.setTimeout(() => {
          shapePreviewTimerRef.current = null;
          const preview = shapePreviewRef.current;
          if (!preview || preview.strokeId !== strokeId) return;
          shapePreviewRef.current = null;
          applyShapeCorrection(strokeId, result);
          scheduleDraw();
        }, SHAPE_PREVIEW_MS);
      };

      const requestIdle = (window as any).requestIdleCallback as
        | ((cb: () => void, opts?: { timeout: number }) => number)
        | undefined;
      if (requestIdle) {
        shapeIdleHandleRef.current = requestIdle(detectTask, { timeout: 260 });
      } else {
        shapeIdleHandleRef.current = window.setTimeout(detectTask, 0);
      }
    }, SHAPE_DETECTION_DELAY_MS);
  }, [
    SHAPE_DETECTION_DELAY_MS,
    SHAPE_PREVIEW_MS,
    applyShapeCorrection,
    clearShapeTimers,
    detectAutoShape,
    scheduleDraw,
  ]);

  const scheduleCursorUpdate = useCallback((point: Point | null) => {
    pendingCursorRef.current = point;
    if (cursorRafRef.current !== null) return;
    cursorRafRef.current = requestAnimationFrame(() => {
      cursorRafRef.current = null;
      const next = pendingCursorRef.current;
      const prev = cursorPositionRef.current;
      if (!next && !prev) return;
      if (next && prev) {
        const dx = next.x - prev.x;
        const dy = next.y - prev.y;
        if (dx * dx + dy * dy < 0.12) return;
      }

      const now = performance.now();
      if (inputMode === "hand") {
        const minInterval = 18;
        if (now - lastCursorCommitTimeRef.current < minInterval) return;
        lastCursorCommitTimeRef.current = now;
      }

      cursorPositionRef.current = next ? { x: next.x, y: next.y } : null;
      setCursorPosition(cursorPositionRef.current);
    });
  }, [inputMode]);

  const eraseAtPoint = useCallback((point: Point) => {
    let modified = false;

    for (let i = strokesRef.current.length - 1; i >= 0; i--) {
      const stroke = strokesRef.current[i];
      const bbox = stroke.bbox ?? (stroke.bbox = computeBBox(stroke.points));

      if (
        point.x < bbox.minX - ERASE_RADIUS ||
        point.x > bbox.maxX + ERASE_RADIUS ||
        point.y < bbox.minY - ERASE_RADIUS ||
        point.y > bbox.maxY + ERASE_RADIUS
      ) {
        continue;
      }

      const newPoints: Point[] = [];

      for (const p of stroke.points) {
        const distance = Math.hypot(p.x - point.x, p.y - point.y);

        if (distance < ERASE_RADIUS) {
          if (!eraseSessionActiveRef.current) {
            pushUndoSnapshot();
            eraseSessionActiveRef.current = true;
          }
          if (newPoints.length > 1) {
            strokesRef.current.splice(i + 1, 0, {
              id: strokeIdCounterRef.current++,
              points: [...newPoints],
              color: stroke.color,
              width: stroke.width,
              bbox: computeBBox(newPoints),
              renderPoints: smoothForRender(newPoints),
              corrected: false,
            });
          }
          newPoints.length = 0;
          modified = true;
        } else {
          newPoints.push(p);
        }
      }

      if (newPoints.length > 1) {
        stroke.points = newPoints;
        stroke.bbox = computeBBox(newPoints);
        stroke.renderPoints = smoothForRender(newPoints);
        stroke.corrected = false;
        stroke.shapeKind = undefined;
        stroke.originalPoints = undefined;
        stroke.originalRenderPoints = undefined;
      } else {
        strokesRef.current.splice(i, 1);
      }
    }

    if (modified) {
      shapeDetectionCacheRef.current.clear();
      baseDirtyRef.current = true;
    }

    return modified;
  }, [pushUndoSnapshot]);

  const addPointToStroke = useCallback((point: Point) => {
    const now = performance.now();

    if (!strokeFilterRef.current) {
      strokeFilterRef.current = createStrokeFilters();
    }

    if (!isDrawingRef.current) {
      if (inputMode === "hand") {
        disableShapeForStrokeRef.current = shiftPressedRef.current;
      }
      isDrawingRef.current = true;
      strokeFilterRef.current.x.reset(point.x, now);
      strokeFilterRef.current.y.reset(point.y, now);

      const start = { x: point.x, y: point.y };
      currentStrokeRef.current = [start];
      currentRenderStrokeRef.current = [start];
      predictedPointRef.current = null;
      liveSmoothCounterRef.current = 0;
      lastPointRef.current = start;
      lastPointTimeRef.current = now;
      scheduleDraw();
      return;
    }

    let filtered = {
      x: strokeFilterRef.current.x.filter(point.x, now),
      y: strokeFilterRef.current.y.filter(point.y, now),
    };

    if (!lastPointRef.current) {
      currentStrokeRef.current.push(filtered);
      lastPointRef.current = filtered;
      currentRenderStrokeRef.current = smoothForLive(currentStrokeRef.current);
      predictedPointRef.current = null;
      scheduleDraw();
      return;
    }

    const dx = filtered.x - lastPointRef.current.x;
    const dy = filtered.y - lastPointRef.current.y;
    let distance = Math.hypot(dx, dy);
    const lastTime = lastPointTimeRef.current ?? now;
    const dt = Math.max(1 / 240, (now - lastTime) / 1000);
    const velocity = distance / dt; // px / s

    // Update current width based on velocity (slower -> thicker)
    const vmax = 2500; // px/s, clamp for mapping
    const velFactor = 1 - clamp(velocity / vmax, 0, 1);
    const dyn = widthDynamicsRef.current ?? 0.75;
    const targetWidth = MIN_WIDTH + (MAX_WIDTH - MIN_WIDTH) * (velFactor * dyn);
    currentWidthRef.current = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, targetWidth));
    lastPointTimeRef.current = now;

    // Blend toward raw point on very fast movement instead of hard snap.
    if (distance > 22) {
      const blend = clamp((distance - 22) / 36, 0, 1) * 0.4;
      filtered = {
        x: filtered.x * (1 - blend) + point.x * blend,
        y: filtered.y * (1 - blend) + point.y * blend,
      };
      distance = Math.hypot(filtered.x - lastPointRef.current.x, filtered.y - lastPointRef.current.y);
    }

    const microThreshold = Math.max(0.35, MICRO_MOVEMENT - smoothingRef.current * 0.05);
    if (distance < microThreshold) return;

    // Adaptive interpolation: fewer points when moving very fast.
    const segmentLimit = clamp(MAX_SEGMENT + velocity * 0.0018, MAX_SEGMENT, 10.4);
    if (distance > segmentLimit) {
      const steps = Math.min(MAX_INTERPOLATION_STEPS, Math.ceil(distance / segmentLimit));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        currentStrokeRef.current.push({
          x: lastPointRef.current.x + (filtered.x - lastPointRef.current.x) * t,
          y: lastPointRef.current.y + (filtered.y - lastPointRef.current.y) * t,
        });
      }
    } else {
      currentStrokeRef.current.push(filtered);
    }

    liveSmoothCounterRef.current++;
    const pointCount = currentStrokeRef.current.length;
    const rebuildStride =
      inputMode === "hand"
        ? pointCount > 120 ? 3 : 2
        : pointCount > 160 ? 4 : 3;
    const shouldRebuildLive =
      liveSmoothCounterRef.current < 22 ||
      pointCount <= 40 ||
      liveSmoothCounterRef.current % rebuildStride === 0;

    if (shouldRebuildLive) {
      currentRenderStrokeRef.current = smoothForLive(currentStrokeRef.current);
    } else {
      const lastRaw = currentStrokeRef.current[currentStrokeRef.current.length - 1];
      const prevRender = currentRenderStrokeRef.current[currentRenderStrokeRef.current.length - 1];
      if (!prevRender || Math.hypot(lastRaw.x - prevRender.x, lastRaw.y - prevRender.y) >= 0.75) {
        currentRenderStrokeRef.current.push(lastRaw);
      }
    }

    const renderPoints = currentRenderStrokeRef.current;
    if (predictionMsRef.current > 0 && renderPoints.length > 1) {
      const tail = renderPoints[renderPoints.length - 1];
      const prev = renderPoints[renderPoints.length - 2];
      const segX = tail.x - prev.x;
      const segY = tail.y - prev.y;
      const segLen = Math.hypot(segX, segY);
      if (segLen > 0.001) {
        const speed = segLen / dt;
        const aheadDist = clamp(speed * (predictionMsRef.current / 1000), 0, 22);
        const nx = segX / segLen;
        const ny = segY / segLen;
        predictedPointRef.current = {
          x: clamp(tail.x + nx * aheadDist, 0, sizeRef.current.width),
          y: clamp(tail.y + ny * aheadDist, 0, sizeRef.current.height),
        };
      } else {
        predictedPointRef.current = null;
      }
    } else {
      predictedPointRef.current = null;
    }

    lastPointRef.current = filtered;
    scheduleDraw();
  }, [inputMode, scheduleDraw]);

  const finishStroke = useCallback(() => {
    const points = [...currentStrokeRef.current];
    if (isDrawingRef.current && points.length > 1) {
      pushUndoSnapshot();
      const renderPoints = finalizeRenderPoints(points, currentRenderStrokeRef.current);
      const committedWidth = Math.max(MIN_WIDTH, Math.round(currentWidthRef.current));
      const strokeId = strokeIdCounterRef.current++;
      strokesRef.current.push({
        id: strokeId,
        points,
        color: currentColorRef.current,
        width: committedWidth,
        bbox: computeBBox(points),
        renderPoints,
        corrected: false,
      });

      queueShapeDetection(strokeId, points);
      baseDirtyRef.current = true;
    }

    currentStrokeRef.current = [];
    currentRenderStrokeRef.current = [];
    predictedPointRef.current = null;
    liveSmoothCounterRef.current = 0;
    isDrawingRef.current = false;
    lastPointRef.current = null;
    strokeFilterRef.current = null;
    disableShapeForStrokeRef.current = false;
    scheduleDraw();
  }, [pushUndoSnapshot, queueShapeDetection, scheduleDraw]);

  const setToolMode = useCallback((next: ToolMode) => {
    clearShapeTimers();
    shapePreviewRef.current = null;
    setPaletteOpen(false);
    setTool(next);
    setGestureStateIfChanged("idle");
    isDrawingRef.current = false;
    currentStrokeRef.current = [];
    currentRenderStrokeRef.current = [];
    predictedPointRef.current = null;
    liveSmoothCounterRef.current = 0;
    disableShapeForStrokeRef.current = false;
    eraseSessionActiveRef.current = false;
    scheduleDraw();
  }, [clearShapeTimers, scheduleDraw, setGestureStateIfChanged]);

  const handleMouseDown = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    if (inputMode !== "mouse") return;

    if (sizeRef.current.width < 1 || sizeRef.current.height < 1) return;

    let clientX: number, clientY: number;
    if ("touches" in e) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }

    const point = { x: clientX - offsetRef.current.left, y: clientY - offsetRef.current.top };

    const target = e.target as HTMLElement | null;
    if (target && target.closest(".ui-dock, .ui-palette, .ui-tip")) {
      return;
    }

    const colorIndex = isNearPalette(point);
    if (colorIndex !== null) {
      disableShapeForStrokeRef.current = false;
      selectColor(COLORS[colorIndex]);
      return;
    }

    if (tool === "erase") {
      disableShapeForStrokeRef.current = false;
      setGestureStateIfChanged("erasing");
      if (eraseAtPoint(point)) {
        scheduleDraw();
      }
    } else {
      eraseSessionActiveRef.current = false;
      disableShapeForStrokeRef.current = (!("touches" in e) && e.shiftKey) || shiftPressedRef.current;
      setGestureStateIfChanged("drawing");
      addPointToStroke(point);
    }
  }, [inputMode, isNearPalette, tool, eraseAtPoint, scheduleDraw, addPointToStroke, selectColor, setGestureStateIfChanged]);

  const handleMouseMove = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    if (inputMode !== "mouse") return;

    if (sizeRef.current.width < 1 || sizeRef.current.height < 1) return;

    let clientX: number, clientY: number;
    if ("touches" in e) {
      if (e.touches.length === 0) return;
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }

    const point = { x: clientX - offsetRef.current.left, y: clientY - offsetRef.current.top };
    scheduleCursorUpdate(point);
    const isPointerDown = "touches" in e ? e.touches.length > 0 : (e.buttons & 1) === 1;

    if (tool === "erase" && isPointerDown) {
      setGestureStateIfChanged("erasing");
      if (eraseAtPoint(point)) {
        scheduleDraw();
      }
      return;
    }

    if (tool === "draw" && isPointerDown) {
      eraseSessionActiveRef.current = false;
      setGestureStateIfChanged("drawing");
      addPointToStroke(point);
      return;
    }

    if (!isPointerDown && gestureStateRef.current !== "idle") {
      eraseSessionActiveRef.current = false;
      if (gestureStateRef.current === "drawing") {
        finishStroke();
      }
      setGestureStateIfChanged("idle");
    }
  }, [inputMode, tool, addPointToStroke, eraseAtPoint, finishStroke, scheduleCursorUpdate, scheduleDraw, setGestureStateIfChanged]);

  const handleMouseUp = useCallback(() => {
    if (inputMode !== "mouse") return;

    if (gestureStateRef.current === "drawing") {
      finishStroke();
    }
    eraseSessionActiveRef.current = false;
    disableShapeForStrokeRef.current = false;
    setGestureStateIfChanged("idle");
  }, [inputMode, finishStroke, setGestureStateIfChanged]);

  const handleHandResults = useCallback((results: any) => {
    if (!containerRef.current) return;
    
    frameSkipRef.current++;
    if (frameSkipRef.current < FRAME_SKIP) return;
    frameSkipRef.current = 0;
    
    const rect = sizeRef.current;
    if (rect.width < 1 || rect.height < 1) return;
    const now = performance.now();

    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
      lastHandSeenTimeRef.current = now;
      if (!isHandDetectedRef.current) {
        isHandDetectedRef.current = true;
        setIsHandDetected(true);
      }
      if (!hideInstructionsRef.current) {
        hideInstructionsRef.current = true;
        setHideInstructions(true);
      }

      const landmarks = results.multiHandLandmarks[0];

      const indexTip = landmarks[8];
      const screenX = (1 - indexTip.x) * rect.width;
      const screenY = indexTip.y * rect.height;
      const currentPoint = { x: screenX, y: screenY };

      scheduleCursorUpdate(currentPoint);

      const pinching = isPinching(landmarks);
      const nearColorIndex = isNearPalette(currentPoint);

      if (nearColorIndex !== null) {
        if (hoveredColorIndexRef.current !== nearColorIndex) {
          hoveredColorIndexRef.current = nearColorIndex;
          setHoveredColorIndex(nearColorIndex);
          colorHoverTimeRef.current = 0;
        } else {
          colorHoverTimeRef.current += now - lastFrameTimeRef.current;
          if (colorHoverTimeRef.current >= COLOR_HOVER_DURATION) {
            const nextColor = COLORS[nearColorIndex];
            selectColor(nextColor);
            colorHoverTimeRef.current = 0;
          }
        }
        lastColorIndexRef.current = nearColorIndex;
      } else {
        if (hoveredColorIndexRef.current !== null) {
          hoveredColorIndexRef.current = null;
          setHoveredColorIndex(null);
        }
        lastColorIndexRef.current = null;
        colorHoverTimeRef.current = 0;
      }

      if (tool === "erase" && pinching) {
        setGestureStateIfChanged("erasing");
        if (eraseAtPoint(currentPoint)) {
          scheduleDraw();
        }
      } else if (tool === "draw" && pinching && nearColorIndex === null) {
        eraseSessionActiveRef.current = false;
        setGestureStateIfChanged("drawing");
        addPointToStroke(currentPoint);
      } else {
        eraseSessionActiveRef.current = false;
        if (isDrawingRef.current) {
          finishStroke();
        }
        setGestureStateIfChanged("idle");
      }
    } else {
      if (now - lastHandSeenTimeRef.current < 180) {
        lastFrameTimeRef.current = now;
        return;
      }
      if (isHandDetectedRef.current) {
        isHandDetectedRef.current = false;
        setIsHandDetected(false);
      }
      scheduleCursorUpdate(null);
      if (hoveredColorIndexRef.current !== null) {
        hoveredColorIndexRef.current = null;
        setHoveredColorIndex(null);
      }
      lastColorIndexRef.current = null;
      colorHoverTimeRef.current = 0;
      pinchActiveRef.current = false;
      eraseSessionActiveRef.current = false;
      predictedPointRef.current = null;

      if (isDrawingRef.current) {
        finishStroke();
      }

      setGestureStateIfChanged("idle");
    }

    lastFrameTimeRef.current = now;
  }, [isPinching, isNearPalette, eraseAtPoint, addPointToStroke, finishStroke, selectColor, tool, scheduleDraw, scheduleCursorUpdate, setGestureStateIfChanged]);

  useEffect(() => {
    handResultsHandlerRef.current = handleHandResults;
  }, [handleHandResults]);

  const loadMediaPipeScripts = useCallback(async () => {
    if (window.Hands && window.Camera) return;
    if (!mediaPipeLoadPromiseRef.current) {
      const waitForGlobal = (globalName: "Hands" | "Camera", timeoutMs = 12000) =>
        new Promise<void>((resolve, reject) => {
          const started = performance.now();
          const check = () => {
            if (window[globalName]) {
              resolve();
              return;
            }
            if (performance.now() - started >= timeoutMs) {
              reject(new Error(`Timed out loading MediaPipe ${globalName}`));
              return;
            }
            window.setTimeout(check, 35);
          };
          check();
        });

      const loadScriptOnce = (src: string, globalName: "Hands" | "Camera") =>
        new Promise<void>((resolve, reject) => {
          if (window[globalName]) {
            resolve();
            return;
          }

          const existing = document.querySelector(`script[src="${src}"]`) as HTMLScriptElement | null;
          if (existing) {
            waitForGlobal(globalName).then(resolve).catch(reject);
            return;
          }

          const script = document.createElement("script");
          script.src = src;
          script.async = true;
          script.crossOrigin = "anonymous";
          script.onload = () => {
            waitForGlobal(globalName).then(resolve).catch(reject);
          };
          script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
          document.head.appendChild(script);
        });

      mediaPipeLoadPromiseRef.current = Promise.all([
        loadScriptOnce("https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js", "Hands"),
        loadScriptOnce("https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js", "Camera"),
      ])
        .then(() => undefined)
        .catch((error) => {
          mediaPipeLoadPromiseRef.current = null;
          throw error;
        });
    }

    await mediaPipeLoadPromiseRef.current;
  }, []);

  useEffect(() => {
    const resizeCanvas = () => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) return;

      const rect = container.getBoundingClientRect();
      setContainerSize({ width: rect.width, height: rect.height });
      sizeRef.current = { width: rect.width, height: rect.height };
      offsetRef.current = { left: rect.left, top: rect.top };
      const deviceDpr = window.devicePixelRatio || 1;
      const dprCap = inputMode === "hand" ? 1.18 : 1.45;
      const dpr = Math.max(1, Math.min(deviceDpr, dprCap));
      dprRef.current = dpr;

      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      mainCtxRef.current = canvas.getContext("2d", { alpha: false });

      if (!offscreenCanvasRef.current) {
        offscreenCanvasRef.current = document.createElement('canvas');
      }
      offscreenCanvasRef.current.width = canvas.width;
      offscreenCanvasRef.current.height = canvas.height;
      offscreenCtxRef.current = offscreenCanvasRef.current.getContext('2d', { 
        alpha: false,
        willReadFrequently: false
      });

      baseDirtyRef.current = true;
      drawCanvas();
    };

    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);
    return () => window.removeEventListener("resize", resizeCanvas);
  }, [drawCanvas, inputMode]);

  useEffect(() => {
    if (inputMode !== "hand") {
      setCameraReady(false);
      setIsLoading(false);
      return;
    }
    
    let hands: any = null;
    let camera: any = null;
    let active = true;

    const loadMediaPipe = async () => {
      try {
        setCameraError(null);
        setCameraReady(false);
        setIsLoading(true);
        handInferenceIntervalRef.current = HAND_INFERENCE_INTERVAL_MS;
        handSendCostMsRef.current = HAND_INFERENCE_INTERVAL_MS;
        await loadMediaPipeScripts();
        if (!active) return;
        if (!videoRef.current) {
          throw new Error("Video element not available");
        }

        hands = new window.Hands({
          locateFile: (file: string) => {
            return `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`;
          },
        });

        hands.setOptions({
          maxNumHands: 1,
          modelComplexity: 0,
          minDetectionConfidence: 0.6,
          minTrackingConfidence: 0.6,
        });

        hands.onResults((results: any) => {
          handResultsHandlerRef.current(results);
        });

        camera = new window.Camera(videoRef.current, {
          onFrame: async () => {
            if (!videoRef.current || !hands || !active || handSendBusyRef.current) return;
            const now = performance.now();
            if (now - lastHandSendAtRef.current < handInferenceIntervalRef.current) return;
            lastHandSendAtRef.current = now;
            handSendBusyRef.current = true;
            try {
              const startedAt = performance.now();
              await hands.send({ image: videoRef.current });
              const sendCost = performance.now() - startedAt;
              handSendCostMsRef.current = handSendCostMsRef.current * 0.82 + sendCost * 0.18;
              handInferenceIntervalRef.current = clamp(handSendCostMsRef.current * 1.1, 34, 85);
            } finally {
              handSendBusyRef.current = false;
            }
          },
          width: 320,
          height: 240,
        });

        await camera.start();
        if (active) {
          setCameraReady(true);
          setIsLoading(false);
        }
      } catch (error: any) {
        console.error("Error initializing MediaPipe:", error);
        if (active) {
          setCameraError(error.message || "Failed to access camera");
          setCameraReady(false);
          setIsLoading(false);
        }
      }
    };

    loadMediaPipe();

    return () => {
      active = false;
      handSendBusyRef.current = false;
      lastHandSendAtRef.current = 0;
      handInferenceIntervalRef.current = HAND_INFERENCE_INTERVAL_MS;
      handSendCostMsRef.current = HAND_INFERENCE_INTERVAL_MS;
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      if (cursorRafRef.current !== null) {
        cancelAnimationFrame(cursorRafRef.current);
        cursorRafRef.current = null;
      }
      if (camera) {
        try {
          camera.stop();
        } catch (e) {
          console.error("Error stopping camera:", e);
        }
      }
      if (hands) {
        try {
          hands.close();
        } catch (e) {
          console.error("Error closing hands:", e);
        }
      }
    };
  }, [inputMode, loadMediaPipeScripts, HAND_INFERENCE_INTERVAL_MS]);

  useEffect(() => {
    return () => {
      clearShapeTimers();
      shiftPressedRef.current = false;
      shapePreviewRef.current = null;
    };
  }, [clearShapeTimers]);

  const palettePos = getPalettePosition();
  const colorProgress = hoveredColorIndex !== null ? (colorHoverTimeRef.current / COLOR_HOVER_DURATION) * 100 : 0;

  const switchToMouseMode = useCallback((nextTool: ToolMode = "draw") => {
    clearShapeTimers();
    shapePreviewRef.current = null;
    setInputMode("mouse");
    setTool(nextTool);
    setGestureStateIfChanged("idle");
    setIsLoading(false);
    setCameraError(null);
    setHideInstructions(true);
    hideInstructionsRef.current = true;
    setIsHandDetected(false);
    isHandDetectedRef.current = false;
    scheduleCursorUpdate(null);
    currentStrokeRef.current = [];
    currentRenderStrokeRef.current = [];
    predictedPointRef.current = null;
    liveSmoothCounterRef.current = 0;
    disableShapeForStrokeRef.current = false;
    eraseSessionActiveRef.current = false;
    strokeFilterRef.current = null;
    scheduleDraw();
  }, [clearShapeTimers, scheduleCursorUpdate, scheduleDraw, setGestureStateIfChanged]);

  const cursorClass = inputMode === "mouse" ? "cursor-crosshair" : "cursor-default";
  const drawCursorRadius = inputMode === "hand" ? Math.max(6, currentWidthRef.current) : Math.max(4, currentWidth);
  const cursorRadius = tool === "erase" ? ERASE_RADIUS : drawCursorRadius;

  const clearCanvas = useCallback(() => {
    if (strokesRef.current.length > 0) {
      pushUndoSnapshot();
    }
    clearShapeTimers();
    strokesRef.current = [];
    shapeDetectionCacheRef.current.clear();
    shapePreviewRef.current = null;
    currentStrokeRef.current = [];
    currentRenderStrokeRef.current = [];
    predictedPointRef.current = null;
    liveSmoothCounterRef.current = 0;
    lastPointRef.current = null;
    isDrawingRef.current = false;
    eraseSessionActiveRef.current = false;
    disableShapeForStrokeRef.current = false;
    strokeFilterRef.current = null;
    baseDirtyRef.current = true;
    scheduleDraw();
  }, [clearShapeTimers, pushUndoSnapshot, scheduleDraw]);

  const saveSnapshotToStorage = useCallback(() => {
    try {
      const payload = {
        version: 1,
        strokes: strokesRef.current,
        settings: {
          currentColor: currentColorRef.current,
          currentWidth: currentWidthRef.current,
          smoothingLevel: smoothingRef.current,
          widthDynamics: widthDynamicsRef.current,
          shapeAssistEnabled: shapeAssistEnabledRef.current,
          shapeSensitivity: shapeSensitivityRef.current,
          predictionMs: predictionMsRef.current,
          showGrid,
          showRulers,
          showCenterGuides,
          themePreset: themePresetRef.current,
        },
      };
      window.localStorage.setItem("x_whiteboard_state_v1", JSON.stringify(payload));
    } catch {
      // Ignore storage failures (quota/private mode).
    }
  }, [showCenterGuides, showGrid, showRulers]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("x_whiteboard_state_v1");
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.strokes)) return;

      const restored: Stroke[] = [];
      for (const item of parsed.strokes) {
        if (!item || !Array.isArray(item.points) || item.points.length < 2) continue;
        const points: Point[] = [];
        for (const p of item.points) {
          if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
          points.push({ x: p.x, y: p.y });
        }
        if (points.length < 2) continue;
        const color = typeof item.color === "string" ? item.color : COLORS[0];
        const width = Number.isFinite(item.width) ? clamp(item.width, MIN_WIDTH, MAX_WIDTH) : currentWidthRef.current;
        const renderPoints = Array.isArray(item.renderPoints)
          ? item.renderPoints
              .filter((p: any) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
              .map((p: any) => ({ x: p.x, y: p.y }))
          : smoothForRender(points);
        restored.push({
          id: Number.isFinite(item.id) ? item.id : strokeIdCounterRef.current++,
          points,
          color,
          width,
          bbox: computeBBox(points),
          renderPoints: renderPoints.length > 1 ? renderPoints : smoothForRender(points),
          corrected: !!item.corrected,
          shapeKind: item.shapeKind as ShapeKind | undefined,
        });
      }

      if (restored.length > 0) {
        strokesRef.current = restored;
        strokeIdCounterRef.current =
          restored.reduce((maxId, stroke) => Math.max(maxId, stroke.id ?? 0), 0) + 1;
        baseDirtyRef.current = true;
        scheduleDraw();
      }

      const settings = parsed.settings ?? {};
      if (typeof settings.currentColor === "string") {
        setCurrentColor(settings.currentColor);
        currentColorRef.current = settings.currentColor;
        setRecentColors((prev) => [settings.currentColor, ...prev.filter((c) => c !== settings.currentColor)].slice(0, 10));
      }
      if (Number.isFinite(settings.currentWidth)) {
        const width = clamp(settings.currentWidth, MIN_WIDTH, MAX_WIDTH);
        setCurrentWidth(width);
        currentWidthRef.current = width;
      }
      if (Number.isFinite(settings.smoothingLevel)) {
        const level = clamp(settings.smoothingLevel, 0, 10);
        setSmoothingLevel(level);
        smoothingRef.current = level;
      }
      if (Number.isFinite(settings.widthDynamics)) {
        const dyn = clamp(settings.widthDynamics, 0, 1);
        setWidthDynamics(dyn);
        widthDynamicsRef.current = dyn;
      }
      if (typeof settings.shapeAssistEnabled === "boolean") {
        setShapeAssistEnabled(settings.shapeAssistEnabled);
        shapeAssistEnabledRef.current = settings.shapeAssistEnabled;
      }
      if (Number.isFinite(settings.shapeSensitivity)) {
        const sens = clamp(settings.shapeSensitivity, 0.2, 1);
        setShapeSensitivity(sens);
        shapeSensitivityRef.current = sens;
      }
      if (Number.isFinite(settings.predictionMs)) {
        const pred = clamp(settings.predictionMs, 0, 24);
        setPredictionMs(pred);
        predictionMsRef.current = pred;
      }
      if (typeof settings.showGrid === "boolean") setShowGrid(settings.showGrid);
      if (typeof settings.showRulers === "boolean") setShowRulers(settings.showRulers);
      if (typeof settings.showCenterGuides === "boolean") setShowCenterGuides(settings.showCenterGuides);
      if (settings.themePreset && settings.themePreset in THEME_PRESETS) {
        setThemePreset(settings.themePreset as ThemePreset);
      }
    } catch {
      // Ignore invalid saved data.
    }
  }, [scheduleDraw]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      saveSnapshotToStorage();
    }, 30000);
    return () => window.clearInterval(interval);
  }, [saveSnapshotToStorage]);

  useEffect(() => {
    const saveOnUnload = () => {
      saveSnapshotToStorage();
    };
    window.addEventListener("beforeunload", saveOnUnload);
    return () => window.removeEventListener("beforeunload", saveOnUnload);
  }, [saveSnapshotToStorage]);


  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Shift") {
        shiftPressedRef.current = true;
        if (shapePreviewRef.current) {
          clearShapeTimers();
          shapePreviewRef.current = null;
          scheduleDraw();
        }
      }
      if (
        e.target &&
        (e.target as HTMLElement).closest("input, textarea, select, [contenteditable='true']")
      ) {
        return;
      }
      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && key === "z") {
        e.preventDefault();
        if (e.shiftKey) {
          redoLastAction();
        } else {
          undoLastAction();
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && key === "y") {
        e.preventDefault();
        redoLastAction();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && key === "c") {
        e.preventDefault();
        clearCanvas();
        return;
      }
      if (e.key === "1") setToolMode("draw");
      if (e.key === "2") setToolMode("erase");
      if (e.key === "[") {
        const next = clamp(currentWidthRef.current - 1, MIN_WIDTH, MAX_WIDTH);
        setCurrentWidth(next);
        currentWidthRef.current = next;
      }
      if (e.key === "]") {
        const next = clamp(currentWidthRef.current + 1, MIN_WIDTH, MAX_WIDTH);
        setCurrentWidth(next);
        currentWidthRef.current = next;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        setToolMode(tool === "draw" ? "erase" : "draw");
      }
      if (key === "p") setPaletteOpen((prev) => !prev);
      if (key === "c") clearCanvas();
      if (key === "g") setShowGrid((prev) => !prev);
      if (key === "r") setShowRulers((prev) => !prev);
      if (key === "m") {
        if (inputMode === "hand") {
          switchToMouseMode(tool);
        } else {
          setInputMode("hand");
          setToolMode("draw");
          setGestureStateIfChanged("idle");
          setIsLoading(true);
          setCameraError(null);
          setHideInstructions(false);
          hideInstructionsRef.current = false;
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift") {
        shiftPressedRef.current = false;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [
    setToolMode,
    clearCanvas,
    clearShapeTimers,
    inputMode,
    redoLastAction,
    scheduleDraw,
    setShowGrid,
    setShowRulers,
    switchToMouseMode,
    tool,
    setGestureStateIfChanged,
    undoLastAction,
  ]);

  const activeTheme = THEME_PRESETS[themePreset] ?? THEME_PRESETS.midnight;
  const colorName = COLOR_NAMES[currentColor.toLowerCase()] ?? "Custom";

  return (
    <div 
      ref={containerRef} 
      className={`fixed inset-0 overflow-hidden touch-none select-none ${cursorClass}`}
      style={{ backgroundColor: activeTheme.background }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onTouchStart={handleMouseDown}
      onTouchMove={handleMouseMove}
      onTouchEnd={handleMouseUp}
    >
      <video
        ref={videoRef}
        className="hidden"
        playsInline
        autoPlay
        muted
      />

      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
      />

      <div className="absolute inset-0 pointer-events-none">
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: `radial-gradient(circle at top, ${activeTheme.overlayTop}, transparent 55%), radial-gradient(circle at 20% 80%, ${activeTheme.overlayLeft}, transparent 45%), radial-gradient(circle at 80% 25%, ${activeTheme.overlayRight}, transparent 40%)`,
          }}
        />
        {showGrid && (
          <div
            className="absolute inset-0 opacity-25 mix-blend-screen"
            style={{
              backgroundImage: `linear-gradient(${activeTheme.gridColor} 1px, transparent 1px), linear-gradient(90deg, ${activeTheme.gridColor} 1px, transparent 1px)`,
              backgroundSize: "64px 64px",
            }}
          />
        )}
        <div className="absolute inset-0 opacity-[0.12] ui-noise" />
        {showCenterGuides && (
          <>
            <div className="absolute left-1/2 top-0 h-full w-px bg-white/15" />
            <div className="absolute top-1/2 left-0 w-full h-px bg-white/15" />
          </>
        )}
      </div>

      {showRulers && (
        <>
          <div
            className="absolute top-0 left-0 h-7 w-full pointer-events-none z-10"
            style={{
              background:
                "linear-gradient(rgba(7,10,18,0.8), rgba(7,10,18,0.65)), repeating-linear-gradient(90deg, rgba(255,255,255,0.32) 0 1px, transparent 1px 32px)",
              borderBottom: "1px solid rgba(255,255,255,0.15)",
            }}
          />
          <div
            className="absolute top-0 left-0 w-7 h-full pointer-events-none z-10"
            style={{
              background:
                "linear-gradient(90deg, rgba(7,10,18,0.8), rgba(7,10,18,0.65)), repeating-linear-gradient(180deg, rgba(255,255,255,0.32) 0 1px, transparent 1px 32px)",
              borderRight: "1px solid rgba(255,255,255,0.15)",
            }}
          />
        </>
      )}


            {isLoading && inputMode === "hand" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center z-50 p-4" style={{ backgroundColor: activeTheme.background }}>
          <div className="text-center max-w-sm">
            <div className="w-12 h-12 mx-auto mb-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            <p className="text-white font-medium mb-6">Initializing camera...</p>
            <button
              onClick={() => switchToMouseMode(tool)}
              className="px-4 py-2 bg-white/10 hover:bg-white/20 text-white rounded-lg transition-colors text-sm"
            >
              Use Mouse/Touch Instead
            </button>
          </div>
        </div>
      )}

      {cameraError && inputMode === "hand" && (
        <div className="absolute inset-0 flex items-center justify-center z-50 p-4" style={{ backgroundColor: activeTheme.background }}>
          <div className="text-center max-w-sm">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-red-900/30 flex items-center justify-center">
              <svg className="w-8 h-8 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <h2 className="text-xl font-semibold text-white mb-2">Camera Access Required</h2>
            <p className="text-gray-400 mb-4 text-sm">{cameraError}</p>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => window.location.reload()}
                className="px-4 py-2 bg-white text-black rounded-lg font-medium transition-all hover:opacity-90"
              >
                Try Again
              </button>
              <button
                onClick={() => switchToMouseMode(tool)}
                className="px-4 py-2 bg-white/10 hover:bg-white/20 text-white rounded-lg transition-colors"
              >
                Use Mouse/Touch Instead
              </button>
            </div>
          </div>
        </div>
      )}

      {!isLoading && !cameraError && !hideInstructions && (
        <div className="absolute top-4 right-4 z-20 ui-surface ui-tip px-4 py-3 rounded-2xl max-w-[260px]">
          <p className="text-white/70 text-xs uppercase tracking-[0.2em]">Tips</p>
          <p className="text-white text-sm mt-2">
            {inputMode === "hand"
              ? "Pinch to draw. Release to end stroke. Shape Assist auto-corrects after 500ms pause."
              : "Click + drag to draw. Release to end stroke. Hold Shift while drawing to skip shape auto-correct."
            }
          </p>
        </div>
      )}

      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20">
        <div className="ui-dock">
          <button
            onClick={() => setToolMode("draw")}
            className={`ui-button ${tool === "draw" ? "ui-button-active" : ""}`}
            aria-label="Draw tool"
          >
            <Pencil className="w-4 h-4" />
          </button>

          <button
            onClick={() => setToolMode("erase")}
            className={`ui-button ${tool === "erase" ? "ui-button-danger" : ""}`}
            aria-label="Erase tool"
          >
            <Eraser className="w-4 h-4" />
          </button>

          <div className="h-6 w-px bg-white/15" />

          <button
            onClick={() => setPaletteOpen((prev) => !prev)}
            className={`ui-button ${paletteOpen ? "ui-button-active" : ""}`}
            aria-label="Toggle color palette"
          >
            <Palette className="w-4 h-4" />
          </button>
          <div
            className="w-6 h-6 rounded-full border border-white/30 shadow-[0_0_0_2px_rgba(255,255,255,0.08)]"
            style={{ backgroundColor: currentColor }}
            aria-label={`Current color ${colorName}`}
          />

          <button
            onClick={() => {
              setShapeAssistEnabled((prev) => !prev);
              if (shapeAssistEnabledRef.current) {
                clearShapeTimers();
                shapePreviewRef.current = null;
                scheduleDraw();
              }
            }}
            className={`ui-button ${shapeAssistEnabled ? "ui-button-active" : ""}`}
            aria-label="Toggle shape assist"
          >
            <WandSparkles className="w-4 h-4" />
          </button>

          <div className="h-6 w-px bg-white/15" />

          <button
            onClick={clearCanvas}
            className="ui-button"
            aria-label="Clear canvas"
          >
            <Trash2 className="w-4 h-4" />
          </button>

          <button
            onClick={undoLastAction}
            className="ui-button"
            aria-label="Undo"
            disabled={!canUndo}
            style={!canUndo ? { opacity: 0.45, pointerEvents: "none" } : undefined}
          >
            <Undo2 className="w-4 h-4" />
          </button>

          <div className="h-6 w-px bg-white/15" />

          <button
            onClick={() => setSettingsOpen((prev) => !prev)}
            className={`ui-button ${settingsOpen ? "ui-button-active" : ""}`}
            aria-label="Open settings panel"
          >
            <Settings2 className="w-4 h-4" />
          </button>

          {inputMode === "mouse" && (
            <button
              onClick={() => {
                setInputMode("hand");
                setToolMode("draw");
                setGestureStateIfChanged("idle");
                setIsLoading(true);
                setCameraError(null);
                setHideInstructions(false);
                hideInstructionsRef.current = false;
                setIsHandDetected(false);
                isHandDetectedRef.current = false;
              }}
              className="ui-button"
              aria-label="Switch to hand tracking mode"
            >
              <Hand className="w-4 h-4" />
            </button>
          )}

          {inputMode === "hand" && cameraReady && (
            <button
              onClick={() => switchToMouseMode(tool)}
              className="ui-button"
              aria-label="Switch to mouse mode"
            >
              <MousePointer className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {settingsOpen && (
        <div className="absolute right-4 bottom-24 z-30 w-[320px] max-w-[calc(100vw-2rem)] ui-surface rounded-2xl p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm font-semibold text-white">Settings</div>
            <button
              className="px-2 py-1 rounded-lg text-xs text-white/85 bg-white/10 hover:bg-white/20 transition"
              onClick={() => setSettingsOpen(false)}
              aria-label="Close settings"
            >
              Close
            </button>
          </div>

          <div className="space-y-3">
            <div>
              <div className="text-[11px] uppercase tracking-[0.16em] text-white/55 mb-1">Stroke</div>
              <label className="text-xs text-white/75 flex justify-between">Smooth <span>{smoothingLevel}</span></label>
              <input
                aria-label="smoothing level"
                type="range"
                min={0}
                max={10}
                value={smoothingLevel}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setSmoothingLevel(v);
                  smoothingRef.current = v;
                  strokeFilterRef.current = null;
                }}
                className="w-full h-2 bg-white/20 rounded-lg appearance-none cursor-pointer accent-white"
              />
              <label className="text-xs text-white/75 flex justify-between mt-2">Dynamics <span>{Math.round(widthDynamics * 100)}%</span></label>
              <input
                aria-label="width dynamics"
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={widthDynamics}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setWidthDynamics(v);
                  widthDynamicsRef.current = v;
                }}
                className="w-full h-2 bg-white/20 rounded-lg appearance-none cursor-pointer accent-white"
              />
              <label className="text-xs text-white/75 flex justify-between mt-2">Prediction <span>{predictionMs}ms</span></label>
              <input
                aria-label="prediction latency"
                type="range"
                min={0}
                max={24}
                step={1}
                value={predictionMs}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setPredictionMs(v);
                  predictionMsRef.current = v;
                }}
                className="w-full h-2 bg-white/20 rounded-lg appearance-none cursor-pointer accent-white"
              />
            </div>

            <div>
              <div className="text-[11px] uppercase tracking-[0.16em] text-white/55 mb-1">Shape</div>
              <label className="text-xs text-white/75 flex justify-between">Sensitivity <span>{shapeSensitivity.toFixed(2)}</span></label>
              <input
                aria-label="shape sensitivity"
                type="range"
                min={0.2}
                max={1}
                step={0.01}
                value={shapeSensitivity}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setShapeSensitivity(v);
                  shapeSensitivityRef.current = v;
                }}
                className="w-full h-2 bg-white/20 rounded-lg appearance-none cursor-pointer accent-white"
              />
            </div>

            <div>
              <div className="text-[11px] uppercase tracking-[0.16em] text-white/55 mb-2">Canvas</div>
              <div className="flex gap-2 mb-2">
                {(["midnight", "light", "paper", "ocean"] as ThemePreset[]).map((preset) => (
                  <button
                    key={preset}
                    onClick={() => setThemePreset(preset)}
                    className={`px-2 py-1 rounded-lg text-xs border transition ${themePreset === preset ? "bg-white/20 border-white/40 text-white" : "bg-white/5 border-white/15 text-white/80 hover:bg-white/10"}`}
                  >
                    {THEME_PRESETS[preset].label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowGrid((prev) => !prev)}
                  className={`ui-button ${showGrid ? "ui-button-active" : ""}`}
                  aria-label="Toggle grid"
                >
                  <Grid3x3 className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setShowRulers((prev) => !prev)}
                  className={`ui-button ${showRulers ? "ui-button-active" : ""}`}
                  aria-label="Toggle rulers"
                >
                  <Ruler className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setShowCenterGuides((prev) => !prev)}
                  className={`ui-button ${showCenterGuides ? "ui-button-active" : ""}`}
                  aria-label="Toggle center guides"
                >
                  <Crosshair className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setThemePreset((prev) => (THEME_PRESETS[prev].isDark ? "light" : "midnight"))}
                  className="ui-button"
                  aria-label="Toggle dark and light theme"
                >
                  {THEME_PRESETS[themePreset].isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {paletteOpen && (
        <div
          className="absolute p-3 ui-surface ui-palette rounded-2xl z-20"
          style={{ left: palettePos.x, top: palettePos.y }}
        >
          <div className="grid grid-cols-4 gap-2">
            {COLORS.map((color, index) => (
              <button
                key={color}
                onClick={() => {
                  selectColor(color);
                }}
                onMouseEnter={() => setPaletteHoverColor(color)}
                onMouseLeave={() => setPaletteHoverColor((prev) => (prev === color ? null : prev))}
                className="relative rounded-xl transition-all duration-100 cursor-pointer flex items-center justify-center focus:outline-none focus:ring-2 focus:ring-white/50"
                style={{
                  width: PALETTE_SIZE,
                  height: PALETTE_SIZE,
                  backgroundColor: color,
                  transform: hoveredColorIndex === index ? "scale(1.1)" : "scale(1)",
                  boxShadow: hoveredColorIndex === index ? "0 4px 12px rgba(0,0,0,0.3)" : "none",
                }}
              >
                {hoveredColorIndex === index && inputMode === "hand" && (
                  <div
                    className="absolute inset-0 rounded-xl border-4 border-white"
                    style={{
                      clipPath: `polygon(0 0, ${colorProgress}% 0, ${colorProgress}% 100%, 0 100%)`,
                    }}
                  />
                )}
                {currentColor === color && (
                  <svg className="w-3 h-3 sm:w-4 sm:h-4 text-black drop-shadow-md" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                )}
              </button>
            ))}
          </div>

          <div className="mt-2 text-xs text-white/75 min-h-[18px]">
            {paletteHoverColor ? COLOR_NAMES[paletteHoverColor.toLowerCase()] ?? paletteHoverColor : `Current: ${colorName}`}
          </div>

          {recentColors.length > 1 && (
            <div className="mt-2">
              <div className="text-[11px] uppercase tracking-[0.16em] text-white/50 mb-1">Recent</div>
              <div className="flex flex-wrap gap-1.5">
                {recentColors.slice(0, 8).map((color) => (
                  <button
                    key={`recent-${color}`}
                    onClick={() => selectColor(color)}
                    className="w-5 h-5 rounded-full border border-white/25 hover:scale-110 transition-transform"
                    style={{ backgroundColor: color }}
                    aria-label={`Recent color ${COLOR_NAMES[color.toLowerCase()] ?? color}`}
                  />
                ))}
              </div>
            </div>
          )}

          {inputMode === "mouse" && (
            <div className="mt-3 px-1">
              <input
                type="range"
                min={MIN_WIDTH}
                max={MAX_WIDTH}
                value={currentWidth}
                onChange={(e) => {
                  const width = Number(e.target.value);
                  setCurrentWidth(width);
                  currentWidthRef.current = width;
                }}
                className="w-full h-2 bg-white/20 rounded-lg appearance-none cursor-pointer accent-white"
              />
              <p className="text-white/60 text-xs text-center mt-1">{Math.round(currentWidth)}px</p>
            </div>
          )}
        </div>
      )}

      {cursorPosition && ((inputMode === "hand" && isHandDetected) || inputMode === "mouse") && (
        <div
          className="pointer-events-none fixed rounded-full relative"
          style={{
            left: cursorPosition.x - cursorRadius,
            top: cursorPosition.y - cursorRadius,
            width: cursorRadius * 2,
            height: cursorRadius * 2,
            backgroundColor: tool === "draw" && gestureState === "drawing" ? currentColor : "transparent",
            border:
              tool === "erase"
                ? `2px dashed rgba(255, 100, 100, ${gestureState === "erasing" ? 0.9 : 0.55})`
                : `2px solid rgba(255,255,255, ${gestureState === "drawing" ? 0.25 : 0.45})`,
            boxShadow:
              tool === "erase"
                ? "0 0 0 1px rgba(255, 100, 100, 0.15), 0 10px 25px rgba(0,0,0,0.35)"
                : "0 0 0 1px rgba(255,255,255,0.10), 0 10px 25px rgba(0,0,0,0.35)",
            transition: "width 0.05s, height 0.05s, border-color 0.08s",
          }}
        >
          <div
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{
              width: tool === "erase" ? 5 : 4,
              height: tool === "erase" ? 5 : 4,
              background:
                tool === "erase"
                  ? "rgba(255, 120, 120, 0.95)"
                  : "rgba(255, 255, 255, 0.95)",
              boxShadow:
                tool === "erase"
                  ? "0 0 12px rgba(255, 110, 110, 0.55)"
                  : "0 0 10px rgba(255,255,255,0.45)",
            }}
          />
        </div>
      )}
    </div>
  );
}
  