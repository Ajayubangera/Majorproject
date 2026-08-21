-- ====================================================================
-- Aegis Guard Surveillance & AI Video Analytics Platform
-- Supabase PostgreSQL Schema (Exact Mirror of System Models)
-- ====================================================================

-- 1. Enable UUID Extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. Users Table
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(36) PRIMARY KEY,
    full_name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    organization_name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS ix_users_email ON users(email);

-- 3. Projects Table
CREATE TABLE IF NOT EXISTS projects (
    id VARCHAR(36) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    location TEXT NOT NULL,
    project_type VARCHAR(50) NOT NULL,
    owner_id VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_project_type CHECK (project_type IN ('school', 'home', 'government'))
);

-- 4. Project Members Table
CREATE TABLE IF NOT EXISTS project_members (
    id VARCHAR(36) PRIMARY KEY,
    project_id VARCHAR(36) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL,
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_project_member UNIQUE (project_id, email),
    CONSTRAINT chk_member_role CHECK (role IN ('admin', 'responder', 'viewer'))
);

-- 5. Cameras Table
CREATE TABLE IF NOT EXISTS cameras (
    id VARCHAR(36) PRIMARY KEY,
    project_id VARCHAR(36) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    source_type VARCHAR(50) NOT NULL,
    nvr_ip_address VARCHAR(100),
    channel_number INTEGER DEFAULT 1,
    rtsp_url TEXT NOT NULL,
    zone_tag VARCHAR(100),
    ai_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_source_type CHECK (source_type IN ('nvr', 'standalone'))
);

-- 6. Alerts Table
CREATE TABLE IF NOT EXISTS alerts (
    id VARCHAR(36) PRIMARY KEY,
    project_id VARCHAR(36) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    camera_id VARCHAR(36) NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
    snapshot_url TEXT NOT NULL,
    threat_description TEXT NOT NULL,
    confidence_score DOUBLE PRECISION NOT NULL,
    anomaly_type VARCHAR(50),
    is_resolved BOOLEAN DEFAULT FALSE,
    is_trashed BOOLEAN DEFAULT FALSE,
    is_new BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS ix_alerts_project_id ON alerts(project_id);
CREATE INDEX IF NOT EXISTS ix_alerts_camera_id ON alerts(camera_id);
CREATE INDEX IF NOT EXISTS ix_alerts_created_at ON alerts(created_at DESC);
