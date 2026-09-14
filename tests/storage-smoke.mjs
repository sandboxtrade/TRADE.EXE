class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(String(key), String(value)); }
  removeItem(key) { this.values.delete(key); }
  clear() { this.values.clear(); }
}

globalThis.localStorage = new MemoryStorage();
globalThis.sessionStorage = new MemoryStorage();

const { authStore } = await import("../storage/auth.js");
const { emptyProfile, saveProfile, loadProfile } = await import("../storage/profile.js");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

let result = await authStore.signUp("A@Example.com", "secret1", false);
assert(result.ok, "sign up failed");
assert((await authStore.current()).email === "a@example.com", "session login not persisted");

await authStore.signOut();
assert((await authStore.current()) === null, "sign out failed");

result = await authStore.signIn("a@example.com", "wrong99", true);
assert(!result.ok, "wrong password was accepted");

result = await authStore.signIn("a@example.com", "secret1", true);
assert(result.ok, "valid password rejected");

const accountA = result.account;
const profileA = emptyProfile();
profileA.wallet = 12345;
profileA.activeSession = { capital: 500, mode: "session", startedAt: Date.now() };
await saveProfile(accountA, profileA);

const recovered = await loadProfile(accountA);
assert(recovered.wallet === 12845, "active session escrow was not recovered");
assert(recovered.activeSession === null, "active session was not cleared after recovery");

const profileB = await loadProfile({ email: "b@example.com" });
assert(profileB.wallet === 25000, "profiles leaked between accounts");

console.log("storage-smoke: OK");
