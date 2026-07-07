"use strict";

/* ============================================================
   Messenger — чистый клиентский код (HTML/CSS/JS), без своего
   сервера. Аутентификация и данные — Firebase Auth + Realtime
   Database (бесплатный тариф Spark, настраивается в браузере).

   Структура данных в Realtime Database:
     /users/{uid}            -> { name, email, avatarColor, createdAt }
     /presence/{uid}         -> { online, lastSeen }
     /userChats/{uid}/{chatId} -> true                (индекс чатов пользователя)
     /chats/{chatId}          -> { type, name, members:{uid:true}, createdBy, createdAt, lastMessage }
     /messages/{chatId}/{id}  -> { senderId, senderName, content, createdAt, status }
     /typing/{chatId}/{uid}   -> timestamp             (присутствует = печатает)
     /directIndex/{uidA_uidB} -> chatId                (чтобы не плодить дубли личных чатов)

   Важно про безопасность от XSS: весь текст сообщений и имена
   вставляются через textContent, никогда через innerHTML — поэтому
   HTML/скрипты в тексте сообщения не выполняются.
   ============================================================ */

const auth = firebase.auth();
const db = firebase.database();

const AVATAR_COLORS = ["#e17076", "#7bc862", "#65aadd", "#a695e7", "#eb6f8e", "#f2924f", "#59a8d1", "#d9a339"];

let currentUser = null;       // { uid, name, email, avatarColor }
let currentChatId = null;
let chats = {};                // chatId -> chat object (с полями из /chats + вычисленными)
let chatUnsubscribers = {};    // chatId -> функция отписки value-листенера на /chats/{chatId}
let messagesRef = null;
let typingRef = null;
let typingTimeout = null;
let othersTyping = {};         // uid -> name, для текущего открытого чата
let presenceCache = {};        // uid -> {online, lastSeen}, для карточек direct-чатов
let presenceListeners = {};    // uid -> unsubscribe
let newChatMode = "direct";
let selectedUsers = [];        // для модалки создания чата

// ---------- Вспомогательные функции ----------

function $(id) { return document.getElementById(id); }

function showScreen(name) {
  ["loading", "login", "register", "app"].forEach((s) => $("screen-" + s).classList.add("hidden"));
  $("screen-" + name).classList.remove("hidden");
}

function showToast(text) {
  const toast = $("toast");
  toast.textContent = text;
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 2500);
}

function initials(name) {
  const parts = String(name || "?").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function randomAvatarColor() {
  return AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
}

function renderAvatarInto(el, name, color, options) {
  options = options || {};
  el.innerHTML = "";
  el.style.background = color || "#5288c1";
  el.textContent = initials(name);
  if (options.status !== undefined) {
    const dot = document.createElement("span");
    dot.className = "status-dot" + (options.status ? " online" : "");
    el.appendChild(dot);
  }
}

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function formatLastSeen(ts) {
  if (!ts) return "не в сети";
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `был(а) в сети сегодня в ${formatTime(ts)}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `был(а) в сети вчера в ${formatTime(ts)}`;
  return `был(а) в сети ${d.toLocaleDateString("ru-RU")} в ${formatTime(ts)}`;
}

function sanitizeContent(raw) {
  return String(raw || "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, 4000);
}

function otherMemberId(chat) {
  if (!chat || chat.type !== "direct" || !chat.members) return null;
  return Object.keys(chat.members).find((uid) => uid !== currentUser.uid) || null;
}

// ---------- Аутентификация ----------

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("login-error").textContent = "";
  const email = $("login-email").value.trim();
  const password = $("login-password").value;
  try {
    await auth.signInWithEmailAndPassword(email, password);
  } catch (err) {
    $("login-error").textContent = translateAuthError(err);
  }
});

$("register-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("register-error").textContent = "";
  const name = $("register-name").value.trim();
  const email = $("register-email").value.trim();
  const password = $("register-password").value;
  if (!name) { $("register-error").textContent = "Введите имя"; return; }
  try {
    const cred = await auth.createUserWithEmailAndPassword(email, password);
    await db.ref("users/" + cred.user.uid).set({
      name, nameLower: name.toLowerCase(), email, avatarColor: randomAvatarColor(),
      createdAt: firebase.database.ServerValue.TIMESTAMP,
    });
  } catch (err) {
    $("register-error").textContent = translateAuthError(err);
  }
});

function translateAuthError(err) {
  const map = {
    "auth/email-already-in-use": "Пользователь с таким email уже существует",
    "auth/invalid-email": "Некорректный email",
    "auth/weak-password": "Пароль должен содержать минимум 6 символов",
    "auth/user-not-found": "Неверный email или пароль",
    "auth/wrong-password": "Неверный email или пароль",
    "auth/invalid-credential": "Неверный email или пароль",
    "auth/too-many-requests": "Слишком много попыток. Попробуйте позже",
    "auth/network-request-failed": "Проблема с сетью. Проверьте соединение",
  };
  return map[err.code] || "Ошибка: " + err.message;
}

$("go-register").addEventListener("click", (e) => { e.preventDefault(); showScreen("register"); });
$("go-login").addEventListener("click", (e) => { e.preventDefault(); showScreen("login"); });

$("btn-logout").addEventListener("click", async () => {
  await setPresenceOffline();
  await auth.signOut();
});

auth.onAuthStateChanged(async (user) => {
  teardownAppListeners();
  if (!user) {
    showScreen("login");
    return;
  }
  const snap = await db.ref("users/" + user.uid).get();
  const profile = snap.val();
  if (!profile) {
    // Профиль ещё не записался (редкая гонка сразу после регистрации) — подождём.
    setTimeout(() => auth.onAuthStateChanged, 300);
    return;
  }
  currentUser = { uid: user.uid, name: profile.name, email: profile.email, avatarColor: profile.avatarColor };
  renderAvatarInto($("my-avatar"), currentUser.name, currentUser.avatarColor);
  $("my-name").textContent = currentUser.name;
  $("my-email").textContent = currentUser.email;
  showScreen("app");
  setupPresence(user.uid);
  listenUserChats(user.uid);
});

// ---------- Присутствие (онлайн/оффлайн) ----------

function setupPresence(uid) {
  const myPresenceRef = db.ref("presence/" + uid);
  const connectedRef = db.ref(".info/connected");
  connectedRef.on("value", (snap) => {
    if (snap.val() === true) {
      myPresenceRef.onDisconnect().set({ online: false, lastSeen: firebase.database.ServerValue.TIMESTAMP }).then(() => {
        myPresenceRef.set({ online: true, lastSeen: firebase.database.ServerValue.TIMESTAMP });
      });
    }
  });
}

async function setPresenceOffline() {
  if (!currentUser) return;
  try {
    await db.ref("presence/" + currentUser.uid).set({ online: false, lastSeen: firebase.database.ServerValue.TIMESTAMP });
  } catch (e) { /* ignore */ }
}

function watchPresence(uid, cb) {
  if (presenceListeners[uid]) return;
  const ref = db.ref("presence/" + uid);
  const handler = (snap) => {
    presenceCache[uid] = snap.val() || { online: false, lastSeen: 0 };
    cb(presenceCache[uid]);
  };
  ref.on("value", handler);
  presenceListeners[uid] = () => ref.off("value", handler);
}

// ---------- Список чатов ----------

function listenUserChats(uid) {
  const ref = db.ref("userChats/" + uid);
  ref.on("child_added", (snap) => attachChatListener(snap.key));
  ref.on("child_removed", (snap) => detachChatListener(snap.key));
  chatUnsubscribers["__index__"] = () => ref.off();
}

function attachChatListener(chatId) {
  if (chatUnsubscribers[chatId]) return;
  const ref = db.ref("chats/" + chatId);
  const handler = (snap) => {
    const data = snap.val();
    if (!data) return;
    chats[chatId] = Object.assign({ id: chatId }, data);
    if (chats[chatId].type === "direct") {
      const otherId = otherMemberId(chats[chatId]);
      if (otherId) {
        watchPresence(otherId, () => renderChatList());
        db.ref("users/" + otherId).get().then((s) => {
          const u = s.val();
          if (u) {
            chats[chatId].displayName = u.name;
            chats[chatId].displayColor = u.avatarColor;
            renderChatList();
            if (chatId === currentChatId) renderChatHeader();
          }
        });
      }
    } else {
      chats[chatId].displayName = data.name || "Группа";
      chats[chatId].displayColor = "#5288c1";
    }
    renderChatList();
    if (chatId === currentChatId) renderChatHeader();
  };
  ref.on("value", handler);
  const unreadRef = db.ref("messages/" + chatId).orderByChild("createdAt");
  unreadRef.on("value", unreadHandlerFor(chatId));
  chatUnsubscribers[chatId] = () => {
    ref.off("value", handler);
    unreadRef.off();
  };
}

function detachChatListener(chatId) {
  if (chatUnsubscribers[chatId]) { chatUnsubscribers[chatId](); delete chatUnsubscribers[chatId]; }
  delete chats[chatId];
  renderChatList();
}

function teardownAppListeners() {
  Object.values(chatUnsubscribers).forEach((fn) => fn());
  chatUnsubscribers = {};
  Object.values(presenceListeners).forEach((fn) => fn());
  presenceListeners = {};
  chats = {};
  currentChatId = null;
  detachMessageListeners();
}

function renderChatList() {
  const list = $("chat-list");
  const query = $("chat-search").value.trim().toLowerCase();
  const items = Object.values(chats)
    .filter((c) => (c.displayName || "").toLowerCase().includes(query))
    .sort((a, b) => (b.lastMessage?.createdAt || 0) - (a.lastMessage?.createdAt || 0));

  list.innerHTML = "";
  $("chat-list-empty").classList.toggle("hidden", Object.keys(chats).length !== 0);

  if (items.length === 0 && Object.keys(chats).length > 0) {
    const p = document.createElement("div");
    p.className = "empty-hint";
    p.textContent = "Ничего не найдено";
    list.appendChild(p);
    return;
  }

  for (const chat of items) {
    const item = document.createElement("div");
    item.className = "chat-item" + (chat.id === currentChatId ? " active" : "");
    item.addEventListener("click", () => selectChat(chat.id));

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    const isDirect = chat.type === "direct";
    const online = isDirect ? (presenceCache[otherMemberId(chat)]?.online || false) : undefined;
    renderAvatarInto(avatar, chat.displayName, chat.displayColor, isDirect ? { status: online } : {});

    const info = document.createElement("div");
    info.className = "chat-item-info";

    const top = document.createElement("div");
    top.className = "chat-item-top";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = chat.displayName || "…";
    top.appendChild(name);
    if (chat.lastMessage) {
      const time = document.createElement("span");
      time.className = "chat-item-time";
      time.textContent = formatTime(chat.lastMessage.createdAt);
      top.appendChild(time);
    }

    const bottom = document.createElement("div");
    bottom.className = "chat-item-bottom";
    const preview = document.createElement("span");
    preview.className = "chat-item-preview";
    preview.textContent = chat.lastMessage ? chat.lastMessage.content : "Нет сообщений";
    bottom.appendChild(preview);
    const unread = computeUnread(chat);
    if (unread > 0) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = String(unread);
      bottom.appendChild(badge);
    }

    info.appendChild(top);
    info.appendChild(bottom);
    item.appendChild(avatar);
    item.appendChild(info);
    list.appendChild(item);
  }
}

const unreadCounts = {}; // chatId -> число непрочитанных

function computeUnread(chat) {
  return unreadCounts[chat.id] || 0;
}

function unreadHandlerFor(chatId) {
  return (snap) => {
    let count = 0;
    snap.forEach((child) => {
      const m = child.val();
      if (m.senderId !== currentUser.uid && m.status !== "read") count++;
    });
    unreadCounts[chatId] = chatId === currentChatId ? 0 : count;
    renderChatList();
  };
}

$("chat-search").addEventListener("input", renderChatList);

// ---------- Открытие чата и сообщения ----------

function detachMessageListeners() {
  if (messagesRef) { messagesRef.off(); messagesRef = null; }
  if (typingRef) { typingRef.off(); typingRef = null; }
  othersTyping = {};
}

async function selectChat(chatId) {
  currentChatId = chatId;
  unreadCounts[chatId] = 0;
  $("screen-app").classList.add("show-chat");
  $("chat-empty").classList.add("hidden");
  $("chat-active").classList.remove("hidden");
  $("messages").innerHTML = "";
  renderChatHeader();
  renderChatList();

  detachMessageListeners();

  messagesRef = db.ref("messages/" + chatId).orderByChild("createdAt").limitToLast(200);
  const renderedIds = new Set();

  messagesRef.on("child_added", (snap) => {
    const msg = Object.assign({ id: snap.key }, snap.val());
    renderedIds.add(msg.id);
    appendMessage(msg);
    scrollMessagesToBottom();
    if (msg.senderId !== currentUser.uid) {
      markDeliveredIfNeeded(chatId, msg);
      if (chatId === currentChatId) markReadIfNeeded(chatId, msg);
    }
  });

  messagesRef.on("child_changed", (snap) => {
    const msg = Object.assign({ id: snap.key }, snap.val());
    updateMessageStatus(msg);
  });

  typingRef = db.ref("typing/" + chatId);
  typingRef.on("value", (snap) => {
    othersTyping = {};
    snap.forEach((child) => {
      if (child.key !== currentUser.uid) othersTyping[child.key] = true;
    });
    renderTypingIndicator();
  });
}

function renderChatHeader() {
  const chat = chats[currentChatId];
  if (!chat) return;
  renderAvatarInto($("chat-avatar"), chat.displayName, chat.displayColor);
  $("chat-title").textContent = chat.displayName || "…";

  if (chat.type === "direct") {
    const otherId = otherMemberId(chat);
    const presence = presenceCache[otherId] || {};
    $("chat-subtitle").textContent = presence.online ? "в сети" : formatLastSeen(presence.lastSeen);
  } else {
    const count = chat.members ? Object.keys(chat.members).length : 0;
    $("chat-subtitle").textContent = `${count} участников`;
  }
}

function renderTypingIndicator() {
  const chat = chats[currentChatId];
  const existing = document.getElementById("typing-indicator");
  if (existing) existing.remove();

  const names = Object.keys(othersTyping);
  $("chat-subtitle").textContent = names.length > 0
    ? "печатает..."
    : (chat ? (chat.type === "direct"
        ? ((presenceCache[otherMemberId(chat)] || {}).online ? "в сети" : formatLastSeen((presenceCache[otherMemberId(chat)] || {}).lastSeen))
        : `${Object.keys(chat.members || {}).length} участников`) : "");

  if (names.length > 0) {
    const row = document.createElement("div");
    row.className = "msg-row";
    row.id = "typing-indicator";
    const bubble = document.createElement("div");
    bubble.className = "typing-row";
    bubble.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
    row.appendChild(bubble);
    $("messages").appendChild(row);
    scrollMessagesToBottom();
  }
}

function appendMessage(msg) {
  const chat = chats[currentChatId];
  const isOwn = msg.senderId === currentUser.uid;
  const row = document.createElement("div");
  row.className = "msg-row" + (isOwn ? " own" : "");
  row.dataset.msgId = msg.id;

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";

  if (!isOwn && chat && chat.type === "group") {
    const sender = document.createElement("span");
    sender.className = "msg-sender";
    sender.textContent = msg.senderName || "";
    bubble.appendChild(sender);
  }

  const text = document.createElement("span");
  text.className = "msg-text";
  text.textContent = msg.content; // textContent — безопасно от XSS
  bubble.appendChild(text);

  const meta = document.createElement("span");
  meta.className = "msg-meta";
  const time = document.createElement("span");
  time.textContent = formatTime(msg.createdAt);
  meta.appendChild(time);
  if (isOwn) {
    const status = document.createElement("span");
    status.className = "msg-status" + (msg.status === "read" ? " read" : "");
    status.textContent = msg.status === "read" ? "✓✓" : msg.status === "delivered" ? "✓✓" : "✓";
    meta.appendChild(status);
  }
  bubble.appendChild(meta);

  row.appendChild(bubble);
  const typingIndicator = document.getElementById("typing-indicator");
  if (typingIndicator) $("messages").insertBefore(row, typingIndicator);
  else $("messages").appendChild(row);
}

function updateMessageStatus(msg) {
  const row = document.querySelector(`.msg-row[data-msg-id="${msg.id}"]`);
  if (!row) return;
  const statusEl = row.querySelector(".msg-status");
  if (!statusEl) return;
  statusEl.textContent = msg.status === "read" ? "✓✓" : msg.status === "delivered" ? "✓✓" : "✓";
  statusEl.classList.toggle("read", msg.status === "read");
}

function scrollMessagesToBottom() {
  const el = $("messages");
  requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
}

function markDeliveredIfNeeded(chatId, msg) {
  if (msg.status === "sent") {
    db.ref(`messages/${chatId}/${msg.id}/status`).set("delivered");
  }
}

function markReadIfNeeded(chatId, msg) {
  if (msg.status !== "read") {
    db.ref(`messages/${chatId}/${msg.id}/status`).set("read");
  }
}

$("btn-back").addEventListener("click", () => {
  $("screen-app").classList.remove("show-chat");
});

// ---------- Отправка сообщений ----------

$("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("composer-input");
  const content = sanitizeContent(input.value);
  if (!content || !currentChatId) return;
  input.value = "";
  autoResizeTextarea(input);
  stopTyping();

  const chatId = currentChatId;
  const newRef = db.ref("messages/" + chatId).push();
  const msg = {
    senderId: currentUser.uid,
    senderName: currentUser.name,
    content,
    createdAt: firebase.database.ServerValue.TIMESTAMP,
    status: "sent",
  };
  await newRef.set(msg);
  await db.ref("chats/" + chatId + "/lastMessage").set({
    content, senderId: currentUser.uid, createdAt: firebase.database.ServerValue.TIMESTAMP, status: "sent",
  });
});

const composerInput = $("composer-input");
composerInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("composer").requestSubmit(); }
});
composerInput.addEventListener("input", () => {
  autoResizeTextarea(composerInput);
  if (!currentChatId) return;
  startTyping();
});

function autoResizeTextarea(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 120) + "px";
}

function startTyping() {
  if (!currentChatId) return;
  const ref = db.ref(`typing/${currentChatId}/${currentUser.uid}`);
  ref.onDisconnect().remove();
  ref.set(firebase.database.ServerValue.TIMESTAMP);
  if (typingTimeout) clearTimeout(typingTimeout);
  typingTimeout = setTimeout(stopTyping, 2000);
}

function stopTyping() {
  if (typingTimeout) { clearTimeout(typingTimeout); typingTimeout = null; }
  if (currentChatId && currentUser) {
    db.ref(`typing/${currentChatId}/${currentUser.uid}`).remove();
  }
}

// ---------- Новый чат (модалка) ----------

$("btn-new-chat").addEventListener("click", () => openModal());
$("modal-close").addEventListener("click", () => closeModal());
$("modal-overlay").addEventListener("click", (e) => { if (e.target.id === "modal-overlay") closeModal(); });

function openModal() {
  newChatMode = "direct";
  selectedUsers = [];
  $("tab-direct").classList.add("active");
  $("tab-group").classList.remove("active");
  $("group-name").classList.add("hidden");
  $("group-name").value = "";
  $("user-search").value = "";
  $("user-results").innerHTML = "";
  $("modal-error").textContent = "";
  renderSelectedUsers();
  $("modal-overlay").classList.remove("hidden");
  setTimeout(() => $("user-search").focus(), 50);
}

function closeModal() { $("modal-overlay").classList.add("hidden"); }

$("tab-direct").addEventListener("click", () => switchMode("direct"));
$("tab-group").addEventListener("click", () => switchMode("group"));

function switchMode(mode) {
  newChatMode = mode;
  $("tab-direct").classList.toggle("active", mode === "direct");
  $("tab-group").classList.toggle("active", mode === "group");
  $("group-name").classList.toggle("hidden", mode !== "group");
  if (mode === "direct" && selectedUsers.length > 1) selectedUsers = [selectedUsers[0]];
  renderSelectedUsers();
}

function renderSelectedUsers() {
  const box = $("selected-users");
  box.innerHTML = "";
  for (const u of selectedUsers) {
    const chip = document.createElement("span");
    chip.className = "selected-chip";
    const nameSpan = document.createElement("span");
    nameSpan.textContent = u.name;
    const btn = document.createElement("button");
    btn.textContent = "×";
    btn.addEventListener("click", () => {
      selectedUsers = selectedUsers.filter((s) => s.uid !== u.uid);
      renderSelectedUsers();
      renderUserResults(lastSearchResults);
    });
    chip.appendChild(nameSpan);
    chip.appendChild(btn);
    box.appendChild(chip);
  }
}

let lastSearchResults = [];
let searchDebounce = null;

$("user-search").addEventListener("input", () => {
  clearTimeout(searchDebounce);
  const query = $("user-search").value.trim();
  if (!query) { $("user-results").innerHTML = ""; lastSearchResults = []; return; }
  searchDebounce = setTimeout(() => searchUsers(query), 250);
});

async function searchUsers(query) {
  try {
    const q = query.toLowerCase();
    const snap = await db.ref("users").orderByChild("nameLower").startAt(q).endAt(q + "\uf8ff").limitToFirst(20).get();
    const results = [];
    snap.forEach((child) => {
      if (child.key !== currentUser.uid) results.push(Object.assign({ uid: child.key }, child.val()));
    });
    lastSearchResults = results;
    renderUserResults(results);
  } catch (err) {
    console.error(err);
  }
}

function renderUserResults(results) {
  const box = $("user-results");
  box.innerHTML = "";
  if (results.length === 0) {
    const p = document.createElement("div");
    p.className = "no-results";
    p.textContent = "Никого не найдено";
    box.appendChild(p);
    return;
  }
  for (const u of results) {
    const isSelected = selectedUsers.some((s) => s.uid === u.uid);
    const row = document.createElement("div");
    row.className = "user-result" + (isSelected ? " selected" : "");
    row.addEventListener("click", () => toggleSelectUser(u));

    const avatar = document.createElement("div");
    avatar.className = "avatar sm";
    renderAvatarInto(avatar, u.name, u.avatarColor);

    const info = document.createElement("div");
    info.className = "user-result-info";
    const name = document.createElement("p");
    name.className = "name";
    name.textContent = u.name;
    const email = document.createElement("p");
    email.className = "muted";
    email.textContent = u.email;
    info.appendChild(name);
    info.appendChild(email);

    row.appendChild(avatar);
    row.appendChild(info);
    box.appendChild(row);
  }
}

function toggleSelectUser(u) {
  if (newChatMode === "direct") {
    selectedUsers = [u];
  } else {
    if (selectedUsers.some((s) => s.uid === u.uid)) selectedUsers = selectedUsers.filter((s) => s.uid !== u.uid);
    else selectedUsers.push(u);
  }
  renderSelectedUsers();
  renderUserResults(lastSearchResults);
}

$("modal-create").addEventListener("click", async () => {
  $("modal-error").textContent = "";
  if (selectedUsers.length === 0) { $("modal-error").textContent = "Выберите пользователя"; return; }
  const groupName = $("group-name").value.trim();
  if (newChatMode === "group" && !groupName) { $("modal-error").textContent = "Введите название группы"; return; }

  try {
    let chatId;
    if (newChatMode === "direct") {
      chatId = await getOrCreateDirectChat(selectedUsers[0].uid);
    } else {
      chatId = await createGroupChat(groupName, selectedUsers.map((u) => u.uid));
    }
    closeModal();
    selectChat(chatId);
  } catch (err) {
    console.error(err);
    $("modal-error").textContent = "Не удалось создать чат: " + err.message;
  }
});

async function getOrCreateDirectChat(otherUid) {
  const key = [currentUser.uid, otherUid].sort().join("_");
  const indexRef = db.ref("directIndex/" + key);
  const candidateId = db.ref("chats").push().key;

  const result = await indexRef.transaction((current) => current || candidateId);
  const finalChatId = result.snapshot.val();

  if (finalChatId === candidateId) {
    // мы выиграли гонку — создаём новый чат
    const now = firebase.database.ServerValue.TIMESTAMP;
    await db.ref("chats/" + candidateId).set({
      type: "direct",
      members: { [currentUser.uid]: true, [otherUid]: true },
      createdBy: currentUser.uid,
      createdAt: now,
    });
    await db.ref("userChats/" + currentUser.uid + "/" + candidateId).set(true);
    await db.ref("userChats/" + otherUid + "/" + candidateId).set(true);
  }
  return finalChatId;
}

async function createGroupChat(name, memberUids) {
  const chatId = db.ref("chats").push().key;
  const allMembers = Array.from(new Set([currentUser.uid, ...memberUids]));
  const membersMap = {};
  allMembers.forEach((uid) => (membersMap[uid] = true));

  await db.ref("chats/" + chatId).set({
    type: "group",
    name,
    members: membersMap,
    createdBy: currentUser.uid,
    createdAt: firebase.database.ServerValue.TIMESTAMP,
  });

  await Promise.all(allMembers.map((uid) => db.ref("userChats/" + uid + "/" + chatId).set(true)));
  return chatId;
}

// ---------- На всякий случай — корректно помечаем оффлайн при закрытии вкладки ----------
window.addEventListener("beforeunload", () => { setPresenceOffline(); });
