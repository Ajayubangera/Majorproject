import { BrowserRouter as Router, Routes, Route, Navigate } from "react-router-dom";
import AuthPage from "./pages/Auth";
import Dashboard from "./pages/Dashboard";
import ProjectNew from "./pages/ProjectNew";
import ProjectSetup from "./pages/ProjectSetup";
import ProjectView from "./pages/ProjectView";
import { getSessionToken } from "./utils/auth";

// Protected Route Wrapper
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const token = getSessionToken();
  return token ? <>{children}</> : <Navigate to="/auth" replace />;
}

// Redirect Root to Dashboard or Auth
function RootRedirect() {
  const token = getSessionToken();
  return token ? <Navigate to="/dashboard" replace /> : <Navigate to="/auth" replace />;
}

export default function App() {
  return (
    <Router>
      <Routes>
        {/* Public auth route */}
        <Route path="/auth" element={<AuthPage />} />

        {/* Protected app routes */}
        <Route 
          path="/dashboard" 
          element={
            <ProtectedRoute>
              <Dashboard />
            </ProtectedRoute>
          } 
        />
        <Route 
          path="/projects/new" 
          element={
            <ProtectedRoute>
              <ProjectNew />
            </ProtectedRoute>
          } 
        />
        <Route 
          path="/project/:id/setup" 
          element={
            <ProtectedRoute>
              <ProjectSetup />
            </ProtectedRoute>
          } 
        />
        <Route 
          path="/project/:id/view" 
          element={
            <ProtectedRoute>
              <ProjectView />
            </ProtectedRoute>
          } 
        />

        {/* Default routes fallback */}
        <Route path="/" element={<RootRedirect />} />
        <Route path="*" element={<RootRedirect />} />
      </Routes>
    </Router>
  );
}
