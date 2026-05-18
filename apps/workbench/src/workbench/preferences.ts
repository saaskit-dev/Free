import { useEffect, useState } from "react";

import type { LanguageMode, SidebarState, ThemeMode, WorkbenchPreferences } from "../types";

const STORAGE_KEY = "free.workbench.preferences";

const defaultPreferences: WorkbenchPreferences = {
  sidebar: "expanded",
  language: "zh",
  theme: "system",
};

export function useWorkbenchPreferences() {
  const [preferences, setPreferences] = useState<WorkbenchPreferences>(defaultPreferences);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Partial<WorkbenchPreferences>;
      setPreferences({
        sidebar: readSidebar(parsed.sidebar),
        language: readLanguage(parsed.language),
        theme: readTheme(parsed.theme),
      });
    } catch {
      setPreferences(defaultPreferences);
    }
  }, []);

  function updatePreferences(next: Partial<WorkbenchPreferences>) {
    setPreferences((current) => {
      const value = {
        ...current,
        ...next,
      };
      if (typeof window !== "undefined") {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
      }
      return value;
    });
  }

  return {
    preferences,
    setSidebar: (sidebar: SidebarState) => updatePreferences({ sidebar }),
    setLanguage: (language: LanguageMode) => updatePreferences({ language }),
    setTheme: (theme: ThemeMode) => updatePreferences({ theme }),
  };
}

function readSidebar(value: unknown): SidebarState {
  return value === "collapsed" ? "collapsed" : "expanded";
}

function readLanguage(value: unknown): LanguageMode {
  return value === "en" ? "en" : "zh";
}

function readTheme(value: unknown): ThemeMode {
  if (value === "system") return "system";
  return value === "dark" ? "dark" : "light";
}

export function t(language: LanguageMode, zh: string, en: string): string {
  return language === "zh" ? zh : en;
}
