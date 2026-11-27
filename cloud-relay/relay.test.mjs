import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));

function connect(url) {
  const ws = new WebSocket(url);
  const messages = [];
  const waiters = [];
  ws.on("message", data => {
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    const index = waiters.findIndex(waiter => waiter.type === message.type);
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      messages.push(message);
    }
  });
  return {
    ws,
    waitFor(type, timeout = 5000) {
      const existing = messages.findIndex(message => message.type === type);
      if (existing >= 0) return Promise.resolve(messages.splice(existing, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = {
          type,
          resolve,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            reject(new Error("Timed out waiting for " + type));
          }, timeout)
        };
        waiters.push(waiter);
      });
    }
  };
}

async function waitForHealth(url, child) {
  const end = Date.now() + 12_000;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error("Relay exited before health check");
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error("Relay did not become healthy");
}

test("TV registration, phone approval, command forwarding and phone re-auth work", async () => {
  const port = 25000 + Math.floor(Math.random() * 12000);
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "omni-relay-test-"));
  const child = spawn(process.execPath, [path.join(here, "server.mjs")], {
    cwd: here,
    env: { ...process.env, PORT: String(port), OR_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk.toString(); });
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  const httpUrl = "http://127.0.0.1:" + port;
  const wsUrl = "ws://127.0.0.1:" + port + "/ws";
  const clients = [];

  try {
    await waitForHealth(httpUrl, child);
    const health = await fetch(httpUrl + "/healthz").then(response => response.json());
    assert.equal(health.ok, true);

    const tv = connect(wsUrl);
    clients.push(tv);
    await once(tv.ws, "open");
    const tvReady = tv.waitFor("tv_ready");
    const codeReady = tv.waitFor("pairing_code");
    const deviceId = "tv-device-test-0000000001";
    const deviceToken = "T".repeat(43);
    tv.ws.send(JSON.stringify({
      type: "tv_hello",
      deviceId,
      deviceToken,
      deviceName: "Test Android TV",
      platform: "android-tv"
    }));
    assert.equal((await tvReady).deviceId, deviceId);
    const pairingCode = (await codeReady).code;
    assert.match(pairingCode, /^\d{6}$/);

    const phone = connect(wsUrl);
    clients.push(phone);
    await once(phone.ws, "open");
    const waiting = phone.waitFor("pair_waiting");
    const request = tv.waitFor("pair_request");
    const remoteId = "phone-remote-test-00000001";
    const remoteToken = "P".repeat(43);
    phone.ws.send(JSON.stringify({
      type: "phone_pair",
      code: pairingCode,
      remoteId,
      remoteToken,
      remoteName: "Test phone"
    }));
    assert.equal((await waiting).deviceName, "Test Android TV");
    const pairRequest = await request;
    const paired = phone.waitFor("paired");
    tv.ws.send(JSON.stringify({
      type: "pair_decision",
      requestId: pairRequest.requestId,
      approved: true
    }));
    assert.equal((await paired).deviceId, deviceId);

    const forwarded = tv.waitFor("control");
    phone.ws.send(JSON.stringify({
      type: "control",
      deviceId,
      id: "command-1",
      action: "left"
    }));
    const command = await forwarded;
    assert.equal(command.action, "left");
    assert.equal(command.id, "command-1");

    const result = phone.waitFor("command_result");
    tv.ws.send(JSON.stringify({
      type: "command_result",
      id: "command-1",
      action: "left",
      success: true
    }));
    assert.equal((await result).success, true);

    const capabilities = phone.waitFor("tv_capabilities");
    tv.ws.send(JSON.stringify({
      type: "tv_capabilities",
      apiLevel: 35,
      androidVersion: "15",
      dpad: true,
      accessibilityEnabled: true
    }));
    assert.equal((await capabilities).dpad, true);

    phone.ws.close();
    await once(phone.ws, "close");

    const phoneAgain = connect(wsUrl);
    clients.push(phoneAgain);
    await once(phoneAgain.ws, "open");
    const authenticated = phoneAgain.waitFor("phone_ready");
    phoneAgain.ws.send(JSON.stringify({
      type: "phone_auth",
      deviceId,
      remoteId,
      remoteToken
    }));
    assert.equal((await authenticated).deviceName, "Test Android TV");
  } catch (error) {
    throw new Error(error.message + "\nRelay stdout:\n" + stdout + "\nRelay stderr:\n" + stderr);
  } finally {
    for (const client of clients) {
      try { client.ws.terminate(); } catch {}
    }
    child.kill("SIGTERM");
    await Promise.race([
      once(child, "exit"),
      new Promise(resolve => setTimeout(resolve, 3000))
    ]);
    await rm(dataDir, { recursive: true, force: true });
  }
});
