import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { Sun, Moon, Monitor } from "lucide-react";
import ChoiceMenu from "./ChoiceMenu";

const options = [
  {
    value: "system",
    label: "跟随系统",
    hint: "随系统外观自动切换",
    icon: <Monitor size={18} />,
  },
  {
    value: "light",
    label: "浅色",
    hint: "明亮清爽的工作空间",
    icon: <Sun size={18} />,
  },
  {
    value: "dark",
    label: "深色",
    hint: "柔和沉静的深色外观",
    icon: <Moon size={18} />,
  },
];
type Theme = "light" | "dark" | "system";
export default function ThemeControl() {
  const [theme, setTheme] = useState<Theme>(() => {
    const value = localStorage.getItem("filedesk-theme");
    return value === "light" || value === "dark" ? value : "system";
  });
  useEffect(() => {
    const query = matchMedia("(prefers-color-scheme: dark)");
    let alive = true;
    function apply() {
      const dark = theme === "system" ? query.matches : theme === "dark";
      document.documentElement.dataset.theme = dark ? "dark" : "light";
      if (isTauri())
        invoke("set_appearance", { dark })
          .then(() => {
            if (alive) document.documentElement.dataset.nativeGlass = "true";
          })
          .catch(() => {
            if (alive) delete document.documentElement.dataset.nativeGlass;
          });
    }
    apply();
    query.addEventListener("change", apply);
    localStorage.setItem("filedesk-theme", theme);
    return () => {
      alive = false;
      query.removeEventListener("change", apply);
    };
  }, [theme]);
  return (
    <ChoiceMenu
      value={theme}
      onChange={(v) => setTheme(v as Theme)}
      options={options}
      label="应用主题"
      heading="外观主题"
      showIcon
      triggerClass="theme-choice-trigger"
    />
  );
}
