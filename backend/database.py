import os
import uuid
from datetime import datetime
from sqlalchemy import (
    Column, String, Text, Integer, Boolean, DateTime, Float, ForeignKey, UniqueConstraint, CheckConstraint, func
)
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import declarative_base, relationship
from dotenv import load_dotenv

# Load env variables
load_dotenv()

# Determine DB URL
# If a POSTGRESQL URL is given (e.g. from Neon), map it to the asyncpg dialect
DATABASE_URL = os.getenv("DATABASE_URL")
connect_args = {}

if not DATABASE_URL:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    db_path = os.path.join(BASE_DIR, "security.db")
    DATABASE_URL = f"sqlite+aiosqlite:///{db_path}"
    connect_args = {"check_same_thread": False}
else:
    # Clean quotes if literal in env
    DATABASE_URL = DATABASE_URL.strip('"').strip("'")
    if DATABASE_URL.startswith("postgresql://"):
        DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+asyncpg://", 1)
    
    # If using postgresql+asyncpg, verify driver is installed; otherwise fallback to SQLite
    if "postgresql+asyncpg" in DATABASE_URL:
        try:
            import asyncpg
            if "?" in DATABASE_URL:
                base_url, _ = DATABASE_URL.split("?", 1)
                DATABASE_URL = base_url
            import ssl
            ssl_context = ssl.create_default_context()
            ssl_context.check_hostname = False
            ssl_context.verify_mode = ssl.CERT_NONE
            connect_args = {
                "ssl": ssl_context,
                "timeout": 30.0  # Allow 30 seconds for Neon database connection wake-up
            }
        except ImportError:
            print("[Database Warning] 'asyncpg' driver not found. Falling back to local SQLite database.")
            BASE_DIR = os.path.dirname(os.path.abspath(__file__))
            db_path = os.path.join(BASE_DIR, "security.db")
            DATABASE_URL = f"sqlite+aiosqlite:///{db_path}"
            connect_args = {"check_same_thread": False}

# Create engine — tuned for high performance with Supabase / PostgreSQL / SQLite
is_postgres = "postgresql" in DATABASE_URL
if is_postgres:
    connect_args["server_settings"] = {
        "application_name": "surveillance_backend",
        "jit": "off"  # Disabling JIT prevents query plan compilation lag on simple queries
    }

engine = create_async_engine(
    DATABASE_URL,
    echo=False,
    future=True,
    pool_pre_ping=is_postgres,  # True for PostgreSQL to prevent stale connection errors; False for SQLite
    pool_recycle=600,
    pool_size=20 if is_postgres else 5,
    max_overflow=30 if is_postgres else 10,
    pool_timeout=15 if is_postgres else 10,
    connect_args=connect_args
)

# Async session factory
AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False
)

Base = declarative_base()

# Models Definition
class User(Base):
    __tablename__ = "users"
    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    full_name = Column(String(255), nullable=False)
    email = Column(String(255), unique=True, nullable=False, index=True)
    password_hash = Column(String(255), nullable=False)
    organization_name = Column(String(255), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

class Project(Base):
    __tablename__ = "projects"
    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name = Column(String(255), nullable=False)
    location = Column(Text, nullable=False)
    project_type = Column(String(50), nullable=False)
    owner_id = Column(String(255), nullable=False, index=True) # Store user email or sub id
    snapshots_captured = Column(Integer, default=0, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    
    __table_args__ = (
        CheckConstraint(project_type.in_(['school', 'home', 'government']), name='chk_project_type'),
    )
    
    # Relationships
    members = relationship("ProjectMember", back_populates="project", cascade="all, delete-orphan")
    cameras = relationship("Camera", back_populates="project", cascade="all, delete-orphan")
    alerts = relationship("Alert", back_populates="project", cascade="all, delete-orphan")

class ProjectMember(Base):
    __tablename__ = "project_members"
    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    project_id = Column(String(36), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    email = Column(String(255), nullable=False, index=True)
    role = Column(String(50), nullable=False)
    joined_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint("project_id", "email", name="uq_project_member"),
        CheckConstraint(role.in_(['admin', 'responder', 'viewer']), name='chk_member_role'),
    )

    project = relationship("Project", back_populates="members")

class Camera(Base):
    __tablename__ = "cameras"
    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    project_id = Column(String(36), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(255), nullable=False)
    source_type = Column(String(50), nullable=False)
    nvr_ip_address = Column(String(100), nullable=True)
    channel_number = Column(Integer, default=1)
    rtsp_url = Column(Text, nullable=False)
    zone_tag = Column(String(100), nullable=True)
    ai_active = Column(Boolean, default=True)
    allowed_members = Column(Text, nullable=True, default="[]")  # JSON list of member emails/roles with view permission
    snapshots_captured = Column(Integer, default=0, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint(source_type.in_(['nvr', 'standalone']), name='chk_source_type'),
    )

    project = relationship("Project", back_populates="cameras")
    alerts = relationship("Alert", back_populates="camera", cascade="all, delete-orphan")

class Alert(Base):
    __tablename__ = "alerts"
    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    project_id = Column(String(36), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    camera_id = Column(String(36), ForeignKey("cameras.id", ondelete="CASCADE"), nullable=False, index=True)
    snapshot_url = Column(Text, nullable=False)
    threat_description = Column(Text, nullable=False)
    confidence_score = Column(Float, nullable=False)
    anomaly_type = Column(String(50), nullable=True)  # running, loitering, fighting, phone_use
    is_resolved = Column(Boolean, default=False, index=True)
    is_trashed = Column(Boolean, default=False, index=True)
    is_new = Column(Boolean, default=True, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)

    project = relationship("Project", back_populates="alerts")
    camera = relationship("Camera", back_populates="alerts")

# DB Initialization function
async def init_db():
    async with engine.begin() as conn:
        # If PostgreSQL, enable uuid extension just in case
        if "postgresql" in DATABASE_URL:
            from sqlalchemy import text
            await conn.execute(text('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";'))
        await conn.run_sync(Base.metadata.create_all)
        
        # Fast Index and Schema Optimization
        try:
            from sqlalchemy import inspect, text
            def check_and_add_indexes_columns(sync_conn):
                inspector = inspect(sync_conn)
                tables = inspector.get_table_names()
                
                if 'alerts' in tables:
                    columns = [col['name'] for col in inspector.get_columns('alerts')]
                    if 'is_trashed' not in columns:
                        sync_conn.execute(text("ALTER TABLE alerts ADD COLUMN is_trashed BOOLEAN DEFAULT FALSE;"))
                    if 'is_new' not in columns:
                        sync_conn.execute(text("ALTER TABLE alerts ADD COLUMN is_new BOOLEAN DEFAULT TRUE;"))
                    if 'anomaly_type' not in columns:
                        sync_conn.execute(text("ALTER TABLE alerts ADD COLUMN anomaly_type VARCHAR(50);"))

                if 'projects' in tables:
                    proj_columns = [col['name'] for col in inspector.get_columns('projects')]
                    if 'snapshots_captured' not in proj_columns:
                        try:
                            sync_conn.execute(text("ALTER TABLE projects ADD COLUMN IF NOT EXISTS snapshots_captured INTEGER DEFAULT 0;"))
                        except Exception:
                            pass
                    try:
                        sync_conn.execute(text("""
                            UPDATE projects SET snapshots_captured = COALESCE(
                                (SELECT count(*) FROM alerts WHERE alerts.project_id = projects.id AND alerts.snapshot_url IS NOT NULL AND alerts.snapshot_url != ''), 
                                0
                            );
                        """))
                    except Exception:
                        pass

                if 'cameras' in tables:
                    cam_columns = [col['name'] for col in inspector.get_columns('cameras')]
                    if 'allowed_members' not in cam_columns:
                        try:
                            sync_conn.execute(text("ALTER TABLE cameras ADD COLUMN IF NOT EXISTS allowed_members TEXT DEFAULT '[]';"))
                        except Exception:
                            pass
                    if 'snapshots_captured' not in cam_columns:
                        try:
                            sync_conn.execute(text("ALTER TABLE cameras ADD COLUMN IF NOT EXISTS snapshots_captured INTEGER DEFAULT 0;"))
                        except Exception:
                            pass
                    try:
                        sync_conn.execute(text("""
                            UPDATE cameras SET snapshots_captured = COALESCE(
                                (SELECT count(*) FROM alerts WHERE alerts.camera_id = cameras.id AND alerts.snapshot_url IS NOT NULL AND alerts.snapshot_url != ''), 
                                0
                            );
                        """))
                    except Exception:
                        pass

                # Create performance indexes
                index_sqls = [
                    "CREATE INDEX IF NOT EXISTS idx_projects_owner_id ON projects (owner_id);",
                    "CREATE INDEX IF NOT EXISTS idx_project_members_email ON project_members (email);",
                    "CREATE INDEX IF NOT EXISTS idx_project_members_project_id ON project_members (project_id);",
                    "CREATE INDEX IF NOT EXISTS idx_cameras_project_id ON cameras (project_id);",
                    "CREATE INDEX IF NOT EXISTS idx_alerts_project_id ON alerts (project_id);",
                    "CREATE INDEX IF NOT EXISTS idx_alerts_camera_id ON alerts (camera_id);",
                    "CREATE INDEX IF NOT EXISTS idx_alerts_is_trashed_new ON alerts (project_id, is_trashed, is_new);",
                    "CREATE INDEX IF NOT EXISTS idx_alerts_proj_trashed_created ON alerts (project_id, is_trashed, created_at DESC);",
                    "CREATE INDEX IF NOT EXISTS idx_alerts_proj_resolved ON alerts (project_id, is_resolved);",
                    "CREATE INDEX IF NOT EXISTS idx_alerts_created_at ON alerts (created_at DESC);"
                ]
                for idx_sql in index_sqls:
                    try:
                        sync_conn.execute(text(idx_sql))
                    except Exception:
                        pass

            await conn.run_sync(check_and_add_indexes_columns)
        except Exception as e:
            print(f"Migration warning: {e}")

# Pre-warm connection pool on startup
async def warmup_db():
    try:
        from sqlalchemy import text
        async with AsyncSessionLocal() as session:
            await session.execute(text("SELECT 1;"))
        print("[Database] Connection pool successfully warmed up.")
    except Exception as e:
        print(f"[Database] Warmup notice: {e}")

# Session dependency — with resilient error handling for serverless DB connections
async def get_db():
    session = AsyncSessionLocal()
    try:
        yield session
    except Exception:
        try:
            await session.rollback()
        except Exception:
            pass
        raise
    finally:
        try:
            await session.close()
        except Exception:
            pass
