export function SessionCommandBar({ connected, connecting }: {
  connected: boolean;
  connecting: boolean;
}) {
  const status = connecting ? "Connecting to monitor" : "Monitor offline";
  const statusTone = connecting ? "connecting" : "offline";
  const showConnection = connecting || !connected;
  if (!showConnection) return null;
  return (
    <div className="commandSessionBar" aria-label="Session controls">
      <span className={`commandSessionConnection ${statusTone}`} aria-label={`Session state: ${status}`}><i />{status}</span>
    </div>
  );
}
