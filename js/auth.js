// ═══════════════════════════════════════════════════════════
// AK Chit Funds — AUTH & ACCESS CONTROL
// ═══════════════════════════════════════════════════════════

const ADMIN_PHONE = '9876543210';

function saveSession(user){ sessionStorage.setItem('akdf_session', JSON.stringify(user)); }
function loadSession(){ try{ return JSON.parse(sessionStorage.getItem('akdf_session'))||null; }catch(e){ return null; } }
function clearSession(){ sessionStorage.removeItem('akdf_session'); }

// ── Init ─────────────────────────────────────────────────────────────────────
async function initAuth(){
    const saved = sessionStorage.getItem('akdf_session');
    if(saved){
        try{
            const u = JSON.parse(saved);
            CURRENT_USER = u;
            applyUserSession(u);
            return;
        }catch(e){}
    }
    document.getElementById('loginScreen').style.display = 'flex';
}

// ── Login ─────────────────────────────────────────────────────────────────────
async function handleLoginSubmit(){
    const phone = document.getElementById('loginPhone').value.trim();
    if(phone.length !== 10){ showToast('❌ Enter valid 10-digit number', false); return; }
    showToast('⏳ Checking access…', true);

    // Admin shortcut
    if(phone === ADMIN_PHONE){
        const user = {phone: phone, role: 'admin', name: 'Admin'};
        CURRENT_USER = user;
        sessionStorage.setItem('akdf_session', JSON.stringify(user));
        applyUserSession(user);
        return;
    }

    // Check if member exists
    const members = await getCollection('members');
    const matched = members.find(function(m){
        return (m.phone||'').replace(/\D/g,'').slice(-10) === phone;
    });

    // Check existing access request regardless of member match
    const reqs = await db.collection('accessRequests').where('phone','==',phone).get().catch(function(){ return {empty:true, docs:[]}; });

    if(!reqs.empty && reqs.docs.length > 0){
        const req = reqs.docs[0].data();
        if(req.status === 'approved'){
            if(matched){
                const user = {phone: phone, role: 'member', memberId: matched.id, name: matched.name};
                CURRENT_USER = user;
                sessionStorage.setItem('akdf_session', JSON.stringify(user));
                applyUserSession(user);
            } else {
                showToast('✅ Approved but no member profile yet. Contact admin.', false);
            }
        } else if(req.status === 'denied'){
            showLoginStep('loginStep3');
        } else {
            // Already pending
            document.getElementById('pendingPhone').textContent = '+91 ' + phone;
            showLoginStep('loginStep2');
        }
    } else {
        // New request — send to admin (works for both members and unknown numbers)
        await db.collection('accessRequests').add({
            phone: phone,
            name: matched ? matched.name : 'Unknown (' + phone + ')',
            memberId: matched ? matched.id : '',
            status: 'pending',
            requestedAt: new Date().toISOString()
        });
        document.getElementById('pendingPhone').textContent = '+91 ' + phone;
        showLoginStep('loginStep2');
        showToast('📨 Access request sent to admin', true);
    }
}

async function checkAccessStatus(){
    const phone = document.getElementById('loginPhone').value.trim() ||
                  (CURRENT_USER ? CURRENT_USER.phone : '');
    if(!phone){ goBackToLogin(); return; }
    const reqs = await db.collection('accessRequests').where('phone','==',phone).get().catch(function(){ return {empty:true, docs:[]}; });
    if(!reqs.empty && reqs.docs.length > 0){
        const req = reqs.docs[0].data();
        if(req.status === 'approved'){
            const members = await getCollection('members');
            const matched = members.find(function(m){
                return (m.phone||'').replace(/\D/g,'').slice(-10) === phone;
            });
            if(matched){
                const user = {phone: phone, role: 'member', memberId: matched.id, name: matched.name};
                sessionStorage.setItem('akdf_session', JSON.stringify(user));
                showToast('✅ Access approved! Loading…', true);
                setTimeout(function(){ location.reload(); }, 800);
                return;
            }
        } else if(req.status === 'denied'){
            showLoginStep('loginStep3');
            return;
        }
    }
    showToast('⏳ Still pending approval', true);
}

// ── Login step switcher ───────────────────────────────────────────────────────
var _pendingPollTimer = null;

function showLoginStep(stepId){
    ['loginStep1','loginStep2','loginStep3'].forEach(function(id){
        document.getElementById(id).classList.remove('active');
    });
    document.getElementById(stepId).classList.add('active');
    if(stepId === 'loginStep2'){
        if(_pendingPollTimer) clearInterval(_pendingPollTimer);
        _pendingPollTimer = setInterval(silentCheckStatus, 5000);
    } else {
        if(_pendingPollTimer){ clearInterval(_pendingPollTimer); _pendingPollTimer = null; }
    }
}

async function silentCheckStatus(){
    const phone = document.getElementById('loginPhone').value.trim();
    if(!phone) return;
    const reqs = await db.collection('accessRequests').where('phone','==',phone).get().catch(function(){ return {docs:[]}; });
    if(!reqs.docs || reqs.docs.length === 0) return;
    const req = reqs.docs[0].data();
    if(req.status === 'approved'){
        if(_pendingPollTimer){ clearInterval(_pendingPollTimer); _pendingPollTimer = null; }
        const members = await getCollection('members');
        const matched = members.find(function(m){
            return (m.phone||'').replace(/\D/g,'').slice(-10) === phone;
        });
        if(matched){
            const user = {phone: phone, role: 'member', memberId: matched.id, name: matched.name};
            sessionStorage.setItem('akdf_session', JSON.stringify(user));
            showToast('✅ Access approved! Loading…', true);
            setTimeout(function(){ location.reload(); }, 1000);
        }
    } else if(req.status === 'denied'){
        if(_pendingPollTimer){ clearInterval(_pendingPollTimer); _pendingPollTimer = null; }
        showLoginStep('loginStep3');
    }
}

function goBackToLogin(){
    document.getElementById('loginPhone').value = '';
    showLoginStep('loginStep1');
}

// ── Apply session UI ──────────────────────────────────────────────────────────
function applyUserSession(user){
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('logoutBtn').style.display = 'block';

    if(user.role === 'admin'){
        document.body.classList.add('admin-mode');
        document.documentElement.classList.add('admin-mode-early');
        document.getElementById('adminHeader').style.display = 'flex';
        document.getElementById('memberHeader').style.display = 'none';
        document.getElementById('headerRoleBadge').textContent = 'ADMIN';
        document.getElementById('headerRoleBadge').style.display = 'inline';
        document.getElementById('accessReqBtn').style.display = 'inline-flex';
        document.getElementById('adminStatCards').style.display = '';
        document.getElementById('adminActionBtns').style.display = 'flex';
        document.getElementById('adminMemberSearch').style.display = '';
        document.getElementById('memberLedgerArea').style.display = 'none';
        document.getElementById('qrGeneratorSection').style.display = '';
        document.getElementById('waReminderSection').style.display = '';
        document.getElementById('adminQuickBtns').style.display = 'flex';
        document.getElementById('memberQrArea').style.display = 'none';
        updateUI();
        pollPendingRequests();
        setTimeout(checkAndShowBackupReminder, 1200);
        if(localStorage.getItem('akdf_balances_fixed_v1')!=='1' && typeof recalculateAllPaymentBalances==='function'){
            recalculateAllPaymentBalances();
        }
    } else {
        document.getElementById('adminHeader').style.display = 'none';
        document.getElementById('memberHeader').style.display = 'block';
        document.getElementById('logoutBtn').style.display = 'none';
        document.getElementById('memberHeaderAvatar').textContent = ini(user.name);
        document.getElementById('memberHeaderName').textContent = user.name;
        document.getElementById('memberHeaderPhone').textContent = '📱 +91 ' + user.phone;
        document.getElementById('adminStatCards').style.display = 'none';
        document.getElementById('adminActionBtns').style.display = 'none';
        document.getElementById('adminMemberSearch').style.display = 'none';
        document.getElementById('adminQuickBtns').style.display = 'none';
        document.getElementById('qrGeneratorSection').style.display = 'none';
        document.getElementById('waReminderSection').style.display = 'none';
        document.getElementById('memberLedgerArea').style.display = 'block';
        document.getElementById('memberQrArea').style.display = 'block';
        document.getElementById('summaryView').value = user.memberId;

        // Remove admin-mode so nav tabs are hidden for members
        document.body.classList.remove('admin-mode');
        document.documentElement.classList.remove('admin-mode-early');

        // Show member sub-nav; hide homeTab (member panels are outside it)
        const mNav = document.getElementById('memberSubNav');
        if(mNav) mNav.style.display = '';
        const ht = document.getElementById('homeTab');
        if(ht) ht.style.display = 'none';

        updateUI();
        if(typeof loadMemberQr === 'function') loadMemberQr(user.memberId);
        if(typeof switchMemberSubTab === 'function') switchMemberSubTab('dash');
    }
}

// ── Logout ────────────────────────────────────────────────────────────────────
function handleLogout(){
    document.body.classList.remove('admin-mode');
    document.documentElement.classList.remove('admin-mode-early');
    sessionStorage.removeItem('akdf_session');
    CURRENT_USER = null;
    document.getElementById('adminHeader').style.display = 'flex';
    document.getElementById('memberHeader').style.display = 'none';
    const mNavL = document.getElementById('memberSubNav'); if(mNavL) mNavL.style.display = 'none';
    const htL = document.getElementById('homeTab'); if(htL) htL.style.display = '';
    ['mDashPanel','mPayPanel','mStatsPanel','mQrPanel'].forEach(id=>{const e=document.getElementById(id);if(e)e.style.display='none';});
    document.getElementById('navGroups').style.display = '';
    document.getElementById('navBackup').style.display = '';
    document.getElementById('navPlanner').style.display = '';
    document.querySelector('.nav-bar').style.display = '';
    document.getElementById('adminStatCards').style.display = '';
    document.getElementById('adminActionBtns').style.display = 'flex';
    document.getElementById('adminMemberSearch').style.display = '';
    document.getElementById('memberLedgerArea').style.display = 'none';
    document.getElementById('qrGeneratorSection').style.display = '';
    document.getElementById('waReminderSection').style.display = '';
    document.getElementById('adminQuickBtns').style.display = 'none';
    document.getElementById('memberQrArea').style.display = 'none';
    document.getElementById('logoutBtn').style.display = 'none';
    document.getElementById('accessReqBtn').style.display = 'none';
    document.getElementById('headerRoleBadge').textContent = 'ADMIN';
    document.getElementById('headerRoleBadge').className = 'badge text-warning border border-warning px-2';
    document.getElementById('ledgerData').innerHTML = '';
    document.getElementById('memberLedgerData').innerHTML = '';
    document.getElementById('summarySearch').value = '';
    document.getElementById('summaryView').value = '';
    showLoginStep('loginStep1');
    document.getElementById('loginPhone').value = '';
    document.getElementById('loginScreen').style.display = 'flex';
}

// ── Access Requests Panel ─────────────────────────────────────────────────────
var _reqFilter = 'pending';

async function openAccessRequests(){
    _reqFilter = 'pending';
    await renderAccessRequests();
    openModal('accessModal');
}

async function filterRequests(type){
    _reqFilter = type;
    ['pending','approved','all'].forEach(function(t){
        var btn = document.getElementById('reqTab' + t.charAt(0).toUpperCase() + t.slice(1));
        if(btn) btn.className = t === type ? 'btn-save' : 'btn-cancel';
    });
    await renderAccessRequests();
}

async function renderAccessRequests(){
    var list = document.getElementById('accessRequestsList');
    list.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:16px;">Loading…</div>';
    var snap = await db.collection('accessRequests').orderBy('requestedAt','desc').get()
        .catch(function(){ return db.collection('accessRequests').get(); });
    var all      = snap.docs.map(function(d){ return Object.assign({id:d.id}, d.data()); });
    var filtered = _reqFilter === 'all' ? all : all.filter(function(r){ return r.status === _reqFilter; });

    if(!filtered.length){
        list.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:24px;">No ' + (_reqFilter==='all'?'':_reqFilter) + ' requests</div>';
        return;
    }

    list.innerHTML = filtered.map(function(r){
        var dateStr = r.requestedAt ? new Date(r.requestedAt).toLocaleDateString('en-IN') : '—';
        var actions = '';
        if(r.status === 'pending'){
            actions = '<button class="btn-approve" onclick="handleApprove(\'' + r.id + '\',\'' + r.phone + '\')">✅ Approve</button>' +
                      '<button class="btn-deny" onclick="handleDeny(\'' + r.id + '\')">✕ Deny</button>';
        } else if(r.status === 'approved'){
            actions = '<span class="badge-approved">✅ Approved</span>' +
                      '<button class="btn-deny" style="font-size:0.92rem;padding:4px 8px;" onclick="handleDeny(\'' + r.id + '\')">Revoke</button>';
        } else {
            actions = '<span class="badge-denied">🚫 Denied</span>' +
                      '<button class="btn-approve" style="font-size:0.92rem;padding:4px 8px;" onclick="handleApprove(\'' + r.id + '\',\'' + r.phone + '\')">Re-approve</button>';
        }
        return '<div class="req-card">' +
            '<div style="flex:1;min-width:0;">' +
            '<div class="req-name">' + (r.name||'Unknown') + '</div>' +
            '<div class="req-phone">📱 +91 ' + r.phone + ' &nbsp;·&nbsp; ' + dateStr + '</div>' +
            '</div>' +
            '<div style="display:flex;gap:6px;align-items:center;flex-shrink:0;">' + actions + '</div>' +
            '</div>';
    }).join('');
}

async function handleApprove(reqId, phone){
    await db.collection('accessRequests').doc(reqId).update({status:'approved', approvedAt: new Date().toISOString()});
    showToast('✅ Access approved!');
    await renderAccessRequests();
    await pollPendingRequests();
}

async function handleDeny(reqId){
    await db.collection('accessRequests').doc(reqId).update({status:'denied', deniedAt: new Date().toISOString()});
    showToast('🚫 Access denied');
    await renderAccessRequests();
    await pollPendingRequests();
}

// ── Poll pending requests (admin) ─────────────────────────────────────────────
var _knownPendingIds = {};
var _firstPoll = true;

async function pollPendingRequests(){
    if(!CURRENT_USER || CURRENT_USER.role !== 'admin') return;
    var snap = await db.collection('accessRequests').where('status','==','pending').get().catch(function(){ return {docs:[]}; });
    var count = snap.docs.length;

    // Detect new requests
    var newRequests = [];
    snap.docs.forEach(function(d){
        if(!_knownPendingIds[d.id]){
            if(!_firstPoll) newRequests.push(Object.assign({id:d.id}, d.data()));
            _knownPendingIds[d.id] = true;
        }
    });
    // Clean up resolved ones
    Object.keys(_knownPendingIds).forEach(function(id){
        if(!snap.docs.find(function(d){ return d.id === id; })){
            delete _knownPendingIds[id];
        }
    });
    _firstPoll = false;

    // Update badge
    var badge = document.getElementById('pendingCount');
    if(count > 0){
        badge.style.display = 'flex';
        badge.textContent   = count;
    } else {
        badge.style.display = 'none';
    }

    // Alert for each new request
    newRequests.forEach(function(req){
        playRequestSound();
        showRequestBanner(req);
    });
}

// ── Notification sound ────────────────────────────────────────────────────────
function playRequestSound(){
    try{
        var ctx = new (window.AudioContext || window.webkitAudioContext)();
        [[0, 880],[0.18, 1100],[0.36, 1320]].forEach(function(pair){
            var delay = pair[0], freq = pair[1];
            var osc  = ctx.createOscillator();
            var gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, ctx.currentTime + delay);
            gain.gain.setValueAtTime(0, ctx.currentTime + delay);
            gain.gain.linearRampToValueAtTime(0.4, ctx.currentTime + delay + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + 0.5);
            osc.start(ctx.currentTime + delay);
            osc.stop(ctx.currentTime + delay + 0.6);
        });
    } catch(e){}
}

// ── Floating request banner ───────────────────────────────────────────────────
function showRequestBanner(req){
    var name  = req.name  || 'Unknown';
    var phone = req.phone || '';
    var reqId = req.id;

    // Keyframes (inject once)
    if(!document.getElementById('akBannerStyle')){
        var s = document.createElement('style');
        s.id = 'akBannerStyle';
        s.textContent = '@keyframes akSlideDown{from{opacity:0;transform:translateX(-50%) translateY(-16px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}';
        document.head.appendChild(s);
    }

    var banner = document.createElement('div');
    banner.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);' +
        'background:linear-gradient(135deg,#1c253b,#141b2d);' +
        'border:1px solid rgba(243,156,18,0.5);border-radius:16px;padding:14px 16px;' +
        'z-index:99999;box-shadow:0 8px 32px rgba(0,0,0,0.6);' +
        'min-width:280px;max-width:320px;animation:akSlideDown 0.3s ease;';

    // Row
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:12px;';

    // Bell
    var bell = document.createElement('div');
    bell.style.cssText = 'font-size:1.5rem;flex-shrink:0;';
    bell.textContent = '🔔';

    // Text
    var txt = document.createElement('div');
    txt.style.cssText = 'flex:1;min-width:0;';
    txt.innerHTML = '<div style="font-size:0.78rem;font-weight:800;color:#f39c12;margin-bottom:2px;">New Access Request</div>' +
        '<div style="font-size:0.85rem;font-weight:700;color:white;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + name + '</div>' +
        '<div style="font-size:0.7rem;color:#8e9aaf;">📱 +91 ' + phone + '</div>';

    // Buttons
    var btns = document.createElement('div');
    btns.style.cssText = 'display:flex;flex-direction:column;gap:5px;flex-shrink:0;';

    var btnApprove = document.createElement('button');
    btnApprove.style.cssText = 'background:linear-gradient(135deg,#10b981,#059669);color:white;border:none;border-radius:8px;padding:6px 10px;font-size:0.72rem;font-weight:800;cursor:pointer;';
    btnApprove.textContent = '✅ Approve';
    btnApprove.onclick = function(){ handleApprove(reqId, phone); banner.remove(); };

    var btnDeny = document.createElement('button');
    btnDeny.style.cssText = 'background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);color:#f87171;border-radius:8px;padding:6px 10px;font-size:0.72rem;font-weight:700;cursor:pointer;';
    btnDeny.textContent = '✕ Deny';
    btnDeny.onclick = function(){ handleDeny(reqId); banner.remove(); };

    btns.appendChild(btnApprove);
    btns.appendChild(btnDeny);
    row.appendChild(bell);
    row.appendChild(txt);
    row.appendChild(btns);
    banner.appendChild(row);
    document.body.appendChild(banner);

    setTimeout(function(){ if(banner.parentNode) banner.remove(); }, 12000);
}
