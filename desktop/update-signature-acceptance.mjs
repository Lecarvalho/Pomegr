import { createHash } from "node:crypto";
import { execFile as defaultExecFile } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { minimalRuntimeEnvironment } from "./environment-policy.mjs";
import { createWindowsUpdateSignatureVerifier, isFullPublisherSubject } from "./updater.mjs";

const MAX_FIXTURE_BYTES = 512 * 1024 * 1024;
const INSPECTION_TIMEOUT_MS = 20_000;
const EXPECTED_RESULTS = Object.freeze(["accepted", "rejected-unsigned", "rejected-wrong-publisher"]);

async function hashFile(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

async function boundedRegularFile(filename) {
  let details;
  try { details = await lstat(filename); } catch { throw new Error("DESKTOP_UPDATE_ACCEPTANCE_FILE_INVALID"); }
  if (!details.isFile() || details.isSymbolicLink() || details.size <= 0 || details.size > MAX_FIXTURE_BYTES) {
    throw new Error("DESKTOP_UPDATE_ACCEPTANCE_FILE_INVALID");
  }
  return Object.freeze({ size: details.size, mtimeMs: details.mtimeMs });
}

export function inspectWindowsAuthenticode(filename, options = {}) {
  const execFile = options.execFile || defaultExecFile;
  const script = [
    "$signature = Get-AuthenticodeSignature -LiteralPath $env:THREADLIGHT_UPDATE_VERIFY_PATH",
    "[PSCustomObject]@{ Status = [string]$signature.Status; Subject = [string]$signature.SignerCertificate.Subject; Timestamped = $null -ne $signature.TimeStamperCertificate } | ConvertTo-Json -Compress",
  ].join("; ");
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-InputFormat", "None",
      "-Command", script,
    ], {
      encoding: "utf8",
      windowsHide: true,
      timeout: INSPECTION_TIMEOUT_MS,
      env: minimalRuntimeEnvironment(options.environment || process.env, { THREADLIGHT_UPDATE_VERIFY_PATH: filename }),
    }, (error, stdout, stderr) => {
      if (error || stderr) {
        reject(new Error("DESKTOP_UPDATE_ACCEPTANCE_INSPECTION_FAILED"));
        return;
      }
      try {
        const result = JSON.parse(stdout);
        resolve(Object.freeze({
          status: String(result?.Status || ""),
          subject: String(result?.Subject || ""),
          timestamped: result?.Timestamped === true,
        }));
      } catch {
        reject(new Error("DESKTOP_UPDATE_ACCEPTANCE_INSPECTION_FAILED"));
      }
    });
  });
}

function observedAcceptanceResult({ verification, inspection, publisherSubject }) {
  const subjectMatches = inspection.subject.toUpperCase() === publisherSubject.toUpperCase();
  if (verification === null && inspection.status === "Valid" && subjectMatches && inspection.timestamped) return "accepted";
  if (verification === "DESKTOP_UPDATE_SIGNATURE_INVALID"
    && inspection.status === "NotSigned"
    && inspection.subject === ""
    && !inspection.timestamped) return "rejected-unsigned";
  if (verification === "DESKTOP_UPDATE_SIGNATURE_INVALID"
    && inspection.status === "Valid"
    && isFullPublisherSubject(inspection.subject)
    && !subjectMatches
    && inspection.timestamped) return "rejected-wrong-publisher";
  return null;
}

export async function verifyUpdateSignatureAcceptance({
  filename,
  publisherSubject,
  expected,
  verifier = createWindowsUpdateSignatureVerifier(),
  inspectSignature = inspectWindowsAuthenticode,
}) {
  if (!path.isAbsolute(filename || "")) throw new Error("DESKTOP_UPDATE_ACCEPTANCE_FILE_INVALID");
  if (!isFullPublisherSubject(publisherSubject)) throw new Error("DESKTOP_UPDATE_ACCEPTANCE_PUBLISHER_INVALID");
  if (!EXPECTED_RESULTS.includes(expected)) throw new Error("DESKTOP_UPDATE_ACCEPTANCE_EXPECTATION_INVALID");

  const sourceBefore = await boundedRegularFile(filename);
  const sourceHash = await hashFile(filename);
  const stagingRoot = await mkdtemp(path.join(os.tmpdir(), "threadlight-signature-acceptance-"));
  const stagedFile = path.join(stagingRoot, "update-fixture.exe");
  try {
    await copyFile(filename, stagedFile, constants.COPYFILE_EXCL);
    await chmod(stagedFile, 0o400);
    const stagedBefore = await boundedRegularFile(stagedFile);
    const stagedHash = await hashFile(stagedFile);
    if (sourceBefore.size !== stagedBefore.size || sourceHash !== stagedHash) {
      throw new Error("DESKTOP_UPDATE_ACCEPTANCE_FILE_CHANGED");
    }

    const inspection = await inspectSignature(stagedFile);
    const verification = await verifier([publisherSubject], stagedFile);
    const stagedAfter = await boundedRegularFile(stagedFile);
    const stagedAfterHash = await hashFile(stagedFile);
    const sourceAfter = await boundedRegularFile(filename);
    const sourceAfterHash = await hashFile(filename);
    if (stagedBefore.size !== stagedAfter.size || stagedHash !== stagedAfterHash
      || sourceBefore.size !== sourceAfter.size || sourceBefore.mtimeMs !== sourceAfter.mtimeMs
      || sourceHash !== sourceAfterHash) {
      throw new Error("DESKTOP_UPDATE_ACCEPTANCE_FILE_CHANGED");
    }

    const observed = observedAcceptanceResult({ verification, inspection, publisherSubject });
    if (observed === null) throw new Error("DESKTOP_UPDATE_ACCEPTANCE_VERIFICATION_FAILED");
    if (observed !== expected) throw new Error("DESKTOP_UPDATE_ACCEPTANCE_RESULT_MISMATCH");
    return Object.freeze({ result: observed, sha256: stagedHash });
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

export function parseAcceptanceArguments(args) {
  if (!Array.isArray(args) || args.length !== 4) throw new Error("DESKTOP_UPDATE_ACCEPTANCE_ARGUMENTS_INVALID");
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!["--file", "--expect"].includes(name) || values.has(name) || typeof args[index + 1] !== "string") {
      throw new Error("DESKTOP_UPDATE_ACCEPTANCE_ARGUMENTS_INVALID");
    }
    values.set(name, args[index + 1]);
  }
  if (!values.has("--file") || !values.has("--expect")) throw new Error("DESKTOP_UPDATE_ACCEPTANCE_ARGUMENTS_INVALID");
  return Object.freeze({ filename: values.get("--file"), expected: values.get("--expect") });
}

async function runCli() {
  const parsed = parseAcceptanceArguments(process.argv.slice(2));
  const result = await verifyUpdateSignatureAcceptance({
    filename: path.resolve(parsed.filename),
    publisherSubject: process.env.WINDOWS_PUBLISHER_SUBJECT,
    expected: parsed.expected,
  });
  process.stdout.write(`Threadlight update signature acceptance: PASS (${result.result}; sha256 ${result.sha256})\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    const code = /^DESKTOP_UPDATE_ACCEPTANCE_[A-Z_]+$/.test(error?.message)
      ? error.message
      : "DESKTOP_UPDATE_ACCEPTANCE_FAILED";
    process.stderr.write(`Threadlight update signature acceptance: FAIL (${code})\n`);
    process.exitCode = 1;
  });
}
