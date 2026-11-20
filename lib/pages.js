// Server-rendered pages for signing in, signing up, the account page and the admin page.
// Plain HTML forms, no scripts: works under the site's Content-Security-Policy and without JavaScript.
const config = require('./config');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = (iso) => (iso ? esc(new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + 'Z') : '—');

function layout(title, body, { user = null, csrf = '' } = {}) {
  const nav = user
    ? `<nav class="acct-nav"><a href="/">Board</a><a href="/account">Account</a>${user.role === 'admin' ? '<a href="/admin">Admin</a>' : ''}
        <form method="post" action="/logout"><input type="hidden" name="csrf" value="${esc(csrf)}"><button class="linkbtn">Sign out</button></form></nav>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} · wxboard</title>
  <link rel="stylesheet" href="/styles.css">
  <link rel="stylesheet" href="/auth.css">
</head>
<body class="acct">
  <header class="top"><a class="brand" href="/">wx<span>board</span></a>${nav}</header>
  <main class="acct-main">${body}</main>
  <footer class="foot">Supplemental information only. Not an FAA-approved weather briefing and not a substitute for one.
    Not an official FAA, NOAA or NWS product. <a href="/terms">Terms of use</a></footer>
</body>
</html>`;
}

const msgBox = (msg) => (!msg ? '' : `<div class="banner ${msg.type === 'error' ? 'err' : 'ok'}">${esc(msg.text)}</div>`);

const TERMS_SUMMARY = `wxboard is a reading aid for weather and NOTAM information gathered from public sources
  (NOAA Aviation Weather Center, National Weather Service, Open-Meteo, Iowa Environmental Mesonet, the FAA TFR site
  and the NMS-API). It is <b>not an FAA-approved briefing source</b>, not an official FAA, NOAA or NWS product, and
  may be incomplete, late or wrong. Get an official briefing before every flight.`;

function terms() {
  return layout('Terms of use', `<section class="card-box wide">
    <h1>Terms of use</h1>
    <p>${TERMS_SUMMARY}</p>
    <ul>
      <li>Data is provided as-is, without any warranty. Feeds can fail; when they do, wxboard may show older data.</li>
      <li>NOTAMs come from the NMS-API. They are US NOTAMs only; NMS is not the authoritative source for non-US NOTAMs.</li>
      <li>Winds aloft are NOAA GFS model output via Open-Meteo, not an official NWS winds aloft forecast.</li>
      <li>The minimums checks are a reading aid, not a flight release or dispatch decision.</li>
      <li>You are responsible for every decision you make. The site's operator accepts no liability for its use.</li>
      <li>Accounts may be removed at any time. Don't share your account.</li>
    </ul>
    <p><a href="/login">Back</a></p></section>`);
}

function login({ next = '/', msg = null, username = '' } = {}) {
  const signupLink = config.auth.signup === 'closed' ? '' : `<p class="muted">No account? <a href="/signup">${config.auth.signup === 'approval' ? 'Request one' : 'Sign up'}</a></p>`;
  return layout('Sign in', `<section class="card-box">
    <h1>Sign in</h1>${msgBox(msg)}
    <form method="post" action="/login" class="stack">
      <input type="hidden" name="next" value="${esc(next)}">
      <label class="fld"><span>Username</span><input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" value="${esc(username)}" required autofocus></label>
      <label class="fld"><span>Password</span><input type="password" name="password" autocomplete="current-password" required></label>
      <button class="btn primary">Sign in</button>
    </form>${signupLink}</section>`);
}

function signup({ msg = null, values = {} } = {}) {
  const mode = config.auth.signup;
  if (mode === 'closed') return layout('Sign up', `<section class="card-box"><h1>Sign-ups are closed</h1><p>Ask the site's operator for an account.</p><p><a href="/login">Sign in</a></p></section>`);
  const intro = {
    approval: 'Request an account. The site operator reviews each request; you can sign in once it is approved.',
    open: 'Create an account.',
    invite: 'Create an account with the invite code you were given.',
  }[mode];
  return layout('Sign up', `<section class="card-box">
    <h1>${mode === 'approval' ? 'Request an account' : 'Sign up'}</h1>
    <p class="muted">${intro}</p>${msgBox(msg)}
    <form method="post" action="/signup" class="stack">
      <label class="fld"><span>Username</span><input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" minlength="3" maxlength="32" value="${esc(values.username)}" required></label>
      <label class="fld"><span>Password (at least 10 characters)</span><input type="password" name="password" autocomplete="new-password" minlength="10" maxlength="200" required></label>
      <label class="fld"><span>Password again</span><input type="password" name="password2" autocomplete="new-password" required></label>
      ${mode === 'invite' ? `<label class="fld"><span>Invite code</span><input name="invite" autocapitalize="characters" spellcheck="false" value="${esc(values.invite)}" required></label>` : ''}
      ${mode === 'approval' ? `<label class="fld"><span>Who are you / how will you use it? (optional)</span><textarea name="note" maxlength="300" rows="3">${esc(values.note)}</textarea></label>` : ''}
      <div class="terms-box small">${TERMS_SUMMARY} <a href="/terms" target="_blank" rel="noopener">Full terms</a></div>
      <label class="chk"><input type="checkbox" name="accept" value="1" required> I understand and accept the terms of use</label>
      <button class="btn primary">${mode === 'approval' ? 'Send request' : 'Create account'}</button>
    </form>
    <p class="muted">Already have an account? <a href="/login">Sign in</a></p></section>`);
}

function signupDone(pending) {
  return layout('Sign up', `<section class="card-box"><h1>${pending ? 'Request sent' : 'Account created'}</h1>
    <p>${pending ? "Thanks. You'll be able to sign in once the site operator approves your account." : 'You can sign in now.'}</p>
    <p><a class="btn primary" href="/login">Sign in</a></p></section>`);
}

function account({ user, csrf, msg = null }) {
  return layout('Account', `<section class="card-box">
    <h1>Account</h1>${msgBox(msg)}
    <p>Signed in as <b>${esc(user.username)}</b>${user.role === 'admin' ? ' <span class="tag blue">ADMIN</span>' : ''}.</p>
    <h2>Change password</h2>
    <form method="post" action="/account/password" class="stack">
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <input type="text" name="username" value="${esc(user.username)}" autocomplete="username" hidden>
      <label class="fld"><span>Current password</span><input type="password" name="current" autocomplete="current-password" required></label>
      <label class="fld"><span>New password (at least 10 characters)</span><input type="password" name="password" autocomplete="new-password" minlength="10" maxlength="200" required></label>
      <label class="fld"><span>New password again</span><input type="password" name="password2" autocomplete="new-password" required></label>
      <button class="btn primary">Change password</button>
      <p class="muted small">This signs you out everywhere else.</p>
    </form>
    <h2>Delete account</h2>
    <form method="post" action="/account/delete" class="stack">
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <label class="fld"><span>Password, to confirm</span><input type="password" name="current" autocomplete="current-password" required></label>
      <button class="btn danger">Delete my account</button>
    </form></section>`, { user, csrf });
}

function admin({ user, csrf, list, invites, msg = null }) {
  const form = (action, id, label, cls = '') => `<form method="post" action="/admin/action" class="inline">
      <input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="action" value="${action}"><input type="hidden" name="id" value="${esc(id)}">
      <button class="btn sm ${cls}">${label}</button></form>`;
  const pending = list.filter((u) => u.status === 'pending');
  const others = list.filter((u) => u.status !== 'pending');
  const row = (u) => {
    const self = u.id === user.id;
    const actions = self ? '<span class="muted small">you</span>' : [
      u.status === 'active' ? form('disable', u.id, 'Disable') : form('enable', u.id, 'Enable'),
      u.role === 'admin' ? form('demote', u.id, 'Remove admin') : form('promote', u.id, 'Make admin'),
      form('delete', u.id, 'Delete', 'danger'),
    ].join('');
    return `<tr><td><b>${esc(u.username)}</b>${u.role === 'admin' ? ' <span class="tag blue">ADMIN</span>' : ''}${u.status === 'disabled' ? ' <span class="tag red">DISABLED</span>' : ''}</td>
      <td class="small">${when(u.createdAt)}</td><td class="small">${when(u.lastLoginAt)}</td><td class="acts">${actions}</td></tr>`;
  };
  const S = config.auth;
  const openInvites = invites.filter((i) => !i.usedBy);
  return layout('Admin', `<section class="card-box wide">
    <h1>Admin</h1>${msgBox(msg)}
    <p class="muted small">Settings (change in config.json, then restart): sign-ups <b>${esc(S.signup)}</b> · NOTAMs shown to <b>${esc(S.notams)}</b> · sessions last <b>${S.sessionDays}</b> days.</p>

    <h2>Waiting for approval <span class="count">${pending.length}</span></h2>
    ${pending.length ? `<table class="utable"><tr><th>User</th><th>Requested</th><th>Note</th><th></th></tr>
      ${pending.map((u) => `<tr><td><b>${esc(u.username)}</b></td><td class="small">${when(u.createdAt)}</td><td class="small note">${esc(u.note) || '<span class="muted">—</span>'}</td>
        <td class="acts">${form('approve', u.id, 'Approve', 'primary')}${form('delete', u.id, 'Reject')}</td></tr>`).join('')}</table>`
      : '<p class="muted">No requests.</p>'}

    <h2>Users <span class="count">${others.length}</span></h2>
    <table class="utable"><tr><th>User</th><th>Created</th><th>Last sign-in</th><th></th></tr>${others.map(row).join('')}</table>

    <h2>Invite codes</h2>
    <p class="muted small">${S.signup === 'invite' ? 'Each code works for one sign-up.' : 'Codes only matter when sign-ups are set to "invite".'}</p>
    ${openInvites.length ? `<table class="utable"><tr><th>Code</th><th>Created</th><th></th></tr>${openInvites.map((i) => `<tr><td class="mono"><b>${esc(i.code)}</b></td><td class="small">${when(i.createdAt)}</td>
      <td class="acts">${form('revoke-invite', i.code, 'Revoke')}</td></tr>`).join('')}</table>` : ''}
    ${form('new-invite', '', 'New invite code')}
    </section>`, { user, csrf });
}

module.exports = { layout, login, signup, signupDone, account, admin, terms, esc };
