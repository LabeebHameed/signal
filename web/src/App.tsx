import { useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { getToken, setToken } from "./api";
import { ConfirmDialogProvider } from "./components/ConfirmDialog";
import Layout from "./components/Layout";
import TokenGate from "./components/TokenGate";
import { ToastProvider } from "./components/Toast";
import { TooltipProvider } from "./components/ui/tooltip";
import Dashboard from "./pages/Dashboard";
import InboxPage from "./pages/InboxPage";
import Postings from "./pages/Postings";
import ProfilePage from "./pages/ProfilePage";
import SettingsPage from "./pages/SettingsPage";
import Sources from "./pages/Sources";
import Workflow from "./pages/Workflow";

export default function App() {
  const [hasToken, setHasToken] = useState(Boolean(getToken()));

  if (!hasToken) return <TokenGate onReady={() => setHasToken(true)} />;

  return (
    <TooltipProvider>
      <ToastProvider>
        <ConfirmDialogProvider>
          <BrowserRouter>
            <Routes>
              <Route
                element={
                  <Layout
                    onLogout={() => {
                      setToken("");
                      setHasToken(false);
                    }}
                  />
                }
              >
                <Route index element={<Dashboard />} />
                <Route path="inbox" element={<InboxPage />} />
                <Route path="matches" element={<Navigate to="/inbox" replace />} />
                <Route path="workflow" element={<Workflow />} />
                <Route path="sources" element={<Sources />} />
                <Route path="postings" element={<Postings />} />
                <Route path="profile" element={<ProfilePage />} />
                <Route path="settings" element={<SettingsPage />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </ConfirmDialogProvider>
      </ToastProvider>
    </TooltipProvider>
  );
}
