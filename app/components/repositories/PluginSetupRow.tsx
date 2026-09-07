import type { RepositoryProviderInventory } from "../../../shared/monitor-contract";
import type { RepositoryPluginAction } from "../../../shared/repository-plugin-contract";
import { pluginDetail, pluginStatus, versionLabel, type ProviderFeedback } from "./repository-setup-details";
import { RepositoryRow } from "./RepositoryRow";

export function PluginSetupRow({ provider, desktop, actionRunning, feedback, onAction }: {
  provider: RepositoryProviderInventory;
  desktop: boolean;
  actionRunning: boolean;
  feedback: ProviderFeedback | null;
  onAction: (action: RepositoryPluginAction) => void;
}) {
  const setup = provider.pluginSetup;
  const state = pluginStatus(setup);
  const version = versionLabel(setup?.version || null);
  const installed = setup?.readiness === "ready" && setup.installation === "installed";
  const available = installed && setup.update.status === "available";
  const scope = setup?.scope ? `${setup.scope[0].toUpperCase()}${setup.scope.slice(1)} installation` : "Local installation";
  return <RepositoryRow title="Pomegr plugin" label={state.label} tone={state.tone === "ready" ? "positive" : state.tone === "warning" ? "warning" : "neutral"}
    detail={<>{version && <><code>{version}</code> · </>}{available ? <>{scope} · <span className="repositoryUpdateAvailable">{versionLabel(setup.update.version) || "Update"} available</span></> : pluginDetail(setup)}</>}
    feedback={feedback}
    actions={desktop ? <>
      <button type="button" className="commandQuietAction" disabled={actionRunning} onClick={() => onAction("recheck")}>Recheck</button>
      {setup?.canUpdate ? <button type="button" className="commandPrimaryAction" disabled={actionRunning} onClick={() => onAction("update")}>Update plugin</button> : setup?.canInstall && <button type="button" className="commandPrimaryAction" disabled={actionRunning} onClick={() => onAction("install")}>Install plugin</button>}
    </> : <details className="repositorySetupInstructions"><summary>View setup instructions</summary><p>{provider.source === "Codex" ? "Add the Pomegr marketplace and plugin in Codex, then restart and review its hooks." : "Add the Pomegr marketplace and plugin in Claude Code, choose Project scope, then reload plugins."} <a className="commandTextLink" href="https://github.com/Lecarvalho/pomegr/blob/main/docs/PLUGINS.md">Read the plugin instructions</a>.</p></details>} />;
}
