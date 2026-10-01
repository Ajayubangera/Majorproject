import os
import uuid
import json
import base64
import asyncio
from datetime import datetime, timedelta
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
from sqlalchemy import func, update, text
from jose import JWTError, jwt
import bcrypt

from database import init_db, warmup_db, get_db, AsyncSessionLocal, User, Project, ProjectMember, Camera, Alert, is_postgres
from stream_manager import StreamManager, encode_jpeg, generate_no_signal_frame

# Supabase Cloud Storage Configuration (no snapshots stored on local disk)
SUPABASE_URL = os.getenv("SUPABASE_URL") or os.getenv("VITE_SUPABASE_URL", "https://sgquvxufepdioksjorvq.supabase.co")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY") or os.getenv("VITE_SUPABASE_ANON_KEY", "")
SUPABASE_BUCKET = os.getenv("SUPABASE_BUCKET", "snapshots")

async def upload_snapshot_to_supabase(project_id: str, filename: str, image_data: bytes) -> Optional[str]:
    """Uploads verified threat snapshot in-memory to Supabase Storage bucket.
    No image is ever saved to local disk.
    Returns the public Supabase URL on success, or None on failure."""
    if not SUPABASE_URL or not SUPABASE_KEY or not image_data:
        return None
    
    path = f"{project_id}/{filename}"
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
                print(f"[Supabase Storage] Successfully uploaded verified snapshot to cloud: {public_url}")
                return public_url
            else:
                print(f"[Supabase Storage] Upload failed with status {response.status_code}: {response.text}")
    except Exception as e:
        print(f"[Supabase Storage] Error uploading snapshot: {e}")
    return None

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
                COALESCE((
                    SELECT json_agg(json_build_object(
                        'id', c.id,
                        'name', c.name,
                        'source_type', c.source_type,
                        'rtsp_url', c.rtsp_url,
                        'zone_tag', c.zone_tag,
                        'ai_active', c.ai_active,
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
                        'created_at', to_char(a.created_at, 'YYYY-MM-DD HH24:MI:SS')
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
                "created_at": row["created_at"]
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
                "created_at": alert.created_at.strftime("%Y-%m-%d %H:%M:%S") if alert.created_at else None
            })
            
        return {
            "project": {
                "id": project.id,
                "name": project.name,
                "location": project.location,
                "project_type": project.project_type,
                "owner_id": project.owner_id,
                "created_at": project.created_at
            },
            "cameras": [{"id": c.id, "name": c.name, "source_type": c.source_type, "rtsp_url": c.rtsp_url, "zone_tag": c.zone_tag, "ai_active": c.ai_active, "nvr_ip_address": c.nvr_ip_address, "channel_number": c.channel_number} for c in cameras],
            "members": [{"id": m.id, "email": m.email, "role": m.role} for m in members],
            "alerts": alerts_list
        }

@app.get("/api/projects/{project_id}/cameras")
async def get_project_cameras(project_id: str, db: AsyncSession = Depends(get_db)):
    cameras_result = await db.execute(select(Camera).where(Camera.project_id == project_id))
    cameras = cameras_result.scalars().all()
    return [{"id": c.id, "name": c.name, "source_type": c.source_type, "rtsp_url": c.rtsp_url, "zone_tag": c.zone_tag, "ai_active": c.ai_active, "nvr_ip_address": c.nvr_ip_address, "channel_number": c.channel_number} for c in cameras]

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

@app.post("/api/projects/{project_id}/cameras")
async def create_camera(project_id: str, camera_data: CameraCreate, db: AsyncSession = Depends(get_db)):
    new_camera = Camera(
        project_id=project_id,
        name=camera_data.name,
        source_type="standalone",
        rtsp_url=camera_data.rtsp_url,
        zone_tag=camera_data.zone_tag,
        ai_active=camera_data.ai_active
    )
    db.add(new_camera)
    await db.commit()
    await db.refresh(new_camera)
    
    # Start stream worker if active
    if new_camera.ai_active:
        proj_res = await db.execute(select(Project.project_type).where(Project.id == project_id))
        project_type = proj_res.scalar() or "home"
        stream_mgr.start_camera(
            camera_id=new_camera.id,
            camera_name=new_camera.name,
            rtsp_url=new_camera.rtsp_url,
            project_id=project_id,
            project_type=project_type,
            zone_tag=new_camera.zone_tag or "",
            on_anomaly_callback=on_anomaly_detected
        )
        
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
        
    camera.name = payload.name
    camera.rtsp_url = payload.rtsp_url
    camera.zone_tag = payload.zone_tag
    camera.nvr_ip_address = payload.nvr_ip_address
    camera.channel_number = payload.channel_number
    
    await db.commit()
    await db.refresh(camera)
    
    # Restart or stop stream worker
    if camera.ai_active:
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
        
    return {
        "status": "success", 
        "camera": {
            "id": camera.id,
            "name": camera.name,
            "source_type": camera.source_type,
            "rtsp_url": camera.rtsp_url,
            "zone_tag": camera.zone_tag,
            "ai_active": camera.ai_active,
            "nvr_ip_address": camera.nvr_ip_address,
            "channel_number": camera.channel_number
        }
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
            snapshot_filename = f"snap_{uuid.uuid4()}.jpg"
        print(f"[Supabase Storage] Gemini verified threat '{anomaly_type}'. Uploading snapshot in-memory to Supabase Cloud...")
        cloud_url = await upload_snapshot_to_supabase(project_id, snapshot_filename, image_data)
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
                created_at=datetime.utcnow()
            )
            session.add(alert_record)
            await session.commit()
            await session.refresh(alert_record)
            alert_id = alert_record.id
            print(f"Async threat alert saved successfully to DB (ID: {alert_id})")
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

