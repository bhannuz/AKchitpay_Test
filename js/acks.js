// ═══════════════════════════════════════════════════════════
// AK Chit Funds — WHATSAPP ACKNOWLEDGEMENT QUEUE
//  • Every payment is queued (chit-picked payments get a 2nd message)
//  • Message text is editable per message, and the default templates are editable
//  • The member's statement can be attached as a PDF
// Payment fields used:  ackPay / ackChit : 'pending' | 'sent' | 'skipped'
// ═══════════════════════════════════════════════════════════

let _ackFilter = 'pending';
let _ackCache  = {};            // "pid:kind" -> item (filled when the list renders)
let _ackPdf    = null;          // { file, url } for the open editor

const _ACK_STMT_LINE = 'Your account statement is attached for your reference.';

// ── tiny self-contained helpers (no dependency on other scripts) ──
function _ackEsc(s){ return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function _ackAmt(v){ return '\u20b9'+(Math.round(parseFloat(v)||0)).toLocaleString('en-IN'); }
function _ackPdfAmt(v){ return 'Rs.'+(Math.round(parseFloat(v)||0)).toLocaleString('en-IN'); }
const _ACK_MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const _ACK_MONTH=['January','February','March','April','May','June','July','August','September','October','November','December'];
function _ackDate(iso){
    if(!iso) return '—';
    const [y,m,d]=String(iso).split('-');
    return `${d}.${_ACK_MON[parseInt(m,10)-1]}.${y}`;
}
function _ackPaidBy(v){
    if(!v) return '';
    const m=String(v).toLowerCase();
    if(m.includes('phone')||m.includes('pe')) return 'Phone Pe';
    if(m.includes('gpay')) return 'Gpay';
    if(m.includes('bank')) return 'Bank';
    if(m.includes('cash')) return 'Cash';
    return String(v);
}
function _ackPhone(m){
    let ph=((m&&m.phone)||'').replace(/\D/g,'');
    if(ph.length===10) ph='91'+ph;
    return ph;
}
function _ackSlots(p){
    return (Array.isArray(p.monthSlots)&&p.monthSlots.length)?p.monthSlots:(p.monthSlot!=null?[p.monthSlot]:[]);
}
function _ackMonthLabels(g,p,full){
    const due=getGroupDueDates(g)||[];
    return _ackSlots(p).slice().sort((a,b)=>a-b).map(i=>{
        const d=due[i]; if(!d) return null;
        const [y,mo]=d.split('-');
        return `${(full?_ACK_MONTH:_ACK_MON)[parseInt(mo,10)-1]} ${y}`;
    }).filter(Boolean);
}

// ═══════════════ TEMPLATES (editable defaults) ═══════════════
const _ACK_DEFAULT_TPL = {
pay:
`Dear {name},

Greetings from *AK Chit Funds*.

We gratefully acknowledge the receipt of your payment. Details are given below.

*Payment Receipt*
Group: {group}
Month(s): {months}
Payment date: {date}
Amount received: {amount}
Mode: {mode}
Balance amount: {balance}
Status: {status}

{note}

Warm regards,
*AK Chit Funds*`,
chit:
`Dear {name},

Greetings from *AK Chit Funds*.

This is to acknowledge that you have picked the chit for the month of *{month}* in the group *{group}*.

*Chit Details*
Group: {group}
Month: {month}
Chit value: {value}
Recorded on: {date}

Our team will contact you shortly regarding the next steps. For any clarification, please feel free to reach out to us.

Thank you for your continued trust in us.

Warm regards,
*AK Chit Funds*`
};

const _ACK_PLACEHOLDERS = {
    pay:  '{name} {group} {months} {date} {amount} {mode} {chitDue} {balance} {status} {note}',
    chit: '{name} {group} {month} {value} {date}'
};

function _ackGetTpl(kind){
    try{ const t=localStorage.getItem('ak_ack_tpl_'+kind); if(t&&t.trim()) return t; }catch(e){}
    return _ACK_DEFAULT_TPL[kind];
}

// Replace {placeholders}; a line whose placeholder is empty is dropped entirely
function _ackFill(tpl,vars){
    const out=tpl.split('\n').map(line=>{
        let drop=false;
        const res=line.replace(/\{(\w+)\}/g,(all,key)=>{
            if(!(key in vars)) return all;
            const v=vars[key];
            if(v===''||v==null){ drop=true; return ''; }
            return v;
        });
        return drop?null:res;
    }).filter(l=>l!==null).join('\n');
    return out.replace(/\n{3,}/g,'\n\n').trim();
}

// Balance still pending for the month(s) this payment covers, counting every earlier
// part-payment of those months (and this one). Falls back to the saved value.
function _ackBalanceAfter(g,p,allPays){
    try{
        if(!Array.isArray(allPays)) throw 0;
        const dues=getGroupDueDates(g)||[];
        const sn=Number(p.slotNum||1), eid=p.enrollmentId||'';
        const same=allPays.filter(x=>x.memberId===p.memberId&&x.groupId===p.groupId
            && (!eid||!x.enrollmentId||x.enrollmentId===eid)
            && Number(x.slotNum||1)===sn);
        const key=x=>(x.date||'')+'|'+(x.id||'');
        const upto=same.filter(x=>key(x)<=key(p));
        const members=parseInt(g.members||g.gMembers||0), amount=parseFloat(g.amount||g.gAmount||0);
        const chit=parseFloat(p.chit)>0?parseFloat(p.chit):(members>0&&amount>0?Math.round(amount/members):0);
        const slotsOf=x=>(Array.isArray(x.monthSlots)&&x.monthSlots.length)?x.monthSlots:null;
        const share=x=>(parseFloat(x.paid)||0)/(slotsOf(x)?slotsOf(x).length:1);
        const inMonth=(x,i)=>Array.isArray(x.monthSlots)?x.monthSlots.includes(i):(x.monthSlot!=null?x.monthSlot===i:getMonthSlot(dues,x.date)===i);
        let months=_ackSlots(p);
        if(!months.length){ const i=getMonthSlot(dues,p.date); months=i>=0?[i]:[]; }
        if(!months.length||!chit) throw 0;
        let bal=0;
        months.forEach(i=>{
            const paid=upto.filter(x=>inMonth(x,i)).reduce((s,x)=>s+share(x),0);
            bal+=Math.max(0,chit-paid);
        });
        return Math.round(bal);
    }catch(e){
        return Math.max(0,parseFloat(p.balance)||0);
    }
}

function _ackVars(kind,m,g,p,allPays){
    if(kind==='chit'){
        return {
            name:m.name||'Member', group:g.name||'',
            month:_ackMonthLabels(g,p,true)[0]||'the selected month',
            value:(parseFloat(p.chitPickedBy)>0)?_ackAmt(p.chitPickedBy):'',
            date:_ackDate(p.date)
        };
    }
    const nMonths=parseInt(p.numMonths)||1;
    const chitDue=(parseFloat(p.chit)||0)*nMonths;
    const bal=_ackBalanceAfter(g,p,allPays);
    return {
        name:m.name||'Member', group:g.name||'',
        months:_ackMonthLabels(g,p,false).join(', '),
        date:_ackDate(p.date),
        amount:_ackAmt(p.paid),
        mode:_ackPaidBy(p.paidBy),
        chitDue:chitDue>0?_ackAmt(chitDue):'',
        balance:_ackAmt(bal),
        status:bal>0?`Balance pending ${_ackAmt(bal)}`:'Paid in full',
        note:bal>0?'Kindly clear the pending balance at your earliest convenience.':'Thank you for your prompt payment.'
    };
}

function buildAckMessage(kind,m,g,p,allPays){
    return _ackFill(_ackGetTpl(kind),_ackVars(kind,m,g,p,allPays));
}

// ═══════════════ STATEMENT PDF ═══════════════
function _ackBuildStatementPdf(m,g,p,allPays){
    const jsPDF=window.jspdf&&window.jspdf.jsPDF;
    if(!jsPDF) throw new Error('PDF library not loaded');
    const sn=Number(p.slotNum||1), eid=p.enrollmentId||'';
    const slotPays=allPays.filter(x=>x.memberId===m.id&&x.groupId===g.id
            && (!eid||!x.enrollmentId||x.enrollmentId===eid)
            && Number(x.slotNum||1)===sn)
        .sort((a,b)=>(a.date||'').localeCompare(b.date||''));
    const dues=getGroupDueDates(g)||[];
    const last=slotPays.length?slotPays[slotPays.length-1]:null;
    const members=parseInt(g.members||g.gMembers||0), amount=parseFloat(g.amount||g.gAmount||0);
    const chitAmount=last&&parseFloat(last.chit)>0?parseFloat(last.chit):(members>0&&amount>0?Math.round(amount/members):0);
    const share=x=>(parseFloat(x.paid)||0)/(_ackSlots(x).length>1?_ackSlots(x).length:1);
    const inMonth=(x,i)=>Array.isArray(x.monthSlots)?x.monthSlots.includes(i):(x.monthSlot!=null?x.monthSlot===i:getMonthSlot(dues,x.date)===i);
    const today=new Date().toISOString().split('T')[0];

    const body=[]; let dueTillDateBal=0;
    dues.forEach((dd,i)=>{
        const mp=slotPays.filter(x=>inMonth(x,i));
        const tot=mp.reduce((s,x)=>s+share(x),0);
        const mbal=Math.max(0,chitAmount-tot);
        if(dd<=today) dueTillDateBal+=mbal;
        const full=mp.length>0&&tot>=chitAmount, part=mp.length>0&&tot>0&&mbal>0;
        const status=full?'Paid':part?'Partial':(dd<today?'Overdue':'Pending');
        const col=full?[6,95,70]:part?[146,64,14]:(status==='Overdue'?[185,28,28]:[110,110,110]);
        if(!mp.length){
            body.push([i+1,_ackDate(dd),chitAmount?_ackPdfAmt(chitAmount):'-','-','-','-',{content:status,styles:{textColor:col,fontStyle:'bold'}},'-']);
            return;
        }
        let cum=0;
        mp.forEach((x,k)=>{
            cum+=share(x);
            const rb=Math.max(0,chitAmount-cum);
            const multi=_ackSlots(x).length>1;
            const paidTxt=multi?(Math.min.apply(null,_ackSlots(x))===i?`${_ackPdfAmt(x.paid)} (${_ackSlots(x).length} mo)`:'(bulk payment)'):_ackPdfAmt(x.paid);
            body.push([
                k===0?i+1:'',
                k===0?_ackDate(dd)+(x.chitPicked==='Yes'?'  [Chit picked]':''):`  Payment ${k+1}`+(x.chitPicked==='Yes'?'  [Chit picked]':''),
                k===0?(chitAmount?_ackPdfAmt(chitAmount):'-'):'',
                _ackDate(x.date), paidTxt, _ackPdfAmt(rb),
                k===mp.length-1?{content:status,styles:{textColor:col,fontStyle:'bold'}}:'',
                _ackPaidBy(x.paidBy)||'-'
            ]);
        });
    });

    const totalPaid=slotPays.reduce((s,x)=>s+(parseFloat(x.paid)||0),0);
    const fullTermBal=Math.max(0,dues.length*chitAmount-totalPaid);
    const picked=slotPays.find(x=>x.chitPicked==='Yes');
    const pickedTxt=picked?('Yes'+(_ackMonthLabels(g,picked,false)[0]?' ('+_ackMonthLabels(g,picked,false)[0]+')':'')):'No';

    const doc=new jsPDF({unit:'mm',format:'a4'});
    const W=doc.internal.pageSize.getWidth();
    doc.setFillColor(30,41,59); doc.rect(0,0,W,24,'F');
    doc.setTextColor(255,255,255); doc.setFont('helvetica','bold'); doc.setFontSize(18); doc.text('AK Chit Funds',14,12);
    doc.setFontSize(10); doc.setFont('helvetica','normal'); doc.text('Account Statement',14,19);
    doc.text('Generated: '+_ackDate(today),W-14,19,{align:'right'});
    doc.setTextColor(30,30,30);
    doc.setFont('helvetica','bold'); doc.setFontSize(12); doc.text(m.name||'Member',14,34);
    doc.setFont('helvetica','normal'); doc.setFontSize(10);
    let y=40;
    doc.text('Group: '+(g.name||''),14,y);
    if(m.phone) doc.text('Phone: '+m.phone,W-14,y,{align:'right'});
    y+=5;
    const slotTxt=slotPays.length&&Number(p.slotNum||1)>1?('Chit slot: '+Number(p.slotNum)):'';
    if(slotTxt){ doc.text(slotTxt,14,y); y+=5; }

    // summary boxes
    y+=2;
    const boxes=[
        ['Total paid',_ackPdfAmt(totalPaid)],
        ['Balance due till date',_ackPdfAmt(dueTillDateBal)],
        ['Balance (full term)',_ackPdfAmt(fullTermBal)],
        ['Chit picked',pickedTxt]
    ];
    const bw=(W-28-9)/4;
    boxes.forEach((b,k)=>{
        const x=14+k*(bw+3);
        doc.setDrawColor(200,205,215); doc.setFillColor(245,247,252); doc.roundedRect(x,y,bw,15,2,2,'FD');
        doc.setFontSize(7.5); doc.setTextColor(110,110,110); doc.text(b[0],x+3,y+5.5);
        doc.setFontSize(10); doc.setFont('helvetica','bold'); doc.setTextColor(30,30,30); doc.text(String(b[1]),x+3,y+11.5);
        doc.setFont('helvetica','normal');
    });
    y+=20;

    doc.autoTable({
        startY:y,
        head:[['#','Due date','Chit/Mo','Pay date','Paid','Balance','Status','Mode']],
        body,
        theme:'grid',
        styles:{fontSize:8,cellPadding:1.6,lineColor:[220,224,232],lineWidth:0.1},
        headStyles:{fillColor:[30,41,59],textColor:255,fontStyle:'bold',halign:'center'},
        columnStyles:{0:{halign:'center',cellWidth:8},2:{halign:'center'},3:{halign:'center'},4:{halign:'center'},5:{halign:'center'},6:{halign:'center'},7:{halign:'center'}},
        margin:{left:14,right:14},
        didDrawPage:()=>{
            const H=doc.internal.pageSize.getHeight();
            doc.setFontSize(7.5); doc.setTextColor(130,130,130);
            doc.text('This is a computer-generated statement from AK Chit Funds.',14,H-8);
        }
    });

    const safe=s=>String(s||'').replace(/[^A-Za-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
    const name=`Statement_${safe(m.name)}_${safe(g.name)}_${today}.pdf`;
    const blob=doc.output('blob');
    const file=new File([blob],name,{type:'application/pdf'});
    return {file,url:URL.createObjectURL(blob)};
}

// ═══════════════ QUEUE DATA ═══════════════
async function _ackItems(){
    const [ps,ms,gs]=await Promise.all([getCollection('payments'),getCollection('members'),getCollection('groups')]);
    const items=[];
    ps.forEach(p=>{
        const m=ms.find(x=>x.id===p.memberId), g=gs.find(x=>x.id===p.groupId);
        if(!m||!g) return;
        if(p.ackPay)  items.push({kind:'pay', status:p.ackPay, p,m,g,allPays:ps});
        if(p.ackChit) items.push({kind:'chit',status:p.ackChit,p,m,g,allPays:ps});
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
    }catch(e){ /* cosmetic */ }
}

// ═══════════════ QUEUE UI ═══════════════
async function openAckQueue(){
    let ov=document.getElementById('ackQueueModal'); if(ov) ov.remove();
    ov=document.createElement('div');
    ov.id='ackQueueModal'; ov.className='modal-overlay';
    ov.style.cssText='display:block;z-index:2000;';
    ov.innerHTML=`<div class="modal-content-custom" style="max-height:92vh;overflow-y:auto;padding:14px 16px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
            <div style="font-size:1.05rem;font-weight:800;color:#25D366;flex:1;">💬 WhatsApp Acknowledgements</div>
            <button type="button" onclick="openAckTemplates()" title="Edit default message text" style="background:rgba(99,102,241,0.15);border:1px solid rgba(99,102,241,0.35);color:#a5b4fc;border-radius:8px;font-size:0.75rem;font-weight:700;cursor:pointer;padding:4px 8px;">✏️ Templates</button>
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
function closeAckQueue(){ const ov=document.getElementById('ackQueueModal'); if(ov) ov.remove(); refreshAckBadge(); }
function setAckFilter(f){ _ackFilter=f; renderAckList(); }

async function renderAckList(){
    const list=document.getElementById('ackList'); if(!list) return;
    const all=await _ackItems();
    const pending=all.filter(i=>i.status==='pending');
    const sent=all.filter(i=>i.status==='sent');
    const tabStyle=(on,col)=>on?`background:${col};border:1px solid ${col};color:#fff;`:'background:var(--input-bg);border:1px solid var(--border);color:var(--text-dim);';
    const tp=document.getElementById('ackTabPending'), ts=document.getElementById('ackTabSent');
    tp.textContent=`Pending (${pending.length})`; tp.style.cssText+=tabStyle(_ackFilter==='pending','#f59e0b');
    ts.textContent=`Sent (${sent.length})`;       ts.style.cssText+=tabStyle(_ackFilter==='sent','#10b981');

    const rows=_ackFilter==='pending'?pending:sent.slice(0,50);
    if(!rows.length){
        list.innerHTML=`<div style="text-align:center;color:var(--text-dim);padding:28px 8px;font-size:0.9rem;">${_ackFilter==='pending'?'🎉 All caught up — no pending acknowledgements.':'Nothing sent yet.'}</div>`;
        return;
    }
    _ackCache={};
    const isPending=_ackFilter==='pending';
    list.innerHTML=rows.map(it=>{
        const {p,m,g,kind}=it;
        _ackCache[p.id+':'+kind]=it;
        const phone=_ackPhone(m);
        const months=_ackMonthLabels(g,p,false).join(', ');
        const badge=kind==='chit'
            ? '<span style="background:#d1fae5;color:#065f46;border-radius:4px;padding:1px 6px;font-size:0.68rem;font-weight:800;">🏆 Chit picked</span>'
            : '<span style="background:#e0e7ff;color:#3730a3;border-radius:4px;padding:1px 6px;font-size:0.68rem;font-weight:800;">💳 Payment</span>';
        let quick='', err='';
        try{
            const msg=buildAckMessage(kind,m,g,p,it.allPays);
            if(phone) quick='https://wa.me/'+phone+'?text='+encodeURIComponent(msg);
        }catch(e){ console.error('Ack message error:',e); err=e.message||'message error'; }
        const mainBtn=`<button type="button" ${phone?'':'disabled'} onclick="openAckEditor('${p.id}','${kind}')" class="btn fw-bold" style="flex:1;border-radius:10px;padding:8px;font-size:0.85rem;background:#25D366;border:none;color:#fff;${phone?'':'opacity:.4;'}">✏️ Review &amp; Send ${isPending?'':'again'}</button>`;
        const quickBtn=quick?`<a href="${quick}" target="_blank" rel="noopener" onclick="${isPending?`markAckSent('${p.id}','${kind}')`:''}" title="Send the text straight away, without editing or statement" style="border-radius:10px;padding:8px 10px;font-size:0.8rem;font-weight:700;text-decoration:none;display:flex;align-items:center;background:rgba(37,211,102,0.15);border:1px solid rgba(37,211,102,0.4);color:#25D366;">⚡ Text</a>`:'';
        return `<div style="background:var(--input-bg);border:1px solid var(--border);border-radius:12px;padding:10px 12px;margin-bottom:8px;">
            <div style="min-width:0;">
                <div style="font-weight:800;font-size:0.92rem;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${_ackEsc(m.name)} ${badge}</div>
                <div style="font-size:0.76rem;color:var(--text-dim);">${_ackEsc(g.name)}${months?' · '+_ackEsc(months):''}</div>
                <div style="font-size:0.76rem;color:var(--text-dim);">${_ackDate(p.date)} · <b style="color:#34d399;">${_ackAmt(p.paid)}</b>${phone?'':' · <span style="color:#f87171;">No phone</span>'}${err?` · <span style="color:#f87171;">${_ackEsc(err)}</span>`:''}</div>
            </div>
            <div style="display:flex;gap:6px;margin-top:8px;align-items:stretch;">
                ${mainBtn}${quickBtn}
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
    try{ await _ackSetStatus(pid,kind,'skipped'); await renderAckList(); refreshAckBadge(); }
    catch(err){ console.error(err); showToast('❌ Failed',false); }
}

// ═══════════════ EDITOR (edit text + attach statement) ═══════════════
function _ackSyncStmtLine(ta,on){
    let t=ta.value;
    if(on){
        if(t.includes(_ACK_STMT_LINE)) return;
        const idx=t.indexOf('Warm regards,');
        t=idx>=0?t.slice(0,idx)+_ACK_STMT_LINE+'\n\n'+t.slice(idx):t.trimEnd()+'\n\n'+_ACK_STMT_LINE;
    }else{
        t=t.replace(_ACK_STMT_LINE+'\n\n','').replace(_ACK_STMT_LINE,'');
    }
    ta.value=t;
}

async function openAckEditor(pid,kind){
    const it=_ackCache[pid+':'+kind]; if(!it) return;
    const {p,m,g}=it;
    const phone=_ackPhone(m);
    let ov=document.getElementById('ackEditorModal'); if(ov) ov.remove();
    if(_ackPdf&&_ackPdf.url){ try{URL.revokeObjectURL(_ackPdf.url);}catch(e){} }
    _ackPdf=null;

    let attachPref='1'; try{ attachPref=localStorage.getItem('ak_ack_attach')||'1'; }catch(e){}
    ov=document.createElement('div');
    ov.id='ackEditorModal'; ov.className='modal-overlay';
    ov.style.cssText='display:block;z-index:2200;';
    ov.innerHTML=`<div class="modal-content-custom" style="max-height:94vh;overflow-y:auto;padding:14px 16px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
            <div style="font-size:1rem;font-weight:800;color:#25D366;flex:1;">${kind==='chit'?'🏆 Chit Picked':'💳 Payment'} Acknowledgement</div>
            <button type="button" onclick="closeAckEditor()" style="background:none;border:none;color:var(--text-dim);font-size:1.3rem;cursor:pointer;padding:2px 6px;">✕</button>
        </div>
        <div style="font-size:0.78rem;color:var(--text-dim);margin-bottom:6px;">To: <b style="color:#fff;">${_ackEsc(m.name)}</b> &nbsp;📞 +${phone}</div>
        <textarea id="ackEditText" class="form-input" rows="15" style="font-size:0.82rem;resize:vertical;margin-bottom:6px;"></textarea>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <button type="button" id="ackResetText" style="background:none;border:none;color:#a5b4fc;font-size:0.76rem;cursor:pointer;padding:0;">↺ Reset to default text</button>
            <span style="font-size:0.7rem;color:var(--text-dim);">Edit freely before sending</span>
        </div>
        <label style="display:flex;align-items:center;gap:8px;background:rgba(99,102,241,0.1);border:1px solid rgba(99,102,241,0.3);border-radius:10px;padding:8px 10px;margin-bottom:6px;cursor:pointer;">
            <input type="checkbox" id="ackAttach" style="width:16px;height:16px;margin:0;" ${attachPref==='1'?'checked':''}>
            <span style="font-size:0.84rem;font-weight:700;color:#fff;flex:1;">📎 Attach statement (PDF)</span>
            <a id="ackViewPdf" href="#" target="_blank" style="display:none;font-size:0.76rem;color:#a5b4fc;">👁 View</a>
        </label>
        <div id="ackPdfStatus" style="font-size:0.72rem;color:var(--text-dim);margin-bottom:8px;min-height:16px;"></div>
        <div style="display:flex;gap:8px;">
            <button type="button" id="ackEditSend" class="btn fw-bold" style="flex:1;border-radius:12px;padding:11px;background:#25D366;border:none;color:#fff;">💬 Send on WhatsApp</button>
            <button type="button" onclick="closeAckEditor()" class="btn fw-bold" style="border-radius:12px;padding:11px 16px;background:var(--input-bg);border:1px solid var(--border);color:#fff;">Cancel</button>
        </div>
    </div>`;
    document.body.appendChild(ov);

    const ta=document.getElementById('ackEditText');
    const cb=document.getElementById('ackAttach');
    const st=document.getElementById('ackPdfStatus');
    const view=document.getElementById('ackViewPdf');
    const sendBtn=document.getElementById('ackEditSend');
    ta.value=buildAckMessage(kind,m,g,p,it.allPays);
    if(cb.checked) _ackSyncStmtLine(ta,true);

    document.getElementById('ackResetText').onclick=()=>{
        ta.value=buildAckMessage(kind,m,g,p,it.allPays);
        if(cb.checked) _ackSyncStmtLine(ta,true);
    };
    cb.onchange=()=>{
        try{ localStorage.setItem('ak_ack_attach',cb.checked?'1':'0'); }catch(e){}
        _ackSyncStmtLine(ta,cb.checked);
        view.style.display=(cb.checked&&_ackPdf)?'inline':'none';
        st.textContent=cb.checked?(_ackPdf?('Ready: '+_ackPdf.file.name):'Preparing statement…'):'';
    };

    // Pre-build the PDF now so the Send click can act immediately (browsers need that for sharing)
    (async()=>{
        try{
            st.textContent='Preparing statement…';
            const allPays=await getCollection('payments');
            const res=_ackBuildStatementPdf(m,g,p,allPays);
            if(!document.getElementById('ackEditorModal')){ URL.revokeObjectURL(res.url); return; }
            _ackPdf=res;
            view.href=res.url;
            view.style.display=cb.checked?'inline':'none';
            st.textContent=cb.checked?('Ready: '+res.file.name):'';
        }catch(e){
            console.error('Statement PDF error:',e);
            st.innerHTML='<span style="color:#f87171;">Statement could not be prepared: '+_ackEsc(e.message||e)+'</span>';
        }
    })();

    sendBtn.onclick=()=>{
        const text=ta.value.trim();
        if(!text){ showToast('❌ Message is empty',false); return; }
        const attach=cb.checked;
        if(attach&&!_ackPdf){ showToast('⏳ Statement is still being prepared — try again in a moment',false); return; }
        const wa='https://wa.me/'+phone+'?text='+encodeURIComponent(text);
        const done=async()=>{
            closeAckEditor();
            if(_ackFilter==='pending'){ try{ await _ackSetStatus(pid,kind,'sent'); }catch(e){ console.error(e); } }
            renderAckList(); refreshAckBadge();
        };
        if(!attach){ window.open(wa,'_blank'); done(); return; }

        // Phones / browsers that can share files: PDF + text go together through the share sheet
        const canShare=navigator.canShare&&navigator.canShare({files:[_ackPdf.file]});
        if(canShare){
            navigator.share({files:[_ackPdf.file],text}).then(done).catch(err=>{
                if(err&&err.name==='AbortError') return;      // user cancelled the share sheet
                console.warn('Share failed, using download fallback:',err);
                _ackDownloadAndOpen(wa); done();
            });
            return;
        }
        // Desktop: download the PDF and open the chat with the text — attach the PDF there
        _ackDownloadAndOpen(wa);
        done();
    };
}

function _ackDownloadAndOpen(wa){
    const a=document.createElement('a');
    a.href=_ackPdf.url; a.download=_ackPdf.file.name;
    document.body.appendChild(a); a.click(); a.remove();
    window.open(wa,'_blank');
    showToast('📎 Statement PDF downloaded — attach it in the WhatsApp chat');
}

function closeAckEditor(){
    const ov=document.getElementById('ackEditorModal'); if(ov) ov.remove();
}

// ═══════════════ TEMPLATE EDITOR ═══════════════
function openAckTemplates(){
    let ov=document.getElementById('ackTplModal'); if(ov) ov.remove();
    ov=document.createElement('div');
    ov.id='ackTplModal'; ov.className='modal-overlay';
    ov.style.cssText='display:block;z-index:2200;';
    const block=(kind,title)=>`
        <div style="font-weight:800;font-size:0.88rem;color:#fff;margin:10px 0 2px;">${title}</div>
        <div style="font-size:0.7rem;color:var(--text-dim);margin-bottom:4px;">Placeholders: <span style="color:#a5b4fc;">${_ACK_PLACEHOLDERS[kind]}</span></div>
        <textarea id="ackTpl_${kind}" class="form-input" rows="12" style="font-size:0.78rem;resize:vertical;"></textarea>
        <button type="button" onclick="resetAckTpl('${kind}')" style="background:none;border:none;color:#a5b4fc;font-size:0.74rem;cursor:pointer;padding:2px 0;">↺ Reset to original</button>`;
    ov.innerHTML=`<div class="modal-content-custom" style="max-height:94vh;overflow-y:auto;padding:14px 16px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
            <div style="font-size:1rem;font-weight:800;color:#a5b4fc;flex:1;">✏️ Default Message Text</div>
            <button type="button" onclick="document.getElementById('ackTplModal').remove()" style="background:none;border:none;color:var(--text-dim);font-size:1.3rem;cursor:pointer;padding:2px 6px;">✕</button>
        </div>
        <div style="font-size:0.74rem;color:var(--text-dim);">These texts are used for every new acknowledgement. Use *text* for bold. A line whose placeholder has no value is skipped automatically. Saved on this device.</div>
        ${block('pay','💳 After every payment')}
        ${block('chit','🏆 When chit is picked')}
        <div style="display:flex;gap:8px;margin-top:10px;">
            <button type="button" onclick="saveAckTemplates()" class="btn fw-bold" style="flex:1;border-radius:12px;padding:10px;background:#6366f1;border:none;color:#fff;">💾 Save</button>
            <button type="button" onclick="document.getElementById('ackTplModal').remove()" class="btn fw-bold" style="border-radius:12px;padding:10px 16px;background:var(--input-bg);border:1px solid var(--border);color:#fff;">Close</button>
        </div>
    </div>`;
    document.body.appendChild(ov);
    document.getElementById('ackTpl_pay').value=_ackGetTpl('pay');
    document.getElementById('ackTpl_chit').value=_ackGetTpl('chit');
}
function resetAckTpl(kind){ document.getElementById('ackTpl_'+kind).value=_ACK_DEFAULT_TPL[kind]; }
function saveAckTemplates(){
    try{
        ['pay','chit'].forEach(k=>{
            const v=document.getElementById('ackTpl_'+k).value.trim();
            if(!v||v===_ACK_DEFAULT_TPL[k]) localStorage.removeItem('ak_ack_tpl_'+k);
            else localStorage.setItem('ak_ack_tpl_'+k,v);
        });
        showToast('✅ Message text saved');
        document.getElementById('ackTplModal').remove();
        renderAckList();
    }catch(e){ showToast('❌ Could not save: '+(e.message||e),false); }
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
