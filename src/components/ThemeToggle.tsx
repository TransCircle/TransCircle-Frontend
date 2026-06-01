import { useCallback, useRef } from "react";
import { useTranslation } from 'react-i18next';
import { useTheme } from "../context/useTheme";
import type { Theme } from "../context/useTheme";
import styles from "./ThemeToggle.module.css";

const SunIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2" />
    <path d="M12 20v2" />
    <path d="m4.93 4.93 1.41 1.41" />
    <path d="m17.66 17.66 1.41 1.41" />
    <path d="M2 12h2" />
    <path d="M20 12h2" />
    <path d="m6.34 17.66-1.41 1.41" />
    <path d="m19.07 4.93-1.41 1.41" />
  </svg>
);

const MoonIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401" />
  </svg>
);

const ContrastIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <circle cx="12" cy="12" r="10" />
    <path d="M12 18a6 6 0 0 0 0-12v12z" />
  </svg>
);

const THEME_KEYS: { id: Theme; i18nKey: string; icon: React.FC }[] = [
  { id: "light", i18nKey: "theme.light", icon: SunIcon },
  { id: "dark", i18nKey: "theme.dark", icon: MoonIcon },
  { id: "contrast", i18nKey: "theme.contrast", icon: ContrastIcon },
];

interface ThemeToggleProps {
  className?: string;
}

export const ThemeToggle = ({ className = "" }: ThemeToggleProps) => {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  const radioRefs = useRef<HTMLButtonElement[]>([]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
      const { key } = event;
      let nextIndex: number;

      switch (key) {
        case "ArrowLeft":
        case "ArrowUp":
          event.preventDefault();
          nextIndex = index > 0 ? index - 1 : THEME_KEYS.length - 1;
          break;
        case "ArrowRight":
        case "ArrowDown":
          event.preventDefault();
          nextIndex = index < THEME_KEYS.length - 1 ? index + 1 : 0;
          break;
        case "Home":
          event.preventDefault();
          nextIndex = 0;
          break;
        case "End":
          event.preventDefault();
          nextIndex = THEME_KEYS.length - 1;
          break;
        default:
          return;
      }

      setTheme(THEME_KEYS[nextIndex]!.id);
      radioRefs.current[nextIndex]?.focus();
    },
    [setTheme]
  );

  return (
    <div
      className={`${styles.toggleGroup} ${className}`.trim()}
      role="radiogroup"
      aria-label={t('theme.selectLabel')}
    >
      {THEME_KEYS.map(({ id, i18nKey, icon: Icon }, index) => {
        const isActive = theme === id;
        return (
          <button
            key={id}
            ref={(el) => {
              if (el) radioRefs.current[index] = el;
            }}
            type="button"
            role="radio"
            className={`${styles.toggleBtn} ${isActive ? styles.active : ""}`}
            onClick={() => setTheme(id)}
            onKeyDown={(e) => handleKeyDown(e, index)}
            aria-label={t(i18nKey)}
            aria-checked={isActive}
            tabIndex={isActive ? 0 : -1}
          >
            <Icon />
          </button>
        );
      })}
    </div>
  );
};
