import { Outlet } from "react-router-dom";

import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";

/**
 * The sidebar-16 shell: a full-width sticky header with the sidebar docked
 * beneath it, and every route rendered inside the inset.
 */
export default function Layout({ onLogout }: { onLogout: () => void }) {
  return (
    <div className="[--header-height:calc(--spacing(14))]">
      <SidebarProvider className="flex flex-col">
        <SiteHeader />
        <div className="flex flex-1">
          <AppSidebar onLogout={onLogout} />
          <SidebarInset className="min-w-0">
            <Outlet />
          </SidebarInset>
        </div>
      </SidebarProvider>
    </div>
  );
}
