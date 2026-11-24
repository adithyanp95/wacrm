"use client";

import { useEffect } from "react";

function registerServiceWorker(): void {
  navigator.serviceWorker
    .register("/sw.js")
    .then((registration) => {
      console.log("[PWA] Service Worker registered with scope:", registration.scope);
    })
    .catch((error) => {
      console.warn("[PWA] Service Worker registration failed:", error);
    });
}

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    // This effect can run after the window `load` event has already
    // fired (hydration finishing late), in which case a `load` listener
    // never runs and the worker is never registered.
    if (document.readyState === "complete") {
      registerServiceWorker();
      return;
    }
    window.addEventListener("load", registerServiceWorker, { once: true });
    return () => window.removeEventListener("load", registerServiceWorker);
  }, []);

  return null;
}
