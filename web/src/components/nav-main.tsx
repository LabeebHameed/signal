import { ReactNode } from "react";
import { NavLink } from "react-router-dom";

import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";

export interface NavItem {
  title: string;
  url: string;
  icon: ReactNode;
  /** Match this route only on an exact path (used for the "/" index route). */
  end?: boolean;
}

/**
 * A flat group of sidebar links. sidebar-16 ships these as collapsible
 * sections with sub-items; Signal's routes are all one level deep, so the
 * collapsible/dropdown layer is dropped and each entry links straight to its
 * route.
 */
export function NavMain({ label, items }: { label: string; items: NavItem[] }) {
  const { isMobile, setOpenMobile } = useSidebar();

  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item) => (
          <SidebarMenuItem key={item.url}>
            <NavLink to={item.url} end={item.end} onClick={() => isMobile && setOpenMobile(false)}>
              {({ isActive }) => (
                <SidebarMenuButton tooltip={item.title} isActive={isActive} render={<span />}>
                  {item.icon}
                  <span>{item.title}</span>
                </SidebarMenuButton>
              )}
            </NavLink>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}
