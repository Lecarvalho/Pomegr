/* eslint-disable @typescript-eslint/no-require-imports -- electron-builder v26 loads release config through CommonJS. */
const packageJson = require("../../package.json");
const path = require("node:path");

function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`DESKTOP_RELEASE_${name}_MISSING`);
  }
  return value.trim();
}

module.exports = {
  ...packageJson.build,
  forceCodeSigning: true,
  win: {
    ...packageJson.build.win,
    // These files are pinned by the terminal runtime's byte-for-byte manifest.
    signExts: [
      `!${path.join("terminal-runtime", "node.exe")}`,
      `!${path.join("terminal-runtime", "node_modules", "node-pty", "prebuilds", "win32-x64", "conpty", "OpenConsole.exe")}`,
    ],
    signtoolOptions: null,
    azureSignOptions: {
      publisherName: requiredEnvironment("WINDOWS_PUBLISHER_SUBJECT"),
      endpoint: requiredEnvironment("ARTIFACT_SIGNING_ENDPOINT"),
      codeSigningAccountName: requiredEnvironment("ARTIFACT_SIGNING_ACCOUNT_NAME"),
      certificateProfileName: requiredEnvironment("ARTIFACT_SIGNING_CERTIFICATE_PROFILE_NAME"),
      fileDigest: "SHA256",
      timestampRfc3161: "http://timestamp.acs.microsoft.com",
      timestampDigest: "SHA256",
    },
  },
};
