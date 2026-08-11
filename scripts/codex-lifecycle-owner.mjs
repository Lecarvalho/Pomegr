import { CODEX_BRIDGE_HEARTBEAT_MS, renewCodexOwnerLease } from "../monitor/providers/codex-liveness.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const options = {
  root: argument("--root"),
  ownerPid: Number(argument("--pid")),
  ownerStartedAt: argument("--started-at"),
  bridgeInstance: argument("--instance"),
};

function heartbeat() {
  try {
    if (renewCodexOwnerLease(options)) return;
  } catch {
    // Lease expiry is the fail-closed behavior.
  }
  process.exit(0);
}

heartbeat();
setInterval(heartbeat, CODEX_BRIDGE_HEARTBEAT_MS);
