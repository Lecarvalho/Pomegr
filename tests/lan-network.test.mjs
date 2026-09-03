import assert from "node:assert/strict";
import test from "node:test";

import {
  createLanNetworkReader,
  isPrivateIPv4,
  resolveWindowsPowerShellExecutable,
} from "../desktop/lan-network.mjs";

function probe({ profiles = [], adapters = [], addresses = [] } = {}) {
  return JSON.stringify({ Profiles: profiles, Adapters: adapters, Addresses: addresses });
}

function privateWifi(index = 7, name = "Wi-Fi") {
  return {
    profiles: [{ InterfaceIndex: index, ProfileIdentity: `profile-${index}`, NetworkCategory: "Private", IPv4Connectivity: "Internet" }],
    adapters: [{ InterfaceIndex: index, Name: name, Status: "Up", HardwareInterface: true, MediaType: "Native 802.11" }],
    addresses: [{ InterfaceIndex: index, IPAddress: "192.168.50.12", PrefixLength: 24, AddressState: "Preferred", SkipAsSource: false }],
  };
}

function reader({ output = probe(privateWifi()), platform = "win32", now = () => 0, error = null, stderr = "", capture } = {}) {
  let calls = 0;
  const value = createLanNetworkReader({
    platform,
    environment: { SystemRoot: "C:\\Windows", PRIVATE_TOKEN: "MUST_NOT_PASS" },
    now,
    execFileFn(command, args, options, callback) {
      calls += 1;
      capture?.({ command, args, options });
      queueMicrotask(() => callback(error, output, stderr));
    },
  });
  return { reader: value, calls: () => calls };
}

test("Windows probe uses an absolute system PowerShell command with fixed bounded arguments", async () => {
  let call;
  const fixture = reader({ capture: (value) => { call = value; } });
  const state = await fixture.reader.read();
  assert.equal(state.status, "available");
  assert.deepEqual(state.candidates[0], {
    id: state.candidates[0].id,
    address: "192.168.50.12",
    subnetMask: "255.255.255.0",
    label: "Wi-Fi",
  });
  assert.match(state.candidates[0].id, /^lan-[A-Za-z0-9_-]{18}$/);
  assert.equal(call.command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(call.args.slice(0, 5), ["-NoLogo", "-NoProfile", "-NonInteractive", "-InputFormat", "None"]);
  assert.match(call.args.at(-1), /Get-NetConnectionProfile/);
  assert.match(call.args.at(-1), /Get-NetAdapter -Physical/);
  assert.match(call.args.at(-1), /ProfileIdentity/);
  assert.match(call.args.at(-1), /ProfileIdentity/);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.timeout, 3_000);
  assert.equal(call.options.maxBuffer, 64 * 1024);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.env.SystemRoot, "C:\\Windows");
  assert.equal(call.options.env.PRIVATE_TOKEN, undefined);
  assert.equal(JSON.stringify(call), JSON.stringify(call).replace(/MUST_NOT_PASS/g, ""));
});

test("reader accepts active private physical Wi-Fi or Ethernet IPv4 networks only", async () => {
  const ethernet = privateWifi(8, "Ethernet");
  ethernet.adapters[0].MediaType = "802.3";
  ethernet.addresses[0].IPAddress = "10.0.4.8";
  ethernet.addresses[0].PrefixLength = 16;
  const state = await reader({ output: probe(ethernet) }).reader.read();
  assert.deepEqual(state, {
    status: "available",
    candidates: [{ id: state.candidates[0].id, address: "10.0.4.8", subnetMask: "255.255.0.0", label: "Ethernet" }],
  });

  const localOnly = privateWifi();
  localOnly.profiles[0].IPv4Connectivity = "LocalNetwork";
  assert.equal((await reader({ output: probe(localOnly) }).reader.read()).status, "available");

  const subnetOnly = privateWifi();
  subnetOnly.profiles[0].IPv4Connectivity = "Subnet";
  assert.equal((await reader({ output: probe(subnetOnly) }).reader.read()).status, "available");

  const tunnelExcluded = privateWifi();
  tunnelExcluded.addresses.push({
    InterfaceIndex: 99, IPAddress: "100.64.0.1", PrefixLength: 32, AddressState: "Preferred", SkipAsSource: false,
  });
  assert.equal((await reader({ output: probe(tunnelExcluded) }).reader.read()).status, "available");

  for (const change of [
    (entry) => { entry.profiles[0].NetworkCategory = "DomainAuthenticated"; },
    (entry) => { entry.adapters[0].HardwareInterface = false; },
    (entry) => { entry.adapters[0].MediaType = "WAN"; },
    (entry) => { entry.adapters[0].Status = "Down"; },
    (entry) => { entry.addresses[0].IPAddress = "127.0.0.1"; },
  ]) {
    const input = privateWifi();
    change(input);
    assert.deepEqual(await reader({ output: probe(input) }).reader.read(), {
      status: "unavailable", candidates: [], reason: "no_eligible_network",
    });
  }

  const publicProfile = privateWifi();
  publicProfile.profiles[0].NetworkCategory = "Public";
  assert.deepEqual(await reader({ output: probe(publicProfile) }).reader.read(), {
    status: "unavailable", candidates: [], reason: "public_network",
  });
});

test("two eligible adapters are returned for explicit selection", async () => {
  const first = privateWifi(4, "Ethernet");
  const second = privateWifi(9, "Wi-Fi");
  second.addresses[0].IPAddress = "172.20.1.14";
  const state = await reader({ output: probe({
    profiles: [...first.profiles, ...second.profiles],
    adapters: [...first.adapters, ...second.adapters],
    addresses: [...first.addresses, ...second.addresses],
  }) }).reader.read();
  assert.equal(state.status, "ambiguous");
  assert.equal(state.candidates.length, 2);
  assert.deepEqual(new Set(state.candidates.map((candidate) => candidate.label)), new Set(["Ethernet", "Wi-Fi"]));
});

test("candidate identity changes when Windows reports a different private connection profile", async () => {
  const first = privateWifi();
  const second = privateWifi();
  second.profiles[0].ProfileIdentity = "profile-reconnected";
  const firstState = await reader({ output: probe(first) }).reader.read();
  const secondState = await reader({ output: probe(second) }).reader.read();
  assert.notEqual(firstState.candidates[0].id, secondState.candidates[0].id);
});

test("malformed, oversized, ambiguous, and unsafe address data fail closed", async () => {
  const malformed = [
    "{not-json}",
    JSON.stringify({ Profiles: {}, Adapters: [], Addresses: [] }),
    probe({ ...privateWifi(), addresses: [{ ...privateWifi().addresses[0], PrefixLength: 31 }] }),
    probe({ ...privateWifi(), addresses: [{ ...privateWifi().addresses[0], PrefixLength: 0 }] }),
    probe({ ...privateWifi(), addresses: [{ ...privateWifi().addresses[0], IPAddress: "192.168.1.999" }] }),
    probe({ ...privateWifi(), adapters: [{ ...privateWifi().adapters[0], Name: "Wi-Fi\nInjected" }] }),
    probe({ ...privateWifi(), profiles: [privateWifi().profiles[0], privateWifi().profiles[0]] }),
    probe({ ...privateWifi(), addresses: [privateWifi().addresses[0], { ...privateWifi().addresses[0], IPAddress: "192.168.50.13" }] }),
    "x".repeat((64 * 1024) + 1),
  ];
  for (const output of malformed) {
    assert.deepEqual(await reader({ output }).reader.read(), {
      status: "unavailable", candidates: [], reason: output === "{not-json}" || output.length > 64 * 1024 ? "probe_failed" : "invalid_result",
    });
  }
});

test("platform, process errors, stderr, and invalid system roots return bounded unavailable states", async () => {
  const unsupported = reader({ platform: "linux" });
  assert.deepEqual(await unsupported.reader.read(), { status: "unavailable", candidates: [], reason: "unsupported_platform" });
  assert.equal(unsupported.calls(), 0);
  assert.deepEqual(await reader({ error: new Error("PRIVATE_NATIVE_ERROR") }).reader.read(), { status: "unavailable", candidates: [], reason: "probe_failed" });
  assert.deepEqual(await reader({ stderr: "PRIVATE_STDERR" }).reader.read(), { status: "unavailable", candidates: [], reason: "probe_failed" });
  assert.equal(resolveWindowsPowerShellExecutable({ SystemRoot: "relative" }), null);
  assert.equal(resolveWindowsPowerShellExecutable({ WINDIR: "C:\\Windows" }), "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(resolveWindowsPowerShellExecutable({ SystemRoot: "relative", WINDIR: "D:\\Windows" }), "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
});

test("reader caches for two seconds, preserves values as received, and singleflights concurrent probes", async () => {
  let clock = 100;
  let callback;
  let calls = 0;
  const lanReader = createLanNetworkReader({
    platform: "win32",
    environment: { SystemRoot: "C:\\Windows" },
    now: () => clock,
    execFileFn(_command, _args, _options, next) { calls += 1; callback = next; },
  });
  const first = lanReader.read();
  const second = lanReader.read();
  assert.equal(calls, 1);
  callback(null, probe(privateWifi()), "");
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one, two);
  clock = 2_099;
  assert.equal(await lanReader.read(), one);
  assert.equal(calls, 1);
  clock = 2_101;
  const third = lanReader.read();
  assert.equal(calls, 2);
  callback(null, probe(privateWifi()), "");
  assert.deepEqual(await third, one);
  const forced = lanReader.read({ force: true });
  assert.equal(calls, 3);
  callback(null, probe(privateWifi()), "");
  await forced;
});

test("IPv4 privacy rejects public and link-local addresses", () => {
  assert.equal(isPrivateIPv4("10.1.2.3"), true);
  assert.equal(isPrivateIPv4("172.16.0.1"), true);
  assert.equal(isPrivateIPv4("172.32.0.1"), false);
  assert.equal(isPrivateIPv4("192.168.1.1"), true);
  assert.equal(isPrivateIPv4("169.254.1.1"), false);
});
