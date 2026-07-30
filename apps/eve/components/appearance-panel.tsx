"use client";

import { Switch } from "@cloudflare/kumo";
import { useEffect, useState } from "react";

const COLOR_MODE_KEY = "eve-color-mode";

type ColorMode = "light" | "dark";

const THEME_COLORS: Record<ColorMode, string> = {
  light: "#fbfbfb",
  dark: "#111111",
};

function currentMode(): ColorMode {
  return document.documentElement.dataset.mode === "light" ? "light" : "dark";
}

function applyMode(mode: ColorMode, persist = true) {
  document.documentElement.dataset.mode = mode;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", THEME_COLORS[mode]);
  if (!persist) return;
  try {
    localStorage.setItem(COLOR_MODE_KEY, mode);
  } catch {
    // The current page still changes if the browser blocks local storage.
  }
}

export function AppearancePanel() {
  const [darkMode, setDarkMode] = useState(() => currentMode() === "dark");

  useEffect(() => {
    function syncMode(event: StorageEvent) {
      if (event.key !== COLOR_MODE_KEY) return;
      const mode = event.newValue === "light" ? "light" : "dark";
      applyMode(mode, false);
      setDarkMode(mode === "dark");
    }

    window.addEventListener("storage", syncMode);
    return () => window.removeEventListener("storage", syncMode);
  }, []);

  function changeMode(checked: boolean) {
    const mode = checked ? "dark" : "light";
    applyMode(mode);
    setDarkMode(checked);
  }

  return (
    <section aria-labelledby="color-theme-heading">
      <h2 id="color-theme-heading" className="mb-1 text-balance text-sm font-medium">
        Color theme
      </h2>
      <p className="mb-4 text-pretty text-sm text-kumo-subtle">
        Choose how the app looks on this device.
      </p>
      <div className="rounded-lg border border-kumo-hairline bg-kumo-elevated p-4">
        <Switch
          checked={darkMode}
          onCheckedChange={changeMode}
          controlFirst
          label={
            <span>
              <span className="block text-sm font-medium">Dark mode</span>
              <span className="mt-0.5 block text-pretty text-xs font-normal text-kumo-subtle">
                Use the darker color palette throughout chat and settings.
              </span>
            </span>
          }
        />
      </div>
    </section>
  );
}
