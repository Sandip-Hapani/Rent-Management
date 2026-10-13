"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";
import clsx from "clsx";

/**
 * Table wrapper that never scrolls sideways. When the table doesn't fit its container (phones,
 * tablets, narrow cards) it switches to a stacked "label: value" card list (`.rt-stack` in
 * globals.css); otherwise it stays a normal table. Below 640px the stacked layout also applies
 * before JavaScript runs. Each cell gets a data-label copied from its column header unless the
 * server already rendered one.
 */
export function ResponsiveTable({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const label = () => {
      for (const table of root.querySelectorAll("table")) {
        const heads = [...table.querySelectorAll("thead th")].map((th) => th.textContent?.trim() ?? "");
        for (const tr of table.querySelectorAll("tbody tr")) {
          let col = 0;
          for (const td of tr.querySelectorAll(":scope > td")) {
            if (!td.hasAttribute("data-label")) td.setAttribute("data-label", heads[col] ?? "");
            col += (td as HTMLTableCellElement).colSpan || 1;
          }
        }
      }
    };
    const fit = () => {
      const table = root.querySelector("table");
      if (!table) return;
      // Measure the natural table width, then decide whether to stack.
      root.classList.remove("rt-stack");
      const overflows = table.scrollWidth > root.clientWidth + 1;
      root.classList.toggle("rt-stack", overflows);
    };
    label();
    fit();
    const resize = new ResizeObserver(fit);
    resize.observe(root);
    // Rows can change after client updates (filters, month selection).
    const mutations = new MutationObserver(() => {
      label();
      fit();
    });
    mutations.observe(root, { childList: true, subtree: true });
    return () => {
      resize.disconnect();
      mutations.disconnect();
    };
  }, []);
  return (
    <div ref={ref} className={clsx("rt", className)}>
      {children}
    </div>
  );
}
