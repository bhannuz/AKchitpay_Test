// ═══════════════════════════════════════════════════════════
// AK Chit Funds — GROUPS CRUD & TAB
// Edit only this file when changing create / edit / delete groups, groups tab rendering
// ═══════════════════════════════════════════════════════════

// GROUP CRUD
// ══════════════════════════════════════════
function toggleGroupAmtType(){
    const isFixed = document.getElementById('gAmtFixed').checked;
    document.getElementById('gFixedAmtRow').style.display = isFixed ? 'block' : 'none';
}

function openAddGroup(){
    if(!isAdmin()){showToast('🚫 Access denied',false);return;}
    document.getElementById('gName').value='';
    document.getElementById('gDuration').value='';
    document.getElementById('gDueDay').value='';
    document.getElementById('gStart').value='';
    document.getElementById('gFixedAmt').value='';
    document.getElementById('editGroupId').value='';
    document.getElementById('groupModalTitle').textContent='🏦 New Group';
    document.getElementById('deleteGroupArea').style.display='none';
    document.getElementById('gAmtFixed').checked=true;
    toggleGroupAmtType();
    openModal('groupModal');
}

async function openEditGroup(gid){
    if(!isAdmin()){showToast('🚫 Access denied',false);return;}
    const gs=await getCollection('groups');const g=gs.find(x=>x.id===gid);if(!g)return;
    document.getElementById('editGroupId').value=g.id;
    document.getElementById('gName').value=g.name||'';
    document.getElementById('gDuration').value=g.duration||g.gDuration||'';
    document.getElementById('gDueDay').value=g.dueDay||'';
    document.getElementById('gStart').value=g.startDate||g.gStart||'';
    document.getElementById('gFixedAmt').value=g.fixedAmt||'';
    const isFixed = g.amtType!=='variable';
    document.getElementById('gAmtFixed').checked=isFixed;
    document.getElementById('gAmtVariable').checked=!isFixed;
    toggleGroupAmtType();
    document.getElementById('groupModalTitle').textContent='✏️ Edit Group';
    document.getElementById('deleteGroupArea').style.display='block';
    openModal('groupModal');
}

async function saveGroup(){
    if(!isAdmin()){showToast('🚫 Access denied',false);return;}
    const name=document.getElementById('gName').value.trim();
    const duration=document.getElementById('gDuration').value;
    const dueDay=parseInt(document.getElementById('gDueDay').value)||null;
    const startDate=document.getElementById('gStart').value;
    const eid=document.getElementById('editGroupId').value;
    if(!name)return showToast('❌ Enter group name',false);
    if(dueDay&&(dueDay<1||dueDay>31))return showToast('❌ Due Day must be 1–31',false);
    const amtType = document.querySelector('input[name="gAmtType"]:checked')?.value||'fixed';
    const fixedAmt = amtType==='fixed'?(parseFloat(document.getElementById('gFixedAmt').value)||0):0;
    const data={name,duration,startDate,amtType};
    if(dueDay) data.dueDay=dueDay;
    if(amtType==='fixed'&&fixedAmt>0) data.fixedAmt=fixedAmt;
    if(eid)await db.collection('groups').doc(eid).update(data);
    else await db.collection('groups').add(data);
    bustCache('groups');
    closeModal('groupModal');showToast(`✅ Group "${name}" saved!`);updateUI();
}

function deleteGroupFromModal(){
    const eid=document.getElementById('editGroupId').value;if(!eid)return;
    const name=document.getElementById('gName').value;
    showConfirm('🗑','Delete Group?',`This will permanently delete "${name}". Member assignments and payments will remain.`,async()=>{
        await db.collection('groups').doc(eid).delete();
        bustCache('groups');
        closeModal('groupModal');showToast('🗑 Group deleted');updateUI();
    });
}

// ══════════════════════════════════════════

// GROUPS TAB
// ══════════════════════════════════════════
let _activeGroupsSubTab = 'groups';

function switchGroupsSubTab(tab){
    _activeGroupsSubTab = tab;
    _applyGroupsSubTabStyles();
    if(tab === 'collections') renderCollectionsTab();
}

function _applyGroupsSubTabStyles(){
    const grpBtn = document.getElementById('grpSubGroups');
    const colBtn = document.getElementById('grpSubCollections');
    const grpArea = document.getElementById('groupListArea');
    const colArea = document.getElementById('collectionsArea');
    if(!grpBtn||!colBtn||!grpArea||!colArea) return;
    if(_activeGroupsSubTab === 'groups'){
        grpBtn.style.cssText='flex:1;padding:8px;border:none;border-radius:9px;font-size:0.8rem;font-weight:800;cursor:pointer;background:rgba(243,156,18,0.18);color:#f39c12;';
        colBtn.style.cssText='flex:1;padding:8px;border:none;border-radius:9px;font-size:0.8rem;font-weight:800;cursor:pointer;background:transparent;color:#888;';
        grpArea.style.display='block';
        colArea.style.display='none';
    } else {
        colBtn.style.cssText='flex:1;padding:8px;border:none;border-radius:9px;font-size:0.8rem;font-weight:800;cursor:pointer;background:rgba(52,211,153,0.15);color:#34d399;';
        grpBtn.style.cssText='flex:1;padding:8px;border:none;border-radius:9px;font-size:0.8rem;font-weight:800;cursor:pointer;background:transparent;color:#888;';
        grpArea.style.display='none';
        colArea.style.display='block';
    }
}

// ── Payout storage helpers (shared across devices via Firestore) ─────────────
async function _getPayouts(){
    try{
        const doc = await db.collection('settings').doc('collectionPayouts').get();
        return doc.exists ? (doc.data().payouts||{}) : {};
    }catch(e){ return {}; }
}
async function _savePayouts(payouts){
    try{ await db.collection('settings').doc('collectionPayouts').set({payouts}); }catch(e){}
}

// Called when admin edits a payout cell
async function updateCollectionPayout(el){
    const gid = el.dataset.gid;
    const idx = parseInt(el.dataset.idx);
    const val = el.value;
    const payouts = await _getPayouts();
    const key = gid+'_'+idx;
    payouts[key] = parseFloat(val)||0;
    await _savePayouts(payouts);
    // Update balance cell live
    const balEl = document.getElementById('colbal_'+gid+'_'+idx);
    const recEl = document.getElementById('colrec_'+gid+'_'+idx);
    if(balEl && recEl){
        const received = parseFloat(recEl.dataset.received)||0;
        const payout   = parseFloat(val)||0;
        const balance  = received - payout;
        balEl.textContent = balance !== 0 ? (balance > 0 ? '+' : '') + '₹' + Math.abs(balance).toLocaleString('en-IN') : '—';
        balEl.style.color = balance < 0 ? '#f87171' : balance > 0 ? '#34d399' : 'var(--text-dim)';
    }
}

function toggleCollectionCard(gid){
    const body = document.getElementById('colbody_'+gid);
    const chevron = document.getElementById('colchev_'+gid);
    if(!body) return;
    const isOpen = body.style.display !== 'none';
    body.style.display = isOpen ? 'none' : 'block';
    if(chevron) chevron.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(90deg)';
}

async function renderCollectionsTab(){
    const colArea = document.getElementById('collectionsArea');
    if(!colArea) return;
    colArea.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:20px;font-size:0.85rem;">Loading...</div>';
    const gs = await getCollection('groups');
    const ps = await getCollection('payments');
    const ms = await getCollection('members');
    const payouts = await _getPayouts();
    if(!gs.length){ colArea.innerHTML='<div style="text-align:center;color:var(--text-dim);padding:40px;">No groups yet.</div>'; return; }

    const todayStr = new Date().toISOString().split('T')[0];
    const html = gs.map((g,gi)=>{
        const allDD = getGroupDueDates(g);
        if(!allDD.length) return '';
        const gPays = ps.filter(p=>p.groupId===g.id);
        const gMs = ms.filter(m=>(m.enrollments||[]).some(e=>e.groupId===g.id)||(m.groupIds||[]).includes(g.id));
        
        // Calculate total slots (accounting for members with multiple chits)
        const expandedSlots=[];
        gMs.forEach(m=>{
            const enr=(m.enrollments||[]).find(e=>e.groupId===g.id);
            const qty=enr?parseInt(enr.qty||1):1;
            for(let q=0;q<qty;q++) expandedSlots.push({m,slotNum:q+1,totalSlots:qty});
        });
        const totalSlots = expandedSlots.length;  // This is the correct denominator!
        
        const totalMonths = parseInt(g.duration||g.gDuration)||21;
        const fixedAmt = g.amtType!=='variable'&&g.fixedAmt ? parseFloat(g.fixedAmt)||0 : 0;
        const totalReceived = gPays.reduce((s,p)=>s+(parseFloat(p.paid)||0),0);
        const elapsed = allDD.filter(d=>d<=todayStr).length;
        const totalPayout = allDD.reduce((s,_,idx)=>s+(payouts[g.id+'_'+idx]||0),0);
        
        // Calculate total commitment: all members × all months × monthly amount
        // BUGFIX: g.monthly / g.gMonthly are never actually saved on a group (only
        // g.fixedAmt is), so this was silently evaluating to 0 for every fixed-amount
        // group — which broke totalCommitment/totalBalance below AND meant the
        // "did this member actually pay in full" check further down always fell back
        // to its loose behavior (any payment > 0 counted as fully paid). Falling back
        // to fixedAmt fixes both.
        const monthlyAmount = fixedAmt>0 ? fixedAmt : parseFloat(g.monthly||g.gMonthly||0);
        const totalCommitment = totalSlots * totalMonths * monthlyAmount;
        const totalBalance = Math.max(0, totalCommitment - totalReceived);

        const rows = allDD.map((dueDate, idx)=>{
            const slotPays = gPays.filter(p=>{
                if(Array.isArray(p.monthSlots)) return p.monthSlots.includes(idx);
                if(p.monthSlot!=null) return p.monthSlot===idx;
                return false;
            });
            
            // Count PAID SLOTS (not unique members)
            // If member with 3 chits pays, count as 3 payments
            let membersPaidThisMonth = 0;
            expandedSlots.forEach(({m, slotNum, totalSlots}) => {
                // Find this member's payment(s) toward this slot for this month
                const memberSlotPays = slotPays.filter(p => {
                    if(p.memberId !== m.id) return false;
                    if(m.enrollments && m.enrollments.length > 0) {
                        const enr = m.enrollments.find(e => e.groupId === g.id);
                        if(enr && enr.enrollmentId && p.enrollmentId) {
                            return p.enrollmentId === enr.enrollmentId && (p.slotNum == null || p.slotNum === slotNum);
                        }
                    }
                    if(p.slotNum != null) return p.slotNum === slotNum;
                    return slotNum === 1;  // Default to first slot if no slot info
                });
                // BUGFIX: a payment *record* existing for this month isn't proof the month
                // is paid — a member can pay only part of what's due (e.g. ₹11,000 toward a
                // ₹23,077 month) and still have a record. Sum what they've actually paid
                // toward this specific month (using the per-month share for payments that
                // span several months) and only count them as paid once that total meets
                // the full amount due, so partially-paid members no longer count toward
                // "all members paid" / the Settled status.
                const paidForThisMonth = memberSlotPays.reduce((s,p) => {
                    const perMonth = p.numMonths && p.numMonths>1 ? (parseFloat(p.paidPerMonth)||0) : (parseFloat(p.paid)||0);
                    return s + perMonth;
                }, 0);
                // For variable-amount groups (monthlyAmount is 0), fall back to the amount
                // recorded directly on the member's own payment (each payment stores its
                // own `chit` due amount) since there's no single group-wide monthly figure.
                const dueForThisMonth = monthlyAmount>0 ? monthlyAmount : memberSlotPays.reduce((mx,p) => {
                    const perMonth = p.numMonths && p.numMonths>1 ? (parseFloat(p.chit)||0)/p.numMonths : (parseFloat(p.chit)||0);
                    return Math.max(mx, perMonth);
                }, 0);
                const hasPaid = paidForThisMonth>0 && dueForThisMonth>0 && paidForThisMonth >= (dueForThisMonth - 0.5);
                if(hasPaid) membersPaidThisMonth++;
            });
            
            // Use paidPerMonth for multi-month payments so each row shows only its share
            const received  = slotPays.reduce((s,p)=>{
                const perMonth = p.numMonths&&p.numMonths>1 ? (parseFloat(p.paidPerMonth)||0) : (parseFloat(p.paid)||0);
                return s + perMonth;
            },0);
            const monthlyCommitment = totalSlots * monthlyAmount;
            const payout    = payouts[g.id+'_'+idx]||0;
            const balance   = Math.max(0, monthlyCommitment - received);
            const isPast    = dueDate < todayStr;
            const isToday   = dueDate === todayStr;
            const isFuture  = dueDate > todayStr;
            // "Settled" (full) must strictly require every member/slot to have paid — a
            // month's total received amount matching the commitment isn't enough proof
            // on its own, since that total could come from uneven contributions (some
            // members overpaying while others haven't paid at all). So this status is
            // only ever derived from the per-member paid count, not from aggregate money.
            const status    = membersPaidThisMonth>0&&membersPaidThisMonth===totalSlots ? 'full'
                            : received===0&&isFuture ? 'upcoming'
                            : received===0&&(isPast||isToday) ? 'overdue'
                            : balance<0 ? 'deficit'
                            : received>0&&payout===0 ? 'received'
                            : received>0 ? 'partial' : 'upcoming';
            const statusBadge = status==='full'     ? '<span style="background:rgba(16,185,129,0.15);color:#34d399;font-size:0.6rem;font-weight:800;padding:2px 8px;border-radius:99px;">✅ Settled</span>'
                              : status==='deficit'  ? '<span style="background:rgba(239,68,68,0.12);color:#f87171;font-size:0.6rem;font-weight:800;padding:2px 8px;border-radius:99px;">⬇ Deficit</span>'
                              : status==='received' ? '<span style="background:rgba(52,211,153,0.12);color:#34d399;font-size:0.6rem;font-weight:800;padding:2px 8px;border-radius:99px;">💰 Received</span>'
                              : status==='partial'  ? '<span style="background:rgba(245,158,11,0.12);color:#f59e0b;font-size:0.6rem;font-weight:800;padding:2px 8px;border-radius:99px;">⚡ Partial</span>'
                              : status==='overdue'  ? '<span style="background:rgba(239,68,68,0.12);color:#f87171;font-size:0.6rem;font-weight:800;padding:2px 8px;border-radius:99px;">🔴 Overdue</span>'
                              : '<span style="background:rgba(255,255,255,0.05);color:#555f7a;font-size:0.6rem;font-weight:800;padding:2px 8px;border-radius:99px;">⏳ Upcoming</span>';
            const rowBg     = status==='full'?'rgba(16,185,129,0.04)':status==='deficit'||status==='overdue'?'rgba(239,68,68,0.04)':status==='received'||status==='partial'?'rgba(245,158,11,0.03)':'';
            const dateColor = isPast||isToday ? '#c7d2fe' : '#555f7a';
            const balColor  = balance<0?'#f87171':balance>0?'#34d399':'var(--text-dim)';
            const balDisp   = balance!==0 ? (balance>0?'+':'')+fmtAmt(balance) : '—';
            const membersPaidBadge = totalSlots > 0 
                ? `<span style="background:rgba(167,139,250,0.15);color:#a78bfa;font-size:0.65rem;font-weight:800;padding:2px 8px;border-radius:5px;">${membersPaidThisMonth}/${totalSlots}</span>`
                : '—';
            return '<tr style="background:'+rowBg+';border-bottom:1px solid rgba(255,255,255,0.04);">'
                +'<td style="text-align:center;color:var(--text-dim);font-size:0.68rem;padding:7px 4px;font-weight:700;">'+(idx+1)+'</td>'
                +'<td style="font-size:0.75rem;color:'+dateColor+';padding:7px 8px;white-space:nowrap;">'+fmtDate(dueDate)+'</td>'
                +'<td id="colrec_'+g.id+'_'+idx+'" data-received="'+received+'" style="font-size:0.78rem;font-weight:700;color:'+(received>0?'#34d399':'var(--text-dim)')+';padding:7px 8px;">'+(received>0?fmtAmt(received):'—')+'</td>'
                +'<td style="text-align:center;padding:7px 6px;">'+membersPaidBadge+'</td>'
                +'<td style="padding:5px 6px;">'
                    +'<input type="number" value="'+(payout||'')+'" placeholder="Rs payout" '
                    +'data-gid="'+g.id+'" data-idx="'+idx+'" '
                    +'onchange="updateCollectionPayout(this)" '
                    +'style="width:90px;background:rgba(99,102,241,0.1);border:1px solid rgba(99,102,241,0.3);color:#a5b4fc;border-radius:7px;padding:4px 7px;font-size:0.75rem;font-weight:700;outline:none;">'
                +'</td>'
                +'<td id="colbal_'+g.id+'_'+idx+'" style="font-size:0.78rem;font-weight:700;color:'+balColor+';padding:7px 8px;">'+balDisp+'</td>'
                +'<td style="text-align:center;padding:7px 6px;">'+statusBadge+'</td>'
                +'</tr>';
        }).join('');

        const balColor = totalBalance<0?'#f87171':totalBalance>0?'#34d399':'var(--text-dim)';

        const gid = g.id;
        return `<div style="background:#1c253b;border:1px solid var(--border);border-radius:14px;overflow:hidden;margin-bottom:10px;">
            <div onclick="toggleCollectionCard('${gid}')" style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;cursor:pointer;user-select:none;">
                <div>
                    <div style="font-size:0.95rem;font-weight:800;color:#f39c12;">&#128194; ${g.name}</div>
                    <div style="display:flex;gap:10px;margin-top:4px;flex-wrap:wrap;">
                        <span style="font-size:0.68rem;color:#34d399;">Rcvd: ${fmtAmt(totalReceived)}</span>
                        <span style="font-size:0.68rem;color:#a5b4fc;">Paid out: ${fmtAmt(totalPayout)}</span>
                        <span style="font-size:0.68rem;color:var(--text-dim);">${elapsed}/${totalMonths} mo</span>
                    </div>
                </div>
                <span id="colchev_${gid}" style="font-size:0.85rem;color:var(--text-dim);transition:transform .2s;transform:rotate(0deg);">&#9654;</span>
            </div>
            <div id="colbody_${gid}" style="display:none;border-top:1px solid var(--border);">
                <div style="overflow-x:auto;">
                    <table style="width:100%;border-collapse:collapse;min-width:380px;">
                        <thead><tr style="border-bottom:1px solid rgba(255,255,255,0.08);">
                            <th style="text-align:center;font-size:0.6rem;color:var(--text-dim);padding:6px 4px;font-weight:500;">#</th>
                            <th style="font-size:0.6rem;color:var(--text-dim);padding:6px 8px;font-weight:500;">Due Date</th>
                            <th style="font-size:0.6rem;color:#34d399;padding:6px 8px;font-weight:500;">Received</th>
                            <th style="font-size:0.6rem;color:#a78bfa;padding:6px 8px;font-weight:500;text-align:center;">Members Paid</th>
                            <th style="font-size:0.6rem;color:#a5b4fc;padding:6px 8px;font-weight:500;">Chit Payout &#9999;</th>
                            <th style="font-size:0.6rem;color:#f59e0b;padding:6px 8px;font-weight:500;">Balance</th>
                            <th style="font-size:0.6rem;color:var(--text-dim);padding:6px 8px;font-weight:500;text-align:center;">Status</th>
                        </tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            </div>
        </div>`;
    }).join('');

    colArea.innerHTML = html || '<div style="text-align:center;color:var(--text-dim);padding:40px;">No data.</div>';
}

// ── Per-Group Member Sort State ────────────────────────────
const _grpMemberSort = {}; // { [gid]: { key, dir } }

function sortGroupMembers(gid, key) {
    if (!_grpMemberSort[gid]) _grpMemberSort[gid] = { key: '', dir: 0 };
    const s = _grpMemberSort[gid];
    
    if (s.key === key) {
        // Same column: cycle dir: 1 (asc) → -1 (desc) → 0 (no sort) → 1 (asc)
        if (s.dir === 0) { s.dir = 1; }
        else if (s.dir === 1) { s.dir = -1; }
        else { s.dir = 0; s.key = ''; }
    } else {
        // Different column: start with ascending (dir=1)
        s.key = key;
        s.dir = 1;
    }
    renderGroupsTab();
}

// ── Group Sort State ───────────────────────────────────────
let _gsortKey = 'name';
let _gsortDir = 1; // 1 = asc, -1 = desc

function sortGroups(key) {
    if (_gsortKey === key) { _gsortDir *= -1; } else { _gsortKey = key; _gsortDir = 1; }
    // Update button styles
    ['name','commitment','months'].forEach(k => {
        const btn   = document.getElementById('gsort' + (k==='name'?'Name':k==='commitment'?'Commit':'Months'));
        const arrow = document.getElementById('gsort' + (k==='name'?'Name':k==='commitment'?'Commit':'Months') + 'Arrow');
        if (!btn || !arrow) return;
        const active = k === key;
        btn.style.background  = active ? 'rgba(99,102,241,0.25)' : 'var(--card-bg)';
        btn.style.borderColor = active ? 'rgba(99,102,241,0.6)'  : 'var(--border)';
        btn.style.color       = active ? '#a5b4fc' : 'var(--text-dim)';
        arrow.textContent     = active ? (_gsortDir === 1 ? ' ↑' : ' ↓') : '';
    });
    renderGroupsTab();
}

async function renderGroupsTab(){
    _applyGroupsSubTabStyles();
    // Ensure default sort arrow is shown
    const defaultArrow = document.getElementById('gsortNameArrow');
    if (defaultArrow && !defaultArrow.textContent) defaultArrow.textContent = ' ↑';
    const gs=await getCollection('groups');const ms=await getCollection('members');const ps=await getCollection('payments');const cs=await getCollection('memberCommitments');
    if(!gs.length){document.getElementById('groupListArea').innerHTML='<div style="text-align:center;color:var(--text-dim);padding:40px;">No groups yet.</div>';return;}

    // ── Apply sort
    gs.sort((a, b) => {
        if (_gsortKey === 'name') {
            return _gsortDir * (a.name||'').localeCompare(b.name||'');
        }
        if (_gsortKey === 'commitment') {
            const ca = parseFloat(a.gAmt || a.chitAmt || 0);
            const cb = parseFloat(b.gAmt || b.chitAmt || 0);
            return _gsortDir * (ca - cb);
        }
        if (_gsortKey === 'months') {
            const da = parseInt(a.duration || a.gDuration || 0);
            const db = parseInt(b.duration || b.gDuration || 0);
            return _gsortDir * (da - db);
        }
        return 0;
    });

    document.getElementById('groupListArea').innerHTML=gs.map((g,gIdx)=>{
        const gMs=ms.filter(m=>(m.enrollments||[]).some(e=>e.groupId===g.id)||(m.groupIds||[]).includes(g.id));
        const gPays=ps.filter(p=>p.groupId===g.id);
        const tPaid=gPays.reduce((s,p)=>s+(parseFloat(p.paid)||0),0);
        
        // Calculate total balance: total commitment - total paid
        const totalMonths=parseInt(g.duration||g.gDuration)||21;
        // BUGFIX: same as the collection view above — g.monthly/g.gMonthly are never
        // actually saved, so fall back to g.fixedAmt (the field that is saved) for
        // fixed-amount groups, otherwise this always silently evaluated to 0.
        const gFixedAmt = g.amtType!=='variable'&&g.fixedAmt ? parseFloat(g.fixedAmt)||0 : 0;
        const monthlyAmount = gFixedAmt>0 ? gFixedAmt : (parseFloat(g.monthly||g.gMonthly)||0);
        // Count total slots (members with multiple chits count as multiple slots)
        let totalSlots = 0;
        gMs.forEach(m => {
            const enr = (m.enrollments||[]).find(e => e.groupId === g.id);
            const qty = enr ? parseInt(enr.qty||1) : 1;
            totalSlots += qty;
        });
        const totalCommitment = totalSlots * totalMonths * monthlyAmount;
        const tBal = Math.max(0, totalCommitment - tPaid);
        
        const picked=gPays.filter(p=>p.chitPicked==='Yes').length;
        let elapsed=0;
        if(g.startDate||g.gStart){const _s=new Date(g.startDate||g.gStart),_n=new Date();elapsed=Math.max(0,Math.min(totalMonths,(_n.getFullYear()-_s.getFullYear())*12+(_n.getMonth()-_s.getMonth())+1));}
        const left=Math.max(0,totalMonths-elapsed);const pct=Math.min(100,Math.round(elapsed/totalMonths*100));

        // Build chit slots — joint pairs share ONE row
        const seenJoint = new Set();
        const expandedSlots = [];
        gMs.forEach(m => {
            const enr = (m.enrollments||[]).find(e=>e.groupId===g.id);
            const qty = enr ? parseInt(enr.qty||1) : 1;
            const coMid = enr && enr.coMemberId ? enr.coMemberId : '';
            if(coMid) {
                const pairKey = [m.id, coMid].sort().join('_');
                if(!seenJoint.has(pairKey)) {
                    seenJoint.add(pairKey);
                    const coM = ms.find(x=>x.id===coMid);
                    for(let q=0;q<qty;q++) expandedSlots.push({m, slotNum:q+1, totalSlots:qty, isJoint:true, coM, coMid});
                }
            } else {
                for(let q=0;q<qty;q++) expandedSlots.push({m, slotNum:q+1, totalSlots:qty, isJoint:false, coM:null, coMid:''});
            }
        });
        const todayStr = new Date().toISOString().split('T')[0];

        // ── Per-group member sort
        const gSort = _grpMemberSort[g.id];
        if (gSort && gSort.key) {
            expandedSlots.sort((a, b) => {
                if (gSort.key === 'member') {
                    return gSort.dir * (a.m.name||'').localeCompare(b.m.name||'');
                }
                if (gSort.key === 'months') {
                    const allMpA = ps.filter(p=>p.memberId===a.m.id&&p.groupId===g.id);
                    const allMpB = ps.filter(p=>p.memberId===b.m.id&&p.groupId===g.id);
                    const sA = new Set(); allMpA.forEach(p=>{ if(Array.isArray(p.monthSlots))p.monthSlots.forEach(s=>sA.add(s)); else if(p.monthSlot!=null)sA.add(p.monthSlot); else sA.add('p'+p.id); });
                    const sB = new Set(); allMpB.forEach(p=>{ if(Array.isArray(p.monthSlots))p.monthSlots.forEach(s=>sB.add(s)); else if(p.monthSlot!=null)sB.add(p.monthSlot); else sB.add('p'+p.id); });
                    return gSort.dir * (sA.size - sB.size);
                }
                if (gSort.key === 'commitment') {
                    const cA = cs.find(c=>c.memberId===a.m.id&&c.groupId===g.id);
                    const cB = cs.find(c=>c.memberId===b.m.id&&c.groupId===g.id);
                    return gSort.dir * ((cA?cA.targetMonth:0) - (cB?cB.targetMonth:0));
                }
                return 0;
            });
        }

        const memberRows = expandedSlots.map(({m, slotNum, totalSlots, isJoint, coM, coMid}, i) => {
            const enr = (m.enrollments||[]).find(e=>e.groupId===g.id);
            const memberQty = enr ? parseInt(enr.qty||1) : 1;
            const allDD = getGroupDueDates(g);
            const fixedAmt = g.amtType!=='variable'&&g.fixedAmt ? parseFloat(g.fixedAmt) : 0;

            // My payments
            const allMp = ps.filter(p=>p.memberId===m.id&&p.groupId===g.id);
            const mp = memberQty>1
                ? allMp.filter(p=>{
                    if(enr&&enr.enrollmentId&&p.enrollmentId) return p.enrollmentId===enr.enrollmentId&&(p.slotNum==null||p.slotNum===slotNum);
                    if(p.slotNum!=null) return p.slotNum===slotNum;
                    return slotNum===1;
                }) : allMp;

            // Co-member payments (joint)
            const coMp = isJoint && coM ? ps.filter(p=>p.memberId===coMid&&p.groupId===g.id) : [];

            // Individual paid amounts
            const myPaid = mp.reduce((s,p)=>s+(parseFloat(p.paid)||0),0);
            const coPaid = coMp.reduce((s,p)=>s+(parseFloat(p.paid)||0),0);
            const paid   = myPaid + coPaid;

            // Union of paid slots across both members
            const paidSlotNums = new Set();
            [...mp, ...coMp].forEach(p=>{
                if(Array.isArray(p.monthSlots)) p.monthSlots.forEach(s=>paidSlotNums.add(s));
                else if(p.monthSlot!=null) paidSlotNums.add(p.monthSlot);
            });

            // Balance = overdue months (by original slot index) not paid by either member
            // Use original allDD index so paidSlotNums lookup is correct
            const chitAmt = fixedAmt>0 ? fixedAmt : (mp[0]?parseFloat(mp[0].chit)||0:(coMp[0]?parseFloat(coMp[0].chit)||0:0));
            const overdueUnpaid = chitAmt>0
                ? allDD.filter((d,idx)=>d<=todayStr && !paidSlotNums.has(idx)).length
                : 0;
            const bal = overdueUnpaid * chitAmt;

            // Months covered = union of paid slots
            const _paidSlots = new Set();
            [...mp,...coMp].forEach(p=>{
                if(Array.isArray(p.monthSlots)) p.monthSlots.forEach(s=>_paidSlots.add(s));
                else if(p.monthSlot!=null) _paidSlots.add(p.monthSlot);
                else _paidSlots.add('pay_'+p.id);
            });
            const monthsCovered = _paidSlots.size;

            const pickedPay = [...mp,...coMp].find(p=>p.chitPicked==='Yes');
            const pickedAmt = pickedPay?(parseFloat(pickedPay.chit)||0)*(parseInt(pickedPay.numMonths)||1):0;
            const pickedBy  = pickedPay&&pickedPay.chitPickedBy?pickedPay.chitPickedBy:'';
            const multiChitBadge = totalSlots>1?`<span style="background:rgba(245,158,11,0.2);border:1px solid rgba(245,158,11,0.4);color:#fbbf24;border-radius:4px;padding:0px 4px;font-size:0.66rem;font-weight:800;margin-left:3px;">x${totalSlots}</span>`:'';
            const slotLabelBadge = totalSlots>1?`<span style="font-size:0.66rem;color:#f59e0b;"> (C${slotNum})</span>`:'';

            // ── Name cell ────────────────────────────────────────────────────
            const nameCell = isJoint && coM
                ? `<td>
                    <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">
                        <strong style="font-size:0.75rem;">${m.name}</strong>
                        <span style="background:rgba(99,102,241,0.15);border:1px solid rgba(99,102,241,0.3);color:#a5b4fc;border-radius:4px;padding:0px 4px;font-size:0.62rem;font-weight:800;">Joint</span>
                        ${multiChitBadge}${slotLabelBadge}
                    </div>
                    <div style="font-size:0.66rem;color:var(--text-dim);">${m.phone||''}</div>
                    <div style="margin-top:2px;padding-top:2px;border-top:1px solid rgba(99,102,241,0.2);">
                        <strong style="font-size:0.72rem;color:#c4b5fd;">${coM.name}</strong>
                        <span style="font-size:0.62rem;color:var(--text-dim);"> · ${coM.phone||''}</span>
                    </div>
                  </td>`
                : `<td><strong style="font-size:0.75rem;">${m.name}</strong>${multiChitBadge}${slotLabelBadge}<br><span style="font-size:0.66rem;color:var(--text-dim);">${m.phone||''}</span></td>`;

            // ── Paid cell — stacked P1 / P2 for joint ───────────────────────
            const paidCell = isJoint && coM
                ? `<td>
                    <div style="color:#34d399;font-weight:700;font-size:0.72rem;">${fmtAmt(myPaid)}</div>
                    <div style="margin-top:2px;padding-top:2px;border-top:1px solid rgba(99,102,241,0.15);color:${coPaid>0?'#34d399':'#f87171'};font-weight:700;font-size:0.72rem;">${coPaid>0?fmtAmt(coPaid):'Pending'}</div>
                  </td>`
                : `<td style="color:#34d399;font-size:0.75rem;">${fmtAmt(paid)}</td>`;

            // ── Balance cell — single combined balance ───────────────────────
            const balCell = `<td style="color:${bal>0?'#f59e0b':'#34d399'};font-weight:700;font-size:0.75rem;">${bal>0?fmtAmt(bal):'—'}</td>`;

            return [
                `<tr${pickedPay?' class="chit-picked"':''}>`,
                `<td style="font-size:0.72rem;">${i+1}</td>`,
                nameCell,
                paidCell,
                balCell,
                `<td style="color:#a5b4fc;font-size:0.78rem;">${monthsCovered}/${totalMonths}</td>`,
                (()=>{ const mComm=cs.find(c=>c.memberId===m.id&&c.groupId===g.id&&(c.slotNum==null?1:c.slotNum)===slotNum); const commVal=mComm?mComm.targetMonth:0; const commId=mComm?mComm.id:''; return '<td><input type="number" min="0" max="'+totalMonths+'" value="'+(commVal||'')+'" placeholder="—" data-mid="'+m.id+'" data-gid="'+g.id+'" data-slot="'+slotNum+'" data-commid="'+commId+'" onchange="updateGroupCommitment(this)" style="width:46px;background:rgba(155,89,182,0.1);border:1px solid rgba(155,89,182,0.3);color:#bb86fc;border-radius:6px;padding:3px 4px;font-size:0.7rem;font-weight:800;text-align:center;outline:none;" title="Commitment month for this slot"></td>'; })(),
                `<td>${pickedPay
                    ?`<div><span class="chit-yes-badge" style="font-size:0.62rem;padding:1px 5px;">&#x2705;</span>${pickedBy?`<div style="font-size:0.7rem;color:#34d399;font-weight:800;margin-top:2px;">${pickedBy}</div>`:''}</div>`
                    :'<span class="chit-no" style="font-size:0.72rem;">—</span>'}</td>`,
                `<td><button class="btn-edit-sm" onclick="openEditMember('${m.id}')" style="padding:3px 6px;font-size:0.72rem;">✏️</button></td>`,
                `</tr>`
            ].join('');
        }).join('');

        const gStartDisp=fmtDate(g.startDate||g.gStart||'');
        const gDueDayDisp=g.dueDay?`${g.dueDay}${['st','nd','rd'][((g.dueDay%100-11)%10)-1]||'th'} of month`:'—';
        const bodyId=`grpBody_${gIdx}`;
        return`<div class="group-card">
            <div class="group-card-header" onclick="toggleGroupCard('${bodyId}',this)">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;">
                    <div>
                        <div style="font-size:0.95rem;font-weight:800;color:#f39c12;">📂 ${g.name}</div>
                        <div style="font-size:0.72rem;color:var(--text-dim);">${(()=>{const slots=gMs.reduce((s,m)=>{const e=(m.enrollments||[]).find(x=>x.groupId===g.id);return s+(e?parseInt(e.qty||1):1);},0);const uniq=gMs.length;return slots===uniq?slots+' members':slots+' chit slots ('+uniq+' members)';})()}  · ${gPays.length} entries</div>
                        <div style="display:flex;gap:4px;margin-top:4px;flex-wrap:wrap;">
                            <span style="font-size:0.66rem;background:rgba(99,102,241,.15);border:1px solid rgba(99,102,241,.3);border-radius:5px;padding:1px 5px;color:#a5b4fc;">🗓 ${gStartDisp}</span>
                            ${g.dueDay?`<span style="font-size:0.66rem;background:rgba(243,156,18,.12);border:1px solid rgba(243,156,18,.3);border-radius:5px;padding:1px 5px;color:#f39c12;">📅 Due ${gDueDayDisp}</span>`:''}
                        </div>
                    </div>
                    <div style="display:flex;gap:5px;align-items:center;">
                        <button onclick="generateGroupPDF('${g.id}');event.stopPropagation();" class="btn-pdf" style="padding:4px 8px;font-size:0.85rem;">📄</button>
                        <button onclick="openEditGroup('${g.id}');event.stopPropagation();" class="btn-edit-sm" style="padding:4px 8px;font-size:0.85rem;">✏️</button>
                        <span class="chevron-icon closed">▼</span>
                    </div>
                </div>
                <div class="row g-2 mt-2" style="--bs-gutter-x:0.4rem;">
                    <div class="col-3"><div class="mini-stat" style="border-top:2px solid #34d399;padding:6px 4px;"><div class="mini-stat-lbl" style="font-size:0.56rem;">Collected</div><div class="mini-stat-val" style="color:#34d399;font-size:clamp(0.65rem,2.2vw,0.82rem);">${fmtAmt(tPaid)}</div></div></div>
                    <div class="col-3"><div class="mini-stat" style="border-top:2px solid #a5b4fc;padding:6px 4px;"><div class="mini-stat-lbl" style="font-size:0.56rem;">Pending</div><div class="mini-stat-val" style="color:#a5b4fc;font-size:0.78rem;">${left}/${totalMonths}</div></div></div>
                    <div class="col-3"><div class="mini-stat" style="border-top:2px solid #34d399;padding:6px 4px;"><div class="mini-stat-lbl" style="font-size:0.56rem;">Picked</div><div class="mini-stat-val" style="color:#34d399;font-size:0.78rem;">${picked}</div></div></div>
                </div>
                <div class="prog-bar-outer mt-2"><div class="prog-bar-inner" style="width:${pct}%"></div></div>
                <div class="prog-label" style="margin-top:2px;font-size:0.66rem;"><span>Month ${elapsed}/${totalMonths}</span><span>${left}/${totalMonths} months pending</span></div>
            </div>
            <div class="group-body" id="${bodyId}" style="max-height:0px;opacity:0;margin-top:0;">

                ${gMs.length?`<div class="table-wrap"><table class="table-custom group-member-table">
                    <thead><tr>
                        <th>#</th>
                        <th onclick="sortGroupMembers('${g.id}','member')" style="cursor:pointer;user-select:none;white-space:nowrap;">Member ${(gSort&&gSort.key==='member')?(gSort.dir===1?'↑':gSort.dir===-1?'↓':'⇅'):'⇅'}</th>
                        <th>Paid</th>
                        <th>Bal</th>
                        <th onclick="sortGroupMembers('${g.id}','months')" style="cursor:pointer;user-select:none;white-space:nowrap;">Mo ${(gSort&&gSort.key==='months')?(gSort.dir===1?'↑':gSort.dir===-1?'↓':'⇅'):'⇅'}</th>
                        <th onclick="sortGroupMembers('${g.id}','commitment')" style="cursor:pointer;user-select:none;white-space:nowrap;">Commit ${(gSort&&gSort.key==='commitment')?(gSort.dir===1?'↑':gSort.dir===-1?'↓':'⇅'):'⇅'}</th>
                        <th>Picked</th><th></th>
                    </tr></thead>
                    <tbody>${memberRows}</tbody>
                </table></div>`:'<div style="text-align:center;color:var(--text-dim);font-size:1rem;padding:10px;">No members yet</div>'}
            </div>
        </div>`;
    }).join('');
}


// Inline commitment edit from groups tab
async function updateGroupCommitment(input){
    const mid    = input.dataset.mid;
    const gid    = input.dataset.gid;
    const slot   = parseInt(input.dataset.slot)||1;
    const commId = input.dataset.commid;
    const val    = parseInt(input.value)||0;
    try {
        if(val > 0){
            if(commId){
                await db.collection('memberCommitments').doc(commId).update({targetMonth: val, slotNum: slot});
            } else {
                const ref = await db.collection('memberCommitments').add({
                    memberId: mid, groupId: gid, slotNum: slot, targetMonth: val,
                    createdAt: new Date().toISOString()
                });
                input.dataset.commid = ref.id;
            }
        } else if(commId) {
            await db.collection('memberCommitments').doc(commId).delete();
            input.dataset.commid = '';
        }
        bustCache('memberCommitments');
        input.style.borderColor = '#34d399';
        setTimeout(()=>{ input.style.borderColor = 'rgba(155,89,182,0.3)'; }, 1200);
    } catch(e) {
        showToast('❌ Failed to save commitment', false);
    }
}

function toggleGroupCard(bodyId, header){
    const body=document.getElementById(bodyId);
    const chevron=header.querySelector('.chevron-icon');
    if(!body) return;
    const isOpen=body.style.maxHeight!=='0px'&&!body.classList.contains('collapsed');
    if(isOpen){
        body.style.maxHeight='0px';body.style.opacity='0';body.style.marginTop='0';
        if(chevron){chevron.classList.remove('open');chevron.classList.add('closed');}
    } else {
        body.style.maxHeight='2000px';body.style.opacity='1';body.style.marginTop='12px';
        if(chevron){chevron.classList.remove('closed');chevron.classList.add('open');}
    }
}

function toggleLedgerTable(id, header){
    const el=document.getElementById(id);
    if(!el)return;
    const chevron=header.querySelector('.ledger-chevron');
    const isOpen=el.style.display!=='none';
    el.style.display=isOpen?'none':'block';
    if(chevron)chevron.style.transform=isOpen?'rotate(0deg)':'rotate(90deg)';
}

// ══════════════════════════════════════════
