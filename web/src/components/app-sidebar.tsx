import * as React from "react";
import { Link } from "react-router-dom";
import {
  GitBranchIcon,
  InboxIcon,
  LayoutDashboardIcon,
  ListIcon,
  LogOutIcon,
  RadioTowerIcon,
  Settings2Icon,
  SlidersHorizontalIcon,
  UserIcon,
} from "lucide-react";

import { NavMain, type NavItem } from "@/components/nav-main";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

const MONITORING: NavItem[] = [
  { title: "Dashboard", url: "/", icon: <LayoutDashboardIcon />, end: true },
  { title: "Inbox", url: "/inbox", icon: <InboxIcon /> },
  { title: "Postings", url: "/postings", icon: <ListIcon /> },
];

const PIPELINE: NavItem[] = [
  { title: "Workflow", url: "/workflow", icon: <GitBranchIcon /> },
  { title: "Sources", url: "/sources", icon: <RadioTowerIcon /> },
];

const CONFIGURATION: NavItem[] = [
  { title: "Profile", url: "/profile", icon: <UserIcon /> },
  { title: "Settings", url: "/settings", icon: <Settings2Icon /> },
];

export function AppSidebar({
  onLogout,
  ...props
}: React.ComponentProps<typeof Sidebar> & { onLogout: () => void }) {
  return (
    <Sidebar
      className="top-(--header-height) h-[calc(100svh-var(--header-height))]!"
      {...props}
    >
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link to="/" />}>
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <SlidersHorizontalIcon className="size-4" />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">Signal</span>
                <span className="truncate text-xs text-muted-foreground">Job posting notifier</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain label="Monitoring" items={MONITORING} />
        <NavMain label="Pipeline" items={PIPELINE} />
        <NavMain label="Configuration" items={CONFIGURATION} />
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Log out" onClick={onLogout}>
              <LogOutIcon />
              <span>Log out</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
