export const TL_DT_05_PACKAGING_SCOPE = "TL-DT-05-no-updater";

export function assertTlDt05PackagingScope(packageJson) {
  const build = packageJson?.build;
  if (build?.extraMetadata?.threadlightPackagingScope !== TL_DT_05_PACKAGING_SCOPE) {
    throw new Error("DESKTOP_TL_DT_05_SCOPE_REQUIRED");
  }
  if (build.publish !== undefined && build.publish !== null) {
    throw new Error("DESKTOP_TL_DT_05_PUBLISH_FORBIDDEN");
  }
  if (packageJson?.dependencies?.["electron-updater"] || packageJson?.devDependencies?.["electron-updater"]) {
    throw new Error("DESKTOP_TL_DT_05_UPDATER_FORBIDDEN");
  }
  return true;
}
