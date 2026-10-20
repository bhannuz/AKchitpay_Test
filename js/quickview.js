// ═══════════════════════════════════════════════════════════
// AK Chit Funds — QUICK VIEW MODALS
// Edit only this file when changing members chip popup, groups chip popup
// ═══════════════════════════════════════════════════════════

// QUICK VIEW MODALS (Members & Groups chips)
// ══════════════════════════════════════════
let _allMembersCache = [];
let _allGroupsCache = [];

async function openMembersQuickView(){
    const ms = await getCollection('members');
    const gs = await getCollection('groups');
    const ps = await getCollection('payments');
    _allMembersCache = ms;
    openModal('membersQuickModal');
    renderMembersQuick(ms, gs, ps);
}

function renderMembersQuick(ms, gs, ps, filter=''){
    const list = document.getElementById('membersQuickList');
    const filtered = filter ? ms.filter(m => m.name.toLowerCase().includes(filter.toLowerCase()) || (m.phone||'').includes(filter)) : ms;
    if(!filtered.length){
        list.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:24px;font-size:1.05rem;">No members found</div>';
        return;
    }
    list.innerHTML = filtered.map((m,i) => {
        const initials = ini(m.name);
        return `<div style="display:flex;align-items:center;gap:10px;background:var(--input-bg);border:1px solid var(--border);border-radius:12px;padding:10px 12px;">
            <div style="width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#f39c12,#f57c00);color:#000;display:flex;align-items:center;justify-content:center;font-size:0.95rem;font-weight:900;flex-shrink:0;">${initials}</div>
            <div style="flex:1;min-width:0;">
                <div style="font-weight:800;font-size:0.92rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${m.name}</div>
                <div style="font-size:0.75rem;color:var(--text-dim);margin-top:2px;">📱 ${m.phone||'—'}</div>
            </div>
            <div style="display:flex;gap:6px;flex-shrink:0;">
                <button class="btn-edit-sm" onclick="closeModal('membersQuickModal');document.getElementById('summarySearch').value='${m.name.replace(/'/g,"\'")}';document.getElementById('summaryView').value='${m.id}';loadMemberLedger();" style="font-size:0.7rem;padding:4px 9px;">📋 View</button>
                ${isAdmin()?`<button class="btn-edit-sm" onclick="openEditMember('${m.id}')" style="font-size:0.7rem;padding:4px 9px;">✏️</button>`:''}
            </div>
        </div>`;
    }).join('');
}

async function filterMembersQuick(){
    const ms = await getCollection('members');
    const gs = await getCollection('groups');
    const ps = await getCollection('payments');
    const filter = document.getElementById('mqSearch').value;
    renderMembersQuick(ms, gs, ps, filter);
}

async function openGroupsQuickView(){
    const gs = await getCollection('groups');
    const ms = await getCollection('members');
    const ps = await getCollection('payments');
    openModal('groupsQuickModal');
    renderGroupsQuick(gs, ms, ps);
}

function renderGroupsQuick(gs, ms, ps){
    const list = document.getElementById('groupsQuickList');
    if(!gs.length){
        list.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:24px;font-size:1.05rem;">No groups yet</div>';
        return;
    }
    list.innerHTML = gs.map(g => {
        const gMs = ms.filter(m => (m.enrollments||[]).some(e=>e.groupId===g.id)||(m.groupIds||[]).includes(g.id));
        const gPays = ps.filter(p => p.groupId === g.id);
        const tPaid = gPays.reduce((s,p) => s+(parseFloat(p.paid)||0), 0);
        const tBal = gPays.reduce((s,p) => s+(parseFloat(p.balance)||0), 0);
        const picked = gPays.filter(p => p.chitPicked==='Yes').length;
        const totalMonths = parseInt(g.duration||g.gDuration)||21;
        let elapsed = 0;
        if(g.startDate||g.gStart){
            const _s=new Date(g.startDate||g.gStart), _n=new Date();
            elapsed = Math.max(0,Math.min(totalMonths,(_n.getFullYear()-_s.getFullYear())*12+(_n.getMonth()-_s.getMonth())+1));
        }
        const left = Math.max(0, totalMonths-elapsed);
        const pct = Math.min(100, Math.round(elapsed/totalMonths*100));
        const gStartDisp = fmtDate(g.startDate||g.gStart||'');
        const totalSlots = gMs.reduce((s,m)=>{const e=(m.enrollments||[]).find(x=>x.groupId===g.id);return s+(e?parseInt(e.qty||1):1);},0);

        // List members
        const memberList = gMs.slice(0,5).map(m => {
            const mp = ps.filter(p=>p.memberId===m.id&&p.groupId===g.id);
            const paid = mp.reduce((s,p)=>s+(parseFloat(p.paid)||0),0);
            const bal = mp.reduce((s,p)=>s+(parseFloat(p.balance)||0),0);
            const pickedM = mp.find(p=>p.chitPicked==='Yes');
            return `<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-bottom:1px solid rgba(255,255,255,0.04);">
                <div style="width:26px;height:26px;border-radius:7px;background:rgba(243,156,18,.15);color:#f39c12;display:flex;align-items:center;justify-content:center;font-size:0.92rem;font-weight:800;flex-shrink:0;">${ini(m.name)}</div>
                <span style="flex:1;font-size:0.98rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${m.name}</span>
                <span style="font-size:1.05rem;color:#34d399;">₹${paid.toLocaleString('en-IN')}</span>
                ${bal>0?`<span style="font-size:1.05rem;color:#f59e0b;">bal ₹${bal.toLocaleString('en-IN')}</span>`:''}
                ${pickedM?`<span style="font-size:0.98rem;background:rgba(16,185,129,.2);color:#34d399;border:1px solid rgba(16,185,129,.4);border-radius:4px;padding:1px 5px;flex-shrink:0;">✅ Picked</span>`:''}
            </div>`;
        }).join('');
        const moreCount = gMs.length > 5 ? `<div style="padding:4px 8px;font-size:1.05rem;color:var(--text-dim);text-align:center;">+${gMs.length-5} more members</div>` : '';

        return `<div style="background:var(--input-bg);border:1px solid var(--border);border-radius:14px;overflow:hidden;">
            <div style="padding:12px 14px;border-bottom:1px solid var(--border);">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
                    <div>
                        <div style="font-size:1.05rem;font-weight:800;color:#f39c12;">📂 ${g.name}</div>
                        <div style="font-size:0.92rem;color:var(--text-dim);margin-top:2px;">${totalSlots===gMs.length?totalSlots+' members':totalSlots+' chit slots'} &nbsp;·&nbsp; 🗓 ${gStartDisp}</div>
                    </div>
                    <div style="display:flex;gap:5px;">
                        <button onclick="closeModal('groupsQuickModal');generateGroupPDF('${g.id}')" style="background:linear-gradient(135deg,#e74c3c,#c0392b);color:white;border:none;border-radius:7px;padding:4px 9px;font-size:1.05rem;font-weight:700;cursor:pointer;">📄 PDF</button>
                        ${isAdmin()?`<button class="btn-edit-sm" onclick="openEditGroup('${g.id}')" style="font-size:1.05rem;padding:4px 9px;">✏️</button>`:''}
                    </div>
                </div>
                <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:8px;">
                    <div style="background:rgba(0,0,0,.2);border-radius:8px;padding:6px;text-align:center;">
                        <div style="font-size:1.05rem;font-weight:800;color:#34d399;">₹${tPaid.toLocaleString('en-IN')}</div>
                        <div style="font-size:0.68rem;color:var(--text-dim);text-transform:uppercase;">Collected</div>
                    </div>
                    <div style="background:rgba(0,0,0,.2);border-radius:8px;padding:6px;text-align:center;">
                        <div style="font-size:1.05rem;font-weight:800;color:#f59e0b;">₹${tBal.toLocaleString('en-IN')}</div>
                        <div style="font-size:0.68rem;color:var(--text-dim);text-transform:uppercase;">Balance</div>
                    </div>
                    <div style="background:rgba(0,0,0,.2);border-radius:8px;padding:6px;text-align:center;">
                        <div style="font-size:1.05rem;font-weight:800;color:#a5b4fc;">${left}/${totalMonths}</div>
                        <div style="font-size:0.68rem;color:var(--text-dim);text-transform:uppercase;">Pending</div>
                    </div>
                    <div style="background:rgba(0,0,0,.2);border-radius:8px;padding:6px;text-align:center;">
                        <div style="font-size:1.05rem;font-weight:800;color:#34d399;">${picked}</div>
                        <div style="font-size:0.68rem;color:var(--text-dim);text-transform:uppercase;">Picked</div>
                    </div>
                </div>
                <div style="background:#252f48;border-radius:4px;height:5px;overflow:hidden;">
                    <div style="height:100%;border-radius:4px;background:linear-gradient(90deg,#f39c12,#f57c00);width:${pct}%"></div>
                </div>
                <div style="display:flex;justify-content:space-between;font-size:0.98rem;color:var(--text-dim);margin-top:3px;">
                    <span>Month ${elapsed}/${totalMonths}</span><span>${pct}% complete</span>
                </div>
            </div>
            ${gMs.length?`<div>${memberList}${moreCount}</div>`:'<div style="padding:8px 14px;font-size:1.05rem;color:var(--text-dim);text-align:center;">No members yet</div>'}
        </div>`;
    }).join('');
}

// ══════════════════════════════════════════
