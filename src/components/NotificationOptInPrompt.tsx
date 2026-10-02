"use client";

import { usePathname } from "next/navigation";
import { NotificationActivationCard } from "@/components/NotificationActivationCard";
import { notificationPromptRouteAllowed } from "@/lib/notification-prompt";

export function NotificationOptInPrompt({ userId }: { userId: string }) {
  const pathname = usePathname();
  // Account and Notifications already have the full device settings card.
  if (!notificationPromptRouteAllowed(pathname)) return null;
  // Remount on identity changes so one user's state never leaks into another's.
  return <NotificationActivationCard key={userId} autoPromptFor={userId} />;
}
