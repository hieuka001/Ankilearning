import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Detects when a new service-worker version is installed and waiting, so the
 * UI can offer a "Có phiên bản mới — Tải lại ngay" prompt instead of silently
 * running stale code.
 *
 * The registration itself lives in main.tsx; this hook only attaches to the
 * existing registration via navigator.serviceWorker. The waiting worker is
 * only surfaced when an older worker already controls the page — on the very
 * first install there is no controller, so no prompt is ever shown then.
 *
 * Applying the update posts {type: 'SKIP_WAITING'} to the waiting worker
 * (handled in public/sw.js); once it takes over, `controllerchange` fires
 * and the page reloads onto the new version.
 */

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000; // re-check every hour

export interface ServiceWorkerUpdate {
  /** A new version is waiting and the prompt has not been dismissed. */
  updateAvailable: boolean;
  /** Activate the waiting worker; the page reloads on controllerchange. */
  applyUpdate: () => void;
  /** Hide the prompt for the rest of this page session. */
  dismiss: () => void;
}

export function useServiceWorkerUpdate(): ServiceWorkerUpdate {
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const updateRequestedRef = useRef(false);
  const reloadingRef = useRef(false);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return undefined;

    let cancelled = false;

    const trackInstalling = (worker: ServiceWorker | null) => {
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        // 'installed' + an existing controller means this worker is the new
        // version waiting to take over. On first install controller is null
        // and this branch never fires a prompt.
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          setWaitingWorker(worker);
        }
      });
    };

    navigator.serviceWorker
      .getRegistration()
      .then((registration) => {
        if (cancelled || !registration) return;
        registrationRef.current = registration;

        // An update may already be waiting from a previous session.
        if (registration.waiting && navigator.serviceWorker.controller) {
          setWaitingWorker(registration.waiting);
        }
        trackInstalling(registration.installing);
        registration.addEventListener('updatefound', () => {
          trackInstalling(registration.installing);
        });
      })
      .catch(() => undefined);

    const onControllerChange = () => {
      // Only reload when the user pressed "Tải lại ngay" in this tab. A
      // controller change can also happen on first install (initial claim)
      // or because another tab applied the update — neither should yank
      // this page into a reload.
      if (!updateRequestedRef.current || reloadingRef.current) return;
      reloadingRef.current = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

    // Periodically look for new versions while the tab is open, and again
    // when the user returns to the tab after at least an hour away.
    let lastCheckAt = Date.now();
    const checkForUpdate = () => {
      lastCheckAt = Date.now();
      registrationRef.current?.update().catch(() => undefined);
    };
    const intervalId = window.setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (
        document.visibilityState === 'visible' &&
        Date.now() - lastCheckAt >= UPDATE_CHECK_INTERVAL_MS
      ) {
        checkForUpdate();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  const applyUpdate = useCallback(() => {
    const worker = waitingWorker ?? registrationRef.current?.waiting ?? null;
    if (!worker) {
      // No waiting worker (should not happen when the prompt is visible):
      // fall back to a plain reload, which picks up fresh HTML anyway.
      window.location.reload();
      return;
    }
    updateRequestedRef.current = true;
    worker.postMessage({ type: 'SKIP_WAITING' });
  }, [waitingWorker]);

  const dismiss = useCallback(() => setDismissed(true), []);

  return {
    updateAvailable: waitingWorker !== null && !dismissed,
    applyUpdate,
    dismiss,
  };
}
