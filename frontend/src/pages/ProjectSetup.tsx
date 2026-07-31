import React, { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { 
  Cpu, Video, Users, ArrowLeft, Check, AlertCircle, Play, Save, ChevronRight, Settings, Loader2 
} from "lucide-react";
import { getCurrentUser } from "../utils/auth";

const API_BASE = `http://${window.location.hostname}:8000`;

interface MemberItem {
  id: string;
  email: string;
  role: string;
}

interface ProjectData {
  id: string;
  name: string;
  location: string;
  project_type: "school" | "home" | "government";
  owner_id: string;
  created_at: string;
}

export default function ProjectSetup() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const currentUser = getCurrentUser();

  const [activeTab, setActiveTab] = useState<"nvr" | "standalone">("nvr");
  const [project, setProject] = useState<ProjectData | null>(null);
  const [members, setMembers] = useState<MemberItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  
  // Tab A - NVR Form State
  const [nvrForm, setNvrForm] = useState({
    deviceLabel: "",
    brand: "Hikvision",
    ipAddress: "",
    rtspPort: 554,
    httpPort: 8000,
    username: "",
    password: "",
    totalChannels: 4,
  });

  // Tab B - Standalone Form State
  const [standaloneForm, setStandaloneForm] = useState({
    name: "",
    ipAddress: "",
    port: 8080,
    streamType: "http",
    path: "/video",
    zoneTag: "",
    aiActive: true,
  });

  // Access Modal State
  const [showAccessModal, setShowAccessModal] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("viewer");

  // Notifications / Alert logs
  const [testResult, setTestResult] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (!currentUser) {
      navigate("/auth");
      return;
    }

    const fetchProjectAndMembers = async () => {
      try {
        const response = await fetch(`${API_BASE}/api/projects/${id}`);
        if (!response.ok) {
          throw new Error("Project setup data not found.");
        }
        const data = await response.json();
        setProject(data.project);
        setMembers(data.members);
        
        // Setup initial default zone
        if (data.project.project_type === "school") {
          setStandaloneForm(prev => ({ ...prev, zoneTag: "Corridor" }));
        } else if (data.project.project_type === "home") {
          setStandaloneForm(prev => ({ ...prev, zoneTag: "Main Door" }));
        } else {
          setStandaloneForm(prev => ({ ...prev, zoneTag: "Generic Zone" }));
        }
      } catch (err) {
        console.error("Failed to load project", err);
      } finally {
        setLoading(false);
      }
    };

    fetchProjectAndMembers();
  }, [id, currentUser, navigate]);

  // Tab A: Handshake Connection Test
  const handleTestNVR = async () => {
    if (!nvrForm.ipAddress) {
      setTestResult({ type: "error", text: "Please enter NVR Target IP Address to run handshake ping." });
      return;
    }
    setActionLoading("test_nvr");
    setTestResult(null);
    try {
      const response = await fetch(`${API_BASE}/api/projects/${id}/test-nvr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_label: nvrForm.deviceLabel || "Security NVR",
          brand: nvrForm.brand,
          ip_address: nvrForm.ipAddress,
          rtsp_port: Number(nvrForm.rtspPort),
          http_port: Number(nvrForm.httpPort),
          username: nvrForm.username,
          password: nvrForm.password,
          total_channels: Number(nvrForm.totalChannels),
        }),
      });
      const data = await response.json();
      setTestResult({
        type: data.status === "success" ? "success" : "error",
        text: data.message,
      });
    } catch (err) {
      setTestResult({ type: "error", text: "Handshake ping command failed. Server unreachable." });
    } finally {
      setActionLoading(null);
    }
  };

  // Tab A: Save & Map Channels
  const handleSaveNVR = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nvrForm.ipAddress || !nvrForm.username) {
      setTestResult({ type: "error", text: "IP Address and Username are required to map NVR channels." });
      return;
    }

    setActionLoading("save_nvr");
    setTestResult(null);
    try {
      const response = await fetch(`${API_BASE}/api/projects/${id}/nvr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_label: nvrForm.deviceLabel || "Security NVR",
          brand: nvrForm.brand,
          ip_address: nvrForm.ipAddress,
          rtsp_port: Number(nvrForm.rtspPort),
          http_port: Number(nvrForm.httpPort),
          username: nvrForm.username,
          password: nvrForm.password,
          total_channels: Number(nvrForm.totalChannels),
        }),
      });

      if (!response.ok) throw new Error("Failed to map channels.");
      const data = await response.json();
      setTestResult({ type: "success", text: `${data.message} Configured feeds mapped successfully.` });
      
      // Auto routing to live matrix after slight delay
      setTimeout(() => {
        navigate(`/project/${id}/view`);
      }, 1500);
    } catch (err: any) {
      setTestResult({ type: "error", text: err.message || "Could not map NVR channels." });
    } finally {
      setActionLoading(null);
    }
  };

  // Tab B: Handshake Connection Test
  const handleTestStandalone = async () => {
    if (!standaloneForm.ipAddress) {
      setTestResult({
        type: "error",
        text: standaloneForm.streamType === "usb"
          ? "Please enter a Webcam Index to run preview handshake."
          : "Please enter an IPv4 Address to run preview handshake."
      });
      return;
    }
    const pathPrefix = standaloneForm.path.startsWith("/") ? "" : "/";
    const combinedUrl = standaloneForm.streamType === "usb"
      ? standaloneForm.ipAddress
      : `${standaloneForm.streamType}://${standaloneForm.ipAddress}:${standaloneForm.port}${pathPrefix}${standaloneForm.path}`;

    setActionLoading("test_cam");
    setTestResult(null);
    try {
      const response = await fetch(`${API_BASE}/api/projects/${id}/test-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: standaloneForm.name || "Test Cam",
          rtsp_url: combinedUrl,
          zone_tag: standaloneForm.zoneTag,
        }),
      });
      const data = await response.json();
      setTestResult({
        type: data.status === "success" ? "success" : "error",
        text: data.message,
      });
    } catch (err) {
      setTestResult({ type: "error", text: "Stream preview connection handshake failed." });
    } finally {
      setActionLoading(null);
    }
  };

  // Tab B: Save Single Camera
  const handleSaveStandalone = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!standaloneForm.name || !standaloneForm.ipAddress) {
      setTestResult({
        type: "error",
        text: standaloneForm.streamType === "usb"
          ? "Camera name and Webcam Index are required."
          : "Camera name and IPv4 Address are required."
      });
      return;
    }
    const pathPrefix = standaloneForm.path.startsWith("/") ? "" : "/";
    const combinedUrl = standaloneForm.streamType === "usb"
      ? standaloneForm.ipAddress
      : `${standaloneForm.streamType}://${standaloneForm.ipAddress}:${standaloneForm.port}${pathPrefix}${standaloneForm.path}`;

    setActionLoading("save_cam");
    setTestResult(null);
    try {
      const response = await fetch(`${API_BASE}/api/projects/${id}/cameras`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: standaloneForm.name,
          rtsp_url: combinedUrl,
          zone_tag: standaloneForm.zoneTag,
          ai_active: standaloneForm.aiActive,
        }),
      });

      if (!response.ok) throw new Error("Failed to save camera.");
      const data = await response.json();
      setTestResult({ type: "success", text: `${data.message} Ingestion started.` });
      
      // Reset standalone form
      setStandaloneForm({
        name: "",
        ipAddress: "",
        port: 8080,
        streamType: "http",
        path: "/video",
        zoneTag: project?.project_type === "school" ? "Corridor" : project?.project_type === "home" ? "Main Door" : "Generic Zone",
        aiActive: true,
      });
    } catch (err: any) {
      setTestResult({ type: "error", text: err.message || "Could not save camera." });
    } finally {
      setActionLoading(null);
    }
  };

  // Add Member / Invite Access
  const handleInviteMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteEmail) return;

    setActionLoading("invite");
    try {
      const response = await fetch(`${API_BASE}/api/projects/${id}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: inviteEmail,
          role: inviteRole,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail || "Could not invite member.");
      }

      setMembers((prev) => [...prev, { id: Math.random().toString(), email: inviteEmail, role: inviteRole }]);
      setInviteEmail("");
    } catch (err: any) {
      alert(err.message);
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", gap: "10px" }}>
        <Loader2 className="pulse-live-icon" style={{ background: "none", boxShadow: "none" }} size={32} color="var(--primary)" />
        <span>Loading workspace Ingestion parameters...</span>
      </div>
    );
  }

  if (!project) return <div>Project not found.</div>;

  // Unlocked Zone Tags depending on project type (Page 3)
  const getZoneTags = () => {
    if (project.project_type === "school") return ["Classroom", "Playground", "Corridor"];
    if (project.project_type === "home") return ["Main Door", "Backyard", "Garage"];
    return ["Corridor", "Main Door", "Backyard", "Garage", "Office", "Parking"];
  };

  return (
    <div style={{ minHeight: "100vh", padding: "40px 24px", position: "relative" }}>
      {/* Top Navbar */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "40px" }}>
        <div style={{ display: "flex", gap: "12px" }}>
          <button onClick={() => navigate("/dashboard")} className="btn-secondary" style={{ padding: "8px 16px" }}>
            <ArrowLeft size={16} />
            Hub
          </button>
          <button onClick={() => navigate(`/project/${id}/view`)} className="btn-primary" style={{ padding: "8px 16px", fontSize: "0.85rem" }}>
            Live Console
          </button>
        </div>
        <div>
          <h1 style={{ fontSize: "1.4rem", fontWeight: 700 }}>{project.name}</h1>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.8rem", textAlign: "right" }}>
            Ingestion Hub / {project.project_type.toUpperCase()}
          </p>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "2.8fr 1.2fr", gap: "24px", alignItems: "start" }}>
        
        {/* Ingestion Panel */}
        <div className="glass-panel" style={{ padding: "32px" }}>
          
          {/* Tabs header */}
          <div style={{ display: "flex", borderBottom: "1px solid var(--border-glass)", marginBottom: "32px", gap: "20px" }}>
            <button
              onClick={() => { setActiveTab("nvr"); setTestResult(null); }}
              style={{
                background: "none",
                border: "none",
                borderBottom: activeTab === "nvr" ? "2px solid var(--primary)" : "2px solid transparent",
                color: activeTab === "nvr" ? "var(--text-primary)" : "var(--text-muted)",
                paddingBottom: "14px",
                fontWeight: 600,
                fontSize: "1rem",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: "8px"
              }}
            >
              <Cpu size={18} />
              NVR / DVR Configuration Array
            </button>
            <button
              onClick={() => { setActiveTab("standalone"); setTestResult(null); }}
              style={{
                background: "none",
                border: "none",
                borderBottom: activeTab === "standalone" ? "2px solid var(--primary)" : "2px solid transparent",
                color: activeTab === "standalone" ? "var(--text-primary)" : "var(--text-muted)",
                paddingBottom: "14px",
                fontWeight: 600,
                fontSize: "1rem",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: "8px"
              }}
            >
              <Video size={18} />
              Standalone Feed (RTSP)
            </button>
          </div>

          {/* Test Action Notifications */}
          {testResult && (
            <div className="glass-panel" style={{
              padding: "16px",
              marginBottom: "24px",
              border: `1px solid ${testResult.type === "success" ? "var(--success)" : "var(--danger)"}`,
              background: testResult.type === "success" ? "rgba(16, 185, 129, 0.08)" : "rgba(239, 68, 68, 0.08)",
              color: testResult.type === "success" ? "var(--success)" : "var(--danger)",
              display: "flex",
              alignItems: "flex-start",
              gap: "10px",
              fontSize: "0.85rem"
            }}>
              {testResult.type === "success" ? <Check size={18} /> : <AlertCircle size={18} />}
              <span>{testResult.text}</span>
            </div>
          )}

          {/* TAB A: NVR FORM */}
          {activeTab === "nvr" && (
            <form onSubmit={handleSaveNVR}>
              <div className="grid-2">
                <div className="form-group">
                  <label className="form-label">Device Label</label>
                  <input
                    type="text"
                    value={nvrForm.deviceLabel}
                    onChange={(e) => setNvrForm({ ...nvrForm, deviceLabel: e.target.value })}
                    placeholder="Main Facility NVR"
                    className="form-input"
                    required
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Brand / Protocol</label>
                  <select
                    value={nvrForm.brand}
                    onChange={(e) => setNvrForm({ ...nvrForm, brand: e.target.value })}
                    className="form-input"
                    style={{ background: "#0a051b" }}
                  >
                    {["Hikvision", "Dahua", "CP Plus", "IP Webcam (Android)", "Generic ONVIF"].map(b => (
                      <option key={b} value={b}>{b}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid-2">
                <div className="form-group">
                  <label className="form-label">Local / Public Target IP</label>
                  <input
                    type="text"
                    value={nvrForm.ipAddress}
                    onChange={(e) => setNvrForm({ ...nvrForm, ipAddress: e.target.value })}
                    placeholder="e.g. 192.168.1.100"
                    className="form-input"
                    required
                  />
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                  <div className="form-group">
                    <label className="form-label">RTSP Port</label>
                    <input
                      type="number"
                      value={nvrForm.rtspPort}
                      onChange={(e) => setNvrForm({ ...nvrForm, rtspPort: Number(e.target.value) })}
                      className="form-input"
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">HTTP Port</label>
                    <input
                      type="number"
                      value={nvrForm.httpPort}
                      onChange={(e) => setNvrForm({ ...nvrForm, httpPort: Number(e.target.value) })}
                      className="form-input"
                      required
                    />
                  </div>
                </div>
              </div>

              <div className="grid-2">
                <div className="form-group">
                  <label className="form-label">Username</label>
                  <input
                    type="text"
                    value={nvrForm.username}
                    onChange={(e) => setNvrForm({ ...nvrForm, username: e.target.value })}
                    placeholder="admin"
                    className="form-input"
                    required
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Password</label>
                  <input
                    type="password"
                    value={nvrForm.password}
                    onChange={(e) => setNvrForm({ ...nvrForm, password: e.target.value })}
                    placeholder="••••••••"
                    className="form-input"
                    required
                  />
                </div>
              </div>

              <div className="form-group" style={{ maxWidth: "50%" }}>
                <label className="form-label">Total Physical Channels</label>
                <input
                  type="number"
                  min={1}
                  max={64}
                  value={nvrForm.totalChannels}
                  onChange={(e) => setNvrForm({ ...nvrForm, totalChannels: Number(e.target.value) })}
                  className="form-input"
                  required
                />
              </div>

              <div style={{ display: "flex", gap: "16px", marginTop: "32px", borderTop: "1px solid var(--border-glass)", paddingTop: "24px" }}>
                <button
                  type="button"
                  onClick={handleTestNVR}
                  disabled={actionLoading !== null}
                  className="btn-secondary"
                  style={{ display: "flex", alignItems: "center", gap: "8px" }}
                >
                  {actionLoading === "test_nvr" ? <Loader2 className="pulse-live-icon" style={{ background: "none", boxShadow: "none" }} size={16} /> : <Settings size={16} />}
                  Test NVR Connection
                </button>
                <button
                  type="submit"
                  disabled={actionLoading !== null}
                  className="btn-primary"
                  style={{ display: "flex", alignItems: "center", gap: "8px" }}
                >
                  {actionLoading === "save_nvr" ? <Loader2 className="pulse-live-icon" style={{ background: "none", boxShadow: "none" }} size={16} /> : <Save size={16} />}
                  Save & Map Channels
                </button>
              </div>
            </form>
          )}

          {/* TAB B: STANDALONE INDIVIDUAL CAMERA FORM */}
          {activeTab === "standalone" && (
            <form onSubmit={handleSaveStandalone}>
              <div className="grid-2">
                <div className="form-group">
                  <label className="form-label">Camera Name / Label</label>
                  <input
                    type="text"
                    value={standaloneForm.name}
                    onChange={(e) => setStandaloneForm({ ...standaloneForm, name: e.target.value })}
                    placeholder="e.g. Playground Gate West"
                    className="form-input"
                    required
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Location / Zone Tag</label>
                  <select
                    value={standaloneForm.zoneTag}
                    onChange={(e) => setStandaloneForm({ ...standaloneForm, zoneTag: e.target.value })}
                    className="form-input"
                    style={{ background: "#0a051b" }}
                  >
                    {getZoneTags().map((tag) => (
                      <option key={tag} value={tag}>{tag}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid-2">
                <div className="form-group">
                  <label className="form-label">Protocol</label>
                  <select
                    value={standaloneForm.streamType}
                    onChange={(e) => setStandaloneForm({ ...standaloneForm, streamType: e.target.value })}
                    className="form-input"
                    style={{ background: "#0a051b" }}
                  >
                    <option value="http">HTTP (IP Webcam / MJPEG)</option>
                    <option value="rtsp">RTSP (IP Camera / H.264)</option>
                    <option value="usb">USB (Webcam)</option>
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">
                    {standaloneForm.streamType === "usb" ? "Webcam Index" : "IPv4 Address"}
                  </label>
                  <input
                    type="text"
                    value={standaloneForm.ipAddress}
                    onChange={(e) => setStandaloneForm({ ...standaloneForm, ipAddress: e.target.value })}
                    placeholder={standaloneForm.streamType === "usb" ? "e.g. 0 or 1" : "e.g. 192.168.1.50"}
                    className="form-input"
                    required
                  />
                </div>
              </div>

              {standaloneForm.streamType !== "usb" && (
                <div className="grid-2">
                  <div className="form-group">
                    <label className="form-label">Port</label>
                    <input
                      type="number"
                      value={standaloneForm.port}
                      onChange={(e) => setStandaloneForm({ ...standaloneForm, port: Number(e.target.value) })}
                      className="form-input"
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Stream Path</label>
                    <input
                      type="text"
                      value={standaloneForm.path}
                      onChange={(e) => setStandaloneForm({ ...standaloneForm, path: e.target.value })}
                      placeholder="e.g. /video or /h264_aac.sdp"
                      className="form-input"
                      required
                    />
                  </div>
                </div>
              )}

              <div className="form-group">
                <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={standaloneForm.aiActive}
                    onChange={(e) => setStandaloneForm({ ...standaloneForm, aiActive: e.target.checked })}
                    style={{ accentColor: "var(--primary)", width: "16px", height: "16px" }}
                  />
                  Activate Edge YOLOv8 AI Threat Analytics Loop
                </label>
              </div>

              <div style={{ display: "flex", gap: "16px", marginTop: "32px", borderTop: "1px solid var(--border-glass)", paddingTop: "24px" }}>
                <button
                  type="button"
                  onClick={handleTestStandalone}
                  disabled={actionLoading !== null}
                  className="btn-secondary"
                  style={{ display: "flex", alignItems: "center", gap: "8px" }}
                >
                  {actionLoading === "test_cam" ? <Loader2 className="pulse-live-icon" style={{ background: "none", boxShadow: "none" }} size={16} /> : <Play size={16} />}
                  Test Stream Preview
                </button>
                <button
                  type="submit"
                  disabled={actionLoading !== null}
                  className="btn-primary"
                  style={{ display: "flex", alignItems: "center", gap: "8px" }}
                >
                  {actionLoading === "save_cam" ? <Loader2 className="pulse-live-icon" style={{ background: "none", boxShadow: "none" }} size={16} /> : <Save size={16} />}
                  Save Camera
                </button>
              </div>
            </form>
          )}

        </div>

        {/* Access control Side module */}
        <div className="glass-panel" style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <Users size={20} color="var(--primary)" />
            <h2 style={{ fontSize: "1.1rem", fontWeight: 700 }}>Access Control</h2>
          </div>
          
          <p style={{ color: "var(--text-secondary)", fontSize: "0.8rem" }}>
            Grant collaborative viewing and response credentials for this project workspace.
          </p>

          <button 
            onClick={() => setShowAccessModal(true)} 
            className="btn-primary"
            style={{ width: "100%", justifyContent: "center", padding: "10px", fontSize: "0.85rem" }}
          >
            Project Access Management
            <ChevronRight size={16} />
          </button>

          <div style={{ borderTop: "1px solid var(--border-glass)", paddingTop: "20px" }}>
            <h4 style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "12px" }}>Active Responders ({members.length})</h4>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {members.map(m => (
                <div key={m.id} style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "10px 12px",
                  background: "rgba(255,255,255,0.02)",
                  border: "1px solid var(--border-glass)",
                  borderRadius: "var(--radius-sm)",
                  fontSize: "0.75rem"
                }}>
                  <span style={{ color: "var(--text-primary)", fontWeight: 500 }}>{m.email}</span>
                  <span style={{
                    color: m.role === "admin" ? "var(--secondary)" : m.role === "responder" ? "var(--warning)" : "var(--text-muted)",
                    fontWeight: 600,
                    textTransform: "uppercase",
                    fontSize: "0.65rem"
                  }}>{m.role}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

      </div>

      {/* Access Management Drawer / Slider Modal */}
      {showAccessModal && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          zIndex: 100,
          display: "flex",
          justifyContent: "flex-end",
          background: "rgba(10, 5, 27, 0.6)",
          backdropFilter: "blur(4px)"
        }} onClick={() => setShowAccessModal(false)}>
          <div 
            className="glass-panel" 
            style={{
              width: "450px",
              height: "100%",
              borderRadius: "0px",
              padding: "40px",
              display: "flex",
              flexDirection: "column",
              boxShadow: "-10px 0 30px rgba(0,0,0,0.5)",
              borderLeft: "1px solid var(--border-glass)"
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 style={{ fontSize: "1.4rem", fontWeight: 700, marginBottom: "8px" }}>Project Access Management</h2>
            <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", marginBottom: "28px" }}>
              Invite team members by email address to map responder and viewer permission tiers.
            </p>

            <form onSubmit={handleInviteMember} style={{ marginBottom: "32px" }}>
              <div className="form-group">
                <label className="form-label">Email Address</label>
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="collaborator@security.com"
                  className="form-input"
                  required
                />
              </div>

              <div className="form-group">
                <label className="form-label">Assign Role Tier</label>
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value)}
                  className="form-input"
                  style={{ background: "#0a051b" }}
                >
                  <option value="admin">Admin (All configurations)</option>
                  <option value="responder">Responder (Acknowledge & Resolve alerts)</option>
                  <option value="viewer">Viewer (Read-only livestream)</option>
                </select>
              </div>

              <button 
                type="submit" 
                className="btn-primary" 
                style={{ width: "100%", justifyContent: "center", padding: "12px", fontSize: "0.9rem" }}
                disabled={actionLoading === "invite"}
              >
                {actionLoading === "invite" ? "Inviting Member..." : "Send Invitation"}
              </button>
            </form>

            <div style={{ borderTop: "1px solid var(--border-glass)", paddingTop: "24px", flex: 1, overflowY: "auto" }}>
              <h4 style={{ fontSize: "0.9rem", fontWeight: 600, color: "var(--text-primary)", marginBottom: "16px" }}>
                Current Team Structure
              </h4>
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                {members.map(m => (
                  <div key={m.id} style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "12px",
                    background: "rgba(255,255,255,0.02)",
                    border: "1px solid var(--border-glass)",
                    borderRadius: "var(--radius-md)",
                    fontSize: "0.8rem"
                  }}>
                    <div>
                      <p style={{ color: "var(--text-primary)", fontWeight: 500 }}>{m.email}</p>
                      <p style={{ color: "var(--text-muted)", fontSize: "0.7rem", marginTop: "2px" }}>Joined today</p>
                    </div>
                    <span style={{
                      background: m.role === "admin" ? "rgba(6, 182, 212, 0.1)" : m.role === "responder" ? "rgba(245, 158, 11, 0.1)" : "rgba(255,255,255,0.05)",
                      border: `1px solid ${m.role === "admin" ? "var(--secondary)" : m.role === "responder" ? "var(--warning)" : "var(--border-glass)"}`,
                      color: m.role === "admin" ? "var(--secondary)" : m.role === "responder" ? "var(--warning)" : "var(--text-secondary)",
                      padding: "4px 8px",
                      borderRadius: "6px",
                      fontSize: "0.7rem",
                      fontWeight: 600,
                      textTransform: "uppercase"
                    }}>{m.role}</span>
                  </div>
                ))}
              </div>
            </div>

            <button 
              onClick={() => setShowAccessModal(false)}
              className="btn-secondary"
              style={{ width: "100%", justifyContent: "center", marginTop: "24px" }}
            >
              Close Panel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
