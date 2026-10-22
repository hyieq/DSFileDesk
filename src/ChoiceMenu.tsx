import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";

export type ChoiceOption = {
  value: string;
  label: string;
  hint: string;
  icon: ReactNode;
};
export default function ChoiceMenu({
  value,
  onChange,
  options,
  label,
  heading,
  showIcon = false,
  triggerClass = "",
  disabled = false,
  placeholder = "请选择",
}: {
  value: string;
  onChange: (value: string) => void;
  options: ChoiceOption[];
  label: string;
  heading: string;
  showIcon?: boolean;
  triggerClass?: string;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const selected = options.findIndex((o) => o.value === value);
  const current = options[selected];
  useLayoutEffect(() => {
    if (!open) return;
    const r = trigger.current!.getBoundingClientRect();
    const h = menu.current!.offsetHeight;
    setPosition({
      left: Math.max(8, Math.min(r.right - 224, window.innerWidth - 232)),
      top:
        r.bottom + 8 + h <= window.innerHeight - 8
          ? r.bottom + 8
          : Math.max(8, r.top - h - 8),
    });
    menu.current
      ?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')
      [Math.max(0, selected)]?.focus({ preventScroll: true });
  }, [open, selected]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (
        !menu.current?.contains(e.target as Node) &&
        !trigger.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    const close = () => setOpen(false);
    const focus = (e: FocusEvent) => {
      if (
        !menu.current?.contains(e.target as Node) &&
        !trigger.current?.contains(e.target as Node)
      )
        close();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", focus);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", focus);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [open]);
  function choose(next: string) {
    onChange(next);
    setOpen(false);
    trigger.current?.focus();
  }
  return (
    <>
      <button
        ref={trigger}
        className={`thumbnail-trigger ${triggerClass} ${open ? "is-open" : ""}`}
        disabled={disabled || options.length === 0}
        aria-label={`${label}：${current?.label || placeholder}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(true);
          }
        }}
      >
        {showIcon && (
          <span className="choice-trigger-icon">{current?.icon}</span>
        )}
        <span>{current?.label || placeholder}</span>
        <ChevronDown size={13} />
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            id={menuId}
            role="menu"
            aria-label={label}
            className="thumbnail-menu"
            style={position}
            onKeyDown={(e) => {
              e.stopPropagation();
              const items = Array.from(
                menu.current!.querySelectorAll<HTMLButtonElement>(
                  '[role="menuitemradio"]',
                ),
              );
              const index = items.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              if (e.key === "Escape") {
                e.preventDefault();
                setOpen(false);
                trigger.current?.focus();
              } else if (
                ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)
              ) {
                e.preventDefault();
                const next =
                  e.key === "Home"
                    ? 0
                    : e.key === "End"
                      ? items.length - 1
                      : (index +
                          (e.key === "ArrowDown" ? 1 : -1) +
                          items.length) %
                        items.length;
                items[next]?.focus();
              } else if (e.key === "Tab") {
                setOpen(false);
                trigger.current?.focus();
              }
            }}
          >
            <div className="thumbnail-menu-heading">{heading}</div>
            {options.map((option) => (
              <button
                key={option.value}
                role="menuitemradio"
                aria-checked={option.value === value}
                className={`thumbnail-option ${option.value === value ? "is-selected" : ""}`}
                onClick={() => choose(option.value)}
              >
                <span className="thumbnail-option-icon">{option.icon}</span>
                <span className="thumbnail-option-text">
                  <strong>{option.label}</strong>
                  <small>{option.hint}</small>
                </span>
                {option.value === value && (
                  <Check
                    className="thumbnail-option-check"
                    size={16}
                    strokeWidth={2}
                  />
                )}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
