'use strict';
const $ = (s, root = document) => root.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = n => '$' + Number(n || 0).toFixed(2);
const stamp = s => s ? new Date(s).toLocaleString() : 'Never';
const store = { get(k) { try { return sessionStorage.getItem(k) || ''; } catch { return ''; } }, set(k,v) { try { sessionStorage.setItem(k,v); } catch {} } };
let token = new URLSearchParams(location.search).get('token') || store.get('conductor.token');
if (token) store.set('conductor.token', token);
if (location.search.includes('token=')) { const u = new URL(location.href); u.searchParams.delete('token'); history.replaceState(null, '', u); }
// Migrate the previous UI's persistent bearer into session-only storage.
try { if (!token && localStorage.getItem('architect.token')) { token = localStorage.getItem('architect.token'); store.set('conductor.token', token); } localStorage.removeItem('architect.token'); } catch {}
const sharedIntent = new URLSearchParams(location.search).get('intent');
if (sharedIntent) { const u = new URL(location.href); u.searchParams.delete('intent'); history.replaceState(null,'',u); }
let runs = [], approvals = [], scores = [], schedules = [], current = null, view = '', search = '', detailSignature = '', refreshBusy = false;
let eventAbort, eventRetry, eventLog = [], eventKeys = new Set(), imageUrls = [];
const modal = $('#modal');
function notice(message, error = false) { const el = $('#notice'); el.textContent = message; el.className = error ? 'error' : ''; el.hidden = !message; }
function connected(ok, label) { $('#connection').className = 'connection ' + (ok ? 'online' : 'offline'); $('#connection-label').textContent = label || (ok ? 'Server connected' : 'Connection lost'); }
async function api(p, opts = {}) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const r = await fetch(p, { ...opts, signal: opts.signal || controller.signal, headers: { ...(opts.body ? {'content-type':'application/json'} : {}), ...(token ? {authorization:'Bearer ' + token} : {}), ...opts.headers }, cache:'no-store' });
    const data = await r.json();
    if (!r.ok) { if (r.status === 401) connected(false, 'Sign in required'); throw new Error(data.error || `Request failed (${r.status})`); }
    return data;
  } catch (e) { if (e.name === 'AbortError') throw new Error('The server took too long. Check the connection before retrying.'); throw e; }
  finally { clearTimeout(timer); }
}
const post = (p, data = {}) => api(p, {method:'POST', body:JSON.stringify(data)});
function empty(title, description = '') { return `<div class="empty"><strong>${esc(title)}</strong>${esc(description)}</div>`; }
function heading(kicker, title, text, action = '') { return `<div class="page-heading"><div><span class="eyebrow">${esc(kicker)}</span><h1>${esc(title)}</h1><p>${esc(text)}</p></div>${action}</div>`; }
function status(s) { return `<span class="status ${esc(s)}">${esc(s.replaceAll('_',' '))}</span>`; }
function button(label, action, data = '', cls = '') { return `<button class="${cls}" data-action="${action}" ${data}>${label}</button>`; }
function autonomy(selected = 'accompaniment') { return `<select name="autonomy"><option value="rehearsal" ${selected === 'rehearsal' ? 'selected' : ''}>Rehearsal · draft only</option><option value="accompaniment" ${selected === 'accompaniment' ? 'selected' : ''}>Accompaniment · ask at decisions</option><option value="autopilot" ${selected === 'autopilot' ? 'selected' : ''}>Autopilot · standing permissions</option></select>`; }
function inputsField(value = {}) { return `<label>Inputs (JSON object)<textarea name="inputs" spellcheck="false">${esc(JSON.stringify(value, null, 2))}</textarea></label>`; }
function parseInputs(raw) { const v = JSON.parse(raw || '{}'); if (!v || Array.isArray(v) || typeof v !== 'object' || Object.values(v).some(x => typeof x !== 'string')) throw new Error('Inputs must be a JSON object with string values, for example {"supplier":"Acme"}.'); return v; }
function budgetField(value = '') { return `<label>Budget per run (USD, optional)<input type="number" name="budgetUsd" min="0.01" step="0.01" placeholder="e.g. 5.00" value="${esc(value)}"></label>`; }
function optsFrom(form) { const f = new FormData(form); return { inputs:parseInputs(f.get('inputs')), autonomy:f.get('autonomy') || 'accompaniment', ...(f.get('budgetUsd') ? {budgetUsd:Number(f.get('budgetUsd'))} : {}) }; }
function dialog(title, html, submit) {
  $('#modal-title').textContent = title; $('#modal-body').innerHTML = html;
  if (!modal.open) modal.showModal();
  const form = $('form', modal);
  if (form) form.onsubmit = async e => {
    e.preventDefault(); const btn = $('button[type=submit]', form); const error = $('.error-text', form); error.textContent = ''; btn.disabled = true;
    try { await submit(form); modal.close(); await refresh(true); }
    catch (err) { error.textContent = err.message; }
    finally { btn.disabled = false; }
  };
}
function formWrap(content, label) { return `<form class="stack">${content}<p class="error-text" role="alert"></p><button type="submit" class="primary">${esc(label)}</button></form>`; }
function settings() {
  dialog('Connect to your engine', formWrap(`<p class="help">This app connects to the execution engine at <strong>${esc(location.origin)}</strong>. Enter the server’s API token. It stays in this browser tab’s session.</p><label>API token<input type="password" name="token" autocomplete="off" value="${esc(token)}" placeholder="ARCHITECT_API_TOKEN"></label><p class="help">Model credentials belong on the server. You can leave this blank only when your server does not require a token.</p>`, 'Connect'), async form => {
    const candidate = new FormData(form).get('token').trim();
    const r = await fetch('/v1/runs?limit=1', {headers:candidate ? {authorization:'Bearer ' + candidate} : {}, cache:'no-store'});
    if (!r.ok) throw new Error(r.status === 401 ? 'The server rejected this token.' : 'Could not connect to the server.');
    token = candidate; store.set('conductor.token', token); notice('Connected to your execution engine.'); detailSignature = ''; if (current) startEvents(current);
  });
}
$('#connection').onclick = settings; $('#settings-button').onclick = settings; $('#modal-close').onclick = () => modal.close();
function renderRuns() {
  const filtered = runs.filter(r => (r.score.goal + ' ' + r.status).toLowerCase().includes(search.toLowerCase()));
  $('#run-list').innerHTML = filtered.map(r => `<button class="run" data-action="open" data-id="${esc(r.id)}"><span class="run-main"><span class="run-title">${esc(r.score.goal)}</span><span class="run-meta"><span>${esc(r.autonomy)}</span><span>${esc(stamp(r.createdAt))}</span><span>${money(r.usage?.costUsd)}</span></span></span>${status(r.status)}</button>`).join('') || empty(search ? 'No matching performances' : 'Your first performance starts here', search ? 'Try another search.' : 'Describe an outcome above. Your plan, decisions, and evidence will appear here.');
}
function home() {
  $('#page').innerHTML = heading('THE PODIUM', 'Make your next move.', 'Give your work a direction. Conductor carries it through.') + `<form id="compose" class="card composer"><label for="goal">WHAT DO YOU WANT TO ACCOMPLISH?</label><textarea id="goal" name="goal" required maxlength="10000" placeholder="Describe an outcome, not just a task…"></textarea><div class="form-footer"><label>Performance mode${autonomy()}</label><label>Spending limit · USD<input type="number" name="budgetUsd" min="0.01" step="0.01" placeholder="Optional"></label><button type="submit" class="primary">Compose score ↗</button></div><details><summary>Starting point & inputs</summary><div class="stack"><label>Start URL (optional)<input name="startUrl" type="url" placeholder="https://example.com"></label>${inputsField()}</div></details><p class="help">Review the plan and estimate before starting. Model calls incur server-side costs.</p><p class="error-text" role="alert"></p></form><div class="section-title"><h2>Recent performances <small id="visible-count"></small></h2><input id="search" aria-label="Search performances" placeholder="Search performances" value="${esc(search)}"></div><div id="run-list" class="run-list"></div>`;
  if (sharedIntent) $('#goal').value = sharedIntent.slice(0,10000);
  renderRuns(); $('#search').oninput = e => { search = e.target.value; renderRuns(); };
  $('#compose').onsubmit = async e => {
    e.preventDefault(); const form = e.target, btn = $('button[type=submit]', form); btn.disabled = true; btn.textContent = 'Composing…'; $('.error-text',form).textContent = '';
    try { const f = new FormData(form); const run = await post('/v1/runs', {goal:f.get('goal').trim(), ...optsFrom(form), startUrl:f.get('startUrl') || undefined, composeOnly:true}); location.hash = 'run/' + run.id; }
    catch(err) { $('.error-text',form).textContent = err.message; }
    finally { btn.disabled = false; btn.textContent = 'Compose score ↗'; }
  };
}
function approvalCard(a, showRun = false) { return `<article class="card approval"><h2>Decision required ${a.risk ? '· ' + esc(a.risk) : ''}</h2><p>${esc(a.reason)}</p>${showRun ? `<p>${button('View performance ↗','open',`data-id="${esc(a.runId)}"`)}</p>` : ''}${a.tool ? `<pre>${esc(a.tool)}\n${esc(JSON.stringify(a.input,null,2))}</pre>` : ''}<p class="help">Approve only after reviewing the action and its inputs.</p><div class="row" style="margin-top:14px">${button('Review decision','decide',`data-id="${esc(a.id)}"`,'primary')}</div></article>`; }
async function drawDetail(id, force = false) {
  const run = await api('/v1/runs/' + encodeURIComponent(id));
  if (current !== id) return;
  const mine = approvals.filter(a => a.runId === id);
  const signature = JSON.stringify([run,mine]);
  if (!force && signature === detailSignature) return;
  detailSignature = signature; imageUrls.forEach(URL.revokeObjectURL); imageUrls = [];
  const state = step => run.steps.find(s => s.id === step.id) || {};
  const active = ['performing','awaiting_approval','verifying'].includes(run.status);
  const actions = [run.status === 'composed' ? button('Start performance →','perform','','primary') : '', ['failed','handed_off'].includes(run.status) ? button('Recover','recover','','primary') : '', !active && run.status !== 'composed' ? button('Encore','encore') : '', active ? button('Cancel performance','cancel','','danger') : '', button('Save score','save'), button('Export report','report')].join('');
  $('#page').innerHTML = `<button class="back" data-action="back">← All performances</button>` + heading('PERFORMANCE / ' + run.id, run.score.goal, run.score.summary) + `<div class="row between">${status(run.status)}<div class="row">${actions}</div></div><div class="metrics"><div class="metric"><small>Spent${run.budgetUsd ? ' / ' + money(run.budgetUsd) + ' limit' : ''}</small><strong>${money(run.usage?.costUsd)}</strong></div><div class="metric"><small>Steps complete</small><strong>${run.steps.filter(s => s.status === 'done').length} / ${run.steps.length}</strong></div><div class="metric"><small>Model calls</small><strong>${run.usage?.calls || 0}</strong></div></div>${run.error ? `<div class="card approval"><h2>Performance needs attention</h2><p>${esc(run.error)}</p></div>` : ''}<div id="estimate"></div>${mine.map(a => approvalCard(a)).join('')}<div class="detail-grid"><div><div class="card"><h2>The score</h2><ol class="steps">${run.score.steps.map(s => `<li class="${esc(state(s).status)}"><h3>${esc(s.title)} ${s.checkpoint ? '<small>· Human checkpoint</small>' : ''}</h3><p>${esc(state(s).summary || s.instruction)}</p><small>${esc(s.instruments.join(' · '))}</small></li>`).join('')}</ol><h3>Permissions</h3><div class="chips">${run.score.permissions.map(p => `<span class="chip">${esc(p)}</span>`).join('') || '<span class="dim">None</span>'}</div></div><div class="card"><h2>Definition of done</h2><ul class="criteria">${run.score.successCriteria.map(c => `<li>${esc(c)}</li>`).join('')}</ul></div>${run.verdict ? `<div class="card"><h2>Verification · ${run.verdict.passed ? 'passed' : 'not passed'}</h2><p>${esc(run.verdict.summary)}</p><ul class="criteria">${run.verdict.criteria.map(c => `<li class="${c.met ? 'met' : 'unmet'}">${c.met ? '✓' : '✕'} ${esc(c.criterion)}<p class="dim">${esc(c.evidence)}</p></li>`).join('')}</ul></div>` : ''}<div class="card"><h2>Evidence <small>(${run.evidence.length})</small></h2><div class="evidence">${run.evidence.map(e => `<article><h3>${esc(e.label)}</h3><small>${esc(e.kind)} · ${esc(stamp(e.at))}</small>${e.kind === 'screenshot' && e.path ? `<img data-evidence="${esc(e.path.split(/[\\/]/).pop())}" alt="${esc(e.label)}">` : ''}${e.content ? `<pre>${esc(e.content)}</pre>` : ''}</article>`).join('') || '<p class="dim">Evidence will appear as the performance runs.</p>'}</div></div></div><div><div class="card"><h2>Live performance</h2><p id="stream-state" class="help">Connecting to event stream…</p><div class="log" id="event-log" aria-label="Performance events"></div></div><div class="card"><h2>Action history <small>(${run.actions.length})</small></h2>${run.actions.slice(-100).reverse().map(a => `<details><summary>${esc(a.outcome)} · ${esc(a.tool)} · ${esc(a.risk)}</summary><pre>${esc(JSON.stringify(a.input,null,2))}\n\n${esc(a.output)}</pre></details>`).join('') || '<p class="dim">No actions yet.</p>'}</div></div></div>`;
  renderEvents();
  if (run.status === 'handed_off') {
    try { const h = await api(`/v1/runs/${id}/handoff`); if (current === id && $('#estimate')) $('#estimate').innerHTML = `<div class="card approval"><h2>Handoff · your next step</h2><pre>${esc(h.markdown)}</pre></div>`; } catch(e) { notice(e.message,true); }
  }
  if (run.status === 'composed') {
    try { const est = await api(`/v1/runs/${id}/estimate`); if (current === id && $('#estimate')) $('#estimate').innerHTML = `<div class="card"><h2>Estimated performance cost</h2><p>${money(est.lowUsd)} – ${money(est.highUsd)}</p><p class="help">An estimate, not a guaranteed price. ${run.budgetUsd ? 'Your spending limit is ' + money(run.budgetUsd) + '.' : 'No spending limit is set.'} Mode: ${esc(run.autonomy)}.</p></div>`; } catch(e) { notice(e.message,true); }
  }
  document.querySelectorAll('[data-evidence]').forEach(async img => {
    try { const r = await fetch(`/v1/runs/${id}/evidence/${encodeURIComponent(img.dataset.evidence)}`, {headers:token ? {authorization:'Bearer ' + token} : {}}); if (!r.ok) throw new Error(); const blob = await r.blob(); if (!img.isConnected) return; const u = URL.createObjectURL(blob); imageUrls.push(u); img.src = u; img.onclick = () => { dialog(img.alt, `<img style="width:100%" src="${u}" alt="${esc(img.alt)}">`); }; } catch { img.replaceWith(document.createTextNode('Screenshot unavailable')); }
  });
}
function renderEvents() { const el = $('#event-log'); if (!el) return; el.innerHTML = eventLog.slice(-250).map(e => `<div><time>${esc(new Date(e.at).toLocaleTimeString())}</time><span>${esc(e.type)}</span><br>${esc(eventText(e))}</div>`).join('') || '<p class="dim">Waiting for events.</p>'; el.scrollTop = el.scrollHeight; }
function eventText(e) { const d = e.data; return d.summary || d.text || d.reason || d.status || (d.tool ? `${d.outcome} · ${d.tool}` : d.label) || ''; }
function stopEvents() { clearTimeout(eventRetry); eventAbort?.abort(); }
async function startEvents(id) {
  stopEvents(); eventLog = []; eventKeys = new Set(); const controller = new AbortController(); eventAbort = controller;
  async function connect() {
    if (controller.signal.aborted || current !== id) return;
    try {
      const r = await fetch(`/v1/runs/${id}/events`, {headers:token ? {authorization:'Bearer ' + token} : {}, signal:controller.signal, cache:'no-store'});
      if (!r.ok) throw new Error('Event stream unavailable');
      if ($('#stream-state')) $('#stream-state').textContent = 'Live · events recorded by your engine';
      const reader = r.body.getReader(), decoder = new TextDecoder(); let buffer = '';
      while (true) {
        const {value,done} = await reader.read(); if (done) break;
        buffer += decoder.decode(value,{stream:true}); let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0,boundary); buffer = buffer.slice(boundary + 2);
          const data = chunk.split('\n').find(l => l.startsWith('data: ')); if (!data) continue;
          const ev = JSON.parse(data.slice(6)), key = JSON.stringify(ev); if (eventKeys.has(key)) continue;
          eventKeys.add(key); eventLog.push(ev); renderEvents();
          if (ev.type === 'approval.requested' || ev.type === 'approval.decided' || ev.type === 'run.status' || ev.type === 'run.verified') void refresh();
        }
      }
    } catch(e) { if (controller.signal.aborted) return; }
    if (!controller.signal.aborted) { if ($('#stream-state')) $('#stream-state').textContent = 'Reconnecting… Your performance continues on the server.'; eventRetry = setTimeout(connect,3000); }
  }
  void connect();
}
function libraryPage() {
  $('#page').innerHTML = heading('REUSABLE WORK', 'Your score library.', 'Keep a plan. Play it again with new inputs.', button('Import score','import','','primary')) + (scores.map(s => `<article class="card"><div class="row between"><div><h2>${esc(s.name)}</h2><p class="dim">${esc(s.description)}</p></div>${button('Play score →','play',`data-name="${esc(s.name)}"`,'primary')}</div><div class="chips">${s.inputs.map(i => `<span class="chip">{{${esc(i)}}}</span>`).join('')}</div><details><summary>Plan & permissions</summary><ol class="steps">${s.score.steps.map(x => `<li><h3>${esc(x.title)}</h3><p>${esc(x.instruction)}</p></li>`).join('')}</ol><p class="help">${esc(s.score.permissions.join(', '))}</p></details><div class="row" style="margin-top:18px">${button('Export package','export',`data-name="${esc(s.name)}"`)}${button('Delete','delete-score',`data-name="${esc(s.name)}"`,'danger')}</div></article>`).join('') || empty('No saved scores yet', 'Open a performance and choose Save score, or import a package.'));
}
function schedulesPage() {
  $('#page').innerHTML = heading('RECURRING WORK', 'Set the rhythm.', 'Schedules run while your execution server is online.', button('New schedule','new-schedule','','primary')) + (schedules.map(s => `<article class="card"><div class="row between"><div><h2>${esc(s.name)}</h2><p class="dim">${esc(s.score)} · ${s.everyMinutes ? 'Every ' + s.everyMinutes + ' minutes' : 'Daily at ' + esc(s.dailyAt) + ' (server local time)'}</p></div>${status(s.enabled ? 'performing' : 'paused')}</div><p class="help">${esc(s.autonomy)} · ${s.budgetUsd ? money(s.budgetUsd) + ' per run' : 'No spending limit'} · Last run: ${esc(stamp(s.lastRunAt))}</p><div class="row" style="margin-top:18px">${button('Edit','edit-schedule',`data-name="${esc(s.name)}"`)}${button(s.enabled ? 'Pause' : 'Enable','toggle-schedule',`data-name="${esc(s.name)}"`)}${s.lastRunId ? button('View last run','open',`data-id="${esc(s.lastRunId)}"`) : ''}${button('Delete','delete-schedule',`data-name="${esc(s.name)}"`,'danger')}</div></article>`).join('') || empty('Your time, on repeat', 'Save a score first, then schedule it to run on an interval or daily.'));
}
function scheduleDialog(existing) {
  if (!scores.length) { notice('Save or import a score before creating a schedule.'); return; }
  const s = existing || {name:'',score:scores[0].name,everyMinutes:60,inputs:{},autonomy:'accompaniment',enabled:true};
  dialog(existing ? 'Edit schedule' : 'New schedule', formWrap(`<label>Schedule name<input name="name" pattern="[a-z0-9][a-z0-9-]{0,62}" required value="${esc(s.name)}" ${existing ? 'readonly' : ''} placeholder="daily-research"></label><label>Saved score<select name="score">${scores.map(x => `<option ${x.name === s.score ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label><div class="fields"><label>Repeat<select name="repeat"><option value="interval" ${s.everyMinutes ? 'selected' : ''}>Every N minutes</option><option value="daily" ${s.dailyAt ? 'selected' : ''}>Daily · server local time</option></select></label><label>Minutes / daily time<input name="frequency" required value="${esc(s.dailyAt || s.everyMinutes)}" placeholder="60 or 09:00"></label></div><label>Performance mode${autonomy(s.autonomy)}</label>${budgetField(s.budgetUsd)}${inputsField(s.inputs)}<label class="check"><input name="enabled" type="checkbox" ${s.enabled ? 'checked' : ''}>Enabled</label><p class="help">Minimum interval is 5 minutes. Daily times use the server’s local timezone. A schedule can perform work and incur model costs.</p>`, 'Save schedule'), async form => {
    const f = new FormData(form), frequency = f.get('frequency');
    await post('/v1/schedules', {name:f.get('name'),score:f.get('score'),...optsFrom(form),enabled:f.has('enabled'),...(f.get('repeat') === 'daily' ? {dailyAt:frequency} : {everyMinutes:Number(frequency)})});
    notice('Schedule saved.');
  });
}
function download(name, data) { const u = URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})); const a = document.createElement('a'); a.href = u; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(u),1000); }
async function action(kind, el) {
  const id = el.dataset.id, name = el.dataset.name;
  if (kind === 'open') { location.hash = 'run/' + id; return; }
  if (kind === 'back') { location.hash = 'runs'; return; }
  if (kind === 'perform') { await post(`/v1/runs/${current}/perform`); notice('Performance started.'); detailSignature = ''; }
  if (kind === 'report') download(current + '.json', await api('/v1/runs/' + current));
  if (kind === 'save') dialog('Save this score',formWrap('<label>Name<input name="name" required pattern="[a-z0-9][a-z0-9-]{0,62}" placeholder="supplier-research"></label><label>Description<input name="description" placeholder="What this score does"></label>','Save score'),async form => { const f = new FormData(form); await post('/v1/scores',{runId:current,name:f.get('name'),description:f.get('description')}); notice('Score saved to your library.'); });
  if (kind === 'encore' || kind === 'recover' || kind === 'play') {
    const run = kind === 'play' ? null : await api('/v1/runs/' + current); const saved = kind === 'play' ? scores.find(s => s.name === name) : null;
    dialog(kind === 'recover' ? 'Recover performance' : kind === 'play' ? 'Play ' + name : 'Encore · run again',formWrap(`<p class="help">${kind === 'recover' ? 'Resume unfinished steps. Completed steps will be preserved.' : 'Starts a new performance with these inputs.'}</p>${kind !== 'recover' ? `<label>Performance mode${autonomy(run?.autonomy || 'accompaniment')}</label>${inputsField(run?.score.inputs || Object.fromEntries((saved?.inputs || []).map(x => [x,''])))}` : ''}${budgetField(run?.budgetUsd)}`,'Start performance'),async form => {
      const f = new FormData(form); const body = kind === 'recover' ? (f.get('budgetUsd') ? {budgetUsd:Number(f.get('budgetUsd'))} : {}) : optsFrom(form);
      const result = await post(kind === 'play' ? `/v1/scores/${encodeURIComponent(name)}/play` : `/v1/runs/${current}/${kind}`,body);
      if (result.id) location.hash = 'run/' + result.id; notice(kind === 'recover' ? 'Recovery requested.' : 'New performance started.'); detailSignature = '';
    });
  }
  if (kind === 'decide') { const a = approvals.find(x => x.id === id); if (!a) throw new Error('This decision is no longer pending.'); dialog('Review decision',formWrap(`<p>${esc(a.reason)}</p>${a.tool ? `<pre>${esc(a.tool)}\n${esc(JSON.stringify(a.input,null,2))}</pre>` : ''}<label>Decision<select name="approved"><option value="false">Decline action</option><option value="true">Approve action</option></select></label><label>Note (optional)<textarea name="note"></textarea></label>`,'Submit decision'),async form => { const f = new FormData(form); await post('/v1/approvals/' + id,{approved:f.get('approved') === 'true',note:f.get('note') || undefined,by:'podium'}); detailSignature = ''; notice('Decision recorded.'); }); }
  if (kind === 'cancel') confirmAction('Cancel this performance?', 'The engine will stop at the next cancellation check. Completed actions remain in the report.', async () => { await post(`/v1/runs/${current}/cancel`); notice('Cancellation requested.'); detailSignature = ''; });
  if (kind === 'export') { const saved = await api('/v1/scores/' + encodeURIComponent(name)); const {savedAt,inputs,...pkg} = saved; download(name + '.score.json',pkg); }
  if (kind === 'import') dialog('Import score package',formWrap('<p class="help">Choose an exported score package. Its digest is checked before installation. Review its permissions before playing.</p><label>Score package<input type="file" name="file" accept=".json,application/json" required></label>','Import score'),async form => { const file = $('input[type=file]',form).files[0]; if (file.size > 1000000) throw new Error('The package must be smaller than 1 MB.'); await post('/v1/scores/import',JSON.parse(await file.text())); notice('Score imported.'); });
  if (kind === 'delete-score' || kind === 'delete-schedule') confirmAction('Delete ' + name + '?', 'This removes the saved ' + (kind === 'delete-score' ? 'score. Existing performances are kept.' : 'schedule. Existing performances are kept.'),async () => { await api('/v1/' + (kind === 'delete-score' ? 'scores' : 'schedules') + '/' + encodeURIComponent(name),{method:'DELETE'}); notice('Deleted ' + name + '.'); });
  if (kind === 'new-schedule') scheduleDialog();
  if (kind === 'edit-schedule') scheduleDialog(schedules.find(x => x.name === name));
  if (kind === 'toggle-schedule') { const s = schedules.find(x => x.name === name); await post('/v1/schedules',{...s,enabled:!s.enabled}); notice(s.enabled ? 'Schedule paused.' : 'Schedule enabled.'); }
  await refresh(true);
}
function confirmAction(title,text,callback) { dialog(title,formWrap(`<p>${esc(text)}</p>`,'Confirm'),callback); }
$('#page').onclick = e => { const el = e.target.closest('[data-action]'); if (!el || el.disabled) return; el.disabled = true; action(el.dataset.action,el).catch(e => notice(e.message,true)).finally(() => { el.disabled = false; }); };
async function route() {
  stopEvents(); current = null; detailSignature = ''; notice('');
  const [target,id] = location.hash.slice(1).split('/'); view = ['scores','schedules','approvals','run'].includes(target) ? target : 'runs';
  document.querySelectorAll('[data-view]').forEach(a => { const active = a.dataset.view === (view === 'run' ? 'runs' : view); a.classList.toggle('active', active); if (active) a.setAttribute('aria-current','page'); else a.removeAttribute('aria-current'); });
  if (view === 'run' && id && /^run_[\w-]+$/.test(id)) { current = id; $('#page').innerHTML = empty('Loading performance…'); try { await drawDetail(id,true); startEvents(id); } catch(e) { $('#page').innerHTML = empty('Could not open performance', e.message) + button('← All performances','back'); } }
  else if (view === 'runs') home();
  else { $('#page').innerHTML = empty('Loading…'); await refresh(true); }
}
async function refresh(force = false) {
  if (refreshBusy) return; refreshBusy = true;
  try {
    [runs,approvals] = await Promise.all([api('/v1/runs'),api('/v1/approvals')]); connected(true);
    $('#run-count').textContent = runs.length; $('#approval-count').textContent = approvals.length;
    if (view === 'runs' && $('#run-list')) renderRuns();
    if (view === 'run' && current) await drawDetail(current,force);
    if (view === 'approvals') $('#page').innerHTML = heading('HUMAN IN THE LOOP','Your decisions matter.','Review consequential actions before they happen.') + (approvals.map(a => approvalCard(a,true)).join('') || empty('All clear', 'There are no decisions waiting for you.'));
    if (view === 'scores' || view === 'schedules') {
      scores = await api('/v1/scores');
      if (view === 'scores') libraryPage();
      else { schedules = await api('/v1/schedules'); schedulesPage(); }
    }
  } catch(e) { connected(false); notice(e.message,true); }
  finally { refreshBusy = false; }
}
window.addEventListener('hashchange',route);
window.addEventListener('online',() => refresh(true));
window.addEventListener('pagehide',stopEvents);
void route().then(() => refresh());
setInterval(() => { if (!document.hidden && !modal.open) void refresh(); },5000);
