// ═══════════════════════════════════════════════════════════
// AK Chit Funds — MEMBER LEDGER - FLAT PAYMENT LIST
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
// HELPER FUNCTION - Get ordinal text (1st, 2nd, 3rd, 5th, etc.)
// ═══════════════════════════════════════════════════════════
function getOrdinal(n) {
    if(!n) return '';
    const s = ['th','st','nd','rd'];
    const v = n%100;
    return n + (s[(v-20)%10] || s[v] || s[0]);
}

// BUGFIX: A payment's stored `balance` field is only ever computed against that single
// payment's own amount (see savePayment in payments.js). When a month is paid in more than
// one installment, each installment's stored balance ignores the other installments made for
// the same month, so simply summing `payment.balance` across payments overstates the true
// outstanding balance (e.g. two payments of 11,000 and 12,077 fully covering a 23,077 month
// would wrongly sum to a combined "balance" of 23,077 instead of the correct 0).
// This recomputes the true balance per (group, enrollment, slot, month) bucket from the
// actual amounts paid, then sums those — so fully-paid months always contribute 0.
function computeCorrectedTotalBalance(payments, groups){
    const chitByGroup = {};
    groups.forEach(g=>{
        let amt = parseFloat(g.fixedAmt)||0;
        if(!amt){
            const fieldNames=['fixedMonthlyAmount','monthlyChitAmount','monthlyAmount','fixedAmount','amount','chitAmount'];
            for(const f of fieldNames){ const v=parseFloat(g[f]); if(v){amt=v;break;} }
        }
        chitByGroup[g.id]=amt;
    });
    const slotMap = new Map();
    payments.forEach(p=>{
        const gid = p.groupId;
        const enrId = p.enrollmentId||'';
        const slotNum = p.slotNum!=null?p.slotNum:1;
        const paid = parseFloat(p.paid)||0;
        const slots = Array.isArray(p.monthSlots)?p.monthSlots:(p.monthSlot!=null?[p.monthSlot]:[]);
        const numMonths = slots.length||1;
        const perMonthPaid = paid/numMonths;
        slots.forEach(s=>{
            const key = gid+'|'+enrId+'|'+slotNum+'|'+s;
            const existing = slotMap.get(key)||{gid,paid:0};
            existing.paid += perMonthPaid;
            slotMap.set(key,existing);
        });
    });
    let totalBal = 0;
    slotMap.forEach(v=>{
        const chitAmount = chitByGroup[v.gid]||0;
        totalBal += Math.max(0, chitAmount - v.paid);
    });
    return totalBal;
}

async function loadMemberLedger(){
    const mid = CURRENT_USER && CURRENT_USER.role === 'member'
        ? CURRENT_USER.memberId
        : document.getElementById('summaryView').value;
    if(!mid) return;

    const ms=await getCollection('members');
    const gs=await getCollection('groups');
    const ps=await getCollection('payments');
    bustCache('memberCommitments');
    const cs=await getCollection('memberCommitments');
    const payoutsDoc = await db.collection('settings').doc('collectionPayouts').get().catch(()=>null);
    const _payoutsMap = payoutsDoc && payoutsDoc.exists ? (payoutsDoc.data().payouts||{}) : {};
    const m=ms.find(x=>x.id===mid); if(!m) return;
    const mPays=ps.filter(p=>p.memberId===mid);
    const mComms=cs.filter(c=>c.memberId===mid);
    const totalPaid=mPays.reduce((s,p)=>s+(parseFloat(p.paid)||0),0);
    const totalBal =computeCorrectedTotalBalance(mPays, gs);
    let enrollments = m.enrollments;
    if(!enrollments||!enrollments.length)
        enrollments=(m.groupIds||[]).map(gid=>({enrollmentId:'',groupId:gid,label:'',qty:1}));
    const memberGroups=gs.filter(g=>m.groupIds&&m.groupIds.includes(g.id));
    const isMember = CURRENT_USER && CURRENT_USER.role==='member';
    const today = new Date().toISOString().split('T')[0];

    function buildSection(grp, enr, slotPays, slotNum, totalSlots, allDueDates, sectionId, groupLabel='', coMember=null, coMemberPays=[]){
        // Always list payments oldest -> newest, so several payments in a month show in the
        // correct date order (stable sort: same-date payments keep their entry order)
        slotPays = [...slotPays].sort((a,b)=>(a.date||'').localeCompare(b.date||''));
        const totalMonths  = parseInt(grp.duration||grp.gDuration)||21;
        
        // Get chit amount from Firebase field: fixedAmt
        let chitAmount = parseFloat(grp.fixedAmt) || 0;
        
        // Fallback: try other variations
        if(!chitAmount || chitAmount === 0) {
            const fieldNames = [
                'fixedMonthlyAmount',
                'monthlyChitAmount', 
                'monthlyAmount',
                'fixedAmount',
                'amount',
                'chitAmount'
            ];
            
            for(let field of fieldNames) {
                const val = parseFloat(grp[field]);
                if(val && val > 0) {
                    chitAmount = val;
                    break;
                }
            }
        }
        
        // Last resort: get from last payment
        if(!chitAmount || chitAmount === 0) {
            const lastPay = slotPays.length ? slotPays[slotPays.length-1] : null;
            if(lastPay) chitAmount = parseFloat(lastPay.chit)||0;
        }

        // Calculate fully paid months
        const _perSlotTotals = {};
        slotPays.forEach(p=>{
            const slots=Array.isArray(p.monthSlots)?p.monthSlots:(p.monthSlot!=null?[p.monthSlot]:[]);
            slots.forEach(s=>{ _perSlotTotals[s]=(_perSlotTotals[s]||0)+(parseFloat(p.paid)||0); });
        });
        const fullyPaidSlotSet = new Set(Object.keys(_perSlotTotals).filter(s=>chitAmount<=0||_perSlotTotals[s]>=chitAmount).map(Number));
        const monthsDone   = fullyPaidSlotSet.size;
        const pct          = Math.min(100,Math.round(monthsDone/totalMonths*100));
        const tPaid        = slotPays.reduce((s,p)=>s+(parseFloat(p.paid)||0),0);
        // BUGFIX: sum true per-slot shortfall (using _perSlotTotals, computed above from actual
        // paid amounts) instead of summing each payment's independently-stored `balance` field,
        // which double-counts when a month was paid via more than one partial payment.
        const tBal         = Object.keys(_perSlotTotals).reduce((s,slotKey)=>s+Math.max(0, chitAmount-_perSlotTotals[slotKey]),0);

        // Build table rows — joint slots show combined row
        const mergedRows = allDueDates.map((dueDate, slotIndex) => {
            // Co-member's payment for this slot (joint chit)
            const coMonthPay = coMember ? coMemberPays.find(p => {
                if(p.isJointMirror) return false;
                if(p.monthSlot != null) return p.monthSlot === slotIndex;
                if(Array.isArray(p.monthSlots)) return p.monthSlots.includes(slotIndex);
                return getMonthSlot(allDueDates, p.date) === slotIndex;
            }) : null;
            // Find all payments for this month/slot
            const monthPayments = slotPays.filter(p => {
                if(p.monthSlot != null) return p.monthSlot === slotIndex;
                if(Array.isArray(p.monthSlots)) return p.monthSlots.includes(slotIndex);
                return getMonthSlot(allDueDates, p.date) === slotIndex;
            });
            
            // If no payments for this month, show one pending row
            if(monthPayments.length === 0) {
                const isOverdue = dueDate < today;
                const statusBadge = isOverdue 
                    ? `<span style="background:rgba(239,68,68,0.15);color:#f87171;border:1px solid rgba(239,68,68,0.3);border-radius:4px;padding:1px 5px;font-size:0.65rem;font-weight:800;">🔴</span>`
                    : `<span style="background:rgba(245,158,11,0.08);color:#fbbf24;border:1px solid rgba(245,158,11,0.2);border-radius:4px;padding:1px 5px;font-size:0.65rem;font-weight:800;">⏳</span>`;
                
                // Chit Picked cell for pending rows
                const commitment_p = mComms.find(c => c.groupId===grp.id && (c.slotNum==null?1:c.slotNum)===slotNum && c.targetMonth===slotIndex+1);
                const commitmentBadge = commitment_p
                    ? `<span style="background:rgba(155,89,182,0.2);color:#bb86fc;border:1px solid rgba(155,89,182,0.4);border-radius:5px;padding:2px 7px;font-size:0.68rem;font-weight:800;">🎯 Chit Target</span>`
                    : `<span style="color:var(--text-dim);">—</span>`;
                
                const _poPend = _payoutsMap[grp.id+'_'+slotIndex]||0;
                const _poCellPend = _poPend>0
                    ? (!isMember
                        ? `<input type="number" value="${_poPend}" data-gid="${grp.id}" data-idx="${slotIndex}" onchange="updateLedgerPayout(this)" style="width:72px;background:rgba(167,139,250,0.1);border:1px solid rgba(167,139,250,0.3);color:#a78bfa;border-radius:6px;padding:3px 6px;font-size:0.72rem;font-weight:700;text-align:center;outline:none;">`
                        : `<span style="color:#a78bfa;font-weight:700;">${fmtAmt(_poPend)}</span>`)
                    : (!isMember
                        ? `<input type="number" placeholder="—" data-gid="${grp.id}" data-idx="${slotIndex}" onchange="updateLedgerPayout(this)" style="width:72px;background:rgba(167,139,250,0.1);border:1px solid rgba(167,139,250,0.3);color:#a78bfa;border-radius:6px;padding:3px 6px;font-size:0.72rem;font-weight:700;text-align:center;outline:none;">`
                        : `<span style="color:var(--text-dim);">—</span>`);
                // Joint chit: only show partner info if partner has actually paid this month
                const partnerLine = (coMember && coMonthPay)
                    ? `<div style="font-size:0.6rem;color:#34d399;margin-top:1px;white-space:nowrap;">✅ ${coMember.name.split(' ')[0]} ${fmtAmt(parseFloat(coMonthPay.paid)||0)}</div>`
                    : '';
                const myPendingStatus = (coMember && coMonthPay)
                    ? '<span style="background:rgba(99,102,241,0.15);color:#a5b4fc;border:1px solid rgba(99,102,241,0.3);border-radius:4px;padding:1px 5px;font-size:0.65rem;font-weight:800;">👥⏳</span>'
                    : statusBadge;
                return `<tr style="${coMember&&coMonthPay?'background:rgba(99,102,241,0.04);border-left:2px solid rgba(99,102,241,0.3);':''}">
                    <td style="text-align:center;color:var(--text-dim);font-weight:700;font-size:0.7rem;">${slotIndex+1}</td>
                    <td style="color:${isOverdue?'#f87171':'#c7d2fe'};font-weight:600;">${fmtDate(dueDate)}</td>
                    <td style="color:#c4b5fd;">${chitAmount>0?fmtAmt(chitAmount):'---'}</td>
                    <td style="vertical-align:top;color:var(--text-dim);font-size:0.7rem;">---${partnerLine}</td>
                    <td style="vertical-align:top;color:var(--text-dim);font-weight:700;">---</td>
                    <td style="vertical-align:middle;">${_poCellPend}</td>
                    <td style="vertical-align:middle;color:var(--text-dim);">---</td>
                    <td style="vertical-align:middle;">${myPendingStatus}</td>
                    <td style="vertical-align:middle;color:var(--text-dim);font-size:0.7rem;">---</td>
                    <td style="vertical-align:middle;">${commitmentBadge}</td>
                    <td style="vertical-align:middle;"></td>
                </tr>`;
            }
            
            // If only ONE payment, show normally
            if(monthPayments.length === 1) {
                const pay = monthPayments[0];
                const iPaid = parseFloat(pay.paid)||0;
                const iBal = parseFloat(pay.balance)||0;
                const iMode = pay.paidBy||'—';
                const iCp = pay.chitPicked==='Yes';
                const isPaid = iPaid > 0;
                
                const rowBg = isPaid ? 'rgba(16,185,129,0.07)' : '';
                const rowBL = iCp ? 'border-left:3px solid #10b981;' : '';
                
                let statusBadge = isPaid 
                    ? `<span style="background:rgba(16,185,129,0.15);color:#34d399;border:1px solid rgba(16,185,129,0.3);border-radius:4px;padding:1px 5px;font-size:0.65rem;font-weight:800;">✅</span>`
                    : `<span style="background:rgba(245,158,11,0.08);color:#fbbf24;border:1px solid rgba(245,158,11,0.2);border-radius:4px;padding:1px 5px;font-size:0.65rem;font-weight:800;">⏳</span>`;
                
                const editCell = !isMember ? `<button class="btn-edit-sm" onclick="openEditPayment('${pay.id}')" style="font-size:0.62rem;padding:3px 7px;background:rgba(99,102,241,0.15);border:1px solid rgba(99,102,241,0.3);color:#a5b4fc;border-radius:4px;cursor:pointer;">Edit</button>` : '';
                
                // Chit Picked cell: show amount if picked, Chit Target badge if it's commitment month, else —
                const commitment_s = mComms.find(c => c.groupId===grp.id && (c.slotNum==null?1:c.slotNum)===slotNum && c.targetMonth===slotIndex+1);
                const chitPickedCell = iCp
                    ? `<span style="background:rgba(16,185,129,0.2);color:#34d399;border:1px solid rgba(16,185,129,0.4);border-radius:5px;padding:2px 7px;font-size:0.68rem;font-weight:800;">🏆 ${pay.chitPickedBy ? fmtAmt(parseFloat(pay.chitPickedBy)||0) || pay.chitPickedBy : fmtAmt(parseFloat(pay.chit)||0)}</span>`
                    : (commitment_s
                        ? `<span style="background:rgba(155,89,182,0.2);color:#bb86fc;border:1px solid rgba(155,89,182,0.4);border-radius:5px;padding:2px 7px;font-size:0.68rem;font-weight:800;">🎯 Chit Target</span>`
                        : `<span style="color:var(--text-dim);">—</span>`);
                
                const dateColor = isPaid ? '#a5b4fc' : '#c7d2fe';
                
                const _poSingle = _payoutsMap[grp.id+'_'+slotIndex]||0;
                const _poCellSingle = _poSingle>0
                    ? (!isMember
                        ? `<input type="number" value="${_poSingle}" data-gid="${grp.id}" data-idx="${slotIndex}" onchange="updateLedgerPayout(this)" style="width:72px;background:rgba(167,139,250,0.1);border:1px solid rgba(167,139,250,0.3);color:#a78bfa;border-radius:6px;padding:3px 6px;font-size:0.72rem;font-weight:700;text-align:center;outline:none;">`
                        : `<span style="color:#a78bfa;font-weight:700;">${fmtAmt(_poSingle)}</span>`)
                    : (!isMember
                        ? `<input type="number" placeholder="—" data-gid="${grp.id}" data-idx="${slotIndex}" onchange="updateLedgerPayout(this)" style="width:72px;background:rgba(167,139,250,0.1);border:1px solid rgba(167,139,250,0.3);color:#a78bfa;border-radius:6px;padding:3px 6px;font-size:0.72rem;font-weight:700;text-align:center;outline:none;">`
                        : `<span style="color:var(--text-dim);">—</span>`);
                // Joint: combine both payments for balance calculation
                const coPaidAmt = coMember && coMonthPay ? parseFloat(coMonthPay.paid)||0 : 0;
                const totalPaidJoint = iPaid + coPaidAmt;
                const jointBalance = coMember ? Math.max(0, chitAmount - totalPaidJoint) : iBal;
                const bothPaid = coMember && coMonthPay && coPaidAmt > 0;

                // Only show partner sub-line if partner actually paid
                const coSubLine = (coMember && coMonthPay)
                    ? `<div style="font-size:0.6rem;color:#34d399;margin-top:1px;white-space:nowrap;">✅ ${coMember.name.split(' ')[0]} ${fmtAmt(coPaidAmt)}</div>`
                    : (coMember ? `<div style="font-size:0.6rem;color:#f87171;margin-top:1px;white-space:nowrap;">⏳ ${coMember.name.split(' ')[0]}</div>` : '');

                const jointBadge = coMember
                    ? (bothPaid
                        ? `<span style="background:rgba(16,185,129,0.15);color:#34d399;border:1px solid rgba(16,185,129,0.3);border-radius:4px;padding:1px 5px;font-size:0.65rem;font-weight:800;">👥✅</span>`
                        : `<span style="background:rgba(99,102,241,0.15);color:#a5b4fc;border:1px solid rgba(99,102,241,0.3);border-radius:4px;padding:1px 5px;font-size:0.65rem;font-weight:800;">👥⏳</span>`)
                    : statusBadge;

                const balDisplay = coMember
                    ? (jointBalance > 0 ? fmtAmt(jointBalance) : '---')
                    : (iBal > 0 ? fmtAmt(iBal) : '---');
                const balColor = jointBalance > 0 ? '#f59e0b' : '#34d399';

                return `<tr style="background:${rowBg};${rowBL}">
                        <td style="text-align:center;color:var(--text-dim);font-weight:700;font-size:0.7rem;">${slotIndex+1}</td>
                        <td style="color:${dateColor};font-weight:600;">${fmtDate(dueDate)}</td>
                        <td style="color:#c4b5fd;">${chitAmount>0?fmtAmt(chitAmount):'---'}</td>
                        <td style="vertical-align:top;font-size:0.72rem;color:var(--text-dim);">${fmtDate(pay.date)}</td>
                        <td style="vertical-align:top;color:${isPaid?'#34d399':'#fbbf24'};font-weight:700;">
                            ${fmtAmt(iPaid)}${coSubLine}
                        </td>
                        <td style="vertical-align:middle;">${_poCellSingle}</td>
                        <td style="vertical-align:middle;color:${balColor};">${balDisplay}</td>
                        <td style="vertical-align:middle;">${coMember ? jointBadge : statusBadge}</td>
                        <td style="vertical-align:middle;color:var(--text-dim);font-size:0.7rem;">${iMode}</td>
                        <td style="vertical-align:middle;">${chitPickedCell}</td>
                        <td style="vertical-align:middle;">${editCell}</td>
                    </tr>`;
            }
            
            // MULTIPLE PAYMENTS (Partial) - Show main row FIRST, then detail rows
            const totalMonthPayments = monthPayments.reduce((s,p) => s + (parseFloat(p.paid)||0), 0);
            // BUGFIX: Recalculate balance from scratch instead of using last payment's balance
            // Joint chit: add everything the co-member paid for this slot
            const coPaidMulti = coMember ? coMemberPays.filter(p => {
                if(p.isJointMirror) return false;
                if(p.monthSlot != null) return p.monthSlot === slotIndex;
                if(Array.isArray(p.monthSlots)) return p.monthSlots.includes(slotIndex);
                return getMonthSlot(allDueDates, p.date) === slotIndex;
            }).reduce((s,p)=>s+(parseFloat(p.paid)||0),0) : 0;
            const mainIBal = Math.max(0, chitAmount - totalMonthPayments - coPaidMulti);
            
            // Determine if partial is actually fully paid
            const isPartialFullyPaid = chitAmount > 0 ? (totalMonthPayments + coPaidMulti) >= chitAmount : totalMonthPayments > 0;
            const statusForPartial = coMember
                ? (isPartialFullyPaid ? `<span style="background:rgba(16,185,129,0.15);color:#34d399;border:1px solid rgba(16,185,129,0.3);border-radius:4px;padding:1px 5px;font-size:0.65rem;font-weight:800;">👥✅</span>` : `<span style="background:rgba(245,158,11,0.15);color:#fbbf24;border:1px solid rgba(245,158,11,0.35);border-radius:4px;padding:1px 5px;font-size:0.65rem;font-weight:800;">👥⚡</span>`)
                : isPartialFullyPaid
                ? `<span style="background:rgba(16,185,129,0.15);color:#34d399;border:1px solid rgba(16,185,129,0.3);border-radius:4px;padding:1px 5px;font-size:0.65rem;font-weight:800;">✅</span>`
                : `<span style="background:rgba(245,158,11,0.15);color:#fbbf24;border:1px solid rgba(245,158,11,0.35);border-radius:4px;padding:1px 5px;font-size:0.65rem;font-weight:800;">⚡</span>`;
            
            let mainRows = '';
            
            // Main summary row for this month (shows total of all partials) - CLICKABLE to toggle
            const _poMulti = _payoutsMap[grp.id+'_'+slotIndex]||0;
            const _poCellMulti = _poMulti>0
                ? (!isMember
                    ? `<input type="number" value="${_poMulti}" data-gid="${grp.id}" data-idx="${slotIndex}" onchange="updateLedgerPayout(this)" style="width:72px;background:rgba(167,139,250,0.1);border:1px solid rgba(167,139,250,0.3);color:#a78bfa;border-radius:6px;padding:3px 6px;font-size:0.72rem;font-weight:700;text-align:center;outline:none;">`
                    : `<span style="color:#a78bfa;font-weight:700;">${fmtAmt(_poMulti)}</span>`)
                : (!isMember
                    ? `<input type="number" placeholder="—" data-gid="${grp.id}" data-idx="${slotIndex}" onchange="updateLedgerPayout(this)" style="width:72px;background:rgba(167,139,250,0.1);border:1px solid rgba(167,139,250,0.3);color:#a78bfa;border-radius:6px;padding:3px 6px;font-size:0.72rem;font-weight:700;text-align:center;outline:none;">`
                    : `<span style="color:var(--text-dim);">—</span>`);
            mainRows += `<tr style="background:${isPartialFullyPaid ? 'rgba(16,185,129,0.07)' : 'rgba(245,158,11,0.12)'};border-left:3px solid ${isPartialFullyPaid ? '#10b981' : '#f59e0b'};font-weight:600;cursor:pointer;" onclick="togglePaymentDetails(this,'partial_${sectionId}_${slotIndex}')">
                    <td style="text-align:center;color:${isPartialFullyPaid ? '#34d399' : '#f59e0b'};font-weight:800;font-size:0.8rem;">▶ ${slotIndex+1}</td>
                    <td style="color:${isPartialFullyPaid ? '#a5b4fc' : '#fbbf24'};font-weight:700;">${fmtDate(dueDate)}</td>
                    <td style="color:#c4b5fd;">${chitAmount>0?fmtAmt(chitAmount):'—'}</td>
                    <td style="vertical-align:middle;font-size:0.68rem;">${monthPayments.map(p=>`<div style="color:#a5b4fc;white-space:nowrap;">${fmtDate(p.date)}</div>`).join('')}</td>
                    <td style="vertical-align:middle;color:${isPartialFullyPaid ? '#34d399' : '#fbbf24'};font-weight:700;">${fmtAmt(totalMonthPayments)}</td>
                    <td style="vertical-align:middle;">${_poCellMulti}</td>
                    <td style="vertical-align:middle;color:#f59e0b;">${mainIBal>0?fmtAmt(mainIBal):'—'}</td>
                    <td style="vertical-align:middle;">${statusForPartial}</td>
                    <td style="vertical-align:middle;color:var(--text-dim);font-size:0.7rem;">—</td>
                    <td style="vertical-align:middle;"><span style="color:var(--text-dim);">—</span></td>
                    <td style="vertical-align:middle;"></td>
                </tr>`;
            
            // Detail rows for each partial payment (hidden by default)
            // BUGFIX: don't trust each payment's stored `balance` field — it was computed
            // independently against the full month chit amount at save time, ignoring any
            // other partial payments made for the same month. Recompute a running/cumulative
            // balance instead so partial payments that add up to the full amount show 0/—.
            let _cumPaidSoFar = 0;
            mainRows += monthPayments.map((pay, payIdx) => {
                const iPaid = parseFloat(pay.paid)||0;
                _cumPaidSoFar += iPaid;
                const iBal = Math.max(0, chitAmount - _cumPaidSoFar - coPaidMulti);
                // ✅ only once cumulative total reaches the chit amount, else ⚡ partial
                const iReached = chitAmount > 0 ? (_cumPaidSoFar + coPaidMulti) >= chitAmount : iPaid > 0;
                const iMode = pay.paidBy||'—';
                const iCp = pay.chitPicked==='Yes';
                const isPaid = iPaid > 0;
                
                let iStatusBadge = !isPaid
                    ? `<span style="background:rgba(245,158,11,0.08);color:#fbbf24;border:1px solid rgba(245,158,11,0.2);border-radius:4px;padding:1px 5px;font-size:0.65rem;font-weight:800;">⏳</span>`
                    : (iReached ? `<span style="background:rgba(16,185,129,0.15);color:#34d399;border:1px solid rgba(16,185,129,0.3);border-radius:4px;padding:1px 5px;font-size:0.65rem;font-weight:800;">✅</span>` : `<span style="background:rgba(245,158,11,0.15);color:#fbbf24;border:1px solid rgba(245,158,11,0.35);border-radius:4px;padding:1px 5px;font-size:0.65rem;font-weight:800;">⚡</span>`);
                
                const editBtn = !isMember ? `<button class="btn-edit-sm" onclick="openEditPayment('${pay.id}')" style="font-size:0.62rem;padding:3px 7px;background:rgba(99,102,241,0.15);border:1px solid rgba(99,102,241,0.3);color:#a5b4fc;border-radius:4px;cursor:pointer;">Edit</button>` : '';
                
                const iChitPickedCell = iCp 
                    ? `<span style="background:rgba(16,185,129,0.2);color:#34d399;border:1px solid rgba(16,185,129,0.4);border-radius:5px;padding:1px 6px;font-size:0.62rem;font-weight:800;">🏆 ${pay.chitPickedBy || 'Picked'}</span>`
                    : `<span style="color:var(--text-dim);">—</span>`;
                
                return `<tr class="partial_${sectionId}_${slotIndex}" style="display:none;background:rgba(245,158,11,0.04);border-left:2px solid #f59e0b;">
                    <td style="text-align:center;color:#f59e0b;font-size:0.6rem;padding:4px 6px;font-weight:800;">  ↳${payIdx+1}</td>
                    <td style="color:#fbbf24;font-weight:600;font-size:0.85rem;"></td>
                    <td style="color:#c4b5fd;"></td>
                    <td style="vertical-align:middle;color:#f59e0b;font-size:0.75rem;font-weight:700;">${fmtDate(pay.date)}</td>
                    <td style="vertical-align:middle;color:#34d399;font-weight:700;">${fmtAmt(iPaid)}</td>
                    <td style="vertical-align:middle;color:var(--text-dim);">—</td>
                    <td style="vertical-align:middle;color:#f59e0b;">${iBal>0?fmtAmt(iBal):'—'}</td>
                    <td style="vertical-align:middle;">${iStatusBadge}</td>
                    <td style="vertical-align:middle;color:var(--text-dim);font-size:0.7rem;">${iMode}</td>
                    <td style="vertical-align:middle;">${iChitPickedCell}</td>
                    <td style="vertical-align:middle;">${editBtn}</td>
                </tr>`;
            }).join('');
            
            return mainRows;
        }).join('');

        // Next due date — first unpaid future slot
        const _td = new Date().toISOString().split('T')[0];
        const nextDueDate = allDueDates.find((d,i) => {
            const isPaid = slotPays.some(p =>
                (Array.isArray(p.monthSlots)&&p.monthSlots.includes(i)) || p.monthSlot===i
            );
            return !isPaid && d >= _td;
        }) || null;

        const overdueCnt = allDueDates.filter((d,i)=>!slotPays.find(p=>{
            if(Array.isArray(p.monthSlots)) return p.monthSlots.includes(i);
            if(p.monthSlot!=null) return p.monthSlot===i;
            return getMonthSlot(allDueDates, p.date)===i;
        })&&d<today).length;

        const chitSlotBadge = totalSlots>1
            ? `<span style="background:rgba(245,158,11,0.25);border:1px solid rgba(245,158,11,0.5);color:#fbbf24;border-radius:5px;padding:2px 9px;font-size:0.75rem;font-weight:800;margin-left:6px;">Chit ${slotNum}</span>`
            : '';
        const labelBadge = enr.label
            ? `<span style="background:rgba(243,156,18,.18);border:1px solid rgba(243,156,18,.35);border-radius:5px;padding:1px 7px;font-size:0.72rem;color:#f39c12;margin-left:6px;">${enr.label}</span>` : '';
        
        // Calculate end date
        const startDate = new Date((grp.startDate || grp.gStart || new Date().toISOString().split('T')[0]) + 'T00:00:00');
        const endDate = new Date(startDate);
        endDate.setMonth(endDate.getMonth() + totalMonths);
        const _edM = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
        const pad = n => String(n).padStart(2, '0');
        const endDateStr = `${pad(endDate.getDate())}.${_edM[endDate.getMonth()]}.${endDate.getFullYear()}`;

        // All commitments for this group across ALL members (to show availability)
        const allGroupComms = cs.filter(c => c.groupId === grp.id);
        const takenMonths = new Set(allGroupComms.map(c => c.targetMonth).filter(Boolean));
        const freeMonths = [];
        for(let m=1; m<=totalMonths; m++){ if(!takenMonths.has(m)) freeMonths.push(m); }
        const commitAvailText = freeMonths.length===0
            ? '<span style="color:#f87171;font-size:0.72rem;font-weight:800;">All months taken</span>'
            : freeMonths.length===totalMonths
                ? '<span style="color:#34d399;font-size:0.72rem;font-weight:800;">All months free</span>'
                : freeMonths.map(n=>getOrdinal(n)).join(', ');

        // Commitment chip for this member+slot
        const myCommObj = mComms.find(c => c.groupId===grp.id && (c.slotNum==null?1:c.slotNum)===slotNum);
        const myCommChip = myCommObj && myCommObj.targetMonth
            ? `<span style="background:rgba(155,89,182,0.2);border:1px solid rgba(155,89,182,0.45);border-radius:6px;padding:3px 9px;font-size:0.72rem;color:#bb86fc;font-weight:800;">🎯 ${getOrdinal(myCommObj.targetMonth)} Month</span>`
            : '';

        // ── Determine group status ──
        const _today2 = new Date().toISOString().split('T')[0];
        const isCompleted  = monthsDone >= totalMonths && tBal <= 0;
        const isEndPassed  = endDateStr && (()=>{ try{ const[d,m,y]=endDateStr.split('.');const mn=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"].indexOf(m);return new Date(y,mn,parseInt(d)).toISOString().split('T')[0] < _today2; }catch(e){return false;} })();
        const groupStatus  = isCompleted
            ? 'completed'   // all months paid, no balance
            : isEndPassed
                ? 'closed'  // end date passed but balance remains
                : pct === 0
                    ? 'new' // no payments yet
                    : 'active';

        // Restore collapse state — completed/closed default to COLLAPSED, active/new default OPEN
        const _lsKey = 'ledger_open_' + sectionId;
        const _lsVal = localStorage.getItem(_lsKey);
        const _isOpen = _lsVal !== null
            ? _lsVal !== 'closed'
            : (groupStatus === 'active' || groupStatus === 'new'); // default open only for active

        return `<div style="margin-bottom:16px;page-break-inside:avoid;">

            <!-- ── Group Card Header (always visible, tap to collapse) ── -->
            ${(()=>{
                const _sc = {
                    completed: { bg:'linear-gradient(135deg,rgba(16,185,129,0.18),rgba(16,185,129,0.06))', border:'rgba(16,185,129,0.4)',  dot:'#10b981', nameColor:'#34d399',  badge:'✅ COMPLETED', badgeBg:'rgba(16,185,129,0.2)',  badgeColor:'#34d399',  badgeBorder:'rgba(16,185,129,0.4)'  },
                    closed:    { bg:'linear-gradient(135deg,rgba(239,68,68,0.14),rgba(239,68,68,0.04))',  border:'rgba(239,68,68,0.35)',  dot:'#ef4444', nameColor:'#f87171',  badge:'🔒 CLOSED',    badgeBg:'rgba(239,68,68,0.15)',   badgeColor:'#f87171',  badgeBorder:'rgba(239,68,68,0.35)'  },
                    new:       { bg:'linear-gradient(135deg,rgba(99,102,241,0.15),rgba(99,102,241,0.04))',border:'rgba(99,102,241,0.35)', dot:'#6366f1', nameColor:'#a5b4fc',  badge:'🆕 NEW',       badgeBg:'rgba(99,102,241,0.18)',  badgeColor:'#a5b4fc',  badgeBorder:'rgba(99,102,241,0.4)'  },
                    active:    { bg:'linear-gradient(135deg,rgba(243,156,18,0.18),rgba(243,156,18,0.06))',border:'rgba(243,156,18,0.35)', dot:'#f39c12', nameColor:'#f39c12',  badge:'🟢 ACTIVE',    badgeBg:'rgba(16,185,129,0.15)', badgeColor:'#34d399',  badgeBorder:'rgba(16,185,129,0.35)' },
                };
                const s = _sc[groupStatus] || _sc.active;
                return `<div onclick="ledgerToggleSection('${sectionId}')"
                     style="display:flex;align-items:center;justify-content:space-between;gap:10px;
                             background:${s.bg};border:1px solid ${s.border};
                             border-radius:${_isOpen?'14px 14px 0 0':'14px'};
                             padding:13px 16px;cursor:pointer;user-select:none;transition:border-radius .25s;"
                     id="hdr_${sectionId}">
                    <div style="display:flex;align-items:center;gap:10px;min-width:0;">
                        <div style="width:10px;height:10px;border-radius:50%;background:${s.dot};flex-shrink:0;box-shadow:0 0 6px ${s.dot};"></div>
                        <div style="min-width:0;">
                            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:2px;">
                                <span style="font-size:1rem;font-weight:900;color:${s.nameColor};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${grp.name}${labelBadge}${chitSlotBadge}${coMember?` <span style="background:rgba(99,102,241,0.18);border:1px solid rgba(99,102,241,0.4);color:#a5b4fc;border-radius:5px;padding:1px 7px;font-size:0.7rem;font-weight:800;">Joint with ${coMember.name.split(' ')[0]}</span>`:''}</span>
                                <span style="font-size:0.6rem;background:${s.badgeBg};border:1px solid ${s.badgeBorder};color:${s.badgeColor};border-radius:5px;padding:1px 7px;font-weight:800;">${s.badge}</span>
                                ${groupLabel?`<span style="font-size:0.6rem;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);color:var(--text-dim);border-radius:4px;padding:1px 6px;font-weight:700;">${groupLabel}</span>`:''}
                            </div>
                            <div style="font-size:0.65rem;color:var(--text-dim);">${fmtDate(grp.startDate||grp.gStart||'')} → ${endDateStr} &nbsp;·&nbsp; ${monthsDone}/${totalMonths} paid</div>
                        </div>
                    </div>
                    <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
                        ${overdueCnt>0?`<span style="background:rgba(239,68,68,0.15);color:#f87171;border:1px solid rgba(239,68,68,0.3);border-radius:5px;padding:2px 7px;font-size:0.65rem;font-weight:800;">${overdueCnt} overdue</span>`:''}
                        ${tBal>0?`<span style="background:rgba(245,158,11,0.12);color:#f59e0b;border:1px solid rgba(245,158,11,0.3);border-radius:5px;padding:2px 7px;font-size:0.65rem;font-weight:800;">${fmtAmt(tBal)} bal</span>`:''}
                        ${groupStatus==='completed'?`<span style="color:#34d399;font-size:0.7rem;font-weight:800;">₹${tPaid.toLocaleString('en-IN')} paid</span>`:''}
                        <span id="chv_${sectionId}" style="font-size:1rem;color:${s.dot};transition:transform .25s;display:inline-block;transform:${_isOpen?'rotate(90deg)':'rotate(0deg)'};">&#9654;</span>
                    </div>
                </div>`;
            })()}

            <!-- ── Collapsible body ── -->
            <div id="body_${sectionId}" style="display:${_isOpen?'block':'none'};">
            <div style="background:#1c253b;border-radius:0;padding:12px 16px;
                border-left:1px solid ${groupStatus==='completed'?'rgba(16,185,129,0.4)':groupStatus==='closed'?'rgba(239,68,68,0.35)':groupStatus==='new'?'rgba(99,102,241,0.35)':'rgba(243,156,18,0.35)'};
                border-right:1px solid ${groupStatus==='completed'?'rgba(16,185,129,0.4)':groupStatus==='closed'?'rgba(239,68,68,0.35)':groupStatus==='new'?'rgba(99,102,241,0.35)':'rgba(243,156,18,0.35)'};
                border-top:none;border-bottom:none;">

                <!-- Status banner for completed/closed groups -->
                ${groupStatus==='completed'?`<div style="background:rgba(16,185,129,0.12);border:1px solid rgba(16,185,129,0.3);border-radius:10px;padding:8px 14px;margin-bottom:10px;display:flex;align-items:center;gap:8px;"><span style="font-size:1.1rem;">🎉</span><div><div style="font-size:0.8rem;font-weight:800;color:#34d399;">Chit Completed!</div><div style="font-size:0.65rem;color:var(--text-dim);">All ${totalMonths} months paid · Total ₹${tPaid.toLocaleString('en-IN')}</div></div></div>`:''}
                ${groupStatus==='closed'?`<div style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:10px;padding:8px 14px;margin-bottom:10px;display:flex;align-items:center;gap:8px;"><span style="font-size:1.1rem;">🔒</span><div><div style="font-size:0.8rem;font-weight:800;color:#f87171;">Group Ended</div><div style="font-size:0.65rem;color:var(--text-dim);">End date passed · ₹${tBal.toLocaleString('en-IN')} balance remaining</div></div></div>`:''}

                <!-- 6-chip stat row responsive -->
                <div class="chip-grid">
                    <div class="chip-box" style="background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.25);border-top:2px solid #34d399;">
                        <span class="chip-label">START DATE</span>
                        <span class="chip-val" style="color:#34d399;">${fmtDate(grp.startDate||grp.gStart||'')}</span>
                    </div>
                    <div class="chip-box" style="background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.2);border-top:2px solid #6366f1;">
                        <span class="chip-label">NEXT DUE</span>
                        <span class="chip-val" style="color:#818cf8;">${nextDueDate?fmtDate(nextDueDate):'—'}</span>
                    </div>
                    <div class="chip-box" style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.25);border-top:2px solid #ef4444;">
                        <span class="chip-label">END DATE</span>
                        <span class="chip-val" style="color:#f87171;">${endDateStr}</span>
                    </div>
                    <div class="chip-box" style="background:rgba(165,180,252,0.08);border:1px solid rgba(165,180,252,0.25);border-top:2px solid #a5b4fc;">
                        <span class="chip-label">${isMember?'PROGRESS':'PENDING'}</span>
                        <span class="chip-val" style="color:#a5b4fc;">${monthsDone}/${totalMonths}</span>
                    </div>
                    <div class="chip-box" style="background:rgba(155,89,182,0.08);border:1px solid rgba(155,89,182,0.25);border-top:2px solid #bb86fc;">
                        <span class="chip-label">${isMember?'MY COMMIT':'COMMITMENT'}</span>
                        <span class="chip-val" style="color:#bb86fc;">${myCommObj&&myCommObj.targetMonth?getOrdinal(myCommObj.targetMonth)+' Mo':'—'}</span>
                    </div>
                    <div class="chip-box" style="background:rgba(99,102,241,0.06);border:1px solid rgba(99,102,241,0.18);border-top:2px solid #818cf8;">
                        <span class="chip-label">AVAIL</span>
                        <span class="chip-val" style="color:#a5b4fc;font-size:0.62rem;">${commitAvailText}</span>
                    </div>
                </div>

                <!-- Progress bar -->
                <div style="background:#252f48;border-radius:5px;height:6px;overflow:hidden;">
                    <div style="height:100%;border-radius:5px;background:linear-gradient(90deg,#f39c12,#f57c00);width:${pct}%;"></div>
                </div>
                <div style="font-size:0.62rem;color:var(--text-dim);margin-top:4px;">Month ${monthsDone}/${totalMonths} paid${overdueCnt>0?' · <span style="color:#f87171;">'+overdueCnt+' overdue</span>':''}</div>
            </div>

            <div style="background:var(--card-bg);border:1px solid var(--border);border-radius:0 0 12px 12px;overflow:hidden;page-break-inside:avoid;">
                <div onclick="toggleLedgerTable('${sectionId}',this)" style="display:flex;justify-content:space-between;align-items:center;padding:10px 16px;cursor:pointer;user-select:none;border-bottom:1px solid var(--border);page-break-inside:avoid;">
                    <span style="font-size:0.78rem;font-weight:700;color:#a5b4fc;text-transform:uppercase;letter-spacing:.5px;">📋 Schedule & Payments (${totalMonths} months)</span>
                    <div style="display:flex;align-items:center;gap:8px;">
                        ${tBal>0?`<span style="font-size:0.78rem;color:#f59e0b;font-weight:700;">${fmtAmt(tBal)} bal</span>`:''}
                        ${overdueCnt>0?`<span style="font-size:0.72rem;color:#f87171;font-weight:700;">${overdueCnt} overdue</span>`:''}
                        <span style="font-size:0.9rem;color:var(--text-dim);transition:transform .25s;" class="ledger-chevron">&#9654;</span>
                    </div>
                </div>
                <div id="${sectionId}" style="display:block;page-break-inside:avoid;">
                    <div style="overflow-x:auto;-webkit-overflow-scrolling:touch;width:100%;page-break-inside:avoid;">
                        <table class="table-custom" style="table-layout:auto !important;width:100% !important;">
                            <thead><tr style="page-break-inside:avoid;">
                                <th style="text-align:center;">#</th>
                                <th>Due Date</th>
                                <th>Monthly Pay</th>
                                <th>Pay Date</th>
                                <th>Paid</th>
                                <th style="color:#a78bfa;">Payout</th>
                                <th>Balance</th>
                                <th>Status</th>
                                <th>Mode</th>
                                <th>Chit Picked</th>
                                <th></th>
                            </tr></thead>
                            <tbody style="page-break-inside:avoid;">
                                ${mergedRows}
                                <tr style="font-weight:800;background:rgba(255,255,255,.04);page-break-inside:avoid;">
                                    <td colspan="4" style="color:var(--text-dim);">Total</td>
                                    <td style="color:#34d399;">${fmtAmt(tPaid)}</td>
                                    <td style="color:#f59e0b;">${tBal>0?fmtAmt(tBal):'—'}</td>
                                    <td colspan="4"></td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                    <div style="padding:6px 14px 8px;font-size:0.65rem;color:var(--text-dim);border-top:1px solid var(--border);page-break-inside:avoid;">
                        ✅ Paid &nbsp;|&nbsp; ⚡ Partial &nbsp;|&nbsp; 🔴 Overdue &nbsp;|&nbsp; ⏳ Pending
                    </div>
                </div>
            </div>
            </div><!-- end collapsible body -->
        </div>`;
    }

    const groupSections = enrollments.map((enr,idx)=>{
        const grp=gs.find(g=>g.id===enr.groupId); if(!grp) return '';
        const totalSlots = enr.qty || 1;

        // Joint chit: find partner member + their payments
        const coMid = enr.coMemberId || '';
        const coMember = coMid ? ms.find(x=>x.id===coMid) : null;
        const coMemberPays = coMid ? ps.filter(p=>p.memberId===coMid&&p.groupId===grp.id) : [];

        const slotSections = [];
        for(let slotNum = 1; slotNum <= totalSlots; slotNum++) {
            // My own payments for this slot (no filtering needed — each member pays independently)
            const slotPays = ps.filter(p => {
                if(p.memberId !== mid || p.groupId !== grp.id) return false;
                if(p.slotNum != null) return p.slotNum === slotNum;
                return true;
            });

            const allDueDates = buildDueDateList(grp);
            const id = `ledger_${idx}_${slotNum}`;
            const groupLabel = enrollments.length>1 ? 'Group '+(idx+1)+' of '+enrollments.length : '';
            slotSections.push(buildSection(grp, enr, slotPays, slotNum, totalSlots, allDueDates, id, groupLabel, coMember, coMemberPays));
        }

        return slotSections.join('');
    }).join('');

    // Build commitment chip
    // commitmentChip removed from member name — shown in chip row instead

    const ledgerHtml = `
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;padding-top:6px;">
            <div style="width:46px;height:46px;border-radius:12px;background:rgba(243,156,18,.15);border:2px solid rgba(243,156,18,.4);color:#f39c12;display:flex;align-items:center;justify-content:center;font-size:1rem;font-weight:900;flex-shrink:0;">${ini(m.name)}</div>
            <div style="flex:1;min-width:0;">
                <div style="font-size:1rem;font-weight:900;">${m.name}</div>
                <div style="font-size:0.72rem;color:var(--text-dim);margin-top:1px;">${enrollments.map(e=>{const g=gs.find(x=>x.id===e.groupId);return g?g.name:'';}).filter(Boolean).join(' · ')}</div>
            </div>
            <div style="display:flex;gap:6px;">
                ${!isMember?`<button class="btn-edit-sm" onclick="openEditMember('${mid}')">Edit</button>`:''} 
                <button onclick="printMemberStatement('${mid}')" style="background:linear-gradient(135deg,#f39c12,#f57c00);color:#000;padding:8px 14px;font-size:0.8rem;font-weight:800;border:none;border-radius:9px;cursor:pointer;">Print</button>
            </div>
        </div>
        ${groupSections||'<div style="text-align:center;color:var(--text-dim);padding:30px;">No group enrollments found</div>'}
    `;

    if(isMember){
        document.getElementById('memberLedgerData').innerHTML = ledgerHtml;
        document.getElementById('mhGroups').textContent = memberGroups.length;
        document.getElementById('mhTotalPaid').textContent = fmtAmt(totalPaid);
        document.getElementById('mhBalance').textContent = fmtAmt(totalBal);
    } else {
        document.getElementById('ledgerData').innerHTML = ledgerHtml;
    }
}

async function updateLedgerPayout(input){
    if(!isAdmin()){ showToast('🚫 Admin only', false); return; }
    const gid = input.dataset.gid;
    const idx = parseInt(input.dataset.idx);
    const val = parseFloat(input.value)||0;
    try {
        const doc = await db.collection('settings').doc('collectionPayouts').get();
        const payouts = doc.exists ? (doc.data().payouts||{}) : {};
        const key = gid + '_' + idx;
        if(val > 0) payouts[key] = val; else delete payouts[key];
        await db.collection('settings').doc('collectionPayouts').set({ payouts }, { merge: false });
        input.style.borderColor = '#34d399';
        setTimeout(() => { input.style.borderColor = 'rgba(167,139,250,0.3)'; }, 1200);
    } catch(e) { showToast('❌ Failed to save payout', false); }
}

// Toggle individual group section in member ledger, persist state
function ledgerToggleSection(sectionId){
    const body = document.getElementById('body_' + sectionId);
    const chv  = document.getElementById('chv_'  + sectionId);
    const hdr  = document.getElementById('hdr_'  + sectionId);
    if(!body) return;
    const isOpen = body.style.display !== 'none';
    body.style.display = isOpen ? 'none' : 'block';
    if(chv) chv.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(90deg)';
    if(hdr) hdr.style.borderRadius = isOpen ? '14px' : '14px 14px 0 0';
    localStorage.setItem('ledger_open_' + sectionId, isOpen ? 'closed' : 'open');
}

function toggleLedgerTable(id, el){
    const table = document.getElementById(id);
    if(table){
        const isHidden = table.style.display === 'none';
        table.style.display = isHidden ? 'block' : 'none';
        const chevron = el.querySelector('.ledger-chevron');
        if(chevron) chevron.style.transform = isHidden ? 'rotate(90deg)' : 'rotate(0deg)';
    }
}

function togglePaymentDetails(row, detailClass){
    const detailRows = document.querySelectorAll('.' + detailClass);
    const isHidden = detailRows.length === 0 || (detailRows[0] && detailRows[0].style.display === 'none');
    
    detailRows.forEach(r => {
        r.style.display = isHidden ? 'table-row' : 'none';
    });
    
    // Toggle arrow in first cell
    const firstCell = row.querySelector('td:first-child');
    if(firstCell) {
        const currentText = firstCell.textContent.trim();
        const num = currentText.replace('▶', '').replace('▼', '').trim();
        firstCell.textContent = (isHidden ? '▼' : '▶') + ' ' + num;
    }
}

function getMonthSlot(dueDates, payDate){
    if(!payDate) return -1;
    const pDate = new Date(payDate+'T00:00:00');
    for(let i=0; i<dueDates.length; i++){
        const dDate = new Date(dueDates[i]+'T00:00:00');
        const dNext = i<dueDates.length-1 ? new Date(dueDates[i+1]+'T00:00:00') : new Date(dDate.getFullYear(),dDate.getMonth()+2,1);
        if(pDate >= dDate && pDate < dNext) return i;
    }
    return -1;
}

function buildDueDateList(grp){
    const start  = grp.startDate||grp.gStart||new Date().toISOString().split('T')[0];
    const dur    = parseInt(grp.duration||grp.gDuration)||21;
    const s      = new Date(start+'T00:00:00');
    // Always use configured dueDay — never fall back to start date's day
    const dueDay = parseInt(grp.dueDay) || parseInt(grp.monthlyDueDay) || s.getDate();
    const baseYear  = s.getFullYear();
    const baseMonth = s.getMonth();
    const pad = n => String(n).padStart(2,'0');
    const dates = [];
    for(let i=0; i<dur; i++){
        const yr     = baseYear + Math.floor((baseMonth + i) / 12);
        const mo     = (baseMonth + i) % 12;
        const maxDay = new Date(yr, mo+1, 0).getDate();
        const day    = Math.min(dueDay, maxDay);
        dates.push(yr + '-' + pad(mo+1) + '-' + pad(day));
    }
    return dates;
}
