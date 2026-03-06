import { GITHUB_CLIENT_ID, OAUTH_CALLBACK_ORIGIN, connectGitHub } from 'https://neevs.io/auth/connect.js';

const DEFAULT_BROKER_URL = "wss://broker.hivemq.com:8884/mqtt";

const state = {
  mqttClient: null,
  connected: false,
  connecting: false,
  manualDisconnect: false,
  url: localStorage.getItem("webmcp-broker-url") || DEFAULT_BROKER_URL,
  topicPrefix: localStorage.getItem("webmcp-topic-prefix") || "",
  seenTopics: [],
  watching: null,
  topicListeners: {},
  onceCallbacks: {},
  selected: null,
  filter: "",
  publishHistory: {},
  continuousPublish: null,
  pinnedTopics: {},
  toolLog: [],
  reconnect: null,
  sidebarCollapsed: { topics: false },
  topicMsgCounts: {},
  deviceStreams: {},  // deviceId → stream URL, populated from device announcements
};

let _toolLogId = 0;

function el(id) {
  return document.getElementById(id);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toast(msg, kind = "default", durationMs = 3000) {
  const node = document.createElement("div");
  node.className = "toast";
  if (kind !== "default") node.classList.add(kind);
  node.textContent = msg;
  el("toast-container").appendChild(node);
  setTimeout(() => node.remove(), durationMs);
}

function cssId(str) {
  return str.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function prettyJson(str) {
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}

function isConnected() {
  return !!(state.mqttClient && state.connected);
}

function parseHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function formatBadgeCount(count) {
  return count > 999 ? "999+" : String(count);
}

function getNamespaceCount(prefix) {
  return state.seenTopics
    .filter(t => t.startsWith(prefix + "/"))
    .reduce((sum, t) => sum + (state.topicMsgCounts[t] || 0), 0);
}

function trackTopic(topic) {
  if (state.seenTopics.includes(topic)) return false;
  state.seenTopics.push(topic);
  renderSidebar();
  if (!state.selected) renderMainPlaceholder();
  return true;
}

function attachJsonFormatter(id) {
  const field = el(id);
  if (!field) return;
  field.addEventListener("blur", () => {
    const val = field.value.trim();
    if (val) field.value = prettyJson(val);
  });
}

const RECONNECT_MAX = 8;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_CAP_MS = 30000;

function scheduleReconnect() {
  const rc = (state.reconnect ??= { attempts: 0, timer: null });
  if (rc.attempts >= RECONNECT_MAX) {
    state.reconnect = null;
    toast("Max reconnect attempts reached", "error");
    updateStatusDot("error");
    setStatusText("Disconnected");
    return;
  }
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** rc.attempts, RECONNECT_CAP_MS);
  rc.attempts++;
  updateStatusDot("connecting");
  setStatusText(`Reconnecting in ${Math.round(delay / 1000)}s… (${rc.attempts}/${RECONNECT_MAX})`);
  rc.timer = setTimeout(() => {
    if (!state.connected) connect(state.url);
  }, delay);
}

function cancelReconnect() {
  if (!state.reconnect) return;
  clearTimeout(state.reconnect.timer);
  state.reconnect = null;
}

function connect(url) {
  cancelReconnect();
  state.manualDisconnect = false;
  state.connecting = true;
  if (state.mqttClient) {
    state.mqttClient.end(true);
    state.mqttClient = null;
  }
  stopWatching();

  updateStatusDot("connecting");
  setStatusText("Connecting…");
  renderMainPlaceholder();

  state.url = url;
  localStorage.setItem("webmcp-broker-url", url);
  const client = mqtt.connect(url, { reconnectPeriod: 0 });
  state.mqttClient = client;

  client.on("connect", () => {
    cancelReconnect();
    state.connected = true;
    state.connecting = false;
    updateStatusDot("connected");
    setStatusText(parseHostname(url));
    el("connect-btn").textContent = "Disconnect";
    const prefix = state.topicPrefix;
    client.subscribe(prefix + "#");
    client.subscribe("devices/" + prefix + "#");
    renderSidebar();
    renderMainPlaceholder();
  });

  client.on("message", (topic, message) => {
    const msg = message.toString();

    if (topic.startsWith("devices/")) {
      try {
        const { topics, stream } = JSON.parse(msg);
        for (const t of topics) trackTopic(t);
        if (stream) {
          const deviceId = topic.slice("devices/".length);
          state.deviceStreams[deviceId] = stream;
        }
        if (!state.selected && state.seenTopics.length > 0) selectTopic(state.seenTopics[0]);
      } catch (e) { console.warn("Failed to parse device announcement JSON", e); }
      return;
    }

    trackTopic(topic);
    state.topicMsgCounts[topic] = (state.topicMsgCounts[topic] || 0) + 1;
    flashSidebarRow(topic);
    updateSidebarBadge(topic);

    if (state.topicListeners[topic]) {
      for (const cb of state.topicListeners[topic]) cb(msg);
    }

    if (state.onceCallbacks[topic]?.length) {
      for (const cb of state.onceCallbacks[topic].splice(0)) cb(msg);
    }

    if (state.watching === topic) showMsgCard(msg);

    if (state.pinnedTopics[topic]) {
      state.pinnedTopics[topic].lastMsg = msg;
      updateWatchCard(topic);
    }
  });

  client.on("error", (err) => {
    state.connecting = false;
    updateStatusDot("error");
    setStatusText("Error");
    const detail = err.message || err;
    toast(`Connection error: ${detail}`, "error");
  });

  client.on("close", () => {
    resetConnectionState();
    if (!state.manualDisconnect) scheduleReconnect();
    state.manualDisconnect = false;
  });
}

function resetConnectionState() {
  state.connected = false;
  state.connecting = false;
  state.seenTopics = [];
  state.watching = null;
  state.selected = null;
  state.onceCallbacks = {};
  state.topicListeners = {};
  state.topicMsgCounts = {};
  state.deviceStreams = {};
  updateStatusDot("idle");
  el("connect-btn").textContent = "Connect";
  unpinAllTopics();
  renderSidebar();
  renderMainPlaceholder();
}

function setStatusText(text) {
  el("status-text").textContent = text;
}

function updateStatusDot(status) {
  const dot = el("status-dot");
  dot.className = "status-dot";
  if (status !== "idle") dot.classList.add(status);
}

function renderMainPlaceholder() {
  const main = el("main-panel");
  if (!state.connected) {
    const msg = state.connecting
      ? "Connecting…"
      : "Connect to an MQTT broker to get started.";
    main.innerHTML = `<div class="panel-placeholder" id="panel-placeholder">${msg}</div>`;
    return;
  }
  main.innerHTML = `
    <div class="conn-summary">
      <div class="conn-summary-title">Connected</div>
      <div class="conn-url">${escHtml(state.url)}</div>
      <div class="conn-stats">
        <div class="conn-stat">
          <span class="conn-stat-value">${state.seenTopics.length}</span>
          <span class="conn-stat-label">Topics</span>
        </div>
      </div>
      <div class="conn-hint">← select a topic to inspect or publish</div>
    </div>
  `;
}

function renderSidebar() {
  renderTopicList();
  const collapsed = state.sidebarCollapsed.topics;
  const listEl = el("topics-list");
  const btn = el("section-toggle-topics");
  const chevron = btn?.parentElement?.querySelector(".sidebar-chevron");
  if (listEl) listEl.hidden = collapsed;
  if (btn) btn.setAttribute("aria-expanded", String(!collapsed));
  if (chevron) chevron.classList.toggle("collapsed", collapsed);
}

function renderTopicList() {
  const container = el("topics-list");
  container.innerHTML = "";

  const filtered = state.filter
    ? state.seenTopics.filter(t => t.toLowerCase().includes(state.filter.toLowerCase()))
    : state.seenTopics;

  if (!filtered.length) {
    if (!state.connected) return;
    const el = document.createElement("div");
    el.className = "sidebar-empty";
    el.textContent = state.filter ? "No matches" : "Waiting for messages…";
    container.appendChild(el);
    return;
  }

  const groups = {};
  const flat = [];
  for (const topic of filtered) {
    const slash = topic.indexOf("/");
    if (slash === -1) {
      flat.push(topic);
    } else {
      const prefix = topic.slice(0, slash);
      if (!groups[prefix]) groups[prefix] = [];
      groups[prefix].push(topic);
    }
  }

  function makeTopicRow(topic, displayText, indented) {
    const isActive = state.selected?.name === topic;
    const count = state.topicMsgCounts[topic] || 0;
    const isPinned = !!state.pinnedTopics[topic];

    const row = document.createElement("div");
    row.className = "sidebar-item-row";
    row.dataset.topic = topic;

    const btn = document.createElement("button");
    btn.className = "sidebar-item";
    if (isActive) btn.classList.add("active");
    if (indented) btn.classList.add("sidebar-item-indented");
    btn.textContent = displayText;
    btn.title = topic;
    btn.addEventListener("click", () => selectTopic(topic));

    const badge = document.createElement("span");
    badge.className = "sidebar-msg-count";
    badge.dataset.topic = topic;
    badge.textContent = formatBadgeCount(count);
    badge.hidden = count === 0;

    const pinBtn = document.createElement("button");
    pinBtn.className = isPinned ? "pin-btn pinned" : "pin-btn";
    pinBtn.title = isPinned ? "Unpin" : "Pin to watch strip";
    pinBtn.setAttribute("aria-pressed", String(isPinned));
    pinBtn.textContent = "⊕";
    pinBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePin(topic);
    });

    row.appendChild(btn);
    row.appendChild(badge);
    row.appendChild(pinBtn);
    return row;
  }

  for (const [prefix, topics] of Object.entries(groups)) {
    if (topics.length === 1) {
      container.appendChild(makeTopicRow(topics[0], topics[0], false));
      continue;
    }

    const isCollapsed = !!state.sidebarCollapsed[`ns:${prefix}`];
    const groupCount = getNamespaceCount(prefix);

    const header = document.createElement("button");
    header.className = "sidebar-ns-header";
    header.setAttribute("aria-expanded", String(!isCollapsed));

    const chevron = document.createElement("span");
    chevron.className = isCollapsed ? "sidebar-chevron collapsed" : "sidebar-chevron";

    header.appendChild(chevron);
    header.appendChild(document.createTextNode(prefix + "/"));

    const nsBadge = document.createElement("span");
    nsBadge.className = "sidebar-msg-count sidebar-ns-badge";
    nsBadge.dataset.ns = prefix;
    nsBadge.textContent = formatBadgeCount(groupCount);
    nsBadge.hidden = groupCount === 0;
    header.appendChild(nsBadge);

    header.addEventListener("click", () => {
      state.sidebarCollapsed[`ns:${prefix}`] = !state.sidebarCollapsed[`ns:${prefix}`];
      renderTopicList();
    });

    const itemsEl = document.createElement("div");
    itemsEl.hidden = isCollapsed;
    for (const topic of topics) {
      itemsEl.appendChild(makeTopicRow(topic, topic.slice(prefix.length + 1), true));
    }

    container.appendChild(header);
    container.appendChild(itemsEl);
  }

  for (const topic of flat) {
    container.appendChild(makeTopicRow(topic, topic, false));
  }
}

function flashSidebarRow(topic) {
  const row = document.querySelector(`.sidebar-item-row[data-topic="${CSS.escape(topic)}"]`);
  if (!row) return;
  row.classList.remove("flash-new");
  void row.offsetWidth;
  row.classList.add("flash-new");
  row.addEventListener("animationend", () => row.classList.remove("flash-new"), { once: true });
}

function updateSidebarBadge(topic) {
  const count = state.topicMsgCounts[topic] || 0;
  const badge = document.querySelector(`.sidebar-msg-count[data-topic="${CSS.escape(topic)}"]`);
  if (badge) {
    badge.textContent = formatBadgeCount(count);
    badge.hidden = false;
  }
  const slash = topic.indexOf("/");
  if (slash !== -1) {
    const prefix = topic.slice(0, slash);
    const nsBadge = document.querySelector(`.sidebar-ns-badge[data-ns="${CSS.escape(prefix)}"]`);
    if (nsBadge) {
      nsBadge.textContent = formatBadgeCount(getNamespaceCount(prefix));
      nsBadge.hidden = false;
    }
  }
}

function selectTopic(topic) {
  stopWatching();
  stopContinuousPublish();
  state.selected = { name: topic };
  renderSidebar();
  renderTopicPanel(topic);
}

function getTopicStream(topic) {
  if (!topic.startsWith("devices/")) return null;
  const rest = topic.slice("devices/".length);
  const slash = rest.indexOf("/");
  if (slash === -1) return null;
  return state.deviceStreams[rest.slice(0, slash)] || null;
}

// Motor D-pad command payloads. Speed is in [0, 1].
const MOTOR_CMDS = {
  forward:  (s) => `{"left":${s},"right":${s}}`,
  backward: (s) => `{"left":${-s},"right":${-s}}`,
  left:     (s) => `{"left":${-s},"right":${s}}`,
  right:    (s) => `{"left":${s},"right":${-s}}`,
  stop:     ()  => `{"left":0,"right":0}`,
};

let _dpadRepeatTimer = null;

function _dpadPublish(topic, dir) {
  const speedEl = document.querySelector(".dpad-speed");
  const speed = speedEl ? parseFloat(speedEl.value) : 0.8;
  const payload = MOTOR_CMDS[dir]?.(+speed.toFixed(2));
  if (payload) state.mqttClient?.publish(topic, payload);
}

function _dpadStart(topic, dir) {
  _dpadPublish(topic, dir);
  clearInterval(_dpadRepeatTimer);
  _dpadRepeatTimer = setInterval(() => _dpadPublish(topic, dir), 100);
}

function _dpadStop(topic) {
  clearInterval(_dpadRepeatTimer);
  _dpadRepeatTimer = null;
  state.mqttClient?.publish(topic, MOTOR_CMDS.stop());
}

function renderTopicPanel(topic) {
  const main = el("main-panel");
  const isMotorTopic = topic.endsWith("/motors/command");
  const streamUrl = getTopicStream(topic);

  const cameraHtml = streamUrl ? `
    <div class="divider-label">Camera</div>
    <div class="camera-section">
      <img class="camera-stream" id="camera-stream-img" src="${escHtml(streamUrl)}" alt="Camera stream">
      <div class="camera-stream-fallback" id="camera-stream-fallback" hidden>
        Stream blocked (mixed content).
        <a class="camera-stream-link" href="${escHtml(streamUrl)}" target="_blank" rel="noopener">Open in new tab ↗</a>
      </div>
    </div>
  ` : "";

  const dpadHtml = isMotorTopic ? `
    <div class="divider-label">Drive</div>
    <div class="dpad-wrap">
      <div class="dpad">
        <div></div>
        <button class="btn dpad-btn" data-dir="forward" title="Forward (↑)" aria-label="Forward">↑</button>
        <div></div>
        <button class="btn dpad-btn" data-dir="left" title="Left (←)" aria-label="Left">←</button>
        <button class="btn dpad-btn dpad-stop" data-dir="stop" title="Stop (Space)" aria-label="Stop">■</button>
        <button class="btn dpad-btn" data-dir="right" title="Right (→)" aria-label="Right">→</button>
        <div></div>
        <button class="btn dpad-btn" data-dir="backward" title="Backward (↓)" aria-label="Backward">↓</button>
        <div></div>
      </div>
      <div class="dpad-speed-row">
        <span class="repeat-label">Speed</span>
        <input type="range" class="dpad-speed" min="0.1" max="1.0" step="0.05" value="0.8" aria-label="Motor speed">
        <span class="dpad-speed-val repeat-unit">0.8</span>
      </div>
    </div>
  ` : "";

  main.innerHTML = `
    <div class="detail-header">
      <div class="detail-title">${escHtml(topic)}</div>
      <div class="detail-type">MQTT topic</div>
    </div>

    <div>
      <div class="section-label">Last message</div>
      <div class="data-card empty" id="last-msg">No data yet</div>
    </div>

    <div class="controls-row">
      <button class="btn btn-sm" id="btn-subscribe-once">Subscribe once</button>
      <button class="btn btn-sm" id="btn-watch">Watch</button>
      <button class="btn btn-sm" id="btn-stop-watch" hidden>Stop</button>
      <span class="watch-indicator" id="watch-indicator" hidden>
        <span class="watch-dot"></span> Watching
      </span>
    </div>

    ${cameraHtml}

    ${dpadHtml}

    <div class="divider-label">Publish</div>

    <div class="input-group" id="publish-history-group" style="display:none">
      <label class="input-label" for="publish-history">History</label>
      <select class="input-field" id="publish-history"></select>
    </div>

    <div class="input-group">
      <label class="input-label" for="publish-msg">Payload <span style="color:var(--text-muted);font-weight:400">— ⌘↵ to send</span></label>
      <textarea class="textarea-field" id="publish-msg" rows="3" placeholder='true'></textarea>
    </div>

    <div class="controls-row">
      <button class="btn btn-primary btn-sm" id="btn-publish">Publish</button>
    </div>

    <div class="controls-row repeat-row">
      <label class="repeat-label">
        <input type="checkbox" class="repeat-check" id="repeat-checkbox">
        Repeat at
      </label>
      <input type="number" class="input-field hz-input" id="repeat-hz" value="1" min="0.1" max="100" step="0.1">
      <span class="repeat-unit">Hz</span>
    </div>
  `;

  const streamImg = el("camera-stream-img");
  if (streamImg) {
    streamImg.addEventListener("error", () => {
      streamImg.hidden = true;
      const fallback = el("camera-stream-fallback");
      if (fallback) fallback.hidden = false;
    });
  }

  el("btn-subscribe-once").addEventListener("click", () => doSubscribeOnce(topic));
  el("btn-watch").addEventListener("click", () => startWatching(topic));
  el("btn-stop-watch").addEventListener("click", stopWatching);
  el("btn-publish").addEventListener("click", () => doPublish(topic));
  el("publish-msg").addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      doPublish(topic);
    }
  });
  el("publish-history").addEventListener("change", (e) => {
    if (!e.target.value) return;
    el("publish-msg").value = e.target.value;
    e.target.value = "";
  });
  renderPublishHistory(topic);

  function syncRepeatPublish() {
    if (el("repeat-checkbox")?.checked) {
      const hz = parseFloat(el("repeat-hz").value) || 1;
      startContinuousPublish(topic, hz);
    } else {
      stopContinuousPublish();
    }
  }
  el("repeat-checkbox").addEventListener("change", syncRepeatPublish);
  el("repeat-hz").addEventListener("change", syncRepeatPublish);
  attachJsonFormatter("publish-msg");

  if (isMotorTopic) {
    // Speed slider display
    const speedEl = main.querySelector(".dpad-speed");
    const speedVal = main.querySelector(".dpad-speed-val");
    speedEl.addEventListener("input", () => {
      speedVal.textContent = parseFloat(speedEl.value).toFixed(2);
    });

    // D-pad pointer events (hold to drive continuously)
    for (const btn of main.querySelectorAll(".dpad-btn")) {
      const dir = btn.dataset.dir;
      btn.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        btn.setPointerCapture(e.pointerId);
        if (dir === "stop") { _dpadStop(topic); return; }
        _dpadStart(topic, dir);
      });
      btn.addEventListener("pointerup",     () => _dpadStop(topic));
      btn.addEventListener("pointercancel", () => _dpadStop(topic));
    }

  }
}

// Keyboard: arrow keys drive, space stops. Active only when D-pad is in DOM.
function initDpadKeyListeners() {
  const KEY_DIR = { ArrowUp: "forward", ArrowDown: "backward", ArrowLeft: "left", ArrowRight: "right" };
  document.addEventListener("keydown", (e) => {
    if (!document.querySelector(".dpad")) return;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
    if (e.key === " ") { e.preventDefault(); _dpadStop(state.selected?.name); return; }
    const dir = KEY_DIR[e.key];
    if (!dir || e.repeat) return;
    e.preventDefault();
    _dpadStart(state.selected?.name, dir);
  });
  document.addEventListener("keyup", (e) => {
    if (!document.querySelector(".dpad")) return;
    if (KEY_DIR[e.key]) _dpadStop(state.selected?.name);
  });
}

function pushPublishHistory(topic, payload) {
  const hist = (state.publishHistory[topic] ??= []);
  const existing = hist.indexOf(payload);
  if (existing !== -1) hist.splice(existing, 1);
  hist.unshift(payload);
  if (hist.length > 10) hist.pop();
}

function renderPublishHistory(topic) {
  const sel = el("publish-history");
  const group = el("publish-history-group");
  if (!sel || !group) return;
  const hist = state.publishHistory[topic] || [];
  group.style.display = hist.length ? "" : "none";
  sel.innerHTML = '<option value="">— History —</option>';
  for (const entry of hist) {
    const opt = document.createElement("option");
    opt.value = entry;
    const collapsed = entry.replace(/\s+/g, " ");
    opt.textContent = collapsed.length > 50 ? collapsed.slice(0, 50) + "…" : collapsed;
    sel.appendChild(opt);
  }
}

function startContinuousPublish(topic, hz) {
  stopContinuousPublish();
  const interval = Math.max(50, Math.round(1000 / hz));
  const timer = setInterval(() => {
    const payload = el("publish-msg")?.value || "";
    state.mqttClient?.publish(topic, payload);
  }, interval);
  state.continuousPublish = { timer };
}

function stopContinuousPublish() {
  if (!state.continuousPublish) return;
  clearInterval(state.continuousPublish.timer);
  state.continuousPublish = null;
  const cb = el("repeat-checkbox");
  if (cb) cb.checked = false;
}

async function doSubscribeOnce(topic) {
  const btn = el("btn-subscribe-once");
  btn.disabled = true;
  btn.textContent = "Waiting…";
  try {
    const msg = await subscribeOnce(topic, 5000);
    showMsgCard(msg);
    toast("Message received", "ok");
  } catch (err) {
    toast(String(err), "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Subscribe once";
  }
}

function setWatchUI(watching) {
  const btnWatch = el("btn-watch");
  const btnStop = el("btn-stop-watch");
  const indicator = el("watch-indicator");
  if (btnWatch) btnWatch.hidden = watching;
  if (btnStop) btnStop.hidden = !watching;
  if (indicator) indicator.hidden = !watching;
}

function startWatching(topic) {
  stopWatching();
  state.watching = topic;
  setWatchUI(true);
}

function stopWatching() {
  stopContinuousPublish();
  state.watching = null;
  setWatchUI(false);
}

function showMsgCard(msg) {
  const card = el("last-msg");
  if (!card) return;
  card.className = "data-card";
  card.textContent = prettyJson(msg);
}

function doPublish(topic) {
  const payload = el("publish-msg").value;
  if (!payload) {
    toast("Enter a payload to publish", "error");
    return;
  }
  pushPublishHistory(topic, payload);
  renderPublishHistory(topic);
  state.mqttClient.publish(topic, payload);
  toast("Published", "ok");
}

function togglePin(topic) {
  if (state.pinnedTopics[topic]) return unpinTopic(topic);
  if (!isConnected()) return;
  state.pinnedTopics[topic] = { lastMsg: null };
  renderPinnedRow();
  renderSidebar();
}

function unpinTopic(topic) {
  if (!state.pinnedTopics[topic]) return;
  delete state.pinnedTopics[topic];
  renderPinnedRow();
  renderSidebar();
}

function unpinAllTopics() {
  state.pinnedTopics = {};
  renderPinnedRow();
}

function renderPinnedRow() {
  const row = el("pinned-row");
  const pinned = Object.entries(state.pinnedTopics);
  row.hidden = !pinned.length;
  row.innerHTML = "";

  for (const [topic, entry] of pinned) {
    const id = cssId(topic);
    const safe = escHtml(topic);
    const msg = entry.lastMsg !== null ? escHtml(entry.lastMsg) : "Waiting…";

    const card = document.createElement("div");
    card.className = "watch-card";
    card.id = `watch-card-${id}`;
    card.innerHTML = `
      <div class="watch-card-header">
        <span class="watch-card-name" title="${safe}">${safe}</span>
        <button class="watch-card-unpin" aria-label="Unpin ${safe}">✕</button>
      </div>
      <div class="watch-card-msg" id="watch-msg-${id}">${msg}</div>
    `;
    card.querySelector(".watch-card-unpin").addEventListener("click", () => unpinTopic(topic));
    row.appendChild(card);
  }
}

function updateWatchCard(topic) {
  const entry = state.pinnedTopics[topic];
  if (!entry) return;
  const msgEl = el(`watch-msg-${cssId(topic)}`);
  if (msgEl && entry.lastMsg !== null) {
    msgEl.textContent = prettyJson(entry.lastMsg);
  }
}

function subscribeOnce(topic, timeoutMs = 5000) {
  if (!isConnected()) return Promise.reject(new Error("Not connected"));
  return new Promise((resolve, reject) => {
    const callbacks = (state.onceCallbacks[topic] ??= []);
    const timer = setTimeout(() => {
      const idx = callbacks.indexOf(cb);
      if (idx !== -1) callbacks.splice(idx, 1);
      reject(new Error(`Timeout waiting for message on ${topic}`));
    }, timeoutMs);
    function cb(msg) {
      clearTimeout(timer);
      resolve(msg);
    }
    callbacks.push(cb);
  });
}

function subscribeForDuration(topic, durationSec, maxMessages = 100) {
  if (!isConnected()) throw new Error("Not connected");
  const collected = [];
  const listeners = (state.topicListeners[topic] ??= new Set());

  return new Promise(resolve => {
    const cb = (msg) => {
      collected.push(msg);
      if (collected.length >= maxMessages) {
        listeners.delete(cb);
        resolve(collected);
      }
    };
    listeners.add(cb);
    setTimeout(() => {
      listeners.delete(cb);
      resolve(collected);
    }, durationSec * 1000);
  });
}

const TOOLS = [
  {
    name: "connect_to_broker",
    description: "Set the MQTT broker WebSocket URL and reconnect.",
    parameters: {
      type: "object",
      properties: {
        ip:   { type: "string", description: "MQTT broker host IP or hostname", default: "broker.hivemq.com" },
        port: { type: "number", description: "MQTT WebSocket port (8884 for wss, 9001 for local ws)", default: 8884 },
      },
      required: ["ip"],
    },
    handler: async ({ ip, port = 8884 }) => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const url = `${proto}://${ip}:${port}/mqtt`;
      el("url-input").value = url;
      connect(url);
      return { status: "connecting", url };
    },
  },
  {
    name: "get_topics",
    description: "List all MQTT topics seen since connecting (via wildcard # subscription).",
    parameters: { type: "object", properties: {} },
    handler: async () => ({ topics: state.seenTopics }),
  },
  {
    name: "subscribe_once",
    description: "Wait for the next message on an MQTT topic and return its payload.",
    parameters: {
      type: "object",
      properties: {
        topic:   { type: "string", description: "MQTT topic, e.g. devices/d4e9f4a2a044/led/command" },
        timeout: { type: "number", description: "Timeout in seconds (default 5)", default: 5 },
      },
      required: ["topic"],
    },
    handler: async ({ topic, timeout = 5 }) => {
      const msg = await subscribeOnce(topic, timeout * 1000);
      if (state.selected?.name === topic) showMsgCard(msg);
      return { topic, payload: msg };
    },
  },
  {
    name: "subscribe_for_duration",
    description: "Collect all messages on an MQTT topic for a given duration.",
    parameters: {
      type: "object",
      properties: {
        topic:        { type: "string" },
        duration:     { type: "number", description: "Duration in seconds" },
        max_messages: { type: "number", description: "Stop after this many messages", default: 100 },
      },
      required: ["topic", "duration"],
    },
    handler: async ({ topic, duration, max_messages = 100 }) => {
      const msgs = await subscribeForDuration(topic, duration, max_messages);
      return { topic, messages: msgs, count: msgs.length };
    },
  },
  {
    name: "publish",
    description: "Publish a message to an MQTT topic.",
    parameters: {
      type: "object",
      properties: {
        topic:   { type: "string", description: "MQTT topic to publish to" },
        payload: { type: "string", description: "Message payload, e.g. 'true', 'false', or a JSON string" },
      },
      required: ["topic", "payload"],
    },
    handler: async ({ topic, payload }) => {
      if (!isConnected()) throw new Error("Not connected");
      state.mqttClient.publish(topic, payload);
      return { published: true, topic, payload };
    },
  },
  {
    name: "get_camera_stream",
    description: "Get the MJPEG stream URL for a device, if it has a camera. Returns the URL to open in a browser or embed in an <img> tag.",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Any MQTT topic belonging to the device, e.g. devices/d4e9f4a2a044/motors/command" },
      },
      required: ["topic"],
    },
    handler: async ({ topic }) => {
      const url = getTopicStream(topic);
      if (!url) return { error: "No camera stream available for this device" };
      return { stream_url: url };
    },
  },
  {
    name: "publish_sequence",
    description: "Publish a sequence of messages to a topic with delays between each.",
    parameters: {
      type: "object",
      properties: {
        topic:     { type: "string" },
        payloads:  { type: "array", items: { type: "string" }, description: "Array of message payloads" },
        durations: { type: "array", items: { type: "number" }, description: "Delay in seconds after each message" },
      },
      required: ["topic", "payloads", "durations"],
    },
    handler: async ({ topic, payloads, durations }) => {
      if (!isConnected()) throw new Error("Not connected");
      for (let i = 0; i < payloads.length; i++) {
        state.mqttClient.publish(topic, payloads[i]);
        await sleep((durations[i] || 0) * 1000);
      }
      return { published: payloads.length, topic };
    },
  },
];

let _webmcpActive = false;

function registerWebMCPTools() {
  if (!navigator.modelContext) {
    console.info("[WebMCP] navigator.modelContext not available");
    updateWebMCPBadge(0);
    return;
  }

  let registered = 0;
  for (const tool of TOOLS) {
    try {
      navigator.modelContext.registerTool({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters,
        execute: (params) => chatExecuteToolCall(tool.name, params),
      });
      registered++;
    } catch (err) {
      console.warn(`[WebMCP] Failed to register "${tool.name}":`, err);
    }
  }

  console.info(`[WebMCP] Registered ${registered}/${TOOLS.length} tools`);
  updateWebMCPBadge(registered);
}

function updateWebMCPBadge(registered) {
  const dot = el("webmcp-status-dot");
  const text = el("webmcp-status-text");
  _webmcpActive = registered > 0;
  if (dot) {
    dot.className = "status-dot";
    if (_webmcpActive) dot.classList.add("connected");
  }
  if (text) {
    text.textContent = _webmcpActive ? `WebMCP · ${registered} tools` : "WebMCP · inactive";
  }
}

function appendToolLog(entry) {
  entry.id = ++_toolLogId;
  state.toolLog.unshift(entry);
  if (state.toolLog.length > 50) state.toolLog.pop();

  const badge = el("tool-log-badge");
  if (badge) {
    badge.textContent = state.toolLog.length;
    badge.hidden = false;
  }

  const list = el("tool-log-list");
  const body = el("log-body");
  if (!list || !body) return;

  if (state.toolLog.length === 1 && body.hidden) {
    body.hidden = false;
    el("log-toggle")?.setAttribute("aria-expanded", "true");
    const chevron = el("log-chevron");
    if (chevron) chevron.textContent = "▲";
  }

  if (!body.hidden) {
    list.insertBefore(createLogEntryEl(entry), list.firstChild);
  }
}

function createLogEntryEl(entry) {
  const el = document.createElement("div");
  el.className = "log-entry";

  const timeStr = entry.ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const isError = !!entry.result?.error;

  el.innerHTML = `
    <div class="log-entry-header">
      <span class="log-tool-name">${escHtml(entry.toolName)}</span>
      <span class="log-duration">${entry.durationMs}ms</span>
      <span class="log-time">${escHtml(timeStr)}</span>
      <button class="btn btn-sm log-replay-btn" title="Replay" aria-label="Replay ${escHtml(entry.toolName)}">↺</button>
    </div>
    <div class="log-params">${escHtml(JSON.stringify(entry.params))}</div>
    <div class="log-result${isError ? " log-result-error" : ""}">${escHtml(JSON.stringify(entry.result))}</div>
  `;

  el.querySelector(".log-replay-btn").addEventListener("click", () => replayToolCall(entry));
  return el;
}

async function replayToolCall(entry) {
  const result = await chatExecuteToolCall(entry.toolName, entry.params);
  if (result.error) {
    toast(`Replay failed: ${result.error}`, "error");
  } else {
    toast(`Replayed ${entry.toolName}`, "ok");
  }
}

function clearChatHistory() {
  chatState.convMsgs = [];
  el("chat-messages").innerHTML = "";
}

function resetChatBusy() {
  chatState.abortCtrl?.abort();
  chatState.busy = false;
  chatState.abortCtrl = null;
  el("chat-send").disabled = false;
  el("chat-abort").hidden = true;
}


const chatState = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  claudeKey: window.DASHBOARD_CONFIG?.anthropicApiKey || localStorage.getItem("webmcp-claude-key") || "",
  githubAuth: JSON.parse(localStorage.getItem("webmcp-gh-auth") || "null"),
  convMsgs: [],
  abortCtrl: null,
  busy: false,
};

function initChat() {
  const keyInput = el("chat-api-key");
  keyInput.value = chatState.claudeKey;

  const sel = el("chat-model-select");
  const saved = localStorage.getItem("webmcp-chat-model") || "anthropic:claude-sonnet-4-6";
  sel.value = saved;
  applyModelSelection(saved);

  sel.addEventListener("change", () => {
    localStorage.setItem("webmcp-chat-model", sel.value);
    applyModelSelection(sel.value);
    clearChatHistory();
  });

  el("chat-key-save").addEventListener("click", () => {
    chatState.claudeKey = keyInput.value.trim();
    localStorage.setItem("webmcp-claude-key", chatState.claudeKey);
    toast("API key saved", "ok");
  });

  el("chat-send").addEventListener("click", sendChatMsg);
  el("chat-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChatMsg();
    }
  });
  el("chat-abort").addEventListener("click", () => chatState.abortCtrl?.abort());
  el("chat-clear").addEventListener("click", clearChatHistory);
  document.addEventListener("keydown", (e) => {
    if (el("chat-panel")?.hidden) return;
    if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
    const active = document.activeElement;
    if (active?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(active?.tagName)) return;
    const chatInput = el("chat-input");
    if (chatInput && !chatInput.disabled) chatInput.focus();
  });

  el("chat-panel-toggle").addEventListener("click", () => {
    const panel = el("chat-panel");
    const btn = el("chat-panel-toggle");
    const open = panel.hidden;
    panel.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    btn.classList.toggle("active", open);
  });
}

function applyModelSelection(value) {
  const [provider, ...rest] = value.split(":");
  chatState.provider = provider;
  chatState.model = rest.join(":");
  el("chat-claude-bar").hidden = provider !== "anthropic";
  el("chat-github-bar").hidden = provider !== "github";
  el("github-notice").hidden = provider !== "github" || !!localStorage.getItem("webmcp-github-notice-dismissed");
  if (provider === "github") updateGitHubAuthBar();
}

function updateGitHubAuthBar() {
  const bar = el("chat-github-bar");
  if (!bar) return;
  bar.innerHTML = "";
  if (chatState.githubAuth) {
    const label = document.createElement("span");
    label.className = "github-user-label";
    label.textContent = `@${chatState.githubAuth.username}`;
    const disconnectBtn = document.createElement("button");
    disconnectBtn.className = "btn btn-sm github-disconnect-btn";
    disconnectBtn.textContent = "Disconnect";
    disconnectBtn.addEventListener("click", () => {
      chatState.githubAuth = null;
      localStorage.removeItem("webmcp-gh-auth");
      clearChatHistory();
      updateGitHubAuthBar();
    });
    bar.appendChild(label);
    bar.appendChild(disconnectBtn);
  } else {
    const connectBtn = document.createElement("button");
    connectBtn.className = "btn btn-sm github-connect-btn";
    connectBtn.textContent = "Connect GitHub";
    connectBtn.addEventListener("click", async () => {
      connectBtn.textContent = "Connecting…";
      connectBtn.disabled = true;
      try {
        chatState.githubAuth = await connectGitHub('read:user', 'mqtt-ai');
        localStorage.setItem("webmcp-gh-auth", JSON.stringify(chatState.githubAuth));
        updateGitHubAuthBar();
      } catch (err) {
        if (err.message !== "OAuth flow cancelled") toast(err.message, "error");
        connectBtn.textContent = "Connect GitHub";
        connectBtn.disabled = false;
      }
    });
    bar.appendChild(connectBtn);
  }
}

function getSystemPrompt() {
  const lines = [
    "You are an AI assistant embedded in the MQTT AI Dashboard.",
    "You have access to MQTT tools to inspect and control a robot via an MQTT broker.",
  ];
  if (isConnected()) {
    lines.push(`Connected to MQTT broker at ${state.url}.`);
    const preview = state.seenTopics.slice(0, 20).join(", ");
    const ellipsis = state.seenTopics.length > 20 ? "…" : "";
    lines.push(`Known topics (${state.seenTopics.length}): ${preview}${ellipsis}`);
  } else {
    const inputUrl = el("url-input")?.value?.trim();
    const urlHint = inputUrl ? ` The URL currently configured in the dashboard is: ${inputUrl}.` : "";
    lines.push(`Not connected to MQTT broker.${urlHint} Call connect_to_broker to connect — do not ask the user for the URL unless it is missing.`);
  }
  if (state.selected) {
    lines.push(`User is currently viewing topic "${state.selected.name}".`);
  }
  lines.push(
    "Publish payloads as plain strings (e.g. 'true', 'false', '42') or JSON strings.",
    "Use the provided tools to answer questions and control the robot. Be concise.",
  );
  return lines.join("\n");
}

function getClaudeTools() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

function getOpenAITools() {
  return TOOLS.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

async function chatExecuteToolCall(name, input) {
  const tool = TOOLS.find((t) => t.name === name);
  const t0 = Date.now();
  const result = tool
    ? await tool.handler(input).catch((err) => ({ error: String(err) }))
    : { error: `Unknown tool: ${name}` };
  appendToolLog({ toolName: name, params: input, result, ts: new Date(), durationMs: Date.now() - t0 });
  return result;
}

async function sendChatMsg() {
  const input = el("chat-input");
  const text = input.value.trim();
  if (!text || chatState.busy) return;

  const key = chatState.provider === "github" ? chatState.githubAuth?.token : chatState.claudeKey;
  if (chatState.provider !== "local" && !key) {
    if (chatState.provider === "github") {
      toast("Connect GitHub above", "error");
    } else {
      toast("Enter your Anthropic API key first", "error");
    }
    return;
  }

  input.value = "";
  chatState.convMsgs.push({ role: "user", content: text });
  appendChatMsg("user", text);
  chatState.busy = true;
  chatState.abortCtrl = new AbortController();
  el("chat-send").disabled = true;
  el("chat-abort").hidden = false;
  showChatSpinner();

  try {
    switch (chatState.provider) {
      case "local":
        await runConversationClaude(null, chatState.abortCtrl.signal, LOCAL_PROXY_URL);
        break;
      case "github":
        await runConversationGitHub(key, chatState.abortCtrl.signal);
        break;
      default:
        await runConversationClaude(key, chatState.abortCtrl.signal);
    }
  } catch (err) {
    handleStreamError(err);
  } finally {
    resetChatBusy();
  }
}

const LOCAL_PROXY_URL = "http://127.0.0.1:7337/claude";

async function fetchClaudeStream(apiKey, signal, url) {
  const headers = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
  if (apiKey) {
    headers["x-api-key"] = apiKey;
    headers["anthropic-dangerous-direct-browser-access"] = "true";
  }
  const res = await fetch(url, {
    method: "POST",
    signal,
    headers,
    body: JSON.stringify({
      model: chatState.model,
      max_tokens: 4096,
      system: getSystemPrompt(),
      messages: chatState.convMsgs,
      tools: getClaudeTools(),
      stream: true,
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`API ${res.status}: ${txt.slice(0, 200)}`);
  }
  return res.body;
}

async function runConversationClaude(apiKey, signal, url = "https://api.anthropic.com/v1/messages") {
  while (true) {
    let stream;
    try {
      stream = await fetchClaudeStream(apiKey, signal, url);
    } catch (err) {
      handleStreamError(err);
      return;
    }

    const contentBlocks = [];
    let textEl = null;
    let textContent = "";
    let toolInput = "";
    let blockType = null;
    let rafId = 0;

    try {
      for await (const { event, data } of parseSSEStream(stream)) {
        switch (event) {
          case "content_block_start": {
            const block = data.content_block;
            blockType = block.type;
            if (block.type === "text") {
              hideChatSpinner();
              textContent = block.text || "";
              textEl = appendChatMsg("assistant", textContent);
            } else if (block.type === "tool_use") {
              contentBlocks.push({ type: "tool_use", id: block.id, name: block.name, input: {} });
              toolInput = "";
              appendChatToolCall(block.id, block.name);
            }
            break;
          }
          case "content_block_delta": {
            if (data.delta.type === "text_delta") {
              textContent += data.delta.text;
              if (textEl && !rafId) {
                rafId = requestAnimationFrame(() => {
                  rafId = 0;
                  if (textEl) textEl.innerHTML = renderMarkdown(textContent);
                  scrollChatBottom();
                });
              }
            } else if (data.delta.type === "input_json_delta") {
              toolInput += data.delta.partial_json;
            }
            break;
          }
          case "content_block_stop": {
            if (blockType === "text" && textContent) {
              rafId = flushStreamingText(textEl, textContent, rafId);
              contentBlocks.push({ type: "text", text: textContent });
              textEl = null;
              textContent = "";
            } else if (blockType === "tool_use") {
              const toolBlock = contentBlocks[contentBlocks.length - 1];
              try {
                toolBlock.input = toolInput ? JSON.parse(toolInput) : {};
              } catch (e) {
                console.warn("Failed to parse tool input JSON", e);
                toolBlock.input = {};
              }
              toolInput = "";
            }
            blockType = null;
            break;
          }
        }
      }
    } catch (err) {
      handleStreamError(err, "Stream error: ");
      return;
    }

    chatState.convMsgs.push({ role: "assistant", content: contentBlocks });
    const toolUses = contentBlocks.filter(b => b.type === "tool_use");
    if (toolUses.length === 0) {
      hideChatSpinner();
      return;
    }

    const toolResults = [];
    for (const tu of toolUses) {
      const result = await chatExecuteToolCall(tu.name, tu.input);
      updateChatToolCall(tu.id, result, tu.input);
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result) });
    }
    chatState.convMsgs.push({ role: "user", content: toolResults });
    showChatSpinner();
  }
}

async function* readStreamLines(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) yield line;
    }
  } finally {
    reader.releaseLock();
  }
}

async function* parseSSEStream(body) {
  let currentEvent = null;
  for await (const line of readStreamLines(body)) {
    if (line.startsWith("event: ")) {
      currentEvent = line.slice(7).trim();
    } else if (line.startsWith("data: ") && currentEvent) {
      try {
        yield { event: currentEvent, data: JSON.parse(line.slice(6)) };
      } catch (e) { console.warn("Failed to parse SSE JSON", e); }
      currentEvent = null;
    }
  }
}

async function runConversationGitHub(token, signal) {
  while (true) {
    let body;
    try {
      const res = await fetch("https://models.github.ai/inference/chat/completions", {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          model: chatState.model,
          messages: [{ role: "system", content: getSystemPrompt() }, ...chatState.convMsgs],
          tools: getOpenAITools(),
          tool_choice: "auto",
          max_completion_tokens: 4096,
          stream: true,
        }),
      });
      if (!res.ok) {
        hideChatSpinner();
        if (res.status === 429) {
          appendRateLimitMsg();
          return;
        }
        const txt = await res.text();
        throw new Error(`API ${res.status}: ${txt.slice(0, 200)}`);
      }
      body = res.body;
    } catch (err) {
      handleStreamError(err);
      return;
    }

    let currentTextEl = null;
    let currentTextContent = "";
    let rafId = 0;
    const tcMap = {};

    try {
      for await (const chunk of parseOpenAIStream(body)) {
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          if (!currentTextEl) {
            hideChatSpinner();
            currentTextContent = "";
            currentTextEl = appendChatMsg("assistant", "");
          }
          currentTextContent += delta.content;
          if (!rafId) {
            rafId = requestAnimationFrame(() => {
              rafId = 0;
              if (currentTextEl) currentTextEl.innerHTML = renderMarkdown(currentTextContent);
              scrollChatBottom();
            });
          }
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const entry = tcMap[tc.index] ??= { id: "", name: "", arguments: "", _shown: false };
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name = tc.function.name;
            if (tc.function?.arguments) entry.arguments += tc.function.arguments;
            if (!entry._shown && entry.id && entry.name) {
              entry._shown = true;
              appendChatToolCall(entry.id, entry.name);
            }
          }
        }
      }
    } catch (err) {
      handleStreamError(err, "Stream error: ");
      return;
    }

    rafId = flushStreamingText(currentTextEl, currentTextContent, rafId);

    const toolCalls = Object.values(tcMap);
    const assistantMsg = { role: "assistant", content: currentTextContent || null };
    if (toolCalls.length) {
      assistantMsg.tool_calls = toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      }));
    }
    chatState.convMsgs.push(assistantMsg);

    if (toolCalls.length === 0) {
      hideChatSpinner();
      return;
    }

    for (const tc of toolCalls) {
      let parsedArgs;
      try {
        parsedArgs = JSON.parse(tc.arguments || "{}");
      } catch (e) {
        console.warn("Failed to parse OpenAI tool call arguments", e);
        parsedArgs = {};
      }
      const result = await chatExecuteToolCall(tc.name, parsedArgs);
      updateChatToolCall(tc.id, result, parsedArgs);
      chatState.convMsgs.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
    }
    showChatSpinner();
  }
}

async function* parseOpenAIStream(body) {
  for await (const line of readStreamLines(body)) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (payload === "[DONE]") return;
    try {
      yield JSON.parse(payload);
    } catch (e) { console.warn("Failed to parse OpenAI stream chunk", e); }
  }
}

function appendChatMsg(role, text) {
  const container = el("chat-messages");
  const node = document.createElement("div");
  node.className = `chat-msg chat-msg-${role}`;
  if (role === "assistant") {
    node.innerHTML = renderMarkdown(text);
  } else {
    node.textContent = text;
    if (role === "user") {
      const msgIndex = chatState.convMsgs.length - 1;
      node.addEventListener("contextmenu", e => showMsgContextMenu(e, node, text, msgIndex));
    }
  }
  container.appendChild(node);
  scrollChatBottom();
  return node;
}

function truncateConvAt(msgEl, msgIndex) {
  if (chatState.busy) resetChatBusy();
  hideChatSpinner();
  while (msgEl.nextSibling) msgEl.nextSibling.remove();
  msgEl.remove();
  chatState.convMsgs.splice(msgIndex);
}

function showMsgContextMenu(e, msgEl, text, msgIndex) {
  e.preventDefault();
  el("chat-ctx-menu")?.remove();

  const menu = document.createElement("div");
  menu.id = "chat-ctx-menu";
  menu.className = "chat-ctx-menu";
  menu.innerHTML = `
    <button class="chat-ctx-item" data-action="edit">Edit</button>
    <button class="chat-ctx-item" data-action="resend">Resend</button>
  `;
  menu.style.left = `${e.clientX}px`;
  menu.style.top  = `${e.clientY}px`;
  document.body.appendChild(menu);

  const r = menu.getBoundingClientRect();
  if (r.right  > window.innerWidth)  menu.style.left = `${e.clientX - r.width}px`;
  if (r.bottom > window.innerHeight) menu.style.top  = `${e.clientY - r.height}px`;

  menu.addEventListener("click", (evt) => {
    const action = evt.target.dataset.action;
    if (!action) return;
    menu.remove();
    truncateConvAt(msgEl, msgIndex);
    const input = el("chat-input");
    input.value = text;
    if (action === "resend") {
      sendChatMsg();
    } else {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  });

  const dismiss = () => menu.remove();
  setTimeout(() => document.addEventListener("click", dismiss, { once: true }), 0);
  document.addEventListener("keydown", (evt) => {
    if (evt.key === "Escape") menu.remove();
  }, { once: true });
}

function nextGptModel() {
  const sel = el("chat-model-select");
  const opts = Array.from(sel.options);
  const idx = opts.findIndex(o => o.value === sel.value);
  return opts.slice(idx + 1).find(o => o.value.startsWith("github:openai/gpt")) || null;
}

function appendRateLimitMsg() {
  const next = nextGptModel();
  const container = el("chat-messages");
  const node = document.createElement("div");
  node.className = "chat-msg chat-msg-error";
  if (next) {
    node.innerHTML = `Rate limit reached. <a href="#" class="chat-rate-limit-link">Switch to ${escHtml(next.text)}</a>`;
    node.querySelector("a").addEventListener("click", e => {
      e.preventDefault();
      const sel = el("chat-model-select");
      sel.value = next.value;
      localStorage.setItem("webmcp-chat-model", next.value);
      applyModelSelection(next.value);
      node.remove();
    });
  } else {
    node.textContent = "Rate limit reached. No fallback model available.";
  }
  container.appendChild(node);
  scrollChatBottom();
}

function appendChatToolCall(toolId, toolName) {
  const container = el("chat-messages");
  const node = document.createElement("details");
  node.className = "chat-tool-call";
  node.dataset.toolId = toolId;
  node.innerHTML = `
    <summary class="chat-tool-call-header">
      <span class="chat-tool-call-icon">⚙</span>
      <span class="chat-tool-call-name">${escHtml(toolName)}</span>
      <span class="chat-tool-call-subtitle"></span>
      <span class="chat-tool-call-status">running…</span>
    </summary>
    <div class="chat-tool-call-body">Waiting for result…</div>
  `;
  container.appendChild(node);
  scrollChatBottom();
}

function updateChatToolCall(toolId, result, params) {
  const el = document.querySelector(`.chat-tool-call[data-tool-id="${CSS.escape(toolId)}"]`);
  if (!el) return;
  const isError = !!result?.error;

  const statusEl = el.querySelector(".chat-tool-call-status");
  if (statusEl) {
    statusEl.textContent = isError ? "error" : "done";
    statusEl.className = "chat-tool-call-status " + (isError ? "error" : "ok");
  }

  const subtitleEl = el.querySelector(".chat-tool-call-subtitle");
  const key = params?.topic || params?.url || "";
  if (subtitleEl && key) subtitleEl.textContent = key;

  const bodyEl = el.querySelector(".chat-tool-call-body");
  if (bodyEl) bodyEl.textContent = JSON.stringify(result, null, 2);
}

function showChatSpinner() {
  hideChatSpinner();
  const container = el("chat-messages");
  const node = document.createElement("div");
  node.className = "chat-spinner";
  node.id = "chat-spinner";
  node.innerHTML = "<span></span><span></span><span></span>";
  container.appendChild(node);
  scrollChatBottom();
}

function hideChatSpinner() {
  el("chat-spinner")?.remove();
}

function handleStreamError(err, prefix = "") {
  hideChatSpinner();
  if (err.name !== "AbortError") {
    appendChatMsg("error", prefix + err.message);
  }
}

function scrollChatBottom() {
  const msgs = el("chat-messages");
  if (msgs) msgs.scrollTop = msgs.scrollHeight;
}

function flushStreamingText(textEl, textContent, rafId) {
  if (rafId) cancelAnimationFrame(rafId);
  if (textEl) textEl.innerHTML = renderMarkdown(textContent);
  return 0;
}

marked.use({ gfm: true, breaks: true });

function renderMarkdown(text) {
  if (!text) return "";
  return DOMPurify.sanitize(marked.parse(text));
}

el("topbar-home-btn").addEventListener("click", () => {
  state.selected = null;
  renderSidebar();
  renderMainPlaceholder();
});

el("connect-btn").addEventListener("click", () => {
  if (state.connected) {
    state.manualDisconnect = true;
    cancelReconnect();
    state.mqttClient?.end(true);
    return;
  }
  const url = el("url-input").value.trim();
  if (url) connect(url);
});

el("url-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") el("connect-btn").click();
});

const presetsBtn = el("url-presets-btn");
const presetsPopover = el("url-presets-popover");

presetsBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  presetsPopover.hidden = !presetsPopover.hidden;
});

presetsPopover.querySelectorAll(".url-preset-item").forEach(item => {
  item.addEventListener("click", () => {
    el("url-input").value = item.dataset.url;
    presetsPopover.hidden = true;
  });
});

el("sidebar-filter").addEventListener("input", (e) => {
  state.filter = e.target.value;
  renderSidebar();
});

el("topic-add-input").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const topic = e.target.value.trim();
  if (!topic) return;
  trackTopic(topic);
  selectTopic(topic);
  e.target.value = "";
});

for (const btn of document.querySelectorAll("[data-section]")) {
  btn.addEventListener("click", () => {
    const section = btn.dataset.section;
    if (section in state.sidebarCollapsed) {
      state.sidebarCollapsed[section] = !state.sidebarCollapsed[section];
      renderSidebar();
    }
  });
}

el("github-notice-dismiss").addEventListener("click", () => {
  localStorage.setItem("webmcp-github-notice-dismissed", "1");
  el("github-notice").hidden = true;
});

el("log-toggle").addEventListener("click", () => {
  const body = el("log-body");
  const expanding = body.hidden;
  body.hidden = !expanding;
  el("log-toggle").setAttribute("aria-expanded", String(expanding));
  el("log-chevron").textContent = expanding ? "▲" : "▼";

  if (expanding) {
    const list = el("tool-log-list");
    list.innerHTML = "";
    for (const entry of state.toolLog) list.appendChild(createLogEntryEl(entry));
  }
});

function initTopicPrefix() {
  const input = el("topic-prefix-input");
  input.value = state.topicPrefix;
  el("topic-prefix-save").addEventListener("click", () => {
    const val = input.value.trim();
    const normalized = val && !val.endsWith("/") ? val + "/" : val;
    input.value = normalized;
    state.topicPrefix = normalized;
    localStorage.setItem("webmcp-topic-prefix", normalized);
    toast("Prefix saved — reconnect to apply", "ok");
  });
}

registerWebMCPTools();
initChat();
initTopicPrefix();
initDpadKeyListeners();

el("webmcp-status-row").addEventListener("click", () => {
  const popover = el("webmcp-tools-popover");
  if (!popover) return;
  if (!popover.hidden) { popover.hidden = true; return; }

  popover.innerHTML = "";

  const header = document.createElement("div");
  header.className = "webmcp-popover-header";
  const titleText = _webmcpActive ? "WebMCP · active" : "WebMCP · inactive";
  const explainHTML = _webmcpActive
    ? `These ${TOOLS.length} tools are registered with your browser's AI context, so native browser AI agents can call them directly. The <strong>AI chat panel</strong> on this page uses the same tools independently via the Anthropic/GitHub API — no flag needed.`
    : `The <strong>AI chat panel</strong> on this page already uses these ${TOOLS.length} tools directly via the Anthropic/GitHub API — no flag needed. WebMCP would <em>also</em> expose them to native browser AI agents. Requires Chrome 146+ Canary → <code>chrome://flags/#webmcp-for-testing</code>.`;
  header.innerHTML = `
    <div class="webmcp-popover-title">${titleText}</div>
    <div class="webmcp-popover-explain">${explainHTML}</div>
  `;
  popover.appendChild(header);

  const divider = document.createElement("div");
  divider.className = "webmcp-popover-divider";
  divider.textContent = "Tools";
  popover.appendChild(divider);

  for (const tool of TOOLS) {
    const item = document.createElement("div");
    item.className = "webmcp-popover-item";
    item.innerHTML = `
      <div class="webmcp-popover-name">${escHtml(tool.name)}</div>
      <div class="webmcp-popover-desc">${escHtml(tool.description)}</div>
    `;
    popover.appendChild(item);
  }

  popover.hidden = false;
});

const settingsBtn = el("settings-btn");
const settingsPopover = el("settings-popover");

settingsBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const opening = settingsPopover.hidden;
  settingsPopover.hidden = !opening;
  settingsBtn.setAttribute("aria-expanded", String(opening));
});

const _darkMq = window.matchMedia("(prefers-color-scheme: dark)");

function resolveTheme(pref) {
  if (pref === "dark" || pref === "light") return pref;
  return _darkMq.matches ? "dark" : "light";
}

function applyTheme(preference) {
  localStorage.setItem("webmcp-theme", preference);
  document.documentElement.setAttribute("data-theme", resolveTheme(preference));
  document.querySelectorAll(".theme-opt").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.theme === preference);
  });
}

_darkMq.addEventListener("change", () => {
  const saved = localStorage.getItem("webmcp-theme") || "system";
  if (saved === "system") applyTheme("system");
});

document.querySelectorAll(".theme-opt").forEach(btn => {
  btn.addEventListener("click", () => applyTheme(btn.dataset.theme));
});

applyTheme(localStorage.getItem("webmcp-theme") || "system");

function updateChatModelLabel() {
  const sel = el("chat-model-select");
  const label = el("chat-model-label");
  if (!sel || !label) return;
  const text = sel.options[sel.selectedIndex]?.text || "";
  label.textContent = text.replace(/^(?:GitHub · |Claude )/, "");
}

el("chat-model-select").addEventListener("change", updateChatModelLabel);
updateChatModelLabel();

// Close all popovers on outside click or Escape

function closeAllPopovers(except) {
  if (except !== "presets") presetsPopover.hidden = true;
  if (except !== "settings") {
    settingsPopover.hidden = true;
    settingsBtn.setAttribute("aria-expanded", "false");
  }
  if (except !== "webmcp") {
    const wmcp = el("webmcp-tools-popover");
    if (wmcp) wmcp.hidden = true;
  }
}

document.addEventListener("click", (e) => {
  const target = e.target;
  if (target.closest(".url-wrap")) return closeAllPopovers("presets");
  if (target.closest(".settings-wrap")) return closeAllPopovers("settings");
  if (target.closest("#webmcp-status-wrap")) return closeAllPopovers("webmcp");
  closeAllPopovers();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeAllPopovers();
});

el("url-input").value = state.url;
connect(state.url);
