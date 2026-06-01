"use client";

import { useState, useRef, useEffect } from "react";

export function InfoTooltip({ text, position = "below" }: {
  text: string;
  position?: "below" | "above";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} className="relative inline-flex items-center shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-4 h-4 rounded-full bg-blue-500 text-white text-[10px] font-bold flex items-center justify-center hover:bg-blue-600 transition-colors leading-none select-none"
        aria-label="Info"
      >
        ?
      </button>
      {open && (
        <div
          className={`absolute left-0 z-50 w-56 rounded-xl bg-gray-800 text-white text-xs leading-relaxed p-3 shadow-xl ${
            position === "above" ? "bottom-6" : "top-6"
          }`}
        >
          {text}
          <div
            className={`absolute left-1.5 w-2 h-2 bg-gray-800 rotate-45 ${
              position === "above" ? "bottom-[-4px]" : "top-[-4px]"
            }`}
          />
        </div>
      )}
    </div>
  );
}
