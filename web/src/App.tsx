import { useState } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { getToken, setToken } from "./api";
import Layout from "./components/Layout";
import TokenGate from "./components/TokenGate";
import { ToastProvider } from "./components/Toast";
import Dashboard from "./pages/Dashboard";
import MatchesPage from "./pages/MatchesPage";
import Postings from "./pages/Postings";
import ProfilePage from "./pages/ProfilePage";
import SettingsPage from "./pages/SettingsPage";
import Sources from "./pages/Sources";

export default function App() {
  const [hasToken, setHasToken] = useState(Boolean(getToken()));

  if (!hasToken) return <TokenGate onReady={() => setHasToken(true)} />;

  return (
    <ToastProvider>
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
            <Route path="matches" element={<MatchesPage />} />
            <Route path="sources" element={<Sources />} />
            <Route path="postings" element={<Postings />} />
            <Route path="profile" element={<ProfilePage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ToastProvider>
  );
}
