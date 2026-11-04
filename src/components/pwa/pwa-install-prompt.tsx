"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { Bell, Check, Download, Share, X, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{
    outcome: "accepted" | "dismissed";
    platform: string;
  }>;
  prompt(): Promise<void>;
}

const STORAGE_KEY = "wasenda:pwa-dismissed";
const DISMISS_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function PwaInstallPrompt() {
  const t = useTranslations("Pwa");
  const [showPrompt, setShowPrompt] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    // 1. Don't show if already running in standalone PWA mode
    const isStandalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;

    if (isStandalone) return;

    // 2. Check dismissal snooze
    try {
      const dismissedAt = localStorage.getItem(STORAGE_KEY);
      if (dismissedAt) {
        const timePassed = Date.now() - Number(dismissedAt);
        if (timePassed < DISMISS_SNOOZE_MS) return;
      }
    } catch (_e) {
      // localStorage disabled or unavailable
    }

    // 3. Detect iOS Safari
    const userAgent = window.navigator.userAgent.toLowerCase();
    const isIOSDevice =
      /iphone|ipad|ipod/.test(userAgent) &&
      !(window as unknown as { MSStream?: unknown }).MSStream;
    const isSafari =
      isIOSDevice && /webkit/.test(userAgent) && !/crios|fxios|opios/.test(userAgent);

    if (isSafari) {
      // Delay prompt slightly so page finishes rendering
      const timer = setTimeout(() => {
        setIsIOS(true);
        setShowPrompt(true);
      }, 2500);
      return () => clearTimeout(timer);
    }

    // 4. Chromium / Android / Edge: listen for beforeinstallprompt
    const handleBeforeInstall = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setShowPrompt(true);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstall);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstall);
    };
  }, []);

  const handleDismiss = () => {
    try {
      localStorage.setItem(STORAGE_KEY, Date.now().toString());
    } catch (_e) {
      // Ignore
    }
    setShowPrompt(false);
  };

  const handleInstall = async () => {
    if (!deferredPrompt) {
      handleDismiss();
      return;
    }

    try {
      await deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      if (choice.outcome === "accepted") {
        setShowPrompt(false);
      }
    } catch (err) {
      console.warn("[PWA] Installation prompt error:", err);
    } finally {
      setDeferredPrompt(null);
    }
  };

  if (!showPrompt) return null;

  return (
    <div className="fixed bottom-4 left-4 right-4 z-50 sm:bottom-6 sm:left-auto sm:right-6 sm:w-96 animate-in fade-in slide-in-from-bottom-5 duration-300">
      <div className="relative rounded-2xl border border-primary/20 bg-card/95 p-5 shadow-2xl backdrop-blur-md">
        {/* Close Button */}
        <button
          type="button"
          onClick={handleDismiss}
          className="absolute right-3.5 top-3.5 rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="flex items-start gap-3.5">
          {/* App Logo */}
          <div className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-background/80 p-1.5 shadow-sm">
            <Image
              src="/icons/icon-192.png"
              alt="WASenda"
              width={40}
              height={40}
              className="object-contain"
            />
          </div>

          <div className="flex-1 pr-4">
            <h3 className="text-sm font-semibold text-foreground tracking-tight">
              {t("installTitle")}
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground leading-relaxed">
              {t("installDescription")}
            </p>
          </div>
        </div>

        {/* Feature Highlights */}
        <div className="mt-3.5 space-y-1.5 rounded-lg bg-muted/40 p-2.5 text-xs text-muted-foreground">
          <div className="flex items-center gap-2 text-foreground font-medium">
            <Zap className="h-3.5 w-3.5 text-primary shrink-0" />
            <span>{t("featureInstant")}</span>
          </div>
          <div className="flex items-center gap-2">
            <Bell className="h-3.5 w-3.5 text-primary shrink-0" />
            <span>{t("featureNotifications")}</span>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="mt-4">
          {isIOS ? (
            <div className="space-y-2">
              <div className="flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/10 p-2.5 text-xs text-foreground">
                <Share className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                <span>{t("iosInstructions")}</span>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full text-xs"
                onClick={handleDismiss}
              >
                <Check className="mr-1.5 h-3.5 w-3.5" />
                Got it
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                className="flex-1 text-xs font-semibold bg-primary text-primary-foreground hover:bg-primary/90"
                onClick={handleInstall}
              >
                <Download className="mr-1.5 h-3.5 w-3.5" />
                {t("installButton")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={handleDismiss}
              >
                {t("laterButton")}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
