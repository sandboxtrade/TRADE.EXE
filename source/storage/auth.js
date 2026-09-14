const LEGACY_ACCOUNT_KEY = "sandbox:account";
const ACCOUNT_KEY = "tradeexe:account:persistent:v2";
const ACCOUNT_SESSION_KEY = "tradeexe:account:session:v2";
const ACCOUNT_DB_KEY = "tradeexe:accounts:v2";

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function readJson(storage, key, fallback = null) {
  try {
    const raw = storage?.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (_) { return fallback; }
}

function writeJson(storage, key, value) {
  try { storage?.setItem(key, JSON.stringify(value)); return true; }
  catch (_) { return false; }
}

function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function makeSalt() {
  try {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return bytesToHex(bytes);
  } catch (_) {
    return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  }
}

async function credentialHash(email, password, salt) {
  const value = `${normalizeEmail(email)}\u0000${salt}\u0000${String(password)}`;
  try {
    const data = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return bytesToHex(new Uint8Array(digest));
  } catch (_) {
    // Старые webview без SubtleCrypto: не криптография, а совместимый
    // fallback для локального прототипа. Production на него не опирается.
    let h1 = 2166136261 >>> 0;
    let h2 = 2246822519 >>> 0;
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
      h2 = Math.imul(h2 ^ c, 3266489917) >>> 0;
    }
    return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
  }
}

function loadAccountDb() {
  const db = readJson(localStorage, ACCOUNT_DB_KEY, {});
  return db && typeof db === "object" && !Array.isArray(db) ? db : {};
}

function saveAccountDb(db) {
  return writeJson(localStorage, ACCOUNT_DB_KEY, db);
}

function publicAccount(email, createdAt = Date.now()) {
  return { email: normalizeEmail(email), at: createdAt };
}

function persistCurrentAccount(account, remember) {
  try {
    localStorage.removeItem(LEGACY_ACCOUNT_KEY);
    localStorage.removeItem(ACCOUNT_KEY);
    sessionStorage.removeItem(ACCOUNT_SESSION_KEY);
  } catch (_) {}
  return remember
    ? writeJson(localStorage, ACCOUNT_KEY, account)
    : writeJson(sessionStorage, ACCOUNT_SESSION_KEY, account);
}

const authStore = {
  async current() {
    const session = readJson(sessionStorage, ACCOUNT_SESSION_KEY, null);
    if (session?.email) return publicAccount(session.email, session.at);

    const persistent = readJson(localStorage, ACCOUNT_KEY, null);
    if (persistent?.email) return publicAccount(persistent.email, persistent.at);

    // Миграция v51: сохранить уже активный старый аккаунт. Пароль у v51 не
    // существовал, поэтому credential record появится после новой регистрации.
    const legacy = readJson(localStorage, LEGACY_ACCOUNT_KEY, null);
    if (legacy?.email) {
      const account = publicAccount(legacy.email, legacy.at);
      persistCurrentAccount(account, true);
      return account;
    }
    return null;
  },

  async signIn(email, password, remember = true) {
    const id = normalizeEmail(email);
    if (!EMAIL_RE.test(id)) return { ok: false, reason: "неверный email" };
    if (String(password || "").length < 6) return { ok: false, reason: "неверный пароль" };
    const db = loadAccountDb();
    const rec = db[id];
    if (!rec?.salt || !rec?.hash) return { ok: false, reason: "аккаунт не найден" };
    const hash = await credentialHash(id, password, rec.salt);
    if (hash !== rec.hash) return { ok: false, reason: "неверный пароль" };
    const account = publicAccount(id, rec.createdAt || Date.now());
    persistCurrentAccount(account, remember);
    return { ok: true, account };
  },

  async signUp(email, password, remember = true) {
    const id = normalizeEmail(email);
    if (!EMAIL_RE.test(id)) return { ok: false, reason: "неверный email" };
    if (String(password || "").length < 6) return { ok: false, reason: "пароль слишком короткий" };
    const db = loadAccountDb();
    if (db[id]) return { ok: false, reason: "аккаунт уже существует" };
    const salt = makeSalt();
    const createdAt = Date.now();
    db[id] = { salt, hash: await credentialHash(id, password, salt), createdAt };
    if (!saveAccountDb(db)) return { ok: false, reason: "не удалось сохранить аккаунт" };
    const account = publicAccount(id, createdAt);
    persistCurrentAccount(account, remember);
    return { ok: true, account };
  },

  async signOut() {
    try {
      localStorage.removeItem(ACCOUNT_KEY);
      localStorage.removeItem(LEGACY_ACCOUNT_KEY);
      sessionStorage.removeItem(ACCOUNT_SESSION_KEY);
    } catch (_) {}
  },
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export { normalizeEmail, authStore, EMAIL_RE };
