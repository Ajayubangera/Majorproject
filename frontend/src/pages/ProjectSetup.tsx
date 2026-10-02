import React, { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { 
  Cpu, Video, ArrowLeft, Check, AlertCircle, Play, Save, ChevronRight, Settings, Loader2,
  Trash2, RefreshCw, Radio, Mail, Users, Eye
} from "lucide-react";
import { getCurrentUser } from "../utils/auth";
import { API_BASE } from "../config/api";

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
  snapshots_captured?: number;
  created_at: string;
}

interface CameraItem {
  id: string;
  name: string;
  source_type: string;
  rtsp_url: string;
  zone_tag?: string;
  ai_active: boolean;
  allowed_members?: string | string[];
  snapshots_captured?: number;
  channel_number?: number;
  nvr_ip_address?: string;
  created_at?: string;
}

export default function ProjectSetup() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const currentUser = getCurrentUser();

  const [activeTab, setActiveTab] = useState<"nvr" | "standalone">("nvr");
  const [project, setProject] = useState<ProjectData | null>(null);
  const [members, setMembers] = useState<MemberItem[]>([]);
  const [cameras, setCameras] = useState<CameraItem[]>([]);
  const [cameraStatus, setCameraStatus] = useState<Record<string, boolean>>({});
  const [deletingCameraId, setDeletingCameraId] = useState<string | null>(null);
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

  // Granular Camera Selection & Member Access Control State
  const [selectedCameraIds, setSelectedCameraIds] = useState<string[]>([]);
  const [showCameraAccessModal, setShowCameraAccessModal] = useState(false);
  const [accessModalCameraIds, setAccessModalCameraIds] = useState<string[]>([]);
  const [selectedMemberEmailsForAccess, setSelectedMemberEmailsForAccess] = useState<string[]>([]);
  const [isSavingCameraAccess, setIsSavingCameraAccess] = useState(false);
  const [cameraAccessFeedback, setCameraAccessFeedback] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Helper to parse camera allowed_members
  const parseAllowedMembers = (raw?: string | string[]): string[] => {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  const handleToggleCameraSelect = (camId: string) => {
    setSelectedCameraIds(prev => 
      prev.includes(camId) ? prev.filter(c => c !== camId) : [...prev, camId]
    );
  };

  const handleToggleSelectAllCameras = () => {
    if (selectedCameraIds.length === cameras.length) {
      setSelectedCameraIds([]);
    } else {
      setSelectedCameraIds(cameras.map(c => c.id));
    }
  };

  const handleOpenAccessModal = (targetCams: CameraItem[]) => {
    const targetIds = targetCams.map(c => c.id);
    setAccessModalCameraIds(targetIds);
    setCameraAccessFeedback(null);

    const nonAdminMembers = members.filter(m => m.role?.toLowerCase() !== "admin");

    if (targetCams.length === 1) {
      const allowed = parseAllowedMembers(targetCams[0].allowed_members);
      if (allowed.length === 0 || allowed.includes("*") || allowed.includes("all")) {
        // By default, all viewers and responders have access
        setSelectedMemberEmailsForAccess(nonAdminMembers.map(m => m.email));
      } else if (allowed.includes("admin_only")) {
        // Strictly admin only — no viewers or responders
        setSelectedMemberEmailsForAccess([]);
      } else {
        // Specific subset of viewers / responders
        setSelectedMemberEmailsForAccess(
          allowed.filter(email => nonAdminMembers.some(m => m.email.toLowerCase() === email.toLowerCase()))
        );
      }
    } else {
      // Multiple cameras selected: start with all viewers & responders selected
      setSelectedMemberEmailsForAccess(nonAdminMembers.map(m => m.email));
    }

    setShowCameraAccessModal(true);
  };

  const handleToggleMemberPermission = (email: string) => {
    setSelectedMemberEmailsForAccess(prev => 
      prev.includes(email) ? prev.filter(e => e !== email) : [...prev, email]
    );
  };

  const handlePresetSelection = (preset: "all" | "responders" | "viewers" | "none") => {
    const nonAdminMembers = members.filter(m => m.role?.toLowerCase() !== "admin");
    if (preset === "all") {
      setSelectedMemberEmailsForAccess(nonAdminMembers.map(m => m.email));
    } else if (preset === "responders") {
      setSelectedMemberEmailsForAccess(nonAdminMembers.filter(m => m.role?.toLowerCase() === "responder").map(m => m.email));
    } else if (preset === "viewers") {
      setSelectedMemberEmailsForAccess(nonAdminMembers.filter(m => m.role?.toLowerCase() === "viewer").map(m => m.email));
    } else if (preset === "none") {
      setSelectedMemberEmailsForAccess([]);
    }
  };

  const handleCloseCameraAccessModal = () => {
    setShowCameraAccessModal(false);
    setCameraAccessFeedback(null);
    setSelectedCameraIds([]);
  };

  const handleSaveCameraAccess = async () => {
    if (accessModalCameraIds.length === 0) return;
    setIsSavingCameraAccess(true);
    setCameraAccessFeedback(null);

    const nonAdminMembers = members.filter(m => m.role?.toLowerCase() !== "admin");
    let payloadAllowed: string[] = [];

    if (selectedMemberEmailsForAccess.length === 0) {
      // No viewers or responders granted access => Admins only
      payloadAllowed = ["admin_only"];
    } else if (nonAdminMembers.length > 0 && selectedMemberEmailsForAccess.length === nonAdminMembers.length) {
      // All viewers & responders selected => Open to all members
      payloadAllowed = ["*"];
    } else {
      // Specific subset of viewers & responders
      payloadAllowed = selectedMemberEmailsForAccess;
    }

    try {
      const response = await fetch(`${API_BASE}/api/projects/${id}/cameras/access`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          camera_ids: accessModalCameraIds,
          allowed_members: payloadAllowed
        })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail || "Failed to update camera permissions");
      }

      // Update local cameras array with serialized allowed_members
      const allowedStr = JSON.stringify(payloadAllowed);
      setCameras(prev => prev.map(c => 
        accessModalCameraIds.includes(c.id) ? { ...c, allowed_members: allowedStr } : c
      ));
      loadCameras();

      const feedbackMessage = payloadAllowed.includes("admin_only")
        ? "Access saved: Restricted to Admins only."
        : payloadAllowed.includes("*")
        ? "Access saved: Visible to All Viewers & Responders."
        : `Access saved: Granted to ${selectedMemberEmailsForAccess.length} Viewer(s) & Responder(s).`;

      setCameraAccessFeedback({
        type: "success",
        text: feedbackMessage
      });

      // Clear camera selection so cameras return to unselected state immediately after work is done
      setSelectedCameraIds([]);

      setTimeout(() => {
        setShowCameraAccessModal(false);
        setCameraAccessFeedback(null);
        setSelectedMemberEmailsForAccess([]);
      }, 1200);

    } catch (err: any) {
      setCameraAccessFeedback({
        type: "error",
        text: err.message || "Failed to save camera permissions"
      });
    } finally {
      setIsSavingCameraAccess(false);
    }
  };

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
        setMembers(data.members || []);
        setCameras(data.cameras || []);
        
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

    // Check camera connectivity status
    const checkCameraStatus = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/projects/${id}/camera-status`);
        if (res.ok) {
          const map = await res.json();
          setCameraStatus(map);
        }
      } catch (e) {}
    };
    checkCameraStatus();
    const interval = setInterval(checkCameraStatus, 3000);
    return () => clearInterval(interval);
  }, [id, currentUser, navigate]);

  const loadCameras = async () => {
    try {
      const response = await fetch(`${API_BASE}/api/projects/${id}`);
      if (response.ok) {
        const data = await response.json();
        setCameras(data.cameras || []);
      }
    } catch (err) {
      console.error("Failed to refresh cameras", err);
    }
  };

  const handleDeleteCamera = async (cameraId: string) => {
    if (!confirm("Are you sure you want to remove this camera?")) return;
    setDeletingCameraId(cameraId);
    try {
      const response = await fetch(`${API_BASE}/api/cameras/${cameraId}`, {
        method: "DELETE"
      });
      if (response.ok) {
        setCameras(prev => prev.filter(c => c.id !== cameraId));
      }
    } catch (err) {
      console.error("Failed to delete camera", err);
    } finally {
      setDeletingCameraId(null);
    }
  };

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
      if (data.camera) {
        setCameras(prev => [...prev, data.camera]);
      } else {
        loadCameras();
      }
      
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

        {/* Currently Working Cameras Side Module */}
        <div className="glass-panel" style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "18px", height: "fit-content" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <Video size={20} color="var(--primary)" />
              <h2 style={{ fontSize: "1.1rem", fontWeight: 700, margin: 0 }}>Working Cameras</h2>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <button
                type="button"
                onClick={loadCameras}
                title="Refresh cameras"
                style={{
                  background: "rgba(255,255,255,0.05)",
                  border: "1px solid var(--border-glass)",
                  borderRadius: "4px",
                  color: "var(--text-secondary)",
                  padding: "4px 6px",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center"
                }}
              >
                <RefreshCw size={12} />
              </button>
              <span style={{
                fontSize: "0.72rem",
                fontWeight: 700,
                background: cameras.length > 0 ? "rgba(16, 185, 129, 0.15)" : "rgba(255,255,255,0.05)",
                color: cameras.length > 0 ? "var(--success)" : "var(--text-muted)",
                border: `1px solid ${cameras.length > 0 ? "rgba(16, 185, 129, 0.3)" : "var(--border-glass)"}`,
                padding: "2px 8px",
                borderRadius: "12px"
              }}>
                {cameras.length} Active
              </span>
            </div>
          </div>
          
          <p style={{ color: "var(--text-secondary)", fontSize: "0.8rem", margin: 0 }}>
            Live surveillance feeds currently active and monitored by Edge YOLOv8 analytics.
          </p>

          <button 
            onClick={() => navigate(`/project/${id}/view`)} 
            className="btn-primary"
            style={{ width: "100%", justifyContent: "center", padding: "10px 14px", fontSize: "0.85rem", gap: "8px" }}
          >
            <Play size={16} />
            Live Surveillance Console
            <ChevronRight size={16} />
          </button>

          <div style={{ borderTop: "1px solid var(--border-glass)", paddingTop: "16px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
              <h4 style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.5px", margin: 0 }}>
                Currently Working Feeds ({cameras.length})
              </h4>
              {cameras.length > 0 && (
                <button
                  type="button"
                  onClick={handleToggleSelectAllCameras}
                  style={{
                    background: "rgba(255, 255, 255, 0.05)",
                    border: "1px solid var(--border-glass)",
                    borderRadius: "4px",
                    color: selectedCameraIds.length === cameras.length ? "var(--primary)" : "var(--text-muted)",
                    fontSize: "0.72rem",
                    padding: "3px 8px",
                    cursor: "pointer",
                    fontWeight: 600,
                    transition: "var(--transition)"
                  }}
                >
                  {selectedCameraIds.length === cameras.length ? "Deselect All" : "Select All"}
                </button>
              )}
            </div>

            {/* Batch Camera Access Assignment Bar */}
            {selectedCameraIds.length > 0 && (
              <div style={{
                background: "linear-gradient(135deg, rgba(99, 102, 241, 0.16), rgba(6, 182, 212, 0.16))",
                border: "1px solid rgba(99, 102, 241, 0.4)",
                borderRadius: "6px",
                padding: "10px 12px",
                marginBottom: "14px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "8px",
                boxShadow: "0 4px 15px rgba(0,0,0,0.2)"
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <span style={{
                    background: "var(--primary)",
                    color: "#fff",
                    fontSize: "0.7rem",
                    fontWeight: 700,
                    padding: "2px 7px",
                    borderRadius: "10px"
                  }}>
                    {selectedCameraIds.length}
                  </span>
                  <span style={{ fontSize: "0.78rem", color: "#e2e8f0", fontWeight: 600 }}>
                    {selectedCameraIds.length === 1 ? "Camera selected" : "Cameras selected"}
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <button
                    type="button"
                    onClick={() => setSelectedCameraIds([])}
                    style={{
                      background: "rgba(255, 255, 255, 0.08)",
                      border: "1px solid var(--border-glass)",
                      color: "var(--text-secondary)",
                      borderRadius: "4px",
                      padding: "5px 10px",
                      fontSize: "0.72rem",
                      cursor: "pointer",
                      fontWeight: 500,
                      transition: "var(--transition)"
                    }}
                    title="Clear camera selection"
                  >
                    Deselect
                  </button>
                  <button
                    type="button"
                    onClick={() => handleOpenAccessModal(cameras.filter(c => selectedCameraIds.includes(c.id)))}
                    className="btn-primary"
                    style={{ padding: "6px 12px", fontSize: "0.75rem", gap: "6px" }}
                  >
                    <Users size={13} />
                    Assign Viewer / Responder Access
                  </button>
                </div>
              </div>
            )}

            {cameras.length === 0 ? (
              <div style={{
                padding: "24px 16px",
                background: "rgba(255,255,255,0.02)",
                border: "1px dashed var(--border-glass)",
                borderRadius: "var(--radius-sm)",
                textAlign: "center",
                color: "var(--text-muted)",
                fontSize: "0.8rem",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: "8px"
              }}>
                <Radio size={24} style={{ opacity: 0.35, color: "var(--primary)" }} />
                <span>No active cameras configured yet.</span>
                <span style={{ fontSize: "0.72rem", color: "var(--text-secondary)" }}>
                  Use the NVR or Standalone RTSP form on the left to add your first feed.
                </span>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "10px", maxHeight: "480px", overflowY: "auto", paddingRight: "2px" }}>
                {cameras.map((cam) => {
                  const isOnline = cameraStatus[cam.id] !== false;
                  const isSelected = selectedCameraIds.includes(cam.id);
                  const allowedList = parseAllowedMembers(cam.allowed_members);
                  const isAllMembers = allowedList.length === 0 || allowedList.includes("*") || allowedList.includes("all");
                  const isAdminOnly = allowedList.includes("admin_only");

                  return (
                    <div
                      key={cam.id}
                      style={{
                        padding: "12px 14px",
                        background: isSelected ? "rgba(99, 102, 241, 0.08)" : "rgba(255,255,255,0.025)",
                        border: isSelected ? "1px solid var(--primary)" : "1px solid var(--border-glass)",
                        boxShadow: isSelected ? "0 0 12px rgba(99, 102, 241, 0.2)" : "none",
                        borderRadius: "var(--radius-sm)",
                        display: "flex",
                        flexDirection: "column",
                        gap: "8px",
                        transition: "all 0.2s ease"
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                        <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "flex-start", gap: "10px" }}>
                          {/* Selection Checkbox */}
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => handleToggleCameraSelect(cam.id)}
                            style={{
                              accentColor: "var(--primary)",
                              cursor: "pointer",
                              width: "16px",
                              height: "16px",
                              marginTop: "2px",
                              flexShrink: 0
                            }}
                            title="Select camera to assign access permissions"
                          />

                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                              <span style={{
                                width: "8px",
                                height: "8px",
                                borderRadius: "50%",
                                background: isOnline ? "#10b981" : "#ef4444",
                                boxShadow: isOnline ? "0 0 8px rgba(16, 185, 129, 0.8)" : "none",
                                flexShrink: 0
                              }} />
                              <span style={{
                                color: "#fff",
                                fontWeight: 600,
                                fontSize: "0.85rem",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap"
                              }}>
                                {cam.name}
                              </span>
                              <span style={{
                                fontSize: "0.62rem",
                                fontWeight: 700,
                                color: isOnline ? "var(--success)" : "var(--danger)",
                                background: isOnline ? "rgba(16, 185, 129, 0.1)" : "rgba(239, 68, 68, 0.1)",
                                padding: "1px 5px",
                                borderRadius: "4px",
                                textTransform: "uppercase"
                              }}>
                                {isOnline ? "Online" : "Offline"}
                              </span>
                            </div>

                            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px", marginTop: "6px" }}>
                              {cam.zone_tag && (
                                <span style={{
                                  fontSize: "0.68rem",
                                  background: "rgba(99, 102, 241, 0.12)",
                                  color: "var(--secondary)",
                                  border: "1px solid rgba(99, 102, 241, 0.25)",
                                  padding: "1px 6px",
                                  borderRadius: "4px"
                                }}>
                                  📍 {cam.zone_tag}
                                </span>
                              )}
                              <span style={{
                                fontSize: "0.68rem",
                                background: cam.ai_active ? "rgba(16, 185, 129, 0.12)" : "rgba(255,255,255,0.04)",
                                color: cam.ai_active ? "var(--success)" : "var(--text-muted)",
                                border: `1px solid ${cam.ai_active ? "rgba(16, 185, 129, 0.25)" : "var(--border-glass)"}`,
                                padding: "1px 6px",
                                borderRadius: "4px"
                              }}>
                                {cam.ai_active ? "⚡ YOLOv8 AI Active" : "AI Inactive"}
                              </span>

                              {/* Camera Visibility Badge */}
                              <span style={{
                                fontSize: "0.68rem",
                                background: isAllMembers 
                                  ? "rgba(6, 182, 212, 0.12)" 
                                  : isAdminOnly 
                                  ? "rgba(239, 68, 68, 0.12)" 
                                  : "rgba(168, 85, 247, 0.14)",
                                color: isAllMembers 
                                  ? "var(--secondary)" 
                                  : isAdminOnly 
                                  ? "var(--danger)" 
                                  : "#c084fc",
                                border: `1px solid ${
                                  isAllMembers 
                                    ? "rgba(6, 182, 212, 0.3)" 
                                    : isAdminOnly 
                                    ? "rgba(239, 68, 68, 0.3)" 
                                    : "rgba(168, 85, 247, 0.35)"
                                }`,
                                padding: "1px 6px",
                                borderRadius: "4px",
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "4px"
                              }}>
                                <Eye size={10} />
                                {isAllMembers 
                                  ? "All Members (Open)" 
                                  : isAdminOnly 
                                  ? "Admins Only" 
                                  : `Restricted (${allowedList.length} permitted)`}
                              </span>

                              {/* Verified Snapshots Captured Badge */}
                              <span style={{
                                fontSize: "0.68rem",
                                background: "rgba(56, 189, 248, 0.12)",
                                color: "#38bdf8",
                                border: "1px solid rgba(56, 189, 248, 0.25)",
                                padding: "1px 6px",
                                borderRadius: "4px",
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "4px"
                              }}>
                                📷 {cam.snapshots_captured || 0} Captures
                              </span>
                            </div>
                          </div>
                        </div>

                        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                          {/* Manage Access Button */}
                          <button
                            type="button"
                            onClick={() => handleOpenAccessModal([cam])}
                            title="Configure Viewer and Responder permissions for this feed"
                            style={{
                              background: "rgba(99, 102, 241, 0.12)",
                              border: "1px solid rgba(99, 102, 241, 0.3)",
                              borderRadius: "4px",
                              color: "var(--secondary)",
                              padding: "4px 8px",
                              fontSize: "0.72rem",
                              fontWeight: 600,
                              cursor: "pointer",
                              display: "flex",
                              alignItems: "center",
                              gap: "4px"
                            }}
                          >
                            <Users size={12} />
                            Access
                          </button>

                          <button
                            onClick={() => handleDeleteCamera(cam.id)}
                            disabled={deletingCameraId === cam.id}
                            title="Remove Camera"
                            style={{
                              background: "rgba(239, 68, 68, 0.1)",
                              border: "1px solid rgba(239, 68, 68, 0.25)",
                              borderRadius: "4px",
                              color: "var(--danger)",
                              padding: "5px 7px",
                              cursor: deletingCameraId === cam.id ? "wait" : "pointer",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center"
                            }}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>

                      <div style={{
                        fontSize: "0.68rem",
                        color: "var(--text-muted)",
                        background: "rgba(0,0,0,0.3)",
                        padding: "5px 8px",
                        borderRadius: "4px",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontFamily: "monospace"
                      }}>
                        {cam.rtsp_url || "No stream URL specified"}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
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
            <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", marginBottom: "18px" }}>
              Invite team members by email address to map responder and viewer permission tiers.
            </p>

            {/* Email Alerts Banner */}
            <div style={{
              background: "rgba(99, 102, 241, 0.08)",
              border: "1px solid rgba(99, 102, 241, 0.25)",
              borderRadius: "var(--radius-sm)",
              padding: "12px 14px",
              marginBottom: "24px"
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
                <Mail size={15} color="var(--primary)" />
                <span style={{ fontSize: "0.82rem", fontWeight: 700, color: "#fff" }}>
                  Automated S3 Cloud Anomaly Alerts
                </span>
              </div>
              <p style={{ margin: 0, fontSize: "0.75rem", color: "var(--text-secondary)", lineHeight: 1.45 }}>
                When unusual activity is verified by AI and saved to cloud storage, instant email notifications with camera details, area, and full S3 snapshot links are automatically dispatched to members.
              </p>
            </div>

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
                      <div style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "3px" }}>
                        <span style={{
                          fontSize: "0.65rem",
                          background: "rgba(16, 185, 129, 0.15)",
                          color: "var(--success)",
                          padding: "1px 6px",
                          borderRadius: "10px",
                          border: "1px solid rgba(16, 185, 129, 0.3)"
                        }}>
                          📧 Receives Threat Alerts
                        </span>
                      </div>
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

      {/* ─── Camera Access & Visibility Modal ─────────────────────────────── */}
      {showCameraAccessModal && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          zIndex: 110,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "rgba(10, 5, 27, 0.75)",
          backdropFilter: "blur(6px)",
          padding: "20px"
        }} onClick={handleCloseCameraAccessModal}>
          <div 
            className="glass-panel" 
            style={{
              width: "500px",
              maxWidth: "100%",
              borderRadius: "12px",
              padding: "32px",
              display: "flex",
              flexDirection: "column",
              boxShadow: "0 20px 50px rgba(0,0,0,0.6)",
              border: "1px solid rgba(99, 102, 241, 0.35)",
              animation: "fadeIn 0.2s ease"
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
              <div style={{
                background: "linear-gradient(135deg, var(--primary), var(--secondary))",
                padding: "8px",
                borderRadius: "8px",
                display: "inline-flex"
              }}>
                <Users size={20} color="#fff" />
              </div>
              <h2 style={{ fontSize: "1.25rem", fontWeight: 700, margin: 0 }}>
                Camera View & Response Access
              </h2>
            </div>

            <p style={{ color: "var(--text-secondary)", fontSize: "0.82rem", marginBottom: "14px", lineHeight: 1.5 }}>
              Configure which <strong>Responders</strong> and <strong>Viewers</strong> are permitted to watch this live stream and receive automated threat alerts.
            </p>

            {/* Permanent Admin Access Info Banner */}
            <div style={{
              background: "rgba(6, 182, 212, 0.08)",
              border: "1px solid rgba(6, 182, 212, 0.25)",
              borderRadius: "8px",
              padding: "10px 14px",
              marginBottom: "16px",
              display: "flex",
              alignItems: "center",
              gap: "10px"
            }}>
              <span style={{ fontSize: "1.15rem" }}>🛡️</span>
              <div style={{ fontSize: "0.76rem", color: "#e2e8f0", lineHeight: 1.45 }}>
                <strong style={{ color: "var(--secondary)" }}>Facility Admins have permanent full access:</strong> Admins automatically view all camera feeds and receive all threat alerts. The toggles below are exclusively for <strong>Responders</strong> and <strong>Viewers</strong>.
              </div>
            </div>

            {/* Target Cameras Pills */}
            <div style={{
              background: "rgba(255, 255, 255, 0.03)",
              border: "1px solid var(--border-glass)",
              borderRadius: "6px",
              padding: "10px 12px",
              marginBottom: "16px"
            }}>
              <span style={{ fontSize: "0.72rem", color: "var(--text-muted)", textTransform: "uppercase", fontWeight: 700, display: "block", marginBottom: "6px" }}>
                Target Camera Feeds ({accessModalCameraIds.length}):
              </span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                {cameras.filter(c => accessModalCameraIds.includes(c.id)).map(c => (
                  <span key={c.id} style={{
                    fontSize: "0.74rem",
                    background: "rgba(99, 102, 241, 0.15)",
                    color: "#c7d2fe",
                    border: "1px solid rgba(99, 102, 241, 0.3)",
                    padding: "2px 8px",
                    borderRadius: "4px",
                    fontWeight: 600
                  }}>
                    📹 {c.name}
                  </span>
                ))}
              </div>
            </div>

            {/* Quick Presets */}
            <div style={{ marginBottom: "16px" }}>
              <span style={{ fontSize: "0.72rem", color: "var(--text-muted)", textTransform: "uppercase", fontWeight: 700, display: "block", marginBottom: "8px" }}>
                Quick Permissions Presets:
              </span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                <button
                  type="button"
                  onClick={() => handlePresetSelection("all")}
                  style={{
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid var(--border-glass)",
                    borderRadius: "4px",
                    color: "#e2e8f0",
                    fontSize: "0.74rem",
                    padding: "5px 9px",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: "5px"
                  }}
                >
                  🌐 All Responders & Viewers
                </button>
                <button
                  type="button"
                  onClick={() => handlePresetSelection("responders")}
                  style={{
                    background: "rgba(245, 158, 11, 0.1)",
                    border: "1px solid rgba(245, 158, 11, 0.3)",
                    borderRadius: "4px",
                    color: "var(--warning)",
                    fontSize: "0.74rem",
                    padding: "5px 9px",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: "5px"
                  }}
                >
                  🚨 Responders Only
                </button>
                <button
                  type="button"
                  onClick={() => handlePresetSelection("viewers")}
                  style={{
                    background: "rgba(168, 85, 247, 0.1)",
                    border: "1px solid rgba(168, 85, 247, 0.3)",
                    borderRadius: "4px",
                    color: "#c084fc",
                    fontSize: "0.74rem",
                    padding: "5px 9px",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: "5px"
                  }}
                >
                  👁️ Viewers Only
                </button>
                <button
                  type="button"
                  onClick={() => handlePresetSelection("none")}
                  style={{
                    background: "rgba(239, 68, 68, 0.1)",
                    border: "1px solid rgba(239, 68, 68, 0.3)",
                    borderRadius: "4px",
                    color: "var(--danger)",
                    fontSize: "0.74rem",
                    padding: "5px 9px",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: "5px"
                  }}
                >
                  🔒 Admins Only (Restricted)
                </button>
              </div>
            </div>

            {/* Member Checklist: Exclusively Viewers & Responders */}
            <div style={{
              border: "1px solid var(--border-glass)",
              borderRadius: "8px",
              padding: "10px",
              maxHeight: "220px",
              overflowY: "auto",
              marginBottom: "18px",
              background: "rgba(0, 0, 0, 0.25)"
            }}>
              {(() => {
                const nonAdminMembers = members.filter(m => m.role?.toLowerCase() !== "admin");

                if (nonAdminMembers.length === 0) {
                  return (
                    <div style={{ textAlign: "center", padding: "20px 14px", color: "var(--text-muted)", fontSize: "0.82rem" }}>
                      <span>No Viewers or Responders registered yet.</span>
                      <div style={{ fontSize: "0.74rem", color: "var(--text-secondary)", marginTop: "6px" }}>
                        Invite team members as <strong>Responder</strong> or <strong>Viewer</strong> in Project Access Management to configure permissions.
                      </div>
                    </div>
                  );
                }

                return nonAdminMembers.map((m) => {
                  const isChecked = selectedMemberEmailsForAccess.includes(m.email);
                  const isResponder = m.role?.toLowerCase() === "responder";

                  return (
                    <label
                      key={m.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "10px 12px",
                        borderRadius: "6px",
                        cursor: "pointer",
                        background: isChecked ? "rgba(99, 102, 241, 0.1)" : "transparent",
                        borderBottom: "1px solid rgba(255,255,255,0.04)",
                        transition: "background 0.15s ease"
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => handleToggleMemberPermission(m.email)}
                          style={{
                            accentColor: "var(--primary)",
                            cursor: "pointer",
                            width: "16px",
                            height: "16px"
                          }}
                        />
                        <div>
                          <div style={{ fontSize: "0.84rem", color: "#f8fafc", fontWeight: 600 }}>
                            {m.email}
                          </div>
                          <span style={{ fontSize: "0.7rem", color: isResponder ? "var(--warning)" : "#c084fc" }}>
                            {isResponder 
                              ? "⚡ Incident Responder (Receives AI Threat Alerts & Live Stream)" 
                              : "👁️ Feed Viewer (Read-only Live Stream)"}
                          </span>
                        </div>
                      </div>

                      <span style={{
                        background: isResponder ? "rgba(245, 158, 11, 0.15)" : "rgba(168, 85, 247, 0.15)",
                        border: `1px solid ${isResponder ? "rgba(245, 158, 11, 0.4)" : "rgba(168, 85, 247, 0.4)"}`,
                        color: isResponder ? "var(--warning)" : "#c084fc",
                        padding: "2px 8px",
                        borderRadius: "4px",
                        fontSize: "0.68rem",
                        fontWeight: 700,
                        textTransform: "uppercase"
                      }}>
                        {m.role}
                      </span>
                    </label>
                  );
                });
              })()}
            </div>

            {/* Feedback Alert */}
            {cameraAccessFeedback && (
              <div style={{
                background: cameraAccessFeedback.type === "success" ? "rgba(16, 185, 129, 0.15)" : "rgba(239, 68, 68, 0.15)",
                border: `1px solid ${cameraAccessFeedback.type === "success" ? "var(--success)" : "var(--danger)"}`,
                borderRadius: "var(--radius-sm)",
                padding: "10px 12px",
                marginBottom: "16px",
                fontSize: "0.8rem",
                color: cameraAccessFeedback.type === "success" ? "var(--success)" : "var(--danger)",
                display: "flex",
                alignItems: "center",
                gap: "8px"
              }}>
                {cameraAccessFeedback.type === "success" ? <Check size={16} /> : <AlertCircle size={16} />}
                <span>{cameraAccessFeedback.text}</span>
              </div>
            )}

            <div style={{ display: "flex", gap: "10px" }}>
              <button
                type="button"
                onClick={handleCloseCameraAccessModal}
                className="btn-secondary"
                style={{ flex: 1, justifyContent: "center", padding: "10px" }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveCameraAccess}
                disabled={isSavingCameraAccess}
                className="btn-primary"
                style={{ flex: 2, justifyContent: "center", padding: "10px", gap: "6px" }}
              >
                {isSavingCameraAccess ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    Saving Access...
                  </>
                ) : (
                  <>
                    <Save size={16} />
                    Apply Access Permissions
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
