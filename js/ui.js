// ═══════════════════════════════════════════════════════════
// AK Chit Funds — UI & NAVIGATION
// Edit only this file when changing tab switching, toasts, modals, search, updateUI
// ═══════════════════════════════════════════════════════════

// Normalize payment mode display
function normalizePaidBy(paidBy) {
    if(!paidBy) return '—';
    const mode = String(paidBy).toLowerCase();
    if(mode.includes('phone') || mode.includes('pe')) return 'Phone Pe';
    if(mode.includes('gpay')) return 'Gpay';
    if(mode.includes('bank')) return 'Bank';
    if(mode.includes('cash')) return 'Cash';
    return paidBy;
}

function switchTab(t){
    document.querySelectorAll('.tab-content').forEach(c=>c.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(i=>i.classList.remove('active'));
    document.querySelectorAll('.tab-nav-item-desktop').forEach(i=>i.classList.remove('active'));
    
    document.getElementById(t+'Tab').classList.add('active');
    const mobNavId = 'nav'+t.charAt(0).toUpperCase()+t.slice(1);
    const mobNav = document.getElementById(mobNavId);
    if(mobNav) mobNav.classList.add('active');
    
    const desktopNavId = 'nav'+t.charAt(0).toUpperCase()+t.slice(1)+'Desktop';
    const desktopNav = document.getElementById(desktopNavId);
    if(desktopNav) desktopNav.classList.add('active');
    
    updateUI();
}

async function migrateData(){
    const ms=await getCollection('members');
    for(let m of ms){if(m.groupId&&!m.groupIds){await db.collection('members').doc(m.id).update({groupIds:[m.groupId],groupId:firebase.firestore.FieldValue.delete()});}}
    updateUI();
}

async function updateUI(){
    const m=await getCollection('members');const g=await getCollection('groups');const p=await getCollection('payments');
    ALL_MEMBERS=m;
    
    // Set member-mode class based on user role
    if(CURRENT_USER && CURRENT_USER.role==='member'){
        document.body.classList.add('member-mode');
        const myPays=p.filter(x=>x.memberId===CURRENT_USER.memberId);
        const myGroups=new Set(myPays.map(x=>x.groupId));
        document.getElementById('memberCount').innerText='—';
        document.getElementById('groupCount').innerText=myGroups.size;
        const today=new Date().toISOString().split('T')[0];
        document.getElementById('todayColl').innerText=fmtAmt(myPays.filter(x=>x.date===today).reduce((s,x)=>s+(parseFloat(x.paid)||0),0));
        return;
    } else {
        document.body.classList.remove('member-mode');
    }
    document.getElementById('memberCount').innerText=m.length;
    document.getElementById('groupCount').innerText=g.length;
    const today=new Date().toISOString().split('T')[0];
    document.getElementById('todayColl').innerText=fmtAmt(p.filter(x=>x.date===today).reduce((s,x)=>s+(parseFloat(x.paid)||0),0));
    if(document.getElementById('groupsTab').classList.contains('active'))renderGroupsTab();
}

function filterSearch(inputId,listId,hiddenId){
    const query=document.getElementById(inputId).value.toLowerCase();
    const list=document.getElementById(listId);
    list.innerHTML='';if(!query){list.style.display='none';return;}
    const filtered=ALL_MEMBERS.filter(m=>m.name.toLowerCase().includes(query));
    if(filtered.length>0){
        list.style.display='block';
        filtered.forEach(m=>{
            const div=document.createElement('div');div.className='suggestion-item';div.innerText=m.name;
            div.onclick=()=>{
                document.getElementById(inputId).value=m.name;
                document.getElementById(hiddenId).value=m.id;
                list.style.display='none';
                if(hiddenId==='summaryView') loadMemberLedger();
                if(hiddenId==='pMember') linkGroupForPayment();
                // Auto-add for QR member search
                if(hiddenId==='qr_member_id') qrAddMember();
            };
            list.appendChild(div);});
    }else{list.style.display='none';}
}

// ── Member Sub-tab Switcher ───────────────────────────────────────────────────
const _mSubCfg = {
    dash:  { btn:'mSubDash',  panel:'mDashPanel',  color:'rgba(243,156,18,0.85)', fg:'black'  },
    pay:   { btn:'mSubPay',   panel:'mPayPanel',   color:'rgba(99,102,241,0.85)', fg:'white'  },
    stats: { btn:'mSubStats', panel:'mStatsPanel', color:'rgba(16,185,129,0.85)', fg:'white'  },
    qr:    { btn:'mSubQr',    panel:'mQrPanel',    color:'rgba(59,130,246,0.85)', fg:'white'  },
};

function switchMemberSubTab(tab) {
    const allPanels = ['mDashPanel','mPayPanel','mStatsPanel','mQrPanel'];
    // homeTab contains admin content — hide it for all member sub-tabs
    const homeTab = document.getElementById('homeTab');
    if(homeTab) homeTab.style.display = 'none';

    allPanels.forEach(pid => {
        const p = document.getElementById(pid);
        if(p) p.style.display = 'none';
    });

    // Show selected panel
    const active = document.getElementById(_mSubCfg[tab]?.panel || '');
    if(active) active.style.display = '';

    // Style buttons
    Object.keys(_mSubCfg).forEach(k => {
        const cfg = _mSubCfg[k];
        const btn = document.getElementById(cfg.btn);
        if(btn){
            const isActive = k === tab;
            btn.style.background = isActive ? cfg.color : 'var(--card-bg)';
            btn.style.color      = isActive ? cfg.fg    : 'var(--text-dim)';
            btn.style.border     = isActive ? 'none'    : '1px solid var(--border)';
        }
    });

    if(tab === 'dash')  loadMemberLedger();
    if(tab === 'pay')   renderMemberPayHistory();
    if(tab === 'stats') renderMemberStats();
    if(tab === 'qr')    renderMemberQrPanel();
}

// ── Member Statistics (interactive) ──────────────────────────────────────────
async function renderMemberStats(filterGid, filterMonth) {
    if(!CURRENT_USER || CURRENT_USER.role !== 'member') return;
    const mid  = CURRENT_USER.memberId;
    const ps   = await getCollection('payments');
    const gs   = await getCollection('groups');
    const myPaysAll = ps.filter(p => p.memberId === mid);
    const myGids    = [...new Set(myPaysAll.map(p=>p.groupId))];

    // Populate group filter
    const gSel = document.getElementById('mStatsGroupFilter');
    if(gSel && gSel.options.length <= 1){
        myGids.forEach(gid=>{
            const g = gs.find(x=>x.id===gid);
            const o = document.createElement('option');
            o.value = gid; o.text = g?.name||gid;
            gSel.appendChild(o);
        });
    }

    // Populate month filter
    const mSel = document.getElementById('mStatsMonthFilter');
    if(mSel && mSel.options.length <= 1){
        const months = [...new Set(myPaysAll.map(p=>(p.date||'').slice(0,7)).filter(Boolean))].sort().reverse();
        months.forEach(m=>{
            const o = document.createElement('option');
            o.value = m; o.text = m;
            mSel.appendChild(o);
        });
    }

    // Read current filters
    const activeGid   = filterGid   ?? (gSel?.value||'');
    const activeMonth = filterMonth ?? (mSel?.value||'');

    let myPays = myPaysAll;
    if(activeGid)   myPays = myPays.filter(p=>p.groupId===activeGid);
    if(activeMonth) myPays = myPays.filter(p=>(p.date||'').startsWith(activeMonth));

    const today     = new Date().toISOString().split('T')[0];
    const thisMonth = today.slice(0,7);
    const totalPaid = myPays.reduce((s,p)=>s+(parseFloat(p.paid)||0),0);
    const totalBal  = myPays.reduce((s,p)=>s+(parseFloat(p.balance)||0),0);
    const chitPicks = myPays.filter(p=>p.chitPicked==='Yes').length;

    // Summary
    const sumEl = document.getElementById('mStatsSummary');
    if(sumEl) sumEl.innerHTML = [
        ['💰 Total Paid',   fmtAmt(totalPaid), '#f39c12'],
        ['📋 Balance Due',  fmtAmt(totalBal),  totalBal>0?'#f87171':'#34d399'],
        ['📝 Payments',     myPays.length,      '#a5b4fc'],
        ['🎯 Chits Picked', chitPicks,          '#34d399'],
        ['📂 Groups',       activeGid ? 1 : myGids.length, '#f59e0b'],
    ].map(([lbl,val,col],i)=>`<tr style="border-bottom:${i<4?'1px solid rgba(255,255,255,0.05)':'none'};">
        <td style="padding:8px 12px;font-size:0.78rem;color:var(--text-dim);">${lbl}</td>
        <td style="padding:8px 12px;font-size:0.85rem;font-weight:800;color:${col};text-align:right;">${val}</td>
    </tr>`).join('');

    // Group-wise (show all groups, highlight filtered)
    const grpEl = document.getElementById('mStatsGroups');
    if(grpEl){
        const rows = myGids.map(gid=>{
            const g    = gs.find(x=>x.id===gid);
            const gPay = myPaysAll.filter(p=>p.groupId===gid);
            const paid = gPay.reduce((s,p)=>s+(parseFloat(p.paid)||0),0);
            const bal  = gPay.reduce((s,p)=>s+(parseFloat(p.balance)||0),0);
            const dur  = parseInt(g?.duration||g?.months||13);
            const paidM= new Set();
            gPay.forEach(p=>{ if(Array.isArray(p.monthSlots)) p.monthSlots.forEach(s=>paidM.add(s)); else if(p.monthSlot!=null) paidM.add(p.monthSlot); });
            const pct  = Math.min(100,Math.round((paidM.size/dur)*100));
            const highlighted = activeGid===gid;
            return `<tr style="border-bottom:1px solid rgba(255,255,255,0.04);cursor:pointer;${highlighted?'background:rgba(99,102,241,0.08);':''}" onclick="document.getElementById('mStatsGroupFilter').value='${gid}';renderMemberStats();">
                <td style="padding:7px 12px;font-size:0.75rem;color:${highlighted?'#a5b4fc':'white'};font-weight:700;max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${g?.name||gid}</td>
                <td style="padding:7px 12px;font-size:0.75rem;color:#34d399;text-align:right;white-space:nowrap;">${fmtAmt(paid)}</td>
                <td style="padding:7px 12px;font-size:0.75rem;color:${bal>0?'#f87171':'#34d399'};text-align:right;white-space:nowrap;">${fmtAmt(bal)}</td>
                <td style="padding:7px 12px;">
                    <div style="display:flex;align-items:center;gap:4px;">
                        <div style="flex:1;background:rgba(255,255,255,0.07);border-radius:3px;height:5px;overflow:hidden;min-width:28px;">
                            <div style="background:linear-gradient(90deg,#6366f1,#34d399);width:${pct}%;height:100%;border-radius:3px;"></div>
                        </div>
                        <span style="font-size:0.6rem;color:var(--text-dim);">${paidM.size}/${dur}</span>
                    </div>
                </td>
            </tr>`;
        });
        grpEl.innerHTML = rows.length ? rows.join('') : '<tr><td colspan="4" style="padding:12px;text-align:center;color:var(--text-dim);font-size:0.75rem;">No data</td></tr>';
    }

    // Recent payments table
    const monEl = document.getElementById('mStatsMonthly');
    if(monEl){
        const sorted = [...myPays].sort((a,b)=>(b.date||'').localeCompare(a.date||''));
        monEl.innerHTML = sorted.length ? sorted.map((p,i)=>{
            const g = gs.find(x=>x.id===p.groupId);
            const dateFormatted = p.date ? (() => {
                const d = new Date(p.date+'T00:00:00');
                const m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
                const dd = String(d.getDate()).padStart(2,'0');
                const mm = m[d.getMonth()];
                const yy = String(d.getFullYear()).slice(-2);
                return `${dd}/${mm}/${yy}`;
            })() : '—';
            return `<tr style="border-bottom:${i<sorted.length-1?'1px solid rgba(255,255,255,0.04)':'none'};">
                <td style="padding:6px 12px;font-size:0.72rem;color:var(--text-dim);white-space:nowrap;">${dateFormatted}</td>
                <td style="padding:6px 12px;font-size:0.72rem;font-weight:800;color:#34d399;text-align:right;white-space:nowrap;">${fmtAmt(parseFloat(p.paid)||0)}</td>
                <td style="padding:6px 12px;font-size:0.72rem;color:var(--text-dim);">${normalizePaidBy(p.paidBy)}</td>
                <td style="padding:6px 12px;font-size:0.72rem;color:var(--text-dim);">${g?.name||'—'}</td>
                <td style="padding:6px 12px;font-size:0.65rem;color:${p.chitPicked==='Yes'?'#34d399':'var(--text-dim)'};">${p.chitPicked==='Yes'?'✅':''}</td>
            </tr>`;
        }).join('') : '<tr><td colspan="5" style="padding:12px;text-align:center;color:var(--text-dim);font-size:0.75rem;">No payments</td></tr>';
    }
}

async function renderMemberPayHistory() {
    const el = document.getElementById('memberLedgerArea2');
    if(!el || !CURRENT_USER) return;
    el.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-dim);font-size:0.8rem;">Loading…</div>';
    const mid  = CURRENT_USER.memberId;
    const ps   = await getCollection('payments');
    const gs   = await getCollection('groups');
    const myPays = ps.filter(p=>p.memberId===mid).sort((a,b)=>(b.date||'').localeCompare(a.date||''));

    if(!myPays.length){
        el.innerHTML='<div style="text-align:center;padding:30px;color:var(--text-dim);font-size:0.82rem;">No payments recorded yet.</div>';
        return;
    }

    // Summary bar
    const totalPaid = myPays.reduce((s,p)=>s+(parseFloat(p.paid)||0),0);
    const totalBal  = myPays.reduce((s,p)=>s+(parseFloat(p.balance)||0),0);

    el.style.cssText='';
    el.innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
            <div style="background:rgba(52,211,153,0.08);border:1px solid rgba(52,211,153,0.25);border-radius:10px;padding:10px 12px;text-align:center;">
                <div style="font-size:0.6rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px;">Total Paid</div>
                <div style="font-size:1rem;font-weight:900;color:#34d399;">${fmtAmt(totalPaid)}</div>
            </div>
            <div style="background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.25);border-radius:10px;padding:10px 12px;text-align:center;">
                <div style="font-size:0.6rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px;">Balance Due</div>
                <div style="font-size:1rem;font-weight:900;color:${totalBal>0?'#f87171':'#34d399'};">${fmtAmt(totalBal)}</div>
            </div>
        </div>
        <div style="background:var(--card-bg);border:1px solid var(--border);border-radius:12px;overflow:hidden;">
            <div style="padding:8px 12px;border-bottom:1px solid var(--border);font-size:0.62rem;font-weight:800;color:#a5b4fc;text-transform:uppercase;letter-spacing:.4px;">💳 All Payments (${myPays.length})</div>
            <div style="overflow-x:auto;">
            <table style="width:100%;border-collapse:collapse;table-layout:auto;">
                <thead><tr style="background:rgba(255,255,255,0.02);">
                    <th style="padding:6px 10px;font-size:0.6rem;color:var(--text-dim);font-weight:700;text-align:left;white-space:nowrap;">Date</th>
                    <th style="padding:6px 10px;font-size:0.6rem;color:var(--text-dim);font-weight:700;text-align:left;white-space:nowrap;">Group</th>
                    <th style="padding:6px 10px;font-size:0.6rem;color:var(--text-dim);font-weight:700;text-align:right;white-space:nowrap;">Paid</th>
                    <th style="padding:6px 10px;font-size:0.6rem;color:var(--text-dim);font-weight:700;text-align:right;white-space:nowrap;">Bal</th>
                    <th style="padding:6px 10px;font-size:0.6rem;color:var(--text-dim);font-weight:700;text-align:left;white-space:nowrap;">Mode</th>
                    <th style="padding:6px 10px;font-size:0.6rem;color:var(--text-dim);font-weight:700;text-align:center;white-space:nowrap;">🎯</th>
                </tr></thead>
                <tbody>${myPays.map((p,i)=>{
                    const g = gs.find(x=>x.id===p.groupId);
                    const months = Array.isArray(p.monthSlots)&&p.monthSlots.length>1 ? ` (${p.monthSlots.length}mo)` : '';
                    const dateFormatted = p.date ? (() => {
                        const d = new Date(p.date+'T00:00:00');
                        const m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
                        const dd = String(d.getDate()).padStart(2,'0');
                        const mm = m[d.getMonth()];
                        const yy = String(d.getFullYear()).slice(-2);
                        return `${dd}/${mm}/${yy}`;
                    })() : '—';
                    return `<tr style="border-bottom:${i<myPays.length-1?'1px solid rgba(255,255,255,0.04)':'none'};">
                        <td style="padding:7px 10px;font-size:0.72rem;color:var(--text-dim);white-space:nowrap;">${dateFormatted}</td>
                        <td style="padding:7px 10px;font-size:0.72rem;color:white;">${g?.name||'—'}${months}</td>
                        <td style="padding:7px 10px;font-size:0.75rem;font-weight:800;color:#34d399;text-align:right;white-space:nowrap;">${fmtAmt(parseFloat(p.paid)||0)}</td>
                        <td style="padding:7px 10px;font-size:0.72rem;color:${parseFloat(p.balance)>0?'#f87171':'#34d399'};text-align:right;white-space:nowrap;">${fmtAmt(parseFloat(p.balance)||0)}</td>
                        <td style="padding:7px 10px;font-size:0.72rem;color:var(--text-dim);">${normalizePaidBy(p.paidBy)}</td>
                        <td style="padding:7px 10px;font-size:0.72rem;text-align:center;white-space:nowrap;">${p.chitPicked==='Yes'?'✅':'—'}</td>
                    </tr>`;
                }).join('')}</tbody>
            </table>
            </div>
        </div>`;
}

async function renderMemberStats(skipFilterInit) {
    if(!CURRENT_USER || CURRENT_USER.role !== 'member') return;
    const mid  = CURRENT_USER.memberId;
    const ps   = await getCollection('payments');
    const gs   = await getCollection('groups');
    const ms   = await getCollection('members');
    const m    = ms.find(x=>x.id===mid);
    const myPaysAll = ps.filter(p=>p.memberId===mid);
    const myGids    = [...new Set(myPaysAll.map(p=>p.groupId))];

    // Populate filters once
    const gSel = document.getElementById('mStatsGroupFilter');
    const mSel = document.getElementById('mStatsMonthFilter');
    if(!skipFilterInit && gSel){
        const curG = gSel.value;
        gSel.innerHTML = '<option value="">All Groups</option>' +
            myGids.map(gid=>{ const g=gs.find(x=>x.id===gid); return `<option value="${gid}"${gid===curG?' selected':''}>${g?.name||gid}</option>`; }).join('');
    }
    if(!skipFilterInit && mSel){
        const curM = mSel.value;
        const months = [...new Set(myPaysAll.map(p=>(p.date||'').slice(0,7)).filter(Boolean))].sort().reverse();
        mSel.innerHTML = '<option value="">All Months</option>' + months.map(m=>`<option value="${m}"${m===curM?' selected':''}>${m}</option>`).join('');
    }

    const activeGid   = gSel?.value||'';
    const activeMonth = mSel?.value||'';
    let myPays = myPaysAll;
    if(activeGid)   myPays = myPays.filter(p=>p.groupId===activeGid);
    if(activeMonth) myPays = myPays.filter(p=>(p.date||'').startsWith(activeMonth));

    const totalPaid  = myPays.reduce((s,p)=>s+(parseFloat(p.paid)||0),0);
    const totalBal   = myPays.reduce((s,p)=>s+(parseFloat(p.balance)||0),0);
    const chitPicks  = myPays.filter(p=>p.chitPicked==='Yes').length;
    const thisMonth  = new Date().toISOString().slice(0,7);
    const monthPaid  = myPaysAll.filter(p=>(p.date||'').startsWith(thisMonth)).reduce((s,p)=>s+(parseFloat(p.paid)||0),0);

    // Summary
    const sumEl = document.getElementById('mStatsSummary');
    if(sumEl) sumEl.innerHTML = [
        ['💰 Total Paid',   fmtAmt(totalPaid),    '#f39c12'],
        ['📋 Balance Due',  fmtAmt(totalBal),      totalBal>0?'#f87171':'#34d399'],
        ['📅 This Month',   fmtAmt(monthPaid),     '#60a5fa'],
        ['📝 Payments',     myPays.length,          '#a5b4fc'],
        ['🎯 Chits Picked', chitPicks,              '#34d399'],
        ['📂 My Groups',    myGids.length,          '#f59e0b'],
    ].map(([lbl,val,col],i)=>`<tr style="border-bottom:${i<5?'1px solid rgba(255,255,255,0.05)':'none'};">
        <td style="padding:7px 10px;font-size:0.75rem;color:var(--text-dim);">${lbl}</td>
        <td style="padding:7px 10px;font-size:0.82rem;font-weight:800;color:${col};text-align:right;">${val}</td>
    </tr>`).join('');

    // Group progress — always show all groups regardless of filter (for context)
    const grpEl = document.getElementById('mStatsGroups');
    if(grpEl){
        grpEl.innerHTML = myGids.length ? myGids.map(gid=>{
            const g    = gs.find(x=>x.id===gid);
            const gPay = myPaysAll.filter(p=>p.groupId===gid);
            const paid = gPay.reduce((s,p)=>s+(parseFloat(p.paid)||0),0);
            const bal  = gPay.reduce((s,p)=>s+(parseFloat(p.balance)||0),0);
            const dur  = parseInt(g?.duration||g?.months||13);
            const paidM= new Set();
            gPay.forEach(p=>{ if(Array.isArray(p.monthSlots)) p.monthSlots.forEach(s=>paidM.add(s)); else if(p.monthSlot!=null) paidM.add(p.monthSlot); });
            const pct  = Math.min(100,Math.round((paidM.size/dur)*100));
            const hl   = activeGid===gid;
            const nextDue = (g?.startDate||'') ? (() => {
                // rough next due — not computed here, just show pending count
                return `${dur - paidM.size} months left`;
            })() : '';
            return `<tr style="border-bottom:1px solid rgba(255,255,255,0.04);cursor:pointer;${hl?'background:rgba(99,102,241,0.08);':''}" onclick="document.getElementById('mStatsGroupFilter').value='${gid}';renderMemberStats(true);">
                <td style="padding:7px 8px;font-size:0.72rem;color:${hl?'#a5b4fc':'white'};font-weight:700;max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${g?.name||gid}</td>
                <td style="padding:7px 8px;font-size:0.72rem;color:#34d399;text-align:right;white-space:nowrap;">${fmtAmt(paid)}</td>
                <td style="padding:7px 8px;font-size:0.72rem;color:${bal>0?'#f87171':'#34d399'};text-align:right;white-space:nowrap;">${fmtAmt(bal)}</td>
                <td style="padding:7px 8px;">
                    <div style="font-size:0.6rem;color:var(--text-dim);margin-bottom:2px;white-space:nowrap;">${paidM.size}/${dur} months</div>
                    <div style="background:rgba(255,255,255,0.07);border-radius:3px;height:4px;overflow:hidden;">
                        <div style="background:${pct>=100?'#34d399':'linear-gradient(90deg,#6366f1,#a5b4fc)'};width:${pct}%;height:100%;border-radius:3px;"></div>
                    </div>
                </td>
            </tr>`;
        }).join('') : '<tr><td colspan="4" style="padding:14px;text-align:center;color:var(--text-dim);font-size:0.75rem;">No groups</td></tr>';
    }

    // Payment history filtered
    const monEl = document.getElementById('mStatsMonthly');
    if(monEl){
        const sorted = [...myPays].sort((a,b)=>(b.date||'').localeCompare(a.date||''));
        monEl.innerHTML = sorted.length ? sorted.map((p,i)=>{
            const g = gs.find(x=>x.id===p.groupId);
            const months = Array.isArray(p.monthSlots)&&p.monthSlots.length>1?` ×${p.monthSlots.length}`:'';
            const dateFormatted = p.date ? (() => {
                const d = new Date(p.date+'T00:00:00');
                const m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
                const dd = String(d.getDate()).padStart(2,'0');
                const mm = m[d.getMonth()];
                const yy = String(d.getFullYear()).slice(-2);
                return `${dd}/${mm}/${yy}`;
            })() : '—';
            return `<tr style="border-bottom:${i<sorted.length-1?'1px solid rgba(255,255,255,0.04)':'none'};">
                <td style="padding:6px 10px;font-size:0.72rem;color:var(--text-dim);white-space:nowrap;">${dateFormatted}</td>
                <td style="padding:6px 10px;font-size:0.75rem;font-weight:800;color:#34d399;text-align:right;white-space:nowrap;">${fmtAmt(parseFloat(p.paid)||0)}${months}</td>
                <td style="padding:6px 10px;font-size:0.72rem;color:var(--text-dim);">${normalizePaidBy(p.paidBy)}</td>
                <td style="padding:6px 10px;font-size:0.72rem;color:var(--text-dim);">${g?.name||'—'}</td>
                <td style="padding:6px 10px;font-size:0.7rem;text-align:center;">${p.chitPicked==='Yes'?'✅':''}</td>
            </tr>`;
        }).join('') : '<tr><td colspan="5" style="padding:14px;text-align:center;color:var(--text-dim);font-size:0.75rem;">No payments for this filter</td></tr>';
    }
}

async function renderMemberQrPanel() {
    if(CURRENT_USER && typeof loadMemberQr === 'function'){
        loadMemberQr(CURRENT_USER.memberId);
    }
}
