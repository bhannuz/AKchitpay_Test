// ═══════════════════════════════════════════════════════════
// AK Chit Funds — PAYMENTS
// ═══════════════════════════════════════════════════════════

// MULTI-MONTH HELPERS
// ══════════════════════════════════════════
async function getPaidSlots(memberId, groupId, group, enrollmentId, slotNum){
    const allDueDates=getGroupDueDates(group);
    const ps=await getCollection('payments');
    // Scope to specific slot — never mix slots
    // Matches: new payments (by enrollmentId) OR old payments (no enrollmentId, matched by slotNum)
    const mPays=ps.filter(p=>{
        if(p.memberId!==memberId||p.groupId!==groupId) return false;
        // If slotNum is provided (multi-slot group), ALWAYS filter by slot
        // to prevent one slot's payments leaking into another
        if(slotNum){
            const pSlot = p.slotNum ? Number(p.slotNum) : 1; // default old payments to slot 1
            const mySlot = Number(slotNum);
            if(pSlot !== mySlot) return false;
        }
        // Within same slot: further narrow by enrollmentId if both sides have it
        if(enrollmentId && p.enrollmentId && p.enrollmentId!==''){
            return p.enrollmentId === enrollmentId;
        }
        return true;
    });
    const paidSlots=new Set();
    mPays.forEach(p=>{
        if(Array.isArray(p.monthSlots)) p.monthSlots.forEach(s=>paidSlots.add(s));
        else if(p.monthSlot!==undefined&&p.monthSlot!==null) paidSlots.add(p.monthSlot);
        else { const slot=getMonthSlot(allDueDates,p.date); if(slot>=0) paidSlots.add(slot); }
    });
    return {paidSlots, allDueDates};
}

// Check if a specific slot already has chitPicked=Yes — slot-isolated
async function isChitAlreadyPicked(ps, memberId, groupId, enrollmentId, slotNum){
    return ps.some(p => {
        if(p.chitPicked !== 'Yes') return false;
        if(p.memberId !== memberId || p.groupId !== groupId) return false;
        // Primary: slotNum match (most reliable, always present on new payments)
        const pSlot = p.slotNum ? Number(p.slotNum) : 1;
        const mySlot = Number(slotNum) || 1;
        if(pSlot !== mySlot) return false;
        // Secondary: if both have enrollmentId, they must match
        if(enrollmentId && p.enrollmentId && p.enrollmentId !== ''){
            return p.enrollmentId === enrollmentId;
        }
        return true;
    });
}


function getSelectedMonthSlots(){
    return Array.from(document.querySelectorAll('#monthSelectorGrid input[type=checkbox]:checked:not(:disabled)')).map(cb=>parseInt(cb.value));
}

// ══════════════════════════════════════════
// SINGLE MONTH SELECTOR — dropdown of all months
// ══════════════════════════════════════════
window._singleMonthPaidSlots = new Set();

async function buildSingleMonthDropdown(){
    const mid=document.getElementById('pMember').value;
    const gid=document.getElementById('pGroup').value;
    const wrap=document.getElementById('singleMonthDropdownWrap');
    const sel=document.getElementById('pSingleMonthSlot');
    const badge=document.getElementById('singleMonthBadge');
    window._singleMonthPaidSlots=new Set();
    sel.innerHTML='<option value="">-- Select Month --</option>';
    badge.style.display='none';
    if(!mid||!gid){wrap.style.display='none';return;}
    const gs=await getCollection('groups');
    const grp=gs.find(g=>g.id===gid);
    if(!grp){wrap.style.display='none';return;}
    const eid=document.getElementById('pEnrollmentId').value||'';
    const sn=parseInt(document.getElementById('pSlotNum').value||'1');
    const {paidSlots,allDueDates}=await getPaidSlots(mid,gid,grp,eid,sn);
    window._singleMonthPaidSlots=paidSlots;
    if(!allDueDates.length){wrap.style.display='none';return;}
    wrap.style.display='block';
    const today=new Date().toISOString().split('T')[0];
    const currentSlot=getMonthSlot(allDueDates,today);
    let autoSelect=currentSlot;
    // If current month already paid, jump to next unpaid
    if(paidSlots.has(currentSlot)){
        for(let i=currentSlot+1;i<allDueDates.length;i++){
            if(!paidSlots.has(i)){autoSelect=i;break;}
        }
    }
    const chitAmount=parseFloat(document.getElementById('pChit').value)||0;
    const isVariableAmount=grp&&grp.amtType==='variable';
    const ps=await getCollection('payments');
    sel.innerHTML='<option value="">-- Select Month --</option>'+allDueDates.map((dd,i)=>{
        const isPaid=paidSlots.has(i);
        const isPast=dd<today;
        const isCurrent=i===currentSlot;
        let tag='';
        if(isVariableAmount){
            if(isPaid){
                let totalPaidForMonth=0;
                ps.forEach(p=>{
                    if(p.memberId!==mid||p.groupId!==gid)return;
                    const pSlot=p.slotNum?Number(p.slotNum):1;
                    if(pSlot!==Number(sn))return;
                    if(eid&&p.enrollmentId&&p.enrollmentId!==''){if(p.enrollmentId!==eid)return;}
                    if(Array.isArray(p.monthSlots)&&p.monthSlots.includes(i)){totalPaidForMonth+=parseFloat(p.paid)||0;}
                    else if(p.monthSlot===i){totalPaidForMonth+=parseFloat(p.paid)||0;}
                });
                if(totalPaidForMonth>0){
                    tag=' ⚠ Partial';
                }else{
                    tag=' ← Current';
                }
            }else if(isPast){
                tag=' ⚠ Overdue';
            }else{
                tag=' (Upcoming)';
            }
        }else{
            if(isPaid){
                let totalPaidForMonth=0;
                ps.forEach(p=>{
                    if(p.memberId!==mid||p.groupId!==gid)return;
                    const pSlot=p.slotNum?Number(p.slotNum):1;
                    if(pSlot!==Number(sn))return;
                    if(eid&&p.enrollmentId&&p.enrollmentId!==''){if(p.enrollmentId!==eid)return;}
                    if(Array.isArray(p.monthSlots)&&p.monthSlots.includes(i)){totalPaidForMonth+=parseFloat(p.paid)||0;}
                    else if(p.monthSlot===i){totalPaidForMonth+=parseFloat(p.paid)||0;}
                });
                if(chitAmount>0&&totalPaidForMonth>=chitAmount){
                    tag=' ✅ Paid';
                }else if(chitAmount>0&&totalPaidForMonth>0){
                    tag=' ⚠ Partial';
                }else{
                    tag=' ✅ Paid';
                }
            }else if(isCurrent){
                tag=' ← Current';
            }else if(isPast){
                tag=' ⚠ Overdue';
            }else{
                tag=' (Upcoming)';
            }
        }
        return `<option value="${i}" ${i===autoSelect?'selected':''}>${fmtDate(dd)}${tag}</option>`;
    }).join('');
    onSingleMonthSlotChange();
}


async function onNumMonthsChange(){
    const preview=document.getElementById('multiMonthPreview');
    document.getElementById('totalChitRef').style.display='none';
    document.getElementById('perMonthLabel').textContent='(per month)';
    preview.style.display='block';
    await buildMonthSelectorGrid();
    calcBalance();
    updateChitPickedOption();
}

async function buildMonthSelectorGrid(){
    const mid=document.getElementById('pMember').value;
    const gid=document.getElementById('pGroup').value;
    const grid=document.getElementById('monthSelectorGrid');
    const summary=document.getElementById('selectedSummary');
    grid.innerHTML='<div style="color:var(--text-dim);font-size:0.92rem;padding:8px;">Select member & group first\u2026</div>';
    summary.style.display='none';
    document.getElementById('perMonthAmtWrap').style.display='none';
    document.getElementById('perMonthCustomToggle').checked=false;
    if(!mid||!gid) return;
    const gs=await getCollection('groups');
    window._gs_cache=gs;
    const grp=gs.find(g=>g.id===gid);
    if(!grp){grid.innerHTML='<div style="color:#f87171;font-size:0.92rem;">Group not found</div>';return;}
    const eid=document.getElementById('pEnrollmentId').value||'';
    const sn=parseInt(document.getElementById('pSlotNum').value||'1');
    const {paidSlots,allDueDates}=await getPaidSlots(mid,gid,grp,eid,sn);
    if(!allDueDates.length){grid.innerHTML='<div style="color:#f87171;font-size:0.92rem;">No due dates configured for this group</div>';return;}
    const today=new Date().toISOString().split('T')[0];
    const chitAmount=parseFloat(document.getElementById('pChit').value)||0;
    const isVariableAmount=grp&&grp.amtType==='variable';
    const ps=await getCollection('payments');
    window._monthPaidMap={};
    grid.innerHTML=allDueDates.map((dd,i)=>{
        const paid=paidSlots.has(i);
        const isPast=dd<=today;
        let totalPaidForMonth=0;
        let splitPaidForMonth=0; // multi-month payments split evenly across their months
        if(paid){
            ps.forEach(p=>{
                if(p.memberId!==mid||p.groupId!==gid)return;
                const pSlot=p.slotNum?Number(p.slotNum):1;
                if(pSlot!==Number(sn))return;
                if(eid&&p.enrollmentId&&p.enrollmentId!==''){if(p.enrollmentId!==eid)return;}
                if(Array.isArray(p.monthSlots)&&p.monthSlots.includes(i)){
                    totalPaidForMonth+=parseFloat(p.paid)||0;
                    splitPaidForMonth+=(parseFloat(p.paid)||0)/(p.monthSlots.length||1);
                }
                else if(p.monthSlot===i){totalPaidForMonth+=parseFloat(p.paid)||0;splitPaidForMonth+=parseFloat(p.paid)||0;}
            });
        }
        window._monthPaidMap[i]=splitPaidForMonth;
        let label='·';
        let statusText='';
        let color='var(--text-dim)';
        if(isVariableAmount){
            if(paid&&totalPaidForMonth>0){
                label='⚠';
                statusText='Partial';
                color='#f59e0b';
            }else if(isPast){
                label='○';
                statusText='Overdue';
                color='#f87171';
            }else{
                label='·';
                statusText='Upcoming';
                color='var(--text-dim)';
            }
        }else{
            if(paid){
                if(chitAmount>0&&totalPaidForMonth>=chitAmount){
                    label='✅';
                    statusText='Paid';
                    color='#34d399';
                }else if(chitAmount>0&&totalPaidForMonth>0){
                    label='⚠';
                    statusText='Partial';
                    color='#f59e0b';
                }else{
                    label='✅';
                    statusText='Paid';
                    color='#34d399';
                }
            }else if(isPast){
                label='○';
                statusText='Overdue';
                color='#f87171';
            }else{
                label='·';
                statusText='Upcoming';
                color='var(--text-dim)';
            }
        }
        return`<label class="month-cb-item ${paid?'already-paid':''}" style="padding:4px 5px;gap:3px;">
            <input type="checkbox" value="${i}" onchange="updateSelectedSummary();calcBalance();" style="width:11px;height:11px;margin:0;">
            <div style="min-width:0;">
                <div style="font-size:0.65rem;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${fmtDate(dd)}</div>
                <div style="font-size:0.6rem;color:${color};">${label} ${statusText}</div>
                <div class="mb-paid" data-slot="${i}" style="font-size:0.6rem;font-weight:700;white-space:nowrap;color:#34d399;"></div>
                <div class="mb-bal" data-slot="${i}" style="font-size:0.6rem;font-weight:700;white-space:nowrap;"></div>
            </div>
        </label>`;
    }).join('');
    updateMonthBalances();
    updateSelectedSummary();
    calcBalance();
}

// Fills the "Bal ₹X" line on every month tile from the current Chit Amt
function updateMonthBalances(){
    const chit=parseFloat(document.getElementById('pChit').value)||0;
    const map=window._monthPaidMap||{};
    document.querySelectorAll('#monthSelectorGrid .mb-bal').forEach(el=>{
        if(!chit){el.textContent='';return;}
        const bal=Math.max(0,chit-(map[el.dataset.slot]||0));
        el.textContent='Bal \u20b9'+Math.round(bal).toLocaleString('en-IN');
        el.style.color=bal===0?'#34d399':(map[el.dataset.slot]>0?'#f59e0b':'#cbd5e1');
    });
    // Partial months: also show how much has been paid so far
    document.querySelectorAll('#monthSelectorGrid .mb-paid').forEach(el=>{
        const paidAmt=map[el.dataset.slot]||0;
        const partial=chit>0 && paidAmt>0 && paidAmt<chit;
        el.textContent=partial?'Paid \u20b9'+Math.round(paidAmt).toLocaleString('en-IN'):'';
    });
}

function updateSelectedSummary(){
    const newlySelected=Array.from(document.querySelectorAll('#monthSelectorGrid input[type=checkbox]:checked:not(:disabled)')).map(cb=>parseInt(cb.value));
    const summary=document.getElementById('selectedSummary');
    if(newlySelected.length===0){
        summary.style.display='none';
        document.getElementById('perMonthAmtWrap').style.display='none';
    } else {
        summary.style.display='block';
        summary.textContent=`\ud83d\udcc5 ${newlySelected.length} month${newlySelected.length>1?'s':''} selected for payment`;
        document.getElementById('perMonthAmtWrap').style.display='block';
        buildPerMonthAmtGrid(newlySelected);
    }
    calcBalance();
    updateChitPickedOption();
}

function buildPerMonthAmtGrid(selectedSlots){
    const isCustom=document.getElementById('perMonthCustomToggle').checked;
    const grid=document.getElementById('perMonthAmtGrid');
    if(!isCustom){ grid.style.display='none'; return; }
    grid.style.display='flex';
    const gs_cache=window._gs_cache||[];
    const gid=document.getElementById('pGroup').value;
    const grp=gs_cache.find(g=>g.id===gid);
    const allDueDates=grp?getGroupDueDates(grp):[];
    const chit=parseFloat(document.getElementById('pChit').value)||0;
    const existing={};
    grid.querySelectorAll('.pma-row').forEach(r=>{ existing[r.dataset.slot]=r.querySelector('input').value; });
    grid.innerHTML=selectedSlots.map(slot=>{
        const label=allDueDates[slot]?fmtDate(allDueDates[slot]):`Month ${slot+1}`;
        const val=existing[slot]!==undefined?existing[slot]:(chit||'');
        return `<div class="pma-row" data-slot="${slot}" style="display:flex;align-items:center;gap:8px;background:rgba(255,255,255,0.04);border:1px solid var(--border);border-radius:8px;padding:7px 10px;">
            <span style="flex:1;font-size:0.92rem;color:#a5b4fc;font-weight:700;">${label}</span>
            <input type="number" placeholder="\u20b9 amount" value="${val}" style="width:110px;background:var(--input-bg);border:1px solid var(--border);color:white;padding:6px 9px;border-radius:7px;font-size:1rem;" oninput="calcBalance()">
        </div>`;
    }).join('');
}

function togglePerMonthCustom(){
    const isCustom=document.getElementById('perMonthCustomToggle').checked;
    const slots=Array.from(document.querySelectorAll('#monthSelectorGrid input[type=checkbox]:checked:not(:disabled)')).map(cb=>parseInt(cb.value));
    if(isCustom && slots.length>0) buildPerMonthAmtGrid(slots);
    else document.getElementById('perMonthAmtGrid').style.display='none';
    calcBalance();
    updateChitPickedOption();
}

function onChitAmtChange(){
    if(document.getElementById('perMonthCustomToggle')?.checked){
        const chit=parseFloat(document.getElementById('pChit').value)||0;
        document.querySelectorAll('#perMonthAmtGrid .pma-row input').forEach(inp=>{
            if(!inp.value) inp.value=chit||'';
        });
    }
    calcBalance();
    updateChitPickedOption();
}

function getPerMonthAmounts(){
    if(!document.getElementById('perMonthCustomToggle')?.checked) return null;
    const map={};
    document.querySelectorAll('#perMonthAmtGrid .pma-row').forEach(r=>{
        const slot=parseInt(r.dataset.slot);
        const val=parseFloat(r.querySelector('input').value)||0;
        if(!isNaN(slot)) map[slot]=val;
    });
    return map;
}

function calcBalance(){
    updateMonthBalances();
    const chit=parseFloat(document.getElementById('pChit').value)||0;
    const paid=parseFloat(document.getElementById('pPaid').value)||0;
    const isMulti=document.getElementById('pNumMonths').value==='multi';
    const ref=document.getElementById('totalChitRef');
    const fmt=v=>`\u20b9${v.toLocaleString('en-IN')}`;
    const setPrev=v=>{
        const w=document.getElementById('prevPaidWrap');
        if(v>0){document.getElementById('prevPaidVal').textContent=fmt(v);w.style.display='inline';}
        else w.style.display='none';
    };
    const show=(totalTxt,bal,prev)=>{
        document.getElementById('totalChitVal').textContent=totalTxt;
        document.getElementById('totalBalVal').textContent=fmt(bal);
        setPrev(prev||0);
        ref.style.display='flex';
    };
    if(isMulti){
        const selectedCBs=Array.from(document.querySelectorAll('#monthSelectorGrid input[type=checkbox]:checked:not(:disabled)'));
        const n=selectedCBs.length;
        if(!chit||n===0){ref.style.display='none';return;}
        const isCustom=document.getElementById('perMonthCustomToggle')?.checked;
        const amtMap=isCustom?(getPerMonthAmounts()||{}):{};
        const paidMap=window._monthPaidMap||{};
        let totalChit=0, alreadyPaid=0, owedBefore=0;
        selectedCBs.forEach(cb=>{
            const slot=parseInt(cb.value);
            const monthChit=isCustom?(amtMap[slot]||chit):chit;
            const prev=paidMap[slot]||0;            // already paid for this month (same figure the tiles show)
            totalChit+=monthChit;
            alreadyPaid+=prev;
            owedBefore+=Math.max(0,monthChit-prev);
        });
        const bal=Math.max(0,owedBefore-paid);
        const totalTxt=n===1 ? fmt(totalChit)
            : (isCustom ? `${fmt(totalChit)} (${n} months, custom amounts)`
                        : `${fmt(totalChit)} (${n}\u00d7${fmt(chit)})`);
        show(totalTxt,bal,Math.round(alreadyPaid));
    } else {
        // Single month: balance also accounts for earlier part-payments of that month
        const slotVal=document.getElementById('pSingleMonthSlot').value;
        if(!chit||slotVal===''){ref.style.display='none';return;}
        const seq=window._calcBalSeq=(window._calcBalSeq||0)+1;
        const mid=document.getElementById('pMember').value;
        const gid=document.getElementById('pGroup').value;
        const eid=document.getElementById('pEnrollmentId').value||'';
        const sn=parseInt(document.getElementById('pSlotNum').value||'1');
        const slot=parseInt(slotVal);
        getCollection('payments').then(ps=>{
            if(seq!==window._calcBalSeq) return; // a newer calc superseded this one
            const prev=ps.filter(p=>p.memberId===mid && p.groupId===gid &&
                (p.enrollmentId||'')===eid &&
                (p.slotNum?Number(p.slotNum):1)===sn &&
                (Array.isArray(p.monthSlots) ? p.monthSlots.includes(slot) : p.monthSlot===slot))
                .reduce((s,p)=>{
                    const slots=Array.isArray(p.monthSlots)?p.monthSlots:(p.monthSlot!=null?[p.monthSlot]:[]);
                    return s+((parseFloat(p.paid)||0)/(slots.length||1));
                },0);
            show(fmt(chit),Math.max(0,chit-prev-paid),prev);
        }).catch(()=>{ show(fmt(chit),Math.max(0,chit-paid),0); });
    }
}


// PAYMENT FORM
// ══════════════════════════════════════════
function resetPaymentForm(){
    document.getElementById('pDate').value=new Date().toISOString().split('T')[0];
    document.getElementById('pMemberSearch').value='';
    document.getElementById('pMember').value='';
    document.getElementById('pMemberList').style.display='none';
    document.getElementById('pGroup').innerHTML='<option value="">-- Select Member First --</option>';
    document.getElementById('pNumMonths').value='1';   // Single Month is the default type
    if(document.getElementById('perMonthCustomToggle')) document.getElementById('perMonthCustomToggle').checked=false;
    if(document.getElementById('perMonthAmtGrid')) document.getElementById('perMonthAmtGrid').style.display='none';
    if(document.getElementById('perMonthAmtWrap')) document.getElementById('perMonthAmtWrap').style.display='none';
    document.getElementById('pChit').value='';
    document.getElementById('pPaid').value='';
    document.getElementById('pPaidBy').value='';
    document.getElementById('pChitPicked').value='No';
    document.getElementById('pChitPickedBy').value='';
    document.getElementById('chitPickedNameDiv').style.display='none';
    document.getElementById('multiMonthPreview').style.display='none';
    document.getElementById('totalChitRef').style.display='none';
    document.getElementById('perMonthLabel').textContent='';
    document.getElementById('monthSelectorGrid').innerHTML='';
    document.getElementById('selectedSummary').style.display='none';
    const sel=document.getElementById('pChitPicked');
    [...sel.options].forEach(o=>o.disabled=false);
    sel.title='';
    // reset single month dropdown
    if(document.getElementById('singleMonthDropdownWrap')) document.getElementById('singleMonthDropdownWrap').style.display='none';
    if(document.getElementById('pSingleMonthSlot')) document.getElementById('pSingleMonthSlot').innerHTML='<option value="">-- Select Month --</option>';
    if(document.getElementById('singleMonthBadge')) document.getElementById('singleMonthBadge').style.display='none';
    window._singleMonthPaidSlots=new Set();
    // Initialize correct mode UI (single month is the default, onchange won't fire)
    onNumMonthsChange();
    loadPaidByOptions().then(()=>populatePaidBySelect('pPaidBy'));
}

function openPaymentModal(){
    if(!isAdmin()){showToast('\ud83d\udeab Access denied',false);return;}
    resetPaymentForm();
    openModal('paymentModal');
    const _pb=document.querySelector('#paymentModal .pm-body'); if(_pb) _pb.scrollTop=0;
}

async function linkGroupForPayment(){
    const mid=document.getElementById('pMember').value;
    const ms=await getCollection('members');const m=ms.find(x=>x.id===mid);if(!m)return;
    const gs=await getCollection('groups');

    let opts='';
    if(m.enrollments && m.enrollments.length){
        opts = m.enrollments.map(e=>{
            const g=gs.find(x=>x.id===e.groupId);
            if(!g) return '';
            const qty = parseInt(e.qty||1);
            if(qty > 1){
                return Array.from({length:qty},(_,i)=>{
                    const slotLabel = e.label ? `${e.label} \u2014 Chit ${i+1}` : `Chit ${i+1} of ${qty}`;
                    return `<option value="${e.groupId}" data-enrollment-id="${e.enrollmentId}" data-slot="${i+1}">${g.name} (${slotLabel})</option>`;
                }).join('');
            } else {
                const dispLabel = e.label ? ` (${e.label})` : '';
                return `<option value="${e.groupId}" data-enrollment-id="${e.enrollmentId}" data-slot="1">${g.name}${dispLabel}</option>`;
            }
        }).join('');
    } else {
        opts = gs.filter(g=>m.groupIds&&m.groupIds.includes(g.id)).map(g=>`<option value="${g.id}" data-slot="1">${g.name}</option>`).join('');
    }
    document.getElementById('pGroup').innerHTML = opts || '<option value="">No groups assigned</option>';

    const sel = document.getElementById('pGroup');
    sel.onchange = function(){
        const chosen = sel.options[sel.selectedIndex];
        document.getElementById('pEnrollmentId').value = chosen ? (chosen.dataset.enrollmentId||'') : '';
        document.getElementById('pSlotNum').value = chosen ? (chosen.dataset.slot||'1') : '1';
        onGroupChange();
    };
    const first = sel.options[sel.selectedIndex];
    document.getElementById('pEnrollmentId').value = first ? (first.dataset.enrollmentId||'') : '';
    document.getElementById('pSlotNum').value = first ? (first.dataset.slot||'1') : '1';
    await onGroupChange();
}

async function onGroupChange(){
    document.getElementById('pChit').value='';
    document.getElementById('pPaid').value='';
    document.getElementById('totalChitRef').style.display='none';
    const mid=document.getElementById('pMember').value;
    const gid=document.getElementById('pGroup').value;
    // Show joint member info if this enrollment is a joint chit
    await showJointMemberInfo(mid, gid);
    if(gid){
        const gs=await getCollection('groups');
        const grp=gs.find(g=>g.id===gid);
        let autoChit=0;
        if(grp && grp.amtType!=='variable' && grp.fixedAmt){
            autoChit=parseFloat(grp.fixedAmt)||0;
        }
        if(!autoChit && mid){
            const ps2=await getCollection('payments');
            const lastP=ps2.filter(p=>p.memberId===mid&&p.groupId===gid&&p.chit).sort((a,b)=>(b.date||'').localeCompare(a.date||''));
            if(lastP.length) autoChit=parseFloat(lastP[0].chit)||0;
        }
        if(autoChit){
            document.getElementById('pChit').value=autoChit;
            calcBalance();
    updateChitPickedOption();
        }
    }
    if(mid&&gid){
        const ps=await getCollection('payments');
        const eid=document.getElementById('pEnrollmentId').value||'';
        const alreadyPicked=await isChitAlreadyPicked(ps,mid,gid,eid,parseInt(document.getElementById('pSlotNum').value||'1'));
        const sel=document.getElementById('pChitPicked');
        if(alreadyPicked){
            sel.value='No';
            [...sel.options].forEach(o=>{if(o.value==='Yes')o.disabled=true;});
            sel.title='This slot already picked the chit';
            document.getElementById('chitPickedNameDiv').style.display='none';
        } else {
            [...sel.options].forEach(o=>o.disabled=false);
            sel.title='';
        }
    }
    if(document.getElementById('pNumMonths').value==='multi'){
        await buildMonthSelectorGrid();
    } else {
        await buildSingleMonthDropdown();
    }
}


// JOINT ENROLLMENT DISPLAY
// ══════════════════════════════════════════
async function showJointMemberInfo(mid, gid){
    let banner = document.getElementById('jointMemberBanner');
    if(!banner) return;
    banner.style.display='none';
    banner.innerHTML='';
    if(!mid||!gid) return;
    const ms = await getCollection('members');
    const m = ms.find(x=>x.id===mid);
    if(!m||!m.enrollments) return;
    const enr = m.enrollments.find(e=>e.groupId===gid);
    if(!enr||!enr.coMemberId) return;
    const coM = ms.find(x=>x.id===enr.coMemberId);
    if(!coM) return;
    banner.style.display='block';
    banner.innerHTML=`
        <div style="display:flex;align-items:center;gap:10px;">
            <span style="font-size:1.3rem;">👥</span>
            <div>
                <div style="font-size:0.88rem;font-weight:800;color:#a5b4fc;">Joint Chit</div>
                <div style="font-size:0.8rem;color:var(--text-dim);">
                    <strong style="color:#c4b5fd;">${m.name}</strong>
                    <span style="margin:0 6px;color:var(--text-dim);">+</span>
                    <strong style="color:#c4b5fd;">${coM.name}</strong>
                    ${coM.phone?'<span style="color:var(--text-dim);"> · '+coM.phone+'</span>':''}
                    share this chit slot
                </div>
            </div>
        </div>`;
}
// ══════════════════════════════════════════

// Simplified savePayment - remove payment note temporarily to fix the issue
async function savePayment(){
    try {
        if(!isAdmin()){showToast('🚫 Access denied',false);return;}
        
        const mid=document.getElementById('pMember').value;
        const gid=document.getElementById('pGroup').value;
        const date=document.getElementById('pDate').value;
        const chitPerMonth=parseFloat(document.getElementById('pChit').value)||0;
        const paid=parseFloat(document.getElementById('pPaid').value)||0;
        const paidBy=document.getElementById('pPaidBy').value;
        const chitPicked=document.getElementById('pChitPicked').value;
        const chitPickedBy=document.getElementById('pChitPickedBy').value.trim();
        const mode = document.getElementById('pNumMonths').value;
        let ackData=null; // set when chit is picked, used for the WhatsApp acknowledgement

        if(!mid){showToast('❌ Select a member',false);return;}
        if(!gid){showToast('❌ Select a group',false);return;}
        if(!date){showToast('❌ Enter date',false);return;}
        if(!paid){showToast('❌ Enter amount paid',false);return;}

        if(mode === '1') {
            // Single month mode
            const slotSel = document.getElementById('pSingleMonthSlot');
            const selectedSlot = slotSel.value !== '' ? parseInt(slotSel.value) : null;
            if(selectedSlot===null){showToast('❌ Select which month this payment is for',false);return;}
            
            const monthSlots = [selectedSlot];
            const enrollmentId1 = document.getElementById('pEnrollmentId').value||'';
            const slotNum1 = parseInt(document.getElementById('pSlotNum').value||'1');

            // BUGFIX: if this month already has other (partial) payments recorded, the
            // remaining balance must be computed against everything paid for the month so
            // far — not just this single payment — otherwise splitting a month's payment
            // into installments makes the stored balance overstate what's actually owed.
            const psForBal = await getCollection('payments');
            const alreadyPaidThisMonth = psForBal
                .filter(p=>p.memberId===mid && p.groupId===gid &&
                    (p.enrollmentId||'')===enrollmentId1 &&
                    (p.slotNum?Number(p.slotNum):1)===slotNum1 &&
                    (Array.isArray(p.monthSlots) ? p.monthSlots.includes(selectedSlot) : p.monthSlot===selectedSlot))
                .reduce((s,p)=>{
                    const slots = Array.isArray(p.monthSlots) ? p.monthSlots : (p.monthSlot!=null?[p.monthSlot]:[]);
                    const n = slots.length||1;
                    return s + ((parseFloat(p.paid)||0)/n);
                },0);
            const balance = Math.max(0, chitPerMonth - alreadyPaidThisMonth - paid);
            
            // Check if THIS enrollment slot already picked chit
            if(chitPicked==='Yes'){
                const alreadyPicked=await isChitAlreadyPicked(psForBal,mid,gid,enrollmentId1,slotNum1);
                if(alreadyPicked){showToast('❌ Chit already picked for this slot',false);return;}
            }
            
            const paymentNote1=getPaymentNoteText();
            await db.collection('payments').add({
                memberId:mid, groupId:gid, enrollmentId:enrollmentId1, slotNum:slotNum1, date,
                chit:chitPerMonth, paid, balance, paidBy, chitPicked, chitPickedBy,
                numMonths:1, monthSlots, monthSlot:selectedSlot,
                paidPerMonth:paid, balPerMonth:balance, paymentNote:paymentNote1,
                ackPay:'pending', ...(chitPicked==='Yes'?{ackChit:'pending'}:{})
            });
            if(chitPicked==='Yes') ackData={mid,gid,slot:selectedSlot,date,chitPickedBy,chit:chitPerMonth};
            
        } else {
            // Multiple month mode
            const monthSlots=getSelectedMonthSlots();
            if(monthSlots.length===0){showToast('❌ Select at least one month',false);return;}
            
            const numMonths=monthSlots.length;
            const enrollmentId1 = document.getElementById('pEnrollmentId').value||'';
            const slotNum1 = parseInt(document.getElementById('pSlotNum').value||'1');

            // Balance = what is still owed for the selected months after earlier (part) payments
            // of those months, minus this payment — same figure the month tiles and the bar show.
            const psForBalMulti = await getCollection('payments');
            const owedBefore = monthSlots.reduce((sum,slot)=>{
                const prev = psForBalMulti
                    .filter(x=>x.memberId===mid && x.groupId===gid &&
                        (x.enrollmentId||'')===enrollmentId1 &&
                        (x.slotNum?Number(x.slotNum):1)===slotNum1 &&
                        (Array.isArray(x.monthSlots) ? x.monthSlots.includes(slot) : x.monthSlot===slot))
                    .reduce((s,x)=>{
                        const sl = Array.isArray(x.monthSlots) ? x.monthSlots : (x.monthSlot!=null?[x.monthSlot]:[]);
                        return s + ((parseFloat(x.paid)||0)/(sl.length||1));
                    },0);
                return sum + Math.max(0, chitPerMonth - prev);
            },0);
            const balance=Math.max(0,owedBefore-paid);
            
            // Check if THIS enrollment slot already picked chit
            if(chitPicked==='Yes'){
                const ps=await getCollection('payments');
                const alreadyPickedInSlots=await isChitAlreadyPicked(ps,mid,gid,enrollmentId1,slotNum1);
                if(alreadyPickedInSlots){showToast('❌ Chit already picked for this slot',false);return;}
            }
            
            const paymentNote2=getPaymentNoteText();
            await db.collection('payments').add({
                memberId:mid, groupId:gid, enrollmentId:enrollmentId1, slotNum:slotNum1, date,
                chit:chitPerMonth, paid, balance, paidBy, chitPicked, chitPickedBy,
                numMonths, monthSlots, monthSlot:monthSlots[0],
                paidPerMonth:paid/numMonths, balPerMonth:balance/numMonths, paymentNote:paymentNote2,
                ackPay:'pending', ...(chitPicked==='Yes'?{ackChit:'pending'}:{})
            });
            if(chitPicked==='Yes') ackData={mid,gid,slot:monthSlots[0],date,chitPickedBy,chit:chitPerMonth};
        }
        
        bustCache('payments');
        showToast('✅ Payment recorded!');
        closeModal('paymentModal');
        resetPaymentForm();
        
        await updateUI();
        const summaryView = document.getElementById('summaryView');
        if(summaryView) {
            summaryView.value = mid;
            await loadMemberLedger();
        }
        
        if(typeof refreshAckBadge==='function') refreshAckBadge();
        
    } catch(error) {
        console.error('Payment save error:', error);
        showToast('❌ ' + error.message, false);
    }
}

// ══════════════════════════════════════════
// CHIT PICKED — WHATSAPP ACKNOWLEDGEMENT
// ══════════════════════════════════════════
function buildChitPickedMessage(d){
    const L=[];
    L.push(`Dear ${d.name},`);
    L.push('');
    L.push('Greetings from *AK Chit Funds*.');
    L.push('');
    L.push(`This is to acknowledge that you have picked the chit for the month of *${d.monthLabel}* in the group *${d.groupName}*.`);
    L.push('');
    L.push('*Chit Details*');
    L.push(`Group: ${d.groupName}`);
    L.push(`Month: ${d.monthLabel}`);
    if(d.pickedValue>0) L.push(`Chit value: ${fmtAmt(d.pickedValue)}`);
    L.push(`Recorded on: ${d.dateLabel}`);
    L.push('');
    L.push('Our team will contact you shortly regarding the next steps. For any clarification, please feel free to reach out to us.');
    L.push('');
    L.push('Thank you for your continued trust in us.');
    L.push('');
    L.push('Warm regards,');
    L.push('*AK Chit Funds*');
    return L.join('\n');
}

async function showChitPickedAck(data){
    try{
        if(!data||!data.mid||!data.gid) return;
        const [ms,gs]=await Promise.all([getCollection('members'),getCollection('groups')]);
        const m=ms.find(x=>x.id===data.mid);
        const g=gs.find(x=>x.id===data.gid);
        if(!m||!g) return;
        const dueDates=getGroupDueDates(g);
        const due=(data.slot!=null&&dueDates[data.slot])?dueDates[data.slot]:null;
        let monthLabel='the selected month';
        if(due){
            const mn=['January','February','March','April','May','June','July','August','September','October','November','December'];
            const [y,mo]=due.split('-');
            monthLabel=`${mn[parseInt(mo,10)-1]} ${y}`;
        }
        const msg=buildChitPickedMessage({
            name:m.name||'Member',
            groupName:g.name||'',
            monthLabel,
            pickedValue:parseFloat(data.chitPickedBy)||0,
            dateLabel:fmtDate(data.date)
        });
        let phone=(m.phone||'').replace(/\D/g,'');
        if(phone.length===10) phone='91'+phone;

        let ov=document.getElementById('chitAckModal');
        if(ov) ov.remove();
        ov=document.createElement('div');
        ov.id='chitAckModal';
        ov.className='modal-overlay';
        ov.style.cssText='display:block;z-index:2100;';
        ov.innerHTML=`<div class="modal-content-custom" style="max-height:92vh;overflow-y:auto;padding:14px 16px;">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
                <div style="font-size:1rem;font-weight:800;color:#34d399;flex:1;">🏆 Chit Picked — Send Acknowledgement</div>
                <button type="button" onclick="document.getElementById('chitAckModal').remove()" style="background:none;border:none;color:var(--text-dim);font-size:1.2rem;cursor:pointer;padding:2px 6px;">✕</button>
            </div>
            <div style="font-size:0.78rem;color:var(--text-dim);margin-bottom:6px;">To: <b style="color:white;">${m.name||''}</b> &nbsp;📞 ${phone?('+'+phone):'<span style="color:#f87171;">No phone number saved</span>'}</div>
            <textarea id="chitAckText" class="form-input" rows="14" style="font-size:0.8rem;resize:vertical;margin-bottom:8px;"></textarea>
            <div style="display:flex;gap:8px;">
                <button type="button" id="chitAckSend" class="btn btn-success fw-bold" style="flex:1;border-radius:12px;padding:10px;background:#25D366;border:none;color:white;">💬 Send on WhatsApp</button>
                <button type="button" id="chitAckCopy" class="btn fw-bold" style="border-radius:12px;padding:10px;background:rgba(99,102,241,0.15);border:1px solid rgba(99,102,241,0.35);color:#a5b4fc;">📋 Copy</button>
                <button type="button" onclick="document.getElementById('chitAckModal').remove()" class="btn fw-bold" style="border-radius:12px;padding:10px;background:var(--input-bg);border:1px solid var(--border);color:white;">Skip</button>
            </div>
        </div>`;
        document.body.appendChild(ov);
        const ta=document.getElementById('chitAckText');
        ta.value=msg;
        const sendBtn=document.getElementById('chitAckSend');
        if(!phone){ sendBtn.disabled=true; sendBtn.style.opacity='.5'; }
        sendBtn.onclick=()=>{
            window.open('https://wa.me/'+phone+'?text='+encodeURIComponent(ta.value),'_blank');
            ov.remove();
        };
        document.getElementById('chitAckCopy').onclick=async()=>{
            try{ await navigator.clipboard.writeText(ta.value); showToast('✅ Message copied'); }
            catch(e){ ta.select(); document.execCommand('copy'); showToast('✅ Message copied'); }
        };
    }catch(err){
        console.error('Chit acknowledgement error:',err);
    }
}

// EDIT / DELETE EXISTING PAYMENT
// ══════════════════════════════════════════
async function openEditPayment(pid){
    if(!isAdmin()){showToast('\ud83d\udeab Access denied',false);return;}
    const ps=await getCollection('payments');
    const p=ps.find(x=>x.id===pid);if(!p)return;
    document.getElementById('epId').value=pid;
    document.getElementById('epDate').value=p.date||'';
    document.getElementById('epChit').value=p.chit||'';
    document.getElementById('epPaid').value=p.paid||'';
    document.getElementById('epBal').value=p.balance||'';
    document.getElementById('epPaidBy').value=p.paidBy||'';
    document.getElementById('epChitPicked').value=p.chitPicked||'No';
    document.getElementById('epChitPickedBy').value=p.chitPickedBy||'';
    document.getElementById('epPaymentNote').value=p.paymentNote||'';
    onEditNoteChange();
    document.getElementById('epChitPickedNameDiv').style.display=p.chitPicked==='Yes'?'block':'none';

    const infoBox=document.getElementById('epMultiMonthInfo');
    const detailEl=document.getElementById('epMultiMonthDetail');
    if(p.numMonths&&p.numMonths>1){
        infoBox.style.display='block';
        const gs=await getCollection('groups');
        const grp=gs.find(g=>g.id===p.groupId);
        let slotLabels='';
        if(grp&&p.monthSlots){
            const dueDates=getGroupDueDates(grp);
            slotLabels=p.monthSlots.map((s,i)=>dueDates[s]?fmtDate(dueDates[s]):`Month ${s+1}`).join(' \u2192 ');
        }
        detailEl.innerHTML=`Covers <strong>${p.numMonths} months</strong>${slotLabels?': '+slotLabels:''}`;
    } else {
        infoBox.style.display='none';
    }

    openModal('editPaymentModal');
}

function epCalcBalance(){
    const chit=parseFloat(document.getElementById('epChit').value)||0;
    const paid=parseFloat(document.getElementById('epPaid').value)||0;
    document.getElementById('epBal').value=Math.max(0,chit-paid);
}
function epTogglePickedName(){
    document.getElementById('epChitPickedNameDiv').style.display=document.getElementById('epChitPicked').value==='Yes'?'block':'none';
}

async function saveEditPayment(){
    if(!isAdmin()){showToast('\ud83d\udeab Access denied',false);return;}
    const pid=document.getElementById('epId').value;if(!pid)return;
    const date=document.getElementById('epDate').value;
    const chit=parseFloat(document.getElementById('epChit').value)||0;
    const paid=parseFloat(document.getElementById('epPaid').value)||0;
    const balance=Math.max(0,chit-paid);
    const paidBy=document.getElementById('epPaidBy').value;
    const chitPicked=document.getElementById('epChitPicked').value;
    const chitPickedBy=document.getElementById('epChitPickedBy').value.trim();
    if(!date)return showToast('\u274c Enter date',false);
    if(!paid)return showToast('\u274c Enter amount paid',false);
    const paymentNote=getEditPaymentNoteText();
    const psBefore=await getCollection('payments');
    const before=psBefore.find(x=>x.id===pid)||{};
    const upd={date,chit,paid,balance,paidBy,chitPicked,chitPickedBy,paymentNote};
    if(chitPicked==='Yes' && before.chitPicked!=='Yes') upd.ackChit='pending'; // queue chit-picked acknowledgement
    await db.collection('payments').doc(pid).update(upd);
    bustCache('payments');
    closeModal('editPaymentModal');showToast('\u2705 Payment updated!');updateUI();
    const mid=document.getElementById('summaryView').value;
    if(mid)loadMemberLedger();
    if(typeof refreshAckBadge==='function') refreshAckBadge();
}

async function deletePayment(){
    if(!isAdmin()){showToast('\ud83d\udeab Access denied',false);return;}
    const pid=document.getElementById('epId').value;if(!pid)return;
    showConfirm('\ud83d\uddd1','Delete Payment?','This will permanently delete this payment record.',async()=>{
        await db.collection('payments').doc(pid).delete();
        bustCache('payments');
        closeModal('editPaymentModal');showToast('\ud83d\uddd1 Payment deleted');updateUI();
        const mid=document.getElementById('summaryView').value;
        if(mid)loadMemberLedger();
    });
}

// ══════════════════════════════════════════


// ── Paid By: Editable Combo Dropdown (Firestore-synced) ────
const DEFAULT_PAID_BY = ['UPI','GPay','PhonePe','PPay','Bank Transfer','Cash','Cheque'];
let _paidByOptions = null;
let _managingFor = null;

function getPaidByOptions() {
    if (_paidByOptions) return _paidByOptions;
    try {
        const stored = localStorage.getItem('ak_paidby_options');
        _paidByOptions = stored ? JSON.parse(stored) : [...DEFAULT_PAID_BY];
    } catch(e) { _paidByOptions = [...DEFAULT_PAID_BY]; }
    return _paidByOptions;
}

async function loadPaidByOptions() {
    try {
        const doc = await db.collection('settings').doc('paidByOptions').get();
        if (doc.exists && Array.isArray(doc.data().options)) {
            _paidByOptions = doc.data().options;
        } else {
            _paidByOptions = [...DEFAULT_PAID_BY];
        }
        localStorage.setItem('ak_paidby_options', JSON.stringify(_paidByOptions));
    } catch(e) {
        try {
            const stored = localStorage.getItem('ak_paidby_options');
            _paidByOptions = stored ? JSON.parse(stored) : [...DEFAULT_PAID_BY];
        } catch(e2) { _paidByOptions = [...DEFAULT_PAID_BY]; }
    }
    return _paidByOptions;
}

async function savePaidByToStorage() {
    try {
        await db.collection('settings').doc('paidByOptions').set({ options: _paidByOptions });
        localStorage.setItem('ak_paidby_options', JSON.stringify(_paidByOptions));
    } catch(e) {
        try { localStorage.setItem('ak_paidby_options', JSON.stringify(_paidByOptions)); } catch(e2){}
        showToast('⚠️ Saved locally only — check connection', false);
    }
}

function populatePaidBySelect(selectId){
    const sel = document.getElementById(selectId);
    if(!sel || sel.tagName !== 'SELECT') return;
    const opts = getPaidByOptions();
    const cur = sel.value;
    sel.innerHTML = '<option value="">-- Mode --</option>' + opts.map(o=>`<option value="${o}"${o===cur?' selected':''}>${o}</option>`).join('');
}

function showPaidByDropdown(inputId, dropId) {
    const input = document.getElementById(inputId);
    const drop  = document.getElementById(dropId);
    if (!input || !drop) return;

    const q = input.value.toLowerCase().trim();
    const opts = getPaidByOptions().filter(o => !q || o.toLowerCase().includes(q));

    if (!opts.length) { drop.style.display = 'none'; return; }

    drop.innerHTML = opts.map(o =>
        `<div onclick="selectPaidBy('${inputId}','${dropId}','${o.replace(/'/g,"\\'")}');event.stopPropagation();"
              style="padding:10px 14px;font-size:0.85rem;font-weight:600;color:var(--text-primary);cursor:pointer;border-bottom:1px solid var(--border);"
              onmouseenter="this.style.background='rgba(99,102,241,0.15)'"
              onmouseleave="this.style.background=''">${o}</div>`
    ).join('');
    drop.style.display = 'block';

    // Close on outside click
    const close = (e) => {
        if (!input.contains(e.target) && !drop.contains(e.target)) {
            drop.style.display = 'none';
            document.removeEventListener('click', close);
        }
    };
    setTimeout(() => document.addEventListener('click', close), 50);
}

function selectPaidBy(inputId, dropId, value) {
    document.getElementById(inputId).value = value;
    document.getElementById(dropId).style.display = 'none';
}

function openManagePaidBy(inputId) {
    _managingFor = inputId;
    renderPaidByOptionsList();
    openModal('managePaidByModal');
}

function renderPaidByOptionsList() {
    const opts = getPaidByOptions();
    const el = document.getElementById('paidByOptionsList');
    if (!el) return;
    el.innerHTML = opts.map((o, i) =>
        `<div style="display:flex;align-items:center;gap:8px;background:var(--input-bg);border:1px solid var(--border);border-radius:10px;padding:8px 12px;">
            <span style="flex:1;font-size:0.85rem;font-weight:600;color:var(--text-primary);">${o}</span>
            <button onclick="movePaidByOption(${i},-1)" title="Move up" style="background:none;border:none;color:var(--text-dim);font-size:0.85rem;cursor:pointer;padding:2px 5px;" ${i===0?'disabled style="opacity:.3;"':''}>▲</button>
            <button onclick="movePaidByOption(${i},1)" title="Move down" style="background:none;border:none;color:var(--text-dim);font-size:0.85rem;cursor:pointer;padding:2px 5px;" ${i===opts.length-1?'disabled style="opacity:.3;"':''}>▼</button>
            <button onclick="deletePaidByOption(${i})" title="Delete" style="background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);color:#ef4444;border-radius:7px;padding:4px 9px;font-size:0.78rem;cursor:pointer;">✕</button>
        </div>`
    ).join('') || '<div style="color:var(--text-dim);font-size:0.8rem;text-align:center;">No options yet</div>';
}

function addPaidByOption() {
    const input = document.getElementById('newPaidByInput');
    const val = (input.value || '').trim();
    if (!val) return;
    const opts = getPaidByOptions();
    if (opts.some(o => o.toLowerCase() === val.toLowerCase())) {
        showToast('⚠️ Option already exists', false); return;
    }
    opts.push(val);
    _paidByOptions = opts;
    input.value = '';
    renderPaidByOptionsList();
}

function deletePaidByOption(i) {
    const opts = getPaidByOptions();
    opts.splice(i, 1);
    _paidByOptions = opts;
    renderPaidByOptionsList();
}

function movePaidByOption(i, dir) {
    const opts = getPaidByOptions();
    const j = i + dir;
    if (j < 0 || j >= opts.length) return;
    [opts[i], opts[j]] = [opts[j], opts[i]];
    _paidByOptions = opts;
    renderPaidByOptionsList();
}

async function savePaidByOptions() {
    await savePaidByToStorage();
    populatePaidBySelect('pPaidBy');
    closeModal('managePaidByModal');
    showToast('✅ Payment modes saved!');
}


// ── Payment Notes Handling ──────────────────────────────────
function onPaymentNoteChange() {
    const sel = document.getElementById('pPaymentNote');
    const wrap = document.getElementById('pCustomNoteWrap');
    if (!sel) return;
    if(wrap) wrap.style.display = sel.value === 'Custom' ? '' : 'none';
}

function onEditNoteChange() {
    const sel = document.getElementById('epPaymentNote');
    const custom = document.getElementById('epCustomNote');
    if (!sel || !custom) return;
    custom.style.display = sel.value === 'Custom' ? '' : 'none';
}

// Get note text to store
function getPaymentNoteText() {
    const sel = document.getElementById('pPaymentNote');
    const custom = document.getElementById('pCustomNote');
    if (!sel) return '';
    if (sel.value === 'Custom') {
        return custom?.value || 'Custom Note';
    }
    return sel.value || '';
}

function getEditPaymentNoteText() {
    const sel = document.getElementById('epPaymentNote');
    const custom = document.getElementById('epCustomNote');
    if (!sel) return '';
    if (sel.value === 'Custom') {
        return custom?.value || 'Custom Note';
    }
    return sel.value || '';
}

// ── Update Chit Picked option based on selected months ──
// ── Update Chit Picked option based on selected months ──
async function onNumMonthsChange(){
    const isSingle = document.getElementById('pNumMonths').value === '1';
    document.getElementById('singleMonthDropdownWrap').style.display = isSingle ? '' : 'none';
    document.getElementById('multiMonthPreview').style.display = isSingle ? 'none' : '';
    
    if(isSingle) {
        await populateSingleMonthDropdown();
    } else {
        await buildMonthSelectorGrid();
    }
}

async function populateSingleMonthDropdown() {
    const mid = document.getElementById('pMember').value;
    const gid = document.getElementById('pGroup').value;
    const sel = document.getElementById('pSingleMonthSlot');
    
    if (!mid || !gid) {
        sel.innerHTML = '<option value="">-- Select member & group first --</option>';
        return;
    }
    
    const gs = await getCollection('groups');
    const grp = gs.find(g => g.id === gid);
    if (!grp) return;
    
    const eid=document.getElementById('pEnrollmentId').value||'';
    const sn=parseInt(document.getElementById('pSlotNum').value||'1');
    const {paidSlots, allDueDates} = await getPaidSlots(mid, gid, grp, eid, sn);
    const chitAmount=parseFloat(document.getElementById('pChit').value)||0;
    const isVariableAmount=grp&&grp.amtType==='variable';
    const ps=await getCollection('payments');
    const today=new Date().toISOString().split('T')[0];
    
    sel.innerHTML = allDueDates.map((dd, i) => {
        const paid = paidSlots.has(i);
        const isPast = dd < today;
        let status = '';
        
        if(isVariableAmount){
            if(paid){
                let totalPaidForMonth=0;
                ps.forEach(p=>{
                    if(p.memberId!==mid||p.groupId!==gid)return;
                    const pSlot=p.slotNum?Number(p.slotNum):1;
                    if(pSlot!==Number(sn))return;
                    if(eid&&p.enrollmentId&&p.enrollmentId!==''){if(p.enrollmentId!==eid)return;}
                    if(Array.isArray(p.monthSlots)&&p.monthSlots.includes(i)){totalPaidForMonth+=parseFloat(p.paid)||0;}
                    else if(p.monthSlot===i){totalPaidForMonth+=parseFloat(p.paid)||0;}
                });
                if(totalPaidForMonth>0){
                    status=' ⚠ Partial';
                }
            }else if(isPast){
                status=' ⚠ Overdue';
            }else{
                status=' (Upcoming)';
            }
        }else{
            if(paid){
                let totalPaidForMonth=0;
                ps.forEach(p=>{
                    if(p.memberId!==mid||p.groupId!==gid)return;
                    const pSlot=p.slotNum?Number(p.slotNum):1;
                    if(pSlot!==Number(sn))return;
                    if(eid&&p.enrollmentId&&p.enrollmentId!==''){if(p.enrollmentId!==eid)return;}
                    if(Array.isArray(p.monthSlots)&&p.monthSlots.includes(i)){totalPaidForMonth+=parseFloat(p.paid)||0;}
                    else if(p.monthSlot===i){totalPaidForMonth+=parseFloat(p.paid)||0;}
                });
                if(chitAmount>0&&totalPaidForMonth>=chitAmount){
                    status=' ✅ Paid';
                }else if(chitAmount>0&&totalPaidForMonth>0){
                    status=' ⚠ Partial';
                }else{
                    status=' ✅ Paid';
                }
            }else if(isPast){
                status=' ⚠ Overdue';
            }else{
                status=' (Upcoming)';
            }
        }
        const label = fmtDate(dd) + status;
        return `<option value="${i}">${label}</option>`;
    }).join('');
    
    sel.value = '';
    onSingleMonthSlotChange();
}

function onSingleMonthSlotChange() {
    const slotVal = document.getElementById('pSingleMonthSlot').value;
    const badge = document.getElementById('singleMonthBadge');
    
    if (slotVal === '') {
        badge.style.display = 'none';
    } else {
        badge.style.display = 'block';
        badge.textContent = '📅 Month ' + (parseInt(slotVal) + 1);
        badge.style.background = 'rgba(34,197,94,0.1)';
        badge.style.borderColor = 'rgba(34,197,94,0.4)';
        badge.style.color = '#34d399';
    }
    
    calcBalance();
    updateChitPickedOptionForMode();
}

async function updateChitPickedOptionForMode() {
    const mode = document.getElementById('pNumMonths').value;
    
    if (mode === '1') {
        // Single month mode
        const slotVal = document.getElementById('pSingleMonthSlot').value;
        if (slotVal === '') return;
        
        const mid = document.getElementById('pMember').value;
        const gid = document.getElementById('pGroup').value;
        const eid2 = document.getElementById('pEnrollmentId').value||'';
        const slotNum = parseInt(document.getElementById('pSlotNum').value||'1');
        const chitSelect = document.getElementById('pChitPicked');
        const yesOption = chitSelect.querySelector('option[value="Yes"]');
        
        const ps = await getCollection('payments');
        const alreadyPicked = await isChitAlreadyPicked(ps, mid, gid, eid2, slotNum);
        yesOption.disabled = alreadyPicked;
        if (alreadyPicked) chitSelect.value = 'No';
    } else {
        // Multiple month mode
        await updateChitPickedOption();
    }
}
async function updateChitPickedOption() {
    try {
        const monthSlots = getSelectedMonthSlots();
        const mid = document.getElementById('pMember').value;
        const gid = document.getElementById('pGroup').value;
        const chitSelect = document.getElementById('pChitPicked');
        const yesOption = chitSelect ? chitSelect.querySelector('option[value="Yes"]') : null;
        
        if (!yesOption || !mid || !gid || monthSlots.length === 0) {
            if (yesOption) yesOption.disabled = false;
            return;
        }
        
        const eid3 = document.getElementById('pEnrollmentId').value||'';
        const slotNum = parseInt(document.getElementById('pSlotNum').value||'1');
        // Only block if THIS enrollment slot already picked — other slots are independent
        const ps = await getCollection('payments');
        const alreadyPicked = await isChitAlreadyPicked(ps, mid, gid, eid3, slotNum);
        yesOption.disabled = alreadyPicked;
        if (alreadyPicked) chitSelect.value = 'No';
    } catch(error) {
        console.error('Error in updateChitPickedOption:', error);
    }
}
