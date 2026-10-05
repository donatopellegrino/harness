// Account changes can happen in another tab or at the local OAuth callback,
// while this page is open through a different origin (for example, the tailnet).
const signature = status => JSON.stringify([Boolean(status?.connected), Boolean(status?.sharing), status?.email ?? null]);

export function accountSynchronizer({ readStatus, currentStatus, onChange, canSync = () => true }) {
  let checking = false;
  return async () => {
    if (checking || !canSync()) return;
    checking = true;
    try {
      const status = await readStatus();
      // A reply or settings action may have started during the request.
      if (canSync() && signature(status) !== signature(currentStatus())) await onChange();
    } finally { checking = false; }
  };
}
