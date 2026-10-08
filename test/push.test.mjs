import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fixture, waitFor } from "./workflow-support.mjs";

/** Decrypts an `aes128gcm` push message (RFC 8291) with the device's keys, as a browser does. */
function decrypt(body, device, auth) {
  const salt = body.subarray(0, 16),
    size = body[20],
    sender = body.subarray(21, 21 + size),
    sealed = body.subarray(21 + size);
  const hkdf = (salt, ikm, info, length) =>
    Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, length));
  const ikm = hkdf(
    auth,
    device.computeSecret(sender),
    Buffer.concat([
      Buffer.from("WebPush: info\0"),
      device.getPublicKey(),
      sender,
    ]),
    32,
  );
  const key = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
  const decipher = crypto.createDecipheriv("aes-128-gcm", key, nonce);
  decipher.setAuthTag(sealed.subarray(-16));
  const plain = Buffer.concat([
    decipher.update(sealed.subarray(0, -16)),
    decipher.final(),
  ]);
  assert.equal(plain.at(-1), 2, "one last record");
  return JSON.parse(plain.subarray(0, -1).toString());
}

/** Checks the VAPID token (RFC 8292) with the server's public key; returns its claims. */
function vapid(header, publicKey) {
  const [, token, key] = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.equal(key, publicKey);
  const [head, claims, signature] = token.split(".");
  const point = Buffer.from(publicKey, "base64url");
  const verifier = crypto.createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: point.subarray(1, 33).toString("base64url"),
      y: point.subarray(33).toString("base64url"),
    },
    format: "jwk",
  });
  assert.ok(
    crypto.verify(
      "sha256",
      Buffer.from(`${head}.${claims}`),
      { key: verifier, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url"),
    ),
    "the VAPID signature is valid",
  );
  return JSON.parse(Buffer.from(claims, "base64url"));
}

test("a finished task notifies the subscribed devices; a device that the push service forgot is removed", async (t) => {
  // A push service on loopback: it keeps each message and answers 410 (the device is gone).
  const received = [];
  const service = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (c) => chunks.push(c));
    request.on("end", () => {
      received.push({ headers: request.headers, body: Buffer.concat(chunks) });
      response.writeHead(410).end();
    });
  });
  await new Promise((r) => service.listen(0, "127.0.0.1", r));
  t.after(() => service.close());
  const origin = `http://127.0.0.1:${service.address().port}`;
  const f = await fixture({ env: { PEEKUMI_PUSH_TEST_ORIGIN: origin } });
  t.after(() => f.close());

  const { key } = await f.req("/api/push/key");
  assert.equal(Buffer.from(key, "base64url").length, 65);
  assert.equal((await f.req("/api/push/key")).key, key, "the key is kept");

  const device = crypto.createECDH("prime256v1");
  device.generateKeys();
  const auth = crypto.randomBytes(16);
  const keys = {
    p256dh: device.getPublicKey().toString("base64url"),
    auth: auth.toString("base64url"),
  };
  // Only the endpoints of push services are accepted.
  for (const endpoint of [
    "https://example.com/push",
    "http://169.254.169.254/latest",
    "file:///etc/passwd",
  ])
    assert.equal(
      (await f.req("/api/push/subscribe", { endpoint, keys })).status,
      400,
    );
  assert.equal(
    (
      await f.req("/api/push/subscribe", {
        endpoint: origin + "/push/device",
        keys: { ...keys, p256dh: "bad" },
      })
    ).status,
    400,
  );
  const endpoint = origin + "/push/device";
  assert.equal(
    (await f.req("/api/push/subscribe", { endpoint, keys })).ok,
    true,
  );
  const saved = path.join(f.state, "push", "subscriptions.json");
  assert.equal(JSON.parse(await readFile(saved, "utf8")).length, 1);

  const c = await f.req("/api/comments", {
    text: "Tidy the module\nMore detail",
    sha: f.sha,
    anchor: { kind: "repo", path: "" },
  });
  const p = await f.req("/api/runs/preview", {
    agent: "claude",
    commentIds: [c.id],
  });
  await f.req("/api/runs", { previewId: p.id });
  await waitFor(() => received.length > 0);
  const [{ headers, body }] = received;
  assert.equal(headers["content-encoding"], "aes128gcm");
  assert.equal(headers.ttl, "86400");
  const claims = vapid(headers.authorization, key);
  assert.equal(claims.aud, origin);
  assert.ok(claims.exp * 1000 > Date.now());
  const message = decrypt(body, device, auth);
  assert.equal(message.title, "Task ready for review");
  assert.match(message.body, /^Tidy the module\n/);
  assert.match(message.url, new RegExp(`^/\\?repo=[0-9a-f]{16}&task=${p.id}$`));
  assert.equal(message.tag, "run-" + p.id);
  // The push service answered 410, so the device is gone from the list.
  await waitFor(
    async () => JSON.parse(await readFile(saved, "utf8")).length === 0,
  );
  assert.equal(
    (await f.req("/api/push/subscribe", { endpoint }, "DELETE")).ok,
    true,
  );
});
