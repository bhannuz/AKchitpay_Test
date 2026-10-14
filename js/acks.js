// ═══════════════════════════════════════════════════════════
// AK Chit Funds — WHATSAPP ACKNOWLEDGEMENT QUEUE (one-tap)
// Every new payment is queued here. Tap "Send" -> WhatsApp opens with the
// message ready, you press send there. Chit-picked payments get a 2nd message.
// Payment fields used:  ackPay: 'pending'|'sent'|'skipped'
//                       ackChit: 'pending'|'sent'|'skipped'  (only when chit picked)
// ═══════════════════════════════════════════════════════════

let _ackFilter = 'pending';

function _ackEsc(s){ return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function _ackPhone(m){
    let ph=((m&&m.phone)||'').replace(/\D/g,'');
    if(ph.length===10) ph='91'+ph;
    return ph;
}

function _ackMonthLabels(g, p, full){
    const due=getGroupDueDates(g)||[];
    const slots=(Array.isArray(p.monthSlots)&&p.monthSlots.length)?p.monthSlots:(p.monthSlot!=null?[p.monthSlot]:[]);
    const sn=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const fn=['January','February','March','April','May','June','July','August','September','October','November','December'];
    return slots.slice().sort((a,b)=>a-b).map(i=>{
        const d=due[i]; if(!d) return null;
        const [y,mo]=d.split('-');
        return `${(full?fn:sn)[parseInt(mo,10)-1]} ${y}`;
    }).filter(Boolean);
}

function buildPaymentAckMessage(m,g,p){
    const months=_ackMonthLabels(g,p,false);
    const nMonths=parseInt(p.numMonths)||1;
    const paid=parseFloat(p.paid)||0;
    const chitDue=(parseFloat(p.chit)||0)*nMonths;
    const bal=Math.max(0,parseFloat(p.balance)||0);
    const L=[];
    L.push(`Dear ${m.name||'Member'},`);
    L.push('');
    L.push('Greetings from *AK Chit Funds*.');
    L.push('');
    L.push('We gratefully acknowledge the receipt of your payment. Details are given below.');
    L.push('');
    L.push('*Payment Receipt*');
    L.push(`Group: ${g.name||''}`);
    if(months.length) L.push(`${months.length>1?'Months':'Month'}: ${months.join(', ')}`);
    L.push(`Payment date: ${fmtDate(p.date)}`);
    L.push(`Amount received: ${fmtAmt(paid)}`);
    if(p.paidBy) L.push(`Mode: ${normalizePaidBy(p.paidBy)}`);
    if(chitDue>0) L.push(`Chit amount due: ${fmtAmt(chitDue)}`);
    L.push(bal>0 ? `Balance pending: ${fmtAmt(bal)}` : 'Status: Paid in full');
    L.push('');
    L.push(bal>0
        ? 'Kindly clear the pending balance at your earliest convenience.'
        : 'Thank you for your prompt payment.');
    L.push('');
    L.push('Warm regards,');
    L.push('*AK Chit Funds*');
    return L.join('\n');
}

function buildChitAckMessage(m,g,p){
    const months=_ackMonthLabels(g,p,true);
    return buildChitPickedMessage({
        name:m.name||'Member',
        groupName:g.name||'',
        monthLabel:months[0]||'the selected month',
        pickedValue:parseFloat(p.chitPickedBy)||0,
        dateLabel:fmtDate(p.date)
    });
}

// Build the flat list of queue items from the payments collection
async function _ackItems(){
    const [ps,ms,gs]=await Promise.all([getCollection('payments'),getCollection('members'),getCollection('groups')]);
    const items=[];
    ps.forEach(p=>{
        const m=ms.find(x=>x.id===p.memberId), g=gs.find(x=>x.id===p.groupId);
        if(!m||!g) return;
        if(p.ackPay) items.push({kind:'pay',status:p.ackPay,p,m,g});
        if(p.ackChit) items.push({kind:'chit',status:p.ackChit,p,m,g});
    });
    items.sort((a,b)=>((b.p.date||'')+b.p.id).localeCompare((a.p.date||'')+a.p.id));
    return items;
}

async function refreshAckBadge(){
    try{
        const el=document.getElementById('ackQueueCount');
        if(!el) return;
        const n=(await _ackItems()).filter(i=>i.status==='pending').length;
        el.textContent=n;
        el.style.display=n>0?'inline-block':'none';
    }catch(e){ /* badge is cosmetic */ }
}

async function openAckQueue(){
    let ov=document.getElementById('ackQueueModal');
    if(ov) ov.remove();
    ov=document.createElement('div');
    ov.id='ackQueueModal';
    ov.className='modal-overlay';
    ov.style.cssText='display:block;z-index:2000;';
    ov.innerHTML=`<div class="modal-content-custom" style="max-height:92vh;overflow-y:auto;padding:14px 16px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
            <div style="font-size:1.05rem;font-weight:800;color:#25D366;flex:1;">💬 WhatsApp Acknowledgements</div>
            <button type="button" onclick="closeAckQueue()" style="background:none;border:none;color:var(--text-dim);font-size:1.3rem;cursor:pointer;padding:2px 6px;">✕</button>
        </div>
        <div style="display:flex;gap:6px;margin-bottom:10px;">
            <button type="button" id="ackTabPending" onclick="setAckFilter('pending')" class="btn fw-bold" style="flex:1;border-radius:10px;padding:7px;font-size:0.82rem;"></button>
            <button type="button" id="ackTabSent" onclick="setAckFilter('sent')" class="btn fw-bold" style="flex:1;border-radius:10px;padding:7px;font-size:0.82rem;"></button>
        </div>
        <div id="ackList"></div>
    </div>`;
    document.body.appendChild(ov);
    await renderAckList();
}

function closeAckQueue(){
    const ov=document.getElementById('ackQueueModal');
    if(ov) ov.remove();
    refreshAckBadge();
}

function setAckFilter(f){ _ackFilter=f; renderAckList(); }

async function renderAckList(){
    const list=document.getElementById('ackList');
    if(!list) return;
    const all=await _ackItems();
    const pending=all.filter(i=>i.status==='pending');
    const sent=all.filter(i=>i.status==='sent');
    const tabStyle=(on,col)=>on
        ? `background:${col};border:1px solid ${col};color:#fff;`
        : 'background:var(--input-bg);border:1px solid var(--border);color:var(--text-dim);';
    const tp=document.getElementById('ackTabPending'), ts=document.getElementById('ackTabSent');
    tp.textContent=`Pending (${pending.length})`; tp.style.cssText+=tabStyle(_ackFilter==='pending','#f59e0b');
    ts.textContent=`Sent (${sent.length})`;       ts.style.cssText+=tabStyle(_ackFilter==='sent','#10b981');

    const rows=_ackFilter==='pending'?pending:sent.slice(0,50);
    if(!rows.length){
        list.innerHTML=`<div style="text-align:center;color:var(--text-dim);padding:28px 8px;font-size:0.9rem;">${_ackFilter==='pending'?'🎉 All caught up — no pending acknowledgements.':'Nothing sent yet.'}</div>`;
        return;
    }
    list.innerHTML=rows.map(it=>{
        const {p,m,g,kind}=it;
        const phone=_ackPhone(m);
        const months=_ackMonthLabels(g,p,false).join(', ');
        const badge=kind==='chit'
            ? '<span style="background:#d1fae5;color:#065f46;border-radius:4px;padding:1px 6px;font-size:0.68rem;font-weight:800;">🏆 Chit picked</span>'
            : '<span style="background:#e0e7ff;color:#3730a3;border-radius:4px;padding:1px 6px;font-size:0.68rem;font-weight:800;">💳 Payment</span>';
        const isPending=_ackFilter==='pending';

        // Build the message up-front and use a REAL link, so the browser never blocks the WhatsApp tab
        let href='', err='';
        try{
            const msg=kind==='chit'?buildChitAckMessage(m,g,p):buildPaymentAckMessage(m,g,p);
            if(phone) href='https://wa.me/'+phone+'?text='+encodeURIComponent(msg);
        }catch(e){ console.error('Ack message error:',e); err=e.message||'message error'; }

        const btnBase='flex:1;border-radius:10px;padding:8px;font-size:0.85rem;font-weight:700;text-align:center;text-decoration:none;display:block;';
        const sendBtn = href
            ? `<a href="${href}" target="_blank" rel="noopener" onclick="${isPending?`markAckSent('${p.id}','${kind}')`:''}" style="${btnBase}background:#25D366;color:#fff;">💬 ${isPending?'Send':'Resend'}</a>`
            : `<span style="${btnBase}background:#25D366;color:#fff;opacity:.4;">💬 Send</span>`;
        return `<div style="background:var(--input-bg);border:1px solid var(--border);border-radius:12px;padding:10px 12px;margin-bottom:8px;">
            <div style="display:flex;align-items:center;gap:8px;">
                <div style="flex:1;min-width:0;">
                    <div style="font-weight:800;font-size:0.92rem;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${_ackEsc(m.name)} ${badge}</div>
                    <div style="font-size:0.76rem;color:var(--text-dim);">${_ackEsc(g.name)}${months?' · '+_ackEsc(months):''}</div>
                    <div style="font-size:0.76rem;color:var(--text-dim);">${fmtDate(p.date)} · <b style="color:#34d399;">${fmtAmt(p.paid)}</b>${phone?'':' · <span style="color:#f87171;">No phone</span>'}${err?` · <span style="color:#f87171;">${_ackEsc(err)}</span>`:''}</div>
                </div>
            </div>
            <div style="display:flex;gap:6px;margin-top:8px;align-items:stretch;">
                ${sendBtn}
                ${isPending?`<button type="button" onclick="skipAck('${p.id}','${kind}')" class="btn fw-bold" style="border-radius:10px;padding:8px 12px;font-size:0.8rem;background:var(--input-bg);border:1px solid var(--border);color:var(--text-dim);">Skip</button>`:''}
            </div>
        </div>`;
    }).join('');
}

async function _ackSetStatus(pid,kind,status){
    const field=kind==='chit'?'ackChit':'ackPay';
    await db.collection('payments').doc(pid).update({[field]:status});
    bustCache('payments');
}

// Called when the Send link is clicked (the link itself opens WhatsApp)
async function markAckSent(pid,kind){
    try{
        await _ackSetStatus(pid,kind,'sent');
        setTimeout(()=>{ renderAckList(); refreshAckBadge(); },600);
    }catch(err){
        console.error('Ack status error:',err);
        showToast('⚠️ Opened WhatsApp, but could not mark as sent: '+(err.message||err),false);
    }
}

async function skipAck(pid,kind){
    try{
        await _ackSetStatus(pid,kind,'skipped');
        await renderAckList();
        refreshAckBadge();
    }catch(err){ console.error(err); showToast('❌ Failed',false); }
}

// Keep the badge fresh whenever the app refreshes its UI
(function(){
    const _orig=window.updateUI;
    if(typeof _orig==='function'){
        window.updateUI=async function(...a){
            const r=await _orig.apply(this,a);
            refreshAckBadge();
            return r;
        };
    }
})();
