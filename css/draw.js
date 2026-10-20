// ═══════════════════════════════════════════════════════════
// AK Chit Funds — CHIT DRAW (spin wheel)
// Used when nobody volunteers to pick the chit for a month:
// spins a wheel of the members who have NOT yet picked in that group.
// Lives in the collapsible "Spin Wheel" section on the Home tab (admin only).
// ═══════════════════════════════════════════════════════════

let _drawState = null;

function _drawEsc(s){ return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// Members (slots) of a group who have not picked their chit yet
function _drawEligible(g, ms, ps){
    const out = [];
    const seenJoint = new Set();
    const gMs = ms.filter(m => m.groupIds && m.groupIds.includes(g.id));
    gMs.forEach(m => {
        const enr = (m.enrollments||[]).find(e => e.groupId === g.id);
        const qty = enr ? parseInt(enr.qty||1) : 1;
        const coMid = enr && enr.coMemberId ? enr.coMemberId : '';
        if(coMid){
            const key = [m.id, coMid].sort().join('_');
            if(seenJoint.has(key)) return;
            seenJoint.add(key);
        }
        const coM = coMid ? ms.find(x => x.id === coMid) : null;
        for(let q = 1; q <= qty; q++){
            const mine = ps.filter(p => p.memberId === m.id && p.groupId === g.id);
            const co   = coMid ? ps.filter(p => p.memberId === coMid && p.groupId === g.id) : [];
            const slotPays = [...mine, ...co].filter(p => {
                if(qty > 1){
                    if(enr && enr.enrollmentId && p.enrollmentId) return p.enrollmentId === enr.enrollmentId && (p.slotNum == null || Number(p.slotNum) === q);
                    return (p.slotNum != null ? Number(p.slotNum) : 1) === q;
                }
                return true;
            });
            if(slotPays.some(p => p.chitPicked === 'Yes')) continue;   // already picked
            let label = m.name + (coM ? ' & ' + coM.name : '');
            if(qty > 1) label += ' (C' + q + ')';
            out.push({ id: m.id + '_' + q, memberId: m.id, slotNum: q, label });
        }
    });
    return out;
}

// Who already picked in a given month slot (for the warning line)
function _drawPickedInMonth(g, ps, ms, slotIndex, dueDates){
    const hit = ps.find(p => {
        if(p.groupId !== g.id || p.chitPicked !== 'Yes') return false;
        if(p.monthSlot != null) return p.monthSlot === slotIndex;
        if(Array.isArray(p.monthSlots)) return p.monthSlots.includes(slotIndex);
        return getMonthSlot(dueDates, p.date) === slotIndex;
    });
    if(!hit) return '';
    const m = ms.find(x => x.id === hit.memberId);
    return m ? m.name : 'someone';
}

function toggleSpinSection(){
    const body = document.getElementById('spinSectionBody');
    const chev = document.getElementById('spinSectionChevron');
    if(!body) return;
    const open = body.style.display === 'none' || body.style.display === '';
    body.style.display = open ? 'block' : 'none';
    if(chev) chev.style.transform = open ? 'rotate(90deg)' : '';
    if(open) loadSpinWheel();
}

async function loadSpinWheel(keepGid){
    const body = document.getElementById('spinSectionBody'); if(!body) return;
    if(_drawState && _drawState.spinning) return;
    body.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-dim);font-size:0.8rem;">Loading…</div>';
    const [gs, ms, ps] = await Promise.all([getCollection('groups'), getCollection('members'), getCollection('payments', true)]);
    let saved = {};
    try{ const d = await db.collection('settings').doc('chitDraws').get(); if(d.exists) saved = d.data().draws || {}; }catch(e){}
    if(!gs.length){ body.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-dim);">No groups yet.</div>'; return; }
    const gid = keepGid && gs.find(x => x.id === keepGid) ? keepGid : gs[0].id;
    _drawState = { gs, ms, ps, saved, angle: 0, spinning: false, winner: null };
    _drawSetGroup(gid);
    _drawRender();
}

function _drawSetGroup(gid){
    const S = _drawState;
    S.g = S.gs.find(x => x.id === gid);
    S.dueDates = getGroupDueDates(S.g);
    S.names = _drawEligible(S.g, S.ms, S.ps);
    const today = new Date().toISOString().split('T')[0];
    let defIdx = 0; S.dueDates.forEach((d, i) => { if(d <= today) defIdx = i; });
    S.slotIndex = defIdx; S.winner = null; S.angle = 0;
}

function _drawRender(){
    const S = _drawState; const body = document.getElementById('spinSectionBody'); if(!S || !body) return;
    const sty = 'width:100%;margin-bottom:6px;padding:8px;border-radius:8px;background:var(--input-bg);color:#e5e7eb;border:1px solid rgba(255,255,255,0.15);font-size:0.8rem;';
    const grpOpts = S.gs.map(x => `<option value="${x.id}" ${x.id === S.g.id ? 'selected' : ''}>${_drawEsc(x.name)}</option>`).join('');
    const monthOpts = S.dueDates.map((d, i) => `<option value="${i}" ${i === S.slotIndex ? 'selected' : ''}>Month ${i + 1} — ${fmtDate(d)}${S.saved[S.g.id + '_' + i] ? ' ✔ drawn' : ''}</option>`).join('');
    body.innerHTML = `<div style="padding:14px 16px;text-align:center;">
        <select id="drawGroupSel" onchange="_drawGroupChanged(this.value)" style="${sty}">${grpOpts}</select>
        <select id="drawMonthSel" onchange="_drawMonthChanged(this.value)" style="${sty}">${monthOpts}</select>
        <div id="drawNote" style="font-size:0.72rem;margin-bottom:8px;min-height:1em;"></div>
        <div id="drawBody"></div>
    </div>`;
    _drawBody();
}

function _drawGroupChanged(gid){
    if(!_drawState || _drawState.spinning) return;
    _drawSetGroup(gid); _drawRender();
}

function _drawMonthChanged(v){
    if(!_drawState || _drawState.spinning) return;
    _drawState.slotIndex = parseInt(v);
    _drawState.winner = null;
    _drawBody();
}

function _drawBody(){
    const S = _drawState; if(!S) return;
    const note = document.getElementById('drawNote');
    const body = document.getElementById('drawBody');
    if(!note || !body) return;
    const key = S.g.id + '_' + S.slotIndex;
    const already = _drawPickedInMonth(S.g, S.ps, S.ms, S.slotIndex, S.dueDates);
    const prev = S.saved[key];
    let msg = '';
    if(already) msg += `<div style="color:#f87171;">⚠ ${_drawEsc(already)} already picked this month.</div>`;
    if(prev) msg += `<div style="color:#34d399;">Previously drawn: <b>${_drawEsc(prev.name)}</b></div>`;
    note.innerHTML = msg;

    if(!S.names.length){
        body.innerHTML = '<div style="padding:24px 0;color:#9ca3af;">Everyone in this group has already picked their chit.</div>';
        return;
    }
    if(S.names.length === 1){
        body.innerHTML = `<div style="padding:20px 0;"><div style="color:#9ca3af;font-size:0.75rem;">Only one member left to pick</div><div style="font-size:1.2rem;font-weight:800;color:#34d399;margin-top:6px;">🏆 ${_drawEsc(S.names[0].label)}</div></div>`;
        return;
    }
    const avail = (document.getElementById('spinSectionBody').clientWidth || window.innerWidth) - 40;
    const size = Math.max(220, Math.min(320, avail));
    body.innerHTML = `
        <div style="position:relative;width:${size}px;height:${size + 14}px;margin:0 auto;">
            <div style="position:absolute;left:50%;top:0;transform:translateX(-50%);z-index:2;width:0;height:0;border-left:11px solid transparent;border-right:11px solid transparent;border-top:22px solid #f43f5e;filter:drop-shadow(0 2px 2px rgba(0,0,0,.6));"></div>
            <canvas id="drawCanvas" width="${size * 2}" height="${size * 2}" style="position:absolute;left:0;top:14px;width:${size}px;height:${size}px;"></canvas>
        </div>
        <div id="drawResult" style="min-height:44px;margin:10px 0 6px;font-size:1.1rem;font-weight:800;color:#34d399;">${S.winner ? '🏆 ' + _drawEsc(S.winner.label) : ''}</div>
        <div style="font-size:0.66rem;color:#9ca3af;margin-bottom:8px;">${S.names.length} members in the draw (those who have not picked yet)</div>
        <div id="drawBtns" style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;"></div>`;
    _drawCanvas();
    _drawButtons();
}

function _drawButtons(){
    const S = _drawState; const b = document.getElementById('drawBtns'); if(!S || !b) return;
    const base = 'border:none;border-radius:10px;padding:9px 18px;font-weight:800;font-size:0.85rem;cursor:pointer;';
    if(S.spinning){ b.innerHTML = `<button disabled style="${base}background:#374151;color:#9ca3af;">Spinning…</button>`; return; }
    if(S.winner){
        b.innerHTML = `<button onclick="_drawSave()" style="${base}background:#10b981;color:#fff;">✔ Confirm & Save</button>
                       <button onclick="chitDrawSpin()" style="${base}background:#374151;color:#e5e7eb;">🔄 Spin again</button>`;
    } else {
        b.innerHTML = `<button onclick="chitDrawSpin()" style="${base}background:#f39c12;color:#1a1f2e;">🎡 SPIN</button>`;
    }
}

function _drawCanvas(){
    const S = _drawState; const c = document.getElementById('drawCanvas'); if(!S || !c) return;
    const ctx = c.getContext('2d'); const W = c.width, R = W / 2 - 6, n = S.names.length, seg = 2 * Math.PI / n;
    const cols = ['#f39c12', '#6366f1', '#10b981', '#ec4899', '#0ea5e9', '#eab308', '#8b5cf6', '#ef4444', '#14b8a6', '#f97316'];
    ctx.clearRect(0, 0, W, W);
    ctx.save(); ctx.translate(W / 2, W / 2); ctx.rotate(S.angle);
    S.names.forEach((nm, i) => {
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, R, i * seg, (i + 1) * seg); ctx.closePath();
        ctx.fillStyle = cols[i % cols.length]; ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 2; ctx.stroke();
        ctx.save(); ctx.rotate(i * seg + seg / 2); ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff';
        const fs = Math.max(14, Math.min(30, Math.floor(R * seg * 0.55)));
        ctx.font = '700 ' + fs + 'px sans-serif';
        let t = nm.label; const maxW = R - 34;
        while(t.length > 3 && ctx.measureText(t).width > maxW) t = t.slice(0, -2);
        if(t !== nm.label) t = t.trimEnd() + '…';
        ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 3;
        ctx.fillText(t, R - 16, 0); ctx.restore();
    });
    ctx.restore();
    ctx.beginPath(); ctx.arc(W / 2, W / 2, 20, 0, 2 * Math.PI); ctx.fillStyle = '#1a1f2e'; ctx.fill();
    ctx.strokeStyle = '#f39c12'; ctx.lineWidth = 4; ctx.stroke();
}

function chitDrawSpin(){
    const S = _drawState; if(!S || S.spinning || S.names.length < 2) return;
    // Fair, unbiased pick via crypto RNG
    const rnd = () => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
    const n = S.names.length, seg = 2 * Math.PI / n;
    const w = Math.floor(rnd() * n);
    const f = 0.15 + rnd() * 0.7;                       // land inside the segment, not on the edge
    const TAU = 2 * Math.PI;
    const finalMod = (((-Math.PI / 2 - (w + f) * seg) % TAU) + TAU) % TAU;   // pointer is at top
    const a0 = S.angle;
    const delta = ((((finalMod - a0) % TAU) + TAU) % TAU) + TAU * (5 + Math.floor(rnd() * 3));
    const dur = 5500, t0 = performance.now();
    S.spinning = true; S.winner = null;
    const res = document.getElementById('drawResult'); if(res) res.textContent = '';
    const sel = document.getElementById('drawMonthSel'), gsel = document.getElementById('drawGroupSel');
    if(sel) sel.disabled = true; if(gsel) gsel.disabled = true;
    _drawButtons();
    const step = now => {
        const t = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - t, 4);
        S.angle = a0 + delta * e;
        _drawCanvas();
        if(t < 1){ requestAnimationFrame(step); return; }
        S.spinning = false; S.winner = S.names[w];
        const r = document.getElementById('drawResult'); if(r) r.innerHTML = '🏆 ' + _drawEsc(S.winner.label);
        if(sel) sel.disabled = false; if(gsel) gsel.disabled = false;
        _drawButtons();
    };
    requestAnimationFrame(step);
}

async function _drawSave(){
    const S = _drawState; if(!S || !S.winner) return;
    const key = S.g.id + '_' + S.slotIndex;
    const rec = { name: S.winner.label, memberId: S.winner.memberId, slotNum: S.winner.slotNum, month: S.slotIndex + 1, date: new Date().toISOString() };
    try{
        await db.collection('settings').doc('chitDraws').set({ draws: { [key]: rec } }, { merge: true });
        S.saved[key] = rec;
        showToast('✅ Draw saved — ' + rec.name + ' · record the chit pick in Payments');
    }catch(e){
        showToast('❌ Could not save draw result', false);
        return;
    }
    S.winner = null; _drawRender();
}
