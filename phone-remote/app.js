const $ = (id) => document.getElementById(id);
const state = { socket: null, paired: null, connected: false, toastTimer: null, repeatTimer: null, repeatDelay: null };
const STORAGE_KEY = "omniRemoteTvPairingV1";

function secureToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function getRemoteIdentity() {
  let remoteId = localStorage.getItem("omniRemoteRemoteId");
  if (!remoteId) {
    remoteId = crypto.randomUUID().replace(/[^a-zA-Z0-9_-]/g, "");
    localStorage.setItem("omniRemoteRemoteId", remoteId);
  }
  let remoteToken = localStorage.getItem("omniRemoteRemoteToken");
  if (!remoteToken) {
    remoteToken = secureToken();
    localStorage.setItem("omniRemoteRemoteToken", remoteToken);
  }
  return { remoteId, remoteToken };
}
function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => el.classList.remove("show"), 2300);
}
function setConnection(connected, label) {
  state.connected = connected;
  const pill = document.querySelector(".connection");
  pill.classList.toggle("connected", connected);
  pill.classList.toggle("disconnected", !connected && label !== "Connecting");
  $("connectionText").textContent = label;
  $("pairButton").disabled = !connected;
}
function setMessage(message, kind = "") {
  $("pairMessage").textContent = message;
  $("pairMessage").className = "message " + kind;
}
function showPaired(deviceName) {
  $("deviceName").textContent = deviceName || "Android TV / Fire TV";
  $("pairPanel").hidden = true;
  $("remotePanel").hidden = false;
  $("forgetButton").hidden = false;
}
function showPairing() {
  $("deviceName").textContent = "No TV paired";
  $("pairPanel").hidden = false;
  $("remotePanel").hidden = true;
  $("forgetButton").hidden = true;
  state.paired = null;
}
function socketUrl() {
  return (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws";
}
function connect() {
  if (state.socket && (state.socket.readyState === WebSocket.OPEN || state.socket.readyState === WebSocket.CONNECTING)) return;
  setConnection(false, "Connecting");
  const ws = new WebSocket(socketUrl());
  state.socket = ws;
  ws.addEventListener("open", () => {
    setConnection(true, "Relay online");
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        state.paired = JSON.parse(saved);
        ws.send(JSON.stringify({ type: "phone_auth", ...state.paired }));
      } catch {
        localStorage.removeItem(STORAGE_KEY);
        showPairing();
      }
    } else {
      setMessage("Secure relay connected. Enter the code from your TV.", "success");
    }
  });
  ws.addEventListener("message", event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    handleMessage(message);
  });
  ws.addEventListener("close", () => {
    setConnection(false, "Reconnecting");
    setTimeout(connect, 1800);
  });
  ws.addEventListener("error", () => {
    setConnection(false, "Relay unavailable");
  });
}
function handleMessage(message) {
  switch (message.type) {
    case "tv_ready":
      break;
    case "paired":
      state.paired = { deviceId: message.deviceId, ...getRemoteIdentity() };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.paired));
      showPaired(message.deviceName);
      $("tvStatus").textContent = "TV ONLINE";
      setMessage("Paired successfully.", "success");
      toast("TV paired securely");
      break;
    case "phone_ready":
      state.paired = { deviceId: message.deviceId, ...getRemoteIdentity() };
      showPaired(message.deviceName);
      $("tvStatus").textContent = "REMOTE CONNECTED";
      toast("Remote reconnected");
      break;
    case "pair_waiting":
      setMessage("Request sent. Approve this phone on the TV screen.", "success");
      break;
    case "pair_denied":
      setMessage(message.message || "Pairing declined on TV.", "error");
      break;
    case "tv_status":
      $("tvStatus").textContent = message.online ? "TV ONLINE" : "TV OFFLINE";
      if (!message.online) toast("TV is currently offline");
      break;
    case "tv_capabilities": {
      const notice = $("capabilityNotice");
      if (!message.accessibilityEnabled) {
        notice.textContent = "Enable OmniRemote TV under Accessibility on the television. Remote commands will not work until the service is enabled.";
        notice.hidden = false;
      } else if (!message.dpad) {
        notice.textContent = "This TV runs Android API " + message.apiLevel + ". Its system does not expose the newer global D-pad actions. Back, Home and volume may work; full directional navigation needs a compatible input adapter.";
        notice.hidden = false;
      } else {
        notice.hidden = true;
      }
      break;
    }
    case "command_result":
      if (!message.success) {
        const reason = message.reason === "tv_offline" ? "TV is offline" :
          message.reason === "dpad_requires_android_13" ? "Full D-pad control needs Android 13 / API 33 or newer" :
          message.reason === "accessibility_service_disabled" ? "Enable OmniRemote TV under Accessibility on the TV" :
          message.reason === "unsupported_action" ? "This action is unavailable on this TV" :
          "TV could not perform " + message.action.replaceAll("_", " ");
        toast(reason);
      }
      break;
    case "error":
      setMessage(message.message || "Connection error.", "error");
      if (message.code === "auth_failed") {
        localStorage.removeItem(STORAGE_KEY);
        showPairing();
      }
      toast(message.message || "Remote error");
      break;
  }
}
function sendAction(action) {
  if (!state.connected || !state.socket || state.socket.readyState !== WebSocket.OPEN || !state.paired) {
    toast("Connect and pair a TV first");
    return;
  }
  state.socket.send(JSON.stringify({
    type: "control",
    deviceId: state.paired.deviceId,
    id: crypto.randomUUID(),
    action
  }));
}
$("pairForm").addEventListener("submit", event => {
  event.preventDefault();
  const code = $("pairCode").value.replace(/\D/g, "").slice(0, 6);
  if (!/^\d{6}$/.test(code)) return setMessage("Enter the six-digit code shown on the TV.", "error");
  if (!state.connected || state.socket?.readyState !== WebSocket.OPEN) return setMessage("Relay is not connected yet.", "error");
  state.socket.send(JSON.stringify({ type: "phone_pair", code, ...getRemoteIdentity(), remoteName: navigator.userAgent.includes("Android") ? "Android phone" : "Phone remote" }));
  setMessage("Sending pairing request…");
});
$("forgetButton").addEventListener("click", () => {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem("omniRemoteRemoteId");
  localStorage.removeItem("omniRemoteRemoteToken");
  state.paired = null;
  showPairing();
  toast("This phone has been unpaired");
});
function stopRepeat() {
  clearTimeout(state.repeatDelay);
  clearInterval(state.repeatTimer);
  state.repeatDelay = null;
  state.repeatTimer = null;
}
document.querySelectorAll("[data-action]").forEach(button => {
  const action = button.dataset.action;
  const start = event => {
    event.preventDefault();
    stopRepeat();
    sendAction(action);
    if (["up", "down", "left", "right"].includes(action)) {
      state.repeatDelay = setTimeout(() => {
        state.repeatTimer = setInterval(() => sendAction(action), 150);
      }, 320);
    }
  };
  button.addEventListener("pointerdown", start);
  button.addEventListener("pointerup", stopRepeat);
  button.addEventListener("pointercancel", stopRepeat);
  button.addEventListener("lostpointercapture", stopRepeat);
  button.addEventListener("contextmenu", e => e.preventDefault());
});
connect();
