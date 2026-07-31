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
    
    # If using postgresql+asyncpg, strip out sslmode/channel_binding query params
    # and pass ssl=True in connection arguments instead.
    if "postgresql+asyncpg" in DATABASE_URL:
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

# Create engine — tuned for Neon serverless PostgreSQL which aggressively closes idle connections
is_postgres = "postgresql" in DATABASE_URL
engine = create_async_engine(
    DATABASE_URL,
    echo=False,
    future=True,
    pool_pre_ping=True,
    pool_recycle=60 if is_postgres else 300,
    pool_size=10 if is_postgres else 5,
    max_overflow=20 if is_postgres else 10,
    pool_timeout=30 if is_postgres else 10,  # Allow 30 seconds for pool checkout during cold starts
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
    owner_id = Column(String(255), nullable=False) # Store user email or sub id
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
    project_id = Column(String(36), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    email = Column(String(255), nullable=False)
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
    project_id = Column(String(36), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(255), nullable=False)
    source_type = Column(String(50), nullable=False)
    nvr_ip_address = Column(String(100), nullable=True)
    channel_number = Column(Integer, default=1)
    rtsp_url = Column(Text, nullable=False)
    zone_tag = Column(String(100), nullable=True)
    ai_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint(source_type.in_(['nvr', 'standalone']), name='chk_source_type'),
    )

    project = relationship("Project", back_populates="cameras")
    alerts = relationship("Alert", back_populates="camera", cascade="all, delete-orphan")

class Alert(Base):
    __tablename__ = "alerts"
    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    project_id = Column(String(36), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    camera_id = Column(String(36), ForeignKey("cameras.id", ondelete="CASCADE"), nullable=False)
    snapshot_url = Column(Text, nullable=False)
    threat_description = Column(Text, nullable=False)
    confidence_score = Column(Float, nullable=False)
    anomaly_type = Column(String(50), nullable=True)  # running, loitering, fighting, phone_use
    is_resolved = Column(Boolean, default=False)
    is_trashed = Column(Boolean, default=False)
    is_new = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

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
        
        # Safe schema migration for is_trashed and is_new columns using SQLAlchemy inspector
        try:
            from sqlalchemy import inspect, text
            def check_and_add_columns(sync_conn):
                inspector = inspect(sync_conn)
                columns = [col['name'] for col in inspector.get_columns('alerts')]
                if 'is_trashed' not in columns:
                    sync_conn.execute(text("ALTER TABLE alerts ADD COLUMN is_trashed BOOLEAN DEFAULT FALSE;"))
                    print("Migration: Added is_trashed column to alerts table successfully.")
                if 'is_new' not in columns:
                    sync_conn.execute(text("ALTER TABLE alerts ADD COLUMN is_new BOOLEAN DEFAULT TRUE;"))
                    print("Migration: Added is_new column to alerts table successfully.")
                if 'anomaly_type' not in columns:
                    sync_conn.execute(text("ALTER TABLE alerts ADD COLUMN anomaly_type VARCHAR(50);"))
                    print("Migration: Added anomaly_type column to alerts table successfully.")
            await conn.run_sync(check_and_add_columns)
        except Exception as e:
            print(f"Migration warning: Could not verify/alter alerts table: {e}")

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
