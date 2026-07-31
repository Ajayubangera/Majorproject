import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { 
  UserPlus, Bell, Activity, ShieldCheck, X, ShieldAlert, Plus, Radio, ArrowLeft, Video, Trash2,
  Maximize2, ZoomIn, ZoomOut, RefreshCw, Wifi, WifiOff, Edit
} from "lucide-react";
import { getCurrentUser } from "../utils/auth";

const parseUTCDate = (dateStr?: string) => {
  if (!dateStr) return null;
  let standardized = dateStr.trim();
  if (!standardized.includes("T") && !standardized.includes("Z")) {
    standardized = standardized.replace(" ", "T") + "Z";
  } else if (standardized.includes("T") && !standardized.endsWith("Z") && !standardized.includes("+") && !standardized.includes("-")) {
    standardized = standardized + "Z";
  }
  const d = new Date(standardized);
  return isNaN(d.getTime()) ? null : d;
};

const formatDateTime = (isoOrTs?: string) => {
  if (!isoOrTs) return "";
  try {
    const d = parseUTCDate(isoOrTs);
    if (d) {
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const hours = String(d.getHours()).padStart(2, '0');
      const minutes = String(d.getMinutes()).padStart(2, '0');
      const seconds = String(d.getSeconds()).padStart(2, '0');
      return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    }
  } catch (e) {}
  return isoOrTs;
};

const API_BASE = `http://${window.location.hostname}:8000`;

const getSnapshotUrl = (url?: string) => {
  if (!url) return "";
  // Handle relative paths starting with /static/
  if (url.startsWith("/static/")) {
    return `${API_BASE}${url}`;
  }
  // Extract /static/snapshots/... from full URLs (handles localhost:8000 stored URLs)
  const match = url.match(/\/static\/snapshots\/.+/);
  if (match) {
    return `${API_BASE}${match[0]}`;
  }
  if (url.startsWith("http")) {
    return url.replace("localhost:8000", `${window.location.hostname}:8000`);
  }
  return `${API_BASE}/${url.replace(/^\//, "")}`;
};

const getSnapshotFallbackUrl = (alert: any) => {
  // Fallback: use the live camera snapshot endpoint
  if (alert?.camera_id) {
    return `${API_BASE}/api/cameras/${alert.camera_id}/snapshot`;
  }
  return "";
};

interface CameraItem {
  id: string;
  name: string;
  source_type: string;
  rtsp_url: string;
  zone_tag: string;
  ai_active: boolean;
  nvr_ip_address?: string;
  channel_number?: number;
}

interface AlertItem {
  id: string;
  camera_id: string;
  camera_name?: string;
  zone_tag?: string;
  snapshot_url: string;
  threat_description: string;
  confidence_score: number;
  is_resolved: boolean;
  is_trashed?: boolean;
  created_at: string;
  timestamp?: string;
}

export default function ProjectView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const currentUser = getCurrentUser();

  const [project, setProject] = useState<any>(null);
  const [cameras, setCameras] = useState<CameraItem[]>([]);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [activeAlerts, setActiveAlerts] = useState<Record<string, any>>({});
  const [offlineCameras, setOfflineCameras] = useState<Record<string, boolean>>({});
  const [showTelemetry, setShowTelemetry] = useState(false);
  
  // Highlighting specific camera
  const [highlightedCamId, setHighlightedCamId] = useState<string | null>(null);

  // Floating states
  const [showMemberModal, setShowMemberModal] = useState(false);
  const [showLogsDrawer, setShowLogsDrawer] = useState(false);
  const [filterDate, setFilterDate] = useState("");
  const [activePopupAlert, setActivePopupAlert] = useState<any | null>(null);
  const [selectedEvidenceAlert, setSelectedEvidenceAlert] = useState<any | null>(null);
  const [newMemberEmail, setNewMemberEmail] = useState("");
  const [newMemberRole, setNewMemberRole] = useState("responder");

  // Edit Camera states
  const [editingCamera, setEditingCamera] = useState<CameraItem | null>(null);
  const [editForm, setEditForm] = useState({ name: "", rtspUrl: "", zoneTag: "" });

  // Inference Injector controls
  const [showSimPanel, setShowSimPanel] = useState(false);
  const [simCameraId, setSimCameraId] = useState("");
  const [simConfidence, setSimConfidence] = useState(() => {
    const saved = localStorage.getItem("simConfidence");
    return saved ? Number(saved) : 0.85;
  });
  const [isAutoDetecting, setIsAutoDetecting] = useState(false);
  const [lastDetectionTime, setLastDetectionTime] = useState<string | null>(null);
  const [isSimulating, setIsSimulating] = useState(false);

  // Sound settings
  const soundEnabled = true;

  // Maximize & Zoom controls state
  const [maximizedCameraId, setMaximizedCameraId] = useState<string | null>(null);
  const [zoomScale, setZoomScale] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  const handleZoomIn = (e: React.MouseEvent) => {
    e.stopPropagation();
    setZoomScale(prev => Math.min(prev + 0.25, 4));
  };

  const handleZoomOut = (e: React.MouseEvent) => {
    e.stopPropagation();
    setZoomScale(prev => {
      const next = Math.max(prev - 0.25, 1);
      if (next === 1) {
        setPanOffset({ x: 0, y: 0 });
      }
      return next;
    });
  };

  const handleZoomReset = (e: React.MouseEvent) => {
    e.stopPropagation();
    setZoomScale(1);
    setPanOffset({ x: 0, y: 0 });
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (zoomScale <= 1) return;
    e.preventDefault();
    setIsDragging(true);
    setDragStart({ x: e.clientX - panOffset.x, y: e.clientY - panOffset.y });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    e.preventDefault();
    setPanOffset({
      x: e.clientX - dragStart.x,
      y: e.clientY - dragStart.y
    });
  };

  const handleMouseUpOrLeave = () => {
    setIsDragging(false);
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const zoomFactor = 0.15;
    if (e.deltaY < 0) {
      // Scroll Up: Zoom In
      setZoomScale(prev => Math.min(prev + zoomFactor, 4));
    } else {
      // Scroll Down: Zoom Out
      setZoomScale(prev => {
        const next = Math.max(prev - zoomFactor, 1);
        if (next === 1) {
          setPanOffset({ x: 0, y: 0 });
        }
        return next;
      });
    }
  };

  // WebSockets ref
  const wsRef = useRef<WebSocket | null>(null);
  const wsReconnectTimerRef = useRef<number | null>(null);
  const wsReconnectDelayRef = useRef(1000);
  const wsIntentionalCloseRef = useRef(false);
  const dismissedAlertIdsRef = useRef<Record<string, boolean>>({});

  // Maximized view container ref
  const maximizedContainerRef = useRef<HTMLDivElement | null>(null);

  // Canvas streams references
  const canvasRefs = useRef<Record<string, HTMLCanvasElement | null>>({});

  // Persisted stream loading states to prevent connection drop on zoom/maximize
  const streamImagesRef = useRef<Record<string, HTMLImageElement>>({});
  const streamConnectedRef = useRef<Record<string, boolean>>({});
  const streamStartTimeRef = useRef<Record<string, number>>({});
  const lastFrameTimeRef = useRef<Record<string, number>>({});
  const pingIntervalsRef = useRef<number[]>([]);

  // Browser-native fullscreen syncing
  useEffect(() => {
    const handleFullscreenChange = () => {
      if (!document.fullscreenElement) {
        setMaximizedCameraId(null);
      }
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, []);

  useEffect(() => {
    if (maximizedCameraId) {
      setTimeout(() => {
        if (maximizedContainerRef.current) {
          maximizedContainerRef.current.requestFullscreen().catch(err => {
            console.error("Failed to enter fullscreen mode:", err);
          });
        }
      }, 50);
    } else if (!maximizedCameraId && document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
  }, [maximizedCameraId]);

  useEffect(() => {
    if (!currentUser) {
      navigate("/auth");
      return;
    }

    // Fetch initial workspace details
    const fetchWorkspace = async () => {
      try {
        const response = await fetch(`${API_BASE}/api/projects/${id}`);
        if (!response.ok) throw new Error("Workspace details unreachable.");
        const data = await response.json();
        setProject(data.project);
        setCameras(data.cameras);
        setAlerts(data.alerts);
        
        // Active alerts are only populated via real-time WebSocket events to avoid historical overlays on startup
        setActiveAlerts({});
        
        if (data.cameras.length > 0) {
          setSimCameraId(data.cameras[0].id);
        }
      } catch (err) {
        console.error("Failed to load live matrix data", err);
      }
    };

    fetchWorkspace();

    // Poll alert registry every 2 seconds (Registry Update Syncing Speed)
    const alertsPollInterval = setInterval(async () => {
      try {
        const response = await fetch(`${API_BASE}/api/projects/${id}/alerts`);
        if (response.ok) {
          const data = await response.json();
          const activeOnly = data.filter((a: any) => !a.is_trashed);
          setAlerts(activeOnly);
          
          // Keep activeAlerts synced with the database
          setActiveAlerts(prev => {
            const copy = { ...prev };
            // Auto-clear active status if alert is resolved/deleted in database
            for (const camId in copy) {
              const stillActive = activeOnly.some((a: any) => a.camera_id === camId && !a.is_resolved);
              if (!stillActive) {
                delete copy[camId];
              }
            }
            // Auto-add new alerts is removed to prevent persistent/startup active warning overlays
            return copy;
          });
        }
      } catch (err) {
        console.error("Alert registry polling failed:", err);
      }
    }, 2000);

    // Poll camera configurations every 2 seconds (Camera Config Syncing Speed)
    const camerasPollInterval = setInterval(async () => {
      try {
        const response = await fetch(`${API_BASE}/api/projects/${id}`);
        if (response.ok) {
          const data = await response.json();
          setCameras(data.cameras);
        }
      } catch (err) {
        console.error("Camera configuration polling failed:", err);
      }
    }, 2000);

    // ─── WebSocket with auto-reconnect (exponential backoff) ─────────────
    const handleWsMessage = (event: MessageEvent) => {
      const payload = JSON.parse(event.data);
      console.log("Real-time WS event received:", payload);

      if (payload.event === "anomaly_detected") {
        const alertData = payload.data;
        
        if (!alertData.is_resolved) {
          setActiveAlerts(prev => ({
            ...prev,
            [alertData.camera_id]: {
              alert_id: alertData.alert_id,
              threat_description: alertData.threat_description,
              confidence_gemini: alertData.confidence_gemini,
              confidence_yolo: alertData.confidence_yolo,
              snapshot_url: alertData.snapshot_url,
              anomaly_type: alertData.anomaly_type,
              status: "active"
            }
          }));

          // Auto-clear active alert overlay after 1 second to return to normal monitoring
          setTimeout(() => {
            setActiveAlerts(prev => {
              const copy = { ...prev };
              if (copy[alertData.camera_id]?.alert_id === alertData.alert_id) {
                delete copy[alertData.camera_id];
              }
              return copy;
            });
          }, 1000);

          if (soundEnabled) {
            playAlarmSound();
          }
          
          setActivePopupAlert(alertData);
        }

        setAlerts(prev => [
          {
            id: alertData.alert_id || Math.random().toString(),
            camera_id: alertData.camera_id,
            camera_name: alertData.camera_name,
            zone_tag: alertData.zone_tag,
            snapshot_url: alertData.snapshot_url,
            threat_description: alertData.threat_description,
            confidence_score: alertData.confidence_gemini,
            is_resolved: alertData.is_resolved ?? false,
            created_at: new Date().toISOString(),
            timestamp: alertData.timestamp
          },
          ...prev
        ]);

      } else if (payload.event === "alert_resolved") {
        const alertId = payload.alert_id;
        setAlerts(prev => prev.map(a => a.id === alertId ? { ...a, is_resolved: true } : a));
        
        setActiveAlerts(prev => {
          const updated = { ...prev };
          for (const camId in updated) {
            if (updated[camId].alert_id === alertId) {
              delete updated[camId];
            }
          }
          return updated;
        });
      } else if (payload.event === "alert_trashed" || payload.event === "alert_permanently_deleted") {
        const alertId = payload.alert_id;
        setAlerts(prev => prev.filter(a => a.id !== alertId));
        setActiveAlerts(prev => {
          const updated = { ...prev };
          for (const camId in updated) {
            if (updated[camId].alert_id === alertId) {
              delete updated[camId];
            }
          }
          return updated;
        });
      } else if (payload.event === "alert_recovered") {
        const recoveredAlert = payload.alert;
        if (recoveredAlert) {
          setAlerts(prev => {
            const updated = [...prev.filter(a => a.id !== recoveredAlert.id), { ...recoveredAlert, is_trashed: false }];
            return updated.sort((a, b) => (parseUTCDate(b.created_at)?.getTime() || 0) - (parseUTCDate(a.created_at)?.getTime() || 0));
          });
        }
      } else if (payload.event === "all_alerts_trashed") {
        setAlerts(prev => prev.map(a => ({ ...a, is_trashed: true })));
        setActiveAlerts({});
      } else if (payload.event === "all_trash_deleted") {
        setAlerts(prev => prev.filter(a => !a.is_trashed));
      }
    };

    const connectWebSocket = () => {
      if (wsIntentionalCloseRef.current) return;

      const ws = new WebSocket(`ws://${window.location.hostname}:8000/api/projects/${id}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log("WebSocket connection established with FastAPI Server");
        wsReconnectDelayRef.current = 1000; // Reset backoff on successful connect
        ws.send(JSON.stringify({ type: "ping" }));
      };

      ws.onmessage = handleWsMessage;

      ws.onerror = (err) => {
        console.error("WS connection error", err);
      };

      ws.onclose = () => {
        console.log("WebSocket stream closed.");
        if (!wsIntentionalCloseRef.current) {
          // Auto-reconnect with exponential backoff (cap at 30s)
          const delay = wsReconnectDelayRef.current;
          console.log(`WebSocket reconnecting in ${delay}ms...`);
          wsReconnectTimerRef.current = window.setTimeout(() => {
            wsReconnectDelayRef.current = Math.min(delay * 2, 30000);
            connectWebSocket();
          }, delay);
        }
      };
    };

    wsIntentionalCloseRef.current = false;
    connectWebSocket();

    return () => {
      wsIntentionalCloseRef.current = true;
      if (wsReconnectTimerRef.current) {
        clearTimeout(wsReconnectTimerRef.current);
      }
      if (wsRef.current) wsRef.current.close();
      clearInterval(alertsPollInterval);
      clearInterval(camerasPollInterval);
    };
  }, [id, currentUser, navigate, soundEnabled]);

  // Centralized camera status polling (once every 3 seconds)
  useEffect(() => {
    if (!id || cameras.length === 0) return;

    const checkCameraStatus = async () => {
      try {
        const response = await fetch(`${API_BASE}/api/projects/${id}/camera-status`);
        if (response.ok) {
          const statusMap = await response.json(); // Map of camera_id -> is_connected
          setOfflineCameras(prev => {
            let changed = false;
            const newOffline: Record<string, boolean> = {};
            cameras.forEach(cam => {
              const isOffline = statusMap[cam.id] === false;
              newOffline[cam.id] = isOffline;
              if (prev[cam.id] !== isOffline) {
                changed = true;
              }
            });
            return changed ? newOffline : prev;
          });
        }
      } catch (err) {
        console.error("Failed to poll camera status", err);
      }
    };

    checkCameraStatus(); // Initial run
    const intervalId = setInterval(checkCameraStatus, 3000);
    return () => clearInterval(intervalId);
  }, [id, cameras]);

  // Canvas drawing loop simulation
  useEffect(() => {
    if (cameras.length === 0) return;

    const activeAnimationFlags: Record<string, boolean> = {};
    const particles: Record<string, Array<{ x: number; y: number; vx: number; vy: number }>> = {};

    // Access persistent refs to prevent connection drops on layout shifts (maximizing)
    const streamImages = streamImagesRef.current;
    const streamConnected = streamConnectedRef.current;
    const streamStartTime = streamStartTimeRef.current;
    const lastFrameTime = lastFrameTimeRef.current;
    const pingIntervals = pingIntervalsRef.current;
    const GRACE_PERIOD_MS = 5000; // Don't show NO SIGNAL for 5s after stream init

    cameras.forEach(cam => {
      activeAnimationFlags[cam.id] = true;
      // Initialize small moving particles to simulate movement in streams
      particles[cam.id] = Array.from({ length: 3 }, () => ({
        x: Math.random() * 200 + 50,
        y: Math.random() * 120 + 40,
        vx: (Math.random() - 0.5) * 1.5,
        vy: (Math.random() - 0.5) * 1.5
      }));

      // Load live HTTP stream if configured
      const isDisconnected = !cam.ai_active;
      
      const updateStatus = (camId: string, isOk: boolean) => {
        streamConnected[camId] = isOk;
        if (isOk) lastFrameTime[camId] = Date.now();
        setOfflineCameras(prev => {
          if (prev[camId] === !isOk) return prev;
          return { ...prev, [camId]: !isOk };
        });
      };

      if (isDisconnected) {
        if (streamImages[cam.id]) {
          streamImages[cam.id].src = "";
          delete streamImages[cam.id];
        }
        streamConnected[cam.id] = false;
        updateStatus(cam.id, false);
      } else {
        const backendStreamUrl = `${API_BASE}/api/cameras/${cam.id}/stream`;
        const existingImg = streamImages[cam.id];
        const existingBaseSrc = existingImg ? existingImg.src.split('?')[0] : '';
        if (!existingImg || existingBaseSrc !== backendStreamUrl) {
          streamStartTime[cam.id] = Date.now();
          const img = new Image();
          img.onload = () => {
            streamConnected[cam.id] = true;
            lastFrameTime[cam.id] = Date.now();
            updateStatus(cam.id, true);
          };
          img.onerror = () => {
            streamConnected[cam.id] = false;
            updateStatus(cam.id, false);
          };
          img.src = backendStreamUrl;
          streamImages[cam.id] = img;
        }
      }
    });

    const drawFrame = () => {
      cameras.forEach((cam) => {
        const targetCanvases: HTMLCanvasElement[] = [];
        
        const mainCanvas = canvasRefs.current[cam.id];
        if (mainCanvas) targetCanvases.push(mainCanvas);
        
        const maxCanvas = canvasRefs.current[`max-${cam.id}`];
        if (maxCanvas && maximizedCameraId === cam.id) {
          targetCanvases.push(maxCanvas);
        }

        targetCanvases.forEach((canvas) => {
          const ctx = canvas.getContext("2d");
          if (!ctx) return;

          const w = canvas.width;
          const h = canvas.height;

          // Clear and draw security background
          ctx.fillStyle = "#0c0721";
          ctx.fillRect(0, 0, w, h);

          const isDisconnected = !cam.ai_active;
          if (isDisconnected) {
            ctx.fillStyle = "#0a051b";
            ctx.fillRect(0, 0, w, h);

            // Grid pattern
            ctx.strokeStyle = "rgba(255, 255, 255, 0.03)";
            ctx.lineWidth = 1;
            for (let i = 0; i < w; i += 20) {
              ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, h); ctx.stroke();
            }
            for (let j = 0; j < h; j += 20) {
              ctx.beginPath(); ctx.moveTo(0, j); ctx.lineTo(w, j); ctx.stroke();
            }

            // Yellow warning text & icon
            ctx.fillStyle = "#eab308";
            ctx.font = "bold 13px monospace";
            ctx.fillText("⚠️ FEED DISCONNECTED", w / 2 - 70, h / 2 - 5);

            ctx.fillStyle = "rgba(255,255,255,0.4)";
            ctx.font = "9px monospace";
            ctx.fillText("OPERATOR SHUTDOWN INITIATED", w / 2 - 75, h / 2 + 15);
            return;
          }

          // Try to draw the real HTTP MJPEG stream
          const liveImg = streamImages[cam.id];
          let streamLoaded = false;

          if (liveImg && streamConnected[cam.id] !== false) {
            try {
              if (liveImg.naturalWidth > 0) {
                ctx.drawImage(liveImg, 0, 0, w, h);
                streamLoaded = true;
                lastFrameTime[cam.id] = Date.now();
                streamConnected[cam.id] = true;
              }
            } catch (e) {
              // Fallback if blocked by CORS or loading
            }
          }

          const isOffline = offlineCameras[cam.id];
          const isHttpStream = true;
          const withinGracePeriod = (Date.now() - (streamStartTime[cam.id] || 0)) < GRACE_PERIOD_MS;
          if (isOffline || (isHttpStream && !streamLoaded)) {
            if (withinGracePeriod && !isOffline) {
              // Show "CONNECTING" animation instead of NO SIGNAL during grace period
              ctx.fillStyle = "#0c0721";
              ctx.fillRect(0, 0, w, h);

              // Subtle grid
              ctx.strokeStyle = "rgba(139, 92, 246, 0.06)";
              ctx.lineWidth = 1;
              for (let i = 0; i < w; i += 20) {
                ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, h); ctx.stroke();
              }
              for (let j = 0; j < h; j += 20) {
                ctx.beginPath(); ctx.moveTo(0, j); ctx.lineTo(w, j); ctx.stroke();
              }

              // Animated dots
              const dotCount = (Math.floor(Date.now() / 400) % 4);
              const dots = ".".repeat(dotCount);
              ctx.fillStyle = "#a78bfa";
              ctx.font = "bold 14px monospace";
              ctx.fillText(`CONNECTING${dots}`, w / 2 - 50, h / 2);
              ctx.fillStyle = "rgba(255,255,255,0.35)";
              ctx.font = "9px monospace";
              ctx.fillText("ESTABLISHING CAMERA LINK", w / 2 - 70, h / 2 + 18);
            } else {
              // Draw Retro CCTV No Signal slate (past grace period or offline)
              ctx.fillStyle = "#110b29";
              ctx.fillRect(0, 0, w, h);

              ctx.strokeStyle = "rgba(239, 68, 68, 0.08)";
              ctx.lineWidth = 1;
              for (let i = 0; i < w; i += 20) {
                ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, h); ctx.stroke();
              }
              for (let j = 0; j < h; j += 20) {
                ctx.beginPath(); ctx.moveTo(0, j); ctx.lineTo(w, j); ctx.stroke();
              }

              const blink = Math.floor(Date.now() / 600) % 2 === 0;
              if (blink) {
                ctx.fillStyle = "#ef4444";
                ctx.beginPath();
                ctx.arc(w / 2 - 55, h / 2 - 4, 6, 0, 2 * Math.PI);
                ctx.fill();
              }

              ctx.fillStyle = "#ef4444";
              ctx.font = "bold 16px monospace";
              ctx.fillText("NO SIGNAL", w / 2 - 35, h / 2 + 1);

              ctx.fillStyle = "#a5b4fc";
              ctx.font = "10px monospace";
              ctx.fillText("AUTO-RECONNECTING...", w / 2 - 58, h / 2 + 20);

              ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
              ctx.font = "9px monospace";
              ctx.fillText(`URL: ${cam.rtsp_url}`, 15, h - 15);
            }
            return;
          }

          // Grid lines to make it look like surveillance camera feeds
          ctx.strokeStyle = "rgba(255, 255, 255, 0.03)";
          ctx.lineWidth = 1;
          for (let i = 0; i < w; i += 40) {
            ctx.beginPath();
            ctx.moveTo(i, 0);
            ctx.lineTo(i, h);
            ctx.stroke();
          }
          for (let j = 0; j < h; j += 30) {
            ctx.beginPath();
            ctx.moveTo(0, j);
            ctx.lineTo(w, j);
            ctx.stroke();
          }

          // Draw perspective lines depending on zone tag to simulate structural layouts
          ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
          ctx.beginPath();
          if (cam.zone_tag === "Corridor") {
            // Hallway perspective lines
            ctx.moveTo(20, h - 10); ctx.lineTo(w / 3, h / 2);
            ctx.moveTo(w - 20, h - 10); ctx.lineTo(2 * w / 3, h / 2);
            ctx.moveTo(w / 3, h / 2); ctx.lineTo(2 * w / 3, h / 2);
          } else if (cam.zone_tag === "Playground" || cam.zone_tag === "Backyard") {
            // Outdoor fields layout
            ctx.moveTo(0, h - 40); ctx.lineTo(w, h - 40);
            ctx.moveTo(w / 2, h - 40); ctx.lineTo(w / 2, h);
          } else {
            // Standard room perspective
            ctx.moveTo(10, 10); ctx.lineTo(w - 10, 10);
            ctx.moveTo(10, h - 10); ctx.lineTo(w - 10, h - 10);
          }
          ctx.stroke();

          // Update and draw normal simulated objects (e.g. green bounding box for humans)
          const activeAlert = activeAlerts[cam.id];
          
          if (activeAlert) {
            // Anomaly active: Draw red flashing visual overlay
            ctx.fillStyle = "rgba(239, 68, 68, 0.08)";
            ctx.fillRect(0, 0, w, h);

            // Pulsing danger frame
            ctx.strokeStyle = `rgba(239, 68, 68, ${Math.abs(Math.sin(Date.now() / 150))})`;
            ctx.lineWidth = 4;
            ctx.strokeRect(2, 2, w - 4, h - 4);

            // Threat location indicator
            ctx.strokeStyle = "var(--danger)";
            ctx.lineWidth = 2;
            ctx.strokeRect(w / 2 - 40, h / 2 - 50, 80, 100);
            
            // Bounding box text
            ctx.fillStyle = "var(--danger)";
            ctx.font = "bold 10px monospace";
            const labelText = activeAlert.anomaly_type ? `AI DETECT: ${activeAlert.anomaly_type.toUpperCase()}` : "AI DETECT: ANOMALY";
            ctx.fillText(labelText, w / 2 - 40, h / 2 - 56);
            ctx.fillText(`CONF: ${(activeAlert.confidence_gemini * 100).toFixed(1)}%`, w / 2 - 40, h / 2 + 65);

            // Blinking Warning overlay text
            ctx.fillStyle = "#fff";
            ctx.font = "bold 12px sans-serif";
            const warningText = activeAlert.anomaly_type ? `⚠️ THREAT: ${activeAlert.anomaly_type.toUpperCase()} DETECTED` : "⚠️ THREAT ALERT VERIFIED";
            ctx.fillText(warningText, 15, 30);
            
          } else {
            // Normal state: Update particles if no real stream is loaded
            if (!streamLoaded) {
              const camParticles = particles[cam.id] || [];
              camParticles.forEach(p => {
                p.x += p.vx;
                p.y += p.vy;

                // Bounce check
                if (p.x < 30 || p.x > w - 30) p.vx *= -1;
                if (p.y < 30 || p.y > h - 30) p.vy *= -1;

                // Draw bounding box
                ctx.strokeStyle = "var(--success)";
                ctx.lineWidth = 1.5;
                ctx.strokeRect(p.x - 15, p.y - 25, 30, 50);

                // Label
                ctx.fillStyle = "var(--success)";
                ctx.font = "8px monospace";
                ctx.fillText("person 0.88", p.x - 15, p.y - 30);
              });
            }
          }

          // Draw crosshair or compass markings
          ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(w / 2 - 10, h / 2); ctx.lineTo(w / 2 + 10, h / 2);
          ctx.moveTo(w / 2, h / 2 - 10); ctx.lineTo(w / 2, h / 2 + 10);
          ctx.stroke();

          // Telemetry details overlay
          ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
          ctx.font = "10px monospace";
          ctx.textAlign = "left";
          ctx.fillText(`CAM_${cam.name.replace(/\s+/g, "_").toUpperCase()}`, 12, h - 14);
          ctx.textAlign = "right";
          ctx.fillText(cam.zone_tag.toUpperCase(), w - 10, h - 14);
          ctx.textAlign = "left";
          
          // Draw date/time overlay — top right, using textAlign=right to never go off-screen
          const now = new Date();
          const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
          const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
          ctx.save();
          ctx.textAlign = "right";
          ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
          ctx.font = "bold 11px monospace";
          ctx.fillText(timeStr, w - 10, 20);
          ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
          ctx.font = "9px monospace";
          ctx.fillText(dateStr, w - 10, 34);
          ctx.restore();

        }); // targetCanvases.forEach
      }); // cameras.forEach

      // Request next frame
      requestAnimationFrame(drawFrame);
    };

    drawFrame();

    return () => {
      cameras.forEach(cam => {
        activeAnimationFlags[cam.id] = false;
      });
      pingIntervals.forEach(clearInterval);
      pingIntervalsRef.current = [];
    };
  }, [cameras, activeAlerts, maximizedCameraId]);

  // Periodic stream health check and auto-reconnect
  useEffect(() => {
    if (cameras.length === 0) return;

    const interval = setInterval(() => {
      cameras.forEach(cam => {
        if (!cam.ai_active) return;

        const isOffline = offlineCameras[cam.id];
        const isStreamDown = streamConnectedRef.current[cam.id] === false;

        // If the stream is marked down, or if the backend says the camera is offline,
        // or if we haven't received a frame in a while (e.g. 5 seconds)
        const timeSinceLastFrame = Date.now() - (lastFrameTimeRef.current[cam.id] || 0);
        const needsReconnect = isStreamDown || isOffline || (timeSinceLastFrame > 5000);

        if (needsReconnect) {
          console.log(`Stream for camera ${cam.name} (${cam.id}) needs reconnect. Retrying...`);
          
          const backendStreamUrl = `${API_BASE}/api/cameras/${cam.id}/stream?t=${Date.now()}`;
          const img = new Image();
          
          img.onload = () => {
            console.log(`Stream reconnected successfully for camera ${cam.name}`);
            streamConnectedRef.current[cam.id] = true;
            lastFrameTimeRef.current[cam.id] = Date.now();
            setOfflineCameras(prev => ({ ...prev, [cam.id]: false }));
          };
          
          img.onerror = () => {
            streamConnectedRef.current[cam.id] = false;
          };
          
          img.src = backendStreamUrl;
          streamImagesRef.current[cam.id] = img;
        }
      });
    }, 3000);

    return () => clearInterval(interval);
  }, [cameras, offlineCameras]);

  // Audio alert trigger
  const playAlarmSound = () => {
    try {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(880, audioCtx.currentTime); // A5 note
      osc.frequency.exponentialRampToValueAtTime(440, audioCtx.currentTime + 0.3);
      
      gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.4);
      
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      
      osc.start();
      osc.stop(audioCtx.currentTime + 0.4);
    } catch (e) {
      console.warn("Audio Context playback blocked by browser user gesture policies.", e);
    }
  };

  // Add Member / Invite API
  const handleAddMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMemberEmail) return;

    try {
      const response = await fetch(`${API_BASE}/api/projects/${id}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: newMemberEmail, role: newMemberRole }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Invitation failed");

      alert(`Member ${newMemberEmail} successfully added as responder.`);
      setNewMemberEmail("");
      setShowMemberModal(false);
    } catch (err: any) {
      alert(err.message);
    }
  };

  // Download snapshot evidence raw file helper
  const handleDownloadSnapshot = async (alert: any) => {
    if (!alert || !alert.snapshot_url) return;
    try {
      const response = await fetch(alert.snapshot_url);
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = `snapshot_${alert.id}.jpg`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(blobUrl);
    } catch (err) {
      console.error("Failed to download raw snapshot:", err);
      window.open(alert.snapshot_url, "_blank");
    }
  };

  // Resolve Alert API
  const handleResolveAlert = async (alertId: string) => {
    try {
      const response = await fetch(`${API_BASE}/api/alerts/${alertId}/resolve`, {
        method: "PUT",
      });
      if (!response.ok) throw new Error("Could not resolve threat alert.");
      
      // Update local alerts list state
      setAlerts(prev => prev.map(a => a.id === alertId ? { ...a, is_resolved: true } : a));
    } catch (err) {
      console.error(err);
    }
  };

  // Trash Alert API
  const handleTrashAlert = async (alertId: string) => {
    try {
      dismissedAlertIdsRef.current[alertId] = true;
      await fetch(`${API_BASE}/api/alerts/${alertId}/trash`, {
        method: "PUT"
      });
      // The WS will broadcast, but we can also update local state instantly
      setAlerts(prev => prev.filter(a => a.id !== alertId));
      setActiveAlerts(prev => {
        const updated = { ...prev };
        for (const camId in updated) {
          if (updated[camId].alert_id === alertId) {
            delete updated[camId];
          }
        }
        return updated;
      });
    } catch (err) {
      console.error("Failed to trash alert:", err);
    }
  };

  // Remove Camera API
  const handleRemoveCamera = async (cameraId: string) => {
    if (!window.confirm("Are you sure you want to remove this camera? This will also delete all of its logged alerts.")) {
      return;
    }
    try {
      const response = await fetch(`${API_BASE}/api/cameras/${cameraId}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("Failed to remove camera.");
      
      // Update local state
      setCameras(prev => prev.filter(c => c.id !== cameraId));
      
      // Remove active alerts associated with it
      setActiveAlerts(prev => {
        const updated = { ...prev };
        delete updated[cameraId];
        return updated;
      });
    } catch (err: any) {
      alert(err.message || "Could not remove camera.");
    }
  };

  // Edit Camera API Submit
  const handleEditCameraSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingCamera) return;

    try {
      const response = await fetch(`${API_BASE}/api/cameras/${editingCamera.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editForm.name,
          rtsp_url: editForm.rtspUrl,
          zone_tag: editForm.zoneTag,
          nvr_ip_address: editingCamera.nvr_ip_address || null,
          channel_number: editingCamera.channel_number || 1
        }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Failed to update camera details.");

      alert("Camera details updated successfully.");
      
      // Update local state
      setCameras(prev => prev.map(c => c.id === editingCamera.id ? { ...c, ...data.camera } : c));
      setEditingCamera(null);
    } catch (err: any) {
      alert(err.message || "Failed to update camera details.");
    }
  };

  // ─── Auto YOLO detection loop ───────────────────────────────────────────────
  // Runs every 12 seconds when isAutoDetecting is true.
  // Probability of firing a detection event is proportional to simConfidence.
  // Captures the current canvas frame of a randomly chosen active camera
  // and POSTs it to the backend detect endpoint for Gemini verification.
  useEffect(() => {
    if (!isAutoDetecting || cameras.length === 0) return;

    const runDetection = async () => {
      // Detection probability based on sensitivity level
      const prob = simConfidence >= 0.90 ? 0.75 :
                   simConfidence >= 0.80 ? 0.60 :
                   simConfidence >= 0.55 ? 0.40 :
                   simConfidence >= 0.30 ? 0.20 : 0.0;

      if (Math.random() > prob) return; // YOLO found nothing this cycle

      // Pick camera: prefer selected camera, else random (excluding manually disconnected or offline cameras)
      const candidateCameras = cameras.filter(c => c.ai_active && !offlineCameras[c.id]);
      if (candidateCameras.length === 0) return;
      
      const targetCam = cameras.find(c => c.id === simCameraId);
      const targetId = simCameraId && targetCam && targetCam.ai_active && !offlineCameras[simCameraId]
        ? simCameraId
        : candidateCameras[Math.floor(Math.random() * candidateCameras.length)].id;

      // Capture canvas frame at this exact moment
      let base64Image = "";
      const canvasEl = canvasRefs.current[targetId];
      if (canvasEl) {
        try { base64Image = canvasEl.toDataURL("image/jpeg", 0.85); }
        catch { /* cross-origin, backend will fetch directly */ }
      }

      setIsSimulating(true);
      try {
        await fetch(`${API_BASE}/api/cameras/${targetId}/detect`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ camera_id: targetId, confidence: simConfidence, image_base64: base64Image })
        });
        setLastDetectionTime(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
      } catch (err) {
        console.error("Auto-detection cycle failed:", err);
      } finally {
        setIsSimulating(false);
      }
    };

    const interval = setInterval(runDetection, 12000);
    runDetection(); // Run immediately on start
    return () => clearInterval(interval);
  }, [isAutoDetecting, cameras, simConfidence, simCameraId, offlineCameras]);


  if (!project) return null;

  // Grid layout helper depending on camera counts
  const getGridLayout = () => {
    const count = cameras.length;
    if (count <= 1) return { gridTemplateColumns: "1fr", height: "calc(100vh - 120px)" };
    if (count <= 4) return { gridTemplateColumns: "repeat(2, 1fr)", height: "calc(100vh - 120px)" };
    return { gridTemplateColumns: "repeat(3, 1fr)", height: "calc(100vh - 120px)" };
  };

  return (
    <div style={{ background: "#060312", minHeight: "100vh", position: "relative", overflow: "hidden" }}>
      
      {/* Top HUD control panel */}
      <div style={{
        position: "absolute",
        top: "20px",
        left: "24px",
        zIndex: 40,
        display: "flex",
        alignItems: "center",
        gap: "16px"
      }}>
        <button 
          onClick={() => navigate("/dashboard")} 
          className="btn-secondary" 
          style={{
            background: "rgba(10,5,27,0.75)",
            border: "1px solid var(--border-glass)",
            padding: "8px 16px",
            fontSize: "0.8rem",
            backdropFilter: "blur(10px)"
          }}
        >
          <ArrowLeft size={14} />
          Hub
        </button>
        <div style={{
          background: "rgba(10,5,27,0.75)",
          border: "1px solid var(--border-glass)",
          padding: "6px 16px",
          borderRadius: "var(--radius-md)",
          backdropFilter: "blur(10px)",
          display: "flex",
          alignItems: "center",
          gap: "12px"
        }}>
          <span style={{ fontSize: "0.85rem", fontWeight: 700 }}>{project.name}</span>
          <span style={{ height: "12px", width: "1px", background: "var(--border-glass)" }}></span>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "0.75rem", color: "var(--text-secondary)" }}>
            <Radio size={14} color="var(--success)" className="pulse-live-icon" style={{ padding: 0, borderRadius: "50%", background: "none", boxShadow: "none" }} />
            <span>Inference Matrix Streaming</span>
          </div>
        </div>
        <div style={{
          background: "rgba(10,5,27,0.75)",
          border: "1px solid var(--border-glass)",
          padding: "8px 16px",
          borderRadius: "var(--radius-md)",
          backdropFilter: "blur(10px)",
          display: "flex",
          alignItems: "center",
          gap: "8px",
          fontSize: "0.8rem",
          color: "var(--text-secondary)",
          position: "relative",
          cursor: "pointer",
          userSelect: "none"
        }}
        title="Stream Telemetry Details"
        onMouseEnter={() => setShowTelemetry(true)}
        onMouseLeave={() => setShowTelemetry(false)}
        >
          <Activity size={14} color="var(--primary)" />
          <span>Stream Info & Speeds</span>
          {showTelemetry && (
            <div style={{
              position: "absolute",
              top: "36px",
              left: "0",
              width: "280px",
              background: "rgba(12, 7, 33, 0.95)",
              border: "1px solid var(--border-glass)",
              borderRadius: "var(--radius-md)",
              padding: "16px",
              boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
              zIndex: 100,
              display: "flex",
              flexDirection: "column",
              gap: "8px",
              color: "#fff",
              textAlign: "left"
            }}>
              <h4 style={{ margin: "0 0 4px 0", fontSize: "0.8rem", fontWeight: 700, color: "var(--primary)", borderBottom: "1px solid var(--border-glass)", paddingBottom: "4px" }}>Stream Telemetry Specifications</h4>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "var(--text-muted)" }}>Video Quality:</span>
                <span>JPEG 90% Quality</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "var(--text-muted)" }}>Display Rate:</span>
                <span>30 FPS</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "var(--text-muted)" }}>AI Inferences:</span>
                <span>2.5 Hz (every 0.4s)</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "var(--text-muted)" }}>UI Alert Sync:</span>
                <span>Every 2s</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "var(--text-muted)" }}>UI Config Sync:</span>
                <span>Every 5s</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "2px", borderTop: "1px solid var(--border-glass)", paddingTop: "4px", fontSize: "0.68rem" }}>
                <span style={{ color: "var(--text-muted)", fontWeight: 600 }}>Low Latency Profile:</span>
                <span style={{ fontFamily: "monospace", color: "var(--success)" }}>probesize=1024, analyzeduration=0, fflags=nobuffer</span>
              </div>
            </div>
          )}
        </div>
        <button 
          onClick={() => setShowLogsDrawer(true)}
          className="btn-secondary"
          style={{
            background: "rgba(10,5,27,0.75)",
            border: "1px solid var(--border-glass)",
            padding: "8px 16px",
            fontSize: "0.8rem",
            backdropFilter: "blur(10px)",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            color: alerts.filter(a => !a.is_trashed).length > 0 ? "#ef4444" : "var(--text-secondary)"
          }}
        >
          <Bell size={14} />
          <span>Incident Logs ({alerts.filter(a => !a.is_trashed).length} Today)</span>
        </button>
      </div>

      {/* Live Stream Matrix Player Grid */}
      <div style={{ padding: "80px 24px 24px 24px" }}>
        {cameras.length === 0 ? (
          <div className="glass-panel flex-center" style={{ height: "calc(100vh - 120px)", flexDirection: "column", gap: "16px" }}>
            <Video size={48} color="var(--text-muted)" />
            <h3 style={{ fontSize: "1.2rem", fontWeight: 600 }}>No video ingestion streams mapped</h3>
            <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>Go to Setup configuration to map NVR channels or Standalone RTSP feeds.</p>
            <button onClick={() => navigate(`/project/${id}/setup`)} className="btn-primary">
              <Plus size={16} />
              Setup Stream Ingestion
            </button>
          </div>
        ) : (
          <div style={{
            display: "grid",
            gap: "16px",
            ...getGridLayout()
          }}>
            {cameras.map((cam) => {
              const activeAlert = activeAlerts[cam.id];
              const isHighlighted = highlightedCamId === cam.id;
              
              return (
                <div 
                  key={cam.id} 
                  className={`glass-panel ${isHighlighted ? "glow-active" : ""}`}
                  style={{
                    position: "relative",
                    overflow: "hidden",
                    border: activeAlert ? "2px solid var(--danger)" : isHighlighted ? "2px solid var(--primary)" : "1px solid var(--border-glass)",
                    borderRadius: "var(--radius-lg)",
                    boxShadow: activeAlert ? "0 0 20px var(--danger-glow)" : isHighlighted ? "0 0 20px var(--primary-glow)" : "none",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: "#000",
                    height: cameras.length === 1 ? "100%" : "auto"
                  }}
                >
                  {/* Canvas feed player */}
                  <canvas
                    ref={(el) => { canvasRefs.current[cam.id] = el; }}
                    width={cameras.length === 1 ? 960 : 480}
                    height={cameras.length === 1 ? 540 : 270}
                    style={{
                      width: cameras.length === 1 ? "100%" : "auto",
                      height: cameras.length === 1 ? "100%" : "auto",
                      maxWidth: "100%",
                      maxHeight: "100%",
                      aspectRatio: "16/9",
                      display: "block",
                      objectFit: "contain"
                    }}
                  />

                  {/* Pulsing live & active AI overlays */}
                  <div style={{
                    position: "absolute",
                    top: "12px",
                    left: "12px",
                    display: "flex",
                    gap: "8px",
                    zIndex: 20
                  }}>
                    <span style={{
                      background: "rgba(10,5,27,0.75)",
                      border: "1px solid var(--border-glass)",
                      padding: "4px 8px",
                      borderRadius: "6px",
                      fontSize: "0.65rem",
                      fontWeight: 600,
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                      color: "#fff"
                    }}>
                      <span className="pulse-live-icon" style={{ width: "6px", height: "6px", borderRadius: "50%", display: "inline-block" }}></span>
                      LIVE
                    </span>
                    <span style={{
                      background: activeAlert ? "rgba(239, 68, 68, 0.25)" : "rgba(10,5,27,0.75)",
                      border: activeAlert ? "1px solid var(--danger)" : "1px solid var(--border-glass)",
                      color: activeAlert ? "var(--danger)" : "var(--secondary)",
                      padding: "4px 8px",
                      borderRadius: "6px",
                      fontSize: "0.65rem",
                      fontWeight: 600,
                      display: "flex",
                      alignItems: "center",
                      gap: "4px"
                    }}>
                      <Activity size={10} />
                      {activeAlert ? "THREAT CONFIRMED" : "AI ANALYTICS ACTIVE"}
                    </span>
                  </div>

                  {/* High compliance Logging marker (Page 3 Government section feature) */}
                  {project.project_type === "government" && (
                    <div style={{
                      position: "absolute",
                      top: "12px",
                      right: "12px",
                      background: "rgba(139, 92, 246, 0.25)",
                      border: "1px solid var(--primary)",
                      color: "var(--primary)",
                      fontSize: "0.6rem",
                      fontWeight: 700,
                      padding: "4px 8px",
                      borderRadius: "4px",
                      zIndex: 20
                    }}>
                      SECURE AUDIT ACTIVE
                    </div>
                  )}

                  {/* Anomaly threat details overlay inside cam frame */}
                  {activeAlert && (
                    <div style={{
                      position: "absolute",
                      bottom: "40px",
                      left: "12px",
                      right: "12px",
                      background: "rgba(239, 68, 68, 0.9)",
                      border: "1px solid var(--danger)",
                      padding: "10px 12px",
                      borderRadius: "var(--radius-sm)",
                      fontSize: "0.75rem",
                      color: "#fff",
                      zIndex: 20,
                      boxShadow: "0 4px 10px rgba(0,0,0,0.3)"
                    }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <p style={{ fontWeight: 700 }}>
                          {activeAlert.threat_description.includes("[Not Gemini Verified]") 
                            ? "OFFLINE VERIFIED ANOMALY (NOT GEMINI VERIFIED)" 
                            : "VERIFIED ANOMALY BY GEMINI 1.5 FLASH"}
                        </p>
                        <div style={{ display: "flex", gap: "6px" }}>
                          <button
                            onClick={async (e) => {
                              e.stopPropagation();
                              if (!window.confirm("Are you sure you want to move ALL notifications to trash?")) return;
                              try {
                                await fetch(`${API_BASE}/api/projects/${id}/alerts/trash-all`, {
                                  method: "PUT"
                                });
                                setAlerts(prev => prev.map(a => ({ ...a, is_trashed: true })));
                                setActiveAlerts({});
                              } catch (err) {
                                console.error("Failed to trash all alerts:", err);
                              }
                            }}
                            style={{
                              background: "rgba(239, 68, 68, 0.25)",
                              border: "1px solid rgba(239, 68, 68, 0.4)",
                              cursor: "pointer",
                              color: "#fff",
                              padding: "2px 6px",
                              borderRadius: "4px",
                              display: "flex",
                              alignItems: "center",
                              gap: "2px",
                              fontSize: "0.65rem",
                              fontWeight: 700
                            }}
                            title="Move All Snapshots to Trash"
                          >
                            <Trash2 size={10} />
                            Trash All
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleTrashAlert(activeAlert.alert_id);
                            }}
                            style={{
                              background: "rgba(0, 0, 0, 0.25)",
                              border: "none",
                              cursor: "pointer",
                              color: "#fff",
                              padding: "2px 6px",
                              borderRadius: "4px",
                              display: "flex",
                              alignItems: "center",
                              gap: "2px",
                              fontSize: "0.65rem",
                              fontWeight: 700
                            }}
                            title="Move Snapshot to Trash"
                          >
                            <Trash2 size={10} />
                            Trash
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (activeAlert.alert_id) {
                                dismissedAlertIdsRef.current[activeAlert.alert_id] = true;
                              }
                              setActiveAlerts(prev => {
                                const copy = { ...prev };
                                delete copy[cam.id];
                                return copy;
                              });
                            }}
                            style={{
                              background: "rgba(0, 0, 0, 0.4)",
                              border: "none",
                              cursor: "pointer",
                              color: "#fff",
                              padding: "2px 6px",
                              borderRadius: "4px",
                              display: "flex",
                              alignItems: "center",
                              gap: "2px",
                              fontSize: "0.65rem",
                              fontWeight: 700
                            }}
                            title="Dismiss Alert Warning from Screen"
                          >
                            <X size={10} />
                            Dismiss
                          </button>
                        </div>
                      </div>
                      <p style={{ marginTop: "4px", opacity: 0.95 }}>
                        {activeAlert.threat_description.replace(" [Not Gemini Verified]", "")}
                      </p>
                    </div>
                  )}

                  {/* Setup & Remove Camera Options */}
                  <div style={{
                    position: "absolute",
                    bottom: "12px",
                    right: "12px",
                    zIndex: 30,
                    display: "flex",
                    gap: "8px"
                  }}>
                    {/* Disconnect/Reconnect Button */}
                    <button
                      onClick={async (e) => {
                        e.stopPropagation();
                        const nextState = !cam.ai_active;
                        try {
                          await fetch(`${API_BASE}/api/cameras/${cam.id}/active`, {
                            method: "PUT",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ ai_active: nextState })
                          });
                          // Update cameras state locally so UI updates instantly
                          setCameras(prev => prev.map(c => c.id === cam.id ? { ...c, ai_active: nextState } : c));
                        } catch (err) {
                          console.error("Failed to toggle camera active status:", err);
                        }
                      }}
                      className="btn-secondary"
                      style={{
                        padding: "6px",
                        background: "rgba(10,5,27,0.85)",
                        border: !cam.ai_active ? "1px solid #eab308" : "1px solid var(--border-glass)",
                        borderRadius: "50%",
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: "32px",
                        height: "32px",
                        boxShadow: "0 2px 10px rgba(0,0,0,0.3)",
                        color: !cam.ai_active ? "#eab308" : "var(--text-secondary)"
                      }}
                      title={!cam.ai_active ? "Reconnect Camera Feed" : "Disconnect Camera Feed"}
                    >
                      {!cam.ai_active ? <Wifi size={14} /> : <WifiOff size={14} />}
                    </button>

                    {/* Add Member Button */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowMemberModal(true);
                      }}
                      className="btn-secondary"
                      style={{
                        padding: "6px",
                        background: "rgba(10,5,27,0.85)",
                        border: "1px solid var(--border-glass)",
                        borderRadius: "50%",
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: "32px",
                        height: "32px",
                        boxShadow: "0 2px 10px rgba(0,0,0,0.3)"
                      }}
                      title="Add Workspace Member"
                    >
                      <UserPlus size={14} color="var(--secondary)" />
                    </button>

                    {/* Edit Camera Button */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingCamera(cam);
                        setEditForm({
                          name: cam.name,
                          rtspUrl: cam.rtsp_url,
                          zoneTag: cam.zone_tag || ""
                        });
                      }}
                      className="btn-secondary"
                      style={{
                        padding: "6px",
                        background: "rgba(10,5,27,0.85)",
                        border: "1px solid var(--border-glass)",
                        borderRadius: "50%",
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: "32px",
                        height: "32px",
                        boxShadow: "0 2px 10px rgba(0,0,0,0.3)"
                      }}
                      title="Edit Camera Details"
                    >
                      <Edit size={14} color="#38bdf8" />
                    </button>

                    {/* Maximize Button */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setMaximizedCameraId(cam.id);
                        setZoomScale(1);
                        setPanOffset({ x: 0, y: 0 });
                      }}
                      className="btn-secondary"
                      style={{
                        padding: "6px",
                        background: "rgba(10,5,27,0.85)",
                        border: "1px solid var(--border-glass)",
                        borderRadius: "50%",
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: "32px",
                        height: "32px",
                        boxShadow: "0 2px 10px rgba(0,0,0,0.3)"
                      }}
                      title="Maximize Camera"
                    >
                      <Maximize2 size={14} color="#fff" />
                    </button>

                    {/* Cancel/Remove Camera Button */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRemoveCamera(cam.id);
                      }}
                      className="btn-secondary"
                      style={{
                        padding: "6px",
                        background: "rgba(10,5,27,0.85)",
                        border: "1px solid var(--border-glass)",
                        borderRadius: "50%",
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: "32px",
                        height: "32px",
                        boxShadow: "0 2px 10px rgba(0,0,0,0.3)"
                      }}
                      title="Remove Camera"
                    >
                      <Trash2 size={14} color="var(--danger)" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Floating Inference Injector on the Bottom Left */}
      <div style={{
        position: "fixed",
        bottom: "24px",
        left: "24px",
        zIndex: 50
      }}>
        <button
          onClick={() => setShowSimPanel(!showSimPanel)}
          className="btn-secondary"
          style={{
            background: "rgba(10,5,27,0.85)",
            border: "1px solid var(--border-glass)",
            borderRadius: "var(--radius-lg)",
            padding: "0 18px",
            height: "48px",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            backdropFilter: "blur(10px)",
            boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
            fontWeight: 600,
            fontSize: "0.85rem",
            color: "var(--warning)"
          }}
        >
          <Activity size={16} />
          Inference Injector
        </button>
      </div>


      {/* Inference Injector Panel */}
      {showSimPanel && (
        <div style={{
          position: "fixed",
          bottom: "84px",
          left: "24px",
          width: "360px",
          zIndex: 60,
          padding: "24px"
        }} className="glass-panel glow-active">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
            <h3 style={{ fontSize: "1rem", fontWeight: 700, display: "flex", alignItems: "center", gap: "6px", color: "var(--warning)" }}>
              <ShieldAlert size={18} />
              YOLOv8 Inference Control
            </h3>
            <button onClick={() => setShowSimPanel(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)" }}>
              <X size={16} />
            </button>
          </div>

          {/* Camera selector */}
          <div className="form-group">
            <label className="form-label" style={{ fontSize: "0.75rem" }}>Monitor Camera Feed</label>
            <select
              value={simCameraId}
              onChange={(e) => setSimCameraId(e.target.value)}
              className="form-input"
              style={{ background: "#0a051b", fontSize: "0.85rem", padding: "8px 12px" }}
            >
              <option value="">All Cameras (auto-select)</option>
              {cameras.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>

          {/* Auto YOLO Scan Simulation Toggle */}
          <div className="form-group" style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "16px" }}>
            <input
              type="checkbox"
              id="isAutoDetectingCheckbox"
              checked={isAutoDetecting}
              onChange={(e) => setIsAutoDetecting(e.target.checked)}
              style={{ cursor: "pointer", width: "16px", height: "16px" }}
            />
            <label htmlFor="isAutoDetectingCheckbox" style={{ fontSize: "0.8rem", fontWeight: 600, cursor: "pointer", userSelect: "none", color: "var(--text-secondary)" }}>
              Enable Simulated Threat Auto-Injection
            </label>
          </div>

          {/* Sensitivity slider */}
          <div className="form-group">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "0.75rem", color: "var(--text-secondary)", marginBottom: "6px" }}>
              <span>Detection Sensitivity</span>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{
                  fontWeight: 700, fontSize: "0.7rem", padding: "2px 8px", borderRadius: "4px",
                  background: simConfidence >= 0.90 ? "rgba(239,68,68,0.2)" :
                              simConfidence >= 0.80 ? "rgba(249,115,22,0.2)" :
                              simConfidence >= 0.55 ? "rgba(234,179,8,0.2)" :
                              simConfidence >= 0.30 ? "rgba(59,130,246,0.2)" : "rgba(100,116,139,0.2)",
                  color: simConfidence >= 0.90 ? "var(--danger)" :
                         simConfidence >= 0.80 ? "#f97316" :
                         simConfidence >= 0.55 ? "#eab308" :
                         simConfidence >= 0.30 ? "#3b82f6" : "var(--text-muted)",
                  border: `1px solid ${
                    simConfidence >= 0.90 ? "rgba(239,68,68,0.4)" :
                    simConfidence >= 0.80 ? "rgba(249,115,22,0.4)" :
                    simConfidence >= 0.55 ? "rgba(234,179,8,0.4)" :
                    simConfidence >= 0.30 ? "rgba(59,130,246,0.4)" : "rgba(100,116,139,0.3)"
                  }`
                }}>
                  {simConfidence >= 0.90 ? "⚡ VIOLENCE" :
                   simConfidence >= 0.80 ? "🔥 FIRE" :
                   simConfidence >= 0.55 ? "🚨 TRESPASSING" :
                   simConfidence >= 0.30 ? "👁 LOITERING" : "✅ NORMAL"}
                </span>
                <span style={{ fontWeight: 600 }}>{(simConfidence * 100).toFixed(0)}%</span>
              </div>
            </div>
            <input
              type="range" min="0.10" max="1.00" step="0.05"
              value={simConfidence}
              onChange={(e) => {
                const val = Number(e.target.value);
                setSimConfidence(val);
                localStorage.setItem("simConfidence", String(val));
              }}
              style={{ width: "100%", accentColor: "var(--warning)" }}
            />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.6rem", color: "var(--text-muted)", marginTop: "4px" }}>
              <span style={{ color: "#3b82f6" }}>30% Loitering</span>
              <span style={{ color: "#eab308" }}>55% Trespassing</span>
              <span style={{ color: "#f97316" }}>80% Fire</span>
              <span style={{ color: "var(--danger)" }}>90% Violence</span>
            </div>
          </div>

          {/* Status row */}
          {isAutoDetecting && (
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px", fontSize: "0.72rem", color: "var(--text-secondary)" }}>
              <span style={{
                width: "8px", height: "8px", borderRadius: "50%",
                background: isSimulating ? "var(--warning)" : "var(--success)",
                boxShadow: isSimulating ? "0 0 6px var(--warning)" : "0 0 6px var(--success)",
                animation: "pulse 1.5s ease-in-out infinite"
              }} />
              {isSimulating ? "Verifying with Gemini..." : `Scanning every 12s${lastDetectionTime ? " · Last: " + lastDetectionTime : ""}`}
            </div>
          )}

          {/* OK Button */}
          <button
            onClick={() => {
              setShowSimPanel(false);
            }}
            className="btn-primary"
            style={{
              width: "100%",
              justifyContent: "center",
              padding: "10px",
              background: "linear-gradient(135deg, var(--warning), var(--accent))",
              boxShadow: "none"
            }}
          >
            OK
          </button>

          <p style={{ fontSize: "0.62rem", color: "var(--text-muted)", marginTop: "10px", textAlign: "center" }}>
            YOLO scans the live feed every 12s. Detections are sent to Gemini for verification.
            Only verified threats appear in notifications.
          </p>
        </div>
      )}

      {/* Add Member Slider Overlay */}
      {showMemberModal && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          zIndex: 100,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "rgba(10,5,27,0.5)",
          backdropFilter: "blur(4px)"
        }} onClick={() => setShowMemberModal(false)}>
          <div className="glass-panel" style={{ width: "400px", padding: "32px" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
              <h2 style={{ fontSize: "1.2rem", fontWeight: 700 }}>Add Responder</h2>
              <button onClick={() => setShowMemberModal(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)" }}>
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleAddMember}>
              <div className="form-group">
                <label className="form-label">Responder's Email</label>
                <input
                  type="email"
                  value={newMemberEmail}
                  onChange={(e) => setNewMemberEmail(e.target.value)}
                  placeholder="name@security-response.com"
                  className="form-input"
                  required
                />
              </div>

              <div className="form-group">
                <label className="form-label">Role</label>
                <select
                  value={newMemberRole}
                  onChange={(e) => setNewMemberRole(e.target.value)}
                  className="form-input"
                  style={{ background: "#0a051b" }}
                >
                  <option value="responder">Responder (Acknowledge threat)</option>
                  <option value="viewer">Viewer (Read-only monitor)</option>
                </select>
              </div>

              <button type="submit" className="btn-primary" style={{ width: "100%", justifyContent: "center" }}>
                Add to Workspace
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Edit Camera Modal */}
      {editingCamera && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          zIndex: 100,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "rgba(10,5,27,0.5)",
          backdropFilter: "blur(4px)"
        }} onClick={() => setEditingCamera(null)}>
          <div className="glass-panel" style={{ width: "450px", padding: "32px" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
              <h2 style={{ fontSize: "1.2rem", fontWeight: 700 }}>Edit Camera Feed</h2>
              <button onClick={() => setEditingCamera(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)" }}>
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleEditCameraSubmit}>
              <div className="form-group">
                <label className="form-label">Camera Name</label>
                <input
                  type="text"
                  value={editForm.name}
                  onChange={(e) => setEditForm(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="e.g. Front Door Camera"
                  className="form-input"
                  required
                />
              </div>

              <div className="form-group">
                <label className="form-label">Camera Feed IP Address / Stream URL</label>
                <input
                  type="text"
                  value={editForm.rtspUrl}
                  onChange={(e) => setEditForm(prev => ({ ...prev, rtspUrl: e.target.value }))}
                  placeholder="e.g. http://192.168.1.100:8080/video"
                  className="form-input"
                  required
                />
                <span style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginTop: "4px", display: "block" }}>
                  For local webcams, you can enter the camera index directly (e.g., "0" or "1").
                </span>
              </div>

              <div className="form-group">
                <label className="form-label">Zone Tag</label>
                <input
                  type="text"
                  value={editForm.zoneTag}
                  onChange={(e) => setEditForm(prev => ({ ...prev, zoneTag: e.target.value }))}
                  placeholder="e.g. Main Gate, Corridor"
                  className="form-input"
                />
              </div>

              <button type="submit" className="btn-primary" style={{ width: "100%", justifyContent: "center", marginTop: "10px" }}>
                Save Changes
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Incident Message Side-drawer (Bell Icon click) */}
      {showLogsDrawer && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          zIndex: 100,
          display: "flex",
          justifyContent: "flex-end",
          background: "rgba(10, 5, 27, 0.4)",
          backdropFilter: "blur(2px)"
        }} onClick={() => setShowLogsDrawer(false)}>
          <div 
            className="glass-panel" 
            style={{
              width: "440px",
              height: "100%",
              borderRadius: "0px",
              padding: "40px 24px",
              display: "flex",
              flexDirection: "column",
              boxShadow: "-10px 0 30px rgba(0,0,0,0.5)"
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "24px" }}>
              <h2 style={{ fontSize: "1.2rem", fontWeight: 700, display: "flex", alignItems: "center", gap: "8px" }}>
                <Bell size={20} color="var(--danger)" />
                Incident Log Drawer
              </h2>
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <button onClick={() => setShowLogsDrawer(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", display: "flex", alignItems: "center" }}>
                  <X size={20} />
                </button>
              </div>
            </div>

            {/* Date Search/Filter Bar */}
            <div style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              marginBottom: "12px",
              background: "rgba(255,255,255,0.02)",
              border: "1px solid var(--border-glass)",
              borderRadius: "var(--radius-md)",
              padding: "6px 12px"
            }}>
              <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)", fontWeight: 600 }}>Filter Date:</span>
              <input
                type="date"
                value={filterDate}
                onChange={(e) => setFilterDate(e.target.value)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#fff",
                  fontSize: "0.8rem",
                  outline: "none",
                  flex: 1,
                  colorScheme: "dark"
                }}
              />
              {filterDate && (
                <button
                  onClick={() => setFilterDate("")}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "var(--danger)",
                    fontSize: "0.75rem",
                    cursor: "pointer",
                    fontWeight: 600
                  }}
                >
                  Clear
                </button>
              )}
            </div>

            {/* Move All to Trash — placed near filter bar */}
            {alerts.filter(a => !a.is_trashed).length > 0 && (
              <button
                onClick={async () => {
                  if (!window.confirm("Are you sure you want to move all notifications to trash?")) return;
                  try {
                    await fetch(`${API_BASE}/api/projects/${id}/alerts/trash-all`, {
                      method: "PUT"
                    });
                    setAlerts(prev => prev.map(a => ({ ...a, is_trashed: true })));
                    setActiveAlerts({});
                  } catch (err) {
                    console.error("Failed to trash all alerts:", err);
                  }
                }}
                style={{
                  background: "rgba(239, 68, 68, 0.1)",
                  color: "var(--danger)",
                  border: "1px solid rgba(239, 68, 68, 0.25)",
                  borderRadius: "var(--radius-md)",
                  padding: "8px 14px",
                  fontSize: "0.75rem",
                  cursor: "pointer",
                  fontWeight: 700,
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  width: "100%",
                  marginBottom: "16px",
                  justifyContent: "center",
                  letterSpacing: "0.4px"
                }}
              >
                <Trash2 size={13} />
                Move All to Trash
              </button>
            )}

            <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: "16px" }}>
              {(() => {
                const filteredAlerts = alerts.filter(alert => {
                  if (alert.is_trashed) return false;
                  if (!filterDate) return true;
                  const d = parseUTCDate(alert.created_at || alert.timestamp);
                  if (!d) return true;
                  const year = d.getFullYear();
                  const month = String(d.getMonth() + 1).padStart(2, '0');
                  const day = String(d.getDate()).padStart(2, '0');
                  const formattedAlertDate = `${year}-${month}-${day}`;
                  return formattedAlertDate === filterDate;
                });

                // Sort by parsed timestamp descending to ensure the latest are always on top
                filteredAlerts.sort((a, b) => {
                  const getMs = (dateStr?: string) => {
                    const d = parseUTCDate(dateStr);
                    return d ? d.getTime() : 0;
                  };
                  return getMs(b.created_at || b.timestamp) - getMs(a.created_at || a.timestamp);
                });

                if (filteredAlerts.length === 0) {
                  return (
                    <div style={{ textAlign: "center", color: "var(--text-muted)", marginTop: "40px" }}>
                      <ShieldCheck size={36} color="var(--success)" style={{ marginBottom: "12px", display: "inline-block" }} />
                      <p style={{ fontSize: "0.85rem" }}>
                        {filterDate ? `No incidents logged on ${filterDate}.` : "Clear environment. No security threat anomalies verified today."}
                      </p>
                    </div>
                  );
                }

                return filteredAlerts.map((alert) => {
                  const isHighlighted = highlightedCamId === alert.camera_id;
                  
                  return (
                    <div 
                      key={alert.id} 
                      onClick={() => {
                        // Highlight corresponding video frame
                        setHighlightedCamId(alert.camera_id);
                        setTimeout(() => {
                          setHighlightedCamId(null);
                        }, 5000); // Highlight for 5 seconds

                        // Automatically resolve alert when viewed
                        if (!alert.is_resolved) {
                          handleResolveAlert(alert.id);
                        }
                      }}
                      className={`glass-panel ${isHighlighted ? "glow-active" : ""}`}
                      style={{
                        padding: "16px",
                        cursor: "pointer",
                        borderLeft: alert.is_resolved ? "4px solid var(--success)" : "4px solid var(--danger)",
                        background: alert.is_resolved ? "rgba(16,185,129,0.02)" : "rgba(239,68,68,0.03)"
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
                        <span style={{
                          fontWeight: 700,
                          fontSize: "0.8rem",
                          color: alert.is_resolved ? "var(--success)" : "var(--danger)"
                        }}>
                          {alert.is_resolved ? "RESOLVED THREAT" : "UNRESOLVED THREAT"}
                        </span>
                        <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
                          {formatDateTime(alert.timestamp || alert.created_at)}
                        </span>
                      </div>

                      <p style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-primary)" }}>
                        [{alert.camera_name || `Camera Feed`} - {alert.zone_tag || "General Area"}]
                      </p>
                      
                      <p style={{ fontSize: "0.75rem", color: "var(--text-secondary)", marginTop: "6px" }}>
                        {alert.threat_description.replace(" [Not Gemini Verified]", "")}
                      </p>
                      {alert.threat_description.includes("[Not Gemini Verified]") && (
                        <div style={{ color: "var(--danger)", fontSize: "0.7rem", fontWeight: 700, marginTop: "4px" }}>
                          ⚠️ Not Gemini Verified
                        </div>
                      )}

                      {alert.snapshot_url && (
                        <div 
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedEvidenceAlert(alert);
                          }}
                          style={{ marginTop: "10px", borderRadius: "var(--radius-sm)", overflow: "hidden", border: "1px solid var(--border-glass)", cursor: "zoom-in" }}
                          title="Open Evidence Modal"
                        >
                          <img 
                            src={getSnapshotUrl(alert.snapshot_url)} 
                            alt="Security Snapshot" 
                            style={{ width: "100%", height: "120px", objectFit: "cover" }}
                            onError={(e) => {
                              const fallback = getSnapshotFallbackUrl(alert);
                              if (fallback && (e.target as HTMLImageElement).src !== fallback) {
                                (e.target as HTMLImageElement).src = fallback;
                              }
                            }}
                          />
                        </div>
                      )}

                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "12px" }}>
                        <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
                          {alert.threat_description.includes("[Not Gemini Verified]") ? "Model Conf:" : "Gemini Conf:"} <strong style={{ color: "var(--primary)" }}>{(alert.confidence_score * 100).toFixed(0)}%</strong>
                        </span>
                        <div style={{ display: "flex", gap: "8px" }}>
                          {!alert.is_resolved && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleResolveAlert(alert.id);
                              }}
                              className="btn-primary"
                              style={{
                                padding: "4px 10px",
                                fontSize: "0.7rem",
                                borderRadius: "6px",
                                background: "var(--success)",
                                boxShadow: "none"
                              }}
                            >
                              Resolve Alert
                            </button>
                          )}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleTrashAlert(alert.id);
                            }}
                            style={{
                              background: "rgba(239, 68, 68, 0.1)",
                              border: "1px solid rgba(239, 68, 68, 0.2)",
                              cursor: "pointer",
                              color: "var(--danger)",
                              padding: "4px 10px",
                              borderRadius: "6px",
                              display: "flex",
                              alignItems: "center",
                              gap: "4px",
                              fontSize: "0.7rem",
                              fontWeight: 700
                            }}
                            title="Move to Trash"
                          >
                            <Trash2 size={12} />
                            Trash
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                });
              })()}
            </div>

            <button 
              onClick={() => setShowLogsDrawer(false)}
              className="btn-secondary"
              style={{ width: "100%", justifyContent: "center", marginTop: "24px" }}
            >
              Close Log Drawer
            </button>
          </div>
        </div>
      )}

      {/* Maximized Camera View Modal */}
      {maximizedCameraId && (() => {
        const maxCam = cameras.find(c => c.id === maximizedCameraId);
        if (!maxCam) return null;
        const activeAlert = activeAlerts[maxCam.id];

        return (
          <div ref={maximizedContainerRef} style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(3, 1, 10, 0.95)",
            backdropFilter: "blur(12px)",
            display: "flex",
            flexDirection: "column",
            zIndex: 9999,
            padding: "20px"
          }}>
            {/* HUD Top Control Bar */}
            <div style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: "16px",
              borderBottom: "1px solid var(--border-glass)",
              paddingBottom: "12px"
            }}>
              <div>
                <h3 style={{ fontSize: "1.1rem", fontWeight: 700, display: "flex", alignItems: "center", gap: "8px", color: "#fff" }}>
                  <span className="pulse-live-icon" style={{ width: "8px", height: "8px", borderRadius: "50%", background: "var(--danger)", display: "inline-block" }}></span>
                  {maxCam.name.toUpperCase()} — {maxCam.zone_tag.toUpperCase()}
                </h3>
                <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                  Maximized Mode — Click & drag video to pan when zoomed
                </span>
              </div>

              {/* Zoom & Panning toolbar */}
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <div style={{
                  background: "rgba(255,255,255,0.05)",
                  border: "1px solid var(--border-glass)",
                  padding: "4px 10px",
                  borderRadius: "var(--radius-md)",
                  fontSize: "0.8rem",
                  color: "var(--text-secondary)",
                  marginRight: "10px"
                }}>
                  Zoom: {(zoomScale * 100).toFixed(0)}%
                </div>

                <button 
                  onClick={handleZoomIn} 
                  className="btn-secondary" 
                  style={{ padding: "6px 12px" }}
                  title="Zoom In (+)"
                >
                  <ZoomIn size={16} />
                </button>

                <button 
                  onClick={handleZoomOut} 
                  className="btn-secondary" 
                  style={{ padding: "6px 12px" }}
                  title="Zoom Out (-)"
                >
                  <ZoomOut size={16} />
                </button>

                <button 
                  onClick={handleZoomReset} 
                  className="btn-secondary" 
                  style={{ padding: "6px 12px" }}
                  title="Reset Zoom (1x)"
                >
                  <RefreshCw size={14} />
                </button>

                <button 
                  onClick={() => setMaximizedCameraId(null)} 
                  className="btn-primary" 
                  style={{ padding: "6px 12px", background: "var(--danger)" }}
                  title="Close Screen"
                >
                  <X size={16} />
                </button>
              </div>
            </div>

            {/* Video Container (handles overflow for panning) */}
            <div 
              style={{
                flex: 1,
                position: "relative",
                overflow: "hidden",
                background: "#000",
                borderRadius: "var(--radius-lg)",
                border: activeAlert ? "2px solid var(--danger)" : "1px solid var(--border-glass)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: zoomScale > 1 ? (isDragging ? "grabbing" : "grab") : "default"
              }}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUpOrLeave}
              onMouseLeave={handleMouseUpOrLeave}
              onWheel={handleWheel}
            >
              {/* Canvas element clone inside maximized viewport */}
              <canvas
                ref={(el) => { if (el) canvasRefs.current[`max-${maxCam.id}`] = el; }}
                width={960}
                height={540}
                style={{
                  width: "100%",
                  maxHeight: "100%",
                  aspectRatio: "16/9",
                  transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoomScale})`,
                  transformOrigin: "center center",
                  transition: isDragging ? "none" : "transform 0.15s cubic-bezier(0.1, 0.8, 0.25, 1)",
                  display: "block"
                }}
              />

              {/* Anomaly warning overlay inside maximized frame */}
              {activeAlert && (
                <div style={{
                  position: "absolute",
                  bottom: "20px",
                  left: "20px",
                  right: "20px",
                  background: "rgba(239, 68, 68, 0.95)",
                  border: "1px solid var(--danger)",
                  padding: "16px 20px",
                  borderRadius: "var(--radius-md)",
                  color: "#fff",
                  boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
                  zIndex: 20
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontWeight: 700 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                      <ShieldAlert size={20} />
                      <span>
                        {activeAlert.threat_description.includes("[Not Gemini Verified]") 
                          ? "UNVERIFIED THREAT (SIMULATION FALLBACK)" 
                          : "CRITICAL SURVEILLANCE ANOMALY DETECTED"}
                      </span>
                    </div>
                    <div style={{ display: "flex", gap: "8px" }}>
                      <button
                        onClick={async (e) => {
                          e.stopPropagation();
                          if (!window.confirm("Are you sure you want to move ALL notifications to trash?")) return;
                          try {
                            await fetch(`${API_BASE}/api/projects/${id}/alerts/trash-all`, {
                              method: "PUT"
                            });
                            setAlerts(prev => prev.map(a => ({ ...a, is_trashed: true })));
                            setActiveAlerts({});
                          } catch (err) {
                            console.error("Failed to trash all alerts:", err);
                          }
                        }}
                        style={{
                          background: "rgba(239, 68, 68, 0.25)",
                          border: "1px solid rgba(239, 68, 68, 0.4)",
                          cursor: "pointer",
                          color: "#fff",
                          padding: "4px 12px",
                          borderRadius: "var(--radius-sm)",
                          display: "flex",
                          alignItems: "center",
                          gap: "6px",
                          fontSize: "0.75rem",
                          fontWeight: 700
                        }}
                        title="Move All Snapshots to Trash"
                      >
                        <Trash2 size={12} />
                        Move All to Trash
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleTrashAlert(activeAlert.alert_id);
                        }}
                        style={{
                          background: "rgba(0, 0, 0, 0.25)",
                          border: "1px solid rgba(255, 255, 255, 0.2)",
                          cursor: "pointer",
                          color: "#fff",
                          padding: "4px 12px",
                          borderRadius: "var(--radius-sm)",
                          display: "flex",
                          alignItems: "center",
                          gap: "6px",
                          fontSize: "0.75rem",
                          fontWeight: 700
                        }}
                        title="Move Snapshot to Trash"
                      >
                        <Trash2 size={12} />
                        Move to Trash
                      </button>
                    </div>
                  </div>
                  <p style={{ marginTop: "6px", fontSize: "0.85rem", opacity: 0.95 }}>
                    {activeAlert.threat_description.replace(" [Not Gemini Verified]", "")}
                    {activeAlert.threat_description.includes("[Not Gemini Verified]") && (
                      <span style={{ display: "block", color: "#fca5a5", fontSize: "0.75rem", fontWeight: 700, marginTop: "4px" }}>
                        ⚠️ NOT GEMINI VERIFIED (OFFLINE SIMULATION FALLBACK)
                      </span>
                    )}
                  </p>
                </div>
              )}
            </div>
          </div>
        );
      })()}
      {/* Dynamic Pop-up Alert Message for Unusual Behavior */}
      {activePopupAlert && (
        <div style={{
          position: "fixed",
          bottom: "30px",
          right: "30px",
          width: "380px",
          background: "rgba(12, 7, 33, 0.95)",
          border: "2px solid var(--danger)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "0 20px 40px rgba(0, 0, 0, 0.6), 0 0 20px rgba(239, 68, 68, 0.2)",
          zIndex: 9999,
          padding: "20px",
          color: "#fff",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
          backdropFilter: "blur(12px)"
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", borderBottom: "1px solid rgba(239, 68, 68, 0.3)", paddingBottom: "10px" }}>
            <ShieldAlert size={22} color="var(--danger)" />
            <span style={{ fontWeight: 800, fontSize: "0.95rem", letterSpacing: "0.5px", color: "var(--danger)" }}>
              UNUSUAL BEHAVIOR DETECTED
            </span>
          </div>
          
          <div style={{ display: "flex", gap: "12px" }}>
            {activePopupAlert.snapshot_url && (
              <img 
                src={getSnapshotUrl(activePopupAlert.snapshot_url)} 
                alt="Threat Snapshot" 
                style={{
                  width: "90px",
                  height: "70px",
                  objectFit: "cover",
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--border-glass)"
                }}
                onError={(e) => {
                  const fallback = getSnapshotFallbackUrl(activePopupAlert);
                  if (fallback && (e.target as HTMLImageElement).src !== fallback) {
                    (e.target as HTMLImageElement).src = fallback;
                  }
                }}
              />
            )}
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: "0.85rem", fontWeight: 700, color: "#fff" }}>
                {activePopupAlert.camera_name || "Camera Feed"}
              </div>
              <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginTop: "2px" }}>
                Zone: {activePopupAlert.zone_tag || "General Area"}
              </div>
              <p style={{ fontSize: "0.75rem", color: "var(--text-secondary)", marginTop: "6px", lineHeight: "1.3" }}>
                {activePopupAlert.threat_description.replace(" [Not Gemini Verified]", "").length > 90 
                  ? `${activePopupAlert.threat_description.replace(" [Not Gemini Verified]", "").slice(0, 90)}...` 
                  : activePopupAlert.threat_description.replace(" [Not Gemini Verified]", "")}
              </p>
              {activePopupAlert.threat_description.includes("[Not Gemini Verified]") && (
                <span style={{ color: "#fca5a5", fontSize: "0.7rem", fontWeight: 700 }}>
                  ⚠️ Not Gemini Verified
                </span>
              )}
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "4px" }}>
            {!maximizedCameraId && (
              <button
                onClick={() => {
                  if (activePopupAlert) {
                    const camId = activePopupAlert.camera_id;
                    const alertId = activePopupAlert.alert_id || activePopupAlert.id;
                    if (alertId) {
                      dismissedAlertIdsRef.current[alertId] = true;
                    }
                    setActiveAlerts(prev => {
                      const copy = { ...prev };
                      delete copy[camId];
                      return copy;
                    });
                  }
                  setActivePopupAlert(null);
                }}
                className="btn-secondary"
                style={{
                  padding: "6px 14px",
                  fontSize: "0.75rem",
                  borderRadius: "var(--radius-sm)",
                  borderColor: "rgba(255,255,255,0.1)"
                }}
              >
                Cancel
              </button>
            )}
            <button
              onClick={() => {
                setShowLogsDrawer(true);
                setActivePopupAlert(null);
              }}
              className="btn-primary"
              style={{
                padding: "6px 14px",
                fontSize: "0.75rem",
                borderRadius: "var(--radius-sm)",
                background: "var(--danger)",
                borderColor: "var(--danger)"
              }}
            >
              View
            </button>
          </div>
        </div>
      )}

      {/* Evidence Report Full-screen Modal Overlay */}
      {selectedEvidenceAlert && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          zIndex: 20000,
          background: "rgba(3, 1, 10, 0.95)",
          backdropFilter: "blur(20px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "32px"
        }} onClick={() => setSelectedEvidenceAlert(null)}>
          <div 
            className="glass-panel" 
            style={{
              width: "900px",
              maxWidth: "100%",
              background: "rgba(10,5,27,0.75)",
              border: "1px solid var(--border-glass)",
              borderRadius: "var(--radius-lg)",
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
              boxShadow: "0 25px 50px rgba(0,0,0,0.6)"
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "20px 24px",
              borderBottom: "1px solid var(--border-glass)"
            }}>
              <h2 style={{ fontSize: "1.1rem", fontWeight: 800, display: "flex", alignItems: "center", gap: "10px", color: "var(--danger)" }}>
                <ShieldAlert size={20} />
                SURVEILLANCE EVIDENCE AUDIT REPORT
              </h2>
              <button 
                onClick={() => setSelectedEvidenceAlert(null)} 
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", display: "flex", alignItems: "center" }}
              >
                <X size={20} />
              </button>
            </div>

            {/* Split layout: Snapshot & Metadata details */}
            <div style={{ display: "flex", flex: 1, minHeight: "450px" }}>
              {/* Left Column: Native resolution snapshot frame */}
              <div style={{
                flex: 1.5,
                background: "#000",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRight: "1px solid var(--border-glass)",
                position: "relative"
              }}>
                <img 
                  src={getSnapshotUrl(selectedEvidenceAlert.snapshot_url)} 
                  alt="Incident Evidence Raw Snapshot" 
                  style={{
                    maxWidth: "100%",
                    maxHeight: "480px",
                    objectFit: "contain",
                    display: "block"
                  }}
                  onError={(e) => {
                    const fallback = getSnapshotFallbackUrl(selectedEvidenceAlert);
                    if (fallback && (e.target as HTMLImageElement).src !== fallback) {
                      (e.target as HTMLImageElement).src = fallback;
                    }
                  }}
                />
                <div style={{
                  position: "absolute",
                  bottom: "12px",
                  left: "12px",
                  background: "rgba(0,0,0,0.75)",
                  padding: "4px 8px",
                  borderRadius: "4px",
                  fontSize: "0.65rem",
                  color: "var(--text-muted)"
                }}>
                  NATIVE CAPTURE RESOLUTION (JPEG 90% QUALITY)
                </div>
              </div>

              {/* Right Column: Evidence details panel */}
              <div style={{
                flex: 1,
                padding: "24px",
                display: "flex",
                flexDirection: "column",
                gap: "20px"
              }}>
                <div>
                  <h3 style={{ fontSize: "0.72rem", color: "var(--text-muted)", fontWeight: 700, letterSpacing: "1px", textTransform: "uppercase" }}>Camera Feed</h3>
                  <p style={{ fontSize: "0.95rem", fontWeight: 700, marginTop: "4px" }}>{selectedEvidenceAlert.camera_name || "Camera Ingestion Stream"}</p>
                </div>

                <div>
                  <h3 style={{ fontSize: "0.72rem", color: "var(--text-muted)", fontWeight: 700, letterSpacing: "1px", textTransform: "uppercase" }}>Zone Location</h3>
                  <span style={{
                    display: "inline-block",
                    background: "rgba(139, 92, 246, 0.15)",
                    border: "1px solid var(--primary)",
                    color: "var(--primary)",
                    padding: "3px 8px",
                    borderRadius: "4px",
                    fontSize: "0.72rem",
                    fontWeight: 700,
                    marginTop: "6px"
                  }}>
                    {selectedEvidenceAlert.zone_tag || "General Zone"}
                  </span>
                </div>

                <div>
                  <h3 style={{ fontSize: "0.72rem", color: "var(--text-muted)", fontWeight: 700, letterSpacing: "1px", textTransform: "uppercase" }}>Timestamp</h3>
                  <p style={{ fontSize: "0.85rem", marginTop: "4px", color: "var(--text-secondary)" }}>
                    {formatDateTime(selectedEvidenceAlert.timestamp || selectedEvidenceAlert.created_at)}
                  </p>
                </div>

                <div>
                  <h3 style={{ fontSize: "0.72rem", color: "var(--text-muted)", fontWeight: 700, letterSpacing: "1px", textTransform: "uppercase" }}>Gemini Verification details</h3>
                  <p style={{ fontSize: "0.82rem", color: "#fff", marginTop: "6px", background: "rgba(255,255,255,0.02)", border: "1px solid var(--border-glass)", padding: "10px 12px", borderRadius: "6px", lineHeight: "1.4" }}>
                    {selectedEvidenceAlert.threat_description}
                  </p>
                </div>

                <div>
                  <h3 style={{ fontSize: "0.72rem", color: "var(--text-muted)", fontWeight: 700, letterSpacing: "1px", textTransform: "uppercase" }}>Confidence Scores</h3>
                  <div style={{ display: "flex", gap: "16px", marginTop: "8px" }}>
                    <div style={{ flex: 1, background: "rgba(255,255,255,0.02)", border: "1px solid var(--border-glass)", padding: "8px 12px", borderRadius: "6px", textAlign: "center" }}>
                      <div style={{ fontSize: "0.62rem", color: "var(--text-muted)" }}>YOLOv8 Edge</div>
                      <div style={{ fontSize: "1.1rem", fontWeight: 800, color: "var(--warning)", marginTop: "2px" }}>
                        {selectedEvidenceAlert.confidence_score ? `${(selectedEvidenceAlert.confidence_score * 100).toFixed(0)}%` : "N/A"}
                      </div>
                    </div>
                    <div style={{ flex: 1, background: "rgba(255,255,255,0.02)", border: "1px solid var(--border-glass)", padding: "8px 12px", borderRadius: "6px", textAlign: "center" }}>
                      <div style={{ fontSize: "0.62rem", color: "var(--text-muted)" }}>Gemini AI</div>
                      <div style={{ fontSize: "1.1rem", fontWeight: 800, color: "var(--primary)", marginTop: "2px" }}>
                        {selectedEvidenceAlert.threat_description.includes("[Not Gemini Verified]") ? "N/A" : (selectedEvidenceAlert.confidence_score ? `${(selectedEvidenceAlert.confidence_score * 100).toFixed(0)}%` : "N/A")}
                      </div>
                    </div>
                  </div>
                </div>

                <div style={{ flex: 1 }}></div>

                {/* Audit Actions */}
                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                  <button 
                    onClick={() => handleDownloadSnapshot(selectedEvidenceAlert)}
                    className="btn-primary"
                    style={{ justifyContent: "center", width: "100%", padding: "12px", gap: "8px" }}
                  >
                    Download Raw Evidence (JPEG)
                  </button>
                  <div style={{ display: "flex", gap: "10px" }}>
                    {!selectedEvidenceAlert.is_resolved && (
                      <button 
                        onClick={() => {
                          handleResolveAlert(selectedEvidenceAlert.id);
                          setSelectedEvidenceAlert(null);
                        }}
                        className="btn-secondary"
                        style={{ flex: 1, justifyContent: "center", background: "var(--success)", borderColor: "var(--success)" }}
                      >
                        Resolve
                      </button>
                    )}
                    <button 
                      onClick={() => {
                        handleTrashAlert(selectedEvidenceAlert.id);
                        setSelectedEvidenceAlert(null);
                      }}
                      className="btn-secondary"
                      style={{ flex: 1, justifyContent: "center", background: "rgba(239, 68, 68, 0.1)", borderColor: "rgba(239, 68, 68, 0.25)", color: "var(--danger)" }}
                    >
                      Move to Trash
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
