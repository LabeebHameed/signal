import { NavLink, Outlet } from "react-router-dom";
import {
  DashboardIcon,
  MatchesIcon,
  PostingsIcon,
  ProfileIcon,
  SettingsIcon,
  SourcesIcon,
} from "../lib/icons";

const NAV_ITEMS = [
  { to: "/", label: "Dashboard", icon: DashboardIcon, end: true },
  { to: "/inbox", label: "Inbox", icon: MatchesIcon, end: false },
  { to: "/sources", label: "Sources", icon: SourcesIcon, end: false },
  { to: "/postings", label: "Postings", icon: PostingsIcon, end: false },
  { to: "/profile", label: "Profile", icon: ProfileIcon, end: false },
  { to: "/settings", label: "Settings", icon: SettingsIcon, end: false },
];

export default function Layout({ onLogout }: { onLogout: () => void }) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">S</span>
          <span className="brand-name">Signal</span>
        </div>
        <nav>
          {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}>
              <Icon />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <button className="secondary logout-btn" onClick={onLogout}>
          Log out
        </button>
      </aside>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
