import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { FolderPlus, School, Home, ShieldAlert, ArrowLeft, ArrowRight, Sparkles } from "lucide-react";
import { getCurrentUser } from "../utils/auth";

const API_BASE = `http://${window.location.hostname}:8000`;

export default function ProjectNew() {
  const [formData, setFormData] = useState({
    name: "",
    location: "",
    projectType: "school", // Default
  });
  
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const navigate = useNavigate();
  const currentUser = getCurrentUser();

  // Route protection
  useEffect(() => {
    if (!currentUser) {
      navigate("/auth");
    }
  }, [currentUser, navigate]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleTypeSelect = (type: string) => {
    setFormData((prev) => ({ ...prev, projectType: type }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name.trim() || !formData.location.trim()) {
      setError("Please fill in all the required blueprint fields.");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`${API_BASE}/api/projects?email=${encodeURIComponent(currentUser!.email)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formData.name,
          location: formData.location,
          project_type: formData.projectType,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail || "Failed to initialize project blueprint.");
      }

      // Success, route to setup page
      navigate(`/project/${data.project.id}/setup`);
    } catch (err: any) {
      setError(err.message || "Something went wrong. Project could not be created.");
    } finally {
      setLoading(false);
    }
  };

  if (!currentUser) return null;

  return (
    <div style={{ minHeight: "100vh", padding: "60px 24px", display: "flex", justifyContent: "center", alignItems: "center" }}>
      <div className="glass-panel" style={{ width: "100%", maxWidth: "680px", padding: "40px" }}>
        
        {/* Navigation back */}
        <button 
          onClick={() => navigate("/dashboard")} 
          className="btn-secondary" 
          style={{ marginBottom: "32px", padding: "8px 16px", fontSize: "0.85rem" }}
        >
          <ArrowLeft size={16} />
          Back to Hub
        </button>

        <div style={{ display: "flex", alignItems: "center", gap: "16px", marginBottom: "32px" }}>
          <div style={{
            background: "linear-gradient(135deg, var(--primary), var(--secondary))",
            padding: "12px",
            borderRadius: "var(--radius-md)",
            boxShadow: "0 0 15px var(--primary-glow)"
          }}>
            <FolderPlus size={24} color="#fff" />
          </div>
          <div>
            <h1 style={{ fontSize: "1.6rem", fontWeight: 700 }}>Initialize Project Blueprint</h1>
            <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", marginTop: "2px" }}>Define workspace environments to configure specific AI intelligence models</p>
          </div>
        </div>

        {error && (
          <div className="glass-panel" style={{ padding: "16px", color: "var(--danger)", border: "1px solid var(--danger)", marginBottom: "24px", fontSize: "0.9rem" }}>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          {/* Metadata Section */}
          <div className="form-group">
            <label className="form-label">Project Name</label>
            <input
              type="text"
              name="name"
              value={formData.name}
              onChange={handleInputChange}
              placeholder="e.g. Oakridge Campus Security Grid"
              className="form-input"
              required
            />
          </div>

          <div className="form-group">
            <label className="form-label">Physical Street Address / Location</label>
            <textarea
              name="location"
              value={formData.location}
              onChange={handleInputChange}
              placeholder="123 Guard Way, Silicon Valley, CA, USA"
              className="form-input"
              rows={3}
              style={{ resize: "none", width: "100%", fontFamily: "var(--font-body)" }}
              required
            />
          </div>

          {/* Sector Selection Matrix */}
          <div style={{ marginBottom: "32px" }}>
            <label className="form-label" style={{ marginBottom: "12px" }}>Sector Selection Matrix</label>
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: "16px"
            }}>
              {/* Card 1: School */}
              <div 
                onClick={() => handleTypeSelect("school")}
                className={`glass-panel ${formData.projectType === "school" ? "glow-active" : ""}`}
                style={{
                  padding: "20px 16px",
                  cursor: "pointer",
                  textAlign: "center",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: "12px",
                  border: formData.projectType === "school" ? "1px solid var(--secondary)" : "1px solid var(--border-glass)",
                  background: formData.projectType === "school" ? "rgba(6, 182, 212, 0.08)" : "var(--bg-glass)"
                }}
              >
                <School size={28} color={formData.projectType === "school" ? "var(--secondary)" : "var(--text-muted)"} />
                <div>
                  <h3 style={{ fontSize: "1rem", fontWeight: 600, color: formData.projectType === "school" ? "var(--secondary)" : "var(--text-primary)" }}>
                    School / Institution
                  </h3>
                  <p style={{ fontSize: "0.75rem", color: "var(--text-secondary)", marginTop: "4px" }}>
                    Campus safety and playground monitoring
                  </p>
                </div>
              </div>

              {/* Card 2: Home */}
              <div 
                onClick={() => handleTypeSelect("home")}
                className={`glass-panel ${formData.projectType === "home" ? "glow-active" : ""}`}
                style={{
                  padding: "20px 16px",
                  cursor: "pointer",
                  textAlign: "center",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: "12px",
                  border: formData.projectType === "home" ? "1px solid var(--accent)" : "1px solid var(--border-glass)",
                  background: formData.projectType === "home" ? "rgba(236, 72, 153, 0.08)" : "var(--bg-glass)"
                }}
              >
                <Home size={28} color={formData.projectType === "home" ? "var(--accent)" : "var(--text-muted)"} />
                <div>
                  <h3 style={{ fontSize: "1rem", fontWeight: 600, color: formData.projectType === "home" ? "var(--accent)" : "var(--text-primary)" }}>
                    Home / Residential
                  </h3>
                  <p style={{ fontSize: "0.75rem", color: "var(--text-secondary)", marginTop: "4px" }}>
                    Domestic security for gates & garages
                  </p>
                </div>
              </div>

              {/* Card 3: Government */}
              <div 
                onClick={() => handleTypeSelect("government")}
                className={`glass-panel ${formData.projectType === "government" ? "glow-active" : ""}`}
                style={{
                  padding: "20px 16px",
                  cursor: "pointer",
                  textAlign: "center",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: "12px",
                  border: formData.projectType === "government" ? "1px solid var(--primary)" : "1px solid var(--border-glass)",
                  background: formData.projectType === "government" ? "rgba(139, 92, 246, 0.08)" : "var(--bg-glass)"
                }}
              >
                <ShieldAlert size={28} color={formData.projectType === "government" ? "var(--primary)" : "var(--text-muted)"} />
                <div>
                  <h3 style={{ fontSize: "1rem", fontWeight: 600, color: formData.projectType === "government" ? "var(--primary)" : "var(--text-primary)" }}>
                    Government
                  </h3>
                  <p style={{ fontSize: "0.75rem", color: "var(--text-secondary)", marginTop: "4px" }}>
                    High compliance audit and logging
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Conditional Sector Features Panel */}
          <div className="glass-panel" style={{
            padding: "20px",
            background: "rgba(255,255,255,0.01)",
            marginBottom: "32px",
            border: "1px dashed var(--border-glass)"
          }}>
            <h4 style={{ fontSize: "0.9rem", fontWeight: 600, marginBottom: "12px", display: "flex", alignItems: "center", gap: "8px" }}>
              <Sparkles size={16} color="var(--primary)" />
              Unlocked Intelligence Parameters
            </h4>

            {formData.projectType === "school" && (
              <div>
                <p style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                  Campus monitoring system unlocked. Allows filtering and tagging streams with high-traffic school-specific markers:
                </p>
                <div style={{ display: "flex", gap: "10px", marginTop: "12px" }}>
                  {["Classroom", "Playground", "Corridor"].map((tag) => (
                    <span key={tag} style={{
                      background: "rgba(6, 182, 212, 0.1)",
                      border: "1px solid rgba(6, 182, 212, 0.2)",
                      color: "var(--secondary)",
                      padding: "4px 10px",
                      fontSize: "0.75rem",
                      borderRadius: "12px",
                      fontWeight: 500
                    }}>{tag}</span>
                  ))}
                </div>
              </div>
            )}

            {formData.projectType === "home" && (
              <div>
                <p style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                  Domestic monitoring suite unlocked. Optimizes stream classification for standard house and boundary security checks:
                </p>
                <div style={{ display: "flex", gap: "10px", marginTop: "12px" }}>
                  {["Main Door", "Backyard", "Garage"].map((tag) => (
                    <span key={tag} style={{
                      background: "rgba(236, 72, 153, 0.1)",
                      border: "1px solid rgba(236, 72, 153, 0.2)",
                      color: "var(--accent)",
                      padding: "4px 10px",
                      fontSize: "0.75rem",
                      borderRadius: "12px",
                      fontWeight: 500
                    }}>{tag}</span>
                  ))}
                </div>
              </div>
            )}

            {formData.projectType === "government" && (
              <div>
                <p style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                  Strict compliance framework enabled. Integrates continuous security logging, audit trails, and strict role hierarchy checks for operations:
                </p>
                <div style={{ display: "flex", gap: "12px", marginTop: "12px", alignItems: "center" }}>
                  <span style={{
                    background: "rgba(139, 92, 246, 0.1)",
                    border: "1px solid rgba(139, 92, 246, 0.2)",
                    color: "var(--primary)",
                    padding: "4px 10px",
                    fontSize: "0.75rem",
                    borderRadius: "12px",
                    fontWeight: 500
                  }}>Strict Audit Trails</span>
                  <span style={{
                    background: "rgba(139, 92, 246, 0.1)",
                    border: "1px solid rgba(139, 92, 246, 0.2)",
                    color: "var(--primary)",
                    padding: "4px 10px",
                    fontSize: "0.75rem",
                    borderRadius: "12px",
                    fontWeight: 500
                  }}>Continuous Surveillance Logs</span>
                </div>
              </div>
            )}
          </div>

          <button 
            type="submit" 
            className="btn-primary" 
            disabled={loading}
            style={{ width: "100%", justifyContent: "center", padding: "14px" }}
          >
            {loading ? "Generating Workspace Blueprint..." : "Create Workspace Blueprint"}
            <ArrowRight size={18} />
          </button>
        </form>
      </div>
    </div>
  );
}
