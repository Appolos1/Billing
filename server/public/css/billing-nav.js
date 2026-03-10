/* billing-nav.js — shared navigation logic for all dashboard pages */

const BillingNav = {
  async init(activePage) {
    const token = localStorage.getItem('bill_token');
    if (!token) { window.location.href = '/auth.html'; return null; }

    const r = await fetch('/api/auth/me', {
      headers: { 'Authorization': 'Bearer ' + token }
    }).then(r=>r.json()).catch(()=>null);

    if (!r?.id) {
      localStorage.removeItem('bill_token');
      window.location.href = '/auth.html';
      return null;
    }

    // Render nav
    const isAdmin = r.role === 'admin';
    document.getElementById('navUser').textContent  = r.name;
    document.getElementById('navInitial').textContent = r.name[0].toUpperCase();
    if (isAdmin) {
      const adminLink = document.getElementById('navAdmin');
      if (adminLink) adminLink.style.display = '';
    }

    // Mark active
    document.querySelectorAll('.nav-link[data-page]').forEach(el => {
      el.classList.toggle('active', el.dataset.page === activePage);
    });

    return r;
  },

  async signOut() {
    const token = localStorage.getItem('bill_token');
    await fetch('/api/auth/logout', {
      method:'POST',
      headers: { 'Authorization': 'Bearer ' + token }
    }).catch(()=>{});
    localStorage.removeItem('bill_token');
    localStorage.removeItem('bill_user');
    window.location.href = '/auth.html';
  }
};

// Shared API helper
async function api(method, path, body) {
  const token = localStorage.getItem('bill_token');
  const opts  = { method, headers: { 'Content-Type':'application/json' } };
  if (token) opts.headers['Authorization'] = 'Bearer ' + token;
  if (body)  opts.body = JSON.stringify(body);
  const r = await fetch(path, opts);
  return r.json();
}

// Shared utils
function esc(s)  { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmt(n)  {
  n = parseInt(n)||0;
  if (n>=1e6) return (n/1e6).toFixed(1)+'M';
  if (n>=1e3) return (n/1e3).toFixed(1)+'K';
  return String(n);
}
function fdate(s) {
  try { return new Date(s).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}); }
  catch { return s||'—'; }
}
function set(id, v) {
  const el = document.getElementById(id);
  if (el) el.textContent = v;
}
function showAlert(id, type, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.className = `alert alert-${type}${msg?' show':''}`;
}
function setBtn(id, txt) {
  const b = document.getElementById(id);
  if (!b) return;
  b.textContent = txt;
  b.disabled    = txt.endsWith('…');
}
function val(id) {
  return (document.getElementById(id)?.value||'').trim();
}

// Toast
let _toastT;
function toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_toastT);
  _toastT = setTimeout(() => el.classList.remove('show'), 2500);
}

// Chart renderer
function renderChart(barsId, datesId, days) {
  const max = Math.max(...days.map(d=>d.count), 1);
  document.getElementById(barsId).innerHTML = days.map(d =>
    `<div class="chart-bar${d.count>0?' has':''}" style="height:${Math.max(4,Math.round(d.count/max*100))}%" title="${d.date}: ${d.count} requests"></div>`
  ).join('');
  document.getElementById(datesId).innerHTML = days.map(d =>
    `<div class="chart-date">${d.date.slice(5)}</div>`
  ).join('');
}
