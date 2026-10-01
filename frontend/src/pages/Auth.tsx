import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Shield, Mail, Lock, User, Building, AlertTriangle, CheckCircle, Info, Eye, EyeOff } from "lucide-react";
import { saveSession } from "../utils/auth";
import { API_BASE } from "../config/api";

export default function AuthPage() {
  const [isLogin, setIsLogin] = useState(true);
  const [formData, setFormData] = useState({
    fullName: "",
    email: "",
    password: "",
    organizationName: "",
    rememberMe: false,
  });

  const [validationError, setValidationError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const navigate = useNavigate();

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value, type, checked } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: type === "checkbox" ? checked : value,
    }));
    setValidationError(null);
  };

  // Enforce strong passwords (Min 8 chars, 1 uppercase, 1 lowercase, 1 number, 1 special char)
  const validatePassword = (password: string) => {
    const regex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#])[A-Za-z\d@$!%*?&#]{8,}$/;
    return regex.test(password);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);
    setStatusMsg(null);

    // Frontend security checks
    if (!formData.email.includes("@")) {
      setValidationError("Please enter a valid email address.");
      return;
    }

    if (!isLogin && !formData.fullName.trim()) {
      setValidationError("Full Name is required.");
      return;
    }

    if (!isLogin && !formData.organizationName.trim()) {
      setValidationError("Organization Name is required.");
      return;
    }

    if (!isLogin && !validatePassword(formData.password)) {
      setValidationError(
        "Password must be at least 8 characters long and contain at least one uppercase letter, one lowercase letter, one number, and one special character (e.g. @, $, !, %, *, ?, &, #)."
      );
      return;
    }

    if (isLogin && !formData.password) {
      setValidationError("Please enter your password.");
      return;
    }

    setIsLoading(true);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000); // 8-second timeout for server/db response

    try {
      if (isLogin) {
        // Log in API call
        const response = await fetch(`${API_BASE}/api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            email: formData.email,
            password: formData.password,
            rememberMe: formData.rememberMe,
          }),
        });

        clearTimeout(timeoutId);

        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.detail || "Authentication failed");
        }

        setStatusMsg({ type: "success", text: "Login successful. Redirecting..." });
        saveSession(data.access_token, formData.rememberMe);
        
        setTimeout(() => {
          navigate("/dashboard");
        }, 1200);

      } else {
        // Register API call
        const response = await fetch(`${API_BASE}/api/auth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            fullName: formData.fullName,
            email: formData.email,
            password: formData.password,
            organizationName: formData.organizationName,
          }),
        });

        clearTimeout(timeoutId);

        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.detail || "Registration failed");
        }

        setStatusMsg({ type: "success", text: "Account registered successfully! Please log in." });
        setIsLogin(true);
        setFormData((prev) => ({ ...prev, password: "" }));
      }
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (err.name === "AbortError") {
        setStatusMsg({ 
          type: "error", 
          text: "Server is taking too long to respond. The serverless database may be waking up from sleep. Please try again in 5 seconds." 
        });
      } else {
        setStatusMsg({ type: "error", text: err.message || "Something went wrong. Please try again." });
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      minHeight: "100vh",
      padding: "24px",
      position: "relative"
    }}>
      <div className="glass-panel" style={{
        width: "100%",
        maxWidth: "460px",
        padding: "40px 32px",
        position: "relative",
        zIndex: 10
      }}>
        {/* Header Icon */}
        <div style={{ display: "flex", justifyContent: "center", marginBottom: "24px" }}>
          <div style={{
            background: "linear-gradient(135deg, var(--primary), var(--secondary))",
            padding: "16px",
            borderRadius: "50%",
            boxShadow: "0 0 20px var(--primary-glow)",
            display: "inline-flex"
          }}>
            <Shield size={32} color="#fff" />
          </div>
        </div>

        <h2 style={{ textAlign: "center", fontSize: "2rem", marginBottom: "8px", fontWeight: 700 }}>
          {isLogin ? "Aegis Guard" : "Create Account"}
        </h2>
        <p style={{ textAlign: "center", color: "var(--text-secondary)", marginBottom: "32px", fontSize: "0.9rem" }}>
          {isLogin ? "AI-Powered Video Analytics & Surveillance Gateway" : "Register organization to start ingestion pipeline"}
        </p>

        {/* Tab switchers */}
        <div style={{
          display: "flex",
          borderBottom: "1px solid var(--border-glass)",
          marginBottom: "24px",
          gap: "16px"
        }}>
          <button 
            type="button"
            onClick={() => { setIsLogin(true); setValidationError(null); setStatusMsg(null); setShowPassword(false); }}
            style={{
              flex: 1,
              background: "none",
              border: "none",
              borderBottom: isLogin ? "2px solid var(--primary)" : "2px solid transparent",
              color: isLogin ? "var(--text-primary)" : "var(--text-muted)",
              paddingBottom: "12px",
              fontWeight: 600,
              fontSize: "0.95rem",
              cursor: "pointer",
              transition: "var(--transition)"
            }}
          >
            Login
          </button>
          <button 
            type="button"
            onClick={() => { setIsLogin(false); setValidationError(null); setStatusMsg(null); setShowPassword(false); }}
            style={{
              flex: 1,
              background: "none",
              border: "none",
              borderBottom: !isLogin ? "2px solid var(--primary)" : "2px solid transparent",
              color: !isLogin ? "var(--text-primary)" : "var(--text-muted)",
              paddingBottom: "12px",
              fontWeight: 600,
              fontSize: "0.95rem",
              cursor: "pointer",
              transition: "var(--transition)"
            }}
          >
            Register
          </button>
        </div>

        {/* Action / Error Alerts */}
        {validationError && (
          <div style={{
            background: "rgba(245, 158, 11, 0.15)",
            border: "1px solid var(--warning)",
            borderRadius: "var(--radius-sm)",
            padding: "12px 16px",
            marginBottom: "20px",
            color: "var(--warning)",
            display: "flex",
            gap: "10px",
            alignItems: "flex-start",
            fontSize: "0.85rem"
          }}>
            <AlertTriangle size={18} style={{ flexShrink: 0, marginTop: "2px" }} />
            <span>{validationError}</span>
          </div>
        )}

        {statusMsg && (
          <div style={{
            background: statusMsg.type === "success" ? "rgba(16, 185, 129, 0.15)" : "rgba(239, 68, 68, 0.15)",
            border: `1px solid ${statusMsg.type === "success" ? "var(--success)" : "var(--danger)"}`,
            borderRadius: "var(--radius-sm)",
            padding: "12px 16px",
            marginBottom: "20px",
            color: statusMsg.type === "success" ? "var(--success)" : "var(--danger)",
            display: "flex",
            flexDirection: "column",
            gap: "6px",
            fontSize: "0.85rem"
          }}>
            <div style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
              {statusMsg.type === "success" ? (
                <CheckCircle size={18} style={{ flexShrink: 0, marginTop: "2px" }} />
              ) : (
                <AlertTriangle size={18} style={{ flexShrink: 0, marginTop: "2px" }} />
              )}
              <span>{statusMsg.text}</span>
            </div>
            {statusMsg.type === "error" && statusMsg.text.toLowerCase().includes("create an account") && (
              <button
                type="button"
                onClick={() => {
                  setIsLogin(false);
                  setStatusMsg(null);
                  setValidationError(null);
                }}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--primary)",
                  textDecoration: "underline",
                  cursor: "pointer",
                  alignSelf: "flex-start",
                  padding: "0",
                  marginTop: "2px",
                  marginLeft: "28px",
                  fontSize: "0.8rem",
                  fontWeight: 600
                }}
              >
                Click here to Register
              </button>
            )}
          </div>
        )}

        {/* Input Form */}
        <form onSubmit={handleSubmit}>
          {!isLogin && (
            <div className="form-group">
              <label className="form-label">Full Name</label>
              <div style={{ position: "relative" }}>
                <span style={{ position: "absolute", left: "14px", top: "14px", color: "var(--text-muted)" }}>
                  <User size={18} />
                </span>
                <input
                  type="text"
                  name="fullName"
                  value={formData.fullName}
                  onChange={handleInputChange}
                  placeholder="e.g. John Doe"
                  className="form-input"
                  style={{ paddingLeft: "42px" }}
                  required
                />
              </div>
            </div>
          )}

          <div className="form-group">
            <label className="form-label">Email Address</label>
            <div style={{ position: "relative" }}>
              <span style={{ position: "absolute", left: "14px", top: "14px", color: "var(--text-muted)" }}>
                <Mail size={18} />
              </span>
              <input
                type="email"
                name="email"
                value={formData.email}
                onChange={handleInputChange}
                placeholder="operator@organization.com"
                className="form-input"
                style={{ paddingLeft: "42px" }}
                required
              />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Password</label>
            <div style={{ position: "relative" }}>
              <span style={{ position: "absolute", left: "14px", top: "14px", color: "var(--text-muted)" }}>
                <Lock size={18} />
              </span>
              <input
                type={showPassword ? "text" : "password"}
                name="password"
                value={formData.password}
                onChange={handleInputChange}
                placeholder="••••••••"
                className="form-input"
                style={{ paddingLeft: "42px", paddingRight: "42px" }}
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                style={{
                  position: "absolute",
                  right: "14px",
                  top: "14px",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--text-muted)",
                  display: "flex",
                  alignItems: "center",
                  padding: 0
                }}
                title={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
            {!isLogin && (
              <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "6px", display: "flex", alignItems: "center", gap: "4px" }}>
                <Info size={12} /> Requires 8+ chars, uppercase, lowercase, number & special char.
              </p>
            )}
          </div>

          {!isLogin && (
            <div className="form-group">
              <label className="form-label">Organization Name</label>
              <div style={{ position: "relative" }}>
                <span style={{ position: "absolute", left: "14px", top: "14px", color: "var(--text-muted)" }}>
                  <Building size={18} />
                </span>
                <input
                  type="text"
                  name="organizationName"
                  value={formData.organizationName}
                  onChange={handleInputChange}
                  placeholder="e.g. Apex Security Corp"
                  className="form-input"
                  style={{ paddingLeft: "42px" }}
                  required
                />
              </div>
            </div>
          )}

          {isLogin && (
            <div style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: "24px",
              fontSize: "0.85rem"
            }}>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  name="rememberMe"
                  checked={formData.rememberMe}
                  onChange={handleInputChange}
                  style={{
                    accentColor: "var(--primary)",
                    cursor: "pointer",
                    width: "16px",
                    height: "16px",
                    borderRadius: "4px"
                  }}
                />
                Remember Me
              </label>
            </div>
          )}

          <button 
            type="submit" 
            className="btn-primary" 
            disabled={isLoading}
            style={{ width: "100%", justifyContent: "center", padding: "14px" }}
          >
            {isLoading ? "Validating credentials..." : (isLogin ? "Authenticate Gate" : "Register Organization")}
          </button>
        </form>
      </div>
    </div>
  );
}
