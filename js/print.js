// Safety net: if ui.js did not provide normalizePaidBy, use an equivalent so statements never fail
if(typeof normalizePaidBy!=='function'){
    window.normalizePaidBy=function(v){
        if(!v) return '—';
        const m=String(v).toLowerCase();
        if(m.includes('phone')||m.includes('pe')) return 'Phone Pe';
        if(m.includes('gpay')) return 'Gpay';
        if(m.includes('bank')) return 'Bank';
        if(m.includes('cash')) return 'Cash';
        return String(v);
    };
}

// Date formatters
function fmtDate(dateStr) {
    if(!dateStr) return '—';
    const d = new Date(dateStr + 'T00:00:00');
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = months[d.getMonth()];
    const yy = String(d.getFullYear()).slice(-2);
    return `${dd}/${mm}/${yy}`;
}

// PRINT MEMBER STATEMENT
// ══════════════════════════════════════════
async function printMemberStatement(mid, opts){
    opts = opts || {};   // opts.returnHtml: return the statement HTML instead of showing the print overlay
    if(!opts.silent) showToast('⏳ Preparing statement…', true);
    const ms=await getCollection('members');
    const gs=await getCollection('groups');
    const ps=await getCollection('payments');
    const m=ms.find(x=>x.id===mid); if(!m){showToast('❌ Member not found',false);return;}
    const mPays=ps.filter(p=>p.memberId===mid);
    const totalPaid=mPays.reduce((s,p)=>s+(parseFloat(p.paid)||0),0);
    
    // Initialize enrollments first
    let enrollments=m.enrollments;
    if(!enrollments||!enrollments.length) enrollments=(m.groupIds||[]).map(gid=>({enrollmentId:'',groupId:gid,label:'',qty:1}));
    
    // Calculate total chit commitment needed
    let totalChitNeeded = 0;
    enrollments.forEach(enr => {
        const g = gs.find(x => x.id === enr.groupId);
        if(g) {
            const duration = parseInt(g.duration || g.gDuration) || 21;
            const monthlyAmt = parseFloat(g.monthly || g.gMonthly) || 0;
            totalChitNeeded += (monthlyAmt * duration);
        }
    });
    
    const totalBal = Math.max(0, totalChitNeeded - totalPaid);
    const chitsPicked=mPays.filter(p=>p.chitPicked==='Yes').length;

    // Chit-picked chip info (replaces the removed Balance chip) — shows the
    // *actual monthly collection payout* for the month this chit was picked
    // (the same value shown in the Groups tab's "Chit Picked" column), not
    // the member's own monthly pay amount, which is a different figure.
    const ordinal = n => { const s=['th','st','nd','rd'], v=n%100; return n+(s[(v-20)%10]||s[v]||s[0]); };
    const payouts = (typeof _getPayouts === 'function') ? await _getPayouts() : {};
    const pickedPayForChip = mPays.find(p=>p.chitPicked==='Yes');
    let chitPickedChipVal = 'Not picked';
    let chitPickedChipColor = '#888';
    if(pickedPayForChip){
        const pg = gs.find(x=>x.id===pickedPayForChip.groupId);
        let monthNum = null;
        if(pickedPayForChip.monthSlot!=null){
            monthNum = pickedPayForChip.monthSlot+1;
        } else if(pg){
            const dueDates = getGroupDueDates(pg);
            const si = getMonthSlot(dueDates, pickedPayForChip.date);
            if(si>=0) monthNum = si+1;
        }
        // The recorded monthly collection payout for that due month is the actual
        // "chit picked" amount; fall back to the payment's own chit value only if
        // no payout has been entered for that month.
        const payoutKey = pg && monthNum ? (pg.id+'_'+(monthNum-1)) : null;
        const payoutVal = payoutKey && payouts[payoutKey] ? parseFloat(payouts[payoutKey])||0 : 0;
        const amt = payoutVal>0 ? payoutVal : (parseFloat(pickedPayForChip.chit)||0)*(parseInt(pickedPayForChip.numMonths)||1);
        chitPickedChipVal = `${Math.round(amt)}${monthNum?` on ${ordinal(monthNum)} month`:''}`;
        chitPickedChipColor = '#065f46';
    }
    
    // Calculate start and end dates across all enrollments
    let startDateVal = null;
    let endDateVal = null;
    
    // Find earliest start and latest end date
    enrollments.forEach(enr => {
        const g = gs.find(x => x.id === enr.groupId);
        if(g) {
            const gStart = g.startDate || g.gStart;
            if(gStart && (!startDateVal || gStart < startDateVal)) {
                startDateVal = gStart;
            }
            
            // Calculate end date from duration
            const totalMonths = parseInt(g.duration || g.gDuration) || 21;
            if(gStart) {
                const startDate = new Date(gStart + 'T00:00:00');
                const endDate = new Date(startDate.getFullYear(), startDate.getMonth() + totalMonths, startDate.getDate());
                if(!endDateVal || endDate > endDateVal) {
                    endDateVal = endDate;
                }
            }
        }
    });
    
    const startDateDisp = startDateVal ? new Date(startDateVal + 'T00:00:00').toLocaleDateString('en-IN', {day:'2-digit', month:'short', year:'numeric'}) : '—';
    const endDateDisp = endDateVal ? endDateVal.toLocaleDateString('en-IN', {day:'2-digit', month:'short', year:'numeric'}) : '—';
    
    // BUGFIX: Ensure we capture ALL groups - merge enrollments with groupIds
    // If member has groupIds that aren't in enrollments, add them
    const enrolledGroupIds = new Set(enrollments.map(e=>e.groupId));
    const missingGroups = (m.groupIds||[]).filter(gid => !enrolledGroupIds.has(gid));
    if(missingGroups.length > 0) {
        enrollments = [...enrollments, ...missingGroups.map(gid=>({enrollmentId:'',groupId:gid,label:'',qty:1}))];
    }
    
    // DEBUG: Log enrollments count
    console.log(`Member ${m.name} has ${enrollments.length} total enrollments:`, enrollments);
    
    const memberGroups=gs.filter(g=>m.groupIds&&m.groupIds.includes(g.id));
    const today=new Date().toLocaleDateString('en-IN',{day:'2-digit',month:'long',year:'numeric'});

    // Build merged schedule+history rows with rowspan for multi-month payments
    function buildPrintSlot(g, enr, slotPays, allDueDates, elapsed, totalMonths, left, pct, gStartDisp, gDueDayDisp, slotNum, totalSlots){
        const gPaid   = slotPays.reduce((s,p)=>s+(parseFloat(p.paid)||0),0);
        const monthsCovered = slotPays.reduce((s,p)=>s+(p.numMonths||1),0);
        const slotBadge  = totalSlots>1 ? `<span style="background:#fef3c7;color:#92400e;border-radius:3px;padding:1px 6px;font-size:9px;font-weight:800;margin-left:4px;">Chit ${slotNum} of ${totalSlots}</span>` : '';
        const labelBadge = enr.label ? `<span style="background:#fff3cd;color:#92400e;border-radius:3px;padding:1px 5px;font-size:9px;margin-left:4px;">${enr.label}</span>` : '';
        const indentStyle = totalSlots>1 ? 'margin-left:12px;border-left:3px solid #f5c842;padding-left:8px;' : '';
        const todayStr = new Date().toISOString().split('T')[0];

        // Get fixed chit amount — from payments first, fallback to group amount/members
        const lastPay    = slotPays.length ? slotPays[slotPays.length-1] : null;
        const membersCount = parseInt(g.members||g.gMembers||0);
        const groupAmount  = parseFloat(g.amount||g.gAmount||0);
        const chitAmount   = lastPay && parseFloat(lastPay.chit)>0
            ? parseFloat(lastPay.chit)
            : (membersCount>0 && groupAmount>0 ? Math.round(groupAmount/membersCount) : 0);
        
        // Calculate total balance for this slot
        const gBal = Math.max(0, (totalMonths * chitAmount) - gPaid);

        // Build paidSlotSet
        const paidSlotSet = new Set();
        slotPays.forEach(p=>{
            if(Array.isArray(p.monthSlots)) p.monthSlots.forEach(s=>paidSlotSet.add(s));
            else if(p.monthSlot!=null) paidSlotSet.add(p.monthSlot);
            else { const si=getMonthSlot(allDueDates,p.date); if(si>=0) paidSlotSet.add(si); }
        });

        // Payments that cover several months (bulk) are split evenly across those months
        const slotsOf = p => (Array.isArray(p.monthSlots)&&p.monthSlots.length) ? p.monthSlots : null;
        const shareOf = p => (parseFloat(p.paid)||0) / (slotsOf(p) ? slotsOf(p).length : 1);
        const isBulk  = p => !!slotsOf(p) && slotsOf(p).length>1;
        const payInMonth = (p,i) => {
            if(Array.isArray(p.monthSlots)) return p.monthSlots.includes(i);
            if(p.monthSlot!=null) return p.monthSlot===i;
            return getMonthSlot(allDueDates,p.date)===i;
        };

        // Build merged rows — EVERY payment made for a month gets its own line
        const rows = allDueDates.map((dueDate,i)=>{
            const monthPayments = slotPays.filter(p=>payInMonth(p,i));
            const totalMonthPaid = monthPayments.reduce((s,p)=>s+shareOf(p),0);
            const monthlyBalance = Math.max(0, chitAmount - totalMonthPaid);
            const chitAmt = chitAmount||0;

            const isAnyPaid     = monthPayments.length>0;
            const isFullPaid    = isAnyPaid && totalMonthPaid >= chitAmount;
            const isPartialPaid = isAnyPaid && totalMonthPaid > 0 && monthlyBalance > 0;
            const isOverdue     = !isAnyPaid && dueDate<todayStr;
            const cp            = monthPayments.some(p=>p.chitPicked==='Yes');
            const hasBulk       = monthPayments.some(isBulk);

            let status;
            if(isFullPaid) status='✅ Paid';
            else if(isPartialPaid) status='⚡ Partial';
            else if(isOverdue)     status='🔴 Overdue';
            else                   status='⏳ Pending';

            const bg = isFullPaid    ? '#f0fff8'
                     : isPartialPaid ? '#fffbeb'
                     : cp            ? '#f0fff8'
                     : hasBulk       ? '#eef2ff'
                     : isOverdue     ? '#fff5f5'
                     : (i%2===0?'#fff':'#fafafa');
            const bl = cp            ? 'border-left:3px solid #10b981;'
                     : hasBulk       ? 'border-left:3px solid #818cf8;'
                     : isPartialPaid ? 'border-left:3px solid #f59e0b;'
                     : '';
            const statusColor = isFullPaid?'#065f46':isPartialPaid?'#92400e':isOverdue?'#b91c1c':'#888';
            const money = v => 'Rs.'+Math.round(v).toLocaleString('en-IN');

            // Cells describing one payment: date, paid, mode
            const payCells = (pay, idx, runBal, many)=>{
                const bulk = isBulk(pay);
                const first = bulk ? Math.min.apply(null, slotsOf(pay)) : null;
                const paidTxt = bulk
                    ? (first===i
                        ? `${money(parseFloat(pay.paid)||0)} <small style="color:#3730a3;font-size:8px;">(${slotsOf(pay).length} mo)</small>`
                        : `<small style="color:#6366f1;font-size:8px;">↳ bulk payment</small>`)
                    : money(parseFloat(pay.paid)||0);
                return {
                    date: fmtDate(pay.date),
                    paid: paidTxt,
                    mode: normalizePaidBy(pay.paidBy),
                    bal: many ? money(runBal) : null
                };
            };

            if(!monthPayments.length){
                return `<tr style="background:${bg};${bl}">
                    <td style="text-align:center;color:#888;">${i+1}</td>
                    <td>${fmtDate(dueDate)}</td>
                    <td style="text-align:center;color:#555;">Rs.${chitAmt>0?chitAmt.toLocaleString('en-IN'):'—'}</td>
                    <td style="text-align:center;">—</td>
                    <td style="text-align:center;">—</td>
                    <td style="text-align:center;">—</td>
                    <td style="text-align:center;font-weight:700;color:${statusColor};">${status}</td>
                    <td style="text-align:center;color:#555;">—</td>
                </tr>`;
            }

            const many = monthPayments.length>1;
            let cum = 0;
            return monthPayments.map((pay,idx)=>{
                cum += shareOf(pay);
                const runBal = Math.max(0, chitAmount - cum);
                const c = payCells(pay, idx, runBal, many);
                const cp2 = pay.chitPicked==='Yes';
                const pickTag = cp2 ? ' <small style="background:#d1fae5;color:#065f46;border-radius:3px;padding:1px 4px;font-size:8px;font-weight:800;">🏆 Picked</small>' : '';
                if(idx===0){
                    const bulkTag = isBulk(pay) && Math.min.apply(null,slotsOf(pay))===i
                        ? ` <small style="background:#e0e7ff;color:#3730a3;border-radius:3px;padding:1px 4px;font-size:8px;font-weight:800;">×${slotsOf(pay).length} months bulk</small>` : '';
                    const manyTag = many ? ` <small style="background:#fef3c7;color:#92400e;border-radius:3px;padding:1px 4px;font-size:8px;font-weight:800;">${monthPayments.length} payments</small>` : '';
                    return `<tr style="background:${bg};${bl}">
                        <td style="text-align:center;color:#888;">${i+1}</td>
                        <td>${fmtDate(dueDate)}${bulkTag}${manyTag}</td>
                        <td style="text-align:center;color:#555;">Rs.${chitAmt>0?chitAmt.toLocaleString('en-IN'):'—'}</td>
                        <td style="text-align:center;">${c.date}</td>
                        <td style="text-align:center;color:#065f46;font-weight:700;">${c.paid}${pickTag}</td>
                        <td style="text-align:center;color:${(many?runBal:monthlyBalance)>0?'#92400e':'#065f46'};font-weight:700;">${money(many?runBal:monthlyBalance)}</td>
                        <td style="text-align:center;font-weight:700;color:${statusColor};">${many?'':status}</td>
                        <td style="text-align:center;color:#555;">${c.mode}</td>
                    </tr>`;
                }
                const last = idx===monthPayments.length-1;
                return `<tr style="background:${bg};border-left:3px solid #e0e7ff;">
                    <td style="text-align:center;color:#bbb;">└</td>
                    <td style="color:#999;font-size:9px;">Payment ${idx+1}</td>
                    <td style="text-align:center;color:#bbb;">—</td>
                    <td style="text-align:center;">${c.date}</td>
                    <td style="text-align:center;color:#065f46;font-weight:700;">${c.paid}${pickTag}</td>
                    <td style="text-align:center;color:${runBal>0?'#92400e':'#065f46'};font-weight:700;">${money(runBal)}</td>
                    <td style="text-align:center;font-weight:700;color:${statusColor};">${last?status:''}</td>
                    <td style="text-align:center;color:#555;">${c.mode}</td>
                </tr>`;
            }).join('');
        }).join('');

        return `<div class="grp-block" style="${indentStyle}border:1px solid #f39c12;background:#ffffff;padding:0;border-radius:2px;margin-bottom:6px;page-break-after:auto;box-shadow:none;">
            <table style="border:1px solid #f39c12;border-collapse:collapse;width:100%;">
                <colgroup><col style="width:4%"><col style="width:13%"><col style="width:12%"><col style="width:13%"><col style="width:13%"><col style="width:13%"><col style="width:13%"><col style="width:19%"></colgroup>
                <thead><tr style="background:#f5f5f5;border-bottom:1px solid #f39c12;"><th style="font-size:8px;font-weight:800;color:#333;border-right:1px solid #f39c12;padding:3px 2px;text-align:center;">#</th><th style="font-size:8px;font-weight:800;color:#333;border-right:1px solid #f39c12;padding:3px 2px;text-align:center;">Due Date</th><th style="font-size:8px;font-weight:800;color:#333;border-right:1px solid #f39c12;padding:3px 2px;text-align:center;">Chit/Mo</th><th style="font-size:8px;font-weight:800;color:#333;border-right:1px solid #f39c12;padding:3px 2px;text-align:center;">Pay Date</th><th style="font-size:8px;font-weight:800;color:#333;border-right:1px solid #f39c12;padding:3px 2px;text-align:center;">Paid</th><th style="font-size:8px;font-weight:800;color:#333;border-right:1px solid #f39c12;padding:3px 2px;text-align:center;">Balance</th><th style="font-size:8px;font-weight:800;color:#333;border-right:1px solid #f39c12;padding:3px 2px;text-align:center;">Status</th><th style="font-size:8px;font-weight:800;color:#333;padding:3px 2px;text-align:center;">Mode</th></tr></thead>
                <tbody>${rows}
                <tr style="background:#fff8e1;font-weight:800;border-top:1px solid #f39c12;font-size:9px;color:#333;">
                    <td colspan="4" style="text-align:center;padding:3px 2px;border-right:1px solid #f39c12;font-weight:800;">Total</td>
                    <td style="text-align:center;color:#065f46;font-weight:900;border-right:1px solid #f39c12;padding:3px 2px;">Rs.${gPaid.toLocaleString('en-IN')}</td>
                    <td style="text-align:center;color:#92400e;font-weight:900;border-right:1px solid #f39c12;padding:3px 2px;">Rs.${gBal.toLocaleString('en-IN')}</td>
                    <td colspan="2" style="text-align:center;"></td>
                </tr></tbody>
            </table>
        </div>`;
    }

    const groupSections = enrollments.map(enr=>{
        const g=gs.find(x=>x.id===enr.groupId); if(!g) return '';
        const qty=parseInt(enr.qty||1);
        const allPays=mPays.filter(p=>{
            if(enr.enrollmentId&&p.enrollmentId) return p.enrollmentId===enr.enrollmentId;
            return p.groupId===enr.groupId;
        }).sort((a,b)=>(a.date||'').localeCompare(b.date||''));
        const totalMonths=parseInt(g.duration||g.gDuration)||21;
        let elapsed=0;
        if(g.startDate||g.gStart){const _s=new Date(g.startDate||g.gStart),_n=new Date();elapsed=Math.max(0,Math.min(totalMonths,(_n.getFullYear()-_s.getFullYear())*12+(_n.getMonth()-_s.getMonth())+1));}
        const left=Math.max(0,totalMonths-elapsed);
        const pct=Math.min(100,Math.round(elapsed/totalMonths*100));
        let allDueDates=getGroupDueDates(g);
        // BUGFIX: If allDueDates is incomplete, regenerate using totalMonths
        if(!allDueDates || allDueDates.length < totalMonths){
            const start=g.startDate||g.gStart;
            const dueDay=parseInt(g.dueDay)||new Date(start).getDate();
            const s=new Date(start+'T00:00:00');
            const startYear=s.getFullYear();
            const startMonth=s.getMonth();
            const pad=n=>String(n).padStart(2,'0');
            allDueDates=[];
            for(let i=0;i<totalMonths;i++){
                const yr=startYear+Math.floor((startMonth+i)/12);
                const mo=(startMonth+i)%12;
                const maxDay=new Date(yr,mo+1,0).getDate();
                const day=Math.min(dueDay,maxDay);
                allDueDates.push(`${yr}-${pad(mo+1)}-${pad(day)}`);
            }
        }
        const gStartDisp=fmtDate(g.startDate||g.gStart||'');
        const gDueDayDisp=g.dueDay?`${g.dueDay}${['st','nd','rd'][((g.dueDay%100-11)%10)-1]||'th'} of month`:'—';
        
        // Calculate group totals for display
        const chitAmount=parseInt(enr.amount||g.amount||0);
        const gPaid=allPays.reduce((s,p)=>s+(parseFloat(p.paid)||0),0);
        const gBal=Math.max(0,chitAmount*qty-gPaid);
        const monthsCovered=allPays.reduce((s,p)=>s+(p.numMonths||1),0);

        if(qty<=1){
            const slotBlock = buildPrintSlot(g, enr, allPays, allDueDates, elapsed, totalMonths, left, pct, gStartDisp, gDueDayDisp, 1, 1);
            return slotBlock;
        } else {
            const slotBlocks = Array.from({length:qty},(_,i)=>{
                const sn=i+1;
                const slotPays=allPays.filter(p=> p.slotNum ? p.slotNum===sn : true);
                return buildPrintSlot(g, enr, slotPays, allDueDates, elapsed, totalMonths, left, pct, gStartDisp, gDueDayDisp, sn, qty);
            }).join('');
            return slotBlocks;
        }
    }).join('');

    const printHTML = `
    <div id="printStatement">
        <style>
            #printStatement { 
                font-family: Arial, sans-serif; 
                color: #111; 
                max-width: 800px; 
                margin: 0 auto; 
                padding: 6px; 
                font-size: 11px; 
                line-height: 1.3;
            }
            #printStatement .hdr { 
                display:flex; 
                justify-content:space-between; 
                align-items:flex-start; 
                border-bottom:2px solid #f39c12; 
                padding-bottom:4px; 
                margin-bottom:8px;
                padding-top: 2px;
            }
            #printStatement .brand { 
                font-size:18px; 
                font-weight:900; 
                color:#f39c12;
                letter-spacing:-0.5px;
            }
            #printStatement .brand-sub { 
                font-size:8px; 
                color:#666; 
                margin-top:1px; 
                font-weight:600; 
                letter-spacing:0px;
                text-transform: uppercase;
            }
            #printStatement .doc-title { 
                font-size:14px; 
                font-weight:900; 
                text-align:right; 
                color:#111; 
                letter-spacing:0.5px;
                text-transform: uppercase;
            }
            #printStatement .doc-sub { 
                font-size:8px; 
                color:#999; 
                text-align:right; 
                margin-top:1px; 
                font-weight:600;
            }
            #printStatement .mbox { 
                background:#f9f9f9; 
                border:1px solid #f39c12; 
                border-radius:2px; 
                padding:6px; 
                margin-bottom:6px;
                box-shadow: none;
            }
            #printStatement .mname { 
                font-size:13px; 
                font-weight:700; 
                color:#111; 
                margin-bottom:6px;
                line-height: 1.3;
            }
            #printStatement .msub { 
                display: none;
            }
            #printStatement .stats { display:flex; gap:0; margin-top:4px; border:1px solid #f39c12; border-radius:2px; overflow:hidden; width:100%; box-shadow: none; }
            #printStatement .stat { flex:1; border-right:1px solid #f39c12; padding:6px 4px; text-align:center; background:#ffffff; }
            #printStatement .stat:nth-child(1) .stat-v { color:#065f46; }
            #printStatement .stat:nth-child(2) .stat-v { color:#92400e; }
            #printStatement .stat:nth-child(3) .stat-v { color:#0891b2; }
            #printStatement .stat:nth-child(4) .stat-v { color:#065f46; }
            #printStatement .stat:last-child { border-right:none; }
            #printStatement .stat-v { font-size:13px; font-weight:900; display:block; margin-top:1px; }
            #printStatement .stat-l { font-size:7px; color:#666; text-transform:uppercase; margin-bottom:1px; font-weight:800; letter-spacing:0px; }
            #printStatement .sec-title { 
                font-size:10px; 
                font-weight:900; 
                color:#111; 
                text-transform:uppercase; 
                letter-spacing:0.5px; 
                margin:6px 0 4px; 
                border-bottom:1px solid #f39c12; 
                padding-bottom:3px;
                padding-left: 2px;
            }
            #printStatement table tbody tr:nth-child(odd) { background:#ffffff; }
            #printStatement table tbody tr:nth-child(even) { background:#f9f9f9; }
            #printStatement table tbody tr.paid { background:#f0fdf4; }
            #printStatement table tbody tr.pending { background:#fffbf0; }
            #printStatement table tbody tr.partial { background:#fef3c7; }
            #printStatement .grp-block { margin-bottom:12px; page-break-inside:avoid; }
            #printStatement .grp-block + .grp-block { page-break-before:auto; margin-top:8px; }
            #printStatement .grp-block:nth-child(odd) { background:#ffffff; }
            #printStatement .grp-block:nth-child(even) { background:#f9f9f9; }
            #printStatement .grp-title { font-size:12px; font-weight:800; margin-bottom:3px; }
            #printStatement .grp-meta { font-size:10px; color:#666; margin-bottom:4px; line-height:1.4; }
            #printStatement .grp-totals { 
                font-size: 10px; 
                text-align: right; 
                margin-bottom: 6px; 
                padding: 6px 8px;
                background: #f0fdf4;
                border: 1px solid #dcfce7;
                border-radius: 3px; 
                font-weight: 800;
                color: #111;
            }
            #printStatement > div:not(.print-btn-bar):not(.hdr):not(.mbox):not(.sec-title):not(.ftr) { 
                margin-bottom: 8px;
                page-break-inside: auto !important;
                padding-bottom: 6px;
                border-bottom: 1px solid #eee;
            }
            #printStatement > div:not(.print-btn-bar):not(.hdr):not(.mbox):not(.sec-title):not(.ftr):last-of-type {
                border-bottom: none;
            }
            #printStatement .prog-outer { background:#e5e5e5; height:4px; border-radius:1px; margin-bottom:3px; overflow:hidden; border:none; }
            #printStatement .prog-inner { height:100%; background:linear-gradient(90deg,#f39c12,#f57c00); border-radius:2px; }
            #printStatement table { width:100%; border-collapse:collapse; font-size:9px; table-layout:auto; margin-bottom:3px; border:1px solid #f39c12; }
            #printStatement thead { display:table-header-group; }
            #printStatement th { background:#f5f5f5; border-bottom:1px solid #f39c12; border-right:1px solid #f39c12; padding:4px 3px; font-size:8px; text-transform:uppercase; color:#333; font-weight:800; letter-spacing:0px; }
            #printStatement th:last-child { border-right:none; }
            #printStatement td { border-bottom:1px solid #e0e0e0; padding:4px 3px; vertical-align:middle; word-break:break-word; font-size:9px; }
            #printStatement tbody tr:nth-child(odd) td { background:#ffffff; }
            #printStatement tbody tr:nth-child(even) td { background:#fafafa; }
            #printStatement tbody tr:last-child td { background:#fff8e1 !important; border-top:1px solid #f39c12; font-weight:800; }
            #printStatement tr { page-break-inside:avoid; }
            #printStatement .ftr { margin-top:6px; border-top:1px solid #f39c12; border-bottom:none; padding-top:3px; padding-bottom:2px; display:flex; justify-content:space-between; font-size:7px; color:#999; font-weight:600; }
            #printStatement .print-btn-bar { display:flex; gap:10px; margin-bottom:16px; }
            #printStatement .print-btn { background:linear-gradient(90deg,#f39c12,#f57c00); color:#000; border:none; padding:10px 24px; border-radius:10px; font-weight:800; font-size:14px; cursor:pointer; }
            #printStatement .close-btn { background:#eee; color:#333; border:none; padding:10px 18px; border-radius:10px; font-weight:700; font-size:14px; cursor:pointer; }
            @media print {
                * { margin:0 !important; padding:0 !important; }
                html, body { width:100% !important; height:100% !important; background:white !important; }
                body > * { display:none !important; }
                #printOverlay { 
                    position:static !important; 
                    top:0 !important; 
                    left:0 !important; 
                    width:100% !important; 
                    height:auto !important; 
                    background:white !important; 
                    z-index:99999 !important; 
                    padding:0 !important; 
                    margin:0 !important;
                    overflow:visible !important;
                    display:block !important;
                }
                #printStatement { 
                    max-width:100% !important; 
                    padding:10px !important; 
                    margin:0 !important;
                    width:100% !important;
                    -webkit-print-color-adjust: exact !important;
                    print-color-adjust: exact !important;
                    color-adjust: exact !important;
                }
                /* Force all colors and backgrounds to print */
                #printStatement * {
                    -webkit-print-color-adjust: exact !important;
                    print-color-adjust: exact !important;
                    color-adjust: exact !important;
                }
                #printStatement .print-btn-bar { 
                    display:none !important; 
                    visibility:hidden !important; 
                    width:0 !important; 
                    height:0 !important; 
                    margin:0 !important; 
                    padding:0 !important; 
                }
                #printStatement .print-btn { display:none !important; }
                #printStatement .close-btn { display:none !important; }
                #printStatement .hdr { page-break-inside:avoid !important; }
                #printStatement .mbox { page-break-inside:avoid !important; }
                #printStatement .sec-title { 
                    page-break-after:avoid !important; 
                    background: #fef3c7 !important;
                    border-bottom: 3px solid #f39c12 !important;
                }
                #printStatement .grp-block { 
                    page-break-inside:avoid !important; 
                    margin-bottom: 28px !important;
                    background: #ffffff !important;
                    border: 1px solid #d0d0d0 !important;
                    padding: 16px !important;
                    box-shadow: 0 1px 3px rgba(0,0,0,0.08) !important;
                }
                #printStatement .grp-title {
                    border-bottom: 1px solid #e5e5e5 !important;
                    padding-bottom: 8px !important;
                }
                #printStatement .grp-title span:last-child {
                    background: #f39c12 !important;
                    color: white !important;
                    border-radius: 5px !important;
                    padding: 5px 12px !important;
                }
                #printStatement .grp-meta {
                    background: #f9f9f9 !important;
                    border-left: 4px solid #f39c12 !important;
                    padding: 10px 12px !important;
                    margin: 12px 0 10px 0 !important;
                }
                #printStatement .prog-outer {
                    background: #e5e5e5 !important;
                    height: 7px !important;
                }
                #printStatement .prog-inner {
                    background: linear-gradient(90deg, #f39c12, #f57c00) !important;
                    height: 100% !important;
                }
                #printStatement .grp-totals {
                    background: linear-gradient(135deg, #f0fdf4 0%, #dbeafe 100%) !important;
                    border: 1px solid #dcfce7 !important;
                    padding: 12px !important;
                    font-weight: 800 !important;
                    color: #111 !important;
                }
                /* Group header for multiple chits */
                #printStatement > div > div:nth-child(1) {
                    background: #fef3c7 !important;
                    border-left: 6px solid #f39c12 !important;
                    padding: 14px 16px !important;
                    margin-bottom: 24px !important;
                }
                #printStatement > div > div:nth-child(1) span:last-child {
                    background: #f39c12 !important;
                    color: white !important;
                    border-radius: 4px !important;
                    padding: 5px 12px !important;
                }
                #printStatement > div > div > div { 
                    page-break-inside:auto !important; 
                    display:block !important;
                    visibility:visible !important;
                }
                #printStatement table { 
                    table-layout:auto !important; 
                    width:100% !important; 
                    page-break-inside:auto !important;
                    margin-bottom:8mm !important;
                    border: 1px solid #e0e0e0 !important;
                    border-collapse: collapse !important;
                }
                #printStatement thead {
                    display: table-header-group !important;
                }
                #printStatement th {
                    background: #f5f5f5 !important;
                    border-bottom: 2px solid #f39c12 !important;
                    padding: 9px 8px !important;
                    color: #333 !important;
                    font-weight: 800 !important;
                }
                #printStatement tbody tr:nth-child(odd) td {
                    background: #ffffff !important;
                }
                #printStatement tbody tr:nth-child(even) td {
                    background: #f9f9f9 !important;
                }
                #printStatement tbody tr:last-child td {
                    background: #fff8e1 !important;
                    border-bottom: 1px solid #f39c12 !important;
                    font-weight: 800 !important;
                }
                #printStatement td {
                    border-bottom: 1px solid #e0e0e0 !important;
                    padding: 8px 7px !important;
                }
                #printStatement .ftr { page-break-inside:avoid !important; }
                @page { 
                    size:A4; 
                    margin:12mm 10mm; 
                }
            }
        </style>
        <div class="print-btn-bar">
            <button class="print-btn" onclick="window.print()">🖨️ Print / Save as PDF</button>
            <button class="close-btn" onclick="closePrintStatement()">✕ Close</button>
        </div>
        <div class="hdr">
            <div style="display:flex;align-items:center;gap:10px;"><img src="logo.png" style="width:48px;height:48px;border-radius:10px;object-fit:cover;" onerror="this.style.display='none';this.nextElementSibling.style.display='block'"><span style="display:none;font-size:22px;">🏆</span><div><div class="brand">AK CHIT FUNDS</div><div class="brand-sub">Chit Fund Management &bull; Member Statement</div></div></div>
            <div><div class="doc-title">MEMBER STATEMENT</div><div class="doc-sub">Generated: ${today}</div></div>
        </div>
        <div class="mbox">
            <div class="mname">${m.name} • &#128222; ${m.phone||'—'} • ${enrollments.map(e=>{const g=gs.find(x=>x.id===e.groupId);const q=parseInt(e.qty||1);return g?(g.name+(e.label?' ('+e.label+')':'')+(q>1?' ×'+q:'')):'?';}).join(', ')||'—'}</div>
            <div class="stats">
                <div class="stat"><div class="stat-l">Total Paid</div><div class="stat-v" style="color:#065f46;">Rs.${totalPaid.toLocaleString('en-IN')}</div></div>
                <div class="stat"><div class="stat-l">Start &rarr; End</div><div class="stat-v" style="color:#0891b2;font-size:11px;">${startDateDisp} &rarr; ${endDateDisp}</div></div>
                <div class="stat"><div class="stat-l">Paid / Total Months</div><div class="stat-v" style="color:#065f46;font-size:11px;">${enrollments.length > 0 ? (() => {let totalMonths=0,paidMonths=0; enrollments.forEach(e=>{const g=gs.find(x=>x.id===e.groupId);if(g){const tm=parseInt(g.duration||g.gDuration)||21;totalMonths=Math.max(totalMonths,tm);const gPays=mPays.filter(p=>p.enrollmentId===e.enrollmentId||p.groupId===e.groupId);const uniqueMonths=new Set();gPays.forEach(p=>{if(p.monthSlot!=null){uniqueMonths.add(p.monthSlot);}else if(Array.isArray(p.monthSlots)){p.monthSlots.forEach(m=>uniqueMonths.add(m));}});paidMonths=Math.max(paidMonths,uniqueMonths.size);}});return paidMonths+'/'+totalMonths;})() : '0/0'}</div></div>
                <div class="stat"><div class="stat-l">Chit Picked</div><div class="stat-v" style="color:${chitPickedChipColor};font-size:11px;">${chitPickedChipVal}</div></div>
            </div>
        </div>
        <div class="sec-title">Payment History &mdash; Group Wise</div>
        ${groupSections||'<p style="color:#888;font-size:10px;">No payments recorded.</p>'}
        <div class="ftr">
            <span>AK Chit Funds &bull; Admin Portal</span>
            <span>Member: ${m.name} &bull; ${today}</span>
            <span>CONFIDENTIAL</span>
        </div>
    </div>`;

    if(opts.returnHtml) return printHTML;

    let overlay = document.getElementById('printOverlay');
    if(!overlay){
        overlay = document.createElement('div');
        overlay.id = 'printOverlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:white;z-index:99999;overflow-y:auto;padding:16px;';
        document.body.appendChild(overlay);
    }
    overlay.innerHTML = printHTML;
    overlay.style.display = 'block';
    showToast('✅ Statement ready — tap Print', true);
}

function closePrintStatement(){
    const el = document.getElementById('printOverlay');
    if(el) el.style.display = 'none';
}

async function generateMemberPDF(mid){ return printMemberStatement(mid); }

async function generateGroupPDF(gid){
    showToast('⏳ Preparing group report…', true);
    const gs = await getCollection('groups');
    const ms = await getCollection('members');
    const ps = await getCollection('payments');
    const g  = gs.find(x => x.id === gid);
    if(!g){ showToast('❌ Group not found', false); return; }

    const gPays = ps.filter(p => p.groupId === gid);
    const tPaid = gPays.reduce((s,p) => s + (parseFloat(p.paid)||0), 0);
    const totalMonths = parseInt(g.duration || g.gDuration) || 21;
    const monthlyAmt = parseFloat(g.monthly || g.gMonthly) || 0;
    const totalChitNeeded = monthlyAmt * totalMonths;
    const tBal = Math.max(0, totalChitNeeded - tPaid);
    const picked = gPays.filter(p => p.chitPicked === 'Yes').length;
    let elapsed = 0;
    if(g.startDate || g.gStart){
        const _s = new Date(g.startDate || g.gStart), _n = new Date();
        elapsed = Math.max(0, Math.min(totalMonths, (_n.getFullYear()-_s.getFullYear())*12 + (_n.getMonth()-_s.getMonth()) + 1));
    }
    const pct  = Math.min(100, Math.round(elapsed / totalMonths * 100));
    let allDueDates = getGroupDueDates(g);
    // BUGFIX: If allDueDates is incomplete, regenerate using totalMonths
    if(!allDueDates || allDueDates.length < totalMonths){
        const start=g.startDate||g.gStart;
        const dueDay=parseInt(g.dueDay)||new Date(start).getDate();
        const s=new Date(start+'T00:00:00');
        const startYear=s.getFullYear();
        const startMonth=s.getMonth();
        const pad=n=>String(n).padStart(2,'0');
        allDueDates=[];
        for(let i=0;i<totalMonths;i++){
            const yr=startYear+Math.floor((startMonth+i)/12);
            const mo=(startMonth+i)%12;
            const maxDay=new Date(yr,mo+1,0).getDate();
            const day=Math.min(dueDay,maxDay);
            allDueDates.push(`${yr}-${pad(mo+1)}-${pad(day)}`);
        }
    }
    const gStartDisp  = fmtDate(g.startDate || g.gStart || '');
    const gDueDayDisp = g.dueDay ? `${g.dueDay}${['st','nd','rd'][((g.dueDay%100-11)%10)-1]||'th'} of every month` : '—';
    const today = new Date().toLocaleDateString('en-IN',{day:'2-digit',month:'long',year:'numeric'});

    const gMs = ms.filter(m => (m.enrollments||[]).some(e=>e.groupId===g.id) || (m.groupIds||[]).includes(g.id));
    const expandedSlots = [];
    gMs.forEach(m => {
        const enr = (m.enrollments||[]).find(e=>e.groupId===g.id);
        const qty = enr ? parseInt(enr.qty||1) : 1;
        for(let q=0; q<qty; q++) expandedSlots.push({m, slotNum:q+1, totalSlots:qty});
    });

    // Chit-picked info (replaces the removed Balance chip, and the removed
    // Chit Picked column in the summary table) — who picked, when, and the payout.
    const pickedEntries = expandedSlots.map(({m, slotNum, totalSlots}) => {
        const mp = ps.filter(p => p.memberId===m.id && p.groupId===g.id);
        const pickedPay = mp.find(p=>p.chitPicked==='Yes');
        if(!pickedPay) return null;
        const slotLabel = totalSlots>1 ? ` (Chit ${slotNum}/${totalSlots})` : '';
        return { name: m.name+slotLabel, amount: (parseFloat(pickedPay.chit)||0)*(parseInt(pickedPay.numMonths)||1), by: pickedPay.chitPickedBy||'', date: pickedPay.date };
    }).filter(Boolean);
    const pickedInfoHtml = pickedEntries.length
        ? pickedEntries.map(e=>`<span style="display:inline-block;background:#f0fff8;border:1px solid #34d399;border-radius:4px;padding:2px 6px;margin:2px 3px 2px 0;font-size:8.5px;"><b>${e.name}</b> — ₹${e.amount.toLocaleString('en-IN')}${e.by?` (${e.by})`:''}</span>`).join('')
        : '<span style="font-size:9px;color:#888;">No chits picked yet</span>';

    const summaryRows = expandedSlots.map(({m, slotNum, totalSlots}, i) => {
        const mp = ps.filter(p => p.memberId===m.id && p.groupId===g.id);
        const paid = mp.reduce((s,p)=>s+(parseFloat(p.paid)||0),0);
        const bal  = mp.reduce((s,p)=>s+(parseFloat(p.balance)||0),0);
        const monthsCovered = mp.reduce((s,p)=>s+(p.numMonths||1),0);
        const pickedPay = mp.find(p=>p.chitPicked==='Yes');
        const lastPay = mp.length ? mp.sort((a,b)=>b.date.localeCompare(a.date))[0].date : '';
        const slotLabel = totalSlots>1 ? ` <span style="background:#fef3c7;color:#92400e;border-radius:3px;padding:1px 4px;font-size:9px;font-weight:800;">Chit ${slotNum}/${totalSlots}</span>` : '';
        const bg = pickedPay ? '#f0fff8' : (i%2===0?'#f9fafb':'#fff');
        const bl = pickedPay ? 'border-left:3px solid #10b981;' : '';
        return `<tr style="background:${bg};${bl}">
            <td style="text-align:center;color:#888;font-weight:800;">${i+1}</td>
            <td><strong>${m.name}</strong>${slotLabel}<br><span style="font-size:9px;color:#888;">${m.phone||''}</span></td>
            <td style="color:#065f46;font-weight:700;">₹${paid.toLocaleString('en-IN')}</td>
            <td style="color:${bal>0?'#92400e':'#065f46'};font-weight:700;">₹${bal.toLocaleString('en-IN')}</td>
            <td style="text-align:center;">${monthsCovered}/${totalMonths}</td>
            <td style="color:#888;">${lastPay?fmtDate(lastPay):'—'}</td>
        </tr>`;
    }).join('');

    const detailSections = expandedSlots.map(({m, slotNum, totalSlots}) => {
        const mp = ps.filter(p => p.memberId===m.id && p.groupId===g.id)
                     .sort((a,b)=>(a.date||'').localeCompare(b.date||''));
        if(!mp.length) return '';
        const mPaid = mp.reduce((s,p)=>s+(parseFloat(p.paid)||0),0);
        const mBal  = mp.reduce((s,p)=>s+(parseFloat(p.balance)||0),0);
        const slotBadge = totalSlots>1 ? ` <span style="background:#fef3c7;color:#92400e;border-radius:3px;padding:1px 5px;font-size:9px;font-weight:800;">Chit ${slotNum}/${totalSlots}</span>` : '';
        const rows = mp.map((p,idx) => {
            const isMulti = p.numMonths && p.numMonths > 1;
            let monthLabel = '—';
            if(isMulti && p.monthSlots && p.monthSlots.length>0){
                const f = allDueDates[p.monthSlots[0]] ? fmtDate(allDueDates[p.monthSlots[0]]) : '—';
                const l = allDueDates[p.monthSlots[p.monthSlots.length-1]] ? fmtDate(allDueDates[p.monthSlots[p.monthSlots.length-1]]) : '—';
                monthLabel = `${f} → ${l}`;
            } else {
                const si = p.monthSlot !== undefined ? p.monthSlot : getMonthSlot(allDueDates, p.date);
                monthLabel = si>=0 && allDueDates[si] ? fmtDate(allDueDates[si]) : '—';
            }
            const cp = p.chitPicked === 'Yes';
            const bg = cp ? '#f0fff8' : (isMulti ? '#eef2ff' : (idx%2===0?'#f9fafb':'#fff'));
            return `<tr style="background:${bg};">
                <td style="text-align:center;color:#888;">${idx+1}</td>
                <td>${monthLabel}${isMulti?` <span style="background:#e0e7ff;color:#3730a3;border-radius:3px;padding:1px 4px;font-size:9px;">${p.numMonths}mo</span>`:''}</td>
                <td>${fmtDate(p.date)}</td>
                <td>₹${(parseFloat(p.chit)||0).toLocaleString('en-IN')}${isMulti?`/mo×${p.numMonths}`:''}</td>
                <td style="color:#065f46;font-weight:700;">Rs.${(parseFloat(p.paid)||0).toLocaleString('en-IN')}</td>
                <td style="color:${(parseFloat(p.balance)||0)>0?'#92400e':'#065f46'};font-weight:700;min-width:40px;">Rs.${(parseFloat(p.balance)||0).toLocaleString('en-IN')}</td>
                <td style="color:#888;">${normalizePaidBy(p.paidBy)}</td>
                <td style="text-align:center;">${cp?'<span style="color:#065f46;font-weight:800;">✅</span>':'—'}</td>
            </tr>`;
        }).join('');
        return `<div style="margin-bottom:8px;page-break-inside:avoid;">
            <div style="background:#f5f5f5;border-left:4px solid #f39c12;padding:5px 8px;font-size:11px;font-weight:800;margin-bottom:3px;">
                👤 ${m.name}${slotBadge} &nbsp;<span style="font-size:9px;color:#888;font-weight:400;">${m.phone||''}</span>
                <span style="float:right;font-size:10px;">Paid: <b style="color:#065f46;">₹${mPaid.toLocaleString('en-IN')}</b> &nbsp; Bal: <b style="color:#92400e;">₹${mBal.toLocaleString('en-IN')}</b></span>
            </div>
            <table style="border:1px solid #f39c12;border-collapse:collapse;width:100%;">
                <colgroup><col style="width:4%"><col style="width:13%"><col style="width:13%"><col style="width:12%"><col style="width:14%"><col style="width:14%"><col style="width:15%"><col style="width:15%"></colgroup>
                <thead><tr style="background:#f5f5f5;border-bottom:1px solid #f39c12;"><th style="border-right:1px solid #f39c12;font-weight:800;">​#</th><th style="border-right:1px solid #f39c12;font-weight:800;">Month Covered</th><th style="border-right:1px solid #f39c12;font-weight:800;">Pay Date</th><th style="border-right:1px solid #f39c12;font-weight:800;">Chit Amt</th><th style="border-right:1px solid #f39c12;font-weight:800;">Paid</th><th style="border-right:1px solid #f39c12;font-weight:800;">Balance</th><th style="border-right:1px solid #f39c12;font-weight:800;">Mode</th><th style="font-weight:800;">Chit?</th></tr></thead>
                <tbody>${rows}
                <tr style="background:#fff8e1;font-weight:800;border-top:1px solid #f39c12;">
                    <td colspan="4" style="border-right:1px solid #f39c12;">Total</td>
                    <td style="color:#065f46;font-weight:900;border-right:1px solid #f39c12;">₹${mPaid.toLocaleString('en-IN')}</td>
                    <td style="color:#92400e;font-weight:900;border-right:1px solid #f39c12;">₹${mBal.toLocaleString('en-IN')}</td>
                    <td colspan="2"></td>
                </tr></tbody>
            </table>
        </div>`;
    }).join('');

    const printHTML = `<div id="groupPrintDoc">
    <style>
        #groupPrintDoc { font-family:Arial,sans-serif; color:#111; max-width:860px; margin:0 auto; padding:10px; }
        #groupPrintDoc .hdr { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:3px solid #f39c12; padding-bottom:6px; margin-bottom:8px; page-break-inside:avoid; }
        #groupPrintDoc .brand { font-size:16px; font-weight:900; color:#f39c12; }
        #groupPrintDoc .info-box { background:#fffbf0; border:2px solid #f39c12; border-radius:8px; padding:8px 12px; margin-bottom:8px; page-break-inside:avoid; }
        #groupPrintDoc .chips { display:flex; gap:0; border:1px solid #e5c76b; border-radius:8px; overflow:hidden; margin-top:6px; }
        #groupPrintDoc .chip { flex:1; padding:5px; text-align:center; border-right:1px solid #e5c76b; }
        #groupPrintDoc .chip:last-child { border-right:none; }
        #groupPrintDoc .chip-v { font-size:14px; font-weight:800; }
        #groupPrintDoc .chip-l { font-size:9px; color:#888; text-transform:uppercase; margin-top:2px; }
        #groupPrintDoc .prog-outer { background:#eee; height:5px; border-radius:3px; margin:5px 0 3px; overflow:hidden; }
        #groupPrintDoc .prog-inner { height:100%; background:linear-gradient(90deg,#f39c12,#f57c00); border-radius:3px; }
        #groupPrintDoc .sec-title { font-size:8px; font-weight:800; color:#111; text-transform:uppercase; letter-spacing:1px; margin:10px 0 4px; border-bottom:3px solid #f39c12; padding-bottom:3px; page-break-after:avoid; }
        #groupPrintDoc table { width:100%; border-collapse:collapse; font-size:10px; table-layout:fixed; margin-bottom:5px; page-break-inside:avoid; border:1px solid #e0e0e0; }
        #groupPrintDoc thead { display:table-header-group; background:#f5f5f5; }
        #groupPrintDoc th { background:#f5f5f5; border-bottom:2px solid #f39c12; padding:5px 5px; font-size:9px; text-transform:uppercase; color:#555; font-weight:800; letter-spacing:0.3px; }
        #groupPrintDoc td { border-bottom:1px solid #e0e0e0; padding:5px 5px; vertical-align:middle; word-break:break-word; overflow-wrap:break-word; }
        #groupPrintDoc tbody tr:last-child td { border-bottom:2px solid #f39c12; font-weight:700; }
        #groupPrintDoc tr { page-break-inside:avoid; page-break-after:auto; }
        #groupPrintDoc .stats { display:flex; gap:6px; margin-top:6px; page-break-inside:avoid; }
        #groupPrintDoc .stat { flex:1; border:1px solid #ddd; border-radius:6px; padding:4px; text-align:center; page-break-inside:avoid; }
        #groupPrintDoc .stat-v { font-size:13px; font-weight:800; }
        #groupPrintDoc .stat-l { font-size:8px; color:#888; text-transform:uppercase; }
        #groupPrintDoc .ftr { margin-top:8px; border-top:2px solid #f39c12; padding-top:4px; display:flex; justify-content:space-between; font-size:8px; color:#555; font-weight:600; page-break-inside:avoid; }
        #groupPrintDoc .print-btn-bar { display:flex; gap:10px; margin-bottom:16px; }
        #groupPrintDoc .print-btn { background:linear-gradient(90deg,#f39c12,#f57c00); color:#000; border:none; padding:10px 24px; border-radius:10px; font-weight:800; font-size:14px; cursor:pointer; }
        #groupPrintDoc .close-btn { background:#eee; color:#333; border:none; padding:10px 18px; border-radius:10px; font-weight:700; font-size:14px; cursor:pointer; }
        @media print {
            * { margin:0 !important; padding:0 !important; }
            html, body { width:100% !important; height:100% !important; background:white !important; }
            body > * { display:none !important; }
            #printOverlay { 
                position:static !important; 
                top:0 !important; 
                left:0 !important; 
                width:100% !important; 
                height:auto !important; 
                background:white !important; 
                z-index:99999 !important; 
                padding:0 !important; 
                margin:0 !important;
                overflow:visible !important;
                display:block !important;
            }
            #groupPrintDoc { 
                max-width:100% !important; 
                padding:8px !important; 
                margin:0 !important;
                width:100% !important;
                -webkit-print-color-adjust: exact !important;
                print-color-adjust: exact !important;
                color-adjust: exact !important;
            }
            #groupPrintDoc * {
                -webkit-print-color-adjust: exact !important;
                print-color-adjust: exact !important;
                color-adjust: exact !important;
            }
            #groupPrintDoc .print-btn-bar { 
                display:none !important; 
                visibility:hidden !important; 
                width:0 !important; 
                height:0 !important; 
                margin:0 !important; 
                padding:0 !important; 
            }
            #groupPrintDoc .print-btn { display:none !important; }
            #groupPrintDoc .close-btn { display:none !important; }
            #groupPrintDoc .hdr { page-break-inside:avoid !important; }
            #groupPrintDoc .info-box { page-break-inside:avoid !important; }
            #groupPrintDoc .sec-title { 
                page-break-after:avoid !important;
                background: #fef3c7 !important;
                border-bottom: 3px solid #f39c12 !important;
            }
            #groupPrintDoc table { 
                table-layout:fixed !important; 
                width:100% !important; 
                page-break-inside:avoid !important;
                margin-bottom:5mm !important;
                border: 1px solid #e0e0e0 !important;
                border-collapse: collapse !important;
            }
            #groupPrintDoc thead {
                display: table-header-group !important;
            }
            #groupPrintDoc th {
                background: #f5f5f5 !important;
                border-bottom: 2px solid #f39c12 !important;
                padding: 5px 5px !important;
                color: #333 !important;
                font-weight: 800 !important;
            }
            #groupPrintDoc tbody tr:nth-child(odd) td {
                background: #ffffff !important;
            }
            #groupPrintDoc tbody tr:nth-child(even) td {
                background: #f9f9f9 !important;
            }
            #groupPrintDoc tbody tr:last-child td {
                background: #fff8e1 !important;
                border-bottom: 1px solid #f39c12 !important;
                font-weight: 800 !important;
            }
            #groupPrintDoc td {
                border-bottom: 1px solid #e0e0e0 !important;
                padding: 5px 5px !important;
            }
            #groupPrintDoc tr { 
                page-break-inside:avoid !important; 
                page-break-after:auto !important; 
            }
            #groupPrintDoc .ftr { page-break-inside:avoid !important; }
            @page { size:A4; margin:10mm 8mm; }
        }
    </style>
    <div class="print-btn-bar">
        <button class="print-btn" onclick="window.print()">🖨️ Print / Save as PDF</button>
        <button class="close-btn" onclick="closePrintStatement()">✕ Close</button>
    </div>
    <div class="hdr">
        <div>
            <div style="display:flex;align-items:center;gap:10px;"><img src="logo.png" style="width:48px;height:48px;border-radius:10px;object-fit:cover;" onerror="this.style.display='none';this.nextElementSibling.style.display='block'"><span style="display:none;font-size:22px;">🏆</span><div class="brand">AK CHIT FUNDS</div></div>
            <div style="font-size:9px;color:#888;">Chit Fund Management &bull; Group Report</div>
        </div>
        <div style="text-align:right;">
            <div style="font-size:14px;font-weight:800;">GROUP STATEMENT</div>
            <div style="font-size:9px;color:#888;">Generated: ${today}</div>
        </div>
    </div>
    <div class="info-box">
        <div style="font-size:18px;font-weight:900;margin-bottom:6px;">📂 ${g.name}</div>
        <div style="font-size:10px;color:#555;">Started: <b>${gStartDisp}</b> &nbsp;·&nbsp; Due: <b>${gDueDayDisp}</b> &nbsp;·&nbsp; Duration: <b>${totalMonths} months</b></div>
        <div class="prog-outer"><div class="prog-inner" style="width:${pct}%"></div></div>
        <div style="display:flex;justify-content:space-between;font-size:9px;color:#888;margin-bottom:8px;">
            <span>Month ${elapsed}/${totalMonths} (${pct}% complete)</span>
            <span>${left} months pending</span>
        </div>
        <div class="stats">
            <div class="stat"><div class="stat-v" style="color:#065f46;">₹${tPaid.toLocaleString('en-IN')}</div><div class="stat-l">Total Collected</div></div>
            <div class="stat"><div class="stat-v">${expandedSlots.length}</div><div class="stat-l">Members</div></div>
            <div class="stat"><div class="stat-v" style="color:#065f46;">${picked}</div><div class="stat-l">Chits Picked</div></div>
            <div class="stat"><div class="stat-v">${gPays.length}</div><div class="stat-l">Payments</div></div>
        </div>
        <div style="margin-top:6px;">
            <div style="font-size:8px;font-weight:800;color:#92400e;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px;">🎯 Chit Picked</div>
            ${pickedInfoHtml}
        </div>
    </div>
    <div class="sec-title">Member Summary</div>
    <table>
        <colgroup><col style="width:5%"><col style="width:26%"><col style="width:18%"><col style="width:18%"><col style="width:13%"><col style="width:20%"></colgroup>
        <thead><tr><th>#</th><th>Member</th><th>Total Paid</th><th>Balance</th><th>Months</th><th>Last Payment</th></tr></thead>
        <tbody>${summaryRows}
        <tr style="background:#fff8e1;font-weight:800;border-top:2px solid #f39c12;">
            <td colspan="2">Grand Total</td>
            <td style="color:#065f46;">₹${tPaid.toLocaleString('en-IN')}</td>
            <td style="color:#92400e;">₹${tBal.toLocaleString('en-IN')}</td>
            <td colspan="2"></td>
        </tr></tbody>
    </table>
    <div class="sec-title" style="margin-top:20px;">Detailed Payment History — Member Wise</div>
    ${detailSections || '<p style="color:#888;font-size:10px;">No payments recorded.</p>'}
    <div class="ftr">
        <span>AK Chit Funds &bull; Admin Portal</span>
        <span>Group: ${g.name} &bull; ${today}</span>
        <span>CONFIDENTIAL</span>
    </div>
    </div>`;

    let overlay = document.getElementById('printOverlay');
    if(!overlay){
        overlay = document.createElement('div');
        overlay.id = 'printOverlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:white;z-index:99999;overflow-y:auto;padding:16px;';
        document.body.appendChild(overlay);
    }
    overlay.innerHTML = printHTML;
    overlay.style.display = 'block';
    showToast('✅ Group report ready — tap Print', true);
}

// ══════════════════════════════════════════
