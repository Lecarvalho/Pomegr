export async function startMonitorAfterEnvironment(options) {
  if (options.smoke === true) {
    options.recordStage("MONITOR_GIT_CHECKING");
    await options.verifyGitExecution();
    options.recordStage("MONITOR_GIT_VERIFIED");
  }
  options.recordStage("MONITOR_STARTING");
  return options.startMonitor();
}
