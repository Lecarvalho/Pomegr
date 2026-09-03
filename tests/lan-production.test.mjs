import assert from "node:assert/strict";
import test from "node:test";
import { startLanProductionFixture } from "./helpers/lan-production-fixture.mjs";

async function fixtureJson(origin, path, body) {
  const response = await fetch(`${origin}${path}`, body === undefined ? undefined : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, value: await response.json() };
}

async function pairGateway(pairing) {
  const url = new URL(pairing.url);
  const response = await fetch(`${url.origin}/__pomegr/pair`, {
    method: "POST",
    headers: { Origin: url.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ secret: url.hash.slice(1) }),
  });
  assert.equal(response.status, 204);
  return response.headers.get("set-cookie")?.split(";", 1)[0] || "";
}

test("the loopback fixture drives real production web through authenticated LAN sharing", async (context) => {
  const fixture = await startLanProductionFixture();
  context.after(() => fixture.close());

  const before = await fixtureJson(fixture.previewOrigin, "/__fixture/state");
  assert.equal(before.response.status, 200);
  assert.equal(before.value.status, "off");
  assert.deepEqual(before.value.candidates, [{ id: "fixture-loopback-network", label: "Test network (simulated)", address: "127.0.0.1" }]);

  const sharing = await fixtureJson(fixture.previewOrigin, "/__fixture/sharing", { enabled: true });
  assert.equal(sharing.value.status, "sharing");
  assert.match(sharing.value.address, /^http:\/\/127\.0\.0\.1:/);
  const pairing = await fixtureJson(fixture.previewOrigin, "/__fixture/pair", {});
  assert.equal(pairing.response.status, 200);
  assert.match(pairing.value.url, /^http:\/\/127\.0\.0\.1:/);
  const cookie = await pairGateway(pairing.value);
  assert.match(cookie, /^pomegr_lan_[A-Za-z0-9_-]+=/);
  const gatewayOrigin = new URL(pairing.value.url).origin;

  const home = await fetch(gatewayOrigin, { headers: { Cookie: cookie, Accept: "text/html" } });
  assert.equal(home.status, 200);
  const markup = await home.text();
  assert.match(markup, /Pomegr/);
  assert.doesNotMatch(markup, /fixture_production_web_authorization/);
  const assets = [...markup.matchAll(/(?:src|href)="(\/assets\/[A-Za-z0-9._/-]+)"/g)].map((match) => match[1]);
  assert.ok(assets.length > 0, "production HTML references its built assets");
  assert.equal((await fetch(`${gatewayOrigin}${assets[0]}`, { headers: { Cookie: cookie } })).status, 200);
  const brand = await fetch(`${gatewayOrigin}/favicon.png`, { headers: { Cookie: cookie } });
  assert.equal(brand.status, 200);
  assert.match(brand.headers.get("content-type") || "", /^image\//);

  const settings = await fetch(`${gatewayOrigin}/settings`, { headers: { Cookie: cookie, Accept: "text/html" } });
  assert.equal(settings.status, 200);
  const rsc = await fetch(`${gatewayOrigin}/settings.rsc?_rsc=fixture`, {
    headers: {
      Cookie: cookie,
      RSC: "1",
      "Next-Url": "/settings",
      "Next-Router-State-Tree": JSON.stringify(["", { children: ["settings", {}] }, null, null, true]),
      "X-Vinext-Mounted-Slots": "main",
      "X-Vinext-Rsc-Render-Mode": "navigation",
    },
  });
  assert.equal(rsc.status, 200);
  assert.match(rsc.headers.get("content-type") || "", /(?:text\/x-component|text\/plain|application\/octet-stream)/);
  assert.ok((await rsc.text()).length > 0, "the actual Vinext RSC navigation response is retained through the gateway");

  const capabilities = await fetch(`${gatewayOrigin}/api/client-access`, { headers: { Cookie: cookie } });
  assert.deepEqual(await capabilities.json(), { mode: "lan", canCopyTranscriptPath: false });
  assert.equal((await fetch(`${gatewayOrigin}/api/transcript-path?sessionId=s&agentId=a`, { headers: { Cookie: cookie } })).status, 404);
  assert.equal((await fetch(fixture.webOrigin)).status, 401, "the internal web service requires desktop authorization");

  await fetch(`${gatewayOrigin}/api/sessions`, { headers: { Cookie: cookie } });
  const unchanged = await fetch(`${gatewayOrigin}/api/sessions?revision=1`, { headers: { Cookie: cookie } });
  assert.equal(unchanged.status, 204);
  assert.equal(unchanged.headers.get("x-pomegr-revision"), "1");

  const stream = await fetch(`${gatewayOrigin}/api/events`, { headers: { Cookie: cookie } });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /event: catalog/);
  await fixture.controller.setSharing(false);
  const ended = await Promise.race([
    reader.read().then((result) => result.done, () => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 800)),
  ]);
  assert.equal(ended, true, "revoking the synthetic gateway closes its event stream");
});
