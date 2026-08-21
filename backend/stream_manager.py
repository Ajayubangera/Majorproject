"""
Camera Stream Manager
======================
Per-camera background threads for frame capture, YOLO inference, and MJPEG streaming.

Supports:
- MJPEGStream: HTTP/HTTPS MJPEG streams (fast exponential-backoff reconnect)
- CVStream: RTSP/USB via OpenCV (fast exponential-backoff reconnect, low-latency flags)

Frame Pipeline:
1. Capture at native resolution (720p/1080p)
2. Every 0.15s (~6.7 Hz): YOLO inference on 320x320 resize
3. On anomaly: save original snapshot from ring buffer → trigger Gemini verification
4. Annotated frames served at 30 FPS via MJPEG endpoint

Snapshot Quality: JPEG 90% quality at native resolution.
"""

import os
import io
import cv2
import time
import uuid
import threading
import asyncio
import numpy as np
from typing import Dict, Optional, Callable
from collections import defaultdict, deque

from tracker import BehaviorTracker

# Configuration
JPEG_QUALITY = 90                        # Snapshot quality (anomaly evidence) — full fidelity
STREAM_JPEG_QUALITY = 90                 # Display stream quality — visually identical, 3-4x faster to encode
STREAM_MAX_HEIGHT = 1080                 # Keep display stream at 1080p
STREAM_FPS = 30                          # Display rate: 30 FPS
INFERENCE_INTERVAL = float(os.getenv("YOLO_INFERENCE_INTERVAL", "0.15"))  # AI tracking: every 0.15s (~6.7 Hz)

# Exponential backoff reconnect (applies to both MJPEG and RTSP/USB)
RECONNECT_BACKOFF_STEPS = [0.5, 1.0, 2.0]  # seconds: fast retry → capped backoff

NO_SIGNAL_WIDTH = 640
NO_SIGNAL_HEIGHT = 480

# Snapshot storage base
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
SNAPSHOTS_DIR = os.path.join(STATIC_DIR, "snapshots")


def generate_no_signal_frame() -> np.ndarray:
    """Generate a clean 640x480 'NO SIGNAL / CHECK CONNECTION' frame."""
    frame = np.zeros((NO_SIGNAL_HEIGHT, NO_SIGNAL_WIDTH, 3), dtype=np.uint8)
    frame[:] = (20, 10, 5)  # Very dark blue-black

    # Grid pattern
    for x in range(0, NO_SIGNAL_WIDTH, 20):
        cv2.line(frame, (x, 0), (x, NO_SIGNAL_HEIGHT), (30, 20, 15), 1)
    for y in range(0, NO_SIGNAL_HEIGHT, 20):
        cv2.line(frame, (0, y), (NO_SIGNAL_WIDTH, y), (30, 20, 15), 1)

    # NO SIGNAL text
    cv2.putText(frame, "NO SIGNAL", (NO_SIGNAL_WIDTH // 2 - 120, NO_SIGNAL_HEIGHT // 2 - 10),
                cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 0, 200), 3, cv2.LINE_AA)

    # CHECK CONNECTION text
    cv2.putText(frame, "CHECK CONNECTION", (NO_SIGNAL_WIDTH // 2 - 130, NO_SIGNAL_HEIGHT // 2 + 30),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (150, 150, 200), 1, cv2.LINE_AA)

    return frame


def encode_jpeg(frame: np.ndarray, quality: int = JPEG_QUALITY) -> bytes:
    """Encode a BGR frame to JPEG bytes at specified quality."""
    encode_params = [cv2.IMWRITE_JPEG_QUALITY, quality]
    success, encoded = cv2.imencode('.jpg', frame, encode_params)
    if success:
        return encoded.tobytes()
    return b""


def encode_stream_jpeg(frame: np.ndarray) -> bytes:
    """Encode a frame for display streaming at native quality (unchanged)."""
    return encode_jpeg(frame, STREAM_JPEG_QUALITY)


class CameraStreamWorker:
    """
    Background thread worker for a single camera.
    Captures frames, runs YOLO inference, and provides annotated frames for streaming.
    """

    def __init__(
        self,
        camera_id: str,
        camera_name: str,
        rtsp_url: str,
        project_id: str,
        project_type: str,
        zone_tag: str = "",
        on_anomaly_callback: Optional[Callable] = None
    ):
        self.camera_id = camera_id
        self.camera_name = camera_name
        self.rtsp_url = rtsp_url
        self.project_id = project_id
        self.project_type = project_type
        self.zone_tag = zone_tag
        self.on_anomaly_callback = on_anomaly_callback  # Called when anomaly detected

        # Thread control
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._inference_thread: Optional[threading.Thread] = None
        self._inference_trigger = threading.Event()
        self._lock = threading.Lock()

        # Frame buffers (thread-safe access)
        self._latest_annotated_jpeg: bytes = encode_jpeg(generate_no_signal_frame())
        self._latest_raw_frame: Optional[np.ndarray] = None
        self._is_connected = False
        self._frame_version: int = 0      # Incremented on each new frame for change detection

        # Ring buffer of recent raw frames for accurate anomaly snapshots
        self._frame_ring_buffer: deque = deque(maxlen=5)

        # YOLO tracker (isolated instance per camera worker to prevent cross-camera track collisions and size mismatches)
        self.tracker: BehaviorTracker = BehaviorTracker()
        self._inference_lock = threading.Lock()
        self._latest_detections = []

        # Anomaly cooldown to prevent flooding (min 10s between alerts for same camera)
        self._last_anomaly_time = 0
        self._anomaly_cooldown = 10.0

        # Reconnect state — exponential backoff
        self._reconnect_count = 0

        # Event registry for event-driven frame push streaming
        self._async_events = set()
        self._events_lock = threading.Lock()

        # Ensure project snapshot directory exists
        self._snapshot_dir = os.path.join(SNAPSHOTS_DIR, project_id)
        os.makedirs(self._snapshot_dir, exist_ok=True)

    @property
    def is_connected(self) -> bool:
        return self._is_connected

    @property
    def is_running(self) -> bool:
        return self._running

    def get_latest_jpeg(self) -> bytes:
        """Get the latest annotated JPEG frame (thread-safe)."""
        with self._lock:
            return self._latest_annotated_jpeg

    def get_frame_version(self) -> int:
        """Get the current frame version counter (thread-safe)."""
        with self._lock:
            return self._frame_version

    def get_latest_raw_frame(self) -> Optional[np.ndarray]:
        """Get the latest raw frame at native resolution (thread-safe)."""
        with self._lock:
            return self._latest_raw_frame.copy() if self._latest_raw_frame is not None else None

    def _get_reconnect_delay(self) -> float:
        """Return the current reconnect delay using exponential backoff, then increment counter."""
        idx = min(self._reconnect_count, len(RECONNECT_BACKOFF_STEPS) - 1)
        delay = RECONNECT_BACKOFF_STEPS[idx]
        self._reconnect_count += 1
        return delay

    def _reset_reconnect(self):
        """Reset reconnect backoff counter on successful connection."""
        self._reconnect_count = 0

    def register_event(self, event: asyncio.Event):
        """Register an asyncio event to be triggered when a new frame is produced."""
        try:
            loop = asyncio.get_running_loop()
            with self._events_lock:
                self._async_events.add((event, loop))
        except RuntimeError:
            # No running loop, skip registration
            pass

    def unregister_event(self, event: asyncio.Event):
        """Unregister an asyncio event when the stream is closed."""
        with self._events_lock:
            self._async_events = {item for item in self._async_events if item[0] != event}

    def _set_frame(self, annotated_jpeg: bytes, raw_frame: Optional[np.ndarray] = None):
        """Update the frame buffers (thread-safe). Increments version and notifies listeners."""
        with self._lock:
            self._latest_annotated_jpeg = annotated_jpeg
            self._frame_version += 1
            if raw_frame is not None:
                self._latest_raw_frame = raw_frame
                self._frame_ring_buffer.append(raw_frame.copy())
        
        # Trigger all registered async event loops thread-safely
        with self._events_lock:
            for event, loop in self._async_events:
                try:
                    loop.call_soon_threadsafe(event.set)
                except Exception:
                    pass

    def start(self):
        """Start the camera worker thread."""
        if self._running:
            return
        self._running = True
        self._inference_trigger.clear()
        
        self._thread = threading.Thread(target=self._run_loop, daemon=True, name=f"cam-{self.camera_id[:8]}")
        self._thread.start()
        
        self._inference_thread = threading.Thread(target=self._inference_loop, daemon=True, name=f"infer-{self.camera_id[:8]}")
        self._inference_thread.start()
        print(f"[StreamManager] Started worker for camera '{self.camera_name}' ({self.camera_id[:8]})")

    def stop(self):
        """Stop the camera worker thread."""
        self._running = False
        self._inference_trigger.set()
        if self._thread:
            self._thread.join(timeout=5)
            self._thread = None
        if self._inference_thread:
            self._inference_thread.join(timeout=5)
            self._inference_thread = None
        print(f"[StreamManager] Stopped worker for camera '{self.camera_name}' ({self.camera_id[:8]})")

    def _inference_loop(self):
        """Persistent background inference thread to avoid dynamic thread creation overhead."""
        last_inference_time = 0
        while self._running:
            # Wait for trigger or timeout (to avoid 100% CPU spinning)
            self._inference_trigger.wait(timeout=0.05)
            if not self._running:
                break

            current_time = time.time()
            if (current_time - last_inference_time) < INFERENCE_INTERVAL:
                continue

            frame_to_process = None
            with self._lock:
                if self._latest_raw_frame is not None:
                    frame_to_process = self._latest_raw_frame.copy()

            if frame_to_process is not None:
                last_inference_time = current_time
                try:
                    detections = self.tracker.process_frame(frame_to_process, project_type=self.project_type)
                    with self._inference_lock:
                        self._latest_detections = detections
                        
                    anomalies = self.tracker.get_anomalies(detections)
                    if anomalies and (time.time() - self._last_anomaly_time) >= self._anomaly_cooldown:
                        self._last_anomaly_time = time.time()
                        # Run anomaly handler in a background thread to keep inference responsive
                        threading.Thread(
                            target=self._handle_anomaly, 
                            args=(frame_to_process.copy(), anomalies), 
                            daemon=True
                        ).start()

                    self.tracker.cleanup()
                except Exception as e:
                    print(f"[StreamManager] Camera '{self.camera_name}': Tracker error: {e}")
                finally:
                    self._inference_trigger.clear()

    def _run_loop(self):
        """Main capture loop — determines stream type and runs accordingly."""
        url_lower = self.rtsp_url.lower()

        if url_lower.startswith("http://") or url_lower.startswith("https://"):
            self._run_mjpeg_stream()
        elif url_lower.startswith("rtsp://") or url_lower.startswith("rtsps://"):
            self._run_cv_stream()
        elif url_lower.isdigit():
            # USB camera index (e.g. "0", "1")
            self._run_cv_stream(source=int(self.rtsp_url))
        else:
            # Try OpenCV as fallback
            self._run_cv_stream()

    def _run_cv_stream(self, source=None):
        """
        OpenCV-based stream capture (RTSP/USB).
        Low-latency flags: probesize=1024, analyzeduration=0, fflags=nobuffer.
        Reconnects with exponential backoff (0.5s → 1s → 2s capped).
        """
        cap_source = source if source is not None else self.rtsp_url
        is_usb = isinstance(cap_source, int)

        while self._running:
            cap = None
            grabber_thread = None
            grabber_state = {"running": True, "frame": None, "ret": False}
            grabber_lock = threading.Lock()
            
            try:
                # Set low-latency environment for FFmpeg backend or use DirectShow on Windows for zero-latency USB
                if is_usb:
                    if os.name == 'nt':
                        cap = cv2.VideoCapture(cap_source, cv2.CAP_DSHOW)
                        cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc('M','J','P','G'))
                    else:
                        cap = cv2.VideoCapture(cap_source)
                    # Force hardware to capture at crisp 1080p resolution at buttery smooth 30 FPS
                    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1920)
                    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 1080)
                    cap.set(cv2.CAP_PROP_FPS, 30)
                elif isinstance(cap_source, str):
                    os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "probesize;1024|analyzeduration;0|fflags;nobuffer|stimeout;3000000"
                    cap = cv2.VideoCapture(cap_source, cv2.CAP_FFMPEG)
                else:
                    cap = cv2.VideoCapture(cap_source)

                if not cap or not cap.isOpened():
                    delay = self._get_reconnect_delay()
                    print(f"[StreamManager] Camera '{self.camera_name}': Failed to open stream, retrying in {delay}s (attempt {self._reconnect_count})...")
                    self._is_connected = False
                    self._set_frame(encode_jpeg(generate_no_signal_frame()))
                    time.sleep(delay)
                    continue

                self._is_connected = True
                self._reset_reconnect()
                cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                print(f"[StreamManager] Camera '{self.camera_name}': OpenCV stream connected.")

                # Frame grabber loop to empty the buffer in a background thread.
                # Used for ALL stream types (RTSP and USB) to prevent cap.read() blocking the display loop.
                def grabber_loop():
                    while self._running and grabber_state["running"]:
                        ret, frame = cap.read()
                        if not ret or frame is None:
                            with grabber_lock:
                                grabber_state["ret"] = False
                                grabber_state["frame"] = None
                            if is_usb:
                                # USB disconnections are immediate, break to trigger reconnect
                                break
                            else:
                                break
                        with grabber_lock:
                            grabber_state["ret"] = True
                            grabber_state["frame"] = frame
                        time.sleep(0.001)

                grabber_thread = threading.Thread(target=grabber_loop, daemon=True)
                grabber_thread.start()

                frame_interval = 1.0 / STREAM_FPS
                last_frame_time = time.time()

                while self._running:
                    start_time = time.time()
                    
                    if not grabber_thread.is_alive():
                        print(f"[StreamManager] Camera '{self.camera_name}': CV grabber thread disconnected.")
                        self._is_connected = False
                        break

                    with grabber_lock:
                        ret = grabber_state["ret"]
                        frame = grabber_state["frame"]

                    if not ret or frame is None:
                        if time.time() - last_frame_time > 3.0:
                            print(f"[StreamManager] Camera '{self.camera_name}': Connection lost or read stalled, reconnecting...")
                            self._is_connected = False
                            break
                        time.sleep(0.01)
                        continue

                    last_frame_time = time.time()
                    self._is_connected = True

                    # Store raw frame for inference
                    raw_copy = frame.copy()
                    with self._lock:
                        self._latest_raw_frame = raw_copy
                    self._inference_trigger.set()

                    with self._inference_lock:
                        current_detections = self._latest_detections

                    # Only draw annotations if there are active detections
                    if current_detections and self.tracker:
                        annotated_frame = self.tracker.draw_annotations(frame, current_detections)
                    else:
                        annotated_frame = frame

                    jpeg_bytes = encode_stream_jpeg(annotated_frame)
                    self._set_frame(jpeg_bytes, raw_copy)

                    elapsed = time.time() - start_time
                    sleep_time = frame_interval - elapsed
                    if sleep_time > 0:
                        time.sleep(sleep_time)

            except Exception as e:
                print(f"[StreamManager] Camera '{self.camera_name}': CV stream error: {e}")
                self._is_connected = False
            finally:
                grabber_state["running"] = False
                if cap:
                    cap.release()
                if grabber_thread:
                    grabber_thread.join(timeout=1.0)

            if self._running:
                self._set_frame(encode_jpeg(generate_no_signal_frame()))
                delay = self._get_reconnect_delay()
                print(f"[StreamManager] Camera '{self.camera_name}': CV stream lost, reconnecting in {delay}s (attempt {self._reconnect_count})...")
                time.sleep(delay)

    def _run_mjpeg_stream(self):
        """
        HTTP MJPEG stream capture.
        Parses multipart boundaries to extract JPEG frames.
        Reconnects with exponential backoff (0.5s → 1s → 2s capped).
        """
        import requests

        while self._running:
            response = None
            grabber_thread = None
            grabber_state = {"running": True, "jpeg_data": None}
            grabber_lock = threading.Lock()

            try:
                print(f"[StreamManager] Camera '{self.camera_name}': Connecting to MJPEG stream ({self.rtsp_url})...")
                response = requests.get(self.rtsp_url, stream=True, timeout=(2.5, 2.5))

                if response.status_code != 200:
                    delay = self._get_reconnect_delay()
                    print(f"[StreamManager] Camera '{self.camera_name}': HTTP {response.status_code}, retrying in {delay}s (attempt {self._reconnect_count})...")
                    self._is_connected = False
                    self._set_frame(encode_jpeg(generate_no_signal_frame()))
                    time.sleep(delay)
                    continue

                content_type = response.headers.get("content-type", "").lower()
                self._is_connected = True
                self._reset_reconnect()
                print(f"[StreamManager] Camera '{self.camera_name}': MJPEG stream connected successfully.")

                if "multipart" in content_type:
                    # Set socket timeout on the raw underlying socket if accessible
                    try:
                        if hasattr(response, "raw") and hasattr(response.raw, "_fp") and response.raw._fp is not None:
                            sock = getattr(response.raw._fp, "fp", None)
                            if sock and hasattr(sock, "raw") and hasattr(sock.raw, "_sock"):
                                sock.raw._sock.settimeout(2.5)
                    except Exception:
                        pass

                    grabber_state["last_chunk_time"] = time.time()

                    # MJPEG multipart stream
                    def mjpeg_grabber():
                        buffer = b""
                        try:
                            for chunk in response.iter_content(chunk_size=4096):
                                if not self._running or not grabber_state["running"]:
                                    break
                                if not chunk:
                                    continue
                                buffer += chunk

                                with grabber_lock:
                                    grabber_state["last_chunk_time"] = time.time()

                                while True:
                                    start = buffer.find(b"\xff\xd8")
                                    if start == -1:
                                        if len(buffer) > 2:
                                            buffer = buffer[-2:]
                                        break
                                    if start > 0:
                                        buffer = buffer[start:]
                                        start = 0

                                    end = buffer.find(b"\xff\xd9", 2)
                                    if end == -1:
                                        if len(buffer) > 2 * 1024 * 1024:
                                            buffer = b""
                                        break

                                    jpeg_data = buffer[:end + 2]
                                    buffer = buffer[end + 2:]

                                    with grabber_lock:
                                        grabber_state["jpeg_data"] = jpeg_data
                        except Exception as e:
                            print(f"[StreamManager] Camera '{self.camera_name}' MJPEG grabber disconnected: {e}")
                        finally:
                            with grabber_lock:
                                grabber_state["running"] = False

                    grabber_thread = threading.Thread(target=mjpeg_grabber, daemon=True)
                    grabber_thread.start()

                    frame_interval = 1.0 / STREAM_FPS
                    last_jpeg_data = None
                    last_frame_arrival_time = time.time()

                    while self._running:
                        start_time = time.time()

                        # Immediate check if grabber thread stopped/disconnected
                        if not grabber_thread.is_alive():
                            print(f"[StreamManager] Camera '{self.camera_name}': MJPEG grabber thread disconnected.")
                            self._is_connected = False
                            break

                        jpeg_data = None
                        with grabber_lock:
                            jpeg_data = grabber_state["jpeg_data"]

                        if jpeg_data is None:
                            if time.time() - last_frame_arrival_time > 3.0:
                                print(f"[StreamManager] Camera '{self.camera_name}': MJPEG initial frame timeout, reconnecting...")
                                self._is_connected = False
                                break
                            time.sleep(0.01)
                            continue

                        # Frame change detection
                        if jpeg_data is last_jpeg_data:
                            if time.time() - last_frame_arrival_time > 3.0:
                                print(f"[StreamManager] Camera '{self.camera_name}': MJPEG stream stalled (no new frames for 3s), reconnecting...")
                                self._is_connected = False
                                break
                            time.sleep(0.002)
                            continue

                        last_frame_arrival_time = time.time()
                        last_jpeg_data = jpeg_data

                        with self._inference_lock:
                            current_detections = self._latest_detections

                        # Decode and annotate frame
                        nparr = np.frombuffer(jpeg_data, np.uint8)
                        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

                        if frame is not None:
                            self._is_connected = True
                            with self._lock:
                                self._latest_raw_frame = frame
                            self._inference_trigger.set()

                            if current_detections and self.tracker:
                                annotated_frame = self.tracker.draw_annotations(frame, current_detections)
                            else:
                                annotated_frame = frame

                            jpeg_bytes = encode_stream_jpeg(annotated_frame)
                            self._set_frame(jpeg_bytes, frame)

                        elapsed = time.time() - start_time
                        sleep_time = frame_interval - elapsed
                        if sleep_time > 0:
                            time.sleep(sleep_time)

                else:
                    # Single JPEG snapshot endpoint — poll it
                    frame_interval = 1.0 / STREAM_FPS

                    while self._running:
                        start_time = time.time()
                        try:
                            resp = requests.get(self.rtsp_url, timeout=3)
                            if resp.status_code == 200 and resp.content:
                                nparr = np.frombuffer(resp.content, np.uint8)
                                frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

                                if frame is not None:
                                    self._is_connected = True

                                    with self._lock:
                                        self._latest_raw_frame = frame.copy()
                                    self._inference_trigger.set()

                                    with self._inference_lock:
                                        current_detections = list(self._latest_detections)

                                    if self.tracker:
                                        annotated_frame = self.tracker.draw_annotations(frame, current_detections)
                                    else:
                                        annotated_frame = frame

                                    jpeg_bytes = encode_stream_jpeg(annotated_frame)
                                    self._set_frame(jpeg_bytes, frame)
                            else:
                                self._is_connected = False
                                break
                        except Exception:
                            self._is_connected = False
                            break

                        elapsed = time.time() - start_time
                        sleep_time = frame_interval - elapsed
                        if sleep_time > 0:
                            time.sleep(sleep_time)

            except Exception as e:
                print(f"[StreamManager] Camera '{self.camera_name}': MJPEG stream error: {e}")
                self._is_connected = False
            finally:
                grabber_state["running"] = False
                if response is not None:
                    try:
                        response.close()
                    except Exception:
                        pass
                if grabber_thread:
                    grabber_thread.join(timeout=1.0)

            if self._running:
                self._set_frame(encode_jpeg(generate_no_signal_frame()))
                delay = self._get_reconnect_delay()
                print(f"[StreamManager] Camera '{self.camera_name}': Stream disconnected, auto-reconnecting in {delay}s (attempt {self._reconnect_count})...")
                time.sleep(delay)

    def _handle_anomaly(self, original_frame: np.ndarray, anomalies: list):
        """
        Handle detected anomaly:
        1. Save original native resolution snapshot to project threat logs
        2. Call the anomaly callback (which triggers Gemini verification)
        """
        if not anomalies:
            return

        # Pick the highest-priority anomaly
        primary = anomalies[0]

        # Save original snapshot at native resolution, JPEG 90% quality
        snapshot_filename = f"snap_{uuid.uuid4()}.jpg"
        snapshot_path = os.path.join(self._snapshot_dir, snapshot_filename)

        try:
            jpeg_data = encode_jpeg(original_frame, JPEG_QUALITY)
            with open(snapshot_path, "wb") as f:
                f.write(jpeg_data)
            print(f"[StreamManager] Snapshot saved: {snapshot_path} ({len(jpeg_data)} bytes)")
        except Exception as e:
            print(f"[StreamManager] Failed to save snapshot: {e}")
            return

        # Trigger callback for Gemini verification
        if self.on_anomaly_callback:
            try:
                self.on_anomaly_callback(
                    camera_id=self.camera_id,
                    camera_name=self.camera_name,
                    project_id=self.project_id,
                    zone_tag=self.zone_tag,
                    anomaly_type=primary["anomaly_type"],
                    description=primary["description"],
                    confidence=primary["confidence"],
                    snapshot_filename=snapshot_filename,
                    snapshot_path=snapshot_path,
                    image_data=jpeg_data
                )
            except Exception as e:
                print(f"[StreamManager] Anomaly callback error: {e}")


class StreamManager:
    """
    Manages all camera stream workers.
    Provides a single shared BehaviorTracker instance for all workers.
    """

    def __init__(self):
        self.workers: Dict[str, CameraStreamWorker] = {}
        self.tracker = BehaviorTracker()
        self._lock = threading.Lock()
        print("[StreamManager] Initialized with YOLOv8 tracker.")

    def start_camera(
        self,
        camera_id: str,
        camera_name: str,
        rtsp_url: str,
        project_id: str,
        project_type: str,
        zone_tag: str = "",
        on_anomaly_callback: Optional[Callable] = None
    ):
        """Start a stream worker for a camera."""
        with self._lock:
            # Stop existing worker if any
            if camera_id in self.workers:
                self.workers[camera_id].stop()

            worker = CameraStreamWorker(
                camera_id=camera_id,
                camera_name=camera_name,
                rtsp_url=rtsp_url,
                project_id=project_id,
                project_type=project_type,
                zone_tag=zone_tag,
                on_anomaly_callback=on_anomaly_callback
            )
            worker.start()
            self.workers[camera_id] = worker

    def stop_camera(self, camera_id: str):
        """Stop a camera's stream worker."""
        with self._lock:
            if camera_id in self.workers:
                self.workers[camera_id].stop()
                del self.workers[camera_id]

    def get_worker(self, camera_id: str) -> Optional[CameraStreamWorker]:
        """Get a camera's stream worker."""
        return self.workers.get(camera_id)

    def get_latest_jpeg(self, camera_id: str) -> Optional[bytes]:
        """Get latest annotated JPEG frame for a camera."""
        worker = self.workers.get(camera_id)
        if worker:
            return worker.get_latest_jpeg()
        return None

    def get_latest_snapshot(self, camera_id: str) -> Optional[bytes]:
        """Get latest native-resolution snapshot for a camera."""
        worker = self.workers.get(camera_id)
        if worker:
            frame = worker.get_latest_raw_frame()
            if frame is not None:
                return encode_jpeg(frame, JPEG_QUALITY)
        return None

    def is_connected(self, camera_id: str) -> bool:
        """Check if a camera is connected."""
        worker = self.workers.get(camera_id)
        return worker.is_connected if worker else False

    def stop_all(self):
        """Stop all camera workers."""
        with self._lock:
            for cid in list(self.workers.keys()):
                self.workers[cid].stop()
            self.workers.clear()
        print("[StreamManager] All camera workers stopped.")

    def get_status(self) -> Dict:
        """Get status summary of all workers."""
        status = {}
        for cid, worker in self.workers.items():
            status[cid] = {
                "camera_name": worker.camera_name,
                "is_running": worker.is_running,
                "is_connected": worker.is_connected,
                "project_id": worker.project_id
            }
        return status
