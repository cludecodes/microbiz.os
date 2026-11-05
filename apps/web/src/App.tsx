import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import Landing from "./pages/Landing";
import Login from "./pages/Login";
import Register from "./pages/Register";
import DashboardLayout from "./pages/DashboardLayout";
import Home from "./pages/Home";
import Workspaces from "./pages/Workspaces";
import WorkspaceDetail from "./pages/WorkspaceDetail";
import Apps from "./pages/Apps";
import AppModule from "./pages/AppModule";
import CRM from "./pages/CRM";
import QRMenu from "./pages/QRMenu";
import PublicMenu from "./pages/PublicMenu";
import Settings from "./pages/Settings";
import Admin from "./pages/Admin";
import NotFound from "./pages/NotFound";
import { useAuth } from "./lib/authContext";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading, workspaces } = useAuth();
  const location = useLocation();
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-slate-500">
        <p>Loading…</p>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  // Failed-logout safety: never render protected content for logged-out users.
  return workspaces.length >= 0 ? children : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      {/* Public QR menu — behind the sticker, no auth (metered server-side). */}
      <Route path="/menu/:workspaceId" element={<PublicMenu />} />

      <Route
        path="/app"
        element={
          <RequireAuth>
            <DashboardLayout />
          </RequireAuth>
        }
      >
        <Route index element={<Home />} />
        <Route path="workspaces" element={<Workspaces />} />
        <Route path="workspaces/:workspaceId" element={<WorkspaceDetail />} />
        <Route path="apps" element={<Apps />} />
        {/* Phase 1 products get a full module page; others use the shell. */}
        <Route path="apps/whatsapp-crm" element={<CRM />} />
        <Route path="apps/qr-menu" element={<QRMenu />} />
        <Route path="apps/:appId" element={<AppModule />} />
        <Route path="settings" element={<Settings />} />
        <Route path="admin" element={<Admin />} />
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
