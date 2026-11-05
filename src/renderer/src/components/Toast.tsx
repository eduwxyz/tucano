import type { ReactNode } from "react";
import { L } from "../../../shared/lang";
import { dismissToast, holdToasts, useStore } from "../store";
import { Icon } from "./ui";

// Short notes at the bottom of the window: an action that didn't go through, and why.
// They go away on their own after a few seconds, unless someone is on them.
export function Toasts(): ReactNode {
  const toasts = useStore((s) => s.toasts);
  return (
    <div
      className="toasts"
      role="status"
      aria-live="polite"
      onPointerEnter={() => holdToasts(true)}
      onPointerLeave={() => holdToasts(false)}
      onFocus={() => holdToasts(true)}
      onBlur={(e) =>
        !e.currentTarget.contains(e.relatedTarget) && holdToasts(false)
      }
    >
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.leaving ? "is-leaving" : ""}`}>
          <span className="toast__text">{t.text}</span>
          <button
            className="icon-btn toast__close"
            aria-label={L("Fechar", "Close")}
            onClick={() => dismissToast(t.id)}
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

// The core's process ended: what's saved is safe, and reloading the page starts a new one.
export function CoreDown(): ReactNode {
  const down = useStore((s) => s.coreDown);
  if (!down) return null;
  return (
    <div className="core-down" role="alert">
      <span>
        {L(
          "O Tucano parou de funcionar. Seus agentes e conversas estão salvos.",
          "Tucano stopped working. Your agents and conversations are saved."
        )}
      </span>
      <button
        className="btn btn--primary btn--sm"
        onClick={() => location.reload()}
      >
        {L("Reabrir", "Reopen")}
      </button>
    </div>
  );
}
