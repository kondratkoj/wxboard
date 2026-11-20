// Accounts and invite codes, kept in <dataDir>/users.json.
// Passwords are hashed with scrypt (built into Node) and a random salt per user; the plain password is never stored.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const config = require('./config');

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 32;

const USERNAME_RE = /^[a-z0-9][a-z0-9_.-]{2,31}$/;
const PASSWORD_MIN = 10;
const PASSWORD_MAX = 200;

const file = () => path.join(config.dataDir, 'users.json');
let db = null; // { version, users: [], invites: [] }
let dbMtime = 0;

// Re-reads the file when it changed on disk, so edits made with tools/admin.js take effect in a running server.
function load() {
  let mtime = 0;
  try { mtime = fs.statSync(file()).mtimeMs; } catch { /* no file yet */ }
  if (db && mtime === dbMtime) return db;
  try { db = JSON.parse(fs.readFileSync(file(), 'utf8')); }
  catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`Can't read ${file()}: ${e.message}`);
    db = { version: 1, users: [], invites: [] };
  }
  dbMtime = mtime;
  db.users ||= []; db.invites ||= [];
  return db;
}

function save() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = file() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(load(), null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file());
  dbMtime = fs.statSync(file()).mtimeMs;
}

// For tests: forget the in-memory copy so the next call re-reads the file.
function _reset() { db = null; dbMtime = 0; }

// ---------- passwords ----------
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, KEYLEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function checkPassword(pw, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, want] = parts;
  const wantBuf = Buffer.from(want, 'base64');
  const got = await scrypt(String(pw), Buffer.from(salt, 'base64'), wantBuf.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return crypto.timingSafeEqual(got, wantBuf);
}

// Used when the username doesn't exist, so a login takes the same time either way.
let dummyHash = null;
async function burnTime(pw) {
  dummyHash ||= await hashPassword(crypto.randomBytes(12).toString('hex'));
  await checkPassword(pw, dummyHash);
}

function validateUsername(name) {
  const u = String(name || '').trim().toLowerCase();
  if (!USERNAME_RE.test(u)) return { error: 'Usernames are 3–32 characters: letters, digits, dot, dash or underscore, starting with a letter or digit.' };
  return { username: u };
}

function validatePassword(pw, username) {
  const s = String(pw || '');
  if (s.length < PASSWORD_MIN) return `Passwords need at least ${PASSWORD_MIN} characters.`;
  if (s.length > PASSWORD_MAX) return `Passwords can be at most ${PASSWORD_MAX} characters.`;
  if (username && s.toLowerCase().includes(username)) return "Passwords can't contain the username.";
  return null;
}

// ---------- users ----------
const publicView = (u) => u && ({ id: u.id, username: u.username, role: u.role, status: u.status, createdAt: u.createdAt, approvedAt: u.approvedAt || null, lastLoginAt: u.lastLoginAt || null, note: u.note || '' });

const byId = (id) => load().users.find((u) => u.id === id) || null;
const byName = (name) => load().users.find((u) => u.username === String(name || '').trim().toLowerCase()) || null;
const list = () => load().users.map(publicView);
const pendingCount = () => load().users.filter((u) => u.status === 'pending').length;
const adminCount = () => load().users.filter((u) => u.role === 'admin' && u.status === 'active').length;

async function create({ username, password, role = 'user', status = 'active', note = '', acceptedTerms = false }) {
  const v = validateUsername(username);
  if (v.error) throw Object.assign(new Error(v.error), { status: 400 });
  const pwErr = validatePassword(password, v.username);
  if (pwErr) throw Object.assign(new Error(pwErr), { status: 400 });
  if (byName(v.username)) throw Object.assign(new Error('That username is taken.'), { status: 409 });
  const hash = await hashPassword(password);
  // Check again: another sign-up may have taken the name while we were hashing.
  if (byName(v.username)) throw Object.assign(new Error('That username is taken.'), { status: 409 });
  const now = new Date().toISOString();
  const user = {
    id: crypto.randomUUID(), username: v.username, hash, role, status,
    createdAt: now, approvedAt: status === 'active' ? now : null, lastLoginAt: null,
    sessionVersion: 1, note: String(note || '').slice(0, 300), acceptedTermsAt: acceptedTerms ? now : null,
  };
  load().users.push(user);
  save();
  return publicView(user);
}

// Returns the user on success, or null. Pending/disabled users are returned with their status so the
// caller can say why they can't sign in (only after the password checks out).
async function verifyLogin(username, password) {
  const u = byName(username);
  if (!u) { await burnTime(password); return null; }
  if (!(await checkPassword(password, u.hash))) return null;
  return u;
}

function recordLogin(id) {
  const u = byId(id);
  if (!u) return;
  u.lastLoginAt = new Date().toISOString();
  save();
}

async function setPassword(id, password) {
  const u = byId(id);
  if (!u) throw Object.assign(new Error('No such user'), { status: 404 });
  const err = validatePassword(password, u.username);
  if (err) throw Object.assign(new Error(err), { status: 400 });
  u.hash = await hashPassword(password);
  u.sessionVersion = (u.sessionVersion || 1) + 1; // signs out every other session
  save();
  return u.sessionVersion;
}

// Admin changes. Refuses to remove or lock out the last active admin.
function update(id, change) {
  const u = byId(id);
  if (!u) throw Object.assign(new Error('No such user'), { status: 404 });
  const wasLastAdmin = u.role === 'admin' && u.status === 'active' && adminCount() === 1;
  if (wasLastAdmin && ((change.role && change.role !== 'admin') || (change.status && change.status !== 'active'))) {
    throw Object.assign(new Error("Can't remove the last admin."), { status: 400 });
  }
  if (change.status) {
    if (change.status === 'active' && !u.approvedAt) u.approvedAt = new Date().toISOString();
    if (change.status !== 'active') u.sessionVersion = (u.sessionVersion || 1) + 1;
    u.status = change.status;
  }
  if (change.role) { u.role = change.role; u.sessionVersion = (u.sessionVersion || 1) + 1; }
  save();
  return publicView(u);
}

function remove(id) {
  const u = byId(id);
  if (!u) return false;
  if (u.role === 'admin' && u.status === 'active' && adminCount() === 1) throw Object.assign(new Error("Can't delete the last admin."), { status: 400 });
  load().users = load().users.filter((x) => x.id !== id);
  save();
  return true;
}

// ---------- invite codes ----------
function createInvite(createdBy) {
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I mix-ups
  const code = Array.from({ length: 10 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
  const inv = { code, createdAt: new Date().toISOString(), createdBy, usedBy: null, usedAt: null };
  load().invites.push(inv);
  save();
  return inv;
}
const listInvites = () => load().invites.slice();
const inviteValid = (code) => load().invites.some((i) => i.code === String(code || '').trim().toUpperCase() && !i.usedBy);
function useInvite(code, username) {
  const inv = load().invites.find((i) => i.code === String(code || '').trim().toUpperCase() && !i.usedBy);
  if (!inv) return false;
  inv.usedBy = username; inv.usedAt = new Date().toISOString();
  save();
  return true;
}
function revokeInvite(code) {
  const before = load().invites.length;
  load().invites = load().invites.filter((i) => !(i.code === code && !i.usedBy));
  if (load().invites.length !== before) save();
}

module.exports = {
  create, verifyLogin, recordLogin, setPassword, update, remove, list, byId, byName, pendingCount, adminCount,
  validateUsername, validatePassword, hashPassword, checkPassword, publicView,
  createInvite, listInvites, inviteValid, useInvite, revokeInvite,
  PASSWORD_MIN, _reset,
};
