import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { 
  Plus, Video, ShieldAlert, Folder, MapPin, LogOut, UserCheck, Bell, X, Clock, AlertTriangle,
  Maximize2, Minimize2, ZoomIn, ZoomOut, RefreshCw, Trash2, RotateCcw, Users, UserPlus, Check
} from "lucide-react";
import { getCurrentUser, clearSession } from "../utils/auth";
import { getViolenceLevel, getViolenceConfig, type ViolenceFilterType } from "../utils/threatUtils";

const parseUTCDate = (dateStr?: string) => {
  if (!dateStr) return null;
  let standardized = dateStr.trim();
  if (!standardized) return null;

  // If it already ends with Z or has an explicit timezone offset like +05:30, -04:00
  if (standardized.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(standardized)) {
    const d = new Date(standardized);
    return isNaN(d.getTime()) ? null : d;
  }

  // Naive date/time strings from database are stored in UTC; format with T and Z
  standardized = standardized.replace(" ", "T");
  if (!standardized.endsWith("Z")) {
    standardized = standardized + "Z";
  }
  const d = new Date(standardized);
  return isNaN(d.getTime()) ? null : d;
};

const formatTime12H = (isoOrTs?: string | Date | null) => {
  if (!isoOrTs) return "N/A";
  try {
    const d = isoOrTs instanceof Date ? isoOrTs : parseUTCDate(isoOrTs);
    if (d && !isNaN(d.getTime())) {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Kolkata",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
      }).format(d);
    }
  } catch (e) {}
  return typeof isoOrTs === "string" ? isoOrTs : "N/A";
};

const formatDate = (isoOrTs?: string | Date | null) => {
  if (!isoOrTs) return "N/A";
  try {
    const d = isoOrTs instanceof Date ? isoOrTs : parseUTCDate(isoOrTs);
    if (d && !isNaN(d.getTime())) {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(d); // Outputs YYYY-MM-DD in IST
    }
  } catch (e) {}
  return typeof isoOrTs === "string" ? isoOrTs : "N/A";
};

const formatDateTime = (isoOrTs?: string) => {
  if (!isoOrTs) return "";
  try {
    const d = parseUTCDate(isoOrTs);
    if (d && !isNaN(d.getTime())) {
      const datePart = formatDate(d);
      const timePart = formatTime12H(d);
      return `${datePart} ${timePart}`;
    }
  } catch (e) {}
  return isoOrTs;
};

const API_BASE = `http://${window.location.hostname}:8000`;

const getSnapshotUrl = (url?: string) => {
  if (!url) return "";
  const cleanUrl = url.trim();
  if (cleanUrl.startsWith("/static/")) {
    return `${API_BASE}${cleanUrl}`;
  }
  if (cleanUrl.startsWith("static/")) {
    return `${API_BASE}/${cleanUrl}`;
  }
  const match = cleanUrl.match(/\/static\/snapshots\/.+/);
  if (match) {
    return `${API_BASE}${match[0]}`;
  }
  const match2 = cleanUrl.match(/static\/snapshots\/.+/);
  if (match2) {
    return `${API_BASE}/${match2[0]}`;
  }
  if (cleanUrl.startsWith("http://") || cleanUrl.startsWith("https://")) {
    return cleanUrl.replace("localhost:8000", `${window.location.hostname}:8000`).replace("127.0.0.1:8000", `${window.location.hostname}:8000`);
  }
  return `${API_BASE}/${cleanUrl.replace(/^\//, "")}`;
};

interface ProjectItem {
  id: string;
  name: string;
  location: string;
  project_type: "school" | "home" | "government";
  owner_id: string;
  created_at: string;
  cameras_count: number;
  alerts_count: number;
}

export default function Dashboard() {
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [analytics, setAnalytics] = useState({
    activeProjects: 0,
    onlineCameras: 0,
    securityThreats: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // Alert logs modal state
  const [activeAlertsProjectId, setActiveAlertsProjectId] = useState<string | null>(null);
  const [projectAlerts, setProjectAlerts] = useState<any[]>([]);
  const [loadingAlerts, setLoadingAlerts] = useState(false);
  const [isModalMaximized, setIsModalMaximized] = useState(false);
  const [expandedSnapshot, setExpandedSnapshot] = useState<{ url: string; title: string } | null>(null);

  // Trash bin state
  const [activeTrashProjectId, setActiveTrashProjectId] = useState<string | null>(null);
  const [projectTrashedAlerts, setProjectTrashedAlerts] = useState<any[]>([]);
  const [loadingTrash, setLoadingTrash] = useState(false);
  const [filterLogsDate, setFilterLogsDate] = useState("");
  const [violenceFilter, setViolenceFilter] = useState<ViolenceFilterType>("all");
  const [filterTrashDate, setFilterTrashDate] = useState("");

  // Access Management Modal State
  const [activeAccessProject, setActiveAccessProject] = useState<ProjectItem | null>(null);
  const [projectMembers, setProjectMembers] = useState<any[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("responder");
  const [inviteLoading, setInviteLoading] = useState(false);
  const [accessFeedback, setAccessFeedback] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Selected single alert detail modal state
  const [selectedAlert, setSelectedAlert] = useState<any | null>(null);
  const [alertZoomScale, setAlertZoomScale] = useState(1);
  const [alertPanOffset, setAlertPanOffset] = useState({ x: 0, y: 0 });
  const [isAlertDragging, setIsAlertDragging] = useState(false);
  const [alertDragStart, setAlertDragStart] = useState({ x: 0, y: 0 });
  const [isImageMaximized, setIsImageMaximized] = useState(false);

  // Track inspected/seen alert IDs (saved to localStorage for persistence across navigations)
  const [inspectedAlertIds, setInspectedAlertIds] = useState<Record<string, boolean>>(() => {
    try {
      const saved = localStorage.getItem("inspected_alert_ids");
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  const handleMouseDownAlert = (e: React.MouseEvent) => {
    if (alertZoomScale <= 1) return;
    e.preventDefault();
    setIsAlertDragging(true);
    setAlertDragStart({ x: e.clientX - alertPanOffset.x, y: e.clientY - alertPanOffset.y });
  };

  const handleMouseMoveAlert = (e: React.MouseEvent) => {
    if (!isAlertDragging) return;
    e.preventDefault();
    setAlertPanOffset({
      x: e.clientX - alertDragStart.x,
      y: e.clientY - alertDragStart.y
    });
  };

  const handleMouseUpAlert = () => {
    setIsAlertDragging(false);
  };

  const handleMouseLeaveAlert = () => {
    setIsAlertDragging(false);
  };

  const handleAlertZoomIn = () => {
    setAlertZoomScale(prev => Math.min(prev + 0.25, 4));
  };

  const handleAlertZoomOut = () => {
    setAlertZoomScale(prev => {
      const next = Math.max(prev - 0.25, 1);
      if (next === 1) {
        setAlertPanOffset({ x: 0, y: 0 });
      }
      return next;
    });
  };

  const handleAlertZoomReset = () => {
    setAlertZoomScale(1);
    setAlertPanOffset({ x: 0, y: 0 });
  };

  const navigate = useNavigate();
  const currentUser = getCurrentUser();

  // Redirect to Auth if not logged in
  useEffect(() => {
    if (!currentUser) {
      navigate("/auth");
    }
  }, [currentUser, navigate]);

  useEffect(() => {
    if (!currentUser) return;

    const fetchDashboardData = async () => {
      try {
        const response = await fetch(`${API_BASE}/api/projects?email=${encodeURIComponent(currentUser.email)}`);
        if (!response.ok) {
          throw new Error("Failed to load workspace projects.");
        }
        const data: ProjectItem[] = await response.json();
        setProjects(data);
      } catch (err: any) {
        setError(err.message || "An error occurred fetching dashboard metrics.");
      } finally {
        setLoading(false);
      }
    };

    fetchDashboardData();
  }, [currentUser]);

  // Recalculate metrics automatically to keep top widgets in perfect sync with project cards
  useEffect(() => {
    const totalCameras = projects.reduce((acc, p) => acc + p.cameras_count, 0);
    const totalAlerts = projects.reduce((acc, p) => acc + p.alerts_count, 0);

    setAnalytics({
      activeProjects: projects.length,
      onlineCameras: totalCameras,
      securityThreats: totalAlerts,
    });
  }, [projects]);

  const handleLogout = () => {
    clearSession();
    navigate("/auth");
  };

  const handleOpenAlertsModal = async (projectId: string) => {
    setActiveAlertsProjectId(projectId);
    setLoadingAlerts(true);
    setProjectAlerts([]);
    try {
      // Mark as read in the backend database
      fetch(`${API_BASE}/api/projects/${projectId}/alerts/read`, { method: "PUT" })
        .catch(err => console.error("Error marking alerts as read:", err));
      
      // Update local workspace state to clear badge count
      setProjects(prev => prev.map(p => {
        if (p.id === projectId) {
          return { ...p, alerts_count: 0 };
        }
        return p;
      }));

      const response = await fetch(`${API_BASE}/api/projects/${projectId}/alerts`);
      if (!response.ok) throw new Error("Failed to fetch project alerts.");
      const data = await response.json();
      setProjectAlerts(data);
    } catch (err: any) {
      console.error(err);
      alert(err.message || "Could not load alerts.");
    } finally {
      setLoadingAlerts(false);
    }
  };

  const handleCloseAlertsModal = () => {
    setActiveAlertsProjectId(null);
    setIsModalMaximized(false);
    setFilterLogsDate("");
    setViolenceFilter("all");
  };

  const handleOpenAccessModal = async (project: ProjectItem) => {
    setActiveAccessProject(project);
    setInviteEmail("");
    setInviteRole("responder");
    setAccessFeedback(null);
    setLoadingMembers(true);
    try {
      const response = await fetch(`${API_BASE}/api/projects/${project.id}/members`);
      if (response.ok) {
        const data = await response.json();
        setProjectMembers(data);
      }
    } catch (err) {
      console.error("Failed to load project members:", err);
    } finally {
      setLoadingMembers(false);
    }
  };

  const handleCloseAccessModal = () => {
    setActiveAccessProject(null);
    setAccessFeedback(null);
  };

  const handleAddMemberSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeAccessProject || !inviteEmail.trim()) return;

    setInviteLoading(true);
    setAccessFeedback(null);
    try {
      const response = await fetch(`${API_BASE}/api/projects/${activeAccessProject.id}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: inviteEmail.trim(),
          role: inviteRole
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail || "Failed to add member access.");
      }
      setAccessFeedback({ type: "success", text: `Access granted to ${inviteEmail.trim()} (${inviteRole}).` });
      setInviteEmail("");
      if (data.member) {
        setProjectMembers(prev => [...prev.filter(m => m.email !== inviteEmail.trim()), data.member]);
      }
    } catch (err: any) {
      setAccessFeedback({ type: "error", text: err.message || "Failed to grant access." });
    } finally {
      setInviteLoading(false);
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    if (!activeAccessProject) return;
    try {
      const response = await fetch(`${API_BASE}/api/projects/${activeAccessProject.id}/members/${memberId}`, {
        method: "DELETE"
      });
      if (response.ok) {
        setProjectMembers(prev => prev.filter(m => m.id !== memberId));
      }
    } catch (err) {
      console.error("Failed to remove member:", err);
    }
  };

  const handleOpenTrashModal = async (projectId: string) => {
    setActiveTrashProjectId(projectId);
    setLoadingTrash(true);
    setProjectTrashedAlerts([]);
    try {
      const response = await fetch(`${API_BASE}/api/projects/${projectId}/alerts/trashed`);
      if (!response.ok) throw new Error("Failed to fetch trashed alerts.");
      const data = await response.json();
      setProjectTrashedAlerts(data);
    } catch (err: any) {
      console.error(err);
      alert(err.message || "Could not load trashed alerts.");
    } finally {
      setLoadingTrash(false);
    }
  };

  const handleCloseTrashModal = () => {
    setActiveTrashProjectId(null);
    setFilterTrashDate("");
  };

  const handleTrashAlert = async (alertId: string) => {
    // Backup state for potential rollback
    const backupAlerts = [...projectAlerts];
    const backupProjects = [...projects];

    // Optimistic Update: remove from notification list instantly
    setProjectAlerts(prev => prev.filter(a => a.id !== alertId));

    // Decrement the badge alerts count instantly
    setProjects(prev => prev.map(p => {
      if (p.id === activeAlertsProjectId) {
        return { ...p, alerts_count: Math.max(0, p.alerts_count - 1) };
      }
      return p;
    }));

    try {
      const response = await fetch(`${API_BASE}/api/alerts/${alertId}/trash`, {
        method: "PUT"
      });
      if (!response.ok) throw new Error("Failed to trash alert.");
    } catch (err: any) {
      // Revert state on failure
      setProjectAlerts(backupAlerts);
      setProjects(backupProjects);
      alert(err.message || "Failed to move alert to trash.");
    }
  };

  const handleRecoverAlert = async (alertId: string) => {
    const backupTrashed = [...projectTrashedAlerts];
    const backupAlerts = [...projectAlerts];

    // Find the alert to recover optimistically
    const recoveredAlert = projectTrashedAlerts.find(a => a.id === alertId);

    // Optimistic Update: remove from trash list instantly
    setProjectTrashedAlerts(prev => prev.filter(a => a.id !== alertId));

    // Optimistic Update: add back to notification list instantly (sorted by time)
    if (recoveredAlert) {
      setProjectAlerts(prev => {
        const updated = [...prev, recoveredAlert];
        return updated.sort((a, b) => (parseUTCDate(b.created_at)?.getTime() || 0) - (parseUTCDate(a.created_at)?.getTime() || 0));
      });
    }

    try {
      const response = await fetch(`${API_BASE}/api/alerts/${alertId}/recover`, {
        method: "PUT"
      });
      if (!response.ok) throw new Error("Failed to recover alert.");
    } catch (err: any) {
      // Revert state on failure
      setProjectTrashedAlerts(backupTrashed);
      setProjectAlerts(backupAlerts);
      alert(err.message || "Failed to recover alert.");
    }
  };

  const handleResolveAlert = async (alertId: string) => {
    // Optimistic Update: mark resolved in state
    setProjectAlerts((prev: any[]) => prev.map(a => a.id === alertId ? { ...a, is_resolved: true } : a));

    setSelectedAlert((prev: any) => {
      if (prev && prev.id === alertId) {
        return { ...prev, is_resolved: true };
      }
      return prev;
    });

    try {
      const response = await fetch(`${API_BASE}/api/alerts/${alertId}/resolve`, {
        method: "PUT"
      });
      if (!response.ok) throw new Error("Failed to resolve alert.");
    } catch (err: any) {
      // Revert state on failure
      setProjectAlerts((prev: any[]) => prev.map(a => a.id === alertId ? { ...a, is_resolved: false } : a));
      setSelectedAlert((prev: any) => {
        if (prev && prev.id === alertId) {
          return { ...prev, is_resolved: false };
        }
        return prev;
      });
      console.error("Failed to resolve alert:", err);
    }
  };

  const handleInspectAlert = (alertItem: any) => {
    setSelectedAlert(alertItem);
    setAlertZoomScale(1);
    setAlertPanOffset({ x: 0, y: 0 });
    setIsImageMaximized(false);

    // Save to inspectedAlertIds state and persist to localStorage
    setInspectedAlertIds(prev => {
      const updated = { ...prev, [alertItem.id]: true };
      try {
        localStorage.setItem("inspected_alert_ids", JSON.stringify(updated));
      } catch {}
      return updated;
    });

    // Mark as resolved in database & state
    if (!alertItem.is_resolved) {
      handleResolveAlert(alertItem.id);
    }
  };

  const handleDeleteAlertPermanently = async (alertId: string) => {
    if (!confirm("Are you sure you want to permanently delete this alert from the database? This cannot be undone.")) return;

    const backupTrashed = [...projectTrashedAlerts];

    // Optimistic Update: remove from trash list instantly
    setProjectTrashedAlerts(prev => prev.filter(a => a.id !== alertId));

    try {
      const response = await fetch(`${API_BASE}/api/alerts/${alertId}/delete`, {
        method: "DELETE"
      });
      if (!response.ok) throw new Error("Failed to permanently delete alert.");
    } catch (err: any) {
      // Revert state on failure
      setProjectTrashedAlerts(backupTrashed);
      alert(err.message || "Failed to delete alert.");
    }
  };

  if (!currentUser) return null;

  return (
    <div style={{ minHeight: "100vh", padding: "40px 24px" }}>
      {/* Top Navbar */}
      <header className="glass-panel" style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "20px 32px",
        marginBottom: "40px",
        borderBottom: "1px solid var(--border-glass)"
      }}>
        <div>
          <h1 style={{ fontSize: "1.8rem", fontWeight: 700, background: "linear-gradient(135deg, #fff, var(--text-secondary))", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
            Welcome back, {currentUser.name}
          </h1>
          <p style={{ color: "var(--text-muted)", fontSize: "0.85rem", marginTop: "4px" }}>
            Managing node streams for <span style={{ color: "var(--secondary)", fontWeight: 600 }}>{currentUser.org}</span>
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            background: "rgba(255,255,255,0.03)",
            border: "1px solid var(--border-glass)",
            padding: "8px 16px",
            borderRadius: "var(--radius-md)",
            fontSize: "0.85rem",
            color: "var(--text-secondary)"
          }}>
            <UserCheck size={16} color="var(--success)" />
            <span>Admin Gateway Active</span>
          </div>
          <button 
            onClick={handleLogout} 
            className="btn-secondary" 
            style={{ padding: "10px 18px", fontSize: "0.85rem", display: "flex", alignItems: "center", gap: "6px" }}
          >
            <LogOut size={16} />
            Logout
          </button>
        </div>
      </header>

      {/* Analytics Cards Grid */}
      <section style={{
        display: "grid",
        gridTemplateColumns: "repeat(3, 1fr)",
        gap: "24px",
        marginBottom: "48px"
      }}>
        <div className="glass-panel" style={{ padding: "28px", display: "flex", alignItems: "center", gap: "20px" }}>
          <div style={{
            background: "rgba(139, 92, 246, 0.15)",
            border: "1px solid var(--primary)",
            padding: "16px",
            borderRadius: "var(--radius-md)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center"
          }}>
            <Folder size={28} color="var(--primary)" />
          </div>
          <div>
            <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem", fontWeight: 500 }}>Active Projects</p>
            <h3 style={{ fontSize: "2.2rem", fontWeight: 800, marginTop: "4px" }}>{analytics.activeProjects}</h3>
          </div>
        </div>

        <div className="glass-panel" style={{ padding: "28px", display: "flex", alignItems: "center", gap: "20px" }}>
          <div style={{
            background: "rgba(6, 182, 212, 0.15)",
            border: "1px solid var(--secondary)",
            padding: "16px",
            borderRadius: "var(--radius-md)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center"
          }}>
            <Video size={28} color="var(--secondary)" />
          </div>
          <div>
            <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem", fontWeight: 500 }}>Online Camera Feeds</p>
            <h3 style={{ fontSize: "2.2rem", fontWeight: 800, marginTop: "4px" }}>{analytics.onlineCameras}</h3>
          </div>
        </div>

        <div className="glass-panel" style={{ 
          padding: "28px", 
          display: "flex", 
          alignItems: "center", 
          gap: "20px",
          border: analytics.securityThreats > 0 ? "1px solid var(--danger-glow)" : "1px solid var(--border-glass)"
        }}>
          <div style={{
            background: analytics.securityThreats > 0 ? "rgba(239, 68, 68, 0.15)" : "rgba(255,255,255,0.03)",
            border: `1px solid ${analytics.securityThreats > 0 ? "var(--danger)" : "var(--border-glass)"}`,
            padding: "16px",
            borderRadius: "var(--radius-md)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center"
          }}>
            <ShieldAlert size={28} color={analytics.securityThreats > 0 ? "var(--danger)" : "var(--text-secondary)"} />
          </div>
          <div>
            <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem", fontWeight: 500 }}>Verified Security Threats</p>
            <h3 style={{ 
              fontSize: "2.2rem", 
              fontWeight: 800, 
              marginTop: "4px",
              color: analytics.securityThreats > 0 ? "var(--danger)" : "var(--text-primary)"
            }}>{analytics.securityThreats}</h3>
          </div>
        </div>
      </section>

      {/* Main Workspace Section */}
      <section>
        <div style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "28px"
        }}>
          <div>
            <h2 style={{ fontSize: "1.4rem", fontWeight: 700 }}>Monitor Workspaces</h2>
            <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", marginTop: "2px" }}>Select a project workspace below to view real-time streams and operations</p>
          </div>
          <button 
            onClick={() => navigate("/projects/new")} 
            className="btn-primary"
            style={{ padding: "12px 20px" }}
          >
            <Plus size={18} />
            Create New Project
          </button>
        </div>

        {error && (
          <div className="glass-panel" style={{ padding: "20px", color: "var(--danger)", border: "1px solid var(--danger)", marginBottom: "24px" }}>
            {error}
          </div>
        )}

        {loading ? (
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: "24px"
          }}>
            {[1, 2, 3].map((i) => (
              <div key={i} className="glass-panel shimmer" style={{ height: "200px" }}></div>
            ))}
          </div>
        ) : projects.length === 0 ? (
          <div className="glass-panel" style={{
            padding: "80px 40px",
            textAlign: "center",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "16px"
          }}>
            <Folder size={48} color="var(--text-muted)" />
            <h3 style={{ fontSize: "1.2rem", fontWeight: 600 }}>No workspaces registered yet</h3>
            <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", maxWidth: "400px" }}>
              To start streaming cctv camera channels and running YOLO/Gemini intelligence models, initialize your first project.
            </p>
            <button 
              onClick={() => navigate("/projects/new")} 
              className="btn-primary" 
              style={{ marginTop: "8px" }}
            >
              <Plus size={16} />
              Create First Project
            </button>
          </div>
        ) : (
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: "24px"
          }}>
            {projects.map((project) => (
              <div 
                key={project.id} 
                className="glass-panel glass-card-interactive"
                style={{
                  padding: "24px",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  minHeight: "220px",
                  position: "relative",
                  overflow: "hidden"
                }}
              >
                {/* Project Tag Indicator */}
                <div style={{
                  position: "absolute",
                  top: "0",
                  right: "24px",
                  background: 
                    project.project_type === "school" ? "rgba(6, 182, 212, 0.15)" : 
                    project.project_type === "government" ? "rgba(139, 92, 246, 0.15)" : "rgba(239, 68, 68, 0.15)",
                  border: 
                    project.project_type === "school" ? "1px solid var(--secondary)" : 
                    project.project_type === "government" ? "1px solid var(--primary)" : "1px solid var(--accent)",
                  color: 
                    project.project_type === "school" ? "var(--secondary)" : 
                    project.project_type === "government" ? "var(--primary)" : "var(--accent)",
                  padding: "4px 10px",
                  fontSize: "0.7rem",
                  fontWeight: 600,
                  borderRadius: "0 0 8px 8px",
                  textTransform: "uppercase"
                }}>
                  {project.project_type}
                </div>

                <div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px", paddingRight: "80px", flexWrap: "wrap", gap: "8px" }}>
                    <h3 style={{ fontSize: "1.2rem", fontWeight: 700, margin: 0 }}>
                      {project.name}
                    </h3>
                    <button
                      onClick={() => handleOpenAccessModal(project)}
                      className="btn-secondary"
                      style={{
                        padding: "4px 10px",
                        fontSize: "0.72rem",
                        fontWeight: 600,
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "5px",
                        borderRadius: "6px",
                        background: "rgba(139, 92, 246, 0.12)",
                        border: "1px solid rgba(139, 92, 246, 0.35)",
                        color: "#c4b5fd",
                        cursor: "pointer",
                        transition: "all 0.2s ease"
                      }}
                      title="Access Management - Invite & manage team members"
                    >
                      <Users size={13} color="#a78bfa" />
                      <span>Access Management</span>
                    </button>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px", color: "var(--text-secondary)", fontSize: "0.8rem", marginBottom: "16px" }}>
                    <MapPin size={14} color="var(--text-muted)" />
                    <span>{project.location}</span>
                  </div>
                </div>

                <div style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "12px",
                  background: "rgba(255,255,255,0.02)",
                  padding: "12px",
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--border-glass)",
                  marginBottom: "20px"
                }}>
                  <div>
                    <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Camera Feeds</span>
                    <p style={{ fontSize: "1rem", fontWeight: 700, color: "var(--text-primary)" }}>{project.cameras_count} Active</p>
                  </div>
                  <div>
                    <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Threats (Today)</span>
                    <p style={{ fontSize: "1rem", fontWeight: 700, color: project.alerts_count > 0 ? "var(--danger)" : "var(--success)" }}>
                      {project.alerts_count} Logged
                    </p>
                  </div>
                </div>

                <div style={{ display: "flex", gap: "10px" }}>
                  <Link 
                    to={`/project/${project.id}/view`} 
                    className="btn-primary" 
                    style={{ flex: 1, padding: "10px", fontSize: "0.85rem", justifyContent: "center" }}
                  >
                    Live Console
                  </Link>
                  <Link 
                    to={`/project/${project.id}/setup`} 
                    className="btn-secondary" 
                    style={{ padding: "10px 14px", fontSize: "0.85rem", justifyContent: "center" }}
                  >
                    Setup
                  </Link>
                  <button
                    onClick={() => handleOpenAlertsModal(project.id)}
                    className="btn-secondary"
                    style={{
                      padding: "10px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      position: "relative"
                    }}
                    title="Alert Messages & Logs"
                  >
                    <Bell size={16} color={project.alerts_count > 0 ? "var(--warning)" : "var(--text-secondary)"} />
                    {project.alerts_count > 0 && (
                      <span style={{
                        position: "absolute",
                        top: "-4px",
                        right: "-4px",
                        background: "var(--danger)",
                        color: "#fff",
                        fontSize: "0.6rem",
                        fontWeight: 700,
                        borderRadius: "50%",
                        width: "14px",
                        height: "14px",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center"
                      }}>
                        {project.alerts_count}
                      </span>
                    )}
                  </button>
                  <button
                    onClick={() => handleOpenTrashModal(project.id)}
                    className="btn-secondary"
                    style={{
                      padding: "10px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center"
                    }}
                    title="Trash & Deleted Alerts"
                  >
                    <Trash2 size={16} color="var(--text-secondary)" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Alert logs modal */}
      {activeAlertsProjectId && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: "rgba(3, 1, 10, 0.8)",
          backdropFilter: "blur(8px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 100,
          padding: "20px"
        }} onClick={handleCloseAlertsModal}>
          <div style={{
            background: "#0c0721",
            border: "1px solid var(--border-glass)",
            borderRadius: "var(--radius-lg)",
            width: "100%",
            maxWidth: isModalMaximized ? "95vw" : "600px",
            height: isModalMaximized ? "90vh" : "auto",
            maxHeight: isModalMaximized ? "90vh" : "80vh",
            display: "flex",
            flexDirection: "column",
            boxShadow: "0 20px 50px rgba(0, 0, 0, 0.6)",
            animation: "fadeIn 0.2s ease-out",
            transition: "max-width 0.3s cubic-bezier(0.4, 0, 0.2, 1), height 0.3s cubic-bezier(0.4, 0, 0.2, 1), max-height 0.3s cubic-bezier(0.4, 0, 0.2, 1)"
          }} onClick={(e) => e.stopPropagation()}>
            
            {/* Header */}
            <div style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "16px 20px",
              borderBottom: "1px solid var(--border-glass)"
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <ShieldAlert size={20} color="var(--danger)" />
                <span style={{ fontWeight: 700, fontSize: "1.1rem" }}>Project Threat Logs</span>
              </div>
              <div style={{ display: "flex", alignItems: "center" }}>
                <button 
                  onClick={() => setIsModalMaximized(!isModalMaximized)}
                  style={{
                    background: "transparent",
                    border: "none",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: "4px",
                    marginRight: "10px"
                  }}
                  title={isModalMaximized ? "Restore Size" : "Maximize logs panel"}
                >
                  {isModalMaximized ? <Minimize2 size={18} color="var(--text-secondary)" /> : <Maximize2 size={18} color="var(--text-secondary)" />}
                </button>
                <button 
                  onClick={handleCloseAlertsModal}
                  style={{
                    background: "transparent",
                    border: "none",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: "4px"
                  }}
                  title="Close logs panel"
                >
                  <X size={20} color="var(--text-secondary)" />
                </button>
              </div>
            </div>

            {/* Date Search & Violence Level Filter Bar */}
            <div style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "12px",
              padding: "10px 20px",
              background: "rgba(255, 255, 255, 0.01)",
              borderBottom: "1px solid var(--border-glass)",
              flexWrap: "wrap"
            }}>
              {/* Date Filter Input */}
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)", fontWeight: 600 }}>Filter by Date:</span>
                <input
                  type="date"
                  value={filterLogsDate}
                  onChange={(e) => setFilterLogsDate(e.target.value)}
                  style={{
                    background: "rgba(255, 255, 255, 0.03)",
                    border: "1px solid var(--border-glass)",
                    borderRadius: "4px",
                    padding: "4px 8px",
                    color: "#fff",
                    fontSize: "0.8rem",
                    outline: "none",
                    colorScheme: "dark"
                  }}
                />
                {filterLogsDate && (
                  <button
                    onClick={() => setFilterLogsDate("")}
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

              {/* Violence Filter Buttons & Move All to Trash */}
              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                {(() => {
                  // Compute dynamic counts based on the current date filter
                  const dateFilteredAlerts = projectAlerts.filter(alertItem => {
                    if (!filterLogsDate) return true;
                    const d = parseUTCDate(alertItem.created_at || alertItem.timestamp);
                    if (!d) return true;
                    const year = d.getFullYear();
                    const month = String(d.getMonth() + 1).padStart(2, '0');
                    const day = String(d.getDate()).padStart(2, '0');
                    return `${year}-${month}-${day}` === filterLogsDate;
                  });

                  const counts = {
                    all: dateFilteredAlerts.length,
                    high: dateFilteredAlerts.filter(a => getViolenceLevel(a) === "high").length,
                    medium: dateFilteredAlerts.filter(a => getViolenceLevel(a) === "medium").length,
                    low: dateFilteredAlerts.filter(a => getViolenceLevel(a) === "low").length
                  };

                  const filterButtons: {
                    id: ViolenceFilterType;
                    label: string;
                    dot?: string;
                    color: string;
                    activeBg: string;
                    activeBorder: string;
                    activeGlow: string;
                  }[] = [
                    {
                      id: "all",
                      label: "All",
                      color: "var(--text-primary)",
                      activeBg: "rgba(255, 255, 255, 0.12)",
                      activeBorder: "rgba(255, 255, 255, 0.3)",
                      activeGlow: "rgba(255, 255, 255, 0.2)"
                    },
                    {
                      id: "high",
                      label: "High",
                      dot: "#ef4444",
                      color: "#ef4444",
                      activeBg: "rgba(239, 68, 68, 0.2)",
                      activeBorder: "#ef4444",
                      activeGlow: "rgba(239, 68, 68, 0.45)"
                    },
                    {
                      id: "medium",
                      label: "Medium",
                      dot: "#f97316",
                      color: "#f97316",
                      activeBg: "rgba(249, 115, 22, 0.2)",
                      activeBorder: "#f97316",
                      activeGlow: "rgba(249, 115, 22, 0.45)"
                    },
                    {
                      id: "low",
                      label: "Normal",
                      dot: "#10b981",
                      color: "#10b981",
                      activeBg: "rgba(16, 185, 129, 0.2)",
                      activeBorder: "#10b981",
                      activeGlow: "rgba(16, 185, 129, 0.45)"
                    }
                  ];

                  return (
                    <div style={{
                      display: "inline-flex",
                      alignItems: "center",
                      background: "rgba(0, 0, 0, 0.35)",
                      border: "1px solid var(--border-glass)",
                      borderRadius: "6px",
                      padding: "2px",
                      gap: "3px"
                    }}>
                      {filterButtons.map(btn => {
                        const isActive = violenceFilter === btn.id;
                        return (
                          <button
                            key={btn.id}
                            onClick={() => setViolenceFilter(prev => prev === btn.id ? "all" : btn.id)}
                            title={`Filter by ${btn.label} violence level (${counts[btn.id]})`}
                            style={{
                              background: isActive ? btn.activeBg : "transparent",
                              border: isActive ? `1px solid ${btn.activeBorder}` : "1px solid transparent",
                              boxShadow: isActive ? `0 0 8px ${btn.activeGlow}` : "none",
                              color: isActive ? btn.color : "var(--text-secondary)",
                              borderRadius: "4px",
                              padding: "4px 8px",
                              fontSize: "0.72rem",
                              fontWeight: isActive ? 700 : 500,
                              cursor: "pointer",
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "5px",
                              transition: "all 0.15s ease"
                            }}
                          >
                            {btn.dot && (
                              <span style={{
                                width: "6px",
                                height: "6px",
                                borderRadius: "50%",
                                background: btn.dot,
                                boxShadow: isActive ? `0 0 6px ${btn.dot}` : "none"
                              }} />
                            )}
                            <span>{btn.label}</span>
                            <span style={{
                              fontSize: "0.65rem",
                              padding: "1px 5px",
                              borderRadius: "10px",
                              background: isActive ? "rgba(0, 0, 0, 0.4)" : "rgba(255, 255, 255, 0.08)",
                              color: isActive ? btn.color : "var(--text-muted)",
                              fontWeight: 700
                            }}>
                              {counts[btn.id]}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  );
                })()}

                {projectAlerts.length > 0 && (
                  <button
                    onClick={async () => {
                      if (!window.confirm("Are you sure you want to move all notifications to trash?")) return;
                      try {
                        await fetch(`${API_BASE}/api/projects/${activeAlertsProjectId}/alerts/trash-all`, {
                          method: "PUT"
                        });
                        setProjectAlerts([]);
                        // Reset the alert badge count on the project card
                        setProjects(prev => prev.map(p =>
                          p.id === activeAlertsProjectId ? { ...p, alerts_count: 0 } : p
                        ));
                      } catch (err) {
                        console.error("Failed to trash all alerts:", err);
                      }
                    }}
                    style={{
                      background: "rgba(239, 68, 68, 0.1)",
                      color: "var(--danger)",
                      border: "1px solid rgba(239, 68, 68, 0.25)",
                      borderRadius: "6px",
                      padding: "5px 12px",
                      fontSize: "0.75rem",
                      cursor: "pointer",
                      fontWeight: 700,
                      display: "flex",
                      alignItems: "center",
                      gap: "5px",
                      whiteSpace: "nowrap"
                    }}
                    title="Move all alerts to trash"
                  >
                    <Trash2 size={12} />
                    Move All to Trash
                  </button>
                )}
              </div>
            </div>

            {/* List */}
            <div style={{
              overflowY: "auto",
              padding: isModalMaximized ? "20px" : "12px 16px",
              display: isModalMaximized ? "grid" : "flex",
              gridTemplateColumns: isModalMaximized ? "repeat(auto-fill, minmax(300px, 1fr))" : undefined,
              gridAutoRows: isModalMaximized ? "210px" : undefined,
              flexDirection: isModalMaximized ? undefined : "column",
              gap: isModalMaximized ? "16px" : "10px",
              flex: 1,
              alignContent: "start",
              minHeight: 0
            }}>
              {loadingAlerts ? (
                <div style={{ display: "flex", justifyContent: "center", padding: "40px" }}>
                  <span style={{ color: "var(--text-secondary)", fontSize: "0.9rem" }}>Loading system logs...</span>
                </div>
              ) : (() => {
                const filtered = projectAlerts.filter(alertItem => {
                  // 1. Date filter
                  if (filterLogsDate) {
                    const d = parseUTCDate(alertItem.created_at || alertItem.timestamp);
                    if (d) {
                      const formattedAlertDate = formatDate(d);
                      if (formattedAlertDate !== filterLogsDate) return false;
                    }
                  }
                  // 2. Violence Level filter
                  if (violenceFilter !== "all") {
                    const level = getViolenceLevel(alertItem);
                    if (level !== violenceFilter) return false;
                  }
                  return true;
                });

                // Sort by parsed timestamp descending to ensure the latest are always on top
                filtered.sort((a, b) => {
                  const getMs = (dateStr?: string) => {
                    const d = parseUTCDate(dateStr);
                    return d ? d.getTime() : 0;
                  };
                  return getMs(b.created_at || b.timestamp) - getMs(a.created_at || a.timestamp);
                });

                if (filtered.length === 0) {
                  return (
                    <div style={{ textAlign: "center", padding: "40px", color: "var(--text-muted)", gridColumn: "1 / -1" }}>
                      <AlertTriangle size={32} style={{ margin: "0 auto 12px auto", opacity: 0.5 }} />
                      <p style={{ fontSize: "0.9rem" }}>
                        {filterLogsDate || violenceFilter !== "all"
                          ? `No ${violenceFilter !== "all" ? violenceFilter + "-violence " : ""}alerts match the selected filters${filterLogsDate ? ` on ${filterLogsDate}` : ""}.`
                          : "No threat alert messages logged for this project yet."}
                      </p>
                    </div>
                  );
                }

                return filtered.map((alertItem) => {
                  const vConfig = getViolenceConfig(getViolenceLevel(alertItem));
                  return (
                  <div
                    key={alertItem.id}
                    onClick={() => {
                      setSelectedAlert(alertItem);
                      setAlertZoomScale(1);
                      setAlertPanOffset({ x: 0, y: 0 });
                      setIsImageMaximized(false);
                      if (!alertItem.is_resolved) {
                        handleResolveAlert(alertItem.id);
                      }
                    }}
                    style={{
                      background: vConfig.bg,
                      border: `1px solid ${vConfig.border}`,
                      borderLeft: `4px solid ${vConfig.color}`,
                      borderRadius: "var(--radius-md)",
                      display: "flex",
                      flexDirection: "column",
                      cursor: "pointer",
                      transition: "background 0.15s ease, box-shadow 0.15s ease",
                      overflow: "hidden",
                      minHeight: isModalMaximized ? undefined : "120px",
                      flexShrink: 0
                    }}
                    title="Click to view full details"
                  >
                    {/* Content */}
                    <div style={{
                      padding: "16px",
                      display: "flex",
                      flexDirection: "column",
                      gap: "8px",
                      overflow: "hidden"
                    }}>
                      {/* Header row */}
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                          <span style={{
                            color: vConfig.color,
                            fontSize: "0.65rem",
                            fontWeight: 700,
                            background: vConfig.badgeBg,
                            padding: "3px 8px",
                            borderRadius: "4px",
                            textTransform: "uppercase",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "5px"
                          }}>
                            <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: vConfig.dotColor, boxShadow: `0 0 6px ${vConfig.glow}` }}></span>
                            {vConfig.label}
                          </span>
                          {alertItem.is_resolved && (
                            <span style={{
                              color: "var(--success)",
                              fontSize: "0.62rem",
                              fontWeight: 600,
                              background: "rgba(16, 185, 129, 0.12)",
                              padding: "2px 6px",
                              borderRadius: "4px"
                            }}>
                              Resolved
                            </span>
                          )}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: "4px", color: "var(--text-muted)", fontSize: "0.7rem" }}>
                          <Clock size={11} />
                          <span>{formatDateTime(alertItem.created_at || alertItem.timestamp)}</span>
                        </div>
                      </div>

                      {/* Camera name */}
                      <h4 style={{ fontSize: "0.85rem", fontWeight: 700, color: "#fff", margin: 0 }}>
                        {alertItem.camera_name} {alertItem.zone_tag && <span style={{ color: "var(--text-secondary)", fontWeight: 400 }}>— {alertItem.zone_tag}</span>}
                      </h4>

                      {/* Description — always truncated in card, full detail on click */}
                      <p style={{ fontSize: "0.78rem", color: "var(--text-secondary)", lineHeight: "1.45", margin: 0 }}>
                        {alertItem.threat_description.replace(" [Not Gemini Verified]", "").length > 100
                          ? `${alertItem.threat_description.replace(" [Not Gemini Verified]", "").slice(0, 100)}...`
                          : alertItem.threat_description.replace(" [Not Gemini Verified]", "")
                        }
                      </p>

                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "4px" }}>
                        <span style={{ fontSize: "0.68rem", color: "var(--text-muted)" }}>
                          {alertItem.threat_description.includes("[Not Gemini Verified]") ? "Model Confidence:" : "Gemini Confidence:"} <strong style={{ color: "var(--primary)" }}>{(alertItem.confidence_score * 100).toFixed(0)}%</strong>
                        </span>
                        {alertItem.threat_description.includes("[Not Gemini Verified]") && (
                          <span style={{ color: "var(--danger)", fontSize: "0.68rem", fontWeight: 700 }}>
                            ⚠️ Not Gemini Verified
                          </span>
                        )}
                      </div>
                      {(alertItem.snapshot_url || alertItem.camera_id) && (
                        <div 
                          onClick={(e) => {
                            e.stopPropagation();
                            handleInspectAlert(alertItem);
                          }}
                          style={{ 
                            marginTop: "8px", 
                            borderRadius: "var(--radius-sm)", 
                            overflow: "hidden", 
                            border: "1px solid var(--border-glass)", 
                            cursor: "zoom-in",
                            background: "rgba(0,0,0,0.5)",
                            minHeight: "120px",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            position: "relative"
                          }}
                          title="Click to view & inspect threat snapshot"
                        >
                          <img 
                            src={alertItem.snapshot_url ? getSnapshotUrl(alertItem.snapshot_url) : `${API_BASE}/api/cameras/${alertItem.camera_id}/snapshot`} 
                            alt="Security Snapshot" 
                            style={{ width: "100%", height: "120px", objectFit: "cover", display: "block" }} 
                            onError={(e) => {
                              if (alertItem.camera_id) {
                                const fallback = `${API_BASE}/api/cameras/${alertItem.camera_id}/snapshot`;
                                if ((e.target as HTMLImageElement).src !== fallback) {
                                  (e.target as HTMLImageElement).src = fallback;
                                }
                              }
                            }}
                          />
                        </div>
                      )}
                    </div>

                    {/* Action buttons — always pinned to bottom, no red border */}
                    <div
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "10px 16px",
                        borderTop: "1px solid var(--border-glass)",
                        background: "rgba(255,255,255,0.015)",
                        flexShrink: 0
                      }}
                    >
                      <button
                        onClick={(e) => { e.stopPropagation(); handleTrashAlert(alertItem.id); }}
                        style={{
                          background: "rgba(239, 68, 68, 0.1)",
                          border: "1px solid rgba(239, 68, 68, 0.2)",
                          borderRadius: "4px",
                          padding: "5px 10px",
                          color: "var(--danger)",
                          cursor: "pointer",
                          fontSize: "0.7rem",
                          display: "flex",
                          alignItems: "center",
                          gap: "4px"
                        }}
                        title="Move to Trash"
                      >
                        <Trash2 size={12} /> Cancel
                      </button>
                      {(() => {
                        const isViewed = Boolean(alertItem.is_resolved || inspectedAlertIds[alertItem.id]);
                        return (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleInspectAlert(alertItem);
                            }}
                            style={{
                              color: isViewed ? "#10b981" : "#ffffff",
                              fontWeight: 700,
                              fontSize: "0.74rem",
                              padding: "5px 14px",
                              background: isViewed ? "rgba(16, 185, 129, 0.15)" : "#ef4444",
                              border: `1px solid ${isViewed ? "rgba(16, 185, 129, 0.4)" : "#dc2626"}`,
                              boxShadow: isViewed ? "0 0 8px rgba(16, 185, 129, 0.2)" : "0 0 10px rgba(239, 68, 68, 0.4)",
                              borderRadius: "4px",
                              cursor: "pointer",
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "6px",
                              transition: "all 0.2s ease"
                            }}
                            title={isViewed ? "Seen / Inspected Notification" : "Unseen Notification - Click to Inspect"}
                          >
                            <span style={{
                              width: "6px",
                              height: "6px",
                              borderRadius: "50%",
                              background: isViewed ? "#10b981" : "#ffffff",
                              boxShadow: `0 0 6px ${isViewed ? "#10b981" : "#ffffff"}`
                            }}></span>
                            {isViewed ? "Inspect ✓" : "Inspect →"}
                          </button>
                        );
                      })()}
                    </div>
                  </div>
                  );
                });
              })()}
            </div>

            {/* Footer */}
            <div style={{
              padding: "12px 20px",
              borderTop: "1px solid var(--border-glass)",
              display: "flex",
              justifyContent: "flex-end",
              background: "rgba(255,255,255,0.01)"
            }}>
              <button 
                onClick={handleCloseAlertsModal}
                className="btn-secondary"
                style={{ fontSize: "0.8rem", padding: "8px 16px" }}
              >
                Close Logs
              </button>
            </div>

          </div>
        </div>
      )}

      {/* Workspace Trash Modal */}
      {activeTrashProjectId && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: "rgba(3, 1, 10, 0.75)",
          backdropFilter: "blur(10px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 100,
          padding: "24px"
        }}>
          <div className="glass-panel" style={{
            width: "100%",
            maxWidth: "600px",
            maxHeight: "85vh",
            display: "flex",
            flexDirection: "column",
            border: "1px solid rgba(239, 68, 68, 0.2)",
            boxShadow: "0 20px 50px rgba(0,0,0,0.5)"
          }}>
            {/* Header */}
            <div style={{
              padding: "20px 24px",
              borderBottom: "1px solid var(--border-glass)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center"
            }}>
              <div>
                <h3 style={{ fontSize: "1.2rem", fontWeight: 700, display: "flex", alignItems: "center", gap: "8px", color: "var(--danger)" }}>
                  <Trash2 size={20} />
                  Workspace Trash Bin
                </h3>
                <p style={{ color: "var(--text-secondary)", fontSize: "0.75rem", marginTop: "2px" }}>
                  Recover logs or permanently purge them from database
                </p>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                {projectTrashedAlerts.length > 0 && (
                  <button
                    onClick={async () => {
                      if (!window.confirm("Are you sure you want to permanently delete ALL alerts in the trash? This action cannot be undone.")) return;
                      try {
                        const response = await fetch(`${API_BASE}/api/projects/${activeTrashProjectId}/alerts/delete-all-trash`, {
                          method: "DELETE"
                        });
                        if (!response.ok) throw new Error("Failed to empty trash.");
                        setProjectTrashedAlerts([]);
                      } catch (err: any) {
                        alert(err.message || "Failed to empty trash.");
                      }
                    }}
                    style={{
                      background: "rgba(239, 68, 68, 0.15)",
                      color: "var(--danger)",
                      border: "1px solid rgba(239, 68, 68, 0.3)",
                      borderRadius: "6px",
                      padding: "6px 12px",
                      fontSize: "0.75rem",
                      cursor: "pointer",
                      fontWeight: 600,
                      display: "flex",
                      alignItems: "center",
                      gap: "4px"
                    }}
                  >
                    <Trash2 size={12} />
                    Delete All
                  </button>
                )}
                <button 
                  onClick={handleCloseTrashModal}
                  style={{
                    background: "transparent",
                    border: "none",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: "4px"
                  }}
                >
                  <X size={20} color="var(--text-secondary)" />
                </button>
              </div>
            </div>

            {/* Date Search/Filter Bar */}
            <div style={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              padding: "10px 24px",
              background: "rgba(255, 255, 255, 0.01)",
              borderBottom: "1px solid var(--border-glass)"
            }}>
              <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)", fontWeight: 600 }}>Filter by Date:</span>
              <input
                type="date"
                value={filterTrashDate}
                onChange={(e) => setFilterTrashDate(e.target.value)}
                style={{
                  background: "rgba(255, 255, 255, 0.03)",
                  border: "1px solid var(--border-glass)",
                  borderRadius: "4px",
                  padding: "4px 8px",
                  color: "#fff",
                  fontSize: "0.8rem",
                  outline: "none",
                  colorScheme: "dark"
                }}
              />
              {filterTrashDate && (
                <button
                  onClick={() => setFilterTrashDate("")}
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

            {/* List */}
            <div style={{
              overflowY: "auto",
              padding: "20px",
              display: "flex",
              flexDirection: "column",
              gap: "16px",
              flex: 1
            }}>
              {loadingTrash ? (
                <div style={{ display: "flex", justifyContent: "center", padding: "40px" }}>
                  <span style={{ color: "var(--text-secondary)", fontSize: "0.9rem" }}>Loading trash...</span>
                </div>
              ) : (() => {
                const filtered = projectTrashedAlerts.filter(alertItem => {
                  if (!filterTrashDate) return true;
                  const d = parseUTCDate(alertItem.created_at || alertItem.timestamp);
                  if (!d) return true;
                  return formatDate(d) === filterTrashDate;
                });

                // Sort by parsed timestamp descending to ensure the latest are always on top
                filtered.sort((a, b) => {
                  const getMs = (dateStr?: string) => {
                    const d = parseUTCDate(dateStr);
                    return d ? d.getTime() : 0;
                  };
                  return getMs(b.created_at || b.timestamp) - getMs(a.created_at || a.timestamp);
                });

                if (filtered.length === 0) {
                  return (
                    <div style={{ textAlign: "center", padding: "40px", color: "var(--text-muted)" }}>
                      <Trash2 size={32} style={{ margin: "0 auto 12px auto", opacity: 0.3 }} />
                      <p style={{ fontSize: "0.9rem" }}>
                        {filterTrashDate ? `No trashed alerts match date ${filterTrashDate}.` : "Trash is empty. Trashed alert messages will appear here."}
                      </p>
                    </div>
                  );
                }

                return filtered.map((alertItem) => (
                  <div 
                    key={alertItem.id}
                    style={{
                      background: "rgba(255,255,255,0.01)",
                      border: "1px solid var(--border-glass)",
                      borderRadius: "var(--radius-md)",
                      padding: "16px",
                      display: "flex",
                      flexDirection: "column",
                      gap: "10px"
                    }}
                  >
                    <div style={{ display: "flex", gap: "12px", alignItems: "start" }}>
                      {/* Image Thumbnail */}
                      <img 
                        src={getSnapshotUrl(alertItem.snapshot_url)} 
                        alt="Alert Snapshot" 
                        style={{
                          width: "80px",
                          height: "60px",
                          objectFit: "cover",
                          borderRadius: "4px",
                          border: "1px solid var(--border-glass)",
                          cursor: "pointer"
                        }}
                        onClick={() => setExpandedSnapshot({ url: getSnapshotUrl(alertItem.snapshot_url), title: `Trashed: ${alertItem.camera_name}` })}
                      />
                      <div style={{ flex: 1 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start" }}>
                          <h4 style={{ fontSize: "0.85rem", fontWeight: 700, color: "#fff" }}>
                            {alertItem.camera_name} {alertItem.zone_tag && `— ${alertItem.zone_tag}`}
                          </h4>
                          <span style={{ color: "var(--text-muted)", fontSize: "0.7rem", display: "flex", alignItems: "center", gap: "4px" }}>
                            <Clock size={10} />
                            {formatDateTime(alertItem.created_at || alertItem.timestamp)}
                          </span>
                        </div>
                        <p style={{ fontSize: "0.75rem", color: "var(--text-secondary)", marginTop: "4px", lineHeight: "1.3" }}>
                          {alertItem.threat_description}
                        </p>
                      </div>
                    </div>

                    <div style={{ 
                      display: "flex", 
                      justifyContent: "space-between", 
                      alignItems: "center", 
                      borderTop: "1px solid rgba(255,255,255,0.03)", 
                      paddingTop: "10px",
                      marginTop: "4px"
                    }}>
                      <span style={{ fontSize: "0.65rem", color: "var(--text-muted)" }}>
                        Confidence: <strong style={{ color: "var(--danger)" }}>{(alertItem.confidence_score * 100).toFixed(0)}%</strong>
                      </span>
                      <div style={{ display: "flex", gap: "8px" }}>
                        <button
                          onClick={() => handleRecoverAlert(alertItem.id)}
                          style={{
                            background: "rgba(16, 185, 129, 0.15)",
                            border: "1px solid rgba(16, 185, 129, 0.3)",
                            borderRadius: "4px",
                            padding: "6px 12px",
                            color: "var(--success)",
                            cursor: "pointer",
                            fontSize: "0.75rem",
                            display: "flex",
                            alignItems: "center",
                            gap: "6px",
                            transition: "background 0.15s ease"
                          }}
                          title="Restore alert to Notifications list"
                        >
                          <RotateCcw size={12} />
                          Recover
                        </button>
                        <button
                          onClick={() => handleDeleteAlertPermanently(alertItem.id)}
                          style={{
                            background: "rgba(239, 68, 68, 0.15)",
                            border: "1px solid rgba(239, 68, 68, 0.3)",
                            borderRadius: "4px",
                            padding: "6px 12px",
                            color: "var(--danger)",
                            cursor: "pointer",
                            fontSize: "0.75rem",
                            display: "flex",
                            alignItems: "center",
                            gap: "6px",
                            transition: "background 0.15s ease"
                          }}
                          title="Permanently delete from database"
                        >
                          <Trash2 size={12} />
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                ));
              })()}
            </div>

            {/* Footer */}
            <div style={{
              padding: "12px 20px",
              borderTop: "1px solid var(--border-glass)",
              display: "flex",
              justifyContent: "flex-end",
              background: "rgba(255,255,255,0.01)"
            }}>
              <button 
                onClick={handleCloseTrashModal}
                className="btn-secondary"
                style={{ fontSize: "0.8rem", padding: "8px 16px" }}
              >
                Close Trash
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Fullscreen Snapshot Pop-up Window */}
      {expandedSnapshot && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: "rgba(3, 1, 10, 0.95)",
          backdropFilter: "blur(12px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 200,
          padding: "40px",
          animation: "fadeIn 0.2s ease-out"
        }} onClick={() => setExpandedSnapshot(null)}>
          <div style={{
            position: "relative",
            maxWidth: "90vw",
            maxHeight: "90vh",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "16px"
          }} onClick={(e) => e.stopPropagation()}>
            <button 
              onClick={() => setExpandedSnapshot(null)}
              style={{
                position: "absolute",
                top: "-40px",
                right: "0",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: "6px",
                color: "#fff",
                fontSize: "0.9rem",
                fontWeight: 600
              }}
            >
              <X size={20} /> Close Preview
            </button>
            <img 
              src={expandedSnapshot.url} 
              alt="Expanded Snapshot" 
              style={{
                maxWidth: "100%",
                maxHeight: "80vh",
                borderRadius: "var(--radius-md)",
                boxShadow: "0 10px 40px rgba(0,0,0,0.8)",
                border: "1px solid var(--border-glass)",
                objectFit: "contain"
              }}
            />
            <div style={{ color: "#fff", fontWeight: 700, fontSize: "1.1rem", textAlign: "center" }}>
              {expandedSnapshot.title}
            </div>
          </div>
        </div>
      )}

      {/* Advanced Zoomable Incident Snapshot Viewer Modal */}
      {selectedAlert && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: "rgba(3, 1, 10, 0.9)",
          backdropFilter: "blur(12px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 150,
          padding: "20px"
        }} onClick={() => setSelectedAlert(null)}>
          <div style={{
            background: "#0c0721",
            border: "1px solid var(--border-glass)",
            borderRadius: "var(--radius-lg)",
            width: "100%",
            maxWidth: isImageMaximized ? "95vw" : "900px",
            height: "80vh",
            maxHeight: "80vh",
            display: "flex",
            flexDirection: "column",
            boxShadow: "0 20px 50px rgba(0, 0, 0, 0.7)",
            animation: "fadeIn 0.2s ease-out",
            transition: "max-width 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
            overflow: "hidden"
          }} onClick={(e) => e.stopPropagation()}>
            
            {/* Title Header */}
            <div style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "16px 24px",
              borderBottom: "1px solid var(--border-glass)",
              background: "rgba(255,255,255,0.02)"
            }}>
              <div>
                <span style={{ fontSize: "0.7rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "1px" }}>Gemini Verified Incident Snapshot</span>
                <h3 style={{ fontSize: "1.1rem", fontWeight: 700, color: "#fff", marginTop: "4px" }}>
                  {selectedAlert.camera_name} {selectedAlert.zone_tag ? `— ${selectedAlert.zone_tag}` : ""}
                </h3>
              </div>
              <button 
                onClick={() => setSelectedAlert(null)}
                style={{ background: "transparent", border: "none", cursor: "pointer", display: "flex", padding: "6px" }}
                title="Close details window"
              >
                <X size={20} color="var(--text-secondary)" />
              </button>
            </div>

            {/* Main split-pane content */}
            <div style={{ display: "flex", flex: 1, overflow: "hidden", flexDirection: isImageMaximized ? "column" : "row" }}>
              
              {/* Left Side: Interactive Zoomable Image container */}
              <div style={{
                flex: isImageMaximized ? 1 : 1.3,
                position: "relative",
                background: "#000",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                overflow: "hidden",
                borderRight: isImageMaximized ? "none" : "1px solid var(--border-glass)",
                borderBottom: isImageMaximized ? "1px solid var(--border-glass)" : "none"
              }}
              onMouseDown={handleMouseDownAlert}
              onMouseMove={handleMouseMoveAlert}
              onMouseUp={handleMouseUpAlert}
              onMouseLeave={handleMouseLeaveAlert}
              >
                <img 
                  src={selectedAlert.snapshot_url ? getSnapshotUrl(selectedAlert.snapshot_url) : `${API_BASE}/api/cameras/${selectedAlert.camera_id}/snapshot`} 
                  alt="Gemini Confirmed Threat" 
                  style={{
                    maxWidth: "100%",
                    maxHeight: "100%",
                    objectFit: "contain",
                    transform: `scale(${alertZoomScale}) translate(${alertPanOffset.x}px, ${alertPanOffset.y}px)`,
                    transformOrigin: "center",
                    cursor: alertZoomScale > 1 ? "grab" : "default",
                    transition: isAlertDragging ? "none" : "transform 0.2s ease-out"
                  }}
                  onError={(e) => {
                    if (selectedAlert.camera_id) {
                      const fallback = `${API_BASE}/api/cameras/${selectedAlert.camera_id}/snapshot`;
                      if ((e.target as HTMLImageElement).src !== fallback) {
                        (e.target as HTMLImageElement).src = fallback;
                      }
                    }
                  }}
                />

                {/* Floating Controls over Image */}
                <div style={{
                  position: "absolute",
                  bottom: "16px",
                  left: "50%",
                  transform: "translateX(-50%)",
                  background: "rgba(10, 5, 27, 0.85)",
                  border: "1px solid var(--border-glass)",
                  borderRadius: "var(--radius-md)",
                  padding: "6px 12px",
                  display: "flex",
                  alignItems: "center",
                  gap: "12px",
                  backdropFilter: "blur(6px)",
                  zIndex: 10
                }}>
                  <button 
                    onClick={handleAlertZoomOut} 
                    style={{ background: "transparent", border: "none", cursor: "pointer", display: "flex", padding: "4px" }}
                    title="Zoom Out (Minimize Image)"
                  >
                    <ZoomOut size={16} color="#fff" />
                  </button>
                  <span style={{ fontSize: "0.75rem", fontWeight: 700, color: "#fff", minWidth: "36px", textAlign: "center" }}>
                    {Math.round(alertZoomScale * 100)}%
                  </span>
                  <button 
                    onClick={handleAlertZoomIn} 
                    style={{ background: "transparent", border: "none", cursor: "pointer", display: "flex", padding: "4px" }}
                    title="Zoom In (Maximize Image)"
                  >
                    <ZoomIn size={16} color="#fff" />
                  </button>
                  <button 
                    onClick={handleAlertZoomReset} 
                    style={{ background: "transparent", border: "none", cursor: "pointer", display: "flex", padding: "4px" }}
                    title="Reset View"
                  >
                    <RefreshCw size={14} color="#fff" />
                  </button>
                  <span style={{ width: "1px", height: "14px", background: "var(--border-glass)" }}></span>
                  <button 
                    onClick={() => setIsImageMaximized(!isImageMaximized)}
                    style={{
                      background: "transparent",
                      border: "none",
                      cursor: "pointer",
                      display: "flex",
                      padding: "4px",
                      alignItems: "center"
                    }}
                    title={isImageMaximized ? "Split Layout (Show details)" : "Maximize Image Container"}
                  >
                    {isImageMaximized ? <Minimize2 size={16} color="var(--secondary)" /> : <Maximize2 size={16} color="var(--secondary)" />}
                  </button>
                </div>
              </div>

              {/* Right Side: Details pane */}
              {!isImageMaximized && (() => {
                const vConfig = getViolenceConfig(getViolenceLevel(selectedAlert));
                return (
                <div style={{
                  flex: 1,
                  padding: "24px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "20px",
                  overflowY: "auto"
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                    <span style={{
                      color: vConfig.color,
                      fontSize: "0.72rem",
                      fontWeight: 700,
                      background: vConfig.badgeBg,
                      border: `1px solid ${vConfig.border}`,
                      padding: "4px 10px",
                      borderRadius: "4px",
                      textTransform: "uppercase",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px"
                    }}>
                      <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: vConfig.dotColor, boxShadow: `0 0 8px ${vConfig.glow}` }}></span>
                      {vConfig.label}
                    </span>
                    <span style={{
                      color: selectedAlert.is_resolved ? "var(--success)" : "var(--danger)",
                      fontSize: "0.7rem",
                      fontWeight: 700,
                      background: selectedAlert.is_resolved ? "rgba(16, 185, 129, 0.15)" : "rgba(239, 68, 68, 0.15)",
                      border: `1px solid ${selectedAlert.is_resolved ? "rgba(16, 185, 129, 0.3)" : "rgba(239, 68, 68, 0.3)"}`,
                      padding: "4px 8px",
                      borderRadius: "4px",
                      textTransform: "uppercase"
                    }}>
                      {selectedAlert.is_resolved ? "Resolved Anomaly" : "Active Threat Alarm"}
                    </span>
                  </div>

                  <div>
                    <h4 style={{ fontSize: "0.85rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.5px" }}>Verified Threat Description</h4>
                    <p style={{ fontSize: "0.95rem", color: "var(--text-primary)", marginTop: "6px", lineHeight: "1.5", fontWeight: 500 }}>
                      {selectedAlert.threat_description.replace(" [Not Gemini Verified]", "")}
                    </p>
                    {selectedAlert.threat_description.includes("[Not Gemini Verified]") && (
                      <div style={{ color: "var(--danger)", fontSize: "0.8rem", fontWeight: 700, marginTop: "6px" }}>
                        ⚠️ NOT GEMINI VERIFIED (OFFLINE SIMULATION FALLBACK)
                      </div>
                    )}
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
                    <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid var(--border-glass)", padding: "12px", borderRadius: "var(--radius-sm)" }}>
                      <span style={{ fontSize: "0.7rem", color: "var(--text-muted)", textTransform: "uppercase" }}>
                        {selectedAlert.threat_description.includes("[Not Gemini Verified]") ? "Model Confidence" : "Gemini Confidence"}
                      </span>
                      <div style={{ fontSize: "1.4rem", fontWeight: 800, color: selectedAlert.threat_description.includes("[Not Gemini Verified]") ? "var(--warning)" : "var(--primary)", marginTop: "4px" }}>
                        {(selectedAlert.confidence_score * 100).toFixed(0)}%
                      </div>
                    </div>
                    <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid var(--border-glass)", padding: "12px", borderRadius: "var(--radius-sm)" }}>
                      <span style={{ fontSize: "0.7rem", color: "var(--text-muted)", textTransform: "uppercase" }}>Detection Time</span>
                      <div style={{ fontSize: "0.95rem", fontWeight: 700, color: "#fff", marginTop: "8px" }}>
                        {formatTime12H(selectedAlert.created_at || selectedAlert.timestamp)}
                      </div>
                      <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "2px" }}>
                        {formatDate(selectedAlert.created_at || selectedAlert.timestamp)}
                      </div>
                    </div>
                  </div>

                  <div style={{ flex: 1 }}></div>

                  <div style={{ display: "flex", gap: "12px" }}>
                    <button 
                      onClick={() => setSelectedAlert(null)}
                      className="btn-secondary"
                      style={{ flex: 1, justifyContent: "center", padding: "12px" }}
                    >
                      Close View
                    </button>
                  </div>
                </div>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* Access Management Modal */}
      {activeAccessProject && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: "rgba(3, 1, 10, 0.85)",
          backdropFilter: "blur(8px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 110,
          padding: "20px"
        }} onClick={handleCloseAccessModal}>
          <div style={{
            background: "#0c0721",
            border: "1px solid var(--border-glass)",
            borderRadius: "var(--radius-lg)",
            width: "100%",
            maxWidth: "540px",
            maxHeight: "85vh",
            display: "flex",
            flexDirection: "column",
            boxShadow: "0 20px 50px rgba(0, 0, 0, 0.6)",
            animation: "fadeIn 0.2s ease-out"
          }} onClick={(e) => e.stopPropagation()}>
            
            {/* Header */}
            <div style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "18px 24px",
              borderBottom: "1px solid var(--border-glass)"
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <Users size={20} color="var(--primary)" />
                <div>
                  <h3 style={{ fontWeight: 700, fontSize: "1.1rem", margin: 0 }}>Access Management</h3>
                  <p style={{ color: "var(--text-secondary)", fontSize: "0.75rem", margin: "2px 0 0 0" }}>
                    {activeAccessProject.name} ({activeAccessProject.project_type.toUpperCase()})
                  </p>
                </div>
              </div>
              <button 
                onClick={handleCloseAccessModal}
                style={{
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: "4px"
                }}
                title="Close"
              >
                <X size={20} color="var(--text-secondary)" />
              </button>
            </div>

            {/* Modal Body */}
            <div style={{ padding: "24px", overflowY: "auto", flex: 1 }}>
              
              {/* Add Member Form */}
              <form onSubmit={handleAddMemberSubmit} style={{ display: "flex", flexDirection: "column", gap: "14px", marginBottom: "24px" }}>
                <label style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--text-primary)" }}>
                  Invite New Member / Responder
                </label>
                
                <div style={{ display: "flex", gap: "10px" }}>
                  <input 
                    type="email"
                    required
                    placeholder="Enter email address (e.g. responder@example.com)"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    style={{
                      flex: 1,
                      padding: "10px 14px",
                      fontSize: "0.85rem",
                      background: "rgba(255,255,255,0.03)",
                      border: "1px solid var(--border-glass)",
                      borderRadius: "var(--radius-sm)",
                      color: "#fff",
                      outline: "none"
                    }}
                  />
                  <select
                    value={inviteRole}
                    onChange={(e) => setInviteRole(e.target.value)}
                    style={{
                      padding: "10px 12px",
                      fontSize: "0.82rem",
                      background: "#160f33",
                      border: "1px solid var(--border-glass)",
                      borderRadius: "var(--radius-sm)",
                      color: "#fff",
                      outline: "none",
                      cursor: "pointer"
                    }}
                  >
                    <option value="responder">Responder</option>
                    <option value="viewer">Viewer</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>

                <button
                  type="submit"
                  disabled={inviteLoading || !inviteEmail.trim()}
                  className="btn-primary"
                  style={{
                    padding: "10px 18px",
                    fontSize: "0.85rem",
                    justifyContent: "center",
                    gap: "6px",
                    opacity: inviteLoading || !inviteEmail.trim() ? 0.6 : 1
                  }}
                >
                  <UserPlus size={16} />
                  {inviteLoading ? "Granting Access..." : "Grant Access"}
                </button>
              </form>

              {/* Feedback alert */}
              {accessFeedback && (
                <div style={{
                  padding: "10px 14px",
                  borderRadius: "var(--radius-sm)",
                  marginBottom: "20px",
                  fontSize: "0.8rem",
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  background: accessFeedback.type === "success" ? "rgba(16, 185, 129, 0.12)" : "rgba(239, 68, 68, 0.12)",
                  border: `1px solid ${accessFeedback.type === "success" ? "rgba(16, 185, 129, 0.3)" : "rgba(239, 68, 68, 0.3)"}`,
                  color: accessFeedback.type === "success" ? "var(--success)" : "var(--danger)"
                }}>
                  {accessFeedback.type === "success" ? <Check size={16} /> : <AlertTriangle size={16} />}
                  <span>{accessFeedback.text}</span>
                </div>
              )}

              {/* Current Active Members */}
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
                  <span style={{ fontSize: "0.8rem", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                    Active Workspace Members ({projectMembers.length})
                  </span>
                </div>

                {loadingMembers ? (
                  <div style={{ textAlign: "center", padding: "20px", color: "var(--text-muted)", fontSize: "0.85rem" }}>
                    Loading member roster...
                  </div>
                ) : projectMembers.length === 0 ? (
                  <div style={{ padding: "16px", background: "rgba(255,255,255,0.02)", border: "1px solid var(--border-glass)", borderRadius: "var(--radius-sm)", textAlign: "center", color: "var(--text-muted)", fontSize: "0.8rem" }}>
                    No additional members added yet. Invite team responders above.
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    {projectMembers.map((member) => (
                      <div
                        key={member.id || member.email}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "10px 14px",
                          background: "rgba(255,255,255,0.025)",
                          border: "1px solid var(--border-glass)",
                          borderRadius: "var(--radius-sm)"
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                          <UserCheck size={16} color="var(--primary)" />
                          <div>
                            <div style={{ fontSize: "0.85rem", fontWeight: 600, color: "#fff" }}>{member.email}</div>
                            <div style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
                              Role: <span style={{ textTransform: "capitalize", color: "var(--secondary)" }}>{member.role}</span>
                            </div>
                          </div>
                        </div>
                        <button
                          onClick={() => handleRemoveMember(member.id)}
                          style={{
                            background: "rgba(239, 68, 68, 0.1)",
                            border: "1px solid rgba(239, 68, 68, 0.25)",
                            borderRadius: "4px",
                            color: "var(--danger)",
                            padding: "4px 8px",
                            fontSize: "0.7rem",
                            cursor: "pointer",
                            display: "flex",
                            alignItems: "center",
                            gap: "4px"
                          }}
                          title="Remove Access"
                        >
                          <Trash2 size={12} />
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

            </div>

            {/* Footer */}
            <div style={{
              padding: "14px 24px",
              borderTop: "1px solid var(--border-glass)",
              display: "flex",
              justifyContent: "flex-end",
              background: "rgba(255,255,255,0.01)"
            }}>
              <button
                onClick={handleCloseAccessModal}
                className="btn-secondary"
                style={{ padding: "8px 18px", fontSize: "0.82rem" }}
              >
                Done
              </button>
            </div>

          </div>
        </div>
      )}
    </div>
  );
}
