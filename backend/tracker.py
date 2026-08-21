"""
YOLOv8 Behavior Tracker Engine
===============================
Runs YOLOv8 Nano (yolov8n.pt) with ByteTrack for persistent object tracking.
Detects: Person (class 0), Cell Phone (class 67).
Analyzes behaviors: Running, Loitering, Fighting/Suspicious, Mobile Phone Use (school only).

Frame input is resized to 320x320 for fast inference.
Bounding box coordinates are scaled back to native resolution for rendering.
"""

import os
import sys
import time
import contextlib
import numpy as np
from collections import defaultdict, deque
from typing import List, Dict, Tuple, Optional
import torch
torch.set_num_threads(1)

# Thread-safe context manager
@contextlib.contextmanager
def suppress_stdout_stderr():
    yield

# YOLO Configuration from environment
YOLO_MODEL = os.getenv("YOLO_MODEL", "yolov8n.pt")
YOLO_CONFIDENCE = float(os.getenv("YOLO_CONFIDENCE", "0.4"))
INFERENCE_SIZE = 320  # Resize to 320x320 for inference

# Behavior detection thresholds
SPEED_THRESHOLD = 15.0       # px/frame for running detection
SPEED_WINDOW = 5             # frames to measure speed
LOITER_STD_THRESHOLD = 15.0  # px std-dev for loitering
LOITER_WINDOW = 15           # frames for loitering detection
PROXIMITY_THRESHOLD = 100.0  # px for fighting/suspicious detection
PHONE_PROXIMITY = 150.0      # px for phone-near-person detection

# Detected class IDs
CLASS_PERSON = 0
CLASS_PHONE = 67
TRACKED_CLASSES = [CLASS_PERSON, CLASS_PHONE]


class BehaviorTracker:
    """
    YOLOv8 Nano tracking engine with behavior analysis.
    
    Usage:
        tracker = BehaviorTracker()
        detections = tracker.process_frame(frame, project_type="school")
    """

    def __init__(self, model_path: str = None):
        self.model_path = model_path or YOLO_MODEL
        self.model = None
        self.half_precision = torch.cuda.is_available()
        self._load_model()

        # Track history: track_id -> deque of (cx, cy, timestamp)
        self.track_history: Dict[int, deque] = defaultdict(lambda: deque(maxlen=max(LOITER_WINDOW, SPEED_WINDOW, 20)))
        # Track class mapping: track_id -> class_id
        self.track_classes: Dict[int, int] = {}

    def _load_model(self):
        """Load YOLOv8 model. Auto-downloads yolov8n.pt on first run."""
        try:
            from ultralytics import YOLO
            print(f"[Tracker] Loading YOLOv8 model: {self.model_path}")
            self.model = YOLO(self.model_path)
            # Warm up with a dummy frame
            dummy = np.zeros((INFERENCE_SIZE, INFERENCE_SIZE, 3), dtype=np.uint8)
            
            current_dir = os.path.dirname(os.path.abspath(__file__))
            custom_tracker = os.path.join(current_dir, "custom_bytetrack.yaml")

            with suppress_stdout_stderr():
                kwargs = {
                    "persist": True, 
                    "verbose": False, 
                    "classes": TRACKED_CLASSES, 
                    "conf": YOLO_CONFIDENCE, 
                    "imgsz": INFERENCE_SIZE,
                    "tracker": custom_tracker
                }
                if self.half_precision:
                    kwargs["half"] = True
                self.model.track(dummy, **kwargs)
            print(f"[Tracker] YOLOv8 model loaded and warmed up successfully.")
        except Exception as e:
            print(f"[Tracker] ERROR loading YOLO model: {e}")
            self.model = None

    def process_frame(
        self,
        frame: np.ndarray,
        project_type: str = "home"
    ) -> List[Dict]:
        """
        Process a single frame through YOLOv8 tracking and behavior analysis.

        Args:
            frame: BGR numpy array at native resolution (e.g. 1920x1080)
            project_type: "school", "home", or "government" — controls phone detection

        Returns:
            List of detection dicts, each containing:
                - track_id: int
                - class_id: int (0=person, 67=phone)
                - class_name: str
                - bbox: (x1, y1, x2, y2) in native resolution coordinates
                - confidence: float
                - behaviors: list of behavior strings detected for this track
                - anomaly_type: str or None — the primary anomaly if any
        """
        if self.model is None:
            return []

        native_h, native_w = frame.shape[:2]
        detections = []

        try:
            current_dir = os.path.dirname(os.path.abspath(__file__))
            custom_tracker = os.path.join(current_dir, "custom_bytetrack.yaml")

            # Run YOLOv8 tracking (model internally resizes to INFERENCE_SIZE)
            with suppress_stdout_stderr():
                kwargs = {
                    "persist": True,
                    "verbose": False,
                    "classes": TRACKED_CLASSES,
                    "conf": YOLO_CONFIDENCE,
                    "imgsz": INFERENCE_SIZE,
                    "tracker": custom_tracker
                }
                if self.half_precision:
                    kwargs["half"] = True
                results = self.model.track(frame, **kwargs)

            if not results or len(results) == 0:
                return []

            result = results[0]
            if result.boxes is None or len(result.boxes) == 0:
                return []

            boxes = result.boxes
            # Extract data
            xyxy_all = boxes.xyxy.cpu().numpy()       # (N, 4) in native resolution (YOLO auto-scales back)
            conf_all = boxes.conf.cpu().numpy()        # (N,)
            cls_all = boxes.cls.cpu().numpy().astype(int)  # (N,)

            # Track IDs (may be None if tracking fails on some frames)
            if boxes.id is not None:
                ids_all = boxes.id.cpu().numpy().astype(int)
            else:
                ids_all = np.arange(len(xyxy_all))  # Fallback: sequential IDs

            # Build detection list and update history
            person_detections = []
            phone_detections = []

            for i in range(len(xyxy_all)):
                x1, y1, x2, y2 = xyxy_all[i]
                conf = float(conf_all[i])
                cls_id = int(cls_all[i])
                track_id = int(ids_all[i])

                cx = (x1 + x2) / 2.0
                cy = (y1 + y2) / 2.0

                # Update track history
                self.track_history[track_id].append((cx, cy, time.time()))
                self.track_classes[track_id] = cls_id

                det = {
                    "track_id": track_id,
                    "class_id": cls_id,
                    "class_name": "person" if cls_id == CLASS_PERSON else "cell phone",
                    "bbox": (float(x1), float(y1), float(x2), float(y2)),
                    "center": (cx, cy),
                    "confidence": conf,
                    "behaviors": [],
                    "anomaly_type": None
                }

                if cls_id == CLASS_PERSON:
                    person_detections.append(det)
                elif cls_id == CLASS_PHONE:
                    phone_detections.append(det)

                detections.append(det)

            # ─── Behavior Analysis for Persons ───────────────────────────────

            for det in person_detections:
                tid = det["track_id"]
                history = self.track_history[tid]

                # 1. Running Detection: speed > 15.0 px/frame over 5-frame window
                if len(history) >= SPEED_WINDOW:
                    recent = list(history)[-SPEED_WINDOW:]
                    speeds = []
                    for j in range(1, len(recent)):
                        dx = recent[j][0] - recent[j - 1][0]
                        dy = recent[j][1] - recent[j - 1][1]
                        speed = np.sqrt(dx ** 2 + dy ** 2)
                        speeds.append(speed)
                    avg_speed = np.mean(speeds) if speeds else 0
                    if avg_speed > SPEED_THRESHOLD:
                        det["behaviors"].append("running")

                # 2. Loitering Detection: std-dev of position < 15.0 px over 15 frames
                if len(history) >= LOITER_WINDOW:
                    recent = list(history)[-LOITER_WINDOW:]
                    xs = [p[0] for p in recent]
                    ys = [p[1] for p in recent]
                    pos_std = np.sqrt(np.std(xs) ** 2 + np.std(ys) ** 2)
                    if pos_std < LOITER_STD_THRESHOLD:
                        det["behaviors"].append("loitering")

                # 3. Looking Sideways (Exam Mode): SCHOOL ONLY — std-dev x > 5.0 and y < 2.0 over 20 frames
                if project_type == "school" and len(history) >= 20:
                    recent = list(history)[-20:]
                    xs = [p[0] for p in recent]
                    ys = [p[1] for p in recent]
                    std_x = np.std(xs)
                    std_y = np.std(ys)
                    if std_x > 5.0 and std_y < 2.0:
                        det["behaviors"].append("looking_sideways")

            # 4. Proximity checking: two persons within 100 px
            # School mode -> Talking/Lean, Home/Government -> Fighting/Suspicious
            for i_idx in range(len(person_detections)):
                for j_idx in range(i_idx + 1, len(person_detections)):
                    p1 = person_detections[i_idx]
                    p2 = person_detections[j_idx]
                    dist = np.sqrt(
                        (p1["center"][0] - p2["center"][0]) ** 2 +
                        (p1["center"][1] - p2["center"][1]) ** 2
                    )
                    if dist < PROXIMITY_THRESHOLD:
                        label_name = "talking" if project_type == "school" else "fighting"
                        if label_name not in p1["behaviors"]:
                            p1["behaviors"].append(label_name)
                        if label_name not in p2["behaviors"]:
                            p2["behaviors"].append(label_name)

            # 5. Mobile Phone Use: SCHOOL ONLY — phone within 150 px of person center
            if project_type == "school":
                for phone_det in phone_detections:
                    phone_cx, phone_cy = phone_det["center"]
                    for person_det in person_detections:
                        person_cx, person_cy = person_det["center"]
                        dist = np.sqrt(
                            (phone_cx - person_cx) ** 2 +
                            (phone_cy - person_cy) ** 2
                        )
                        if dist < PHONE_PROXIMITY:
                            if "phone_use" not in person_det["behaviors"]:
                                person_det["behaviors"].append("phone_use")
                            # Also tag the phone detection
                            if "phone_use" not in phone_det["behaviors"]:
                                phone_det["behaviors"].append("phone_use")

            # ─── Set primary anomaly_type ─────────────────────────────────────
            # Priority: fighting > talking > looking_sideways > running > phone_use > loitering
            priority = ["fighting", "talking", "looking_sideways", "running", "phone_use", "loitering"]
            for det in detections:
                if det["behaviors"]:
                    for p in priority:
                        if p in det["behaviors"]:
                            det["anomaly_type"] = p
                            break

        except Exception as e:
            print(f"[Tracker] Error processing frame: {e}")

        return detections

    def draw_annotations(
        self,
        frame: np.ndarray,
        detections: List[Dict],
        alert_text: Optional[str] = None
    ) -> np.ndarray:
        """
        Draw bounding boxes and labels on the frame.
        Green for persons, Blue for objects (phones).
        Red ALERT overlay if any anomaly detected.

        Args:
            frame: BGR numpy array (native resolution)
            detections: List from process_frame()
            alert_text: Optional override alert text

        Returns:
            Annotated BGR numpy array
        """
        import cv2
        annotated = frame.copy()
        has_anomaly = False
        anomaly_descriptions = []

        for det in detections:
            x1, y1, x2, y2 = [int(v) for v in det["bbox"]]
            cls_id = det["class_id"]
            conf = det["confidence"]
            track_id = det["track_id"]
            behaviors = det["behaviors"]

            # Color: green for person, blue for phone
            if cls_id == CLASS_PERSON:
                color = (0, 200, 0)  # Green BGR
            else:
                color = (200, 100, 0)  # Blue BGR

            # If anomaly, use red border
            if behaviors:
                color = (0, 0, 255)  # Red BGR
                has_anomaly = True

            # Draw bounding box
            cv2.rectangle(annotated, (x1, y1), (x2, y2), color, 2)

            # Label
            label = f"{det['class_name']} #{track_id} {conf:.2f}"
            if behaviors:
                label += f" [{', '.join(behaviors)}]"
                anomaly_descriptions.append(f"{det['class_name']} #{track_id}: {', '.join(behaviors)}")

            # Draw label background
            (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.45, 1)
            cv2.rectangle(annotated, (x1, y1 - th - 6), (x1 + tw + 4, y1), color, -1)
            cv2.putText(annotated, label, (x1 + 2, y1 - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1, cv2.LINE_AA)

        # Red ALERT overlay at top-left if anomaly detected
        if has_anomaly:
            display_text = alert_text or "ALERT: " + "; ".join(anomaly_descriptions[:2])
            # Semi-transparent red bar
            overlay = annotated.copy()
            cv2.rectangle(overlay, (0, 0), (annotated.shape[1], 40), (0, 0, 180), -1)
            cv2.addWeighted(overlay, 0.6, annotated, 0.4, 0, annotated)
            cv2.putText(annotated, display_text[:120], (10, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (255, 255, 255), 2, cv2.LINE_AA)

        return annotated

    def get_anomalies(self, detections: List[Dict]) -> List[Dict]:
        """
        Extract only detections that have anomalies.

        Returns list of dicts with:
            - anomaly_type: str
            - description: str
            - confidence: float
            - track_id: int
            - bbox: tuple
        """
        anomalies = []
        for det in detections:
            if det["anomaly_type"]:
                desc_map = {
                    "running": f"Person #{det['track_id']} running at high speed in monitored zone.",
                    "loitering": f"Person #{det['track_id']} loitering — stationary for extended period.",
                    "fighting": f"Persons in close proximity — potential physical altercation detected.",
                    "phone_use": f"Mobile phone detected near person #{det['track_id']} — unauthorized device usage."
                }
                anomalies.append({
                    "anomaly_type": det["anomaly_type"],
                    "description": desc_map.get(det["anomaly_type"], f"Abnormal behavior: {det['anomaly_type']}"),
                    "confidence": det["confidence"],
                    "track_id": det["track_id"],
                    "bbox": det["bbox"],
                    "behaviors": det["behaviors"]
                })
        return anomalies

    def cleanup(self):
        """Clean up old track history for tracks not seen recently."""
        now = time.time()
        stale_ids = []
        for tid, history in self.track_history.items():
            if history and (now - history[-1][2]) > 10.0:  # 10s timeout
                stale_ids.append(tid)
        for tid in stale_ids:
            del self.track_history[tid]
            self.track_classes.pop(tid, None)
