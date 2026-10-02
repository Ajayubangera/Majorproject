import React, { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { 
  Shield, Mail, Lock, User, Building, AlertTriangle, 
  CheckCircle, Info, Eye, EyeOff, KeyRound, ArrowLeft 
} from "lucide-react";
import { saveSession } from "../utils/auth";
import { API_BASE } from "../config/api";

type AuthMode = "login" | "register" | "forgot" | "reset";

export default function AuthPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const resetTokenParam = searchParams.get("reset_token");
  const emailParam = searchParams.get("email");

  const [authMode, setAuthMode] = useState<AuthMode>(resetTokenParam ? "reset" : "login");
  
  const [formData, setFormData] = useState({
    fullName: "",
    email: emailParam || "",
    password: "",
    organizationName: "",
    rememberMe: false,
  });

  // Forgot password state
  const [forgotEmail, setForgotEmail] = useState(emailParam || "");

  // Reset password state
  const [resetPassword, setResetPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showResetPassword, setShowResetPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const [validationError, setValidationError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const navigate = useNavigate();

  // If URL has reset_token parameter, switch to reset mode immediately
  useEffect(() => {
    if (resetTokenParam) {
      setAuthMode("reset");
      if (emailParam) {
        setFormData((prev) => ({ ...prev, email: emailParam }));
        setForgotEmail(emailParam);
      }
    }
  }, [resetTokenParam, emailParam]);

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

  // Main login/register submit handler
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);
    setStatusMsg(null);

    // Frontend security checks
    if (!formData.email.includes("@")) {
      setValidationError("Please enter a valid email address.");
      return;
    }

    if (authMode === "register" && !formData.fullName.trim()) {
      setValidationError("Full Name is required.");
      return;
    }

    if (authMode === "register" && !formData.organizationName.trim()) {
      setValidationError("Organization Name is required.");
      return;
    }

    if (authMode === "register" && !validatePassword(formData.password)) {
      setValidationError(
        "Password must be at least 8 characters long and contain at least one uppercase letter, one lowercase letter, one number, and one special character (e.g. @, $, !, %, *, ?, &, #)."
      );
      return;
    }

    if (authMode === "login" && !formData.password) {
      setValidationError("Please enter your password.");
      return;
    }

    setIsLoading(true);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000); // 8-second timeout for server/db response

    try {
      if (authMode === "login") {
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

      } else if (authMode === "register") {
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

        setStatusMsg({ 
          type: "success", 
          text: "Account registered successfully! A welcome confirmation email has been sent to your inbox. Please log in." 
        });
        setAuthMode("login");
        setFormData((prev) => ({ ...prev, password: "" }));
      }
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (err.name === "AbortError") {
        setStatusMsg({ 
          type: "error", 
          text: "Server is taking too long to respond. The database may be waking up from sleep. Please try again in 5 seconds." 
        });
      } else {
        setStatusMsg({ type: "error", text: err.message || "Something went wrong. Please try again." });
      }
    } finally {
      setIsLoading(false);
    }
  };

  // Forgot password request handler
  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);
    setStatusMsg(null);

    const targetEmail = forgotEmail.trim();
    if (!targetEmail || !targetEmail.includes("@")) {
      setValidationError("Please enter a valid registered email address.");
      return;
    }

    setIsLoading(true);
    try {
      const response = await fetch(`${API_BASE}/api/auth/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: targetEmail }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail || "Unable to process password reset request.");
      }

      setStatusMsg({
        type: "success",
        text: `If an account with '${targetEmail}' exists, a secure password reset link has been dispatched to your email! Please check your inbox and spam folder.`
      });
    } catch (err: any) {
      setStatusMsg({
        type: "error",
        text: err.message || "Failed to dispatch reset email. Please try again."
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Reset password submission handler
  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);
    setStatusMsg(null);

    if (!resetTokenParam) {
      setValidationError("No password reset token found. Please click the reset link sent to your email.");
      return;
    }

    if (!validatePassword(resetPassword)) {
      setValidationError(
        "New password must be at least 8 characters long and contain at least one uppercase letter, one lowercase letter, one number, and one special character."
      );
      return;
    }

    if (resetPassword !== confirmPassword) {
      setValidationError("Passwords do not match. Please ensure both passwords are identical.");
      return;
    }

    setIsLoading(true);
    try {
      const response = await fetch(`${API_BASE}/api/auth/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: resetTokenParam,
          newPassword: resetPassword
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail || "Password reset failed.");
      }

      setStatusMsg({
        type: "success",
        text: "Password reset successful! You can now authenticate with your new password."
      });

      // Clear search params from URL
      setSearchParams({});
      if (emailParam) {
        setFormData((prev) => ({ ...prev, email: emailParam, password: "" }));
      }
      setResetPassword("");
      setConfirmPassword("");
      setAuthMode("login");
    } catch (err: any) {
      setStatusMsg({
        type: "error",
        text: err.message || "Failed to reset password. The link may have expired (links expire after 30 minutes)."
      });
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
            background: authMode === "forgot" || authMode === "reset"
              ? "linear-gradient(135deg, #ef4444, #8b5cf6)"
              : "linear-gradient(135deg, var(--primary), var(--secondary))",
            padding: "16px",
            borderRadius: "50%",
            boxShadow: "0 0 20px var(--primary-glow)",
            display: "inline-flex"
          }}>
            {authMode === "forgot" || authMode === "reset" ? (
              <KeyRound size={32} color="#fff" />
            ) : (
              <Shield size={32} color="#fff" />
            )}
          </div>
        </div>

        {/* Title & Subtitle */}
        <h2 style={{ textAlign: "center", fontSize: "2rem", marginBottom: "8px", fontWeight: 700 }}>
          {authMode === "forgot" && "Forgot Password"}
          {authMode === "reset" && "Reset Password"}
          {authMode === "login" && "Aegis Guard"}
          {authMode === "register" && "Create Account"}
        </h2>
        <p style={{ textAlign: "center", color: "var(--text-secondary)", marginBottom: "32px", fontSize: "0.9rem" }}>
          {authMode === "forgot" && "Enter your registered email to receive a recovery link"}
          {authMode === "reset" && "Set a new secure password for your account"}
          {authMode === "login" && "AI-Powered Video Analytics & Surveillance Gateway"}
          {authMode === "register" && "Register organization to start ingestion pipeline"}
        </p>

        {/* Tab switchers for Login/Register */}
        {(authMode === "login" || authMode === "register") && (
          <div style={{
            display: "flex",
            borderBottom: "1px solid var(--border-glass)",
            marginBottom: "24px",
            gap: "16px"
          }}>
            <button 
              type="button"
              onClick={() => { setAuthMode("login"); setValidationError(null); setStatusMsg(null); setShowPassword(false); }}
              style={{
                flex: 1,
                background: "none",
                border: "none",
                borderBottom: authMode === "login" ? "2px solid var(--primary)" : "2px solid transparent",
                color: authMode === "login" ? "var(--text-primary)" : "var(--text-muted)",
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
              onClick={() => { setAuthMode("register"); setValidationError(null); setStatusMsg(null); setShowPassword(false); }}
              style={{
                flex: 1,
                background: "none",
                border: "none",
                borderBottom: authMode === "register" ? "2px solid var(--primary)" : "2px solid transparent",
                color: authMode === "register" ? "var(--text-primary)" : "var(--text-muted)",
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
        )}

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
                  setAuthMode("register");
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

        {/* ─── 1. FORGOT PASSWORD VIEW ────────────────────────────────────── */}
        {authMode === "forgot" && (
          <form onSubmit={handleForgotPassword}>
            <div className="form-group">
              <label className="form-label">Registered Email Address</label>
              <div style={{ position: "relative" }}>
                <span style={{ position: "absolute", left: "14px", top: "14px", color: "var(--text-muted)" }}>
                  <Mail size={18} />
                </span>
                <input
                  type="email"
                  value={forgotEmail}
                  onChange={(e) => { setForgotEmail(e.target.value); setValidationError(null); }}
                  placeholder="Enter your registered email"
                  className="form-input"
                  style={{ paddingLeft: "42px" }}
                  required
                />
              </div>
              <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "8px", lineHeight: 1.4 }}>
                We will email you a secure link valid for 30 minutes to set a new password.
              </p>
            </div>

            <button 
              type="submit" 
              className="btn-primary" 
              disabled={isLoading}
              style={{ width: "100%", justifyContent: "center", padding: "14px", marginTop: "12px", marginBottom: "16px" }}
            >
              {isLoading ? "Dispatching reset email..." : "Send Reset Link"}
            </button>

            <button
              type="button"
              onClick={() => {
                setAuthMode("login");
                setValidationError(null);
                setStatusMsg(null);
              }}
              style={{
                width: "100%",
                background: "transparent",
                border: "1px solid var(--border-glass)",
                borderRadius: "var(--radius-md)",
                padding: "10px",
                color: "var(--text-secondary)",
                fontSize: "0.85rem",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "8px",
                transition: "var(--transition)"
              }}
            >
              <ArrowLeft size={16} /> Back to Sign In
            </button>
          </form>
        )}

        {/* ─── 2. RESET PASSWORD VIEW (From Email Link) ──────────────────── */}
        {authMode === "reset" && (
          <form onSubmit={handleResetPassword}>
            {emailParam && (
              <div style={{
                background: "rgba(99, 102, 241, 0.1)",
                border: "1px solid rgba(99, 102, 241, 0.3)",
                borderRadius: "var(--radius-sm)",
                padding: "10px 14px",
                marginBottom: "20px",
                fontSize: "0.85rem",
                color: "#c7d2fe"
              }}>
                Resetting password for: <strong>{emailParam}</strong>
              </div>
            )}

            <div className="form-group">
              <label className="form-label">New Password</label>
              <div style={{ position: "relative" }}>
                <span style={{ position: "absolute", left: "14px", top: "14px", color: "var(--text-muted)" }}>
                  <Lock size={18} />
                </span>
                <input
                  type={showResetPassword ? "text" : "password"}
                  value={resetPassword}
                  onChange={(e) => { setResetPassword(e.target.value); setValidationError(null); }}
                  placeholder="Enter new strong password"
                  className="form-input"
                  style={{ paddingLeft: "42px", paddingRight: "42px" }}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowResetPassword(!showResetPassword)}
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
                  title={showResetPassword ? "Hide password" : "Show password"}
                >
                  {showResetPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
              <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "6px", display: "flex", alignItems: "center", gap: "4px" }}>
                <Info size={12} /> Requires 8+ chars, uppercase, lowercase, number & special char.
              </p>
            </div>

            <div className="form-group">
              <label className="form-label">Confirm New Password</label>
              <div style={{ position: "relative" }}>
                <span style={{ position: "absolute", left: "14px", top: "14px", color: "var(--text-muted)" }}>
                  <Lock size={18} />
                </span>
                <input
                  type={showConfirmPassword ? "text" : "password"}
                  value={confirmPassword}
                  onChange={(e) => { setConfirmPassword(e.target.value); setValidationError(null); }}
                  placeholder="Re-enter new password"
                  className="form-input"
                  style={{ paddingLeft: "42px", paddingRight: "42px" }}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
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
                  title={showConfirmPassword ? "Hide password" : "Show password"}
                >
                  {showConfirmPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

            <button 
              type="submit" 
              className="btn-primary" 
              disabled={isLoading}
              style={{ width: "100%", justifyContent: "center", padding: "14px", marginTop: "12px", marginBottom: "16px" }}
            >
              {isLoading ? "Saving new password..." : "Update Password & Sign In"}
            </button>

            <button
              type="button"
              onClick={() => {
                setSearchParams({});
                setAuthMode("login");
                setValidationError(null);
                setStatusMsg(null);
              }}
              style={{
                width: "100%",
                background: "transparent",
                border: "1px solid var(--border-glass)",
                borderRadius: "var(--radius-md)",
                padding: "10px",
                color: "var(--text-secondary)",
                fontSize: "0.85rem",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "8px"
              }}
            >
              <ArrowLeft size={16} /> Cancel & Back to Login
            </button>
          </form>
        )}

        {/* ─── 3. LOGIN & REGISTER VIEW ──────────────────────────────────── */}
        {(authMode === "login" || authMode === "register") && (
          <form onSubmit={handleSubmit}>
            {authMode === "register" && (
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
              {authMode === "register" && (
                <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "6px", display: "flex", alignItems: "center", gap: "4px" }}>
                  <Info size={12} /> Requires 8+ chars, uppercase, lowercase, number & special char.
                </p>
              )}
            </div>

            {authMode === "register" && (
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

            {/* REMEMBER ME + FORGOT PASSWORD ROW */}
            {authMode === "login" && (
              <div style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: "24px",
                fontSize: "0.85rem"
              }}>
                <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", userSelect: "none" }}>
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

                {/* Forgot Password Button */}
                <button
                  type="button"
                  onClick={() => {
                    setAuthMode("forgot");
                    setForgotEmail(formData.email);
                    setValidationError(null);
                    setStatusMsg(null);
                  }}
                  style={{
                    background: "none",
                    border: "none",
                    color: "var(--primary)",
                    cursor: "pointer",
                    fontSize: "0.85rem",
                    fontWeight: 600,
                    padding: 0,
                    textDecoration: "underline",
                    transition: "var(--transition)"
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "var(--primary-hover, #818cf8)")}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "var(--primary)")}
                >
                  Forgot Password?
                </button>
              </div>
            )}

            <button 
              type="submit" 
              className="btn-primary" 
              disabled={isLoading}
              style={{ width: "100%", justifyContent: "center", padding: "14px" }}
            >
              {isLoading ? "Validating credentials..." : (authMode === "login" ? "Authenticate Gate" : "Register Organization")}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
