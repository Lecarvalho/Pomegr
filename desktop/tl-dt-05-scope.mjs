export const TL_DT_05_PACKAGING_SCOPE = "TL-DT-08-signed-updates";

export function assertTlDt05PackagingScope(packageJson) {
  const build = packageJson?.build;
  if (build?.extraMetadata?.threadlightPackagingScope !== TL_DT_05_PACKAGING_SCOPE) {
    throw new Error("DESKTOP_TL_DT_05_SCOPE_REQUIRED");
  }
  const publish = build?.publish;
  if (!Array.isArray(publish) || publish.length !== 1
    || publish[0]?.provider !== "github"
    || publish[0]?.owner !== "Lecarvalho"
    || publish[0]?.repo !== "threadlight") throw new Error("DESKTOP_UPDATE_PUBLISH_INVALID");
  if (typeof packageJson?.dependencies?.["electron-updater"] !== "string") throw new Error("DESKTOP_UPDATER_DEPENDENCY_REQUIRED");
  if (build.electronUpdaterCompatibility !== ">=2.16") throw new Error("DESKTOP_UPDATE_METADATA_COMPATIBILITY_INVALID");
  if (build.win?.verifyUpdateCodeSignature !== true) throw new Error("DESKTOP_UPDATE_SIGNATURE_VERIFICATION_REQUIRED");
  if (build.win?.signtoolOptions?.publisherName !== "Leandro Carvalho") throw new Error("DESKTOP_UPDATE_PUBLISHER_INVALID");
  if (build.nsis?.differentialPackage !== true) throw new Error("DESKTOP_UPDATE_BLOCKMAP_REQUIRED");
  return true;
}
