// ═══════════════════════════════════════════════════════════
// AK Chit Funds — CHIT PLANNER
// Edit only this file when changing the Chit Planner logic
// ═══════════════════════════════════════════════════════════

let _ncpActive = null;

// ── Firestore helpers — mirrors QR pattern exactly ───────────────────────────
async function _ncpFetch(){
    try{
        var doc = await db.collection('settings').doc('ncpPlanners').get();
        console.log('[NCP] fetch exists:', doc.exists);
        if(!doc.exists) return {};
        return doc.data().planners || {};
    }catch(e){ console.error('[NCP] fetch error:', e.code, e.message); return {}; }
}
async function _ncpWrite(planners){
    try{
        console.log('[NCP] writing', Object.keys(planners).length, 'version(s)');
        await db.collection('settings').doc('ncpPlanners').set({ planners: planners });
    }catch(e){ console.error('[NCP] write error:', e.code, e.message); }
}

// ── Null-safe field reader ────────────────────────────────────────────────────
function _ncpVal(id){ var el=document.getElementById(id); return el ? el.value : ''; }
function _ncpSet(id, val){ var el=document.getElementById(id); if(el) el.value = val||''; }

// ── Read current form values ─────────────────────────────────────────────────
function ncpSyncMembDur(){
    var m = parseInt(_ncpVal('ncp_members'))||0;
    var d = document.getElementById('ncp_duration');
    if(m > 0 && d && !d.value) d.value = m;
}

function ncpReadForm(){
    var rows = [];
    document.querySelectorAll('#ncp_rows .ncp-row').forEach(function(row){
        var pay=row.querySelector('.ncp-pay'); var chit=row.querySelector('.ncp-chit');
        rows.push({ pay: pay?pay.value:'', chit: chit?chit.value:'' });
    });
    var wrap = document.getElementById('ncp_tableWrap');
    return {
        amount:     _ncpVal('ncp_amount'),
        members:    _ncpVal('ncp_members'),
        duration:   _ncpVal('ncp_duration'),
        start:      _ncpVal('ncp_start'),
        dueday:     _ncpVal('ncp_dueday'),
        commission: _ncpVal('ncp_commission'),
        member:     _ncpVal('ncp_member'),
        incr_min:   _ncpVal('ncp_incr_min'),
        incr_max:   _ncpVal('ncp_incr_max'),
        rows:       rows,
        tableVisible: wrap ? wrap.style.display !== 'none' : false
    };
}

// ── Fill form from saved data ─────────────────────────────────────────────────
function ncpFillForm(data){
    _ncpSet('ncp_amount',     data.amount);
    _ncpSet('ncp_members',    data.members);
    _ncpSet('ncp_duration',   data.duration);
    _ncpSet('ncp_start',      data.start);
    _ncpSet('ncp_dueday',     data.dueday);
    _ncpSet('ncp_commission', data.commission);
    _ncpSet('ncp_member',     data.member);
    _ncpSet('ncp_incr_min',   data.incr_min);
    _ncpSet('ncp_incr_max',   data.incr_max);
    if(data.tableVisible && data.rows && data.rows.length){
        ncpGenerate(data.rows);
    } else {
        var w=document.getElementById('ncp_tableWrap'); if(w) w.style.display='none';
        var r=document.getElementById('ncp_rows'); if(r) r.innerHTML='';
        var s=document.getElementById('ncpSuggestionBox'); if(s) s.style.display='none';
    }
}

// ── Auto-save (debounced) ─────────────────────────────────────────────────────
var _ncpSaveTimer = null;
function ncpAutoSave(){
    clearTimeout(_ncpSaveTimer);
    _ncpSaveTimer = setTimeout(async function(){
        if(!_ncpActive) return;
        var all = await _ncpFetch();
        if(!all[_ncpActive]) return;
        var data = ncpReadForm();
        data._label   = all[_ncpActive]._label;
        data._savedAt = all[_ncpActive]._savedAt;
        all[_ncpActive] = data;
        await _ncpWrite(all);
    }, 1500);
}

// ── Save / overwrite version ──────────────────────────────────────────────────
async function ncpSaveVersion(){
    var label = (document.getElementById('ncp_version_label').value||'').trim();
    if(!label){ showToast('❌ Enter a version name', false); return; }
    var key  = 'ncp_' + label.replace(/\s+/g,'_').toLowerCase();
    var all  = await _ncpFetch();
    var isUpdate = !!all[key];
    var data = ncpReadForm();
    data._label   = label;
    data._savedAt = new Date().toLocaleString('en-IN');
    all[key] = data;
    await _ncpWrite(all);
    _ncpActive = key;
    ncpRenderSaved();
    showToast(isUpdate ? '🔄 "'+label+'" updated' : '✅ Saved "'+label+'"');
}

// ── New blank planner ─────────────────────────────────────────────────────────
function ncpNewPlanner(){
    _ncpActive = null;
    ['ncp_amount','ncp_members','ncp_duration','ncp_start','ncp_dueday','ncp_commission','ncp_member','ncp_incr_min','ncp_incr_max'].forEach(function(id){ _ncpSet(id,''); });
    _ncpSet('ncp_version_label','');
    var w=document.getElementById('ncp_tableWrap'); if(w) w.style.display='none';
    var r=document.getElementById('ncp_rows'); if(r) r.innerHTML='';
    var s=document.getElementById('ncpSuggestionBox'); if(s) s.style.display='none';
    ncpRenderSaved();
    showToast('📋 New planner ready');
}

// ── Load a version ────────────────────────────────────────────────────────────
async function ncpLoadVersion(key){
    var all = await _ncpFetch();
    if(!all[key]) return;
    _ncpActive = key;
    _ncpSet('ncp_version_label', all[key]._label);
    ncpFillForm(all[key]);
    ncpRenderSaved();
    showToast('📂 Loaded "' + (all[key]._label||key) + '"');
    setTimeout(function(){
        var el = document.getElementById('plannerTab');
        if(el) el.scrollIntoView({behavior:'smooth', block:'start'});
    }, 100);
}

// ── Delete a version ──────────────────────────────────────────────────────────
async function ncpDeleteVersion(key){
    var all = await _ncpFetch();
    var label = all[key] ? (all[key]._label||key) : key;
    if(!confirm('Delete version "'+label+'"?')) return;
    delete all[key];
    await _ncpWrite(all);
    if(_ncpActive === key){ ncpNewPlanner(); return; }
    ncpRenderSaved();
    showToast('🗑 Deleted "'+label+'"');
}

// ── Render saved versions list ────────────────────────────────────────────────
async function ncpRenderSaved(){
    var all  = await _ncpFetch();
    var keys = Object.keys(all);
    var bar  = document.getElementById('ncpSavedBar');
    if(!keys.length){ bar.innerHTML = ''; return; }

    var html = '<div style="font-size:0.62rem;font-weight:800;color:var(--text-dim);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">📁 Saved Versions ('+keys.length+')</div>';
    html += '<div style="display:flex;flex-direction:column;gap:6px;">';
    keys.forEach(function(k){
        var p = all[k];
        var isActive = k === _ncpActive;
        var monthlyPay = p.amount && p.members ? Math.round(parseFloat(p.amount)/parseInt(p.members)) : 0;
        var suggestion = ncpQuickSuggestion(p);
        html += '<div style="background:'+(isActive?'rgba(99,102,241,0.15)':'var(--card-bg)')+';border:1px solid '+(isActive?'rgba(99,102,241,0.5)':'var(--border)')+';border-radius:12px;padding:12px 14px;">';
        html += '<div style="display:flex;align-items:flex-start;gap:10px;">';
        html += '<div style="flex:1;min-width:0;">';
        html += '<div style="font-size:0.88rem;font-weight:800;color:'+(isActive?'#a5b4fc':'white')+';margin-bottom:3px;">'+(isActive?'✏️ ':'')+escHtml(p._label||k)+'</div>';
        html += '<div style="font-size:0.68rem;color:var(--text-dim);">'+(p.name?escHtml(p.name)+' · ':'')+(p.members||'?')+' members · '+(p.duration||'?')+' months'+(monthlyPay?' · ₹'+monthlyPay.toLocaleString('en-IN')+'/mo':'')+'</div>';
        if(suggestion){ html += '<div style="font-size:0.68rem;color:#a5b4fc;margin-top:4px;line-height:1.5;">💡 '+escHtml(suggestion)+'</div>'; }
        html += '<div style="font-size:0.6rem;color:var(--text-dim);margin-top:2px;">💾 '+(p._savedAt||'—')+'</div>';
        html += '</div>';
        html += '<div style="display:flex;gap:5px;flex-shrink:0;">';
        if(!isActive){
            html += '<button onclick="ncpLoadVersion(\''+k+'\')" style="background:rgba(99,102,241,0.2);border:1px solid rgba(99,102,241,0.4);color:#a5b4fc;padding:5px 11px;border-radius:8px;font-size:0.72rem;font-weight:800;cursor:pointer;">📂 Load</button>';
        } else {
            html += '<button onclick="ncpSaveVersion()" style="background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.4);color:#34d399;padding:5px 11px;border-radius:8px;font-size:0.72rem;font-weight:800;cursor:pointer;">💾 Update</button>';
        }
        html += '<button onclick="ncpDeleteVersion(\''+k+'\')" style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);color:#f87171;padding:5px 9px;border-radius:8px;font-size:0.72rem;cursor:pointer;">🗑</button>';
        html += '</div></div></div>';
    });
    html += '</div>';
    bar.innerHTML = html;
}

function escHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── Quick suggestion text for saved card ──────────────────────────────────────
function ncpQuickSuggestion(p){
    if(!p.amount || !p.members || !p.duration) return '';
    var amount   = parseFloat(p.amount);
    var members  = parseInt(p.members);
    var duration = parseInt(p.duration);
    var monthly  = Math.round(amount / members);
    var comm     = parseFloat(p.commission||0);
    var netPayout= amount - (amount * comm / 100);
    if(members === duration){
        return 'Balanced chit — '+members+' members, '+duration+' months. Each member pays ₹'+monthly.toLocaleString('en-IN')+'/mo. Net payout ₹'+Math.round(netPayout).toLocaleString('en-IN')+'.';
    } else if(members < duration){
        return '⚠️ More months than members — verify structure.';
    } else {
        return members+' members, '+duration+' months. Monthly ₹'+monthly.toLocaleString('en-IN')+'. Net payout ₹'+Math.round(netPayout).toLocaleString('en-IN')+'.';
    }
}

// ── Get due date for a month index ───────────────────────────────────────────
function ncpGetDueDate(baseDate, monthIndex, dueDay){
    if(!baseDate) return '—';
    var d = new Date(baseDate.getFullYear(), baseDate.getMonth() + monthIndex, 1);
    var maxDay = new Date(d.getFullYear(), d.getMonth()+1, 0).getDate();
    var day = Math.min(parseInt(dueDay)||1, maxDay);
    return new Date(d.getFullYear(), d.getMonth(), day)
        .toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
}

// ── Generate schedule ─────────────────────────────────────────────────────────
function ncpGenerate(savedRows){
    var amount     = parseFloat(document.getElementById('ncp_amount').value)||0;
    var members    = parseInt(document.getElementById('ncp_members').value)||0;
    var duration   = parseInt(document.getElementById('ncp_duration').value)||0;
    var startVal   = document.getElementById('ncp_start').value;
    var dueDay     = parseInt(document.getElementById('ncp_dueday').value)||1;
    var commission = parseFloat(document.getElementById('ncp_commission').value)||0;

    if(!savedRows){
        if(!duration){ showToast('❌ Enter Duration', false); return; }
        if(!members){  showToast('❌ Enter No. of Members', false); return; }
        if(!amount){   showToast('❌ Enter Chit Amount', false); return; }
    }
    if(!duration || !members) return;

    var monthlyPay = amount > 0 && members > 0 ? Math.round(amount / members) : 0;
    var base       = startVal ? new Date(startVal) : null;
    var netPayout  = amount > 0 ? Math.round(amount - (amount * commission / 100)) : 0;

    // ── Summary chips ──
    var chips = [
        ['Amount',   amount > 0    ? '₹'+amount.toLocaleString('en-IN') : '—'],
        ['Members',  members||'—'],
        ['Duration', (duration||'—')+' mo'],
        ['Monthly',  monthlyPay > 0 ? '₹'+monthlyPay.toLocaleString('en-IN') : '—'],
        ['Commission', commission+'%'],
        ['Net Payout', netPayout > 0 ? '₹'+netPayout.toLocaleString('en-IN') : '—'],
    ];
    var chipsHtml = chips.map(function(c, idx){
        return '<div style="flex:1;min-width:80px;padding:10px 6px;text-align:center;'+(idx<chips.length-1?'border-right:1px solid var(--border);':'')+'">'+
            '<div style="font-size:0.82rem;font-weight:800;color:#a5b4fc;">'+c[1]+'</div>'+
            '<div style="font-size:0.55rem;color:var(--text-dim);text-transform:uppercase;margin-top:2px;">'+c[0]+'</div>'+
            '</div>';
    }).join('');
    document.getElementById('ncp_chips').innerHTML = chipsHtml;

    // ── Per-month calculations ──
    // Net payout increases each month: month 1 winner gets least (bid lowest),
    // month N winner gets chit amount fully.
    // Simple increasing model: payout = amount - ((duration - i) / duration) × commAmt
    // i.e. early winner accepts more discount; last winner gets full amount.
    // Foreman profit per month = totalCollection × commission%

    var totalCollection = monthlyPay * members;
    var commAmt         = amount > 0 ? Math.round(amount * commission / 100) : 0;
    // foremanPerMonth calculated per row after chit payout is set — placeholder only
    var foremanPerMonth = 0;

    // ── Schedule rows ──
    var rowsEl = document.getElementById('ncp_rows');
    rowsEl.innerHTML = '';
    for(var i=0; i<duration; i++){
        var dueStr = ncpGetDueDate(base, i, dueDay);

        // Increasing net payout: month 1 = amount - commAmt, month N = amount
        // Spread evenly across duration
        // Payout spread: use incr range if provided, else fall back to commission spread
        var incrMin = parseFloat(document.getElementById('ncp_incr_min').value)||0; // discount % for month 1
        var incrMax = parseFloat(document.getElementById('ncp_incr_max').value)||0; // discount % for last month
        var autoChit;
        if(incrMin !== 0 || incrMax !== 0){
            // Linearly interpolate: negative incrMax = bonus above chit amount for last winner
            var payoutStart = Math.round(amount * (1 - incrMin / 100));
            var payoutEnd   = Math.round(amount * (1 - incrMax / 100));
            autoChit = duration > 1
                ? Math.round(payoutStart + ((payoutEnd - payoutStart) / (duration - 1)) * i)
                : payoutEnd;
            // Do NOT cap at amount when bonus is intended (negative incrMax)
            if(incrMax >= 0 && autoChit > amount) autoChit = amount;
        } else {
            autoChit = duration > 1
                ? Math.round((amount - commAmt) + (commAmt / (duration - 1)) * i)
                : amount;
        }
        if(incrMin === 0 && incrMax === 0 && autoChit > amount) autoChit = amount;

        var savedPay  = savedRows && savedRows[i] ? savedRows[i].pay  : (monthlyPay||'');
        var savedChit = savedRows && savedRows[i] ? savedRows[i].chit : autoChit;

        var div = document.createElement('div');
        div.className = 'ncp-row';
        div.style.cssText = 'display:flex;gap:3px;align-items:center;background:var(--input-bg);border-radius:8px;padding:4px 6px;';

        div.innerHTML =
            '<span style="width:22px;font-size:0.72rem;color:var(--text-dim);font-weight:700;text-align:center;flex-shrink:0;">'+(i+1)+'</span>'+
            // Due date
            '<span class="ncp-due" style="flex:1.5;font-size:0.75rem;color:#a5b4fc;white-space:nowrap;">'+dueStr+'</span>'+
            // Monthly Pay (editable)
            '<input type="number" class="ncp-pay form-input" value="'+(savedPay||'')+'" placeholder="Pay/mo" style="flex:1;margin-bottom:0;padding:5px 6px;font-size:0.78rem;" oninput="ncpUpdateTotals();ncpAutoSave();">'+
            // Payout Amount (editable — the actual chit payout member receives)
            '<input type="number" class="ncp-chit form-input" value="'+(savedChit||'')+'" placeholder="Payout" style="flex:1;margin-bottom:0;padding:5px 6px;font-size:0.78rem;color:#a5b4fc;" oninput="ncpUpdateTotals();ncpAutoSave();">'+

            // Foreman profit = (monthly × members) - net payout (auto, updates on input)
            '<span class="ncp-profit" style="flex:0.9;font-size:0.72rem;font-weight:700;color:#f59e0b;text-align:center;background:rgba(245,158,11,0.07);border-radius:6px;padding:5px 3px;">—</span>'+
            // % return (auto)
            '<span class="ncp-pct" style="width:44px;text-align:center;font-size:0.72rem;font-weight:800;color:#a5b4fc;">—</span>';
        rowsEl.appendChild(div);
    }

    document.getElementById('ncp_tableWrap').style.display = 'block';
    ncpUpdateTotals();
    ncpShowInsights();
    if(!savedRows) showToast('✅ Schedule generated', true);
    ncpAutoSave();
}

// ── Update totals — % return per row, foreman profit auto, no net payout sum ──
function ncpUpdateTotals(){
    var amount     = parseFloat(document.getElementById('ncp_amount').value)||0;
    var members    = parseInt(document.getElementById('ncp_members').value)||0;
    var commission = parseFloat(document.getElementById('ncp_commission').value)||0;

    var rows        = document.querySelectorAll('#ncp_rows .ncp-row');
    var totalPay    = 0;
    var totalProfit = 0;

    rows.forEach(function(row){
        var payInput    = row.querySelector('.ncp-pay');
        var chitInput   = row.querySelector('.ncp-chit');
        var profitEl    = row.querySelector('.ncp-profit');
        var pctEl       = row.querySelector('.ncp-pct');

        var pay  = parseFloat(payInput  ? payInput.value  : 0)||0;
        var chit = parseFloat(chitInput ? chitInput.value : 0)||0;
        totalPay += pay;

        // Foreman profit = (Monthly Pay × Members) − Net Payout
        var monthlyCollect = pay > 0 && members > 0 ? pay * members
            : (amount > 0 && members > 0 ? Math.round(amount/members) * members : 0);
        var foremanThisRow = chit > 0 && monthlyCollect > 0
            ? Math.max(0, monthlyCollect - chit)
            : 0;
        totalProfit += foremanThisRow;

        // Update foreman profit cell
        if(profitEl) profitEl.textContent = foremanThisRow > 0
            ? '₹'+foremanThisRow.toLocaleString('en-IN') : '—';

        // % return = chit payout / (monthly pay × members) × 100
        var monthlyCollect = pay > 0 && members > 0
            ? pay * members
            : (amount > 0 && members > 0 ? Math.round(amount/members)*members : 0);
        if(pctEl){
            if(chit > 0 && monthlyCollect > 0){
                var pct = ((chit / monthlyCollect) * 100).toFixed(1);
                pctEl.textContent = pct + '%';
                var num = parseFloat(pct)||0;
                pctEl.style.color = num >= 100 ? '#34d399' : num >= 85 ? '#f59e0b' : '#f87171';
            } else {
                pctEl.textContent = '—';
                pctEl.style.color = 'var(--text-dim)';
            }
        }
    });

    // Footer: total pay + total profit only (no net payout sum)
    var payEl    = document.getElementById('ncp_totalPay');
    var payoutEl = document.getElementById('ncp_totalPayout');
    var profTotEl = document.getElementById('ncp_totalProfit');

    if(payEl)    payEl.textContent    = totalPay    > 0 ? '₹'+totalPay.toLocaleString('en-IN')    : '—';
    // Sum payout column
    var totalChitPayout = 0;
    document.querySelectorAll('#ncp_rows .ncp-row').forEach(function(r){
        var c = r.querySelector('.ncp-chit'); totalChitPayout += parseFloat(c?c.value:0)||0;
    });
    if(payoutEl) payoutEl.textContent = totalChitPayout > 0 ? '₹'+totalChitPayout.toLocaleString('en-IN') : '—';
    if(profTotEl) profTotEl.textContent = totalProfit > 0 ? '₹'+totalProfit.toLocaleString('en-IN') : '—';
}

// ── Planner insights / suggestions ───────────────────────────────────────────
function ncpShowInsights(){
    var amount     = parseFloat(document.getElementById('ncp_amount').value)||0;
    var members    = parseInt(document.getElementById('ncp_members').value)||0;
    var duration   = parseInt(document.getElementById('ncp_duration').value)||0;
    var commission = parseFloat(document.getElementById('ncp_commission').value)||0;
    var box        = document.getElementById('ncpSuggestionBox');
    var textEl     = document.getElementById('ncpSuggestionText');
    if(!amount || !members || !duration){ box.style.display='none'; return; }

    var monthly    = Math.round(amount / members);
    var totalCollected = monthly * members * duration;
    var netPayout  = Math.round(amount - (amount * commission / 100));
    var foremanEarning = Math.round(amount * commission / 100) * duration;
    var memberSaving = amount - (monthly * duration); // what a member gains
    var roi        = totalCollected > 0 ? ((amount / totalCollected) * 100).toFixed(1) : 0;

    var tips = [];

    // Structure check
    if(members === duration){
        tips.push('✅ <strong>Balanced structure</strong> — '+members+' members for '+duration+' months. Every member gets the chit exactly once.');
    } else if(members > duration){
        tips.push('⚠️ <strong>Members ('+members+') > Duration ('+duration+' months)</strong> — some members will not get the chit. Consider increasing duration to match members.');
    } else {
        tips.push('⚠️ <strong>Duration ('+duration+') > Members ('+members+')</strong> — some months will have no chit winner. Reduce duration or add members.');
    }

    // Monthly affordability
    tips.push('💰 <strong>Monthly contribution:</strong> ₹'+monthly.toLocaleString('en-IN')+' per member. Total pool collected: ₹'+totalCollected.toLocaleString('en-IN')+'.');

    // Net payout
    if(commission > 0){
        tips.push('🏦 <strong>Foreman commission '+commission+'%:</strong> ₹'+Math.round(amount*commission/100).toLocaleString('en-IN')+' per chit. Net payout to winner: ₹'+netPayout.toLocaleString('en-IN')+'.');
    } else {
        tips.push('ℹ️ No foreman commission set — full ₹'+amount.toLocaleString('en-IN')+' paid out to each winner.');
    }

    // Member benefit
    if(memberSaving > 0){
        tips.push('📈 <strong>Member benefit:</strong> A member who wins gets ₹'+amount.toLocaleString('en-IN')+' but pays total ₹'+(monthly*duration).toLocaleString('en-IN')+' — saves ₹'+memberSaving.toLocaleString('en-IN')+' (if winning early).');
    }

    // ROI insight
    tips.push('📊 <strong>Fund utilisation:</strong> '+roi+'% of collected money returned per chit cycle.');

    // Commission recommendation
    if(commission === 0){
        tips.push('💡 <strong>Suggestion:</strong> Consider adding 2–5% foreman commission to cover admin costs. E.g. 5% = ₹'+Math.round(amount*0.05).toLocaleString('en-IN')+' per chit.');
    } else if(commission > 8){
        tips.push('⚠️ Commission '+commission+'% is relatively high — members may prefer lower. Industry standard is 2–5%.');
    }

    textEl.innerHTML = tips.join('<br><br>');
    box.style.display = 'block';
}

// ── Print schedule ────────────────────────────────────────────────────────────
function ncpPrint(){
    var name       = _ncpVal('ncp_version_label') || 'Chit Group';
    var memberName = document.getElementById('ncp_member').value.trim();
    var members    = parseInt(document.getElementById('ncp_members').value)||0;
    var duration   = parseInt(document.getElementById('ncp_duration').value)||0;
    var startVal   = document.getElementById('ncp_start').value;
    var dueDay     = parseInt(document.getElementById('ncp_dueday').value)||1;
    var commission = parseFloat(document.getElementById('ncp_commission').value)||0;
    var base       = startVal ? new Date(startVal) : null;
    var startDisp  = base ? base.toLocaleDateString('en-IN',{day:'2-digit',month:'long',year:'numeric'}) : '—';
    var today      = new Date().toLocaleDateString('en-IN',{day:'2-digit',month:'long',year:'numeric'});

    var rows = document.querySelectorAll('#ncp_rows .ncp-row');
    var totalPay = 0;
    var rowData  = [];
    rows.forEach(function(row, i){
        var payEl  = row.querySelector('.ncp-pay');
        var chitEl = row.querySelector('.ncp-chit');
        var mp  = parseFloat(payEl  ? payEl.value  : 0)||0;
        var cp  = parseFloat(chitEl ? chitEl.value : 0)||0;
        var due = row.querySelector('.ncp-due').textContent.trim();
        totalPay += mp;
        rowData.push({i:i, mp:mp, cp:cp, due:due});
    });
    var amount     = parseFloat(document.getElementById('ncp_amount').value)||0;
    var netPayout  = amount > 0 ? Math.round(amount - (amount*commission/100)) : 0;

    var amount    = parseFloat(document.getElementById('ncp_amount').value)||0;
    var members2  = parseInt(document.getElementById('ncp_members').value)||0;
    var tableRows = rowData.map(function(r){
        // % return = payout / (monthly × members) × 100
        var monthCol  = r.mp > 0 && members2 > 0 ? r.mp * members2
                        : (amount > 0 && members2 > 0 ? Math.round(amount/members2)*members2 : 0);
        var pct = monthCol > 0 && r.cp > 0 ? ((r.cp / monthCol)*100).toFixed(1) : '—';
        var pctColor = parseFloat(pct) >= 100 ? '#065f46' : parseFloat(pct) >= 85 ? '#92400e' : '#991b1b';
        return '<tr style="background:'+(r.i%2===0?'#f9fafb':'#fff')+';">'+
            '<td style="text-align:center;color:#888;font-size:13px;">'+(r.i+1)+'</td>'+
            '<td>'+r.due+'</td>'+
            '<td style="color:#1d4ed8;font-weight:700;">'+(r.cp?'₹'+r.cp.toLocaleString('en-IN'):'—')+'</td>'+
            '<td style="text-align:center;font-weight:800;color:'+pctColor+';">'+(pct!=='—'?pct+'%':'—')+'</td>'+
            '</tr>';
    }).join('');

    var printHTML = '<div id="ncpPrintDoc"><style>'+
        '#ncpPrintDoc{font-family:Arial,sans-serif;color:#111;max-width:820px;margin:0 auto;padding:16px;}'+
        '#ncpPrintDoc .hdr{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #f39c12;padding-bottom:10px;margin-bottom:14px;}'+
        '#ncpPrintDoc .brand{font-size:16px;font-weight:900;color:#f39c12;}'+
        '#ncpPrintDoc .info-box{background:#fffbf0;border:2px solid #f39c12;border-radius:8px;padding:14px 18px;margin-bottom:14px;}'+
        '#ncpPrintDoc .chips{display:flex;gap:0;border:1px solid #e5c76b;border-radius:8px;overflow:hidden;margin-top:10px;}'+
        '#ncpPrintDoc .chip{flex:1;padding:8px;text-align:center;border-right:1px solid #e5c76b;}'+
        '#ncpPrintDoc .chip:last-child{border-right:none;}'+
        '#ncpPrintDoc .chip-v{font-size:14px;font-weight:800;}'+
        '#ncpPrintDoc .chip-l{font-size:9px;color:#888;text-transform:uppercase;}'+
        '#ncpPrintDoc table{width:100%;border-collapse:collapse;font-size:15px;margin-bottom:10px;}'+
        '#ncpPrintDoc thead tr{background:#fef3c7;}'+
        '#ncpPrintDoc th{border:1px solid #d1a832;padding:10px 12px;font-size:13px;text-transform:uppercase;color:#555;font-weight:800;}'+
        '#ncpPrintDoc td{border:1px solid #e5e7eb;padding:9px 12px;}'+
        '#ncpPrintDoc tfoot td{background:#fff8e1;font-weight:800;border-top:2px solid #f39c12;}'+
        '#ncpPrintDoc .ftr{margin-top:14px;border-top:1px solid #ddd;padding-top:8px;display:flex;justify-content:space-between;font-size:10px;color:#aaa;}'+
        '#ncpPrintDoc .pbar{display:flex;gap:10px;margin-bottom:16px;}'+
        '#ncpPrintDoc .pbtn{background:linear-gradient(90deg,#f39c12,#f57c00);color:#000;border:none;padding:10px 24px;border-radius:10px;font-weight:800;font-size:14px;cursor:pointer;}'+
        '#ncpPrintDoc .cbtn{background:#eee;color:#333;border:none;padding:10px 18px;border-radius:10px;font-weight:700;font-size:14px;cursor:pointer;}'+
        '@media print{body>*:not(#printOverlay){display:none!important;}#printOverlay{position:absolute!important;top:0!important;left:0!important;width:100%!important;}#ncpPrintDoc .pbar{display:none!important;}@page{size:A4 portrait;margin:10mm;}}'+
        '</style>'+
        '<div class="pbar">'+
        '<button class="pbtn" onclick="window.print()">🖨️ Print / Save as PDF</button>'+
        '<button class="cbtn" onclick="closePrintStatement()">✕ Close</button>'+
        '</div>'+
        '<div class="hdr">'+
        '<div>'+
        '<div style="display:flex;align-items:center;gap:10px;">'+
        '<img src="logo.png" style="width:48px;height:48px;border-radius:10px;object-fit:cover;" onerror="this.style.display=\'none\';this.nextSibling.style.display=\'inline\'" />'+
        '<span style="display:none;font-size:22px;">🏆</span>'+
        '<div><div class="brand">AK CHIT FUNDS</div><div style="font-size:9px;color:#888;">Chit Fund Management &middot; Group Schedule</div></div>'+
        '</div>'+
        (memberName ? '<div style="margin-top:6px;font-size:12px;font-weight:800;">For: ' + memberName + '</div>' : '')+
        '</div>'+
        '<div style="text-align:right;"><div style="font-size:13px;font-weight:800;">CHIT SCHEDULE</div><div style="font-size:9px;color:#888;">' + today + '</div></div>'+
        '</div>'+
        '<div class="info-box">'+
        '<div style="font-size:16px;font-weight:900;margin-bottom:8px;">📂 '+name+'</div>'+
        '<div class="chips">'+
        '<div class="chip"><div class="chip-v">'+members+'</div><div class="chip-l">Members</div></div>'+
        '<div class="chip"><div class="chip-v">'+duration+'</div><div class="chip-l">Months</div></div>'+
        '<div class="chip"><div class="chip-v">'+dueDay+'</div><div class="chip-l">Due Day</div></div>'+
        '<div class="chip"><div class="chip-v">'+startDisp+'</div><div class="chip-l">Start Date</div></div>'+
        (amount>0?'<div class="chip"><div class="chip-v" style="color:#065f46;">₹'+Math.round(amount/members).toLocaleString('en-IN')+'</div><div class="chip-l">Monthly/Member</div></div>':'')+
        '</div></div>'+
        '<table>'+
        '<thead><tr><th style="width:6%;text-align:center;">#</th><th style="width:40%;">Due Date</th><th style="width:36%;">Chit Payout</th><th style="width:18%;text-align:center;">% Return</th></tr></thead>'+
        '<tbody>'+tableRows+'</tbody>'+
        '<tfoot><tr><td colspan="2" style="text-align:right;padding-right:10px;font-weight:800;">TOTAL</td>'+
        '<td style="color:#888;">—</td>'+
        '<td></td></tr></tfoot>'+
        '</table>'+
        '<div class="ftr"><span>AK Chit Funds · Planner</span><span>'+name+' · '+today+'</span><span>CONFIDENTIAL</span></div>'+
        '</div>';

    var overlay = document.getElementById('printOverlay');
    if(!overlay){
        overlay = document.createElement('div');
        overlay.id = 'printOverlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:white;z-index:99999;overflow-y:auto;padding:16px;';
        document.body.appendChild(overlay);
    }
    overlay.innerHTML = printHTML;
    overlay.style.display = 'block';
    showToast('✅ Ready — tap Print / Save as PDF', true);
}

// ── Restore session on tab open ───────────────────────────────────────────────
async function ncpRestoreSession(){
    var all = await _ncpFetch();
    var keys = Object.keys(all);
    ncpRenderSaved();
    if(keys.length === 1){
        _ncpActive = keys[0];
        _ncpSet('ncp_version_label', all[keys[0]]._label);
        ncpFillForm(all[keys[0]]);
    }
}

// ── Planner Sub-tab Switcher ──────────────────────────────────────────────────
function switchPlannerSubTab(tab) {
    const panels = { planner: 'plPlannerPanel', completed: 'plCompletedPanel' };
    const btns   = { planner: 'plSubPlanner',   completed: 'plSubCompleted'   };
    Object.keys(panels).forEach(k => {
        const p = document.getElementById(panels[k]);
        const b = document.getElementById(btns[k]);
        if(p) p.style.display = k === tab ? '' : 'none';
        if(b){
            b.style.background = k === tab ? 'rgba(99,102,241,0.85)' : 'var(--card-bg)';
            b.style.color      = k === tab ? 'white' : 'var(--text-dim)';
            b.style.border     = k === tab ? 'none' : '1px solid var(--border)';
        }
    });
    if(tab === 'completed') renderCompletedGroups();
}

// ── Completed Groups Renderer ─────────────────────────────────────────────────
async function renderCompletedGroups() {
    const el = document.getElementById('completedGroupsList');
    if(!el) return;
    el.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-dim);font-size:0.8rem;">Loading…</div>';

    const gs = await getCollection('groups');
    const ps = await getCollection('payments');
    const ms = await getCollection('members');

    // A group is "completed" if all its months have at least one payment recorded
    // OR if it has an explicit status==='closed'
    const completed = gs.filter(g => {
        if(g.status === 'closed') return true;
        // Check if all due dates have payments
        const dueDates = getGroupDueDates(g);
        if(!dueDates.length) return false;
        const gPays = ps.filter(p => p.groupId === g.id);
        const paidMonths = new Set();
        gPays.forEach(p => {
            if(Array.isArray(p.monthSlots)) p.monthSlots.forEach(s => paidMonths.add(s));
            else if(p.monthSlot != null) paidMonths.add(p.monthSlot);
        });
        return dueDates.every((_, i) => paidMonths.has(i));
    });

    if(!completed.length){
        el.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-dim);font-size:0.85rem;">No completed groups yet.<br><span style="font-size:0.72rem;">Groups appear here when all months are paid or status is set to Closed.</span></div>';
        return;
    }

    el.innerHTML = completed.map(g => {
        const gPays = ps.filter(p => p.groupId === g.id);
        const totalCollected = gPays.reduce((s,p) => s + (parseFloat(p.paid)||0), 0);
        const totalBalance   = gPays.reduce((s,p) => s + (parseFloat(p.balance)||0), 0);
        const chitPicks      = gPays.filter(p => p.chitPicked === 'Yes').length;
        const uniqueMembers  = new Set(gPays.map(p => p.memberId)).size;
        const startDate = g.startDate || g.start || '—';
        const endDate   = g.endDate   || g.end   || '—';
        const chitAmt   = g.chitAmount || g.amount || '—';
        const months    = g.duration  || g.months  || '—';

        return `<div style="background:var(--card-bg);border:1px solid rgba(16,185,129,0.25);border-radius:12px;overflow:hidden;margin-bottom:10px;">
            <div style="padding:10px 14px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;">
                <div>
                    <div style="font-size:0.88rem;font-weight:800;color:white;">${g.name||'—'}</div>
                    <div style="font-size:0.68rem;color:var(--text-dim);margin-top:2px;">${startDate} → ${endDate} &nbsp;·&nbsp; ${months} months</div>
                </div>
                <span style="background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.35);color:#34d399;border-radius:20px;padding:3px 10px;font-size:0.68rem;font-weight:800;">✅ Completed</span>
            </div>
            <table style="width:100%;border-collapse:collapse;">
                <tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
                    <td style="padding:7px 14px;font-size:0.75rem;color:var(--text-dim);">💰 Total Collected</td>
                    <td style="padding:7px 14px;font-size:0.82rem;font-weight:800;color:#f39c12;text-align:right;">₹${totalCollected.toLocaleString('en-IN')}</td>
                </tr>
                <tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
                    <td style="padding:7px 14px;font-size:0.75rem;color:var(--text-dim);">📋 Outstanding Balance</td>
                    <td style="padding:7px 14px;font-size:0.82rem;font-weight:800;color:${totalBalance>0?'#f87171':'#34d399'};text-align:right;">₹${totalBalance.toLocaleString('en-IN')}</td>
                </tr>
                <tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
                    <td style="padding:7px 14px;font-size:0.75rem;color:var(--text-dim);">👥 Members</td>
                    <td style="padding:7px 14px;font-size:0.82rem;font-weight:800;color:#60a5fa;text-align:right;">${uniqueMembers}</td>
                </tr>
                <tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
                    <td style="padding:7px 14px;font-size:0.75rem;color:var(--text-dim);">💳 Chit Amount</td>
                    <td style="padding:7px 14px;font-size:0.82rem;font-weight:800;color:#a5b4fc;text-align:right;">₹${Number(chitAmt).toLocaleString('en-IN')}</td>
                </tr>
                <tr>
                    <td style="padding:7px 14px;font-size:0.75rem;color:var(--text-dim);">🎯 Chits Picked</td>
                    <td style="padding:7px 14px;font-size:0.82rem;font-weight:800;color:#34d399;text-align:right;">${chitPicks} / ${months}</td>
                </tr>
            </table>
        </div>`;
    }).join('');
}
