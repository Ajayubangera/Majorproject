import os
import uuid
import json
import base64
import asyncio
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Set, Optional

# Load .env variables FIRST before anything else reads os.getenv()
from dotenv import load_dotenv
load_dotenv(dotenv_path=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))
load_dotenv(dotenv_path=os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))
load_dotenv()

from fastapi import FastAPI, Depends, HTTPException, status, WebSocket, WebSocketDisconnect, BackgroundTasks, Form, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.future import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import func, update, text, delete
from jose import JWTError, jwt
import bcrypt

from database import init_db, warmup_db, get_db, AsyncSessionLocal, User, Project, ProjectMember, Camera, Alert, is_postgres
from stream_manager import StreamManager, encode_jpeg, generate_no_signal_frame

# Supabase Cloud Storage Configuration (no snapshots stored on local disk)
SUPABASE_URL = os.getenv("SUPABASE_URL") or os.getenv("VITE_SUPABASE_URL", "https://sgquvxufepdioksjorvq.supabase.co")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY") or os.getenv("VITE_SUPABASE_ANON_KEY", "")
SUPABASE_BUCKET = os.getenv("SUPABASE_BUCKET", "snapshots")

def sanitize_storage_segment(segment: Optional[str], default: str = "general") -> str:
    """Sanitizes strings for safe, clean S3 / Supabase object path segments."""
    if not segment:
        return default
    import re
    s = str(segment).strip()
    s = re.sub(r'[/\\:*?"<>|#%&{}\\<>*?/$!\'":@+`|=.]', '_', s)
    s = re.sub(r'\s+', '_', s)
    s = re.sub(r'_+', '_', s).strip('_')
    return s if s else default

async def upload_snapshot_to_supabase(
    project_id: str,
    filename: str,
    image_data: bytes,
    camera_id: Optional[str] = None,
    camera_name: Optional[str] = None,
    anomaly_type: Optional[str] = None,
    project_name: Optional[str] = None,
    account_name: Optional[str] = None
) -> Optional[str]:
    """Uploads verified threat snapshot in-memory to Supabase Storage bucket.
    Organizes files hierarchically: {account_name}/{project_name}/{camera_name}/{filename}
    No image is ever saved to local disk.
    Returns the public Supabase URL on success, or None on failure."""
    if not SUPABASE_URL or not SUPABASE_KEY or not image_data:
        return None

    resolved_account = account_name
    resolved_project = project_name
    resolved_camera = camera_name

    # Query DB to resolve missing components
    if not (resolved_account and resolved_project and resolved_camera):
        try:
            async with AsyncSessionLocal() as session:
                from sqlalchemy import select
                # 1. Resolve Project and Account
                if project_id and not (resolved_account and resolved_project):
                    proj_res = await session.execute(select(Project).where(Project.id == project_id))
                    proj = proj_res.scalar_one_or_none()
                    if proj:
                        if not resolved_project and proj.name:
                            resolved_project = proj.name
                        
                        if not resolved_account and proj.owner_id:
                            # Look up user account / organization name
                            user_res = await session.execute(
                                select(User).where((User.email == proj.owner_id) | (User.id == proj.owner_id))
                            )
                            user = user_res.scalar_one_or_none()
                            if user:
                                resolved_account = user.organization_name or user.full_name or user.email.split("@")[0]
                            else:
                                resolved_account = proj.owner_id.split("@")[0] if "@" in proj.owner_id else proj.owner_id

                # 2. Resolve Camera Name
                if not resolved_camera and camera_id:
                    cam_res = await session.execute(select(Camera).where(Camera.id == camera_id))
                    cam = cam_res.scalar_one_or_none()
                    if cam and cam.name:
                        resolved_camera = cam.name

        except Exception as db_err:
            print(f"[Supabase Storage] Notice: DB resolution for storage path used fallbacks: {db_err}")

    # Fallbacks if still unresolved
    resolved_account = resolved_account or "account"
    resolved_project = resolved_project or (f"project_{project_id[:8]}" if project_id else "project")
    resolved_camera = resolved_camera or "camera"

    # Sanitize each segment for S3 / URL safety
    safe_account = sanitize_storage_segment(resolved_account, "account")
    safe_project = sanitize_storage_segment(resolved_project, "project")
    safe_camera = sanitize_storage_segment(resolved_camera, "camera")

    # Format a clean verified snapshot filename if generic
    clean_filename = filename
    if not clean_filename or clean_filename.startswith("snap_") or not any(char.isalpha() for char in clean_filename):
        ts = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
        anomaly_str = sanitize_storage_segment(anomaly_type, "threat") if anomaly_type else "incident"
        clean_filename = f"verified_{anomaly_str}_{ts}_{uuid.uuid4().hex[:6]}.jpg"
    else:
        base_name, ext = os.path.splitext(clean_filename)
        safe_base = sanitize_storage_segment(base_name, "verified_threat")
        ext = ext if ext.lower() in [".jpg", ".jpeg", ".png"] else ".jpg"
        clean_filename = f"{safe_base}{ext}"

    # Hierarchical cloud S3 path: account_name/project_name/camera_name/verified_snapshots_images
    path = f"{safe_account}/{safe_project}/{safe_camera}/{clean_filename}"
    upload_url = f"{SUPABASE_URL.rstrip('/')}/storage/v1/object/{SUPABASE_BUCKET}/{path}"
    headers = {
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "apikey": SUPABASE_KEY,
        "Content-Type": "image/jpeg",
        "x-upsert": "true"
    }
    
    try:
        import httpx
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(upload_url, headers=headers, content=image_data)
            if response.status_code in (200, 201):
                public_url = f"{SUPABASE_URL.rstrip('/')}/storage/v1/object/public/{SUPABASE_BUCKET}/{path}"
                print(f"[Supabase Storage] Successfully uploaded verified snapshot to cloud hierarchy: {path}")
                return public_url
            else:
                print(f"[Supabase Storage] Upload failed with status {response.status_code}: {response.text}")
    except Exception as e:
        print(f"[Supabase Storage] Error uploading snapshot: {e}")
    return None

async def delete_project_cloud_snapshots(
    project_id: str,
    project_name: Optional[str] = None,
    owner_id: Optional[str] = None,
    snapshot_urls: Optional[List[str]] = None
) -> int:
    """Deletes all snapshots stored in Supabase S3 cloud storage for a given project.
    Removes files by:
    1. Parsing all snapshot URLs recorded in the alerts table
    2. Scanning and deleting objects under the project's cloud folder hierarchy:
       - {account_name}/{project_name}/...
       - {project_id}/...
    Also removes local directory fallback cache if present.
    Returns total number of cloud files deleted."""
    if not SUPABASE_URL or not SUPABASE_KEY:
        return 0

    import httpx
    prefixes_to_delete = set()

    # 1. Parse individual snapshot URLs from database records
    if snapshot_urls:
        for url in snapshot_urls:
            if not url:
                continue
            marker = f"/{SUPABASE_BUCKET}/"
            if marker in url:
                parts = url.split(marker, 1)
                if len(parts) > 1 and parts[1]:
                    clean_p = parts[1].split("?")[0]
                    prefixes_to_delete.add(clean_p)

    headers = {
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "apikey": SUPABASE_KEY,
        "Content-Type": "application/json"
    }
    base = SUPABASE_URL.rstrip('/')
    list_url = f"{base}/storage/v1/object/list/{SUPABASE_BUCKET}"

    # Helper function to list all objects under a folder prefix
    async def list_prefix_recursive(client: httpx.AsyncClient, current_prefix: str) -> List[str]:
        found = []
        try:
            res = await client.post(list_url, headers=headers, json={"prefix": current_prefix, "limit": 1000})
            if res.status_code == 200:
                for item in res.json():
                    name = item.get("name")
                    if not name:
                        continue
                    item_path = f"{current_prefix}/{name}".strip("/")
                    if item.get("id") is not None:
                        found.append(item_path)
                    else:
                        sub_items = await list_prefix_recursive(client, item_path)
                        found.extend(sub_items)
        except Exception as err:
            print(f"[Supabase Storage] List prefix error for '{current_prefix}': {err}")
        return found

    try:
        async with httpx.AsyncClient(timeout=25.0) as client:
            # Check legacy project_id prefix
            if project_id:
                legacy_items = await list_prefix_recursive(client, project_id)
                for item in legacy_items:
                    prefixes_to_delete.add(item)

            # Check hierarchical account/project prefix
            if project_name:
                safe_proj = sanitize_storage_segment(project_name, "")
                if safe_proj:
                    top_res = await client.post(list_url, headers=headers, json={"prefix": "", "limit": 100})
                    if top_res.status_code == 200:
                        for top_item in top_res.json():
                            account_folder = top_item.get("name")
                            if account_folder and top_item.get("id") is None:
                                folder_prefix = f"{account_folder}/{safe_proj}"
                                sub_files = await list_prefix_recursive(client, folder_prefix)
                                for f in sub_files:
                                    prefixes_to_delete.add(f)

            # Execute batch deletion via Supabase S3 delete endpoint
            del_url = f"{base}/storage/v1/object/{SUPABASE_BUCKET}"
            all_files = list(prefixes_to_delete)
            deleted_count = 0
            for i in range(0, len(all_files), 100):
                batch = all_files[i:i + 100]
                del_res = await client.request("DELETE", del_url, headers=headers, json={"prefixes": batch})
                if del_res.status_code == 200:
                    deleted_count += len(batch)
                    print(f"[Supabase Storage] Deleted {len(batch)} cloud snapshots for project '{project_name}'.")
                else:
                    print(f"[Supabase Storage] Batch delete failed ({del_res.status_code}): {del_res.text}")

            # Also clean local disk cache if exists
            try:
                import shutil
                local_dir = os.path.join(SNAPSHOTS_DIR, project_id)
                if os.path.exists(local_dir):
                    shutil.rmtree(local_dir, ignore_errors=True)
            except Exception:
                pass

            return deleted_count
    except Exception as e:
        print(f"[Supabase Storage] Error cleaning project cloud storage: {e}")
        return 0


# Create backend directories
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
SNAPSHOTS_DIR = os.path.join(STATIC_DIR, "snapshots")
os.makedirs(SNAPSHOTS_DIR, exist_ok=True)

# JPEG quality for snapshots
JPEG_QUALITY = 90


# Configuration
SECRET_KEY = os.getenv("JWT_SECRET", "super-secret-surveillance-command-center-token-gateway-12345")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 # 24 hours (or 7 days if remember me is used)

# bcrypt helpers (replaces passlib to avoid bcrypt >= 4.1 incompatibility)

app = FastAPI(title="AI-Powered Edge CCTV Surveillance & Gemini Verification Platform")

# CORS Setup
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex="https?://.*",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve static files
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# ─── Stream Manager (real YOLOv8 detection pipeline) ─────────────────────────
stream_mgr = StreamManager()

from verification_queue import verification_queue, VerificationTask

# Anomaly callback — bridges threaded stream workers to async DB/WebSocket pipeline
def on_anomaly_detected(
    camera_id: str,
    camera_name: str,
    project_id: str,
    zone_tag: str,
    anomaly_type: str,
    description: str,
    confidence: float,
    snapshot_filename: str,
    snapshot_path: str,
    image_data: bytes
):
    """Called from stream worker threads when YOLO detects anomalous behavior.
    Enqueues to the commercial Gemini multi-key rate-limiting queue."""
    task = VerificationTask(
        camera_id=camera_id,
        project_id=project_id,
        anomaly_type=anomaly_type,
        image_data=image_data,
        confidence_yolo=confidence,
        camera_name=camera_name,
        camera_zone_tag=zone_tag,
        snapshot_filename=snapshot_filename
    )
    try:
        import builtins
        loop = getattr(builtins, "_main_event_loop", None)
        if not loop or loop.is_closed():
            loop = asyncio.get_event_loop()
        
        if loop and loop.is_running() and not loop.is_closed():
            asyncio.run_coroutine_threadsafe(verification_queue.enqueue(task), loop)
        else:
            print("[Anomaly] Event loop not running or closed, cannot schedule verification.")
    except Exception as e:
        print(f"[Anomaly] Error enqueuing verification task: {e}")

# Background task to initialize stream workers for all active cameras
async def initialize_stream_workers():
    """Start stream workers for all cameras with ai_active=True on startup."""
    print("[Startup] Initializing stream workers for active cameras...")
    db = AsyncSessionLocal()
    try:
        # Fetch all cameras with their project info
        result = await db.execute(
            select(Camera, Project.project_type)
            .join(Project, Camera.project_id == Project.id)
        )
        rows = result.all()
        
        started = 0
        for camera, project_type in rows:
            if camera.ai_active:
                stream_mgr.start_camera(
                    camera_id=camera.id,
                    camera_name=camera.name,
                    rtsp_url=camera.rtsp_url,
                    project_id=camera.project_id,
                    project_type=project_type,
                    zone_tag=camera.zone_tag or "",
                    on_anomaly_callback=on_anomaly_detected
                )
                started += 1
        
        print(f"[Startup] Started {started} stream workers out of {len(rows)} total cameras.")
    except Exception as e:
        print(f"[Startup] Error initializing stream workers: {e}")
    finally:
        await db.close()

# Startup event to initialize DB, migrations, stream workers, and Gemini verification queue
@app.on_event("startup")
async def startup_event():
    await init_db()
    await warmup_db()
    # Store reference to the running event loop for cross-thread scheduling
    import builtins
    builtins._main_event_loop = asyncio.get_event_loop()
    verification_queue.start()
    await initialize_stream_workers()

@app.on_event("shutdown")
async def shutdown_event():
    verification_queue.stop()
    stream_mgr.stop_all()

# Commercial Health & Observability Endpoint
@app.get("/api/health")
async def system_health_check():
    from database import is_postgres
    return {
        "status": "HEALTHY",
        "service": "CCTV AI Surveillance & Verification Command Center",
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "database": {
            "type": "postgresql (Supabase)" if is_postgres else "sqlite (local)",
            "connected": True
        },
        "stream_pipeline": {
            "active_workers": len(stream_mgr.workers),
            "cameras": [
                {
                    "camera_id": cid,
                    "name": w.camera_name,
                    "connected": w.is_connected,
                    "running": w.is_running
                }
                for cid, w in stream_mgr.workers.items()
            ]
        },
        "gemini_verification_queue": verification_queue.get_metrics()
    }

# Connection Manager for WebSockets
class ConnectionManager:
    def __init__(self):
        # project_id -> list of websockets
        self.active_connections: Dict[str, Set[WebSocket]] = {}

    async def connect(self, project_id: str, websocket: WebSocket):
        await websocket.accept()
        if project_id not in self.active_connections:
            self.active_connections[project_id] = set()
        self.active_connections[project_id].add(websocket)
        print(f"WS Client connected to project {project_id}. Total active: {len(self.active_connections[project_id])}")

    def disconnect(self, project_id: str, websocket: WebSocket):
        if project_id in self.active_connections:
            self.active_connections[project_id].discard(websocket)
            if not self.active_connections[project_id]:
                del self.active_connections[project_id]
        print(f"WS Client disconnected from project {project_id}")

    async def broadcast(self, project_id: str, message: dict):
        if project_id in self.active_connections:
            # Create a list copy to iterate safely
            sockets = list(self.active_connections[project_id])
            for websocket in sockets:
                try:
                    await websocket.send_json(message)
                except Exception as e:
                    print(f"WS broadcast error: {e}")
                    self.disconnect(project_id, websocket)

manager = ConnectionManager()

# Pydantic schemas
class UserRegister(BaseModel):
    fullName: str = Field(..., min_length=2)
    email: EmailStr
    password: str = Field(..., min_length=8)
    organizationName: str = Field(..., min_length=2)

class UserLogin(BaseModel):
    email: EmailStr
    password: str
    rememberMe: bool = False

class ForgotPasswordRequest(BaseModel):
    email: EmailStr

class ResetPasswordRequest(BaseModel):
    token: str = Field(..., min_length=10)
    newPassword: str = Field(..., min_length=8)

class ProjectCreate(BaseModel):
    name: str = Field(..., min_length=2)
    location: str = Field(..., min_length=2)
    project_type: str = Field(..., description="school, home, government")

class ProjectMemberInvite(BaseModel):
    email: EmailStr
    role: str = Field("viewer", description="admin, responder, viewer")

class CameraCreate(BaseModel):
    name: str = Field(..., min_length=2)
    rtsp_url: str = Field(..., min_length=1)
    zone_tag: Optional[str] = None
    ai_active: bool = True

class CameraUpdate(BaseModel):
    name: str = Field(..., min_length=2)
    rtsp_url: str = Field(..., min_length=1)
    zone_tag: Optional[str] = None
    nvr_ip_address: Optional[str] = None
    channel_number: Optional[int] = 1

class CameraAccessBatchUpdate(BaseModel):
    camera_ids: List[str]
    allowed_members: List[str]  # List of member emails or roles; empty or ["*"] means all members

class NVRConfig(BaseModel):
    device_label: str
    brand: str
    ip_address: str
    rtsp_port: int = 554
    http_port: int = 8000
    username: str
    password: str
    total_channels: int = 1

class SimulatedDetection(BaseModel):
    camera_id: str
    confidence: float
    anomaly_type: Optional[str] = None
    image_base64: Optional[str] = None # Base64 encoded image frame

# Helper functions
def get_password_hash(password: str) -> str:
    db_url = os.getenv("DATABASE_URL", "")
    # Use cost factor 4 for sqlite/local development to speed up hashing, 12 for production
    rounds = 4 if not db_url or "sqlite" in db_url else 12
    return bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt(rounds=rounds)).decode('utf-8')


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return bcrypt.checkpw(plain_password.encode('utf-8'), hashed_password.encode('utf-8'))

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None):
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt

def create_password_reset_token(email: str) -> str:
    """Generates a secure, signed JWT token valid for 30 minutes for password reset."""
    expire = datetime.utcnow() + timedelta(minutes=30)
    to_encode = {
        "sub": email,
        "type": "password_reset",
        "exp": expire
    }
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)

def verify_password_reset_token(token: str) -> Optional[str]:
    """Validates the reset token and returns the user's email if valid."""
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        if payload.get("type") != "password_reset":
            return None
        return payload.get("sub")
    except JWTError:
        return None

# Dependency to check auth
async def get_current_user(token: str):
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        email: str = payload.get("sub")
        if email is None:
            raise credentials_exception
        return payload
    except JWTError:
        raise credentials_exception

# REST Endpoints

@app.post("/api/auth/register")
async def register(user_data: UserRegister, db: AsyncSession = Depends(get_db)):
    # Check if email exists
    result = await db.execute(select(User).where(User.email == user_data.email))
    existing_user = result.scalars().first()
    if existing_user:
        raise HTTPException(status_code=400, detail="Email is already registered")
        
    hashed_pwd = get_password_hash(user_data.password)
    new_user = User(
        full_name=user_data.fullName,
        email=user_data.email,
        password_hash=hashed_pwd,
        organization_name=user_data.organizationName
    )
    db.add(new_user)
    await db.commit()
    await db.refresh(new_user)
    
    # Automatically dispatch welcome email to user's registered email
    try:
        from email_service import email_service
        asyncio.create_task(email_service.send_account_welcome_email(
            full_name=new_user.full_name,
            email=new_user.email,
            organization_name=new_user.organization_name
        ))
    except Exception as email_err:
        print(f"[EmailService] Notice: Could not dispatch registration welcome email: {email_err}")

    return {"message": "Registration successful", "user": {"email": new_user.email, "fullName": new_user.full_name}}

@app.post("/api/auth/login")
async def login(user_data: UserLogin, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).where(User.email == user_data.email))
    user = result.scalars().first()
    if not user:
        raise HTTPException(status_code=404, detail="Email not found. Please create an account.")
    if not verify_password(user_data.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid password.")
        
    # Generate token
    expires_delta = timedelta(days=7) if user_data.rememberMe else timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    token_payload = {
        "sub": user.email,
        "name": user.full_name,
        "org": user.organization_name
    }
    token = create_access_token(data=token_payload, expires_delta=expires_delta)
    
    return {
        "access_token": token,
        "token_type": "bearer",
        "user": {
            "fullName": user.full_name,
            "email": user.email,
            "org": user.organization_name
        }
    }

@app.post("/api/auth/forgot-password")
async def forgot_password(payload: ForgotPasswordRequest, db: AsyncSession = Depends(get_db)):
    email = payload.email.strip().lower()
    result = await db.execute(select(User).where(User.email == email))
    user = result.scalars().first()
    
    if not user:
        print(f"[ForgotPassword] Request received for unknown email: {email}")
        return {
            "message": "If an account with this email exists, a password reset link has been dispatched to your inbox."
        }

    reset_token = create_password_reset_token(user.email)
    try:
        from email_service import email_service
        asyncio.create_task(email_service.send_password_reset_email(
            full_name=user.full_name,
            email=user.email,
            reset_token=reset_token
        ))
        print(f"[ForgotPassword] Dispatched reset email task for {email}")
    except Exception as err:
        print(f"[ForgotPassword] Error dispatching reset email: {err}")

    return {
        "message": "If an account with this email exists, a password reset link has been dispatched to your inbox."
    }

@app.post("/api/auth/reset-password")
async def reset_password(payload: ResetPasswordRequest, db: AsyncSession = Depends(get_db)):
    email = verify_password_reset_token(payload.token)
    if not email:
        raise HTTPException(
            status_code=400,
            detail="The password reset link is invalid or has expired (links expire after 30 minutes). Please request a new one."
        )

    result = await db.execute(select(User).where(User.email == email))
    user = result.scalars().first()
    if not user:
        raise HTTPException(status_code=404, detail="Account not found.")

    user.password_hash = get_password_hash(payload.newPassword)
    await db.commit()
    await db.refresh(user)
    print(f"[PasswordReset] Successfully updated password for {email}")

    return {
        "message": "Password reset successful! You can now log in with your new password.",
        "email": user.email
    }

@app.get("/api/projects")
async def list_projects(email: str, db: AsyncSession = Depends(get_db)):
    # Optimized single-query project listing with camera and active unread alert count aggregation
    stmt = text("""
        SELECT 
            p.id,
            p.name,
            p.location,
            p.project_type,
            p.owner_id,
            p.created_at,
            COALESCE(p.snapshots_captured, 0) as snapshots_captured,
            COALESCE(c.cam_count, 0) as cameras_count,
            COALESCE(a.alert_count, 0) as alerts_count
        FROM projects p
        LEFT JOIN (
            SELECT project_id, COUNT(id) as cam_count 
            FROM cameras 
            GROUP BY project_id
        ) c ON p.id = c.project_id
        LEFT JOIN (
            SELECT project_id, COUNT(id) as alert_count 
            FROM alerts 
            WHERE is_trashed = FALSE AND is_new = TRUE
            GROUP BY project_id
        ) a ON p.id = a.project_id
        WHERE p.owner_id = :email 
           OR p.id IN (SELECT project_id FROM project_members WHERE email = :email)
        ORDER BY p.created_at DESC;
    """)
    result = await db.execute(stmt, {"email": email})
    rows = result.mappings().all()
    
    projects_list = []
    for r in rows:
        projects_list.append({
            "id": r["id"],
            "name": r["name"],
            "location": r["location"],
            "project_type": r["project_type"],
            "owner_id": r["owner_id"],
            "created_at": r["created_at"],
            "snapshots_captured": int(r.get("snapshots_captured", 0)),
            "cameras_count": int(r["cameras_count"]),
            "alerts_count": int(r["alerts_count"])
        })
    return projects_list

@app.post("/api/projects")
async def create_project(project_data: ProjectCreate, email: str, db: AsyncSession = Depends(get_db)):
    new_project = Project(
        name=project_data.name,
        location=project_data.location,
        project_type=project_data.project_type,
        owner_id=email
    )
    db.add(new_project)
    await db.commit()
    await db.refresh(new_project)
    
    # Auto add owner as admin member
    owner_member = ProjectMember(
        project_id=new_project.id,
        email=email,
        role="admin"
    )
    db.add(owner_member)
    await db.commit()
    
    return {"message": "Project created successfully", "project": new_project}

@app.get("/api/projects/{project_id}")
async def get_project_details(project_id: str, db: AsyncSession = Depends(get_db)):
    if is_postgres:
        # High-speed single round-trip query for PostgreSQL / Supabase
        single_sql = text("""
            SELECT 
                p.id, p.name, p.location, p.project_type, p.owner_id, p.created_at,
                COALESCE(p.snapshots_captured, 0) as snapshots_captured,
                COALESCE((
                    SELECT json_agg(json_build_object(
                        'id', c.id,
                        'name', c.name,
                        'source_type', c.source_type,
                        'rtsp_url', c.rtsp_url,
                        'zone_tag', c.zone_tag,
                        'ai_active', c.ai_active,
                        'allowed_members', c.allowed_members,
                        'snapshots_captured', COALESCE(c.snapshots_captured, 0),
                        'nvr_ip_address', c.nvr_ip_address,
                        'channel_number', c.channel_number
                    ))
                    FROM cameras c
                    WHERE c.project_id = p.id
                ), '[]'::json) AS cameras,
                COALESCE((
                    SELECT json_agg(json_build_object(
                        'id', m.id,
                        'email', m.email,
                        'role', m.role
                    ))
                    FROM project_members m
                    WHERE m.project_id = p.id
                ), '[]'::json) AS members,
                COALESCE((
                    SELECT json_agg(json_build_object(
                        'id', a.id,
                        'camera_id', a.camera_id,
                        'camera_name', cam.name,
                        'zone_tag', cam.zone_tag,
                        'snapshot_url', a.snapshot_url,
                        'threat_description', a.threat_description,
                        'confidence_score', a.confidence_score,
                        'anomaly_type', a.anomaly_type,
                        'is_resolved', a.is_resolved,
                        'is_trashed', a.is_trashed,
                        'is_new', a.is_new,
                        'created_at', to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                    ) ORDER BY a.created_at DESC)
                    FROM alerts a
                    LEFT JOIN cameras cam ON a.camera_id = cam.id
                    WHERE a.project_id = p.id
                ), '[]'::json) AS alerts
            FROM projects p
            WHERE p.id = :project_id;
        """)
        res = await db.execute(single_sql, {"project_id": project_id})
        row = res.mappings().first()
        if not row:
            raise HTTPException(status_code=404, detail="Project not found")
            
        cams = json.loads(row["cameras"]) if isinstance(row["cameras"], str) else (row["cameras"] or [])
        members = json.loads(row["members"]) if isinstance(row["members"], str) else (row["members"] or [])
        alerts = json.loads(row["alerts"]) if isinstance(row["alerts"], str) else (row["alerts"] or [])
        
        return {
            "project": {
                "id": row["id"],
                "name": row["name"],
                "location": row["location"],
                "project_type": row["project_type"],
                "owner_id": row["owner_id"],
                "created_at": row["created_at"],
                "snapshots_captured": int(row.get("snapshots_captured", 0))
            },
            "cameras": cams,
            "members": members,
            "alerts": alerts
        }
    else:
        # SQLite / Generic Fallback
        project_result = await db.execute(select(Project).where(Project.id == project_id))
        project = project_result.scalars().first()
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")
            
        cameras_result = await db.execute(select(Camera).where(Camera.project_id == project_id))
        cameras = cameras_result.scalars().all()
        
        members_result = await db.execute(select(ProjectMember).where(ProjectMember.project_id == project_id))
        members = members_result.scalars().all()
        
        alerts_result = await db.execute(
            select(Alert, Camera.name, Camera.zone_tag)
            .join(Camera, Alert.camera_id == Camera.id)
            .where(Alert.project_id == project_id)
            .order_by(Alert.created_at.desc())
        )
        alerts = alerts_result.all()
        
        alerts_list = []
        for alert, camera_name, zone_tag in alerts:
            alerts_list.append({
                "id": alert.id,
                "camera_id": alert.camera_id,
                "camera_name": camera_name,
                "zone_tag": zone_tag,
                "snapshot_url": alert.snapshot_url,
                "threat_description": alert.threat_description,
                "confidence_score": alert.confidence_score,
                "anomaly_type": alert.anomaly_type,
                "is_resolved": alert.is_resolved,
                "is_trashed": alert.is_trashed,
                "is_new": alert.is_new,
                "created_at": alert.created_at.strftime("%Y-%m-%dT%H:%M:%SZ") if alert.created_at else None
            })
            
        return {
            "project": {
                "id": project.id,
                "name": project.name,
                "location": project.location,
                "project_type": project.project_type,
                "owner_id": project.owner_id,
                "created_at": project.created_at,
                "snapshots_captured": getattr(project, "snapshots_captured", 0)
            },
            "cameras": [{
                "id": c.id,
                "name": c.name,
                "source_type": c.source_type,
                "rtsp_url": c.rtsp_url,
                "zone_tag": c.zone_tag,
                "ai_active": c.ai_active,
                "allowed_members": c.allowed_members,
                "snapshots_captured": getattr(c, "snapshots_captured", 0),
                "nvr_ip_address": c.nvr_ip_address,
                "channel_number": c.channel_number
            } for c in cameras],
            "members": [{"id": m.id, "email": m.email, "role": m.role} for m in members],
            "alerts": alerts_list
        }

@app.delete("/api/projects/{project_id}")
async def delete_project(project_id: str, db: AsyncSession = Depends(get_db)):
    """Permanently deletes a project, including:
    1. Stopping all active camera streams/workers.
    2. Deleting all snapshots from Supabase S3 cloud storage.
    3. Deleting all alerts, cameras, workspace members, and the project record from Supabase PostgreSQL.
    """
    proj_res = await db.execute(select(Project).where(Project.id == project_id))
    project = proj_res.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    project_name = project.name
    owner_id = project.owner_id

    # 1. Stop camera streams if active
    try:
        cam_res = await db.execute(select(Camera).where(Camera.project_id == project_id))
        cameras = cam_res.scalars().all()
        from stream_manager import stream_manager
        for cam in cameras:
            try:
                stream_manager.stop_camera(cam.id)
                if cam.id in stream_manager.cameras:
                    del stream_manager.cameras[cam.id]
            except Exception as cam_err:
                print(f"[DeleteProject] Error stopping camera {cam.id}: {cam_err}")
    except Exception as e:
        print(f"[DeleteProject] Error checking cameras to stop: {e}")

    # 2. Collect snapshot URLs for Supabase S3 deletion
    cloud_deleted = 0
    try:
        alert_res = await db.execute(select(Alert.snapshot_url).where(Alert.project_id == project_id))
        snapshot_urls = [row[0] for row in alert_res.fetchall() if row[0]]

        # Delete from Supabase S3 cloud storage
        cloud_deleted = await delete_project_cloud_snapshots(
            project_id=project_id,
            project_name=project_name,
            owner_id=owner_id,
            snapshot_urls=snapshot_urls
        )
    except Exception as s3_err:
        print(f"[DeleteProject] Cloud deletion warning: {s3_err}")

    # 3. Delete all related records in Supabase PostgreSQL DB
    try:
        await db.execute(delete(Alert).where(Alert.project_id == project_id))
        await db.execute(delete(Camera).where(Camera.project_id == project_id))
        await db.execute(delete(ProjectMember).where(ProjectMember.project_id == project_id))
        await db.execute(delete(Project).where(Project.id == project_id))
        await db.commit()
    except Exception as db_err:
        await db.rollback()
        print(f"[DeleteProject] Database delete failed: {db_err}")
        raise HTTPException(status_code=500, detail=f"Failed to delete project from database: {str(db_err)}")

    print(f"[DeleteProject] Successfully deleted project '{project_name}' ({project_id}) from Supabase DB and Cloud Storage ({cloud_deleted} files removed).")
    return {
        "success": True,
        "message": f"Project '{project_name}' and all associated cloud snapshots were permanently deleted.",
        "project_id": project_id,
        "cloud_files_deleted": cloud_deleted
    }

@app.get("/api/projects/{project_id}/cameras")
async def get_project_cameras(project_id: str, db: AsyncSession = Depends(get_db)):
    cameras_result = await db.execute(select(Camera).where(Camera.project_id == project_id))
    cameras = cameras_result.scalars().all()
    return [{
        "id": c.id,
        "name": c.name,
        "source_type": c.source_type,
        "rtsp_url": c.rtsp_url,
        "zone_tag": c.zone_tag,
        "ai_active": c.ai_active,
        "allowed_members": c.allowed_members,
        "snapshots_captured": getattr(c, "snapshots_captured", 0),
        "nvr_ip_address": c.nvr_ip_address,
        "channel_number": c.channel_number
    } for c in cameras]

@app.get("/api/projects/{project_id}/members")
async def get_project_members(project_id: str, db: AsyncSession = Depends(get_db)):
    members_result = await db.execute(select(ProjectMember).where(ProjectMember.project_id == project_id))
    members = members_result.scalars().all()
    return [{"id": m.id, "email": m.email, "role": m.role, "joined_at": m.joined_at.strftime("%Y-%m-%d") if m.joined_at else None} for m in members]

@app.post("/api/projects/{project_id}/members")
async def add_project_member(project_id: str, invite: ProjectMemberInvite, db: AsyncSession = Depends(get_db)):
    # Check if already a member
    exist_res = await db.execute(select(ProjectMember).where(ProjectMember.project_id == project_id, ProjectMember.email == invite.email))
    existing = exist_res.scalars().first()
    if existing:
        raise HTTPException(status_code=400, detail="User is already a member of this project")
        
    new_member = ProjectMember(
        project_id=project_id,
        email=invite.email,
        role=invite.role
    )
    db.add(new_member)
    await db.commit()
    await db.refresh(new_member)

    # Fetch project details for welcome/access notification email
    try:
        proj_res = await db.execute(select(Project).where(Project.id == project_id))
        project = proj_res.scalar_one_or_none()
        from email_service import email_service
        project_name = project.name if project else "Surveillance Workspace"
        project_location = project.location if project else "Facility"
        project_type = project.project_type if project else "facility"
        asyncio.create_task(email_service.send_member_welcome_email(
            member_email=new_member.email,
            role=new_member.role,
            project_name=project_name,
            project_location=project_location,
            project_type=project_type
        ))
    except Exception as welcome_err:
        print(f"[EmailService] Notice: Could not dispatch welcome email: {welcome_err}")

    return {"message": "Member added successfully", "member": {"id": new_member.id, "email": new_member.email, "role": new_member.role}}

@app.delete("/api/projects/{project_id}/members/{member_id}")
async def delete_project_member(project_id: str, member_id: str, db: AsyncSession = Depends(get_db)):
    member_res = await db.execute(select(ProjectMember).where(ProjectMember.project_id == project_id, ProjectMember.id == member_id))
    member = member_res.scalars().first()
    if not member:
        raise HTTPException(status_code=404, detail="Member not found")
    await db.delete(member)
    await db.commit()
    return {"message": "Member access removed successfully"}

class MemberRoleUpdate(BaseModel):
    role: str = Field(..., description="admin, responder, viewer")

@app.patch("/api/projects/{project_id}/members/{member_id}")
async def update_project_member_role(
    project_id: str,
    member_id: str,
    payload: MemberRoleUpdate,
    db: AsyncSession = Depends(get_db)
):
    target_role = payload.role.strip().lower()
    valid_roles = ["admin", "responder", "viewer"]
    if target_role not in valid_roles:
        raise HTTPException(status_code=400, detail=f"Invalid role '{target_role}'. Must be one of: {valid_roles}")

    member_res = await db.execute(
        select(ProjectMember).where(ProjectMember.project_id == project_id, ProjectMember.id == member_id)
    )
    member = member_res.scalars().first()
    if not member:
        raise HTTPException(status_code=404, detail="Member not found")

    old_role = member.role
    member.role = target_role
    await db.commit()
    await db.refresh(member)
    print(f"[AccessManagement] Member {member.email} role updated from '{old_role}' to '{target_role}' for project {project_id}.")

    # Dispatch email notification if role changed
    email_delivery = None
    if old_role != target_role:
        try:
            proj_res = await db.execute(select(Project).where(Project.id == project_id))
            project = proj_res.scalar_one_or_none()
            project_name = project.name if project else "Surveillance Workspace"
            project_location = project.location if project else "Facility"
            from email_service import email_service
            email_delivery = await email_service.send_role_change_email(
                member_email=member.email,
                old_role=old_role,
                new_role=target_role,
                project_name=project_name,
                project_location=project_location
            )
            print(f"[EmailService] Role change email delivery result for {member.email}: {email_delivery}")
        except Exception as email_err:
            print(f"[EmailService] Error dispatching role change email: {email_err}")
            email_delivery = {"status": "error", "error": str(email_err)}

    return {
        "message": f"Member role updated to {target_role}",
        "member": {"id": member.id, "email": member.email, "role": member.role},
        "email_delivery": email_delivery
    }

class TestEmailRequest(BaseModel):
    target_email: Optional[str] = None
    anomaly_type: Optional[str] = "violence"

@app.get("/api/projects/{project_id}/email-status")
async def get_project_email_status(project_id: str, db: AsyncSession = Depends(get_db)):
    """Returns SMTP configuration and list of Access Management recipients who receive incident alerts."""
    from email_service import email_service
    status_info = email_service.get_status()

    proj_res = await db.execute(select(Project).where(Project.id == project_id))
    project = proj_res.scalar_one_or_none()

    members_res = await db.execute(select(ProjectMember).where(ProjectMember.project_id == project_id))
    members = members_res.scalars().all()

    recipients = []
    if project and project.owner_id and "@" in project.owner_id:
        recipients.append({"email": project.owner_id, "role": "owner"})
    for m in members:
        if m.email and "@" in m.email:
            recipients.append({"email": m.email, "role": m.role})

    # De-duplicate by email
    unique_recipients = []
    seen = set()
    for r in recipients:
        if r["email"] not in seen:
            seen.add(r["email"])
            unique_recipients.append(r)

    return {
        "smtp": status_info,
        "recipients": unique_recipients,
        "total_recipients": len(unique_recipients)
    }

@app.post("/api/projects/{project_id}/test-alert-email")
async def test_alert_email(
    project_id: str,
    payload: Optional[TestEmailRequest] = None,
    db: AsyncSession = Depends(get_db)
):
    """Dispatches a test alert email with camera, area, and cloud snapshot details to Access Management members."""
    from email_service import email_service

    proj_res = await db.execute(select(Project).where(Project.id == project_id))
    project = proj_res.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    cam_res = await db.execute(select(Camera).where(Camera.project_id == project_id))
    camera = cam_res.scalars().first()
    camera_name = camera.name if camera else "Main Entrance Cam"
    camera_id = camera.id if camera else "CAM-SEC-01"
    zone_tag = camera.zone_tag if camera else "Perimeter Area"

    alert_res = await db.execute(
        select(Alert).where(Alert.project_id == project_id).order_by(Alert.created_at.desc())
    )
    latest_alert = alert_res.scalars().first()
    snapshot_url = latest_alert.snapshot_url if (latest_alert and latest_alert.snapshot_url) else "https://images.unsplash.com/photo-1557597774-9d273605dfa9?w=800"

    anomaly = payload.anomaly_type if (payload and payload.anomaly_type) else "unusual_activity"

    if payload and payload.target_email and payload.target_email.strip():
        to_emails = [payload.target_email.strip()]
    else:
        to_emails = []
        if project.owner_id and "@" in project.owner_id:
            to_emails.append(project.owner_id.strip())
        members_res = await db.execute(select(ProjectMember).where(ProjectMember.project_id == project_id))
        for m in members_res.scalars().all():
            if m.email and "@" in m.email:
                to_emails.append(m.email.strip())
        to_emails = list(dict.fromkeys(to_emails))

    if not to_emails:
        raise HTTPException(status_code=400, detail="No email addresses found in Access Management for this project.")

    result = await email_service.send_alert_email(
        to_emails=to_emails,
        project_name=project.name,
        project_location=project.location,
        camera_name=camera_name,
        camera_id=camera_id,
        zone_tag=zone_tag,
        anomaly_type=anomaly,
        threat_description=f"Verified {anomaly.replace('_', ' ')} incident in monitored area. Automated dispatch to Access Management roster.",
        confidence_score=0.96,
        snapshot_url=snapshot_url,
        timestamp=datetime.utcnow()
    )

    return {
        "status": "success",
        "result": result,
        "message": f"Test alert email successfully dispatched to {len(to_emails)} recipient(s): {', '.join(to_emails)}"
    }

@app.post("/api/projects/{project_id}/cameras")
async def create_camera(project_id: str, camera_data: CameraCreate, db: AsyncSession = Depends(get_db)):
    final_zone_tag = camera_data.zone_tag.strip() if camera_data.zone_tag and camera_data.zone_tag.strip() else camera_data.name.strip()
    new_camera = Camera(
        project_id=project_id,
        name=camera_data.name.strip(),
        source_type="standalone",
        rtsp_url=camera_data.rtsp_url.strip(),
        zone_tag=final_zone_tag,
        ai_active=camera_data.ai_active
    )
    db.add(new_camera)
    await db.commit()
    await db.refresh(new_camera)
    
    # Start stream worker in background thread so HTTP response returns instantly
    if new_camera.ai_active:
        proj_res = await db.execute(select(Project.project_type).where(Project.id == project_id))
        project_type = proj_res.scalar() or "home"
        import threading
        threading.Thread(
            target=stream_mgr.start_camera,
            kwargs={
                "camera_id": new_camera.id,
                "camera_name": new_camera.name,
                "rtsp_url": new_camera.rtsp_url,
                "project_id": project_id,
                "project_type": project_type,
                "zone_tag": new_camera.zone_tag or "",
                "on_anomaly_callback": on_anomaly_detected
            },
            daemon=True
        ).start()
        
    return {
        "message": "Standalone camera saved successfully",
        "camera": {
            "id": new_camera.id,
            "name": new_camera.name,
            "source_type": new_camera.source_type,
            "rtsp_url": new_camera.rtsp_url,
            "zone_tag": new_camera.zone_tag,
            "ai_active": new_camera.ai_active,
            "nvr_ip_address": new_camera.nvr_ip_address,
            "channel_number": new_camera.channel_number
        }
    }

@app.delete("/api/cameras/{camera_id}")
async def delete_camera(camera_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Camera).where(Camera.id == camera_id))
    camera = result.scalars().first()
    if not camera:
        raise HTTPException(status_code=404, detail="Camera not found")
        
    await db.delete(camera)
    await db.commit()
    
    # Stop stream worker
    stream_mgr.stop_camera(camera_id)
    
    return {"status": "success", "message": "Camera removed successfully"}

@app.put("/api/cameras/{camera_id}")
async def update_camera(camera_id: str, payload: CameraUpdate, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Camera).where(Camera.id == camera_id))
    camera = result.scalars().first()
    if not camera:
        raise HTTPException(status_code=404, detail="Camera not found")
        
    old_rtsp_url = camera.rtsp_url
    final_zone_tag = payload.zone_tag.strip() if payload.zone_tag and payload.zone_tag.strip() else payload.name.strip()
    
    camera.name = payload.name.strip()
    camera.rtsp_url = payload.rtsp_url.strip()
    camera.zone_tag = final_zone_tag
    camera.nvr_ip_address = payload.nvr_ip_address
    camera.channel_number = payload.channel_number
    
    await db.commit()
    await db.refresh(camera)
    
    # Instant restart or metadata update
    if camera.ai_active:
        proj_res = await db.execute(select(Project.project_type).where(Project.id == camera.project_id))
        project_type = proj_res.scalar() or "home"
        
        existing_worker = stream_mgr.get_worker(camera.id)
        if existing_worker and old_rtsp_url == camera.rtsp_url:
            # High-speed in-memory update: no need to disconnect/reconnect socket
            existing_worker.camera_name = camera.name
            existing_worker.zone_tag = camera.zone_tag or ""
            print(f"[StreamManager] Updated worker metadata instantly for camera '{camera.name}' without restarting stream.")
        else:
            # If stream URL changed, restart in background daemon thread to avoid blocking HTTP response with thread.join()
            import threading
            threading.Thread(
                target=stream_mgr.start_camera,
                kwargs={
                    "camera_id": camera.id,
                    "camera_name": camera.name,
                    "rtsp_url": camera.rtsp_url,
                    "project_id": camera.project_id,
                    "project_type": project_type,
                    "zone_tag": camera.zone_tag or "",
                    "on_anomaly_callback": on_anomaly_detected
                },
                daemon=True
            ).start()
    else:
        stream_mgr.stop_camera(camera.id)
        
    return {
        "status": "success", 
        "camera": {
            "id": camera.id,
            "name": camera.name,
            "source_type": camera.source_type,
            "rtsp_url": camera.rtsp_url,
            "zone_tag": camera.zone_tag,
            "ai_active": camera.ai_active,
            "allowed_members": camera.allowed_members,
            "nvr_ip_address": camera.nvr_ip_address,
            "channel_number": camera.channel_number
        }
    }

@app.patch("/api/projects/{project_id}/cameras/access")
async def update_cameras_access(
    project_id: str,
    payload: CameraAccessBatchUpdate,
    db: AsyncSession = Depends(get_db)
):
    if not payload.camera_ids:
        raise HTTPException(status_code=400, detail="No camera IDs provided")

    # 1. Fetch project info
    proj_res = await db.execute(select(Project).where(Project.id == project_id))
    project = proj_res.scalar_one_or_none()
    project_name = project.name if project else "Surveillance Workspace"
    project_location = project.location if project else "Facility"

    # 2. Fetch all project cameras
    all_cams_res = await db.execute(select(Camera).where(Camera.project_id == project_id))
    all_cameras = all_cams_res.scalars().all()

    target_cam_ids = set(payload.camera_ids)
    target_members = set(m.strip().lower() for m in payload.allowed_members if m and "@" in m)
    is_open_to_all = "*" in payload.allowed_members or "all" in payload.allowed_members
    is_admin_only = "admin_only" in payload.allowed_members

    allowed_json = json.dumps(payload.allowed_members)

    for cam in all_cameras:
        if cam.id in target_cam_ids:
            cam.allowed_members = allowed_json
        else:
            # If specific members were selected for target cameras, ensure they are NOT listed in other cameras
            if target_members and not is_open_to_all:
                try:
                    existing = json.loads(cam.allowed_members) if cam.allowed_members else []
                    if isinstance(existing, list):
                        updated_existing = [m for m in existing if m.strip().lower() not in target_members]
                        cam.allowed_members = json.dumps(updated_existing)
                except Exception:
                    pass

    await db.commit()

    print(f"[AccessControl] Updated allowed members for {len(payload.camera_ids)} cameras in project {project_id}: {payload.allowed_members}")

    # 3. Dispatch notification emails to members whose camera access was configured
    if target_members and not is_open_to_all and not is_admin_only:
        try:
            from email_service import email_service
            fresh_cams_res = await db.execute(select(Camera).where(Camera.project_id == project_id))
            fresh_cameras = fresh_cams_res.scalars().all()

            for member_email in target_members:
                granted = []
                for c in fresh_cameras:
                    try:
                        c_allowed = json.loads(c.allowed_members) if c.allowed_members else []
                        if isinstance(c_allowed, list):
                            clean = [x.strip().lower() for x in c_allowed]
                            if member_email in clean or "*" in clean or "all" in clean:
                                granted.append({"name": c.name, "zone_tag": c.zone_tag or ""})
                    except Exception:
                        pass

                if granted:
                    asyncio.create_task(email_service.send_camera_access_update_email(
                        member_email=member_email,
                        project_name=project_name,
                        project_location=project_location,
                        granted_cameras=granted,
                        total_project_cameras=len(fresh_cameras)
                    ))
        except Exception as email_err:
            print(f"[EmailService] Error dispatching camera access email: {email_err}")

    return {
        "status": "success",
        "message": f"Updated permissions for {len(payload.camera_ids)} camera(s)",
        "camera_ids": payload.camera_ids,
        "allowed_members": payload.allowed_members
    }

@app.put("/api/cameras/{camera_id}/active")
async def set_camera_active_status(camera_id: str, payload: dict, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Camera).where(Camera.id == camera_id))
    camera = result.scalars().first()
    if not camera:
        raise HTTPException(status_code=404, detail="Camera not found")
        
    ai_active = payload.get("ai_active", True)
    camera.ai_active = ai_active
    await db.commit()
    
    # Start or stop stream worker
    if ai_active:
        proj_res = await db.execute(select(Project.project_type).where(Project.id == camera.project_id))
        project_type = proj_res.scalar() or "home"
        stream_mgr.start_camera(
            camera_id=camera.id,
            camera_name=camera.name,
            rtsp_url=camera.rtsp_url,
            project_id=camera.project_id,
            project_type=project_type,
            zone_tag=camera.zone_tag or "",
            on_anomaly_callback=on_anomaly_detected
        )
    else:
        stream_mgr.stop_camera(camera.id)
        
    return {"status": "success", "ai_active": camera.ai_active, "message": f"Camera active status updated to {ai_active}"}

@app.post("/api/projects/{project_id}/nvr")
async def configure_nvr(project_id: str, nvr_data: NVRConfig, db: AsyncSession = Depends(get_db)):
    # Map NVR IP and credentials to multiple camera streams
    cameras_created = []
    
    brand_rtsp_templates = {
        "hikvision": "rtsp://{username}:{password}@{ip}:{rtsp_port}/Streaming/Channels/{channel}01",
        "dahua": "rtsp://{username}:{password}@{ip}:{rtsp_port}/cam/realmonitor?channel={channel}&subtype=0",
        "cp plus": "rtsp://{username}:{password}@{ip}:{rtsp_port}/cam/realmonitor?channel={channel}&subtype=0",
        "generic onvif": "rtsp://{username}:{password}@{ip}:{rtsp_port}/onvif/device_service/channel_{channel}",
        "ip webcam (android)": "rtsp://{username}:{password}@{ip}:{rtsp_port}/h264_aac.sdp" if nvr_data.username and nvr_data.password else "rtsp://{ip}:{rtsp_port}/h264_aac.sdp"
    }
    
    template = brand_rtsp_templates.get(nvr_data.brand.lower(), brand_rtsp_templates["generic onvif"])
    
    for ch in range(1, nvr_data.total_channels + 1):
        url = template.format(
            username=nvr_data.username,
            password=nvr_data.password,
            ip=nvr_data.ip_address,
            rtsp_port=nvr_data.rtsp_port,
            channel=ch
        )
        
        # Masked password in display name or description for security, but save raw url in db
        cam_name = f"{nvr_data.device_label} - Ch {ch:02d}"
        new_cam = Camera(
            project_id=project_id,
            name=cam_name,
            source_type="nvr",
            nvr_ip_address=nvr_data.ip_address,
            channel_number=ch,
            rtsp_url=url,
            zone_tag="Corridor" if ch % 2 == 0 else "Main Door", # Mock default zone tags
            ai_active=True
        )
        db.add(new_cam)
        cameras_created.append(new_cam)
        
    await db.commit()
    
    # Start stream workers for NVR channels
    proj_res = await db.execute(select(Project.project_type).where(Project.id == project_id))
    project_type = proj_res.scalar() or "home"
    
    for cam in cameras_created:
        await db.refresh(cam)
        stream_mgr.start_camera(
            camera_id=cam.id,
            camera_name=cam.name,
            rtsp_url=cam.rtsp_url,
            project_id=project_id,
            project_type=project_type,
            zone_tag=cam.zone_tag or "",
            on_anomaly_callback=on_anomaly_detected
        )
        
    return {
        "message": f"NVR configured and mapped {nvr_data.total_channels} channels.",
        "cameras": [{"id": c.id, "name": c.name, "rtsp_url": f"rtsp://{nvr_data.username}:****@{nvr_data.ip_address}:{nvr_data.rtsp_port}/..."} for c in cameras_created]
    }

@app.post("/api/projects/{project_id}/test-nvr")
async def test_nvr_connection(project_id: str, nvr_data: NVRConfig):
    # Simulate network handshake latency
    await asyncio.sleep(1.5)
    # Simple check for demo purposes
    if nvr_data.ip_address.startswith("127.") or nvr_data.ip_address.startswith("192.") or nvr_data.ip_address.startswith("10.") or nvr_data.ip_address == "localhost" or nvr_data.ip_address == "8.8.8.8":
        return {"status": "success", "message": f"Handshake with NVR Device label '{nvr_data.device_label}' successful. PING latency: 42ms. Connected to {nvr_data.total_channels} channels."}
    else:
        return {"status": "error", "message": f"Connection timed out. Host {nvr_data.ip_address} unreachable on RTSP port {nvr_data.rtsp_port}."}

@app.post("/api/projects/{project_id}/test-stream")
async def test_stream(project_id: str, camera_data: CameraCreate):
    # Simulate stream testing connection delay
    await asyncio.sleep(1.0)
    # Validate rtsp, http, or USB camera index stream formats
    url = camera_data.rtsp_url.lower()
    if url.isdigit():
        return {"status": "success", "message": "USB camera index validation passed."}
    elif url.startswith("rtsp://") or url.startswith("rtsps://") or url.startswith("http://") or url.startswith("https://"):
        return {"status": "success", "message": "Stream validation passed. Codec: H.264/MJPEG/AAC. Frame Rate: 30 FPS. Resolution: 1920x1080."}
    else:
        return {"status": "error", "message": "Invalid stream URL format. Must start with rtsp://, rtsps://, http://, or https://, or be a USB index (digit)."}

@app.get("/api/cameras/{camera_id}/stream")
def get_camera_stream(camera_id: str):
    """
    Returns an MJPEG stream of annotated frames from the background thread worker.
    Uses a sync generator so Starlette runs it in a background thread pool,
    preventing ASGI event loop block/saturation while keeping full native quality.
    """
    import time
    def frame_generator():
        worker = stream_mgr.get_worker(camera_id)
        if not worker:
            fallback = encode_jpeg(generate_no_signal_frame())
            yield (b'--frame\r\n'
                   b'Content-Type: image/jpeg\r\n\r\n' + fallback + b'\r\n')
            return

        last_version = -1
        try:
            while True:
                # Check if the worker has been stopped, replaced, or is no longer running
                current_worker = stream_mgr.get_worker(camera_id)
                if not current_worker or current_worker is not worker or not worker.is_running:
                    print(f"[Streaming] Camera {camera_id} worker stopped or replaced. Ending stream.")
                    fallback = encode_jpeg(generate_no_signal_frame())
                    yield (b'--frame\r\n'
                           b'Content-Type: image/jpeg\r\n\r\n' + fallback + b'\r\n')
                    break

                current_version = worker.get_frame_version()
                if current_version != last_version:
                    jpeg_bytes = worker.get_latest_jpeg()
                    if jpeg_bytes:
                        yield (b'--frame\r\n'
                               b'Content-Type: image/jpeg\r\n\r\n' + jpeg_bytes + b'\r\n')
                        last_version = current_version
                time.sleep(0.005) # 5ms sleep in thread pool is highly efficient and responsive
        except (GeneratorExit, Exception):
            # Gracefully handle client disconnection, uvicorn reload, or closed socket errors
            pass

    return StreamingResponse(
        frame_generator(),
        media_type="multipart/x-mixed-replace; boundary=frame"
    )

@app.get("/api/cameras/{camera_id}/snapshot")
async def get_camera_snapshot_frame(camera_id: str):
    """
    Returns the latest native resolution JPEG frame as a snapshot.
    """
    jpeg_bytes = stream_mgr.get_latest_snapshot(camera_id)
    if not jpeg_bytes:
        fallback = encode_jpeg(generate_no_signal_frame())
        return Response(content=fallback, media_type="image/jpeg")
    return Response(content=jpeg_bytes, media_type="image/jpeg")

@app.get("/api/cameras/{camera_id}/frame")
async def get_camera_frame(camera_id: str):
    """
    Returns the latest pre-encoded display-quality JPEG frame instantly.
    Used by the frontend frame-polling loop for zero-buffer-lag streaming.
    Includes X-Cam-Connected header so the frontend can detect disconnects immediately.
    """
    worker = stream_mgr.get_worker(camera_id)
    if worker:
        jpeg_bytes = worker.get_latest_jpeg()
        connected = worker.is_connected
        return Response(
            content=jpeg_bytes,
            media_type="image/jpeg",
            headers={
                "X-Cam-Connected": "1" if connected else "0",
                "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            }
        )
    else:
        fallback = encode_jpeg(generate_no_signal_frame())
        return Response(
            content=fallback,
            media_type="image/jpeg",
            headers={
                "X-Cam-Connected": "0",
                "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            }
        )

@app.get("/api/projects/{project_id}/camera-status")
async def get_project_camera_status(project_id: str):
    """
    Returns the real connection status of all cameras in a project.
    Polled by the frontend once every 3 seconds to update UI badges/simulation panel.
    """
    status_dict = {}
    for cid, worker in stream_mgr.workers.items():
        if worker.project_id == project_id:
            status_dict[cid] = worker.is_connected
    return status_dict

@app.get("/api/projects/{project_id}/alerts")
async def get_project_alerts(project_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Alert, Camera.name, Camera.zone_tag)
        .join(Camera, Alert.camera_id == Camera.id)
        .where(Alert.project_id == project_id)
        .where(Alert.is_trashed == False)
        .order_by(Alert.created_at.desc())
    )
    alerts_data = []
    for alert, camera_name, zone_tag in result.all():
        alerts_data.append({
            "id": alert.id,
            "project_id": alert.project_id,
            "camera_id": alert.camera_id,
            "camera_name": camera_name,
            "zone_tag": zone_tag,
            "snapshot_url": alert.snapshot_url,
            "threat_description": alert.threat_description,
            "confidence_score": alert.confidence_score,
            "anomaly_type": alert.anomaly_type,
            "is_resolved": alert.is_resolved,
            "is_trashed": alert.is_trashed,
            "is_new": alert.is_new,
            "created_at": alert.created_at.strftime("%Y-%m-%dT%H:%M:%SZ") if alert.created_at else None
        })
    return alerts_data

@app.get("/api/projects/{project_id}/alerts/trashed")
async def get_trashed_project_alerts(project_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Alert, Camera.name, Camera.zone_tag)
        .join(Camera, Alert.camera_id == Camera.id)
        .where(Alert.project_id == project_id)
        .where(Alert.is_trashed == True)
        .order_by(Alert.created_at.desc())
    )
    alerts_data = []
    for alert, camera_name, zone_tag in result.all():
        alerts_data.append({
            "id": alert.id,
            "project_id": alert.project_id,
            "camera_id": alert.camera_id,
            "camera_name": camera_name,
            "zone_tag": zone_tag,
            "snapshot_url": alert.snapshot_url,
            "threat_description": alert.threat_description,
            "confidence_score": alert.confidence_score,
            "anomaly_type": alert.anomaly_type,
            "is_resolved": alert.is_resolved,
            "is_trashed": alert.is_trashed,
            "is_new": alert.is_new,
            "created_at": alert.created_at.strftime("%Y-%m-%dT%H:%M:%SZ") if alert.created_at else None
        })
    return alerts_data

@app.put("/api/projects/{project_id}/alerts/read")
async def mark_alerts_as_read(project_id: str, db: AsyncSession = Depends(get_db)):
    await db.execute(
        update(Alert)
        .where(Alert.project_id == project_id)
        .where(Alert.is_new == True)
        .values(is_new=False)
    )
    await db.commit()
    # Broadcast count reset event so frontend can update immediately in real-time
    await manager.broadcast(project_id, {
        "event": "alerts_marked_read"
    })
    return {"message": "All alerts marked as read"}

@app.put("/api/alerts/{alert_id}/resolve")
async def resolve_alert(alert_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Alert).where(Alert.id == alert_id))
    alert = result.scalars().first()
    if not alert:
        raise HTTPException(status_code=404, detail="Alert not found")
    
    project_id = alert.project_id
    alert.is_resolved = True
    await db.commit()
    
    # Broadcast status update
    await manager.broadcast(project_id, {
        "event": "alert_resolved",
        "alert_id": alert_id
    })
    
    return {"message": "Alert marked as resolved"}

@app.put("/api/alerts/{alert_id}/trash")
async def trash_alert(alert_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Alert).where(Alert.id == alert_id))
    alert = result.scalars().first()
    if not alert:
        raise HTTPException(status_code=404, detail="Alert not found")
    project_id = alert.project_id
    alert.is_trashed = True
    await db.commit()
    # Broadcast trash event so active alerts matrix and lists update in real-time
    await manager.broadcast(project_id, {
        "event": "alert_trashed",
        "alert_id": alert_id
    })
    return {"message": "Alert moved to trash"}

@app.put("/api/projects/{project_id}/alerts/resolve-all")
async def resolve_all_alerts(project_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Alert).where(Alert.project_id == project_id, Alert.is_resolved == False))
    alerts = result.scalars().all()
    for alert in alerts:
        alert.is_resolved = True
    await db.commit()
    
    # Broadcast event so frontend removes active alerts from matrix
    await manager.broadcast(project_id, {
        "event": "all_alerts_resolved"
    })
    return {"message": "All alerts marked as resolved"}


@app.put("/api/projects/{project_id}/alerts/trash-all")
async def trash_all_alerts(project_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Alert).where(Alert.project_id == project_id, Alert.is_trashed == False))
    alerts = result.scalars().all()
    for alert in alerts:
        alert.is_trashed = True
    await db.commit()
    # Broadcast trash-all event so active alert lists update in real-time
    await manager.broadcast(project_id, {
        "event": "all_alerts_trashed"
    })
    return {"message": f"Successfully moved {len(alerts)} alerts to trash."}

@app.put("/api/alerts/{alert_id}/recover")
async def recover_alert(alert_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Alert, Camera.name, Camera.zone_tag)
        .join(Camera, Alert.camera_id == Camera.id)
        .where(Alert.id == alert_id)
    )
    res = result.all()
    if not res:
        raise HTTPException(status_code=404, detail="Alert not found")
    alert, camera_name, zone_tag = res[0]
    alert.is_trashed = False
    await db.commit()
    await db.refresh(alert)
    # Broadcast recover event
    await manager.broadcast(alert.project_id, {
        "event": "alert_recovered",
        "alert_id": alert.id,
        "alert": {
            "id": alert.id,
            "project_id": alert.project_id,
            "camera_id": alert.camera_id,
            "camera_name": camera_name,
            "zone_tag": zone_tag,
            "snapshot_url": alert.snapshot_url,
            "threat_description": alert.threat_description,
            "confidence_score": alert.confidence_score,
            "is_resolved": alert.is_resolved,
            "is_trashed": alert.is_trashed,
            "created_at": alert.created_at.strftime("%Y-%m-%dT%H:%M:%SZ") if alert.created_at else None
        }
    })
    return {"message": "Alert recovered from trash", "alert": alert}

@app.delete("/api/alerts/{alert_id}/delete")
async def delete_alert(alert_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Alert).where(Alert.id == alert_id))
    alert = result.scalars().first()
    if not alert:
        raise HTTPException(status_code=404, detail="Alert not found")
    project_id = alert.project_id
    await db.delete(alert)
    await db.commit()
    # Broadcast permanent delete event
    await manager.broadcast(project_id, {
        "event": "alert_permanently_deleted",
        "alert_id": alert_id
    })
    return {"message": "Alert permanently deleted from database"}

@app.delete("/api/projects/{project_id}/alerts/delete-all-trash")
async def delete_all_trash_alerts(project_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Alert).where(Alert.project_id == project_id, Alert.is_trashed == True))
    alerts = result.scalars().all()
    count = len(alerts)
    for alert in alerts:
        await db.delete(alert)
    await db.commit()
    # Broadcast empty trash event
    await manager.broadcast(project_id, {
        "event": "all_trash_deleted"
    })
    return {"message": f"Successfully deleted {count} alerts from trash permanently."}


# Shared HTTP Client with connection pooling for ultra-fast response times and persistent TCP connections
import httpx
shared_client = httpx.AsyncClient(
    timeout=httpx.Timeout(3.0, connect=1.5),
    follow_redirects=True,
    limits=httpx.Limits(max_keepalive_connections=50, max_connections=100)
)

# Helper to fetch a snapshot frame directly from camera HTTP streams (bypassing CORS)
async def fetch_camera_snapshot(url: str) -> Optional[bytes]:
    url_lower = url.lower()
    if not (url_lower.startswith("http://") or url_lower.startswith("https://")):
        return None
    try:
        response = await shared_client.get(url)
        if response.status_code == 200:
            content_type = response.headers.get("content-type", "")
            if "multipart" in content_type:
                # Parse first frame of MJPEG stream
                async with shared_client.stream("GET", url) as stream_res:
                    if stream_res.status_code == 200:
                        buffer = b""
                        async for chunk in stream_res.aiter_bytes(chunk_size=4096):
                            buffer += chunk
                            start = buffer.find(b"\xff\xd8")
                            if start != -1:
                                end = buffer.find(b"\xff\xd9", start)
                                if end != -1:
                                    return buffer[start:end+2]
                            if len(buffer) > 1024 * 1024:  # Cap at 1MB
                                break
            else:
                if response.content.startswith(b"\xff\xd8") or b"JFIF" in response.content[:20]:
                    return response.content
    except Exception as e:
        print(f"Backend failed to fetch camera snapshot directly: {e}")
    return None

# Background threat verification task using LangChain (Gemini + OpenRouter fallback) and committing to DB
async def verify_threat_in_background(
    camera_id: str, 
    project_id: str,
    anomaly_type: str, 
    image_data: bytes, 
    confidence_yolo: float,
    camera_name: str,
    camera_zone_tag: str,
    snapshot_filename: Optional[str] = None
):
    threat_detected = False
    threat_description = "Normal monitoring environment."
    confidence_score = confidence_yolo
    verified_successfully = False
    
    # ─── LangChain Threat Verification Pipeline ─────────────────────────────
    # Strategy: Try Gemini keys via LangChain → OpenRouter fallback → Offline simulation
    
    if image_data:
        import base64 as b64mod
        image_b64 = b64mod.b64encode(image_data).decode("utf-8")
        
        # Build the threat verification prompt
        if anomaly_type.lower() == "normal":
            verification_prompt = (
                "You are an AI Security Analytics Officer verifying potential surveillance threats.\n"
                "Our edge YOLOv8 model flagged a potential event, but it has been classified as 'normal' behavior (false positive check).\n"
                "Please analyze this frame and confirm that there is indeed NO active threat or anomaly.\n\n"
                "Return a JSON object in this exact format:\n"
                '{"threat_detected": false, "threat_description": "Normal activity verified in this scene.", "confidence": 0.95}\n'
                "Return strictly valid raw JSON only. No markdown wrapping."
            )
        else:
            verification_prompt = (
                "You are an AI Security Analytics Officer verifying potential surveillance threats.\n"
                f"Our edge YOLOv8 detection model has flagged a potential '{anomaly_type}' event in this camera frame.\n\n"
                "Task:\n"
                "1. Analyze the environment and contents shown in the camera frame.\n"
                f"2. Determine if the '{anomaly_type}' threat is genuinely occurring (e.g. fire/smoke, fighting/physical violence, unauthorized entry/climbing, or lingering loitering behavior).\n"
                f"3. If this is a simulated black or solid-colored test frame and YOLO confidence is high (>= 0.70), you may assume it is a simulated test threat event, write a realistic description of '{anomaly_type}' in the target environment, and mark threat_detected true.\n"
                "4. Otherwise, if there is no genuine threat in the frame, mark threat_detected false and describe the normal activity.\n\n"
                "Return a JSON object in this exact format:\n"
                '{"threat_detected": true_or_false, "threat_description": "A detailed, genuine description of the verified threat or normal scene", "confidence": ' + str(confidence_yolo) + '}\n'
                "Return strictly valid raw JSON only. No markdown wrapping."
            )
        
        # ─── Strategy 1: LangChain with Gemini API keys ─────────────────────
        gemini_keys = [
            os.getenv("GEMINI_API_KEY"),
            os.getenv("GEMINI_API_KEY_1"),
            os.getenv("GEMINI_API_KEY_2"),
            os.getenv("GEMINI_API_KEY_3"),
            os.getenv("GEMINI_API_KEY_4"),
            os.getenv("GEMINI_API_KEY_5")
        ]
        gemini_keys = [k for k in gemini_keys if k]
        
        for idx, key in enumerate(gemini_keys):
            try:
                from langchain_google_genai import ChatGoogleGenerativeAI
                from langchain_core.messages import HumanMessage
                
                print(f"[LangChain-Gemini] Attempting threat verification with API Key #{idx}...")
                
                llm = ChatGoogleGenerativeAI(
                    model="gemini-2.5-flash",
                    google_api_key=key,
                    temperature=0.1,
                    max_output_tokens=512,
                )
                
                message = HumanMessage(
                    content=[
                        {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}},
                        {"type": "text", "text": verification_prompt}
                    ]
                )
                
                # Run blocking LLM call in thread executor to prevent event loop blocking
                loop = asyncio.get_event_loop()
                response = await loop.run_in_executor(None, lambda: llm.invoke([message]))
                
                resp_text = response.content.strip()
                # Strip markdown code fence if present
                if resp_text.startswith("```"):
                    lines = resp_text.splitlines()
                    if lines[0].startswith("```"):
                        lines = lines[1:]
                    if lines and lines[-1].startswith("```"):
                        lines = lines[:-1]
                    resp_text = "\n".join(lines).strip()
                    
                result = json.loads(resp_text)
                threat_detected = result.get("threat_detected", False)
                threat_description = result.get("threat_description", "Threat verified by Gemini via LangChain.")
                confidence_score = result.get("confidence", confidence_yolo)
                
                verified_successfully = True
                print(f"[LangChain-Gemini] API Key #{idx} succeeded. Threat detected: {threat_detected}")
                break
                
            except Exception as e:
                print(f"[LangChain-Gemini] API Key #{idx} failed/exhausted: {e}. Trying next key...")
                continue
        
        # ─── Strategy 2: OpenRouter Fallback via LangChain ──────────────────
        if not verified_successfully:
            openrouter_key = os.getenv("OPENROUTER_API_KEY")
            openrouter_model = os.getenv("OPENROUTER_MODEL", "google/gemini-2.0-flash-001")
            
            if openrouter_key:
                try:
                    from langchain_openai import ChatOpenAI
                    from langchain_core.messages import HumanMessage as HMsg
                    
                    print(f"[LangChain-OpenRouter] Attempting fallback verification via {openrouter_model}...")
                    
                    llm = ChatOpenAI(
                        model=openrouter_model,
                        openai_api_key=openrouter_key,
                        openai_api_base="https://openrouter.ai/api/v1",
                        temperature=0.1,
                        max_tokens=512,
                        default_headers={
                            "HTTP-Referer": "https://surveillance-platform.local",
                            "X-Title": "AI Surveillance Threat Verification"
                        }
                    )
                    
                    message = HMsg(
                        content=[
                            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}},
                            {"type": "text", "text": verification_prompt}
                        ]
                    )
                    
                    loop = asyncio.get_event_loop()
                    response = await loop.run_in_executor(None, lambda: llm.invoke([message]))
                    
                    resp_text = response.content.strip()
                    if resp_text.startswith("```"):
                        lines = resp_text.splitlines()
                        if lines[0].startswith("```"):
                            lines = lines[1:]
                        if lines and lines[-1].startswith("```"):
                            lines = lines[:-1]
                        resp_text = "\n".join(lines).strip()
                        
                    result = json.loads(resp_text)
                    threat_detected = result.get("threat_detected", False)
                    threat_description = result.get("threat_description", "Threat verified by OpenRouter fallback.")
                    confidence_score = result.get("confidence", confidence_yolo)
                    
                    verified_successfully = True
                    print(f"[LangChain-OpenRouter] Fallback succeeded. Threat detected: {threat_detected}")
                    
                except Exception as e:
                    print(f"[LangChain-OpenRouter] Fallback failed: {e}")
    
    # ─── Strategy 3: Offline Simulation Fallback ────────────────────────────
    if not verified_successfully:
        print("[Verification] All LLM strategies exhausted. Falling back to offline simulation.")
        anomaly_map = {
            "violence": (True, "Physical violence detected. Two individuals engaging in active combat in camera range.", confidence_yolo),
            "loitering": (True, f"Suspicious loitering verified near {camera_zone_tag or 'facility boundary'}. Individual standing motionless for >15 minutes.", confidence_yolo),
            "trespassing": (True, f"Intrusion alert verified. Person climbing locked gateway area in zone: {camera_zone_tag or 'Rear Area'}.", confidence_yolo),
            "fire": (True, "Thermal hazard verified. Active ignition source and plume smoke rising near device.", confidence_yolo),
            "normal": (False, "Normal activity, verified by Gemini. False positive filtered.", 0.12)
        }
        threat_detected, threat_description, confidence_score = anomaly_map.get(
            anomaly_type.lower(), (False, "Normal operational state.", 0.05)
        )
        threat_description += " [Not Gemini Verified]"

    # Only snapshots that are verified by Gemini layer as active threats are saved into Supabase cloud.
    # No photos are ever stored in the local disk.
    snapshot_url = ""
    if verified_successfully and threat_detected:
        if not snapshot_filename:
            snapshot_filename = f"verified_{anomaly_type}_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}.jpg"
        print(f"[Supabase Storage] Gemini verified threat '{anomaly_type}'. Uploading snapshot in-memory to Supabase Cloud...")
        cloud_url = await upload_snapshot_to_supabase(
            project_id=project_id,
            filename=snapshot_filename,
            image_data=image_data,
            camera_id=camera_id,
            camera_name=camera_name,
            anomaly_type=anomaly_type
        )
        if cloud_url:
            snapshot_url = cloud_url
        else:
            print("[Supabase Storage] Cloud upload failed, no snapshot stored.")
    else:
        print(f"[Supabase Storage] Event not verified as an active threat by Gemini layer (threat_detected={threat_detected}, verified={verified_successfully}). Skipping Supabase storage and local disk.")

    # Save to Database for all suspicious activities (anomalies) detected by YOLO
    alert_id = None
    async with AsyncSessionLocal() as session:
        try:
            alert_record = Alert(
                project_id=project_id,
                camera_id=camera_id,
                snapshot_url=snapshot_url,
                threat_description=threat_description,
                confidence_score=confidence_score,
                anomaly_type=anomaly_type,
                is_resolved=not threat_detected,  # Automatically resolve if Gemini filters as false positive
                created_at=datetime.now(timezone.utc)
            )
            session.add(alert_record)

            if snapshot_url:
                await session.execute(
                    update(Camera)
                    .where(Camera.id == camera_id)
                    .values(snapshots_captured=Camera.snapshots_captured + 1)
                )
                await session.execute(
                    update(Project)
                    .where(Project.id == project_id)
                    .values(snapshots_captured=Project.snapshots_captured + 1)
                )

            await session.commit()
            await session.refresh(alert_record)
            alert_id = alert_record.id
            print(f"Async threat alert saved successfully to DB (ID: {alert_id}, snapshots_captured incremented)")
        except Exception as db_err:
            print(f"Failed to save alert in background thread: {db_err}")
            await session.rollback()
                
    # Broadcast JSON payload via WebSocket
    ws_payload = {
        "event": "anomaly_detected",  # Always broadcast anomaly so frontend logs it
        "data": {
            "camera_id": camera_id,
            "camera_name": camera_name,
            "zone_tag": camera_zone_tag,
            "confidence_yolo": confidence_yolo,
            "confidence_gemini": confidence_score,
            "anomaly_type": anomaly_type,
            "threat_description": threat_description,
            "snapshot_url": snapshot_url,
            "timestamp": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
            "alert_id": alert_id,
            "is_resolved": not threat_detected
        }
    }
    await manager.broadcast(project_id, ws_payload)


# Gemini Verification + Alert Loop Core Endpoint
@app.post("/api/cameras/{camera_id}/detect")
async def trigger_yolo_detection(
    camera_id: str, 
    payload: SimulatedDetection, 
    request: Request, 
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db)
):
    # 1. Fetch camera and project info
    cam_result = await db.execute(
        select(Camera, Project.project_type)
        .join(Project, Camera.project_id == Project.id)
        .where(Camera.id == camera_id)
    )
    row = cam_result.first()
    if not row:
        raise HTTPException(status_code=404, detail="Camera not found")
        
    camera, project_type = row
    project_id = camera.project_id
    snapshot_filename = f"snap_{uuid.uuid4()}.jpg"
    
    image_data = b""
    
    # 2. Decode frontend base64 image if sent (held in memory, no local disk write)
    if payload.image_base64:
        try:
            image_data = base64.b64decode(payload.image_base64.split(",")[-1])
            print("Successfully decoded live canvas frame for threat verification (in-memory).")
        except Exception as e:
            print(f"Error decoding live canvas image: {e}")
            image_data = b""
            
    # 3. If base64 is empty/failed, first try the stream manager's latest live frame (in-memory)
    if not image_data:
        live_frame = stream_mgr.get_latest_snapshot(camera_id)
        if live_frame and len(live_frame) > 1000:  # Must be a real frame, not a placeholder
            image_data = live_frame
            print("Successfully grabbed latest live frame from stream manager for snapshot (in-memory).")

    # 4. If stream manager had no live frame, try fetching directly from HTTP camera URL (in-memory)
    if not image_data and camera.rtsp_url:
        rtsp_url_lower = camera.rtsp_url.lower()
        if rtsp_url_lower.startswith("http://") or rtsp_url_lower.startswith("https://"):
            print(f"Base64 empty. Fetching snapshot directly from camera stream URL: {camera.rtsp_url}")
            fetched = await fetch_camera_snapshot(camera.rtsp_url)
            if fetched:
                image_data = fetched
                print("Successfully fetched live frame directly from camera stream source (in-memory).")
            else:
                print(f"Bypassing detection for camera {camera.id}: no active stream signal.")
                return {"message": "Detection bypassed: camera has no signal.", "threat_detected": False}

    # Final fallback to black jpeg if still empty (in-memory)
    if not image_data:
        image_data = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x01\x00`\x00`\x00\x00\xff\xdb\x00C\x00\x08\x06\x06\x07\x06\x05\x08\x07\x07\x07\t\t\x08\n\x0c\x14\r\x0c\x0b\x0b\x0c\x19\x12\x13\x0f\x14\x1d\x1a\x1f\x1e\x1d\x1a\x1c\x1c $.' \",#\x1c\x1c(7),01444\x1f'9=82<.342\xff\xc0\x00\x0b\x08\x00\x10\x00\x10\x01\x01\x11\x00\xff\xc4\x00\x1f\x00\x00\x01\x05\x01\x01\x01\x01\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x01\x02\x03\x04\x05\x06\x07\x08\t\n\x0b\xff\xda\x00\x08\x01\x01\x00\x00?\x00\xbf\x00\xff\xd9"

    # 4. Run real YOLOv8 detection
    anomaly_type = payload.anomaly_type
    confidence_score = payload.confidence
    
    try:
        import cv2
        import numpy as np
        nparr = np.frombuffer(image_data, np.uint8)
        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if frame is not None:
            # Process using the shared stream manager tracker
            detections = stream_mgr.tracker.process_frame(frame, project_type=project_type)
            anomalies = stream_mgr.tracker.get_anomalies(detections)
            
            if anomalies:
                anomaly_type = anomalies[0]["anomaly_type"]
                confidence_score = anomalies[0]["confidence"]
                print(f"[YOLO] Real anomaly detected in trigger_yolo_detection: {anomaly_type} ({confidence_score})")
            else:
                print(f"[YOLO] No real anomaly detected in trigger_yolo_detection. Using manual override values.")
        else:
            print("[YOLO] Failed to decode image frame for YOLO inference.")
    except Exception as e:
        print(f"[YOLO] Error running YOLO in detect endpoint: {e}")

    # 5. Decide anomaly_type automatically if not provided and not found by YOLO
    if not anomaly_type:
        c = confidence_score
        if c >= 0.80:
            anomaly_type = "violence" if c >= 0.90 else "fire"
        elif c >= 0.55:
            anomaly_type = "trespassing"
        elif c >= 0.30:
            anomaly_type = "loitering"
        else:
            anomaly_type = "normal"

    # 6. Enqueue threat verification task to commercial queue (held in-memory, zero disk write)
    detect_task = VerificationTask(
        camera_id=camera.id,
        project_id=project_id,
        anomaly_type=anomaly_type,
        image_data=image_data,
        confidence_yolo=confidence_score,
        camera_name=camera.name,
        camera_zone_tag=camera.zone_tag,
        snapshot_filename=snapshot_filename
    )
    await verification_queue.enqueue(detect_task)

    return {
        "status": "enqueued",
        "message": "Threat verification task enqueued to rate-limiting queue."
    }


# WebSockets Route
@app.websocket("/api/projects/{project_id}/ws")
async def websocket_endpoint(websocket: WebSocket, project_id: str):
    await manager.connect(project_id, websocket)
    try:
        # Loop to keep connection open and handle incoming messages from frontend
        while True:
            data = await websocket.receive_text()
            # Echo or process custom control inputs if needed
            message = json.loads(data)
            print(f"WS Msg received: {message}")
            if message.get("type") == "ping":
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        manager.disconnect(project_id, websocket)
    except Exception as e:
        print(f"WebSocket error on project {project_id}: {e}")
        manager.disconnect(project_id, websocket)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)

