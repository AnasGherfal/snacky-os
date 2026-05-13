"use client";

import { useEffect, useState } from "react";

export function RouteCreatedToast() {
  const [message, setMessage] = useState("");

  useEffect(() => {
    const storedMessage = window.sessionStorage.getItem("snacky-route-created");
    if (!storedMessage) return;

    setMessage(storedMessage);
    window.sessionStorage.removeItem("snacky-route-created");
    const timeoutId = window.setTimeout(() => setMessage(""), 5000);

    return () => window.clearTimeout(timeoutId);
  }, []);

  if (!message) return null;

  return (
    <div className="fixed right-4 top-20 z-50 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800 shadow-lg" role="status">
      {message}
    </div>
  );
}
