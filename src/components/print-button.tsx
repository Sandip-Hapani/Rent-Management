"use client";

import { Button } from "./ui";

export function PrintButton() {
  return <Button variant="secondary" onClick={() => window.print()}>Print / PDF</Button>;
}
