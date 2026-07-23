import { NavLink, Outlet, useLocation } from "react-router-dom";
import {
  DashboardIcon,
  MatchesIcon,
  PostingsIcon,
  ProfileIcon,
  SettingsIcon,
  SourcesIcon,
  WorkflowIcon,
} from "../lib/icons";

const NAV_ITEMS = [
  { to: "/", label: "Dashboard", icon: DashboardIcon, end: true },
  { to: "/inbox", label: "Inbox", icon: MatchesIcon, end: false },
  { to: "/workflow", label: "Workflow", icon: WorkflowIcon, end: false },
  { to: "/sources", label: "Sources", icon: SourcesIcon, end: false },
  { to: "/postings", label: "Postings", icon: PostingsIcon, end: false },
  { to: "/profile", label: "Profile", icon: ProfileIcon, end: false },
  { to: "/settings", label: "Settings", icon: SettingsIcon, end: false },
];

export default function Layout({ onLogout }: { onLogout: () => void }) {
  // The Workflow page's graph + sidebar split needs more room than the
  // standard reading-width pages, so it opts into a wider content column.
  const isWorkflow = useLocation().pathname === "/workflow";
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
      <main className={`content${isWorkflow ? " content-wide" : ""}`}>
        <Outlet />
      </main>
    </div>
  );
}
