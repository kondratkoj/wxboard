#!/usr/bin/env node
// Manage wxboard accounts from the command line. Works whether the server is running or not.
//
//   node tools/admin.js create-admin <username>     make an admin account (asks for a password)
//   node tools/admin.js create-user <username>      make an ordinary, already-approved account
//   node tools/admin.js reset-password <username>   set a new password (signs that user out everywhere)
//   node tools/admin.js approve <username>          approve a pending sign-up
//   node tools/admin.js disable <username> | enable <username> | delete <username>
//   node tools/admin.js list                        show every account
//
// In Docker:  docker compose exec wxboard node tools/admin.js create-admin <username>
const readline = require('readline');
const users = require('../lib/users');
const config = require('../lib/config');

function askHidden(prompt) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      // Piped input (e.g. scripts): read one line.
      const rl = readline.createInterface({ input: process.stdin });
      rl.once('line', (l) => { rl.close(); resolve(l); });
      return;
    }
    process.stdout.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let s = '';
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') {
        stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData);
        process.stdout.write('\n'); resolve(s);
      } else if (ch === '\u0003') { process.stdout.write('\n'); process.exit(130); }
      else if (ch === '\u007f' || ch === '\b') s = s.slice(0, -1);
      else s += ch;
    };
    stdin.on('data', onData);
  });
}

async function newPassword(username) {
  const pw = await askHidden(`Password for ${username} (at least ${users.PASSWORD_MIN} characters): `);
  const err = users.validatePassword(pw, username);
  if (err) throw new Error(err);
  if (process.stdin.isTTY) {
    const again = await askHidden('Again: ');
    if (again !== pw) throw new Error("The passwords don't match.");
  }
  return pw;
}

function need(name) {
  const u = users.byName(name);
  if (!u) throw new Error(`No account called "${name}".`);
  return u;
}

async function main() {
  const [cmd, name] = process.argv.slice(2);
  switch (cmd) {
    case 'create-admin':
    case 'create-user': {
      if (!name) throw new Error(`Usage: node tools/admin.js ${cmd} <username>`);
      const v = users.validateUsername(name);
      if (v.error) throw new Error(v.error);
      if (users.byName(v.username)) throw new Error(`"${v.username}" already exists.`);
      const pw = await newPassword(v.username);
      const u = await users.create({ username: v.username, password: pw, role: cmd === 'create-admin' ? 'admin' : 'user', status: 'active' });
      console.log(`Created ${u.role} "${u.username}".`);
      break;
    }
    case 'reset-password': {
      const u = need(name);
      await users.setPassword(u.id, await newPassword(u.username));
      console.log(`Password changed for "${u.username}". They were signed out everywhere.`);
      break;
    }
    case 'approve': case 'enable': users.update(need(name).id, { status: 'active' }); console.log(`"${name}" is active.`); break;
    case 'disable': users.update(need(name).id, { status: 'disabled' }); console.log(`"${name}" is disabled.`); break;
    case 'delete': users.remove(need(name).id); console.log(`"${name}" deleted.`); break;
    case 'list': {
      const all = users.list();
      if (!all.length) { console.log('No accounts yet.'); break; }
      for (const u of all) console.log(`${u.username.padEnd(32)} ${u.role.padEnd(6)} ${u.status.padEnd(9)} created ${u.createdAt.slice(0, 10)}  last sign-in ${u.lastLoginAt ? u.lastLoginAt.slice(0, 10) : '—'}`);
      break;
    }
    default:
      console.log(require('fs').readFileSync(__filename, 'utf8').split('\n').slice(1, 11).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
      process.exitCode = cmd ? 1 : 0;
      return;
  }
  console.log(`(accounts file: ${require('path').join(config.dataDir, 'users.json')})`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
