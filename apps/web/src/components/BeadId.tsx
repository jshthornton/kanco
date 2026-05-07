import { useState } from "react";

interface Props {
  id: string;
  className?: string;
  stopPropagation?: boolean;
}

export function BeadId({ id, className, stopPropagation = true }: Props) {
  const [copied, setCopied] = useState(false);

  async function copy(e: React.MouseEvent) {
    if (stopPropagation) e.stopPropagation();
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore
    }
  }

  return (
    <code
      className={`bead-id-copy${className ? ` ${className}` : ""}${copied ? " copied" : ""}`}
      role="button"
      tabIndex={0}
      title={copied ? "copied!" : `copy ${id}`}
      onClick={copy}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          copy(e as unknown as React.MouseEvent);
        }
      }}
    >
      {id}
    </code>
  );
}
