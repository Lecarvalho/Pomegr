export function DesktopUpdateOffer({ version, installing, onInstall }: {
  version: string;
  installing: boolean;
  onInstall: () => void;
}) {
  return (
    <section className="desktopUpdateOffer">
      <p role="status" aria-live="polite" aria-atomic="true">
        {installing ? `Restarting Pomegr to update to v${version}` : `Pomegr v${version} is ready`}
      </p>
      <button
        type="button"
        disabled={installing}
        aria-label={installing
          ? `Restarting Pomegr to update to version ${version}`
          : `Restart Pomegr to update to version ${version}`}
        onClick={onInstall}
      >
        {installing ? "Restarting…" : "Restart to update"}
      </button>
    </section>
  );
}
