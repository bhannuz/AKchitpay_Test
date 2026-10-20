import { app, auth, db } from './firebase.js';
import { initializeApp, deleteApp } from 'https://www.gstatic.com/firebasejs/11.8.1/firebase-app.js';
import {
  onAuthStateChanged, signOut, getAuth, createUserWithEmailAndPassword, updateProfile,
  updatePassword, reauthenticateWithCredential, EmailAuthProvider,
} from 'https://www.gstatic.com/firebasejs/11.8.1/firebase-auth.js';
import {
  collection, doc, getDocs, getDoc, addDoc as _addDoc, setDoc as _setDoc, updateDoc as _updateDoc, deleteDoc as _deleteDoc,
  onSnapshot, query, where, orderBy, serverTimestamp, getFirestore,
} from 'https://www.gstatic.com/firebasejs/11.8.1/firebase-firestore.js';
import { resolveRole, pinToPassword, randomPin, isValidPin, isValidMobile, normalizePin } from './roles.js';
/* payments, issues, members inlined below — see functions below */

/* ════════════════════════════════
   AUTH GUARD
════════════════════════════════ */
let UID = null;          // apartment id (the admin's uid) — for members it is NOT their own uid
let ROLE = 'admin';      // 'admin' | 'member'
let MY_FLAT = null, MY_NAME = '', MY_PHONE = '';
const isAdmin  = () => ROLE === 'admin';
const isMember = () => ROLE === 'member';
let _booted = false; // prevent duplicate boot on auth token refresh

/* Write guard (UX layer). The REAL enforcement is firestore.rules.
   Admin: everything. Flat member: may only create documents in /issues and /contacts. */
const _canWrite = ref => isAdmin() || (isMember() && /\/(issues|contacts)$/.test(ref.path || ''));
const _deny = () => { toast('Only the apartment admin can make changes.', 'error'); throw new Error('read-only'); };
const addDoc    = (ref, ...a) => _canWrite(ref) ? _addDoc(ref, ...a)    : _deny();
const setDoc    = (ref, ...a) => _canWrite(ref) ? _setDoc(ref, ...a)    : _deny();
const updateDoc = (ref, ...a) => _canWrite(ref) ? _updateDoc(ref, ...a) : _deny();
const deleteDoc = (ref, ...a) => _canWrite(ref) ? _deleteDoc(ref, ...a) : _deny();

const ADMIN_EMAIL = 'admin@gatebook.app';
onAuthStateChanged(auth, async user => {
  if (!user) {
    window.location.replace('index.html');
    return;
  }
  // Redirect admin away from regular app
  if (user.email === ADMIN_EMAIL) {
    window.location.replace('admin.html');
    return;
  }
  // Show user info in nav (always update)
  const initials = (user.displayName||user.email||'A').charAt(0).toUpperCase();
  document.getElementById('userAvatar').textContent = initials;
  document.getElementById('userName').textContent   = user.displayName || user.email.split('@')[0];

  // Only boot once — onAuthStateChanged can fire multiple times
  if (_booted) return;
  _booted = true;

  let r;
  try { r = await resolveRole(user); } catch (e) { console.error(e); r = { role: 'new' }; }
  // A flat member who was removed (or never added) goes back to the login page
  if (r.role === 'new' && sessionStorage.getItem('gb_intent') === 'member') {
    await signOut(auth);
    window.location.replace('index.html');
    return;
  }
  ROLE    = r.role === 'member' ? 'member' : 'admin';
  UID     = r.aptId || user.uid;
  MY_FLAT = r.flatId || null;
  MY_NAME = r.name || user.displayName || '';
  MY_PHONE = r.phone || '';
  console.info('Gatebook roles build r7 · role:', ROLE);
  applyRoleUI();
  boot();
});

window._doSignOut = async function() {
  await signOut(auth);
  window.location.replace('index.html');
};

/* ════════════════════════════════
   HELPERS for scoped Firestore paths
   All data lives under apartments/{uid}/...
════════════════════════════════ */
const flatsColl   = () => collection(db, 'apartments', UID, 'flats');
const expColl     = () => collection(db, 'apartments', UID, 'expenses');
const issuesColl  = () => collection(db, 'apartments', UID, 'issues');
const aptDocRef   = () => doc(db, 'apartments', UID);
const flatRef     = id => doc(db, 'apartments', UID, 'flats', id);
const issueRef    = id => doc(db, 'apartments', UID, 'issues', id);
const vehColl     = () => collection(db, 'apartments', UID, 'vehicles');
const vehRef      = id => doc(db, 'apartments', UID, 'vehicles', id);
const sexpColl    = () => collection(db, 'apartments', UID, 'soc_expenses');
const sexpRef     = id => doc(db, 'apartments', UID, 'soc_expenses', id);
const contactsColl= () => collection(db, 'apartments', UID, 'contacts');
const contactRef  = id => doc(db, 'apartments', UID, 'contacts', id);

/* ════════════════════════════════
   STATE
════════════════════════════════ */
const flats  = new Map();
const exps   = new Map();
const issues = [];
const contacts = [];          // service contacts (plumber, electrician etc)

let AB='', FS='all', SQ='', RTF='all', FLF='all', MF='all', AM=new Date().toISOString().slice(0,7), AV='analytics', IF='all', STRVIEW='floor';
// Analytics tab state — declared here to avoid TDZ errors
let _anStatus='all', _anFilterType='month', _anSelMonth=AM, _anSelYear=new Date().getFullYear().toString(), _anBlock='all';
const _pieSegs={};
let eu=null, iu=null, vu=null, pu=null;
const vehicles = new Map();   // flatId -> {tw,fw,nums,slot}
const socExps  = [];          // society-level expenses
let president  = null;        // current president object
let customCats = { flat: [], soc: [] }; // user-defined expense categories
const DEFAULT_FLAT_CATS = ['Maintenance','Water','Electricity','Parking','Lift','Security','Cleaning','Corpus Fund','Other'];
const DEFAULT_SOC_CATS  = ['Maintenance','Water','Electricity','Security','Cleaning','Lift','Gardening','Painting','Other'];
let APT_NAME = 'Gatebook';
let APT_CORPUS_FUND = 0;

/* ════════════════════════════════
   HELPERS
════════════════════════════════ */
const st  = f => f.paid>=f.due?'paid':f.paid>0?'partial':'pending';
const sl  = s => ({paid:'Paid in full',partial:'Partial payment',pending:'Not paid'}[s]);
const si  = s => ({paid:'ti-circle-check',partial:'ti-clock',pending:'ti-alert-circle'}[s]);
const inr = n => '₹'+Number(n||0).toLocaleString('en-IN');
const fd  = s => new Date(s).toLocaleDateString('en-IN',{day:'2-digit',month:'short'});
const fdt = ts => {
  if(!ts)return'–';
  const d=ts.toDate?ts.toDate():new Date(ts);
  return d.toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
};
const bks = () => [...new Set([...flats.values()].map(f=>f.block))].sort();
const bfl = b => [...flats.values()].filter(f=>f.block===b);
const fex = id => exps.get(id)||[];
const paidAM = (fid, month) => {
  const m = month || AM;
  return (exps.get(fid)||[]).filter(e=>e.month===m).reduce((s,e)=>s+(e.amt||0),0);
};

/* ── Shared APP context for tab modules ── */
function refreshAPP() { /* no-op — all functions use closure vars directly */ }

/* ── Month selector ── */
function buildMonthSelect() {
  const sel = document.getElementById('mf');
  const opts = [];
  for (let i=0; i<12; i++) {
    const d = new Date();
    d.setMonth(d.getMonth()-i);
    const val = d.toISOString().slice(0,7);
    const lbl = d.toLocaleDateString('en-IN',{month:'long',year:'numeric'});
    opts.push(`<option value="${val}"${val===AM?' selected':''}>${lbl}</option>`);
  }
  sel.innerHTML = opts.join('');
}

/* ════════════════════════════════
   APT NAME
════════════════════════════════ */
function applyAptName(name) {
  APT_NAME = name||'Gatebook';
  document.getElementById('aptNameDisplay').innerHTML =
    `${APT_NAME.replace(/(\w+)$/,'<em>$1</em>')}`;
  document.title = `${APT_NAME} — Powered by AK Group`;
}


/* ════════════════════════════════
   SYNC & TOAST
════════════════════════════════ */
function sync(s) {
  const d=document.getElementById('sdot'),l=document.getElementById('slbl');
  if(!d)return;
  d.className='sdot '+s;
  l.textContent={live:'Live',saving:'Saving…',error:'Error'}[s];
}

function toast(msg, t='success') {
  const el=document.getElementById('toast');
  document.getElementById('tMsg').textContent=msg;
  document.getElementById('tIco').className=t==='success'?'ti ti-circle-check':'ti ti-alert-circle';
  el.className=t+' show';
  setTimeout(()=>el.className='',3200);
}

/* ════════════════════════════════
   RENDER
════════════════════════════════ */
function rStats() {
  const all=[...flats.values()];
  const due=all.reduce((s,f)=>s+f.due,0);
  const paid=all.reduce((s,f)=>s+f.paid,0);
  const pc=all.filter(f=>st(f)==='paid').length;
  const pen=all.filter(f=>st(f)==='pending').length;
  const pct=due?Math.round(paid/due*100):0;
  const oi=issues.filter(i=>i.status==='open').length;
  const ip=issues.filter(i=>i.status==='in-progress').length;

  document.getElementById('openCnt').textContent=oi;
  const bnavBadge = document.getElementById('bnavIssueCnt');
  if (bnavBadge) { bnavBadge.textContent=oi; bnavBadge.style.display=oi>0?'':'none'; }
  // Update flat count badge in navbar
  const badge=document.getElementById('flatCountBadge');
  if(badge){badge.textContent=`${all.length} flats`;badge.style.display='';}
  const totTw=[...vehicles.values()].reduce((s,v)=>s+(parseInt(v.tw)||0),0);
  const totFw=[...vehicles.values()].reduce((s,v)=>s+(parseInt(v.fw)||0),0);
  // Only set phAct if not on president/analytics tab (those tabs set their own phAct)
  if (AV !== 'president' && AV !== 'analytics') {
    document.getElementById('phAct').innerHTML=`
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <button class="btn btn-indigo" onclick="window._oA()"><i class="ti ti-plus"></i> Add Payment</button>
        <button class="btn btn-indigo" onclick="window._oPresExp()"><i class="ti ti-receipt"></i> Add Expense</button>
      </div>`;
  }
  document.getElementById('statsRow').innerHTML=`
    <div class="scard indigo">
      <div class="sc-top"><div class="sc-icon"><i class="ti ti-receipt"></i></div><span class="sc-trend up">This month</span></div>
      <div class="sc-label">Total Due</div><div class="sc-value">${inr(due)}</div>
      <div class="sc-sub">${all.filter(f=>f.resType!=='tenant').length} owners · ${all.filter(f=>f.resType==='tenant').length} tenants</div>
    </div>
    <div class="scard green">
      <div class="sc-top"><div class="sc-icon"><i class="ti ti-circle-check"></i></div><span class="sc-trend up">${pct}% collected</span></div>
      <div class="sc-label">Amount Collected</div><div class="sc-value">${inr(paid)}</div>
      <div class="sc-sub">${pc} of ${all.length} flats fully paid</div>
      <div class="sc-bar"><div class="sc-fill" style="width:${pct}%"></div></div>
    </div>
    <div class="scard amber" onclick="window._showPending()" style="cursor:pointer">
      <div class="sc-top"><div class="sc-icon"><i class="ti ti-clock"></i></div><span class="sc-trend dn">${pen} pending</span></div>
      <div class="sc-label">Outstanding Balance</div><div class="sc-value">${inr(due-paid)}</div>
      <div class="sc-sub">${all.filter(f=>st(f)==='partial').length} partial · ${pen} not paid</div>
      <div class="sc-bar"><div class="sc-fill" style="width:${due?Math.round((due-paid)/due*100):0}%"></div></div>
    </div>
    <div class="scard red">
      <div class="sc-top"><div class="sc-icon"><i class="ti ti-tool"></i></div><span class="sc-trend dn">${ip} in progress</span></div>
      <div class="sc-label">Open Issues</div><div class="sc-value">${oi}</div>
      <div class="sc-sub">${issues.filter(i=>i.status==='resolved').length} resolved</div>
    </div>
  `;
}


window.fMem = fMem;
window.rResidents = rResidents;

function toggleResEdit(fid) {
  const editRow = document.getElementById('redit_'+fid);
  if (!editRow) return;
  const isOpen = editRow.style.display !== 'none';
  // close all others first
  document.querySelectorAll('[id^="redit_"]').forEach(r => r.style.display = 'none');
  if (!isOpen) editRow.style.display = 'table-row';
}

async function saveResEdit(fid) {
  const name    = (document.getElementById('re_name_'+fid)?.value||'').trim();
  const resType = document.getElementById('re_type_'+fid)?.value||'owner';
  const due     = parseInt(document.getElementById('re_due_'+fid)?.value)||0;
  const moveIn  = document.getElementById('re_movein_'+fid)?.value||'';
  const moveOut = document.getElementById('re_moveout_'+fid)?.value||'';
  const tw      = parseInt(document.getElementById('re_tw_'+fid)?.value)||0;
  const fw      = parseInt(document.getElementById('re_fw_'+fid)?.value)||0;
  sync('saving');
  try {
    await updateDoc(flatRef(fid), { owner:name, resType, due, moveIn, moveOut });
    await setDoc(vehRef(fid), { flatId:fid, tw, fw, updatedAt:serverTimestamp() }, {merge:true});
    sync('live');
    toast('Saved ✓');
    document.getElementById('redit_'+fid).style.display = 'none';
  } catch(e) { console.error(e); sync('error'); toast('Save failed.','error'); }
}

window._toggleResEdit = toggleResEdit;
window._saveResEdit   = saveResEdit;

window._oCatM = oCatM;
window._cCatM = cCatM;
window._addCat = addCat;
window._delCat = delCat;
window._cD=cD;
window.switchView=switchView;
window.fIss=fIss;
window.fMem=fMem;
window.rMembers=rMembers;

/* ════════════════════════════════
   FLAT DETAIL MODAL
════════════════════════════════ */
/* ── Flat drawer state ── */
let _dFid = null, _dPage = 0, _dQ = '', _dCat = 'all';
const PAGE_SIZE = 20;

function oFl(fid) {
  _dFid  = fid;
  _dPage = 0;
  _dQ    = '';
  _dCat  = 'all';
  const f = flats.get(fid); if (!f) return;
  const s   = st(f);
  const bal = f.due - f.paid;
  const sc  = s==='paid'?'var(--green)':s==='partial'?'var(--amber)':'var(--red)';
  const month = new Date(AM+'-01').toLocaleDateString('en-IN',{month:'long',year:'numeric'});

  document.getElementById('dTitle').textContent = f.flatId + (f.owner?' — '+f.owner:'');
  document.getElementById('dSub').textContent   = (f.block?'Block '+f.block+' · ':'')+month;

  const ex   = fex(fid);
  const cats = [...new Set(ex.map(e=>e.cat).filter(Boolean))].sort();
  const catOpts = `<option value="all">All categories</option>`
    + cats.map(c=>`<option value="${c}">${c}</option>`).join('');

  document.getElementById('dBody').innerHTML = `
    <div class="drawer-stats">
      <div class="dstat"><div class="dstat-label">Paid</div><div class="dstat-val" style="color:var(--green)">${inr(f.paid)}</div></div>
      <div class="dstat"><div class="dstat-label">Balance</div><div class="dstat-val" style="color:${bal>0?'var(--red)':'var(--green)'}">${inr(Math.abs(bal))}</div></div>
      <div class="dstat"><div class="dstat-label">Status</div><div class="dstat-val" style="font-size:11px;color:${sc}">${sl(s)}</div></div>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;margin-top:12px">
      <div class="etitle" style="margin-bottom:0"><i class="ti ti-list"></i>Payment History <span id="dHistCount" style="font-size:11px;color:var(--muted);font-weight:600"></span></div>
      <button class="btn btn-indigo btn-sm" onclick="window._cD();window._oAFor('${f.block}','${fid}')">
        <i class="ti ti-plus"></i> Add
      </button>
    </div>
    ${ex.length > PAGE_SIZE ? `
    <div class="hist-toolbar">
      <div class="hist-search-wrap">
        <i class="ti ti-search"></i>
        <input class="hist-search" type="text" placeholder="Search category or note…"
          oninput="_dQ=this.value.toLowerCase().trim();_dPage=0;_renderHistPage()"/>
      </div>
      <select class="hist-cat-sel" onchange="_dCat=this.value;_dPage=0;_renderHistPage()">${catOpts}</select>
    </div>` : ''}
    <div id="dHistList"></div>
    <div id="dPager"></div>
  `;

  _renderHistPage();

  document.getElementById('flatDrawer').classList.add('open');
  document.getElementById('drawerBg').classList.add('open');
  document.getElementById('app').classList.add('drawer-open');
}

/* ── Residents tab: edit-only drawer (no payment history) ── */
function oFlEdit(fid) {
  _dFid  = fid;
  const f = flats.get(fid); if (!f) return;
  const isTenant = (f.resType||'owner') === 'tenant';
  const month = new Date(AM+'-01').toLocaleDateString('en-IN',{month:'long',year:'numeric'});

  document.getElementById('dTitle').textContent = f.flatId + (f.owner?' — '+f.owner:'');
  document.getElementById('dSub').textContent   = (f.block?'Block '+f.block+' · ':'')+month;
  const veh = vehicles.get(fid) || { tw:0, fw:0 };
  const tw = parseInt(veh.tw)||0, fw = parseInt(veh.fw)||0;

  const _inp = (id,type,val,ph,extra='') => `<input id="${id}" type="${type}" value="${val}" placeholder="${ph}" ${extra}
    style="width:100%;box-sizing:border-box;height:38px;padding:0 11px;background:#fff;border:1.5px solid var(--border2);
    color:var(--text);font-family:var(--font);font-size:13px;font-weight:600;border-radius:8px;outline:none;"
    onfocus="this.style.borderColor='var(--indigo)'" onblur="this.style.borderColor='var(--border2)'"/>`;
  const _lbl = t => `<div style="font-size:11px;font-weight:800;color:var(--text);text-transform:uppercase;letter-spacing:.4px;margin-bottom:5px;">${t}</div>`;
  const _fld = (lbl,inp) => `<div>${_lbl(lbl)}${inp}</div>`;

  document.getElementById('dBody').innerHTML = `<div style="padding:4px 0 8px;">

    <!-- ── RESIDENT SECTION ── -->
    <div style="margin-bottom:18px;">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:12px;padding-bottom:8px;border-bottom:2px solid var(--indigo);">
        <i class="ti ti-user" style="color:var(--indigo);font-size:15px;"></i>
        <span style="font-size:13px;font-weight:800;color:var(--text);">Resident</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
        ${_fld('Name', _inp('edOwner','text',(f.owner||'').replace(/"/g,'&quot;'),'Full name'))}
        ${_fld('Type', `<select id="edType" onchange="window._toggleOwnerFields(this.value)"
          style="width:100%;height:38px;padding:0 11px;background:#fff;border:1.5px solid var(--border2);
          color:var(--text);font-family:var(--font);font-size:13px;font-weight:600;border-radius:8px;outline:none;box-sizing:border-box;">
          <option value="owner" ${!isTenant?'selected':''}>🏠 Owner</option>
          <option value="tenant" ${isTenant?'selected':''}>🔑 Tenant</option>
        </select>`)}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">
        ${_fld('📱 Mobile Number', _inp('edPhone','tel',(f.phone||f.ownerPhone||'').replace(/"/g,'&quot;'),'10-digit mobile no.'))}
        ${_fld('WhatsApp', `<div style="display:flex;align-items:center;height:38px;gap:8px;">
          <input type="checkbox" id="edWA" ${f.waEnabled!==false?'checked':''}
            style="width:18px;height:18px;accent-color:var(--indigo);cursor:pointer;"/>
          <label for="edWA" style="font-size:12px;font-weight:600;color:var(--text);cursor:pointer;">WhatsApp enabled</label>
        </div>`)}
      </div>

      <!-- Owner fields (tenant only) -->
      <div id="ownerSection" style="display:${isTenant?'grid':'none'};grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">
        ${_fld('Owner Name', _inp('edOwnerName','text',(f.ownerName||'').replace(/"/g,'&quot;'),'Flat owner'))}
        ${_fld('Owner Phone', _inp('edOwnerPhone','tel',(f.ownerPhone||'').replace(/"/g,'&quot;'),'Contact no.'))}
      </div>

      <!-- Status -->
      <div style="display:flex;gap:8px;margin-bottom:12px;">
        <button id="activeTab" type="button" onclick="window._setResidentStatus('active')"
          style="flex:1;height:38px;border:none;background:var(--indigo);color:#fff;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;font-family:var(--font);">
          ✅ Active
        </button>
        <button id="movedTab" type="button" onclick="window._setResidentStatus('moved')"
          style="flex:1;height:38px;border:1.5px solid var(--border2);background:#fff;color:var(--text2);border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;font-family:var(--font);">
          🚪 Moved Out
        </button>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        ${_fld('Move-In Date', _inp('edMoveIn','date',f.moveIn||'',''))}
        <div id="moveOutSection" style="${f.moveOut?'display:block':'display:none'}">
          ${_lbl('Move-Out Date')}${_inp('edMoveOut','date',f.moveOut||',','')}
        </div>
      </div>
    </div>

    <!-- ── FLAT DETAILS SECTION ── -->
    <div style="margin-bottom:18px;">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:12px;padding-bottom:8px;border-bottom:2px solid var(--purple);">
        <i class="ti ti-building" style="color:var(--purple);font-size:15px;"></i>
        <span style="font-size:13px;font-weight:800;color:var(--text);">Flat Details</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;">
        ${_fld('Monthly Due (₹)', _inp('edDue','number',f.due||'','e.g. 5000','min="0"'))}
        ${_fld('Area (sq.ft)', _inp('edSft','number',f.sft||'','e.g. 850','min="0"'))}
        ${_fld('Vehicles 2W/4W', _inp('edVehicles','text',tw+'/'+fw,'1/1'))}
      </div>
    </div>

    <!-- ── SAVE / CANCEL ── -->
    <div style="display:flex;gap:10px;">
      <button onclick="window._cD()"
        style="padding:0 20px;height:44px;border:1.5px solid var(--border2);border-radius:10px;background:#fff;
          color:var(--text2);font-size:13px;font-weight:700;cursor:pointer;font-family:var(--font);white-space:nowrap;">
        Cancel
      </button>
      <button id="edSaveBtn" onclick="window._saveFlat('${fid}')"
        style="padding:0 28px;height:44px;border:none;border-radius:10px;background:var(--indigo);
          color:#fff;font-size:13px;font-weight:700;cursor:pointer;font-family:var(--font);
          display:flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap;">
        <i class="ti ti-device-floppy" style="font-size:15px;"></i> Save
      </button>
    </div>

  </div>


    <!-- HISTORY TOGGLE -->
    <div style="display:flex;gap:6px;background:var(--surface2);padding:6px;border-radius:8px;margin-bottom:14px">
      <button id="payHistToggle" data-history="payment" onclick="window._toggleHistory('payment')" 
        style="flex:1;padding:8px 12px;border:none;background:var(--indigo);color:#fff;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer;font-family:var(--font);transition:all .15s">
        <i class="ti ti-receipt" style="margin-right:4px;font-size:12px"></i>Payment History
      </button>
      <button id="stayHistToggle" data-history="staying" onclick="window._toggleHistory('staying')" 
        style="flex:1;padding:8px 12px;border:none;background:transparent;color:var(--text2);border-radius:6px;font-size:11px;font-weight:700;cursor:pointer;font-family:var(--font);transition:all .15s">
        <i class="ti ti-calendar" style="margin-right:4px;font-size:12px"></i>Staying History
      </button>
    </div>

    <!-- PAYMENT HISTORY -->
    <div id="paymentHistSection" style="background:var(--surface2);border:1.5px solid var(--border);border-radius:var(--r-lg);padding:14px;margin-bottom:14px;display:block">
      <div style="font-size:12px;font-weight:800;color:var(--text);margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;gap:6px">
        <div style="display:flex;align-items:center;gap:6px">
          <i class="ti ti-receipt" style="color:var(--amber);font-size:13px"></i> Payment History
        </div>
        <button type="button" onclick="window._togglePaymentEdit()" style="padding:4px 8px;background:transparent;border:1.5px solid var(--border);color:var(--text2);font-size:10px;font-weight:700;border-radius:4px;cursor:pointer;font-family:var(--font);">
          <i class="ti ti-edit" style="font-size:11px;margin-right:2px"></i>Edit
        </button>
      </div>
      <div id="paymentHistoryList" style="max-height:300px;overflow-y:auto;border-radius:8px"></div>
      <div id="paymentEditSection" style="display:none;margin-top:10px;padding-top:10px;border-top:1.5px solid var(--border)">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
          <input id="newPaymentDate" type="date" placeholder="Date" style="padding:8px;border:1.5px solid var(--border);border-radius:6px;font-family:var(--font);font-size:11px"/>
          <input id="newPaymentAmt" type="number" placeholder="Amount" style="padding:8px;border:1.5px solid var(--border);border-radius:6px;font-family:var(--font);font-size:11px"/>
        </div>
        <button id="paymentBtn" type="button" onclick="window._addPayment('${fid}')" style="width:100%;padding:8px;background:var(--indigo);color:#fff;border:none;border-radius:6px;font-weight:700;font-size:11px;cursor:pointer;font-family:var(--font);">
          + Add Payment
        </button>
      </div>
    </div>

    <!-- STAYING HISTORY -->
    <div id="stayingHistSection" style="background:var(--surface2);border:1.5px solid var(--border);border-radius:var(--r-lg);padding:14px;margin-bottom:14px;display:none">
      <div style="font-size:12px;font-weight:800;color:var(--text);margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;gap:6px">
        <div style="display:flex;align-items:center;gap:6px">
          <i class="ti ti-calendar" style="color:var(--green);font-size:13px"></i> Staying History
        </div>
        <button type="button" onclick="window._toggleStayingEdit()" style="padding:4px 8px;background:transparent;border:1.5px solid var(--border);color:var(--text2);font-size:10px;font-weight:700;border-radius:4px;cursor:pointer;font-family:var(--font);">
          <i class="ti ti-edit" style="font-size:11px;margin-right:2px"></i>Edit
        </button>
      </div>
      <div style="display:grid;gap:8px">
        <!-- All Stay Periods - Chronological -->
        ${(() => {
          // Combine current resident with all stay periods
          const allPeriods = [];
          
          // Add current resident if exists
          if (f.moveIn) {
            allPeriods.push({
              owner: f.owner || 'Resident',
              moveIn: f.moveIn,
              moveOut: f.moveOut || '',
              isCurrent: !f.moveOut
            });
          }
          
          // Add historical periods
          if (f.stayPeriods && f.stayPeriods.length > 0) {
            f.stayPeriods.forEach(p => {
              allPeriods.push({
                owner: p.owner || 'Resident',
                moveIn: p.moveIn,
                moveOut: p.moveOut || '',
                isCurrent: false
              });
            });
          }
          
          // Sort by moveIn date (newest first)
          allPeriods.sort((a, b) => new Date(b.moveIn || 0) - new Date(a.moveIn || 0));
          
          if (allPeriods.length === 0) {
            return '<div style="padding:12px;text-align:center;color:var(--muted);font-size:11px">No stay records yet</div>';
          }
          
          return allPeriods.map((p, idx) => `
            <div style="background:#fff;border:1.5px solid var(--border);border-radius:8px;padding:12px;font-size:12px">
              <div style="display:flex;justify-content:space-between;align-items:flex-start">
                <div style="flex:1">
                  <div style="font-weight:700;color:var(--text)">${p.owner}</div>
                  <div style="color:var(--text2);margin-top:4px;font-size:11px">
                    ${p.moveIn ? new Date(p.moveIn).toLocaleDateString('en-IN',{day:'2-digit',month:'2-digit',year:'numeric'}) : '—'} 
                    → 
                    ${p.moveOut ? new Date(p.moveOut).toLocaleDateString('en-IN',{day:'2-digit',month:'2-digit',year:'numeric'}) : 'Present'}
                  </div>
                  ${p.isCurrent ? '<div style="margin-top:6px;padding:4px 8px;background:var(--green);color:#fff;border-radius:4px;font-size:10px;font-weight:700;width:fit-content">Current</div>' : ''}
                </div>
              </div>
            </div>
          `).join('');
        })()}
      </div>
      <div id="stayingEditSection" style="display:none;margin-top:10px;padding-top:10px;border-top:1.5px solid var(--border)">
        <div style="font-size:11px;font-weight:700;color:var(--text2);margin-bottom:10px;padding:8px;background:var(--surface2);border-radius:6px">
          ℹ️ Edit current resident's dates or add historical stay periods
        </div>
        <div style="display:grid;gap:8px;margin-bottom:8px">
          <div>
            <label style="font-size:10px;font-weight:700;color:var(--text2);margin-bottom:4px;display:block">CURRENT RESIDENT - Move-In Date</label>
            <input id="editMoveIn" type="date" value="${f.moveIn||''}" style="width:100%;padding:8px;border:1.5px solid var(--border);border-radius:6px;font-family:var(--font);font-size:11px;box-sizing:border-box"/>
          </div>
          <div>
            <label style="font-size:10px;font-weight:700;color:var(--text2);margin-bottom:4px;display:block">CURRENT RESIDENT - Move-Out Date</label>
            <input id="editMoveOut" type="date" value="${f.moveOut||''}" placeholder="Leave empty if still staying" style="width:100%;padding:8px;border:1.5px solid var(--border);border-radius:6px;font-family:var(--font);font-size:11px;box-sizing:border-box"/>
          </div>
        </div>
        <div style="display:flex;gap:8px">
          <button type="button" onclick="window._updateStayingDates('${fid}')" style="flex:1;padding:8px;background:var(--indigo);color:#fff;border:none;border-radius:6px;font-weight:700;font-size:11px;cursor:pointer;font-family:var(--font);">
            Save Current Resident
          </button>
          <button type="button" onclick="window._addStayPeriod('${fid}')" style="flex:1;padding:8px;background:var(--green);color:#fff;border:none;border-radius:6px;font-weight:700;font-size:11px;cursor:pointer;font-family:var(--font);">
            + Add Historical Period
          </button>
        </div>
        <div id="stayPeriodsContainer" style="margin-top:10px;display:grid;gap:8px">
          <!-- Additional stay periods will be rendered here -->
        </div>
      </div>
    </div>`;
    
    // Populate payment history after dBody is set
    setTimeout(() => {
    const ex = fex(fid);
    const historyList = document.getElementById('paymentHistoryList');
    if (historyList) {
      if (!ex.length) {
        historyList.innerHTML = '<div style="padding:10px;text-align:center;color:var(--muted)">No payments recorded</div>';
      } else {
        const historyHtml = ex
          .sort((a,b) => new Date(b.rawDate||b.date||0) - new Date(a.rawDate||a.date||0))
          .slice(0, 20)
          .map((e,idx) => {
            const dt = e.rawDate||e.date||'—';
            const amt = e.amt||0;
            const docId = e.expId || e.id;
            return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px;border-bottom:1px solid var(--border);font-size:11px">
              <div style="flex:1">
                <div style="font-weight:600;color:var(--text)">${dt}</div>
                <div style="color:var(--text2);font-size:10px">${e.cat||'Payment'}</div>
              </div>
              <div style="display:flex;align-items:center;gap:8px">
                <div style="font-weight:700;color:var(--green)">${inr(amt)}</div>
                <button onclick="window._editPayment('${fid}','${docId}',${idx})" style="padding:2px 6px;background:transparent;border:none;color:var(--indigo);cursor:pointer;font-size:12px;" title="Edit"><i class="ti ti-edit"></i></button>
                <button onclick="window._deletePayment('${fid}','${docId}')" style="padding:2px 6px;background:transparent;border:none;color:var(--red);cursor:pointer;font-size:12px;" title="Delete"><i class="ti ti-trash"></i></button>
              </div>
            </div>`;
          }).join('');
        historyList.innerHTML = historyHtml;
      }
    }
    
    // Render additional stay periods
    const periodsContainer = document.getElementById('stayPeriodsContainer');
    if (periodsContainer && f && f.stayPeriods && f.stayPeriods.length > 0) {
      periodsContainer.innerHTML = f.stayPeriods.map((p, idx) => {
        const periodOwner = p.owner || f.owner || 'Resident';
        return `<div style="background:#fff;border:1.5px solid var(--border);border-radius:8px;padding:12px;font-size:12px;display:flex;justify-content:space-between;align-items:center">
          <div style="flex:1">
            <div style="font-weight:700;color:var(--text)">${periodOwner}</div>
            <div style="color:var(--text2);margin-top:4px">
              ${p.moveIn ? new Date(p.moveIn).toLocaleDateString('en-IN',{day:'2-digit',month:'2-digit',year:'numeric'}) : '—'} 
              → 
              ${p.moveOut ? new Date(p.moveOut).toLocaleDateString('en-IN',{day:'2-digit',month:'2-digit',year:'numeric'}) : 'Present'}
            </div>
          </div>
          <button onclick="window._deleteStayPeriod('${fid}',${idx})" style="padding:2px 6px;background:transparent;border:none;color:var(--red);cursor:pointer;font-size:12px;margin-left:8px" title="Delete"><i class="ti ti-trash"></i></button>
        </div>`
      }).join('');
    }
  }, 0);

  document.getElementById('flatDrawer').classList.add('open');
  document.getElementById('drawerBg').classList.add('open');
  document.getElementById('app').classList.add('drawer-open');
}

function _renderHistPage() {
  const f   = flats.get(_dFid); if (!f) return;
  const ex  = fex(_dFid);

  /* Filter */
  const vis = ex.filter(e => {
    if (_dCat !== 'all' && e.cat !== _dCat) return false;
    if (_dQ && !(e.cat||'').toLowerCase().includes(_dQ)
            && !(e.note||'').toLowerCase().includes(_dQ)
            && !(e.date||'').toLowerCase().includes(_dQ)) return false;
    return true;
  });

  const tot   = vis.reduce((s,e)=>s+(e.amt||0), 0);
  const pages = Math.max(1, Math.ceil(vis.length / PAGE_SIZE));
  if (_dPage >= pages) _dPage = pages - 1;

  const slice = vis.slice(_dPage * PAGE_SIZE, (_dPage+1) * PAGE_SIZE);

  /* Count label */
  const cntEl = document.getElementById('dHistCount');
  if (cntEl) cntEl.textContent = vis.length
    ? `(${vis.length}${vis.length !== ex.length ? ' filtered' : ''})`
    : '';

  /* Rows */
  const listEl = document.getElementById('dHistList');
  if (!listEl) return;

  if (!vis.length) {
    listEl.innerHTML = `<div class="hist-empty"><i class="ti ti-inbox"></i>${_dQ||_dCat!=='all'?'No records match this filter.':'No payments recorded yet.'}</div>`;
    document.getElementById('dPager').innerHTML = '';
    return;
  }

  listEl.innerHTML = `
    <div class="elist">
      ${slice.map(e=>{
        const eid = e.expId||e.id;
        return `<div class="erow" id="erow_${eid}">
          <div style="flex:1;min-width:0">
            <div class="ecat"><i class="ti ti-tag"></i>${e.cat}</div>
            <div class="edate">${e.date}${e.note?' · '+e.note:''}</div>
          </div>
          <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
            <div class="eamt">${inr(e.amt)}</div>
            <button onclick="window._openExpEdit('${eid}','${_dFid}')"
              style="background:none;border:1.5px solid var(--border);border-radius:var(--r-md);padding:3px 7px;cursor:pointer;color:var(--indigo);font-size:11px;display:flex;align-items:center;gap:3px;white-space:nowrap">
              <i class="ti ti-pencil" style="font-size:11px"></i>
            </button>
            <button onclick="window._delExp('${eid}','${_dFid}')"
              style="background:none;border:1.5px solid var(--border);border-radius:var(--r-md);padding:3px 7px;cursor:pointer;color:var(--red);font-size:11px;display:flex;align-items:center;gap:3px">
              <i class="ti ti-trash" style="font-size:11px"></i>
            </button>
          </div>
        </div>
        <div id="eedit_${eid}" style="display:none;background:var(--surface2);border-bottom:1.5px solid var(--border2);padding:10px 14px">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px">
            <div>
              <div style="font-size:9px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px">Category</div>
              <input id="ec_cat_${eid}" type="text" value="${e.cat||''}"
                style="width:100%;box-sizing:border-box;height:28px;padding:0 7px;background:var(--surface);border:1.5px solid var(--border);color:var(--text);font-family:var(--font);font-size:11px;font-weight:700;border-radius:var(--r-md);outline:none"
                onfocus="this.style.borderColor='var(--indigo)'" onblur="this.style.borderColor='var(--border)'"/>
            </div>
            <div>
              <div style="font-size:9px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px">Amount (₹)</div>
              <input id="ec_amt_${eid}" type="number" value="${e.amt||''}" min="0"
                style="width:100%;box-sizing:border-box;height:28px;padding:0 7px;background:var(--surface);border:1.5px solid var(--border);color:var(--indigo);font-family:var(--font);font-size:12px;font-weight:800;border-radius:var(--r-md);outline:none"
                onfocus="this.style.borderColor='var(--indigo)'" onblur="this.style.borderColor='var(--border)'"/>
            </div>
            <div>
              <div style="font-size:9px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px">Date</div>
              <input id="ec_date_${eid}" type="date" value="${e.rawDate||''}"
                style="width:100%;box-sizing:border-box;height:28px;padding:0 7px;background:var(--surface);border:1.5px solid var(--border);color:var(--text);font-family:var(--font);font-size:11px;font-weight:600;border-radius:var(--r-md);outline:none"
                onfocus="this.style.borderColor='var(--indigo)'" onblur="this.style.borderColor='var(--border)'"/>
            </div>
            <div>
              <div style="font-size:9px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px">Note</div>
              <input id="ec_note_${eid}" type="text" value="${e.note||''}" placeholder="Optional note"
                style="width:100%;box-sizing:border-box;height:28px;padding:0 7px;background:var(--surface);border:1.5px solid var(--border);color:var(--text);font-family:var(--font);font-size:11px;font-weight:500;border-radius:var(--r-md);outline:none"
                onfocus="this.style.borderColor='var(--indigo)'" onblur="this.style.borderColor='var(--border)'"/>
            </div>
          </div>
          <div style="display:flex;gap:6px;justify-content:flex-end">
            <button onclick="window._closeExpEdit('${eid}')"
              style="background:none;border:1.5px solid var(--border);border-radius:var(--r-md);padding:4px 10px;cursor:pointer;color:var(--text2);font-size:11px;font-family:var(--font);font-weight:600">Cancel</button>
            <button onclick="window._saveExpEdit('${eid}','${_dFid}')"
              style="background:var(--indigo);border:none;border-radius:var(--r-md);padding:4px 12px;cursor:pointer;color:#fff;font-size:11px;font-family:var(--font);font-weight:700">Save</button>
          </div>
        </div>`;
      }).join('')}
    </div>
    <div class="etotal" style="margin-top:0">
      <span class="etotal-label">
        ${pages>1?`Page ${_dPage+1}/${pages} · `:''}${vis.length} record${vis.length!==1?'s':''}
      </span>
      <span class="etotal-val">${inr(tot)}</span>
    </div>`;

  /* Pagination (only if more than one page) */
  const pagerEl = document.getElementById('dPager');
  if (pages <= 1) { pagerEl.innerHTML=''; return; }

  const maxBtns = 5;
  let start = Math.max(0, _dPage - Math.floor(maxBtns/2));
  let end   = Math.min(pages, start + maxBtns);
  if (end - start < maxBtns) start = Math.max(0, end - maxBtns);

  let btns = `<button class="pager-btn" onclick="_dPage=Math.max(0,_dPage-1);_renderHistPage()"
    ${_dPage===0?'disabled':''} title="Previous"><i class="ti ti-chevron-left"></i></button>`;

  if (start > 0) btns += `<button class="pager-btn" onclick="_dPage=0;_renderHistPage()">1</button>
    ${start>1?'<span class="pager-info">…</span>':''}`;

  for (let i=start; i<end; i++) {
    btns += `<button class="pager-btn${i===_dPage?' active':''}" onclick="_dPage=${i};_renderHistPage()">${i+1}</button>`;
  }

  if (end < pages) btns += `${end<pages-1?'<span class="pager-info">…</span>':''}
    <button class="pager-btn" onclick="_dPage=${pages-1};_renderHistPage()">${pages}</button>`;

  btns += `<button class="pager-btn" onclick="_dPage=Math.min(${pages-1},_dPage+1);_renderHistPage()"
    ${_dPage===pages-1?'disabled':''} title="Next"><i class="ti ti-chevron-right"></i></button>`;

  pagerEl.innerHTML = `<div class="pager">${btns}</div>`;
}

function cD() {
  document.getElementById('flatDrawer').classList.remove('open');
  document.getElementById('drawerBg').classList.remove('open');
  document.getElementById('app').classList.remove('drawer-open');
}

function cM(){document.getElementById('flatM').classList.remove('open');}

/* auto-save flat fields on blur / select change — no button needed */
let _autoSaveTimer=null;
async function saveFlat(fid) {
  const btn = document.getElementById('edSaveBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader-2" style="font-size:14px;animation:spin .8s linear infinite"></i> Saving…'; }
  const owner      = (document.getElementById('edOwner')?.value||'').trim();
  const resType    = document.getElementById('edType')?.value||'owner';
  const due        = parseInt(document.getElementById('edDue')?.value)||0;
  const sft        = parseInt(document.getElementById('edSft')?.value)||0;
  const moveIn     = document.getElementById('edMoveIn')?.value||'';
  const moveOut    = document.getElementById('edMoveOut')?.value||'';
  const ownerName  = (document.getElementById('edOwnerName')?.value||'').trim();
  const ownerPhone = (document.getElementById('edOwnerPhone')?.value||'').trim();
  const phone      = (document.getElementById('edPhone')?.value||'').trim();
  const waEnabled  = document.getElementById('edWA')?.checked !== false;
  
  // Handle block - preserve existing block/floor if fields not present in drawer
  const existingFlat = flats.get(fid) || {};
  const edBlockEl = document.getElementById('edBlock');
  let block;
  if (edBlockEl) {
    block = edBlockEl.value;
    if (block === '__new__') {
      block = (document.getElementById('edNewBlock')?.value||'').trim();
      if (!block) { toast('Enter new block name', 'error'); if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-device-floppy" style="font-size:15px"></i> Save Changes'; } return; }
    }
  } else {
    // edBlock field not in this drawer — keep existing block intact
    block = existingFlat.block || '';
  }

  const edFloorEl = document.getElementById('edFloor');
  const floor = edFloorEl ? (parseInt(edFloorEl.value)||0) : (existingFlat.floor || 0);
  
  // Parse vehicles format "2/1" into tw and fw
  const vehiclesInput = (document.getElementById('edVehicles')?.value||'0/0').trim();
  const [twStr, fwStr] = vehiclesInput.split('/');
  const tw = parseInt(twStr)||0;
  const fw = parseInt(fwStr)||0;
  
  sync('saving');
  try {
    // Build update payload — always include block/floor to ensure they're preserved
    const updatePayload = { owner, resType, due, sft, moveIn, moveOut, ownerName, ownerPhone, phone, waEnabled };
    // Only write block/floor if they have valid values (prevent wiping with empty string)
    if (block !== undefined && block !== null) updatePayload.block = block;
    if (floor !== undefined) updatePayload.floor = floor;
    await updateDoc(flatRef(fid), updatePayload);
    await setDoc(vehRef(fid), { flatId:fid, tw, fw, updatedAt:serverTimestamp() }, { merge:true });
    vehicles.set(fid, { ...(vehicles.get(fid)||{}), tw, fw });
    sync('live');
    toast('Saved ✓');
    cD(); // close drawer
    rAll(); // refresh data
  } catch(e) {
    console.error(e); sync('error'); toast('Save failed.', 'error');
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-device-floppy" style="font-size:15px"></i> Save Changes'; }
  }
}
// Keep autoSaveFlat as alias for legacy callers
async function autoSaveFlat(fid) { return saveFlat(fid); }

async function autoSaveVeh(fid) {
  const tw = parseInt(document.getElementById('edTw')?.value)||0;
  const fw = parseInt(document.getElementById('edFw')?.value)||0;
  sync('saving');
  try {
    await setDoc(vehRef(fid),{flatId:fid,tw,fw,updatedAt:serverTimestamp()},{merge:true});
    vehicles.set(fid,{...(vehicles.get(fid)||{}),tw,fw});
    sync('live');
    renderAnPayTable();
  } catch(e){ console.error(e);sync('error');toast('Save failed.','error'); }
}
let _autoSaveVehTimer = null;

function toggleOwnerFields(resType) {
  const sec = document.getElementById('ownerSection');
  if (sec) sec.style.display = resType === 'tenant' ? 'grid' : 'none';
}

/* inline edit of a payment amount in history */
function openExpEdit(eid) {
  document.getElementById('eedit_'+eid).style.display = 'block';
}
function closeExpEdit(eid) {
  document.getElementById('eedit_'+eid).style.display = 'none';
}
async function saveExpEdit(eid, fid) {
  const cat     = (document.getElementById('ec_cat_'+eid)?.value||'').trim();
  const amt     = parseInt(document.getElementById('ec_amt_'+eid)?.value)||0;
  const rawDate = document.getElementById('ec_date_'+eid)?.value||'';
  const note    = (document.getElementById('ec_note_'+eid)?.value||'').trim();
  const d       = new Date(rawDate);
  const date    = isNaN(d) ? rawDate : fd(rawDate);
  const expDocRef = doc(db,'apartments',UID,'expenses',eid);
  sync('saving');
  try {
    // Get the expense's month before updating
    const expMonth = (exps.get(fid)||[]).find(e=>(e.expId||e.id)===eid)?.month || AM;
    await updateDoc(expDocRef,{cat,amt,date,rawDate,note});
    const allEx = (exps.get(fid)||[]).filter(e => e.month === expMonth);
    const totalPaid = allEx.reduce((s,e)=> (e.expId||e.id)===eid ? s+amt : s+(e.amt||0), 0);
    await updateDoc(flatRef(fid),{paid:totalPaid});
    sync('live'); toast('Saved ✓'); closeExpEdit(eid);
  } catch(e){ console.error(e);sync('error');toast('Save failed.','error'); }
}

/* delete a flat payment record */
async function delExp(expId, fid) {
  if (!confirm('Delete this payment record?')) return;
  const expDocRef = doc(db,'apartments',UID,'expenses',expId);
  sync('saving');
  try {
    const expMonth = (exps.get(fid)||[]).find(e=>(e.expId||e.id)===expId)?.month || AM;
    await deleteDoc(expDocRef);
    const allEx = (exps.get(fid)||[]).filter(e => e.month === expMonth && (e.expId||e.id)!==expId);
    const totalPaid = allEx.reduce((s,e)=>s+(e.amt||0),0);
    await updateDoc(flatRef(fid),{paid:totalPaid});
    sync('live'); toast('Deleted ✓');
  } catch(e){ console.error(e); sync('error'); toast('Delete failed.','error'); }
}

/* ════════════════════════════════
   ADD EXPENSE MODAL
════════════════════════════════ */
function fBS(){
  document.getElementById('fB').innerHTML=bks().map(b=>`<option value="${b}">Block ${b}</option>`).join('');
  document.getElementById('fB').value=AB;
}
function fFS(){
  const b=document.getElementById('fB').value;
  document.getElementById('fF').innerHTML=bfl(b).map(f=>`<option value="${f.flatId}">${f.flatId} — ${f.owner||'(No owner)'}</option>`).join('');
}
function oA(){fBS();fFS();document.getElementById('fD').value=new Date().toISOString().split('T')[0];document.getElementById('fA').value='';document.getElementById('fN').value='';document.getElementById('fS').value='paid';renderCatOpts('fC','flat');document.getElementById('addM').classList.add('open')}
function oAFor(block,fid){fBS();document.getElementById('fB').value=block;fFS();setTimeout(()=>document.getElementById('fF').value=fid,10);document.getElementById('fD').value=new Date().toISOString().split('T')[0];document.getElementById('fA').value='';document.getElementById('fN').value='';document.getElementById('fS').value='paid';renderCatOpts('fC','flat');document.getElementById('addM').classList.add('open')}
function cA(){document.getElementById('addM').classList.remove('open');}
document.getElementById('fB').addEventListener('change',fFS);

async function sE(){
  const block=document.getElementById('fB').value,fid=document.getElementById('fF').value;
  const cat=document.getElementById('fC').value,amt=parseInt(document.getElementById('fA').value)||0;
  const dv=document.getElementById('fD').value,s=document.getElementById('fS').value;
  const note=document.getElementById('fN').value.trim();
  if(!amt||amt<=0){toast('Please enter a valid amount.','error');return;}
  const f=flats.get(fid);if(!f){toast('Flat not found.','error');return;}
  sync('saving');
  const btn=document.getElementById('svBtn');btn.disabled=true;
  document.getElementById('svLbl').textContent='Saving…';
  try{
    const payMonth = dv ? dv.slice(0,7) : AM;
    await addDoc(expColl(),{flatId:fid,block,cat,amt,date:dv?fd(dv):fd(new Date().toISOString()),rawDate:dv||new Date().toISOString().split('T')[0],note,status:s,month:payMonth,createdAt:serverTimestamp()});
    let np=f.paid;
    if(s==='paid')np=f.due;else if(s==='partial')np=Math.min(f.paid+amt,f.due-1);
    await updateDoc(flatRef(fid),{paid:np});
    sync('live');cA();toast('Payment saved ✓');
  }catch(e){console.error(e);sync('error');toast('Save failed. Check console.','error');}
  finally{btn.disabled=false;document.getElementById('svLbl').textContent='Save Payment';}
}

/* ════════════════════════════════
   ADD FLAT MODAL
════════════════════════════════ */
function oAF(){
  document.getElementById('nB').innerHTML=bks().map(b=>`<option value="${b}">Block ${b}</option>`).join('');
  document.getElementById('nI').value='';document.getElementById('nO').value='';document.getElementById('nD').value='';
  document.getElementById('flatAddM').classList.add('open');
}
function cAF(){document.getElementById('flatAddM').classList.remove('open');}
async function sNF(){
  const block=document.getElementById('nB').value,id=document.getElementById('nI').value.trim().toUpperCase();
  const owner=document.getElementById('nO').value.trim(),due=parseInt(document.getElementById('nD').value)||0;
  if(!id){toast('Enter a flat number.','error');return;}
  if(!owner){toast('Enter owner name.','error');return;}
  if(flats.has(id)){toast(`Flat ${id} already exists.`,'error');return;}
  sync('saving');
  try{
    await setDoc(flatRef(id),{block,owner,resType:'owner',due:0,paid:0,month:AM});
    sync('live');cAF();toast(`Flat ${id} registered ✓`);AB=block;rBTabs();rBlock();
  }catch(e){console.error(e);sync('error');toast('Failed to register flat.','error');}
}

/* ════════════════════════════════
   RAISE ISSUE MODAL
════════════════════════════════ */
function oRI(){
  ['iT','iDe','iFl','iRe'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('iP').value='medium';
  document.getElementById('iBl').innerHTML=bks().map(b=>`<option value="${b}">Block ${b}</option>`).join('')+'<option value="Common">Common Area</option>';
  const btn=document.getElementById('issBtn');btn.disabled=false;
  document.getElementById('issBtnL').textContent='Submit Complaint';
  const _lock=isMember();
  if(_lock){
    document.getElementById('iRe').value=MY_NAME||'';
    document.getElementById('iFl').value=MY_FLAT||'';
    const _f=flats.get(MY_FLAT); if(_f&&_f.block) document.getElementById('iBl').value=_f.block;
  }
  ['iRe','iFl','iBl'].forEach(id=>{document.getElementById(id).disabled=_lock;});
  document.getElementById('rIM').classList.add('open');
}
function cRI(){
  document.getElementById('rIM').classList.remove('open');
  document.getElementById('issBtn').disabled=false;
  document.getElementById('issBtnL').textContent='Submit Complaint';
}
async function sI(){
  const title=document.getElementById('iT').value.trim();
  const cat=document.getElementById('iCa').value;
  const priority=document.getElementById('iP').value;
  const block=document.getElementById('iBl').value;
  const flat=document.getElementById('iFl').value.trim().toUpperCase();
  const desc=document.getElementById('iDe').value.trim();
  const reporter=document.getElementById('iRe').value.trim();
  if(!title){toast('Enter an issue title.','error');return;}
  if(!desc){toast('Please describe the issue.','error');return;}
  if(!reporter){toast('Enter your name.','error');return;}
  const btn=document.getElementById('issBtn');btn.disabled=true;
  document.getElementById('issBtnL').textContent='Submitting…';
  sync('saving');
  try{
    const now=new Date().toISOString();
    await addDoc(issuesColl(),{
      title,cat,priority,block,flat,desc,reporter,
      reporterUid:auth.currentUser?.uid||null,
      status:'open',month:AM,
      timeline:[{action:'Issue reported',by:reporter,status:'open',ts:now}],
      createdAt:serverTimestamp(),
    });
    sync('live');cRI();toast('Issue submitted ✓');switchView('issues');
  }catch(e){
    console.error(e);sync('error');toast('Failed to submit. Try again.','error');
    btn.disabled=false;document.getElementById('issBtnL').textContent='Submit Complaint';
  }
}

/* ════════════════════════════════
   ISSUE DETAIL MODAL
════════════════════════════════ */
function oID(id){
  const iss=issues.find(i=>i.id===id); if(!iss)return;
  document.getElementById('idT').textContent = iss.title;
  document.getElementById('idS').textContent = `${iss.cat} · Reported by ${iss.reporter}`;

  const cats = ['Plumbing','Electrical','Lift','Security','Cleaning','Parking','Noise','Internet','Other'];
  const flatOpts = [...flats.values()]
    .map(f=>`<option value="${f.flatId}"${f.flatId===(iss.flat||iss.block)?'selected':''}>${f.flatId}${f.owner?' — '+f.owner:''}</option>`).join('');

  document.getElementById('idC').innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px">
      <div>
        <label style="font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:3px">Title</label>
        <input id="ie_title" type="text" value="${(iss.title||'').replace(/"/g,'&quot;')}"
          style="width:100%;box-sizing:border-box;height:32px;padding:0 8px;background:var(--surface);border:1.5px solid var(--border);color:var(--text);font-family:var(--font);font-size:12px;font-weight:600;border-radius:var(--r-md);outline:none"
          onfocus="this.style.borderColor='var(--indigo)'" onblur="this.style.borderColor='var(--border)'"/>
      </div>
      <div>
        <label style="font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:3px">Flat / Location</label>
        <select id="ie_flat" style="width:100%;box-sizing:border-box;height:32px;padding:0 8px;background:var(--surface);border:1.5px solid var(--border);color:var(--text);font-family:var(--font);font-size:12px;font-weight:600;border-radius:var(--r-md);outline:none">
          ${flatOpts}
        </select>
      </div>
      <div>
        <label style="font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:3px">Category</label>
        <select id="ie_cat" style="width:100%;box-sizing:border-box;height:32px;padding:0 8px;background:var(--surface);border:1.5px solid var(--border);color:var(--text);font-family:var(--font);font-size:12px;font-weight:600;border-radius:var(--r-md);outline:none">
          ${cats.map(c=>`<option value="${c}"${c===iss.cat?'selected':''}>${c}</option>`).join('')}
        </select>
      </div>
      <div>
        <label style="font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:3px">Priority</label>
        <select id="ie_priority" style="width:100%;box-sizing:border-box;height:32px;padding:0 8px;background:var(--surface);border:1.5px solid var(--border);color:var(--text);font-family:var(--font);font-size:12px;font-weight:600;border-radius:var(--r-md);outline:none">
          <option value="high"   ${iss.priority==='high'   ?'selected':''}>🔴 High</option>
          <option value="medium" ${iss.priority==='medium' ?'selected':''}>🟡 Medium</option>
          <option value="low"    ${iss.priority==='low'    ?'selected':''}>🟢 Low</option>
        </select>
      </div>
      <div>
        <label style="font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:3px">Status</label>
        <select id="ie_status" style="width:100%;box-sizing:border-box;height:32px;padding:0 8px;background:var(--surface);border:1.5px solid var(--border);color:var(--text);font-family:var(--font);font-size:12px;font-weight:600;border-radius:var(--r-md);outline:none">
          <option value="open"        ${iss.status==='open'       ?'selected':''}>⭕ Open</option>
          <option value="in-progress" ${iss.status==='in-progress'?'selected':''}>🔄 In Progress</option>
          <option value="resolved"    ${iss.status==='resolved'   ?'selected':''}>✅ Resolved</option>
        </select>
      </div>
      <div>
        <label style="font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:3px">Reported by</label>
        <input id="ie_reporter" type="text" value="${(iss.reporter||'').replace(/"/g,'&quot;')}"
          style="width:100%;box-sizing:border-box;height:32px;padding:0 8px;background:var(--surface);border:1.5px solid var(--border);color:var(--text);font-family:var(--font);font-size:12px;font-weight:600;border-radius:var(--r-md);outline:none"
          onfocus="this.style.borderColor='var(--indigo)'" onblur="this.style.borderColor='var(--border)'"/>
      </div>
    </div>
    <div style="margin-bottom:14px">
      <label style="font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:3px">Description</label>
      <textarea id="ie_desc" rows="3"
        style="width:100%;box-sizing:border-box;padding:8px;background:var(--surface);border:1.5px solid var(--border);color:var(--text);font-family:var(--font);font-size:12px;border-radius:var(--r-md);outline:none;resize:vertical;line-height:1.6"
        onfocus="this.style.borderColor='var(--indigo)'" onblur="this.style.borderColor='var(--border)'">${_esc(iss.desc||'')}</textarea>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;padding-top:4px;border-top:1px solid var(--border)">
      <button onclick="window._delIssue('${id}')"
        style="background:none;border:1px solid #FCA5A5;border-radius:6px;padding:6px 14px;cursor:pointer;color:var(--red);font-size:12px;font-weight:600;font-family:var(--font);display:inline-flex;align-items:center;gap:5px;margin-right:auto">
        <i class="ti ti-trash" style="font-size:12px"></i> Delete
      </button>
      <button onclick="window._cID()"
        style="background:none;border:1px solid var(--border2);border-radius:6px;padding:6px 16px;cursor:pointer;color:var(--text2);font-size:12px;font-weight:600;font-family:var(--font)">Cancel</button>
      <button onclick="window._saveIss('${id}')"
        style="background:var(--indigo);border:none;border-radius:6px;padding:6px 18px;cursor:pointer;color:#fff;font-size:12px;font-weight:700;font-family:var(--font);display:inline-flex;align-items:center;gap:5px">
        <i class="ti ti-check" style="font-size:12px"></i> Save Changes
      </button>
    </div>
  `;

  const tl=iss.timeline||[{action:'Issue reported',by:iss.reporter,status:'open',ts:null}];
  const tlDotColor={open:'var(--red)',created:'var(--indigo)','in-progress':'var(--amber)',resolved:'var(--green)'};
  document.getElementById('idTL').innerHTML=`
    <div class="etitle" style="margin-top:18px"><i class="ti ti-timeline"></i>Activity Timeline</div>
    ${tl.map((t,i)=>`
      <div class="itl-item">
        <div class="itl-dot-col">
          <div class="itl-dot" style="background:${tlDotColor[t.status]||'var(--indigo)'}"></div>
          ${i<tl.length-1?'<div class="itl-line"></div>':''}
        </div>
        <div class="itl-body">
          <div class="itl-action">${_esc(t.action)}</div>
          <div class="itl-by">By ${_esc(t.by||'System')} · ${t.ts?new Date(t.ts).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}):fdt(iss.createdAt)}</div>
        </div>
      </div>`).join('')}
  `;
  if(isMember()) document.querySelectorAll('#idC input,#idC select,#idC textarea').forEach(el=>{el.disabled=true;});
  document.getElementById('idM').classList.add('open');
}
function cID(){document.getElementById('idM').classList.remove('open');}

async function saveIss(id){
  const iss = issues.find(i=>i.id===id); if(!iss)return;
  const title    = (document.getElementById('ie_title')?.value||'').trim();
  const flat     = document.getElementById('ie_flat')?.value||iss.flat||iss.block;
  const cat      = document.getElementById('ie_cat')?.value||iss.cat;
  const priority = document.getElementById('ie_priority')?.value||iss.priority;
  const status   = document.getElementById('ie_status')?.value||iss.status;
  const reporter = (document.getElementById('ie_reporter')?.value||'').trim();
  const desc     = document.getElementById('ie_desc')?.value||'';
  if(!title){ toast('Title is required.','error'); return; }
  const changed = [];
  if(status!==iss.status) changed.push({action:`Status changed to ${status}`,by:'Admin',status,ts:new Date().toISOString()});
  if(priority!==iss.priority) changed.push({action:`Priority changed to ${priority}`,by:'Admin',status,ts:new Date().toISOString()});
  const timeline = [...(iss.timeline||[]), ...changed];
  sync('saving');
  try{
    await updateDoc(issueRef(id),{title,flat,cat,priority,status,reporter,desc,timeline});
    sync('live'); cID(); toast('Issue updated ✓');
  }catch(e){ console.error(e); sync('error'); toast('Update failed.','error'); }
}
window._saveIss = saveIss;

async function delIssue(id){
  const iss = issues.find(i=>i.id===id); if(!iss)return;
  if(!confirm(`Delete issue "${iss.title}"?\nThis cannot be undone.`)) return;
  sync('saving');
  try{
    await deleteDoc(issueRef(id));
    sync('live'); cID(); toast('Issue deleted ✓');
  }catch(e){ console.error(e); sync('error'); toast('Delete failed.','error'); }
}
window._delIssue = delIssue;

/* ════════════════════════════════
   FIRESTORE LISTENERS
   (scoped under apartments/{uid}/...)
════════════════════════════════ */
let _unsubFlats = null; // unsubscribe handle for flats listener
function listenFlats(){
  if (_unsubFlats) { try { _unsubFlats(); } catch(_){} _unsubFlats = null; }
  let _firstLoad = true;
  _unsubFlats = onSnapshot(flatsColl(), snap => {
    snap.docChanges().forEach(ch => {
      const d = {flatId:ch.doc.id,...ch.doc.data()};
      ch.type==='removed' ? flats.delete(ch.doc.id) : flats.set(ch.doc.id,d);
    });
    if (_firstLoad) {
      _firstLoad = false;
      document.getElementById('lo').style.display  = 'none';
      document.getElementById('app').style.display = '';
    }
    try { refreshAPP(); rAll(); } catch(e) { console.error('rAll error:', e); }
    sync('live');
  },e=>{
    console.error('Flats listener error:',e);
    sync('error');
    document.getElementById('loSub').textContent='⚠ Firebase connection failed. Check console.';
  });
}

function listenExp(){
  if(eu)eu();
  // Load ALL expenses — no orderBy to avoid Firestore index requirement
  eu=onSnapshot(expColl(),snap=>{
    exps.clear();
    snap.forEach(d=>{const e={expId:d.id,...d.data()};const a=exps.get(e.flatId)||[];a.push(e);exps.set(e.flatId,a);});
    rAll();
  },e=>console.error('exp listener',e));
}

function listenIssues(){
  if(iu)iu();
  const q=query(issuesColl(),orderBy('createdAt','desc'));
  iu=onSnapshot(q,snap=>{issues.length=0;snap.forEach(d=>issues.push({id:d.id,...d.data()}));rAll();},
    ()=>{iu=onSnapshot(issuesColl(),snap=>{issues.length=0;snap.forEach(d=>issues.push({id:d.id,...d.data()}));rAll();});});
}

/* ════════════════════════════════
   DOM EVENTS
════════════════════════════════ */
window.fFLF = function() {
  const el = document.getElementById('flf');
  if (el) { FLF = el.value; rBlock(); }
};
const flfEl = document.getElementById('flf');
if (flfEl) flfEl.addEventListener('change',e=>{FLF=e.target.value;rBlock();});
const qiEl = document.getElementById('qi');
if (qiEl) qiEl.addEventListener('input', e=>{SQ=e.target.value.toLowerCase().trim();rBlock();});
// #mf month dropdown removed from UI — AM stays as current month
['flatM','addM','flatAddM','rIM','idM','vehM','presM','presExpM','catM'].forEach(id=>{
  const el=document.getElementById(id);if(!el)return;
  el.addEventListener('click',e=>{
    if(e.target.id===id){cM();cA();cAF();cRI();cID();cVehM();cPresM();cPresExp();}
  });
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){cD();cA();cAF();cRI();cID();cVehM();cPresM();cPresExp();cCatM();}});

/* ════════════════════════════════
   WINDOW EXPOSE
════════════════════════════════ */
window._sB = b => { AB=b; FLF='all'; const flf=document.getElementById('flf'); if(flf)flf.value='all'; refreshAPP(); rBTabs(); rBlock(); };
// Expose functions used in inline onchange/oninput HTML handlers
window.rBTabs  = () => rBTabs();
window.rBlock  = () => rBlock();
window.rStats  = () => rStats();
window.rIssues = () => rIssues();
window.rStructure = rStructure;
window.bks     = bks;
window._setFS  = v => { FS  = v; rBlock(); };
window._setRTF = v => { RTF = v; rBlock(); };
window._setFLF = v => { FLF = v; rBlock(); };
window._setAM  = v => { AM  = v; rBTabs(); rBlock(); rStats(); };
window._oFl  =oFl;  window._oFlEdit=oFlEdit;  window.oFlEdit = oFlEdit; window._cM=cD;
window._autoSaveFlat=autoSaveFlat;
window._saveFlat=saveFlat;
window._toggleOwnerFields=toggleOwnerFields;
window._toggleHistory = v => {
  const payBtn = document.getElementById('payHistToggle');
  const stayBtn = document.getElementById('stayHistToggle');
  const paySec = document.getElementById('paymentHistSection');
  const staySec = document.getElementById('stayingHistSection');
  
  if (v === 'payment') {
    payBtn.style.background = 'var(--indigo)';
    payBtn.style.color = '#fff';
    stayBtn.style.background = 'transparent';
    stayBtn.style.color = 'var(--text2)';
    paySec.style.display = 'block';
    staySec.style.display = 'none';
  } else {
    payBtn.style.background = 'transparent';
    payBtn.style.color = 'var(--text2)';
    stayBtn.style.background = 'var(--indigo)';
    stayBtn.style.color = '#fff';
    paySec.style.display = 'none';
    staySec.style.display = 'block';
  }
};
window._setResidentStatus = (status) => {
  const activeTab = document.getElementById('activeTab');
  const movedTab = document.getElementById('movedTab');
  const moveOutSection = document.getElementById('moveOutSection');
  const moveOutInput = document.getElementById('edMoveOut');
  
  if (status === 'active') {
    // Active Resident - hide move-out date
    activeTab.style.background = 'var(--indigo)';
    activeTab.style.color = '#fff';
    movedTab.style.background = 'transparent';
    movedTab.style.color = 'var(--text2)';
    moveOutSection.style.display = 'none';
    moveOutInput.value = '';
  } else {
    // Moved Out - show move-out date
    activeTab.style.background = 'transparent';
    activeTab.style.color = 'var(--text2)';
    movedTab.style.background = 'var(--indigo)';
    movedTab.style.color = '#fff';
    moveOutSection.style.display = 'block';
  }
};
window._togglePaymentEdit = () => {
  const editSection = document.getElementById('paymentEditSection');
  if (editSection.style.display === 'none') {
    // Opening for new payment
    document.getElementById('newPaymentDate').value = new Date().toISOString().slice(0,10);
    document.getElementById('newPaymentAmt').value = '';
    document.getElementById('newPaymentDate').dataset.docId = '';
    document.getElementById('paymentBtn').innerHTML = '+ Add Payment';
    editSection.style.display = 'block';
    document.getElementById('newPaymentDate').focus();
  } else {
    editSection.style.display = 'none';
  }
};
window._toggleStayingEdit = () => {
  const editSection = document.getElementById('stayingEditSection');
  editSection.style.display = editSection.style.display === 'none' ? 'block' : 'none';
};
window._addPayment = async (fid) => {
  const dateInput = document.getElementById('newPaymentDate');
  const amtInput = document.getElementById('newPaymentAmt');
  const paymentDate = dateInput?.value || new Date().toISOString().slice(0,10);
  const amount = parseInt(amtInput?.value)||0;
  const docId = dateInput?.dataset.docId;
  
  if (amount <= 0) { alert('Enter a valid amount'); return; }
  if (!paymentDate) { alert('Enter payment date'); return; }
  
  try {
    if (docId) {
      // Update existing payment - use setDoc with merge to avoid errors
      const docRef = doc(db, 'apartments', UID, 'expenses', docId);
      await setDoc(docRef, { 
        rawDate: paymentDate, 
        month: paymentDate.slice(0,7), 
        amt: amount,
        updatedAt: serverTimestamp()
      }, { merge: true });
      toast('Payment updated ✓');
    } else {
      // Add new payment
      const exp = { flatId: fid, month: paymentDate.slice(0,7), amt: amount, date: new Date().toISOString(), rawDate: paymentDate };
      await addDoc(collection(db, 'apartments', UID, 'expenses'), exp);
      toast('Payment added ✓');
    }
    dateInput.value = '';
    amtInput.value = '';
    dateInput.dataset.docId = '';
    document.getElementById('paymentEditSection').style.display = 'none';
    cD(); rAll();
  } catch(e) { console.error('Payment save error:', e); toast('Failed to save payment: ' + e.message, 'error'); }
};
window._updateStayingDates = async (fid) => {
  const newMoveIn = document.getElementById('editMoveIn')?.value || '';
  const newMoveOut = document.getElementById('editMoveOut')?.value || '';
  
  try {
    const f = flats.get(fid);
    if (!f) return;
    
    // If moving to a new resident, save current resident to history first
    if (newMoveIn && f.moveIn && newMoveIn !== f.moveIn) {
      // Current resident is being replaced - save their period
      if (!f.stayPeriods) f.stayPeriods = [];
      f.stayPeriods.push({
        owner: f.owner,
        moveIn: f.moveIn,
        moveOut: f.moveOut || new Date().toISOString().slice(0,10)
      });
    }
    
    // Update the primary resident dates
    await updateDoc(flatRef(fid), { 
      moveIn: newMoveIn, 
      moveOut: newMoveOut,
      stayPeriods: f.stayPeriods || []
    });
    
    toast('Dates updated ✓');
    cD(); oFlEdit(fid);
  } catch(e) { console.error(e); toast('Failed to update dates', 'error'); }
};
window._addStayPeriod = async (fid) => {
  const resName = prompt('Enter resident name:');
  if (!resName) return;
  
  const moveIn = prompt('Enter Move-In date (YYYY-MM-DD):');
  if (!moveIn) return;
  
  const moveOut = prompt('Enter Move-Out date (YYYY-MM-DD) or leave empty if currently staying:');
  
  try {
    // Save as a new stay period
    const period = {
      owner: resName,
      moveIn,
      moveOut: moveOut || '',
      addedAt: new Date().toISOString()
    };
    
    const f = flats.get(fid);
    if (!f.stayPeriods) f.stayPeriods = [];
    f.stayPeriods.push(period);
    
    await updateDoc(flatRef(fid), { stayPeriods: f.stayPeriods });
    toast('Stay period added ✓');
    cD(); oFlEdit(fid); // Refresh drawer
  } catch(e) { 
    console.error(e); 
    toast('Failed to add period', 'error'); 
  }
};
window._deleteStayPeriod = async (fid, periodIndex) => {
  if (!confirm('Delete this stay period?')) return;
  
  try {
    const f = flats.get(fid);
    if (f.stayPeriods) {
      f.stayPeriods.splice(periodIndex, 1);
      await updateDoc(flatRef(fid), { stayPeriods: f.stayPeriods });
      toast('Period deleted ✓');
      cD(); oFlEdit(fid); // Refresh
    }
  } catch(e) { 
    console.error(e); 
    toast('Failed to delete period', 'error'); 
  }
};
window._deletePayment = async (fid, docId) => {
  if (!confirm('Delete this payment record?')) return;
  try {
    const docRef = doc(db, 'apartments', UID, 'expenses', docId);
    await deleteDoc(docRef);
    const ex = exps.get(fid)||[];
    const idx = ex.findIndex(e => e.expId === docId || e.id === docId);
    if (idx !== -1) ex.splice(idx, 1);
    toast('Payment deleted ✓');
    cD(); rAll();
  } catch(e) { console.error(e); toast('Failed to delete payment', 'error'); }
};
window._editPayment = (fid, docId, idx) => {
  // Show edit section and populate with current payment data
  const editSection = document.getElementById('paymentEditSection');
  const ex = exps.get(fid)||[];
  const payment = ex[idx];
  
  if (payment) {
    document.getElementById('newPaymentDate').value = payment.rawDate || payment.date || new Date().toISOString().slice(0,10);
    document.getElementById('newPaymentAmt').value = payment.amt || 0;
    document.getElementById('newPaymentDate').dataset.docId = docId;
    document.getElementById('newPaymentDate').dataset.fid = fid;
    document.getElementById('paymentBtn').innerHTML = '💾 Save Payment';
    editSection.style.display = 'block';
    editSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
    document.getElementById('newPaymentDate').focus();
  }
};
window._toggleBlockInput = () => {
  const blockSelect = document.getElementById('edBlock');
  const newBlockInput = document.getElementById('newBlockInput');
  if (blockSelect.value === '__new__') {
    newBlockInput.style.display = 'block';
    document.getElementById('edNewBlock').focus();
  } else {
    newBlockInput.style.display = 'none';
  }
};
window._smSwitchTab = (n) => {
  document.getElementById('smPanel1').style.display = n===1 ? 'flex' : 'none';
  document.getElementById('smPanel1').style.flexDirection = 'column';
  document.getElementById('smPanel2').style.display = n===2 ? 'flex' : 'none';
  document.getElementById('smPanel2').style.flexDirection = 'column';
  const t1 = document.getElementById('smTab1');
  const t2 = document.getElementById('smTab2');
  t1.style.borderBottomColor = n===1 ? 'var(--indigo)' : 'transparent';
  t1.style.color = n===1 ? 'var(--indigo)' : 'var(--muted)';
  t2.style.borderBottomColor = n===2 ? 'var(--indigo)' : 'transparent';
  t2.style.color = n===2 ? 'var(--indigo)' : 'var(--muted)';
};
window._openStructureManager = () => {
  document.getElementById('structureModal').style.display = 'block';
  document.getElementById('newBlockName').value = '';
  document.getElementById('newFlatsContainer').innerHTML = '';
  window._addNewFlatRow();
  window._renderStructureList();
  window._smSwitchTab(1);
};
window._renameBlockPrompt = async (oldName) => {
  const newName = prompt('Rename block:', oldName);
  if (!newName || newName.trim() === oldName) return;
  const nn = newName.trim();
  const toUpdate = [...flats.entries()].filter(([,f]) => f.block === oldName);
  sync('saving');
  try {
    await Promise.all(toUpdate.map(([fid]) => updateDoc(doc(db,'apartments',UID,'flats',fid), {block: nn})));
    toUpdate.forEach(([fid, f]) => { f.block = nn; flats.set(fid, f); });
    sync('live'); toast('Block renamed ✓');
    window._renderStructureList(); rStructure();
  } catch(e) { sync('error'); toast('Rename failed','error'); }
};
window._closeStructureManager = () => {
  document.getElementById('structureModal').style.display = 'none';
};
window._renderStructureList = () => {
  const list = document.getElementById('structureList');
  const blockList = bks();
  
  if (blockList.length === 0) {
    list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted)">No blocks yet. Add a new block to get started.</div>';
    return;
  }
  
  let html = '';
  blockList.forEach(blockName => {
    const blockFlats = [...flats.values()].filter(f => f.block === blockName);
    html += `
      <div style="background:var(--surface2);border:1.5px solid var(--border);border-radius:8px;padding:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <div style="display:flex;align-items:center;gap:6px;">
            <span id="blkLabel_${blockName}" style="font-weight:700;color:var(--text);font-size:13px">${blockName}</span>
            <button onclick="window._renameBlockPrompt('${blockName}')" style="background:none;border:none;color:var(--indigo);cursor:pointer;font-size:12px;padding:2px 4px;" title="Rename">✏️</button>
          </div>
          <button onclick="if(confirm('Delete block ${blockName} and all its flats?')) window._deleteBlock('${blockName}')" style="padding:4px 8px;background:transparent;border:1.5px solid var(--red);color:var(--red);border-radius:6px;font-size:10px;font-weight:700;cursor:pointer;font-family:var(--font)">🗑️</button>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;border-top:1px solid var(--border);padding-top:10px">
          ${blockFlats.length === 0 ? '<div style="color:var(--muted);font-size:11px">No flats</div>' : blockFlats.map(f => {
            // Find the actual fid for this flat
            let actualFid = '';
            for (const [key, flat] of flats.entries()) {
              if (flat.flatId === f.flatId && flat.block === f.block) {
                actualFid = key;
                break;
              }
            }
            return `
            <span style="display:inline-flex;align-items:center;gap:5px;background:#fff;border:1px solid var(--border);border-radius:20px;padding:4px 10px 4px 8px;font-size:11px;font-weight:700;cursor:pointer;"
              onclick="window._closeStructureManager();window.oFlEdit('${actualFid}')" title="${f.owner||'No resident'} · Floor ${f.floor||'—'}">
              <span style="color:var(--indigo)">${f.flatId}</span>
              <button onclick="event.stopPropagation();if(confirm('Delete flat ${f.flatId}?'))window._deleteFlat('${f.flatId}','${blockName}')"
                style="background:none;border:none;color:var(--red);cursor:pointer;font-size:11px;padding:0;line-height:1;display:flex;align-items:center;" title="Delete">✕</button>
            </span>
          `}).join('')}
        </div>
      </div>
    `;
  });
  
  list.innerHTML = html;
};
window._addNewFlatRow = () => {
  const container = document.getElementById('newFlatsContainer');
  const rowId = 'newflat_' + Date.now();
  const rowHtml = `
    <div id="${rowId}" style="background:var(--surface2);padding:12px;border-radius:10px;border:1px solid var(--border);display:flex;flex-direction:column;gap:8px;position:relative;">
      <button type="button" onclick="document.getElementById('${rowId}').remove()"
        style="position:absolute;top:8px;right:8px;padding:2px 7px;background:transparent;border:1px solid var(--red);color:var(--red);border-radius:4px;font-size:11px;font-weight:700;cursor:pointer;font-family:var(--font)">✕</button>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <div>
          <label style="font-size:10px;font-weight:700;color:var(--text2);display:block;margin-bottom:3px;">FLAT #</label>
          <input class="newFlatNum" type="text" placeholder="e.g. 101"
            style="width:100%;padding:9px 10px;border:1.5px solid var(--border);border-radius:7px;font-family:var(--font);font-size:13px;box-sizing:border-box;"/>
        </div>
        <div>
          <label style="font-size:10px;font-weight:700;color:var(--text2);display:block;margin-bottom:3px;">FLOOR</label>
          <input class="newFlatFloor" type="number" placeholder="1" min="1"
            style="width:100%;padding:9px 10px;border:1.5px solid var(--border);border-radius:7px;font-family:var(--font);font-size:13px;box-sizing:border-box;"/>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <div>
          <label style="font-size:10px;font-weight:700;color:var(--text2);display:block;margin-bottom:3px;">RESIDENT</label>
          <input class="newResName" type="text" placeholder="Name"
            style="width:100%;padding:9px 10px;border:1.5px solid var(--border);border-radius:7px;font-family:var(--font);font-size:13px;box-sizing:border-box;"/>
        </div>
        <div>
          <label style="font-size:10px;font-weight:700;color:var(--text2);display:block;margin-bottom:3px;">MONTHLY DUE</label>
          <input class="newMonthlyDue" type="number" placeholder="₹ 0" min="0"
            style="width:100%;padding:9px 10px;border:1.5px solid var(--border);border-radius:7px;font-family:var(--font);font-size:13px;box-sizing:border-box;"/>
        </div>
      </div>
    </div>
  `;
  container.insertAdjacentHTML('beforeend', rowHtml);
};
window._deleteBlock = async (blockName) => {
  try {
    const blockFlats = [...flats.entries()].filter(([_, f]) => f.block === blockName);
    for (const [fid, f] of blockFlats) {
      await deleteDoc(flatRef(fid));
      flats.delete(fid);
      vehicles.delete(fid);
    }
    toast('Block & flats deleted ✓');
    window._renderStructureList();
    rAll();
  } catch(e) {
    console.error(e);
    toast('Failed to delete block: ' + e.message, 'error');
  }
};
window._deleteFlat = async (flatId, blockName) => {
  try {
    // Find the flat by flatId and blockName
    let foundFid = null;
    for (const [fid, f] of flats.entries()) {
      if (f.flatId === flatId && f.block === blockName) {
        foundFid = fid;
        break;
      }
    }
    
    if (!foundFid) {
      toast('Flat not found', 'error');
      return;
    }
    
    await deleteDoc(flatRef(foundFid));
    flats.delete(foundFid);
    vehicles.delete(foundFid);
    toast('Flat deleted ✓');
    window._renderStructureList();
    rAll();
  } catch(e) {
    console.error(e);
    toast('Failed to delete flat: ' + e.message, 'error');
  }
};
window._saveNewStructure = async () => {
  const blockName = document.getElementById('newBlockName').value.trim();
  if (!blockName) { alert('Enter block name'); return; }
  
  const flatRows = document.querySelectorAll('#newFlatsContainer > div');
  if (flatRows.length === 0) { alert('Add at least one flat'); return; }
  
  const newFlats = [];
  flatRows.forEach(row => {
    const flatNum = row.querySelector('.newFlatNum').value.trim();
    const floor = parseInt(row.querySelector('.newFlatFloor').value) || 0;
    const resName = row.querySelector('.newResName').value.trim();
    const due = parseInt(row.querySelector('.newMonthlyDue').value) || 0;
    
    if (flatNum) {
      newFlats.push({ flatNum, floor, resName, due });
    }
  });
  
  if (newFlats.length === 0) { alert('Add flat numbers'); return; }
  
  sync('saving');
  try {
    for (const f of newFlats) {
      const fid = (blockName + '-' + f.flatNum).replace(/[^a-z0-9-]/gi, '_').toLowerCase();
      const flatDoc = {
        flatId: f.flatNum,
        block: blockName,
        floor: f.floor,
        owner: f.resName,
        resType: 'owner',
        due: f.due,
        moveIn: new Date().toISOString().slice(0,10),
        moveOut: '',
        createdAt: serverTimestamp()
      };
      await setDoc(flatRef(fid), flatDoc);
      await setDoc(vehRef(fid), { flatId: fid, tw: 0, fw: 0, updatedAt: serverTimestamp() }, { merge: true });
      flats.set(fid, flatDoc);
      vehicles.set(fid, { tw: 0, fw: 0 });
    }
    
    sync('live');
    toast('Block & flats created ✓');
    window._closeStructureManager();
    window._renderStructureList();
    rAll();
  } catch(e) {
    console.error(e);
    sync('error');
    toast('Failed to create structure', 'error');
  }
};
window.autoSaveVeh=autoSaveVeh;
window._openExpEdit=openExpEdit; window._closeExpEdit=closeExpEdit; window._saveExpEdit=saveExpEdit; window._delExp=delExp;
window._oA   =oA;   window._oAFor=oAFor; window._cA=cA; window._sE=sE;
window._oAF  =oAF;  window._cAF=cAF;    window._sNF=sNF;
window._oRI  =oRI;  window._cRI=cRI;    window._sI=sI;
window._oID=oID; window._cID=cID;
// vehicles.js
window._oVehM   = oVehM;   window._oVehFor = oVehFor;
window._cVehM   = cVehM;   window._sVeh    = sVeh;   window._delVeh = delVeh;
window.rVehicles = rVehicles;
// president.js
window._oPresM   = oPresM;  window._cPresM  = cPresM;  window._sPres   = sPres;

window._presSwTab = (n) => {
  document.getElementById('presPanel1').style.display = n===1 ? 'flex' : 'none';
  document.getElementById('presPanel1').style.flexDirection = 'column';
  document.getElementById('presPanel2').style.display = n===2 ? 'flex' : 'none';
  document.getElementById('presPanel2').style.flexDirection = 'column';
  const t1 = document.getElementById('presTab1');
  const t2 = document.getElementById('presTab2');
  t1.style.borderBottomColor = n===1 ? 'var(--indigo)' : 'transparent';
  t1.style.color = n===1 ? 'var(--indigo)' : 'var(--muted)';
  t2.style.borderBottomColor = n===2 ? 'var(--indigo)' : 'transparent';
  t2.style.color = n===2 ? 'var(--indigo)' : 'var(--muted)';
  if (n===2) window._loadPresHistModal();
};

window._loadPresHistModal = async () => {
  const inn = document.getElementById('presHistModalInner');
  if (!inn) return;
  inn.innerHTML = `<div style="text-align:center;padding:20px;color:var(--muted);font-size:12px;">Loading…</div>`;
  try {
    const presHistColl = () => collection(db, 'apartments', UID, 'presidentHistory');
    let snap;
    try { snap = await getDocs(query(presHistColl(), orderBy('archivedAt','desc'))); }
    catch { snap = await getDocs(presHistColl()); }
    if (snap.empty) {
      inn.innerHTML = `<div style="text-align:center;padding:30px;color:var(--muted);font-size:13px;"><i class="ti ti-history" style="font-size:28px;display:block;margin-bottom:8px;opacity:.4;"></i>No history yet</div>`;
      return;
    }
    // cache rows with doc id for edit/delete
    window._presHistRows = [];
    snap.forEach(d => window._presHistRows.push({ id: d.id, ...d.data() }));
    window._renderPresHistCards();
  } catch(e) { console.error('presHistModal',e); inn.innerHTML = `<div style="text-align:center;padding:20px;color:var(--red);font-size:12px;">Failed to load history</div>`; }
};

window._renderPresHistCards = () => {
  const inn = document.getElementById('presHistModalInner');
  if (!inn) return;
  const rows = window._presHistRows || [];
  const fmtD = s => { if (!s) return '—'; try { return new Date(s).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}); } catch { return s; } };
  const calcTenure = (s,e) => { if (!s) return '—'; const start=new Date(s),end=e?new Date(e):new Date(); const months=Math.max(0,(end.getFullYear()-start.getFullYear())*12+(end.getMonth()-start.getMonth())); return months<1?'< 1 month':months===1?'1 month':months<12?`${months} months`:`${Math.floor(months/12)}y ${months%12}m`; };
  inn.innerHTML = `<div style="position:relative;padding-left:20px;">
    <div style="position:absolute;left:7px;top:0;bottom:0;width:2px;background:var(--border2);border-radius:2px;"></div>
    <div style="display:flex;flex-direction:column;gap:8px;">
      ${rows.map((p,i) => {
        const ini=(p.name||'?').charAt(0).toUpperCase();
        return `<div id="phcard_${i}" style="position:relative;display:flex;align-items:center;gap:10px;background:var(--surface2);border:1px solid var(--border2);border-radius:10px;padding:8px 10px;">
          <div style="position:absolute;left:-16px;width:10px;height:10px;border-radius:50%;background:var(--indigo);border:2px solid #fff;box-shadow:0 0 0 2px var(--indigo);"></div>
          <div style="width:30px;height:30px;border-radius:50%;background:var(--purple-bg);color:var(--purple);font-weight:800;font-size:12px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">${ini}</div>
          <div style="flex:1;min-width:0;">
            <div style="font-weight:700;font-size:12px;color:var(--text);">${p.name||'—'}</div>
            <div style="font-size:10px;color:var(--muted);margin-top:1px;">Flat ${p.flatId||'—'} · ${fmtD(p.termStart)} → ${fmtD(p.termEnd||p.archivedAt)}</div>
            <span style="font-size:9px;font-weight:700;padding:2px 7px;border-radius:20px;background:var(--purple-bg);color:var(--purple);">${calcTenure(p.termStart,p.termEnd||p.archivedAt)}</span>
          </div>
          <div style="display:flex;flex-direction:column;gap:5px;flex-shrink:0;">
            <button onclick="window._editPresHist(${i})" title="Edit"
              style="width:26px;height:26px;border-radius:6px;border:1.5px solid var(--indigo);background:#fff;color:var(--indigo);cursor:pointer;display:flex;align-items:center;justify-content:center;">
              <i class="ti ti-pencil" style="font-size:12px;"></i>
            </button>
            <button onclick="window._delPresHist(${i})" title="Delete"
              style="width:26px;height:26px;border-radius:6px;border:1.5px solid var(--red);background:#fff;color:var(--red);cursor:pointer;display:flex;align-items:center;justify-content:center;">
              <i class="ti ti-trash" style="font-size:12px;"></i>
            </button>
          </div>
        </div>`;
      }).join('')}
    </div>
  </div>`;
};

window._editPresHist = (i) => {
  const p = (window._presHistRows||[])[i];
  if (!p) return;
  document.getElementById('phEdit_idx').value   = i;
  document.getElementById('phEdit_id').value    = p.id;
  document.getElementById('phEdit_name').value  = p.name||'';
  document.getElementById('phEdit_flat').value  = p.flatId||'';
  document.getElementById('phEdit_start').value = p.termStart||'';
  document.getElementById('phEdit_end').value   = p.termEnd||'';
  document.getElementById('phEdit_phone').value = p.phone||'';
  document.getElementById('presHistEditModal').style.display = 'flex';
};

window._closePresHistEdit = () => {
  document.getElementById('presHistEditModal').style.display = 'none';
};

window._savePresHistEdit = async () => {
  const id    = document.getElementById('phEdit_id').value;
  const i     = parseInt(document.getElementById('phEdit_idx').value);
  const name  = document.getElementById('phEdit_name').value.trim();
  const flatId= document.getElementById('phEdit_flat').value.trim();
  const termStart = document.getElementById('phEdit_start').value;
  const termEnd   = document.getElementById('phEdit_end').value;
  const phone = document.getElementById('phEdit_phone').value.trim();
  if (!name) { toast('Name is required','error'); return; }
  try {
    sync('saving');
    await updateDoc(doc(db,'apartments',UID,'presidentHistory',id), {name,flatId,termStart,termEnd,phone});
    sync('live'); toast('Updated ✓');
    window._presHistRows[i] = {...window._presHistRows[i], name,flatId,termStart,termEnd,phone};
    window._closePresHistEdit();
    window._renderPresHistCards();
  } catch(e) { console.error(e); sync('error'); toast('Save failed','error'); }
};

window._delPresHist = async (i) => {
  const p = (window._presHistRows||[])[i];
  if (!p || !confirm(`Delete history record for ${p.name||'this president'}?`)) return;
  try {
    sync('saving');
    await deleteDoc(doc(db,'apartments',UID,'presidentHistory',p.id));
    sync('live'); toast('Deleted ✓');
    window._presHistRows.splice(i,1);
    window._renderPresHistCards();
  } catch(e) { console.error(e); sync('error'); toast('Delete failed','error'); }
};
window._oPresExp = oPresExp; window._cPresExp= cPresExp; window._sPresExp= sPresExp;
window._delSE = delSE; window._openSEEdit = openSEEdit; window._closeSEEdit = closeSEEdit; window._saveSEEdit = saveSEEdit;

// Single ⋮ menu → bottom sheet edit/delete for expense
window._openSEModal = (id) => {
  const e = [...(window._seCache||[])].find(x=>x.id===id);
  if (!e) { console.warn('Expense not found', id); return; }
  const modal = document.getElementById('seActionModal');
  if (!modal) return;
  document.getElementById('seam_id').value    = id;
  document.getElementById('seam_title').value = e.title||'';
  document.getElementById('seam_cat').value   = e.cat||'';
  document.getElementById('seam_amt').value   = e.amt||'';
  document.getElementById('seam_date').value  = e.rawDate||'';
  document.getElementById('seam_note').value  = e.note||'';
  // Update modal header with expense context
  const hdr = document.getElementById('seam_header_title');
  const sub = document.getElementById('seam_header_sub');
  if (hdr) hdr.textContent = e.title || 'Edit Expense';
  if (sub) sub.textContent = (e.cat||'') + (e.date ? ' · ' + e.date : '');
  modal.style.display = 'flex';
};
window._closeSEModal = () => {
  const m = document.getElementById('seActionModal');
  if (m) m.style.display = 'none';
};
window._saveSEModal = async () => {
  const id     = document.getElementById('seam_id').value;
  const title  = document.getElementById('seam_title').value.trim();
  const cat    = document.getElementById('seam_cat').value.trim();
  const amt    = parseInt(document.getElementById('seam_amt').value)||0;
  const rawDate= document.getElementById('seam_date').value;
  const note   = document.getElementById('seam_note').value.trim();
  const d      = new Date(rawDate);
  const date   = isNaN(d) ? rawDate : d.toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
  const month  = isNaN(d) ? '' : d.toISOString().slice(0,7);
  sync('saving');
  try {
    await updateDoc(sexpRef(id), {title,cat,amt,date,rawDate,month,note});
    sync('live'); toast('Saved ✓'); window._closeSEModal(); rPresident();
  } catch(err) { console.error(err); sync('error'); toast('Save failed.','error'); }
};
window._delSEModal = async () => {
  const id = document.getElementById('seam_id').value;
  if (!confirm('Delete this expense?')) return;
  window._closeSEModal(); delSE(id);
};
window.rPresident = rPresident;
// issues.js / members.js
window.fIss = fIss; window.fMem = fMem; window.rMembers = rMembers;

/* ════════════════════════════════
   IN-APP SETUP WIZARD
   Shown when the account has no flats yet
════════════════════════════════ */
let WIZ_BLOCKS = [{ name:'A', floors:4, flatsPerFloor:4 }];

function wizSetStep(n) {
  [0,1,2].forEach(i => {
    document.getElementById('ws'+i).style.display = i===n ? '' : 'none';
  });
  // Update dots
  const dots = document.getElementById('wizDots').children;
  [0,1,2].forEach(i => {
    const d = dots[i];
    if(i < n)       d.style.cssText = 'width:8px;height:8px;border-radius:50%;background:var(--green);flex-shrink:0';
    else if(i === n) d.style.cssText = 'width:24px;height:8px;border-radius:99px;background:var(--indigo);flex-shrink:0';
    else             d.style.cssText = 'width:8px;height:8px;border-radius:50%;background:var(--surface3);flex-shrink:0';
  });
}

function wizRenderBlocks() {
  document.getElementById('wBlocks').innerHTML = WIZ_BLOCKS.map((b,i) => `
    <div class="wiz-block-row">
      <div>
        <label>Block Name</label>
        <input type="text" value="${b.name}" maxlength="3" placeholder="A"
          oninput="WIZ_BLOCKS[${i}].name=this.value.toUpperCase();wizUpdatePreview()"/>
      </div>
      <div>
        <label>Floors</label>
        <input type="number" value="${b.floors}" min="1" max="50"
          oninput="WIZ_BLOCKS[${i}].floors=parseInt(this.value)||1;wizUpdatePreview()"/>
      </div>
      <div>
        <label>Flats / Floor</label>
        <input type="number" value="${b.flatsPerFloor}" min="1" max="20"
          oninput="WIZ_BLOCKS[${i}].flatsPerFloor=parseInt(this.value)||1;wizUpdatePreview()"/>
      </div>
      ${WIZ_BLOCKS.length > 1
        ? `<button class="wiz-rm" onclick="wizRemoveBlock(${i})"><i class="ti ti-trash"></i></button>`
        : '<div></div>'}
    </div>`).join('');
  wizUpdatePreview();
}

function wizRemoveBlock(i) { WIZ_BLOCKS.splice(i,1); wizRenderBlocks(); }

window.WIZ_BLOCKS = WIZ_BLOCKS;
window.wizUpdatePreview = function() {
  let total=0, lines=[];
  WIZ_BLOCKS.forEach(b => {
    const cnt = b.floors * (b.flatsPerFloor||1);
    total += cnt;
    lines.push(`<strong>Block ${b.name||'?'}</strong> — ${b.floors} floor${b.floors!==1?'s':''}, ${b.flatsPerFloor} flat${b.flatsPerFloor!==1?'s':''}/floor = ${cnt} flats`);
  });
  const p = document.getElementById('wPreview');
  if(p) p.innerHTML = lines.join('<br>') + `<br><strong>Total: ${total} flats</strong> will be created`;
};
window.wizRemoveBlock = wizRemoveBlock;

window._wizAddBlock = function() {
  const letters = 'ABCDEFGHIJKLMNOP';
  WIZ_BLOCKS.push({ name: letters[WIZ_BLOCKS.length] || String(WIZ_BLOCKS.length+1), floors:4, flatsPerFloor:4 });
  wizRenderBlocks();
};

window._wizBack = n => wizSetStep(n-1);

window._wizNext = function(from) {
  if(from === 0) {
    const n = document.getElementById('wAptName').value.trim();
    if(!n) { toast('Please enter your apartment name.','error'); return; }
    APT_NAME = n; applyAptName(n);
    wizRenderBlocks();
    wizSetStep(1);
  } else if(from === 1) {
    if(WIZ_BLOCKS.some(b=>!b.name.trim())) { toast('Every block needs a name.','error'); return; }
    // Build confirm preview
    let html = `<strong>${APT_NAME}</strong><br><br>`;
    WIZ_BLOCKS.forEach(b => {
      html += `🏢 <strong>Block ${b.name}</strong>: ${b.floors} floors × ${b.flatsPerFloor} flats = ${b.floors*b.flatsPerFloor} flats<br>`;
      for(let fl=1; fl<=Math.min(b.floors,3); fl++) {
        const ids=[];
        for(let f=1; f<=b.flatsPerFloor; f++) ids.push(`${b.name}-${fl}${String(f).padStart(2,'0')}`);
        html+=`&nbsp;&nbsp;&nbsp;Floor ${fl}: ${ids.join(', ')}<br>`;
      }
      if(b.floors>3) html += `&nbsp;&nbsp;&nbsp;… and ${b.floors-3} more floor${b.floors-3!==1?'s':''}<br>`;
    });
    const tot = WIZ_BLOCKS.reduce((s,b)=>s+b.floors*b.flatsPerFloor,0);
    html += `<br><strong>Total: ${tot} flats</strong> will be auto-created.`;
    document.getElementById('wConfirm').innerHTML = html;
    wizSetStep(2);
  }
};

window._wizLaunch = async function() {
  const btn = document.getElementById('wLaunchBtn');
  btn.disabled = true;
  document.getElementById('wLaunchLbl').textContent = ' Creating…';
  try {
    // Get corpus fund value from input
    const corpusFundValue = parseFloat(document.getElementById('wCorpusFund')?.value || 0) || 0;
    // Save apt config (merge so name is preserved if set)
    await setDoc(aptDocRef(), { name: APT_NAME, blocks: WIZ_BLOCKS, corpusFund: corpusFundValue }, { merge: true });
    // Create flats
    // Check if flats already exist (prevent duplicate creation on double-tap)
    const existingSnap = await getDocs(flatsColl());
    if (!existingSnap.empty) {
      toast('Society already set up — loading…');
      document.getElementById('setupWiz').style.display = 'none';
      document.getElementById('lo').style.display = '';
      listenFlats(); listenExp(); listenIssues(); listenVehicles(); listenSocExp(); listenContacts();
      return;
    }
    for(const b of WIZ_BLOCKS) {
      for(let fl=1; fl<=b.floors; fl++) {
        for(let f=1; f<=b.flatsPerFloor; f++) {
          const fid = `${b.name}-${fl}${String(f).padStart(2,'0')}`;
          await setDoc(flatRef(fid), { block:b.name, floor:fl, owner:'', resType:'owner', due:0, paid:0, month:AM });
        }
      }
    }
    document.getElementById('setupWiz').style.display = 'none';
    document.getElementById('lo').style.display = '';
    // Detach any stale listeners before starting fresh
    [_unsubFlats, eu, iu, vu, pu].forEach(unsub => { try { if(unsub) unsub(); } catch(_){} });
    _unsubFlats = null; eu = null; iu = null; vu = null; pu = null;
    flats.clear(); exps.clear(); issues.length = 0; vehicles.clear(); socExps.length = 0;
    listenFlats(); listenExp(); listenIssues(); listenVehicles(); listenSocExp(); listenContacts();
    toast(`${APT_NAME} launched ✓`);
  } catch(e) {
    console.error(e);
    toast('Launch failed. Check console.','error');
    btn.disabled = false;
    document.getElementById('wLaunchLbl').textContent = ' Launch App';
  }
};

/* ════════════════════════════════
   INLINED: payments.js
════════════════════════════════ */

/* ── switchView (was missing) ── */
function switchView(v) {
  AV = v;
  refreshAPP();
  document.getElementById('iView').style.display          = v==='issues'    ? 'block' : 'none';
  document.getElementById('presView').style.display       = v==='president' ? 'block' : 'none';
  document.getElementById('analyticsView').style.display  = v==='analytics' ? 'block' : 'none';
  document.getElementById('structureView').style.display  = v==='structure' ? 'block' : 'none';
  document.querySelectorAll('.vtab').forEach(p => p.classList.toggle('active', p.dataset.v===v));
  document.querySelectorAll('.bnav-item').forEach(p => p.classList.toggle('active', p.dataset.v===v));
  if(v==='analytics') try{ rAnalytics(); } catch(e){ console.error(e); }
  if(v==='structure') try{ rStructure(); } catch(e){ console.error(e); }
  if(v==='president') {
    try{ rPresident(); } catch(e){ console.error(e); }
    rPresHistory().catch(e => console.error('rPresHistory', e));
  }
  if(v==='payments')  try{ rBTabs(); rBlock(); } catch(e){ console.error(e); }
  // Re-draw charts after layout settles (needed after CSS reorder on mobile)
  if(v==='analytics'||v==='president'){
    setTimeout(()=>{
      try{ if(v==='analytics') rAnalytics(); else rPresident(); }catch(e){}
    },120);
  }
}

function rAll(){
  refreshAPP();
  rStats();
  try{ rIssues(); } catch(e){ console.error('rIssues',e); }
  const p=document.getElementById('presView');
  if(p && p.style.display!=='none') try{ rPresident(); } catch(e){ console.error('rPresident',e); }
  const av=document.getElementById('analyticsView');
  if(av && av.style.display!=='none') try{ rAnalytics(); } catch(e){ console.error('rAnalytics',e); }
  const sv=document.getElementById('structureView');
  if(sv && sv.style.display!=='none') try{ rStructure(); } catch(e){ console.error('rStructure',e); }
}

function listenVehicles(){
  if(vu)vu();
  vu=onSnapshot(vehColl(),snap=>{
    vehicles.clear();
    snap.forEach(d=>vehicles.set(d.id,{...d.data()}));
    console.log('Vehicles loaded:', vehicles.size, 'items');
    rStats();
  },e=>console.error('veh listener',e));
}
function listenSocExp(){
  if(pu)pu();
  const q=query(sexpColl(),orderBy('createdAt','desc'));
  pu=onSnapshot(q,snap=>{
    socExps.length=0;
    snap.forEach(d=>socExps.push({id:d.id,...d.data()}));
    if(document.getElementById('presView').style.display!=='none')rPresident();
  },()=>{
    pu=onSnapshot(sexpColl(),snap=>{socExps.length=0;snap.forEach(d=>socExps.push({id:d.id,...d.data()}));if(document.getElementById('presView').style.display!=='none')rPresident();});
  });
}

let cu=null; // contacts listener unsubscribe handle
function listenContacts(){
  if(cu)cu();
  cu=onSnapshot(contactsColl(),snap=>{
    contacts.length=0;
    snap.forEach(d=>contacts.push({id:d.id,...d.data()}));
    contacts.sort((a,b)=>(a.name||'').localeCompare(b.name||''));
    // Always attempt re-render — _rContacts() itself checks if #contactsList exists
    try { window._rContacts(); } catch(e) { console.error('rContacts render error', e); }
  },e=>{
    console.error('contacts listener error', e);
    toast('Could not load contacts — check connection', 'error');
  });
}



function setAB(v) { AB = v; }

/* ══ payments.js ══ */
/* ═══════════════════════════════
   PAYMENTS TAB — js/payments.js
   Handles: block tabs OR floor tabs (no-block buildings)
   Custom filters: status, resident type, floor, search
════════════════════════════════ */

function hasBlocks() {
  return [...flats.values()].some(f => (f.block || '').trim() !== '');
}

function getFloors(blockOrAll) {
  const all = [...flats.values()];
  const scoped = blockOrAll ? all.filter(f => f.block === blockOrAll) : all;
  return [...new Set(scoped.map(f => f.floor).filter(x => x != null))].sort((a,b) => a - b);
}

function updateFloorFilter(block) {
  const sel = document.getElementById('flf');
  if (!sel) return;
  if (!hasBlocks()) { sel.style.display = 'none'; return; } // no-block uses floor tabs not dropdown
  const floors = getFloors(block);
  if (floors.length > 1) {
    sel.innerHTML = `<option value="all">All floors</option>` +
      floors.map(fl => `<option value="${fl}">Floor ${fl}</option>`).join('');
    sel.style.display = '';
  } else {
    sel.style.display = 'none';
  }
}

function rBTabs() {
  const useBlocks = hasBlocks();

  // Populate payments block filter dropdown
  const pbf = document.getElementById('pbf');
  if (pbf) {
    const curPbf = pbf.value;
    const allBlocks = bks();
    pbf.innerHTML = `<option value="all">All Blocks</option>` +
      allBlocks.map(b => `<option value="${b}"${b === curPbf ? ' selected' : ''}>Block ${b}</option>`).join('');
    if (allBlocks.length <= 1) pbf.style.display = 'none';
    else pbf.style.display = '';
  }

  if (useBlocks) {
    const bs = bks();
    if (!bs.includes(AB)) { AB = bs[0] || ''; setAB(AB); }
    document.getElementById('btabs').innerHTML = bs.map(b => {
      const bf = [...flats.values()].filter(f => f.block === b);
      const pc = bf.filter(f => st(f) === 'paid').length;
      return `<button class="btab${b === AB ? ' active' : ''}" onclick="window._sB('${b}')">
        <i class="ti ti-building"></i> Block ${b}
        <span class="btab-badge">${pc}/${bf.length}</span>
      </button>`;
    }).join('');
    updateFloorFilter(AB);
  } else {
    // No blocks — show floor tabs
    const all = [...flats.values()];
    const floors = [...new Set(all.map(f => f.floor).filter(x => x != null))].sort((a,b) => a - b);
    const flNums = floors.map(String);
    if (!flNums.includes(String(AB))) { AB = String(floors[0] || 1); setAB(AB); }
    document.getElementById('btabs').innerHTML = floors.map(fl => {
      const bf = all.filter(f => f.floor === fl);
      const pc = bf.filter(f => st(f) === 'paid').length;
      return `<button class="btab${String(fl) === String(AB) ? ' active' : ''}" onclick="window._sB('${fl}')">
        <i class="ti ti-stairs"></i> Floor ${fl}
        <span class="btab-badge">${pc}/${bf.length}</span>
      </button>`;
    }).join('');
    document.getElementById('flf').style.display = 'none'; // no dropdown when using floor tabs
  }
}

function rBlock() {
  const useBlocks = hasBlocks();

  let bf = [...flats.values()];
  if (useBlocks) {
    bf = bf.filter(f => f.block === AB);
  } else {
    bf = bf.filter(f => String(f.floor) === String(AB));
  }

  const vis = bf.filter(f => {
    if (FS !== 'all' && st(f) !== FS) return false;
    if (RTF !== 'all') {
      const vacant = !(f.owner || '').trim();
      if (RTF === 'vacant' && !vacant) return false;
      if (RTF === 'owner'  && (vacant || f.resType === 'tenant')) return false;
      if (RTF === 'tenant' && f.resType !== 'tenant') return false;
    }
    if (FLF !== 'all' && useBlocks && String(f.floor) !== String(FLF)) return false;
    if (SQ && !f.flatId.toLowerCase().includes(SQ) && !(f.owner || '').toLowerCase().includes(SQ)) return false;
    return true;
  });

  const pc  = bf.filter(f => st(f) === 'paid').length;
  const col = bf.reduce((s, f) => s + f.paid, 0);
  const headLabel = useBlocks ? `Block ${AB}` : `Floor ${AB}`;

  let h = `<div class="bhead">
    <div class="bhead-left">
      <div class="bstripe"></div>
      <div class="btitle">${headLabel}</div>
      <span class="bbadge">✅ ${pc}/${bf.length} paid</span>
    </div>
    <div class="bcollected">Collected: <strong>${inr(col)}</strong></div>
  </div><div class="fgrid">`;

  if (!vis.length) {
    h += `<div class="empty-grid"><i class="ti ti-search-off"></i>No flats match your filter.</div>`;
  } else {
    // Group by floor when in block view with multiple floors
    const byFloor = {};
    vis.forEach(f => { const fl = f.floor ?? '—'; (byFloor[fl] = byFloor[fl] || []).push(f); });
    const sortedFloors = Object.keys(byFloor).sort((a,b) => Number(a) - Number(b));
    const multiFloor = useBlocks && sortedFloors.length > 1;

    sortedFloors.forEach((fl, idx) => {
      if (multiFloor) {
        if (idx > 0) h += `</div>`;
        h += `<div class="floor-divider"><i class="ti ti-stairs"></i> Floor ${fl}</div><div class="fgrid">`;
      }
      byFloor[fl].forEach(f => {
        const s = st(f), pct = f.due ? Math.round(Math.min(f.paid/f.due*100,100)) : 0;
        h += `<div class="fcard ${s}" onclick="window._oFl('${f.flatId}')" role="button" tabindex="0"
          onkeydown="if(event.key==='Enter')window._oFl('${f.flatId}')">
          <div class="fc-top">
            <div>
              <div class="fc-num">${f.flatId}</div>
              <div class="fc-owner">${f.owner || '(No owner)'}</div>
              <span class="fc-type ${f.resType || 'owner'}">${f.resType === 'tenant' ? 'Tenant' : 'Owner'}</span>
            </div>
            <div class="fc-indicator"><i class="ti ${si(s)}"></i></div>
          </div>
          <div class="fc-amount">${inr(f.paid)}</div>
          <div class="fc-due">of ${inr(f.due)} monthly due</div>
          <div class="fprog"><div class="fpbar" style="width:${pct}%"></div></div>
          <div class="spill ${s}"><i class="ti ${si(s)}"></i>${sl(s)}</div>
        </div>`;
      });
    });
  }
  document.getElementById('bcon').innerHTML = h + '</div>';
}


/* ══ issues.js ══ */
/* ════════════════════════════════
   ISSUES TAB — js/issues.js
   Depends on: window.APP (shared state injected from app.html)
════════════════════════════════ */

function rIssues() {
  document.getElementById('phAct').innerHTML = '';
  const fil = IF === 'all' ? [...issues] : issues.filter(i => i.status === IF);
  const icons = {
    Plumbing: 'ti-tool', Electrical: 'ti-bolt', Lift: 'ti-elevator',
    Security: 'ti-shield', Cleaning: 'ti-vacuum-cleaner', Parking: 'ti-car',
    Noise: 'ti-volume', Internet: 'ti-wifi', Other: 'ti-clipboard'
  };
  const el = document.getElementById('iList');

  if (!fil.length) {
    el.innerHTML = `<div class="iss-empty">
      <i class="ti ti-mood-happy"></i>
      <h3>${IF === 'all' ? 'No issues raised yet' : 'No ' + IF + ' issues found'}</h3>
      <p>${IF === 'all' ? 'Everything is running smoothly!' : 'All clear in this category.'}</p>
    </div>`;
    return;
  }

  el.innerHTML = `
    <table style="width:100%;border-collapse:collapse">
      <thead>
        <tr style="background:var(--surface3)">
          <th style="padding:9px 14px;text-align:left;font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid var(--border2)">Issue</th>
          <th style="padding:9px 14px;text-align:left;font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid var(--border2)">Flat</th>
          <th style="padding:9px 14px;text-align:left;font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid var(--border2)">Category</th>
          <th style="padding:9px 14px;text-align:left;font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid var(--border2)">Reported</th>
          <th style="padding:9px 14px;text-align:center;font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid var(--border2);width:60px">Priority</th>
          <th style="padding:9px 14px;text-align:center;font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid var(--border2);width:60px">Status</th>
        </tr>
      </thead>
      <tbody>
        ${fil.map(iss => {
          const pLabel = iss.priority.charAt(0).toUpperCase() + iss.priority.slice(1);
          const sLabel = iss.status === 'in-progress' ? 'In Progress' : iss.status.charAt(0).toUpperCase() + iss.status.slice(1);

          const pColor = iss.priority === 'high' ? '#EF4444' : iss.priority === 'medium' ? '#F59E0B' : '#22C55E';
          const pIcon  = iss.priority === 'high' ? 'ti-flag-3' : iss.priority === 'medium' ? 'ti-flag-2' : 'ti-flag';

          const sColor = iss.status === 'open' ? '#EF4444' : iss.status === 'in-progress' ? '#F59E0B' : '#22C55E';
          const sIcon  = iss.status === 'open' ? 'ti-circle-x' : iss.status === 'in-progress' ? 'ti-clock' : 'ti-circle-check';

          return `<tr onclick="window._oID('${iss.id}')"
            style="cursor:pointer;transition:background .12s"
            onmouseover="this.style.background='var(--indigo-bg)'" onmouseout="this.style.background=''">
            <td style="padding:11px 14px;border-bottom:1px solid var(--border);vertical-align:middle">
              <div style="font-size:13px;font-weight:600;color:var(--text);display:flex;align-items:center;gap:7px">
                <i class="ti ${icons[iss.cat] || 'ti-clipboard'}" style="font-size:14px;color:var(--indigo);flex-shrink:0"></i>
                ${_esc(iss.title)}
              </div>
              ${iss.desc ? `<div style="font-size:11px;color:var(--text2);margin-top:2px">${_esc(iss.desc.length > 80 ? iss.desc.slice(0,80)+'…' : iss.desc)}</div>` : ''}
            </td>
            <td style="padding:11px 14px;border-bottom:1px solid var(--border);vertical-align:middle">
              <span class="tab-chip indigo">${_esc(iss.flat || iss.block)}</span>
            </td>
            <td style="padding:11px 14px;border-bottom:1px solid var(--border);vertical-align:middle">
              <span class="tab-chip purple">${_esc(iss.cat)}</span>
            </td>
            <td style="padding:11px 14px;border-bottom:1px solid var(--border);vertical-align:middle;font-size:12px;color:var(--text2);white-space:nowrap">
              <div>${fdt(iss.createdAt)}</div>
              <div style="font-size:11px;color:var(--muted);margin-top:1px">By ${_esc(iss.reporter)}</div>
            </td>
            <td style="padding:11px 14px;border-bottom:1px solid var(--border);vertical-align:middle;text-align:center">
              <div title="${pLabel} Priority" style="display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:8px;background:${pColor}18;color:${pColor}">
                <i class="ti ${pIcon}" style="font-size:15px"></i>
              </div>
            </td>
            <td style="padding:11px 14px;border-bottom:1px solid var(--border);vertical-align:middle;text-align:center">
              <div title="${sLabel}" style="display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:8px;background:${sColor}18;color:${sColor}">
                <i class="ti ${sIcon}" style="font-size:15px"></i>
              </div>
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

function fIss(f) {
  IF = f;
  const el = document.getElementById('issStatusFilter');
  if (el) el.value = f;
  rIssues();
}


/* ══ members.js ══ */
/* ════════════════════════════════
   MEMBERS TAB — js/members.js
   Depends on: window.APP (shared state injected from app.html)
════════════════════════════════ */

/* MF declared in state line above */

/* ── Helpers ── */
function tenure(moveIn, moveOut) {
  if (!moveIn) return '—';
  const start = new Date(moveIn);
  const end   = moveOut ? new Date(moveOut) : new Date();
  const days  = Math.floor((end - start) / 86400000);
  if (days < 0) return '—';
  const yrs = Math.floor(days / 365);
  const mos = Math.floor((days % 365) / 30);
  const parts = [];
  if (yrs) parts.push(`${yrs}y`);
  if (mos) parts.push(`${mos}m`);
  if (!parts.length) parts.push(`${days}d`);
  return parts.join(' ');
}

function fmtDate(d) {
  return d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
}

/* ── Filter toggle ── */
function fMem(t) {
  MF = t;
  document.querySelectorAll('.mff').forEach(b => b.classList.toggle('active', b.dataset.t === t));
  rResidents();
}

/* ── Main render ── */
function rMembers() {
  const q = (document.getElementById('memQ')?.value || '').trim().toLowerCase();

  let rows = [...flats.values()].filter(f => {
    if (MF === 'owner'  && (f.resType || 'owner') !== 'owner') return false;
    if (MF === 'tenant' && f.resType !== 'tenant')             return false;
    if (MF === 'vacant' && (f.owner || '').trim())             return false;
    if (q && !f.flatId?.toLowerCase().includes(q)
          && !(f.owner || '').toLowerCase().includes(q)
          && !(f.ownerName || '').toLowerCase().includes(q)) return false;
    return true;
  }).sort((a, b) => (a.flatId || '').localeCompare(b.flatId || ''));

  if (!rows.length) {
    document.getElementById('memList').innerHTML =
      `<div class="mem-empty"><i class="ti ti-users-off"></i>No members found.</div>`;
    return;
  }

  const tRows = rows.map(f => {
    const isVacant   = !(f.owner || '').trim();
    const rType      = isVacant ? 'vacant' : (f.resType || 'owner');
    const isTenant   = rType === 'tenant';
    const typeLabel  = isVacant ? 'Vacant' : isTenant ? '🔑 Tenant' : '🏠 Owner';
    const tenureStr  = isVacant ? '—' : tenure(f.moveIn, f.moveOut);
    const movedIn    = fmtDate(f.moveIn);
    const movedOut   = fmtDate(f.moveOut);
    const allEx      = fex(f.flatId);
    const totalPaid  = allEx.reduce((s, e) => s + e.amt, 0);
    const balance    = (f.due || 0) - (f.paid || 0);
    const payMonths  = [...new Set(allEx.map(e => e.month || e.date?.slice(0, 7)))].filter(Boolean);
    const statusColor = balance > 0 ? 'var(--red)' : balance === 0 && f.due > 0 ? 'var(--green)' : 'var(--muted)';

    // Owner info line — always show; for tenants show actual owner separately
    const residentCell = isVacant
      ? `<span style="color:var(--muted);font-style:italic">Vacant</span>`
      : `<div class="mem-name">${f.owner}</div>`;

    const ownerCell = isTenant
      ? (f.ownerName
          ? `<div style="font-size:12px;font-weight:700;color:var(--text)">${f.ownerName}</div>
             ${f.ownerPhone ? `<div style="font-size:10px;color:var(--text2)">${f.ownerPhone}</div>` : ''}`
          : `<span style="color:var(--muted);font-size:11px">Not set</span>`)
      : `<span style="font-size:11px;color:var(--muted)">—</span>`;

    return `<tr onclick="window._oFl('${f.flatId}')" style="cursor:pointer">
      <td><span class="mem-flat">${f.flatId}</span>${f.block ? `<br><span style="font-size:10px;color:var(--muted)">Block ${f.block}</span>` : ''}</td>
      <td>
        <div style="font-size:12px;font-weight:700;color:var(--text)">${f.owner||'<em style="color:var(--muted);font-weight:400">Vacant</em>'}</div>
        <span class="mem-type ${rType}" style="margin-top:3px">${typeLabel}</span>
      </td>
      <td><span class="mem-tenure"><strong>${tenureStr}</strong></span></td>
      <td><span style="font-size:12px;font-weight:700;color:${statusColor}">${f.due ? inr(Math.abs(balance)) : '—'}</span></td>
    </tr>`;
  }).join('');

  document.getElementById('memList').innerHTML = `
    <table class="mem-table">
      <thead><tr>
        <th>Flat</th>
        <th>Owner</th>
        <th>Stays</th>
        <th>Balance</th>
      </tr></thead>
      <tbody>${tRows}</tbody>
    </table>`;
}


/* ══ vehicles.js ══ */
/* ════════════════════════════════
   VEHICLES TAB — js/vehicles.js
   Reads from: closure vars (shared state)
════════════════════════════════ */

function rVehicles() {
  const q  = (document.getElementById('vehQ')?.value || '').toLowerCase().trim();
  const bf = document.getElementById('vehBF')?.value || 'all';
  const tf = document.getElementById('vehTF')?.value || 'all';
  const all = [...flats.values()];

  // Rebuild block filter dropdown
  const bs = bks();
  const bfSel = document.getElementById('vehBF');
  if (bfSel && bfSel.options.length <= 1) {
    bs.forEach(b => {
      const o = document.createElement('option');
      o.value = b; o.textContent = 'Block ' + b;
      bfSel.appendChild(o);
    });
  }

  const totTw   = [...vehicles.values()].reduce((s, v) => s + (parseInt(v.tw) || 0), 0);
  const totFw   = [...vehicles.values()].reduce((s, v) => s + (parseInt(v.fw) || 0), 0);
  const withVeh = [...flats.values()].filter(f => {
    const v = vehicles.get(f.flatId) || {};
    return (parseInt(v.tw) || 0) + (parseInt(v.fw) || 0) > 0;
  }).length;

  document.getElementById('vehSum').innerHTML = `
    <div class="vscard"><div class="vscard-icon tw"><i class="ti ti-motorbike"></i></div><div><div class="vscard-label">2-Wheelers</div><div class="vscard-val">${totTw}</div></div></div>
    <div class="vscard"><div class="vscard-icon fw"><i class="ti ti-car"></i></div><div><div class="vscard-label">4-Wheelers</div><div class="vscard-val">${totFw}</div></div></div>
  `;

  const rows = all.filter(f => {
    if (bf !== 'all' && f.block !== bf) return false;
    if (q && !f.flatId.toLowerCase().includes(q) && !(f.owner || '').toLowerCase().includes(q)) return false;
    const v = vehicles.get(f.flatId) || {};
    const tw = parseInt(v.tw) || 0, fw = parseInt(v.fw) || 0;
    if (tf === '2w'   && tw === 0) return false;
    if (tf === '4w'   && fw === 0) return false;
    if (tf === 'both' && (tw === 0 || fw === 0)) return false;
    if (tf === 'none' && (tw + fw) > 0) return false;
    return true;
  });

  if (!rows.length) {
    document.getElementById('vehBody').innerHTML = `<tr><td colspan="7" style="text-align:center;padding:3rem;color:var(--muted)"><i class="ti ti-motorbike" style="font-size:32px;display:block;margin-bottom:8px;opacity:.3"></i>No records match your filter.</td></tr>`;
    return;
  }

  document.getElementById('vehBody').innerHTML = rows.map(f => {
    const v = vehicles.get(f.flatId) || { tw: 0, fw: 0, nums: '', slot: '' };
    const tw = parseInt(v.tw) || 0, fw = parseInt(v.fw) || 0;
    const twB = tw > 0 ? `<span class="vbadge tw"><i class="ti ti-motorbike"></i>${tw}</span>` : `<span class="vbadge none">–</span>`;
    const fwB = fw > 0 ? `<span class="vbadge fw"><i class="ti ti-car"></i>${fw}</span>` : `<span class="vbadge none">–</span>`;
    return `<tr>
      <td><strong style="color:var(--indigo)">${f.flatId}</strong></td>
      <td><div style="font-weight:600">${f.owner || '(No owner)'}</div><div style="font-size:10px;color:var(--muted)">${f.resType === 'tenant' ? '🔑 Tenant' : '🏠 Owner'}</div></td>
      <td>${twB}</td>
      <td>${fwB}</td>
      <td style="font-size:12px;color:var(--text2)">${v.nums || '—'}</td>
      <td style="font-size:12px;color:var(--text2)">${v.slot || '—'}</td>
      <td><button class="btn btn-white btn-sm" onclick="window._oVehFor('${f.flatId}')"><i class="ti ti-pencil"></i> Edit</button></td>
    </tr>`;
  }).join('');
}

function oVehM() {
  const first = [...flats.values()][0];
  if (first) oVehFor(first.flatId);
  else toast('No flats found.', 'error');
}

function oVehFor(fid) {
  const f = flats.get(fid);
  const v = vehicles.get(fid) || { tw: 0, fw: 0, nums: '', slot: '' };
  document.getElementById('vehFid').value         = fid;
  document.getElementById('vehMSub').textContent  = fid + (f && f.owner ? ' — ' + f.owner : '');
  document.getElementById('veh2w').value           = v.tw || 0;
  document.getElementById('veh4w').value           = v.fw || 0;
  document.getElementById('vehNums').value         = v.nums || '';
  document.getElementById('vehSlot').value         = v.slot || '';
  document.getElementById('vehDelBtn').style.display = vehicles.has(fid) ? '' : 'none';
  document.getElementById('vehSaveBtn').disabled   = false;
  document.getElementById('vehSaveLbl').textContent = 'Save Vehicles';
  document.getElementById('vehM').classList.add('open');
}

function cVehM() { document.getElementById('vehM').classList.remove('open'); }

async function sVeh() {
  const fid  = document.getElementById('vehFid').value;
  const tw   = parseInt(document.getElementById('veh2w').value)   || 0;
  const fw   = parseInt(document.getElementById('veh4w').value)   || 0;
  const nums = document.getElementById('vehNums').value.trim();
  const slot = document.getElementById('vehSlot').value.trim();
  const btn  = document.getElementById('vehSaveBtn');
  btn.disabled = true;
  document.getElementById('vehSaveLbl').textContent = 'Saving…';
  sync('saving');
  try {
    const { setDoc, serverTimestamp } = await import('https://www.gstatic.com/firebasejs/11.8.1/firebase-firestore.js');
    await setDoc(vehRef(fid), { flatId: fid, tw, fw, nums, slot, updatedAt: serverTimestamp() });
    sync('live'); cVehM(); toast('Vehicles saved ✓');
  } catch(e) { console.error(e); sync('error'); toast('Save failed.', 'error'); }
  finally { btn.disabled = false; document.getElementById('vehSaveLbl').textContent = 'Save Vehicles'; }
}

async function delVeh() {
  const fid = document.getElementById('vehFid').value;
  if (!confirm('Clear vehicle data for this flat?')) return;
  sync('saving');
  try {
    const { deleteDoc } = await import('https://www.gstatic.com/firebasejs/11.8.1/firebase-firestore.js');
    await deleteDoc(vehRef(fid));
    sync('live'); cVehM(); toast('Vehicle data cleared ✓');
  } catch(e) { console.error(e); sync('error'); toast('Delete failed.', 'error'); }
}


/* ══ president.js ══ */
/* ════════════════════════════════
   PRESIDENT TAB — js/president.js
   Reads from: closure vars (shared state)
════════════════════════════════ */

const CAT_ICONS = {
  Maintenance:'ti-tool', Water:'ti-droplet', Electricity:'ti-bolt',
  Security:'ti-shield', Cleaning:'ti-vacuum-cleaner', Lift:'ti-elevator',
  Gardening:'ti-plant', Painting:'ti-paint', Other:'ti-clipboard'
};
const CAT_BG = {
  Maintenance:'var(--indigo-bg)', Water:'var(--sky-bg)', Electricity:'var(--amber-bg)',
  Security:'var(--red-bg)', Cleaning:'var(--green-bg)', Lift:'var(--purple-bg)',
  Gardening:'var(--green-bg)', Painting:'var(--amber-bg)', Other:'var(--surface3)'
};
const CAT_CLR = {
  Maintenance:'var(--indigo)', Water:'var(--sky)', Electricity:'var(--amber)',
  Security:'var(--red)', Cleaning:'var(--green)', Lift:'var(--purple)',
  Gardening:'var(--green)', Painting:'var(--amber)', Other:'var(--text2)'
};

function rPresident() {
  /* ── Save filter selections BEFORE rebuilding DOM ── */
  const _savedYear  = document.getElementById('histYearFilter')?.value  || 'all';
  const _savedMonth = document.getElementById('histMonthFilter')?.value || 'all';
  const _savedCat   = document.getElementById('histCatFilter')?.value   || 'all';

  /* ── Action bar: buttons LEFT, filters RIGHT ── */
  document.getElementById('phAct').innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;width:100%;gap:10px;flex-wrap:wrap;">
      <div style="display:flex;gap:8px;align-items:center;flex-shrink:0;">
        <button class="btn btn-indigo" onclick="window._oA()"><i class="ti ti-plus"></i> Add Payment</button>
        <button class="btn btn-indigo" onclick="window._oPresExp()"><i class="ti ti-receipt"></i> Add Expense</button>
      </div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
        <select id="histYearFilter"
          style="font-size:11px;height:32px;padding:0 8px;border:1.5px solid var(--border2);border-radius:var(--r-md);background:#fff;color:var(--text);font-family:var(--font);font-weight:600;cursor:pointer;outline:none;"
          onchange="rPresident()">
          <option value="all">All Years</option>
        </select>
        <select id="histMonthFilter"
          style="font-size:11px;height:32px;padding:0 8px;border:1.5px solid var(--border2);border-radius:var(--r-md);background:#fff;color:var(--text);font-family:var(--font);font-weight:600;cursor:pointer;outline:none;"
          onchange="rPresident()">
          <option value="all">All Months</option>
        </select>
        <select id="histCatFilter"
          style="font-size:11px;height:32px;padding:0 8px;border:1.5px solid var(--border2);border-radius:var(--r-md);background:#fff;color:var(--text);font-family:var(--font);font-weight:600;cursor:pointer;outline:none;"
          onchange="rPresident()">
          <option value="all">All Categories</option>
        </select>
      </div>
    </div>`;

  /* ── Category colour helpers ── */
  const CAT_ICONS2 = {Maintenance:'ti-tool',Water:'ti-droplet',Electricity:'ti-bolt',Security:'ti-shield',Cleaning:'ti-vacuum-cleaner',Lift:'ti-elevator',Gardening:'ti-plant',Painting:'ti-paint',Internet:'ti-wifi',Parking:'ti-parking',Other:'ti-clipboard'};
  const CAT_COLORS = ['#6366f1','#10b981','#f59e0b','#ef4444','#0ea5e9','#8b5cf6','#ec4899','#14b8a6','#f97316','#84cc16'];
  const catClr  = i => CAT_COLORS[i%CAT_COLORS.length];
  const catIcon = c => CAT_ICONS2[c]||'ti-clipboard';
  const allCatNames = [...new Set(socExps.map(e=>e.cat).filter(Boolean))].sort();

  /* ── Filter dropdowns ── */
  const allMonths = [...new Set(socExps.map(e=>e.month).filter(Boolean))].sort().reverse();
  const allYears  = [...new Set(allMonths.map(m=>m.slice(0,4)))].sort().reverse();
  const allCats   = [...new Set(socExps.map(e=>e.cat).filter(Boolean))].sort();

  // Year dropdown — restore saved selection
  const ySel = document.getElementById('histYearFilter');
  if (ySel) {
    ySel.innerHTML = `<option value="all">All Years</option>` +
      allYears.map(y => `<option value="${y}">${y}</option>`).join('');
    if (_savedYear && allYears.includes(_savedYear)) ySel.value = _savedYear;
  }

  // Month dropdown — cascade by selected year, restore saved selection
  const selectedYear = ySel?.value || 'all';
  const filteredMonths = selectedYear === 'all' ? allMonths : allMonths.filter(m => m.startsWith(selectedYear));
  const mSel = document.getElementById('histMonthFilter');
  if (mSel) {
    mSel.innerHTML = `<option value="all">All Months</option>` +
      filteredMonths.map(m => {
        const lbl = new Date(m + '-01').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
        return `<option value="${m}">${lbl}</option>`;
      }).join('');
    // Default to current month (AM) if available
    if (!_savedMonth) {
      mSel.value = filteredMonths.includes(AM) ? AM : (filteredMonths[0] || 'all');
    } else if (filteredMonths.includes(_savedMonth)) {
      mSel.value = _savedMonth;
    }
  }

  // Category dropdown — restore saved selection
  const cSel = document.getElementById('histCatFilter');
  if (cSel) {
    cSel.innerHTML = `<option value="all">All Categories</option>` +
      allCats.map(c => `<option value="${c}">${c}</option>`).join('');
    if (_savedCat && allCats.includes(_savedCat)) cSel.value = _savedCat;
  }

  /* ── Filter expense rows using saved values ── */
  const yf = _savedYear;
  const mf = (_savedMonth && filteredMonths.includes(_savedMonth)) ? _savedMonth : (mSel?.value || 'all');
  const cf = (_savedCat  && allCats.includes(_savedCat))           ? _savedCat  : (cSel?.value || 'all');

  const vis = socExps.filter(e => {
    if (yf !== 'all' && !(e.month||'').startsWith(yf)) return false;
    if (mf !== 'all' && e.month !== mf)                return false;
    if (cf !== 'all' && e.cat   !== cf)                return false;
    return true;
  });

  /* ── Calculate current month expenses ── */
  const currentMonthExpenses = socExps.filter(e => {
    const m = e.month || '';
    return m === AM;
  });
  const totalCurrentMonthExp = currentMonthExpenses.reduce((s,e)=>s+(e.amt||0),0);

  /* ── Summary cards (Current Month vs All Time) ── */
  const totalAllExp = socExps.reduce((s,e)=>s+(e.amt||0),0);
  const currentMonthLabel = new Date(AM + '-01').toLocaleDateString('en-IN',{month:'long',year:'numeric'});

  /* ── Calculate total society expenses ── */
  const totalSocietyExpenses = socExps.reduce((s, e) => s + (e.amt || 0), 0);
  
  /* ── Calculate all-time payments ── */
  const allTimePayments = Array.from(exps.values())
    .flat()
    .reduce((s, e) => s + (e.amt || 0), 0);

  document.getElementById('fundRow').innerHTML = `
    <div class="fcard2 indigo"><div class="fcard2-label">${currentMonthLabel}</div><div class="fcard2-val">${inr(totalCurrentMonthExp)}</div><div class="fcard2-sub">${currentMonthExpenses.length} record${currentMonthExpenses.length!==1?'s':''}</div></div>
    <div class="fcard2 indigo"><div class="fcard2-label">All Time</div><div class="fcard2-val">${inr(totalAllExp)}</div><div class="fcard2-sub">${socExps.length} records</div></div>`;


  /* ── Build pie segments from filtered data ── */
  const catMap2 = new Map();
  vis.forEach(e => { const c=e.cat||'Other'; catMap2.set(c,(catMap2.get(c)||0)+(e.amt||0)); });
  const expPieSegs2 = [...catMap2.entries()].sort((a,b)=>b[1]-a[1])
    .map(([cat,amt],i)=>({ label:cat, value:amt, color:catClr(i), displayValue:inr(amt) }));

  const visTotal = vis.reduce((s,e)=>s+(e.amt||0),0);

  /* ── Pie chart (always draw, even if empty) ── */
  if (typeof drawPie === 'function') {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      drawPie('expTabPie', expPieSegs2, 'expTabTooltip');
      if (typeof buildLegend === 'function')
        buildLegend('expTabLegend', expPieSegs2.map(s=>({...s,count:s.value})), visTotal);
    }));
  }

  if(!vis.length){
    document.getElementById('presExpList').innerHTML=`<div class="exp-empty"><i class="ti ti-receipt-off"></i>No expenses recorded yet.</div>`;
    return;
  }

  window._seCache = vis;
  document.getElementById('presExpList').innerHTML = (function(){
    var TH = 'padding:8px 10px;font-size:10px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;border-bottom:1.5px solid var(--border2)';
    var TD = 'padding:10px 12px;font-size:12px;border-bottom:1px solid var(--border2);vertical-align:middle';
    var html = '<table style="width:100%;border-collapse:collapse;table-layout:fixed">'
      + '<colgroup><col style="width:36%"/><col style="width:24%"/><col style="width:22%"/><col style="width:18%"/></colgroup>'
      + '<thead><tr style="background:var(--surface3)">'
      + '<th style="'+TH+';text-align:left">Title</th>'
      + '<th style="'+TH+';text-align:center">Category</th>'
      + '<th style="'+TH+';text-align:center">Date</th>'
      + '<th style="'+TH+';text-align:right">Amount</th>'
      + '</tr></thead><tbody>';
    vis.forEach(function(e){
      var ci = allCatNames.indexOf(e.cat);
      var clr = catClr(ci >= 0 ? ci : 0);
      var paidByHtml = e.paidBy ? '<div style="font-size:10px;color:var(--muted);font-weight:400;margin-top:1px">'+e.paidBy+'</div>' : '';
      html += '<tr id="serow_'+e.id+'" onclick="window._openSEModal(&quot;'+e.id+'&quot;)"'
        + ' style="border-bottom:1px solid var(--border2);cursor:pointer;transition:background .12s"'
        + ' onmouseover="this.style.background=\'var(--indigo-bg)\'"'
        + ' onmouseout="this.style.background=\'\'">'
        + '<td style="'+TD+';font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+(e.title||'—')+paidByHtml+'</td>'
        + '<td style="'+TD+';overflow:hidden;text-align:center"><span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px;background:'+clr+'20;color:'+clr+';white-space:nowrap;display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis">'+(e.cat||'—')+'</span></td>'
        + '<td style="'+TD+';font-size:10px;color:var(--muted);white-space:nowrap;text-align:center;overflow:hidden;text-overflow:ellipsis;max-width:0">'+(e.date||'—')+'</td>'
        + '<td style="'+TD+';font-weight:800;color:var(--text);text-align:right;white-space:nowrap;font-size:12px">'+inr(e.amt)+'</td>'
        + '</tr>';
    });
    var totAmt = vis.reduce(function(s,e){ return s + (e.amt||0); }, 0);
    html += '</tbody><tfoot><tr style="background:var(--surface3);border-top:2px solid var(--border2)">'
      + '<td style="padding:10px 12px;font-size:11px;font-weight:800;color:var(--text2)" colspan="3">Total — '+vis.length+' record'+(vis.length!==1?'s':'')+'</td>'
      + '<td style="padding:10px 12px;text-align:right;font-weight:800;color:var(--text);font-size:13px;white-space:nowrap">'+inr(totAmt)+'</td>'
      + '</tr></tfoot>';
    html += '</table>';
    return html;
  })();
}

async function rPresHistory() {
  const sec = document.getElementById('presHistSection');
  const inn = document.getElementById('presHistInner');
  if (!sec || !inn) return;
  try {
    let snap;
    try { snap = await getDocs(query(collection(db,'apartments',UID,'presidentHistory'), orderBy('archivedAt','desc'))); }
    catch { snap = await getDocs(collection(db,'apartments',UID,'presidentHistory')); }
    if (snap.empty) { sec.style.display = 'none'; return; }
    const rows = [];
    snap.forEach(d => rows.push(d.data()));
    sec.style.display = 'block';
    const fmtD = s => { if (!s) return '—'; try { return new Date(s).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}); } catch { return s; } };
    const calcTenure = (s,e) => {
      if (!s) return '—';
      const start = new Date(s), end = e ? new Date(e) : new Date();
      const months = Math.max(0,(end.getFullYear()-start.getFullYear())*12+(end.getMonth()-start.getMonth()));
      return months < 1 ? '< 1 month' : months === 1 ? '1 month' : months < 12 ? `${months} months` : `${Math.floor(months/12)}y ${months%12}m`;
    };
    inn.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">
        <i class="ti ti-history" style="color:var(--purple);font-size:13px;"></i>
        <span style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;">Past Presidents</span>
        <span style="font-size:10px;color:var(--muted);font-weight:500;">(${rows.length})</span>
      </div>
      <div style="position:relative;padding-left:20px;">
        <!-- vertical line -->
        <div style="position:absolute;left:7px;top:0;bottom:0;width:2px;background:var(--border2);border-radius:2px;"></div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${rows.map((p,i) => {
            const ini = (p.name||'?').charAt(0).toUpperCase();
            const tenure = calcTenure(p.termStart, p.termEnd||p.archivedAt);
            return `<div style="position:relative;display:flex;align-items:center;gap:10px;
              background:#fff;border:1px solid var(--border2);border-radius:10px;padding:8px 10px;
              box-shadow:0 1px 3px rgba(0,0,0,.05);">
              <!-- dot on timeline -->
              <div style="position:absolute;left:-16px;width:10px;height:10px;border-radius:50%;
                background:var(--purple);border:2px solid #fff;box-shadow:0 0 0 2px var(--purple);"></div>
              <!-- avatar -->
              <div style="width:30px;height:30px;border-radius:50%;background:var(--purple-bg);color:var(--purple);
                font-weight:800;font-size:12px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">${ini}</div>
              <!-- info -->
              <div style="flex:1;min-width:0;">
                <div style="font-weight:700;font-size:12px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${p.name||'—'}</div>
                <div style="font-size:10px;color:var(--muted);margin-top:1px;">
                  Flat ${p.flatId||'—'} &nbsp;·&nbsp; ${fmtD(p.termStart)} → ${fmtD(p.termEnd||p.archivedAt)}
                </div>
              </div>
              <!-- tenure badge -->
              <span style="font-size:9px;font-weight:700;padding:2px 7px;border-radius:20px;
                background:var(--purple-bg);color:var(--purple);white-space:nowrap;flex-shrink:0;">${tenure}</span>
            </div>`;
          }).join('')}
        </div>
      </div>`;
  } catch(e) { console.error('presHistory',e); sec.style.display='none'; }
}
window.rPresHistory = rPresHistory;

function oPresM() {
  window._presSwTab(1);
  const pres = president;
  const allFlats = [...flats.values()].sort((a,b) => (a.flatId||'').localeCompare(b.flatId||''));
  const byBlock = new Map();
  allFlats.forEach(f => {
    const blk = f.block || 'Other';
    if (!byBlock.has(blk)) byBlock.set(blk, []);
    byBlock.get(blk).push(f);
  });
  const blocks = [...byBlock.keys()].sort();
  document.getElementById('presFlat').innerHTML =
    `<option value="">— Select flat —</option>` +
    blocks.map(blk =>
      `<optgroup label="Block ${blk}">` +
      byBlock.get(blk).map(f =>
        `<option value="${f.flatId}"${pres && pres.flatId === f.flatId ? ' selected' : ''}>
          ${f.flatId}${f.owner ? ' — ' + f.owner : ' (Vacant)'}
        </option>`
      ).join('') +
      `</optgroup>`
    ).join('');
  document.getElementById('presName').value  = pres?.name || '';
  document.getElementById('presStart').value = pres?.termStart || new Date().toISOString().split('T')[0];
  document.getElementById('presEnd').value   = pres?.termEnd || '';
  document.getElementById('presPhone').value = pres?.phone || '';
  document.getElementById('presSaveBtn').disabled = false;
  document.getElementById('presSaveLbl').textContent = 'Elect President';
  document.getElementById('presM').classList.add('open');
}

function cPresM() { document.getElementById('presM').classList.remove('open'); }

async function sPres() {
  const flatId    = document.getElementById('presFlat').value;
  const name      = document.getElementById('presName').value.trim();
  const termStart = document.getElementById('presStart').value;
  const termEnd   = document.getElementById('presEnd').value;
  const phone     = document.getElementById('presPhone').value.trim();
  if (!name) { toast('Enter president name.', 'error'); return; }
  document.getElementById('presSaveBtn').disabled = true;
  document.getElementById('presSaveLbl').textContent = 'Saving…';
  sync('saving');
  try {
    // Archive outgoing president if different
    if (president && president.name && president.name !== name) {
      await addDoc(collection(db,'apartments',UID,'presidentHistory'), {
        ...president,
        archivedAt: new Date().toISOString()
      });
    }
    await setDoc(doc(db,'apartments',UID), { president:{flatId,name,termStart,termEnd,phone,updatedAt:new Date().toISOString()} }, {merge:true});
    president = {flatId,name,termStart,termEnd,phone};
    sync('live'); cPresM(); toast('President elected ✓'); rPresident(); rPresHistory();
  } catch(e) { console.error(e); sync('error'); toast('Save failed.', 'error'); }
  finally { document.getElementById('presSaveBtn').disabled=false; document.getElementById('presSaveLbl').textContent='Elect President'; }
}

function oPresExp() {
  ['peTitle','peAmt','pePaidBy','peVendor','peNote'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('peDate').value = new Date().toISOString().split('T')[0];
  document.getElementById('peCat').value  = 'Maintenance';
  document.getElementById('peBtn').disabled = false;
  document.getElementById('peLbl').textContent = 'Save Expense';
  document.getElementById('presExpM').classList.add('open');
}

function cPresExp() { document.getElementById('presExpM').classList.remove('open'); }

async function sPresExp() {
  const title  = document.getElementById('peTitle').value.trim();
  const cat    = document.getElementById('peCat').value;
  const amt    = parseInt(document.getElementById('peAmt').value) || 0;
  const date   = document.getElementById('peDate').value;
  const paidBy = document.getElementById('pePaidBy').value.trim() || president?.name || 'President';
  const vendor = document.getElementById('peVendor').value.trim();
  const note   = document.getElementById('peNote').value.trim();
  if (!title) { toast('Enter expense title.', 'error'); return; }
  if (!amt)   { toast('Enter amount.', 'error'); return; }
  document.getElementById('peBtn').disabled = true;
  document.getElementById('peLbl').textContent = 'Saving…';
  sync('saving');
  try {
    const { addDoc, serverTimestamp } = await import('https://www.gstatic.com/firebasejs/11.8.1/firebase-firestore.js');
    const d   = new Date(date);
    const mth = d.toISOString().slice(0,7);
    await addDoc(sexpColl(), { title, cat, amt, date:d.toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}), rawDate:date, month:mth, paidBy, vendor, note, status:'pending', createdAt:serverTimestamp() });
    sync('live'); cPresExp(); toast('Society expense recorded ✓');
  } catch(e) { console.error(e); sync('error'); toast('Save failed.', 'error'); }
  finally { document.getElementById('peBtn').disabled=false; document.getElementById('peLbl').textContent='Save Expense'; }
}


async function delSE(id) {
  if (!confirm('Delete this expense?')) return;
  sync('saving');
  try {
    const { deleteDoc } = await import('https://www.gstatic.com/firebasejs/11.8.1/firebase-firestore.js');
    await deleteDoc(sexpRef(id));
    sync('live'); toast('Expense deleted ✓');
  } catch(e) { console.error(e); sync('error'); toast('Delete failed.', 'error'); }
}

function openSEEdit(id) {
  document.querySelectorAll('[id^="seedit_"]').forEach(el => el.style.display = 'none');
  const editEl = document.getElementById('seedit_'+id);
  if (editEl) editEl.style.display = 'block';
}
function closeSEEdit(id) {
  const editEl = document.getElementById('seedit_'+id);
  if (editEl) editEl.style.display = 'none';
}
async function saveSEEdit(id) {
  const title  = (document.getElementById('se_title_'+id)?.value||'').trim();
  const cat    = (document.getElementById('se_cat_'+id)?.value||'').trim();
  const amt    = parseInt(document.getElementById('se_amt_'+id)?.value)||0;
  const rawDate= document.getElementById('se_date_'+id)?.value||'';
  const paidBy = (document.getElementById('se_paidBy_'+id)?.value||'').trim();
  const vendor = (document.getElementById('se_vendor_'+id)?.value||'').trim();
  const note   = (document.getElementById('se_note_'+id)?.value||'').trim();
  const d      = new Date(rawDate);
  const date   = isNaN(d) ? rawDate : d.toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
  const month  = isNaN(d) ? '' : d.toISOString().slice(0,7);
  sync('saving');
  try {
    await updateDoc(sexpRef(id), {title,cat,amt,date,rawDate,month,paidBy,vendor,note});
    sync('live'); toast('Saved ✓'); closeSEEdit(id);
  } catch(e) { console.error(e); sync('error'); toast('Save failed.', 'error'); }
}

// Convenience: open Add Expense modal (alias used in phAct button)


/* ══ RESIDENTS TAB (merged Members + Vehicles) ══ */
function rResidents() {
  // re-use rMembers for now — members tab shows in resView
  // Vehicle summary cards
  const all = [...flats.values()];
  const totTw   = [...vehicles.values()].reduce((s,v)=>s+(parseInt(v.tw)||0),0);
  const totFw   = [...vehicles.values()].reduce((s,v)=>s+(parseInt(v.fw)||0),0);
  const withVeh = all.filter(f=>{const v=vehicles.get(f.flatId)||{};return (parseInt(v.tw)||0)+(parseInt(v.fw)||0)>0;}).length;
  const vs = document.getElementById('vehSum');
  if(vs) vs.innerHTML = `
    <div class="vscard"><div class="vscard-icon tw"><i class="ti ti-motorbike"></i></div><div><div class="vscard-label">2-Wheelers</div><div class="vscard-val">${totTw}</div></div></div>
    <div class="vscard"><div class="vscard-icon fw"><i class="ti ti-car"></i></div><div><div class="vscard-label">4-Wheelers</div><div class="vscard-val">${totFw}</div></div></div>
    <div class="vscard"><div class="vscard-icon tot"><i class="ti ti-parking"></i></div><div><div class="vscard-label">Total Vehicles</div><div class="vscard-val">${totTw+totFw}</div></div></div>
    <div class="vscard"><div class="vscard-icon fl"><i class="ti ti-home-check"></i></div><div><div class="vscard-label">Flats w/ Vehicles</div><div class="vscard-val">${withVeh}/${all.length}</div></div></div>
  `;

  // Render member rows (reuse rMembers logic but target resBody)
  const q = (document.getElementById('memQ')?.value||'').trim().toLowerCase();
  const tf = document.getElementById('resTF')?.value||'all';
  let rows = all.filter(f=>{
    if(MF==='owner'  && (f.resType||'owner')!=='owner') return false;
    if(MF==='tenant' && f.resType!=='tenant')            return false;
    if(MF==='vacant' && (f.owner||'').trim())            return false;
    if(q && !f.flatId?.toLowerCase().includes(q) && !(f.owner||'').toLowerCase().includes(q)) return false;
    const v=vehicles.get(f.flatId)||{};
    const tw=parseInt(v.tw)||0,fw=parseInt(v.fw)||0;
    if(tf==='2w'   && tw===0)     return false;
    if(tf==='4w'   && fw===0)     return false;
    if(tf==='none' && tw+fw>0)    return false;
    return true;
  }).sort((a,b)=>(a.flatId||'').localeCompare(b.flatId||''));

  if(!rows.length){
    document.getElementById('resBody').innerHTML=`<tr><td colspan="4" style="text-align:center;padding:3rem;color:var(--muted)"><i class="ti ti-users-off" style="font-size:32px;display:block;margin-bottom:8px;opacity:.3"></i>No residents match filter.</td></tr>`;
    return;
  }

  function tenure2(moveIn,moveOut){
    if(!moveIn)return'—';
    const days=Math.floor(((moveOut?new Date(moveOut):new Date())-new Date(moveIn))/86400000);
    if(days<0)return'—';
    const y=Math.floor(days/365),m=Math.floor((days%365)/30);
    return [y?y+'y':'',m?m+'m':''].filter(Boolean).join(' ')||days+'d';
  }
  function fmtD(d){return d?new Date(d).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}):'—';}

  document.getElementById('resBody').innerHTML = rows.map(f=>{
    const isVacant=(!(f.owner||'').trim());
    const rType=isVacant?'vacant':(f.resType||'owner');
    const isTenant=rType==='tenant';
    const v=vehicles.get(f.flatId)||{tw:0,fw:0,nums:'',slot:''};
    const tw=parseInt(v.tw)||0,fw=parseInt(v.fw)||0;
    const twB=tw>0?`<span class="vbadge tw"><i class="ti ti-motorbike"></i>${tw}</span>`:`<span class="vbadge none">–</span>`;
    const fwB=fw>0?`<span class="vbadge fw"><i class="ti ti-car"></i>${fw}</span>`:`<span class="vbadge none">–</span>`;
    const fid=f.flatId;
    return `
    <tr id="rrow_${fid}" onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background=''">
      <td style="padding:11px 14px;border-bottom:1px solid var(--border);vertical-align:middle">
        <strong style="color:var(--indigo);font-size:12px;font-weight:800">${fid}</strong>
      </td>
      <td style="padding:11px 14px;border-bottom:1px solid var(--border);vertical-align:middle">
        <div style="font-size:13px;font-weight:700;color:var(--text)">${f.owner||'<em style="color:var(--muted);font-weight:400">Vacant</em>'}</div>
        <span class="mem-type ${rType}" style="margin-top:3px;display:inline-block">${isVacant?'Vacant':isTenant?'🔑 Tenant':'🏠 Owner'}</span>
      </td>
      <td style="padding:11px 14px;border-bottom:1px solid var(--border);vertical-align:middle">${twB}</td>
      <td style="padding:11px 14px;border-bottom:1px solid var(--border);vertical-align:middle">${fwB}</td>
      <td style="padding:11px 14px;border-bottom:1px solid var(--border);vertical-align:middle;text-align:right">
        <button onclick="window._toggleResEdit('${fid}')"
          style="background:var(--indigo-bg);border:1px solid var(--indigo);border-radius:6px;padding:4px 10px;cursor:pointer;color:var(--indigo);font-size:11px;font-weight:700;font-family:var(--font);display:inline-flex;align-items:center;gap:4px">
          <i class="ti ti-pencil" style="font-size:11px"></i> Edit
        </button>
      </td>
    </tr>
    <tr id="redit_${fid}" style="display:none">
      <td colspan="5" style="padding:0;border-bottom:2px solid var(--indigo)">
        <div style="background:var(--surface2);padding:14px 16px">
          <div style="font-size:10px;font-weight:700;color:var(--indigo);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;display:flex;align-items:center;gap:6px">
            <i class="ti ti-pencil"></i> Edit Resident — ${fid}
            <button onclick="window._toggleResEdit('${fid}')" style="margin-left:auto;background:none;border:none;cursor:pointer;color:var(--muted);font-size:16px;line-height:1;padding:0"><i class="ti ti-x"></i></button>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;margin-bottom:10px">
            <div>
              <div style="font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px">Name</div>
              <input id="re_name_${fid}" type="text" value="${(f.owner||'').replace(/"/g,'&quot;')}" placeholder="Full name"
                style="width:100%;box-sizing:border-box;height:32px;padding:0 8px;background:#fff;border:1px solid var(--border2);color:var(--text);font-family:var(--font);font-size:12px;font-weight:600;border-radius:6px;outline:none"
                onfocus="this.style.borderColor='var(--indigo)'" onblur="this.style.borderColor='var(--border2)'"/>
            </div>
            <div>
              <div style="font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px">Type</div>
              <select id="re_type_${fid}"
                style="width:100%;box-sizing:border-box;height:32px;padding:0 8px;background:#fff;border:1px solid var(--border2);color:var(--text);font-family:var(--font);font-size:12px;font-weight:600;border-radius:6px;outline:none">
                <option value="owner" ${!isTenant?'selected':''}>🏠 Owner</option>
                <option value="tenant" ${isTenant?'selected':''}>🔑 Tenant</option>
              </select>
            </div>
            <div>
              <div style="font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px">Monthly Due (₹)</div>
              <input id="re_due_${fid}" type="number" value="${f.due||''}" placeholder="5000" min="0"
                style="width:100%;box-sizing:border-box;height:32px;padding:0 8px;background:#fff;border:1px solid var(--border2);color:var(--text);font-family:var(--font);font-size:12px;font-weight:600;border-radius:6px;outline:none"
                onfocus="this.style.borderColor='var(--indigo)'" onblur="this.style.borderColor='var(--border2)'"/>
            </div>
            <div>
              <div style="font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px">Move-In</div>
              <input id="re_movein_${fid}" type="date" value="${f.moveIn||''}"
                style="width:100%;box-sizing:border-box;height:32px;padding:0 8px;background:#fff;border:1px solid var(--border2);color:var(--text);font-family:var(--font);font-size:12px;border-radius:6px;outline:none"
                onfocus="this.style.borderColor='var(--indigo)'" onblur="this.style.borderColor='var(--border2)'"/>
            </div>
            <div>
              <div style="font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px">Move-Out</div>
              <input id="re_moveout_${fid}" type="date" value="${f.moveOut||''}"
                style="width:100%;box-sizing:border-box;height:32px;padding:0 8px;background:#fff;border:1px solid var(--border2);color:var(--text);font-family:var(--font);font-size:12px;border-radius:6px;outline:none"
                onfocus="this.style.borderColor='var(--indigo)'" onblur="this.style.borderColor='var(--border2)'"/>
            </div>
            <div>
              <div style="font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px">2-Wheelers</div>
              <input id="re_tw_${fid}" type="number" value="${tw}" min="0" max="10"
                style="width:100%;box-sizing:border-box;height:32px;padding:0 8px;background:#fff;border:1px solid var(--border2);color:var(--text);font-family:var(--font);font-size:12px;font-weight:600;border-radius:6px;outline:none"
                onfocus="this.style.borderColor='var(--indigo)'" onblur="this.style.borderColor='var(--border2)'"/>
            </div>
            <div>
              <div style="font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px">4-Wheelers</div>
              <input id="re_fw_${fid}" type="number" value="${fw}" min="0" max="10"
                style="width:100%;box-sizing:border-box;height:32px;padding:0 8px;background:#fff;border:1px solid var(--border2);color:var(--text);font-family:var(--font);font-size:12px;font-weight:600;border-radius:6px;outline:none"
                onfocus="this.style.borderColor='var(--indigo)'" onblur="this.style.borderColor='var(--border2)'"/>
            </div>
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button onclick="window._toggleResEdit('${fid}')"
              style="background:none;border:1px solid var(--border2);border-radius:6px;padding:5px 14px;cursor:pointer;color:var(--text2);font-size:12px;font-weight:600;font-family:var(--font)">Cancel</button>
            <button onclick="window._saveResEdit('${fid}')"
              style="background:var(--indigo);border:none;border-radius:6px;padding:5px 16px;cursor:pointer;color:#fff;font-size:12px;font-weight:700;font-family:var(--font);display:inline-flex;align-items:center;gap:5px">
              <i class="ti ti-check" style="font-size:12px"></i> Save
            </button>
          </div>
        </div>
      </td>
    </tr>`;
  }).join('');
}

/* ══ CUSTOM CATEGORIES ══ */
// DEFAULT_FLAT_CATS moved to top-level state section
// DEFAULT_SOC_CATS moved to top-level state section
// customCats declared in state section above

function getCats(type){ return [...new Set([...(type==='flat'?DEFAULT_FLAT_CATS:DEFAULT_SOC_CATS),...(type==='flat'?customCats.flat:customCats.soc)])]; }

function renderCatOpts(selId, type){
  const sel=document.getElementById(selId); if(!sel)return;
  const cur=sel.value;
  sel.innerHTML=getCats(type).map(c=>`<option value="${c}">${c}</option>`).join('')
    + `<option value="__new__" style="color:var(--indigo);font-weight:700">＋ New Category…</option>`;
  if(cur && getCats(type).includes(cur)) sel.value=cur;
}

function renderCatChips(listId, type){
  const el=document.getElementById(listId); if(!el)return;
  const def=type==='flat'?DEFAULT_FLAT_CATS:DEFAULT_SOC_CATS;
  const custom=type==='flat'?customCats.flat:customCats.soc;
  el.innerHTML=[...new Set([...def,...custom])].map(c=>`
    <span class="cat-chip">${c}${!def.includes(c)?`<button class="cat-del" onclick="window._delCat('${type}','${c}')"><i class="ti ti-x"></i></button>`:''}</span>
  `).join('');
}

function oCatM(){
  renderCatChips('flatCatList','flat');
  renderCatChips('socCatList','soc');
  ['flatCatInput','socCatInput'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  document.getElementById('catM').classList.add('open');
}
function cCatM(){ document.getElementById('catM').classList.remove('open'); }

async function addCat(type){
  const inp=document.getElementById(type==='flat'?'flatCatInput':'socCatInput');
  const val=(inp?.value||'').trim(); if(!val){toast('Enter a category name.','error');return;}
  const arr=type==='flat'?customCats.flat:customCats.soc;
  const def=type==='flat'?DEFAULT_FLAT_CATS:DEFAULT_SOC_CATS;
  if([...def,...arr].map(c=>c.toLowerCase()).includes(val.toLowerCase())){toast('Already exists.','error');return;}
  arr.push(val); if(inp)inp.value='';
  await saveCats();
  renderCatChips(type==='flat'?'flatCatList':'socCatList',type);
  renderCatOpts('fC','flat'); renderCatOpts('peCat','soc');
  toast(`"${val}" added ✓`);
}

async function delCat(type,name){
  const arr=type==='flat'?customCats.flat:customCats.soc;
  const i=arr.indexOf(name); if(i===-1)return;
  arr.splice(i,1);
  await saveCats();
  renderCatChips(type==='flat'?'flatCatList':'socCatList',type);
  renderCatOpts('fC','flat'); renderCatOpts('peCat','soc');
  toast(`"${name}" removed`);
}

async function saveCats(){
  try{ await setDoc(doc(db,'apartments',UID,'config','categories'), customCats); sync('live'); }
  catch(e){ console.error(e); toast('Failed to save categories.','error'); }
}

async function loadCats(){
  try{
    const snap=await getDoc(doc(db,'apartments',UID,'config','categories'));
    if(snap.exists()){const d=snap.data();customCats.flat=d.flat||[];customCats.soc=d.soc||[];}
  } catch(e){ console.error('loadCats:',e); }
  renderCatOpts('fC','flat'); renderCatOpts('peCat','soc');
}

window._oCatM=oCatM; window._cCatM=cCatM;
window._addCat=addCat; window._delCat=delCat;


/* ── Inline category add in dropdowns ── */
window._catSelChange = function(selId, type) {
  const sel = document.getElementById(selId);
  if (!sel) return;
  if (sel.value === '__new__') {
    // Revert to first valid option while input shows
    sel.value = getCats(type)[0] || 'Maintenance';
    window._showInlineCat(selId);
  }
};

window._showInlineCat = function(selId) {
  const wrap = document.getElementById(selId + '_new');
  const inp  = document.getElementById(selId + '_input');
  if (!wrap) return;
  wrap.style.display = 'block';
  if (inp) { inp.value = ''; inp.focus(); }
};

window._hideInlineCat = function(selId) {
  const wrap = document.getElementById(selId + '_new');
  if (wrap) wrap.style.display = 'none';
};

window._addInlineCat = async function(selId, type) {
  const inp = document.getElementById(selId + '_input');
  const val = (inp?.value || '').trim();
  if (!val) { inp?.focus(); return; }
  const arr = type==='flat' ? customCats.flat : customCats.soc;
  const def = type==='flat' ? DEFAULT_FLAT_CATS : DEFAULT_SOC_CATS;
  if ([...def,...arr].map(c=>c.toLowerCase()).includes(val.toLowerCase())) {
    toast('Category already exists.','error');
    inp?.focus(); return;
  }
  arr.push(val);
  await saveCats();
  renderCatOpts(selId, type);
  // Select the newly added category
  const sel = document.getElementById(selId);
  if (sel) sel.value = val;
  window._hideInlineCat(selId);
  toast(`"${val}" added ✓`);
};

/* ════════════════════════════════
   PAYMENT HISTORY EDITOR (Analytics tab)
════════════════════════════════ */
function _openPayHistory(fid) {
  const f = flats.get(fid);
  if (!f) return;
  const modal = document.getElementById('payHistM');
  document.getElementById('payHistTitle').textContent = `${fid} — Payment History`;
  document.getElementById('payHistSub').textContent   = f.owner || 'Vacant';
  modal.dataset.fid = fid;
  modal.classList.add('open');
  _renderPayHistory(fid);
}
window._openPayHistory = _openPayHistory;

function _renderPayHistory(fid) {
  const records = (exps.get(fid) || []).slice().sort((a, b) => (b.rawDate||'').localeCompare(a.rawDate||''));
  const body = document.getElementById('payHistBody');
  if (!body) return;

  if (!records.length) {
    body.innerHTML = `<div style="padding:32px;text-align:center;color:var(--muted);font-size:13px">
      <i class="ti ti-inbox" style="font-size:24px;display:block;margin-bottom:8px"></i>No payment records found</div>`;
    return;
  }

  body.innerHTML = records.map(e => {
    const eid    = e.expId || e.id;
    const isPaid = (e.status||'paid') === 'paid';
    const isPartial = (e.status||'') === 'partial';
    const statusColor = isPaid ? 'var(--green)' : isPartial ? 'var(--amber)' : 'var(--red)';
    const statusLabel = isPaid ? '✅ Paid' : isPartial ? '⚠️ Partial' : '❌ Pending';
    return `
    <div id="phrow_${eid}" style="border:1.5px solid var(--border2);border-radius:10px;padding:12px 14px;margin-bottom:8px;background:var(--surface2)">
      <!-- VIEW MODE -->
      <div id="phview_${eid}" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:3px">
            <span style="font-size:13px;font-weight:800;color:var(--indigo)">${inr(e.amt||0)}</span>
            <span style="font-size:10px;font-weight:700;background:var(--surface3);color:var(--text2);padding:2px 8px;border-radius:20px">${e.cat||'–'}</span>
            <span style="font-size:10px;font-weight:700;color:${statusColor}">${statusLabel}</span>
          </div>
          <div style="font-size:11px;color:var(--muted)">${e.date||'–'}${e.note ? ' · '+e.note : ''}${e.month ? ' · '+e.month : ''}</div>
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0">
          <button onclick="window._phEdit('${eid}')"
            style="height:28px;padding:0 10px;background:none;border:1px solid var(--border2);border-radius:6px;font-size:11px;font-weight:600;color:var(--indigo);cursor:pointer;font-family:var(--font);display:inline-flex;align-items:center;gap:4px">
            <i class="ti ti-pencil" style="font-size:11px"></i> Edit
          </button>
          <button onclick="window._phDelete('${eid}','${fid}')"
            style="height:28px;padding:0 10px;background:none;border:1px solid #FCA5A5;border-radius:6px;font-size:11px;font-weight:600;color:var(--red);cursor:pointer;font-family:var(--font);display:inline-flex;align-items:center;gap:4px">
            <i class="ti ti-trash" style="font-size:11px"></i>
          </button>
        </div>
      </div>
      <!-- EDIT MODE -->
      <div id="phedit_${eid}" style="display:none;margin-top:10px;border-top:1px solid var(--border2);padding-top:10px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
          <div>
            <label style="font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:4px">Category</label>
            <input id="phe_cat_${eid}" type="text" value="${(e.cat||'').replace(/"/g,'&quot;')}"
              style="width:100%;height:34px;padding:0 10px;border:1.5px solid var(--border2);border-radius:8px;font-size:12px;font-weight:600;font-family:var(--font);color:var(--text);background:#fff;box-sizing:border-box"/>
          </div>
          <div>
            <label style="font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:4px">Amount (₹)</label>
            <input id="phe_amt_${eid}" type="number" value="${e.amt||0}"
              style="width:100%;height:34px;padding:0 10px;border:1.5px solid var(--border2);border-radius:8px;font-size:12px;font-weight:600;font-family:var(--font);color:var(--text);background:#fff;box-sizing:border-box"/>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
          <div>
            <label style="font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:4px">Date</label>
            <input id="phe_date_${eid}" type="date" value="${e.rawDate||''}"
              style="width:100%;height:34px;padding:0 10px;border:1.5px solid var(--border2);border-radius:8px;font-size:12px;font-weight:600;font-family:var(--font);color:var(--text);background:#fff;box-sizing:border-box"/>
          </div>
          <div>
            <label style="font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:4px">Status</label>
            <select id="phe_status_${eid}"
              style="width:100%;height:34px;padding:0 10px;border:1.5px solid var(--border2);border-radius:8px;font-size:12px;font-weight:600;font-family:var(--font);color:var(--text);background:#fff;box-sizing:border-box">
              <option value="paid"    ${(e.status||'paid')==='paid'   ?'selected':''}>✅ Paid</option>
              <option value="partial" ${(e.status||'')==='partial'?'selected':''}>⚠️ Partial</option>
              <option value="pending" ${(e.status||'')==='pending'?'selected':''}>❌ Pending</option>
            </select>
          </div>
        </div>
        <div style="margin-bottom:10px">
          <label style="font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:4px">Note</label>
          <input id="phe_note_${eid}" type="text" value="${(e.note||'').replace(/"/g,'&quot;')}" placeholder="Optional note…"
            style="width:100%;height:34px;padding:0 10px;border:1.5px solid var(--border2);border-radius:8px;font-size:12px;font-weight:500;font-family:var(--font);color:var(--text);background:#fff;box-sizing:border-box"/>
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button onclick="window._phCancelEdit('${eid}')"
            style="height:32px;padding:0 14px;background:none;border:1.5px solid var(--border2);border-radius:8px;font-size:12px;font-weight:600;color:var(--text2);cursor:pointer;font-family:var(--font)">Cancel</button>
          <button onclick="window._phSave('${eid}','${fid}')"
            style="height:32px;padding:0 14px;background:var(--indigo);border:none;border-radius:8px;font-size:12px;font-weight:700;color:#fff;cursor:pointer;font-family:var(--font);display:inline-flex;align-items:center;gap:5px">
            <i class="ti ti-device-floppy" style="font-size:13px"></i> Save
          </button>
        </div>
      </div>
    </div>`;
  }).join('');
}
window._renderPayHistory = _renderPayHistory;

window._phEdit = function(eid) {
  // Close any other open edits first
  document.querySelectorAll('[id^="phedit_"]').forEach(el => el.style.display = 'none');
  document.querySelectorAll('[id^="phview_"]').forEach(el => el.style.display = 'flex');
  document.getElementById('phedit_'+eid).style.display = 'block';
  document.getElementById('phview_'+eid).style.display = 'none';
};

window._phCancelEdit = function(eid) {
  document.getElementById('phedit_'+eid).style.display = 'none';
  document.getElementById('phview_'+eid).style.display = 'flex';
};

window._phSave = async function(eid, fid) {
  const cat    = (document.getElementById('phe_cat_'+eid)?.value||'').trim();
  const amt    = parseInt(document.getElementById('phe_amt_'+eid)?.value)||0;
  const rawDate= document.getElementById('phe_date_'+eid)?.value||'';
  const status = document.getElementById('phe_status_'+eid)?.value||'paid';
  const note   = (document.getElementById('phe_note_'+eid)?.value||'').trim();
  const date   = rawDate ? fd(rawDate) : '';
  const payMonth = rawDate ? rawDate.slice(0,7) : AM;

  if (!amt || amt <= 0) { toast('Enter a valid amount','error'); return; }
  sync('saving');
  try {
    await updateDoc(doc(db,'apartments',UID,'expenses',eid), { cat, amt, date, rawDate, note, status, month: payMonth });
    // Recompute flat paid total for that month
    const allEx  = (exps.get(fid)||[]).filter(e => (e.month || payMonth) === payMonth);
    const newPaid = allEx.reduce((s,e) => (e.expId||e.id)===eid ? s+amt : s+(e.amt||0), 0);
    await updateDoc(flatRef(fid), { paid: newPaid });
    sync('live'); toast('Payment updated ✓');
    window._phCancelEdit(eid);
  } catch(err) { console.error(err); sync('error'); toast('Save failed','error'); }
};

window._phDelete = async function(eid, fid) {
  if (!confirm('Delete this payment record?')) return;
  sync('saving');
  try {
    const payMonth = (exps.get(fid)||[]).find(e=>(e.expId||e.id)===eid)?.month || AM;
    await deleteDoc(doc(db,'apartments',UID,'expenses',eid));
    const allEx   = (exps.get(fid)||[]).filter(e => e.month===payMonth && (e.expId||e.id)!==eid);
    const newPaid = allEx.reduce((s,e)=>s+(e.amt||0), 0);
    await updateDoc(flatRef(fid), { paid: newPaid });
    sync('live'); toast('Deleted ✓');
    _renderPayHistory(fid);
  } catch(err) { console.error(err); sync('error'); toast('Delete failed','error'); }
};

async function boot(){
  refreshAPP();
  // buildMonthSelect() — month dropdown removed from UI, AM defaults to current month
  try{
    // Load apartment config
    const aptDoc = await getDoc(aptDocRef());

    // ── PAUSE CHECK — block access if admin has paused this account ──
    if (aptDoc.exists() && aptDoc.data().status === 'paused') {
      document.getElementById('lo').style.display = 'none';
      document.body.innerHTML = `
        <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;
          background:linear-gradient(135deg,#EEF2FF,#FDF4FF);font-family:'Plus Jakarta Sans',sans-serif;padding:24px">
          <div style="background:#fff;border-radius:20px;padding:40px 36px;width:min(460px,100%);
            text-align:center;box-shadow:0 24px 64px rgba(99,102,241,.15);border:1.5px solid #E0E7FF">
            <div style="width:64px;height:64px;border-radius:18px;background:#FEF3C7;
              display:flex;align-items:center;justify-content:center;font-size:28px;margin:0 auto 18px">⏸</div>
            <h2 style="font-size:20px;font-weight:800;color:#111827;margin-bottom:8px">Account Paused</h2>
            <p style="font-size:13px;color:#6B7280;font-weight:500;line-height:1.6;margin-bottom:24px">
              Your Gatebook account has been temporarily suspended by the administrator.<br><br>
              Please contact <strong>support@gatebook.app</strong> to reactivate your account.
            </p>
            <button onclick="window._doSignOut()"
              style="display:inline-flex;align-items:center;gap:8px;padding:10px 24px;
              background:#6366F1;color:#fff;border:none;border-radius:10px;font-size:13px;
              font-weight:700;cursor:pointer;font-family:inherit">
              <i class="ti ti-logout"></i> Sign Out
            </button>
          </div>
        </div>`;
      return;
    }
    // ── END PAUSE CHECK ──

    if(aptDoc.exists() && aptDoc.data().name) applyAptName(aptDoc.data().name);
    if(aptDoc.exists() && aptDoc.data().president) president=aptDoc.data().president;
    if(aptDoc.exists() && aptDoc.data().corpusFund) APT_CORPUS_FUND=aptDoc.data().corpusFund;
    await loadCats();

    // Check if society is already configured (registered via register.html)
    // register.html writes blocks[] to the apt doc AND creates all flats
    // so if blocks exist in apt doc, skip the wizard entirely
    const aptData = aptDoc.exists() ? aptDoc.data() : {};
    const hasAptBlocks = aptData.blocks && aptData.blocks.length > 0;

    // Also check flat count
    const snap = await getDocs(flatsColl());

    if (!snap.empty || hasAptBlocks || isMember()) {
      // Society already set up — go straight to app
      listenFlats();
      listenExp();
      listenIssues();
      listenVehicles();
      listenSocExp();
      listenContacts();
      if (isAdmin()) initMembershipUI(); else { showMemberBanner(); initChangeCode(); }
      // Reveal the app UI — this was previously only done in the wizard branch,
      // causing a permanently blank page on refresh for already-configured societies.
      document.getElementById('lo').style.display = 'none';
      document.getElementById('app').style.display = '';
    } else {
      // Brand new society with no config — show in-app setup wizard
      document.getElementById('lo').style.display = 'none';
      const wiz = document.getElementById('setupWiz');
      wiz.style.display = 'flex';
      if (aptData.name) {
        document.getElementById('wAptName').value = aptData.name;
      }
      wizSetStep(0);
    }
  }catch(err){
    console.error('Boot error:',err);
    document.getElementById('loSub').textContent='⚠ Firebase connection failed. Check console.';
  }
}

/* ══ STRUCTURE TAB — Master Data Management ══ */
function rStructure() {
  // Render president chip in Residents tab
  const presCard = document.getElementById('presBanner');
  if (presCard) {
    if (president && president.name) {
      const ini   = (president.name||'P').charAt(0).toUpperCase();
      const since = president.termStart
        ? new Date(president.termStart).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'})
        : '';
      presCard.innerHTML = `
        <div class="pres-chip" style="margin:0;padding:4px 8px;">
          <div class="pres-chip-av">${ini}</div>
          <div>
            <div class="pres-chip-label">🏆 President</div>
            <div class="pres-chip-name">${president.name}</div>
            <div class="pres-chip-flat">Flat ${president.flatId||''}${since?' · Since '+since:''}</div>
          </div>
          <button class="pres-chip-edit" onclick="window._oPresM()" title="Change president">
            <i class="ti ti-pencil"></i>
          </button>
        </div>`;
    } else {
      presCard.innerHTML = `
        <button onclick="window._oPresM()"
          style="display:inline-flex;align-items:center;gap:5px;height:30px;padding:0 10px;
            border:1.5px dashed var(--border2);border-radius:99px;background:transparent;
            color:var(--text2);font-size:11px;font-weight:600;cursor:pointer;font-family:var(--font);white-space:nowrap;">
          <i class="ti ti-crown" style="font-size:11px;color:var(--indigo)"></i> Elect President
        </button>`;
    }
  }
  
  document.getElementById('phAct').innerHTML = '';
  // Populate block filter
  const bfSel = document.getElementById('strBlockFilter');
  if (bfSel) {
    const blocks = [...new Set([...flats.values()].map(f=>f.block).filter(Boolean))].sort();
    const cur = bfSel.value || 'all';
    bfSel.innerHTML = `<option value="all">All Blocks</option>` +
      blocks.map(b=>`<option value="${b}"${b===cur?' selected':''}>${'Block '+b}</option>`).join('');
  }

  const selBlock = bfSel?.value || 'all';
  const selType = document.getElementById('strTypeFilter')?.value || 'all';
  const q = (document.getElementById('strSearch')?.value||'').trim().toLowerCase();

  let rows = [...flats.values()].filter(f => {
    if (selBlock !== 'all' && f.block !== selBlock) return false;
    
    const isVacant = !(f.owner||'').trim();
    const rType = isVacant ? 'vacant' : (f.resType||'owner');
    if (selType !== 'all' && rType !== selType) return false;
    
    if (q && !f.flatId?.toLowerCase().includes(q) && !(f.owner||'').toLowerCase().includes(q)) return false;
    return true;
  }).sort((a,b) => (a.flatId||'').localeCompare(b.flatId||''));

  // Stats
  const all = [...flats.values()];
  const total   = all.length;
  const owners  = all.filter(f=>(f.resType||'owner')==='owner' && (f.owner||'').trim()).length;
  const tenants = all.filter(f=>f.resType==='tenant').length;
  const vacant  = all.filter(f=>!(f.owner||'').trim()).length;
  
  const statEl  = document.getElementById('strStats');
  if (statEl) statEl.innerHTML = `
    <div class="vscard" style="min-height:65px"><div class="vscard-icon tw"><i class="ti ti-home"></i></div><div><div class="vscard-label" style="font-size:10px">Total</div><div class="vscard-val" style="font-size:16px">${total}</div></div></div>
    <div class="vscard" style="min-height:65px"><div class="vscard-icon fw"><i class="ti ti-user-check"></i></div><div><div class="vscard-label" style="font-size:10px">Owners</div><div class="vscard-val" style="font-size:16px">${owners}</div></div></div>
    <div class="vscard" style="min-height:65px"><div class="vscard-icon" style="background:var(--amber-bg);color:var(--amber)"><i class="ti ti-key"></i></div><div><div class="vscard-label" style="font-size:10px">Tenants</div><div class="vscard-val" style="font-size:16px">${tenants}</div></div></div>
    <div class="vscard" style="min-height:65px"><div class="vscard-icon" style="background:var(--surface3);color:var(--muted)"><i class="ti ti-door"></i></div><div><div class="vscard-label" style="font-size:10px">Vacant</div><div class="vscard-val" style="font-size:16px">${vacant}</div></div></div>`;

  const chipsEl = document.getElementById('strChips');
  if (!chipsEl) return;

  if (!rows.length) {
    chipsEl.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:4rem;color:var(--muted)">
      <i class="ti ti-building-off" style="font-size:40px;display:block;margin-bottom:12px;opacity:.4"></i>
      No flats found.
    </div>`;
    return;
  }

  // Render based on view
  if (STRVIEW === 'floor') {
    // Group by block → floor → flats
    const byBlock = new Map();
    rows.forEach(f => {
      const block = f.block || 'Ungrouped';
      const floor = String(f.floor || '—');
      if (!byBlock.has(block)) byBlock.set(block, new Map());
      const floorMap = byBlock.get(block);
      if (!floorMap.has(floor)) floorMap.set(floor, []);
      floorMap.get(floor).push(f);
    });

    const blocks = [...byBlock.entries()].sort((a,b)=>(a[0]||'').localeCompare(b[0]||''));
    const totalBlocks = blocks.length;

    chipsEl.style.display = 'grid';
    chipsEl.style.gridTemplateColumns = `repeat(${totalBlocks}, 1fr)`;
    chipsEl.style.gap = '10px';
    chipsEl.style.alignItems = 'start';

    chipsEl.innerHTML = blocks.map(([block, floorMap]) => {
      const allFlats = [...floorMap.values()].flat();
      const blockPaid = allFlats.filter(f => paidAM(f.flatId, AM) >= (f.due||0)).length;
      const floors = [...floorMap.entries()].sort((a,b)=>(parseInt(a[0])||0)-(parseInt(b[0])||0));

      const blkKey = 'blk_'+block;
      return `<div style="display:flex;flex-direction:column;gap:8px;">
        <!-- Block header — toggleable -->
        <div onclick="(function(el){const body=el.nextElementSibling;const icon=el.querySelector('.blk-toggle-icon');const open=body.style.display!=='none';body.style.display=open?'none':'flex';icon.style.transform=open?'rotate(-90deg)':'rotate(0)'})(this)"
          style="margin:0 -4px;padding:10px 14px;background:var(--indigo);
            border-radius:12px;display:flex;align-items:center;gap:10px;cursor:pointer;user-select:none;">
          <div style="width:32px;height:32px;border-radius:8px;background:rgba(255,255,255,.18);
            display:flex;align-items:center;justify-content:center;flex-shrink:0;">
            <i class="ti ti-building" style="color:#fff;font-size:16px;"></i>
          </div>
          <div style="flex:1;min-width:0;">
            <div style="font-weight:800;color:#fff;font-size:14px;letter-spacing:.2px;">Block ${block}</div>
            <div style="font-size:10px;color:rgba(255,255,255,.75);margin-top:1px;">
              ${allFlats.length} flat${allFlats.length!==1?'s':''} &nbsp;·&nbsp; ${blockPaid} paid
            </div>
          </div>
          <span style="font-size:11px;font-weight:800;padding:3px 10px;border-radius:20px;
            background:rgba(255,255,255,.22);color:#fff;letter-spacing:.2px;">
            ${blockPaid}/${allFlats.length}
          </span>
          <i class="ti ti-chevron-down blk-toggle-icon" style="color:rgba(255,255,255,.8);font-size:15px;transition:transform .2s;"></i>
        </div>
        <!-- Floors stacked (collapsible) -->
        <div style="display:flex;flex-direction:column;gap:8px;">
        ${floors.map(([floor, fts]) => {
          const paidCnt = fts.filter(f => paidAM(f.flatId, AM) >= (f.due||0)).length;
          return `<div>
            <div style="font-size:12px;font-weight:800;color:var(--text);text-transform:uppercase;
              letter-spacing:.5px;padding:4px 6px;margin-bottom:5px;display:flex;align-items:center;gap:5px;">
              <i class="ti ti-stairs" style="font-size:13px;color:var(--indigo);"></i>
              Floor ${floor}
              <span style="margin-left:auto;font-size:9px;padding:1px 6px;border-radius:10px;
                background:${paidCnt===fts.length?'#dcfce7':paidCnt>0?'#fef9c3':'#fee2e2'};
                color:${paidCnt===fts.length?'#16a34a':paidCnt>0?'#d97706':'#dc2626'};font-weight:700;">
                ${paidCnt}/${fts.length}
              </span>
            </div>
            <div style="display:flex;flex-direction:column;gap:5px;">
              ${fts.map(f => makeChip(f)).join('')}
            </div>
          </div>`;
        }).join('')}
        </div>
      </div>`;
    }).join('');

  } else if (STRVIEW === 'block') {
    // Group by block only
    const byBlock = new Map();
    rows.forEach(f => {
      const block = f.block || 'Ungrouped';
      if (!byBlock.has(block)) byBlock.set(block, []);
      byBlock.get(block).push(f);
    });

    chipsEl.innerHTML = [...byBlock.entries()]
      .sort((a,b) => (a[0]||'').localeCompare(b[0]||''))
      .map(([block, fts]) => {
        const paidCnt = fts.filter(f => {
          const paid = paidAM(f.flatId, AM);
          return paid >= (f.due||0);
        }).length;
        
        return `<div style="margin-bottom:6px;">
          <div onclick="(function(el){const body=el.nextElementSibling;const icon=el.querySelector('.blk-toggle-icon');const open=body.style.display!=='none';body.style.display=open?'none':'grid';icon.style.transform=open?'rotate(-90deg)':'rotate(0)'})(this)"
            style="display:flex;align-items:center;gap:8px;margin-bottom:8px;padding:6px 10px;
              background:linear-gradient(135deg,var(--indigo-bg),var(--surface2));border-radius:10px;
              border-left:3px solid var(--indigo);cursor:pointer;user-select:none;">
            <i class="ti ti-building" style="color:var(--indigo);font-size:15px;flex-shrink:0;"></i>
            <div style="flex:1;min-width:0;">
              <div style="font-weight:800;color:var(--text);font-size:12px;letter-spacing:.2px;">Block ${block}</div>
              <div style="font-size:10px;color:var(--muted);margin-top:1px;">${fts.length} flat${fts.length!==1?'s':''} &nbsp;·&nbsp; <span style="color:var(--green);font-weight:700;">${paidCnt} paid</span></div>
            </div>
            <span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px;background:${paidCnt===fts.length?'var(--green)':paidCnt>0?'var(--amber)':'var(--red)'};color:#fff;">${paidCnt}/${fts.length}</span>
            <i class="ti ti-chevron-down blk-toggle-icon" style="color:var(--indigo);font-size:13px;transition:transform .2s;"></i>
          </div>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;">
            ${fts.map(f => makeChip(f)).join('')}
          </div>
        </div>`
      }).join('');

  } else {
    // All flats in one grid
    chipsEl.innerHTML = `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;">
      ${rows.map(f => makeChip(f)).join('')}
    </div>`;
  }

  function makeChip(f) {
    const isVacant = !(f.owner||'').trim();
    const rType    = isVacant ? 'vacant' : (f.resType||'owner');
    const paid     = paidAM(f.flatId, AM);
    const due      = f.due || 0;
    const status   = paid >= due && due > 0 ? 'paid' : paid > 0 ? 'partial' : due > 0 ? 'pending' : 'vacant';

    let fid = '';
    for (const [key, flat] of flats.entries()) {
      if (flat.flatId === f.flatId && flat.block === f.block) { fid = key; break; }
    }

    // Option 4 — Icon chip: status dot + flat ID + type (3-col grid)
    const dotClr  = {paid:'#22c55e', partial:'#f59e0b', pending:'#ef4444', vacant:'#d1d5db'}[status];
    const typeLbl = isVacant ? 'Vacant' : rType==='tenant' ? 'Tenant' : 'Owner';
    const typeClr = isVacant ? '#9ca3af' : rType==='tenant' ? '#d97706' : '#6366f1';
    const borderClr = {paid:'#bbf7d0', partial:'#fde68a', pending:'#fecaca', vacant:'#e5e7eb'}[status];
    const bgClr   = {paid:'#f0fdf4', partial:'#fffbeb', pending:'#fff1f2', vacant:'#fafafa'}[status];

    return `<button onclick="window.oFlEdit('${fid}')"
      style="background:${bgClr};border:1px solid ${borderClr};border-radius:8px;
        padding:7px 8px;cursor:pointer;font-family:var(--font);text-align:left;
        display:flex;align-items:center;gap:7px;width:100%;
        transition:box-shadow .12s,border-color .12s;box-shadow:0 1px 2px rgba(0,0,0,.04);"
      onmouseover="this.style.boxShadow='0 3px 8px rgba(0,0,0,.1)';this.style.borderColor='${dotClr}'"
      onmouseout="this.style.boxShadow='0 1px 2px rgba(0,0,0,.04)';this.style.borderColor='${borderClr}'">
      <span style="width:8px;height:8px;border-radius:50%;background:${dotClr};flex-shrink:0;display:inline-block;"></span>
      <div style="min-width:0;overflow:hidden;">
        <div style="font-size:11px;font-weight:700;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.2">${f.flatId}</div>
        <div style="font-size:9px;font-weight:600;color:${typeClr};margin-top:1px;white-space:nowrap">${typeLbl}</div>
      </div>
    </button>`;
  }
}

window.rStructure = rStructure;
window._setStrView = v => {
  STRVIEW = v;
  document.querySelectorAll('[data-view]').forEach(btn => {
    btn.style.background = btn.dataset.view === v ? 'var(--indigo)' : 'transparent';
    btn.style.color = btn.dataset.view === v ? '#fff' : 'var(--text2)';
  });
  rStructure();
};


/* ══ ANALYTICS TAB ══ */

function _getCanvasSize(canvas) {
  const rect = canvas.getBoundingClientRect();
  return { W: rect.width, H: rect.height };
}

function drawPie(canvasId, segments, tooltipId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  // Responsive: set canvas pixel size to display size
  const rect = canvas.getBoundingClientRect();
  const dpr  = window.devicePixelRatio||1;
  const W = rect.width||200, H = rect.height||200;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const cx = W/2, cy = H/2, r = Math.min(W,H)/2 - 8;
  ctx.clearRect(0, 0, W, H);
  const total = segments.reduce((s,sg)=>s+sg.value,0);
  if (!total) {
    ctx.fillStyle = '#e5e7eb';
    ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.fill();
    ctx.fillStyle = '#9ca3af'; ctx.font = '11px sans-serif'; ctx.textAlign='center';
    ctx.fillText('No data', cx, cy+4);
    _pieSegs[canvasId] = [];
    return;
  }
  let angle = -Math.PI/2;
  const drawn = [];
  segments.forEach(sg => {
    const slice = (sg.value/total)*Math.PI*2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, angle, angle+slice);
    ctx.closePath();
    ctx.fillStyle = sg.color;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
    drawn.push({ ...sg, startAngle: angle, endAngle: angle+slice, cx, cy, r, total });
    angle += slice;
  });
  _pieSegs[canvasId] = drawn;
  // donut hole
  ctx.beginPath();
  ctx.arc(cx, cy, r*0.45, 0, Math.PI*2);
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--surface2').trim()||'#f8f9fa';
  ctx.fillStyle = bg; ctx.fill();
  // center label — tight, no overlap
  const textColor = getComputedStyle(document.documentElement).getPropertyValue('--text').trim()||'#111';
  const mutedColor = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim()||'#888';
  const holeR = r * 0.45;
  const maxFontBig = Math.floor(holeR * 0.55);
  const maxFontSm  = Math.floor(holeR * 0.35);
  const fontBig = Math.min(Math.max(10, maxFontBig), 18);
  const fontSm  = Math.min(Math.max(8,  maxFontSm),  12);
  const lineH   = fontBig + fontSm + 3;
  ctx.textAlign = 'center';
  ctx.font = `bold ${fontBig}px sans-serif`;
  ctx.fillStyle = textColor;
  ctx.fillText(segments[0]?.centerLabel || total, cx, cy - lineH/2 + fontBig);
  ctx.font = `${fontSm}px sans-serif`;
  ctx.fillStyle = mutedColor;
  ctx.fillText('total', cx, cy - lineH/2 + fontBig + fontSm + 3);

  // Attach tooltip mouse handler — recalculate geometry from live canvas rect
  if (tooltipId) {
    canvas.onmousemove = (ev) => {
      const tip  = document.getElementById(tooltipId);
      if (!tip) return;
      const segs = _pieSegs[canvasId];
      if (!segs || !segs.length) { tip.style.display='none'; return; }
      const cr  = canvas.getBoundingClientRect();
      const lW  = cr.width, lH = cr.height;
      const lcx = lW/2, lcy = lH/2, lr = Math.min(lW,lH)/2 - 8;
      const mx  = ev.clientX - cr.left;
      const my  = ev.clientY - cr.top;
      const dx  = mx - lcx, dy = my - lcy;
      const dist = Math.sqrt(dx*dx + dy*dy);
      if (dist < lr*0.45 || dist > lr) { tip.style.display='none'; return; }
      let a = Math.atan2(dy, dx);
      if (a < -Math.PI/2) a += Math.PI*2;
      const hit = segs.find(sg => {
        let s = sg.startAngle, e = sg.endAngle;
        if (s < -Math.PI/2) { s += Math.PI*2; e += Math.PI*2; }
        return a >= s && a < e;
      });
      if (hit) {
        const pct = Math.round(hit.value/hit.total*100);
        tip.textContent   = `${hit.label}: ${hit.displayValue||hit.value} (${pct}%)`;
        tip.style.display = 'block';
        tip.style.left    = (ev.clientX+12)+'px';
        tip.style.top     = (ev.clientY-28)+'px';
      } else {
        tip.style.display = 'none';
      }
    };
    canvas.onmouseleave = () => {
      const tip = document.getElementById(tooltipId);
      if (tip) tip.style.display='none';
    };
  }
}

function buildLegend(legendId, segments, total) {
  const el = document.getElementById(legendId);
  if (!el) return;
  el.innerHTML = segments.map(sg => `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
      <div style="display:flex;align-items:center;gap:6px;min-width:0">
        <span style="width:10px;height:10px;border-radius:50%;background:${sg.color};flex-shrink:0;display:inline-block"></span>
        <span style="font-size:11px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${sg.label}</span>
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
        <span style="font-size:11px;font-weight:800;color:var(--text)">${sg.count!==undefined?sg.count:sg.value}</span>
        <span style="font-size:10px;color:var(--muted)">${total?Math.round((sg.count!==undefined?sg.count:sg.value)/total*100):0}%</span>
        ${sg.amt!==undefined?`<span style="font-size:10px;font-weight:700;color:var(--indigo)">${inr(sg.amt)}</span>`:''}
      </div>
    </div>`).join('');
}

function _buildAnalyticsFilters() {
  const months = new Set();
  // Collect months from payment transactions only
  exps.forEach(records => records.forEach(e=>{ if(e.month) months.add(e.month); }));
  months.add(AM);
  const sorted = [...months].sort().reverse();

  const mSel = document.getElementById('anFilterMonth');
  const ySel = document.getElementById('anFilterYear');
  const bSel  = document.getElementById('anBlockFilter');
  const bSel2 = document.getElementById('anBlockFilter2');
  if (!mSel || !ySel) return;

  // Populate block filter (both top filter bar + table header)
  const allBlocks = [...new Set([...flats.values()].map(f => f.block).filter(Boolean))].sort();
  [bSel, bSel2].forEach(sel => {
    if (!sel) return;
    const curB = sel.value || _anBlock;
    sel.innerHTML = `<option value="all">All Blocks</option>` +
      allBlocks.map(b => `<option value="${b}"${b === curB ? ' selected' : ''}>Block ${b}</option>`).join('');
    if (allBlocks.length > 1) sel.style.display = '';
    else sel.style.display = 'none';
    if (allBlocks.includes(curB)) sel.value = curB;
  });

  // Read current user selection BEFORE touching innerHTML
  const prevMonth = mSel.value || _anSelMonth || AM;
  const prevYear  = ySel.value  || _anSelYear  || new Date().getFullYear().toString();

  mSel.innerHTML = sorted.map(m => {
    const lbl = new Date(m+'-01').toLocaleDateString('en-IN',{month:'long',year:'numeric'});
    return `<option value="${m}"${m===prevMonth?' selected':''}>${lbl}</option>`;
  }).join('');
  // Force the value — some browsers ignore selected attribute
  if (sorted.includes(prevMonth)) mSel.value = prevMonth;
  else mSel.value = sorted[0] || AM;

  const years = [...new Set(sorted.map(m=>m.slice(0,4)))].sort().reverse();
  ySel.innerHTML = years.map(y=>`<option value="${y}"${y===prevYear?' selected':''}>${y}</option>`).join('');
  if (years.includes(prevYear)) ySel.value = prevYear;
  else ySel.value = years[0] || new Date().getFullYear().toString();
}

function _buildFlatSummary(filterType, selMonth, selYear, selBlock) {
  const matchM = m => filterType==='month' ? m===selMonth : (m||'').startsWith(selYear);
  const matchB = b => !selBlock || selBlock === 'all' || b === selBlock;

  // Aggregate all payment transactions for the period from the expenses collection
  const byFlat = new Map();
  exps.forEach((records, fid) => {
    records.forEach(e => {
      if (!matchM(e.month)) return;
      const f = flats.get(fid);
      if (!matchB(f?.block || e.block || '')) return;
      if (!byFlat.has(fid)) byFlat.set(fid, { flatId:fid, paid:0, due:0, owner:'', resType:'owner', block:'', exps:[] });
      const rec = byFlat.get(fid);
      rec.paid += (e.amt || 0);
      rec.exps.push(e);
    });
  });

  // Cross-reference with current flat records for owner/due/resType
  byFlat.forEach((rec, fid) => {
    const f = flats.get(fid);
    if (f) {
      rec.owner   = f.owner   || rec.owner;
      rec.due     = f.due     || rec.due;
      rec.resType = f.resType || rec.resType;
      rec.block   = f.block   || rec.block;
    } else {
      const s = rec.exps[0];
      rec.owner = s?.owner || s?.block || '';
      rec.block = s?.block || '';
    }
  });

  // Include all flats with no payments for the period (truly pending/not paid)
  if (filterType === 'month') {
    flats.forEach((f, fid) => {
      if (!matchB(f.block || '')) return;
      if (!byFlat.has(fid)) {
        byFlat.set(fid, { flatId:fid, paid:0, due:f.due||0, owner:f.owner||'', resType:f.resType||'owner', block:f.block||'', exps:[] });
      }
    });
  }

  const result = [];
  byFlat.forEach(rec => {
    const isVacant = !(rec.owner||'').trim();
    rec._status = isVacant ? 'vacant' : (rec.paid >= rec.due && rec.due > 0 ? 'paid' : rec.paid > 0 ? 'partial' : 'pending');
    result.push(rec);
  });
  return result.sort((a,b) => (a.flatId||'').localeCompare(b.flatId||''));
}
// ════════════════════════════════════════════════════════
//  ANALYTICS TAB — FIXED rAnalytics()
//  Replace the existing rAnalytics() function in app.html
//  with this version.
//
//  Root cause: old code read f.paymentHistory (undefined)
//  instead of the exps Map loaded from Firestore subcollection.
// ════════════════════════════════════════════════════════

function rAnalytics() {

  /* ── 0. Empty state — no flats configured yet ── */
  if (flats.size === 0) {
    const phActEl = document.getElementById('phAct');
    if (phActEl) phActEl.innerHTML = '';
    const totalsEl = document.getElementById('analyticsTotals');
    if (totalsEl) totalsEl.innerHTML = '';

    // Render welcome message into the existing grid container (preserve DOM structure)
    const layoutGrid = document.querySelector('#analyticsView .an-layout-grid');
    if (layoutGrid) {
      layoutGrid.style.display = 'none';
    }
    let emptyEl = document.getElementById('anEmptyState');
    if (!emptyEl) {
      emptyEl = document.createElement('div');
      emptyEl.id = 'anEmptyState';
      const anView = document.getElementById('analyticsView');
      if (anView) anView.appendChild(emptyEl);
    }
    emptyEl.style.display = 'flex';
    emptyEl.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
        min-height:55vh;text-align:center;padding:40px 24px;width:100%">
        <div style="width:72px;height:72px;border-radius:20px;background:linear-gradient(135deg,#6366F1,#8B5CF6);
          display:flex;align-items:center;justify-content:center;font-size:32px;color:#fff;
          box-shadow:0 12px 32px rgba(99,102,241,.3);margin-bottom:20px">
          <i class="ti ti-building-community"></i>
        </div>
        <div style="font-size:20px;font-weight:800;color:var(--text);margin-bottom:6px">
          Welcome to <span style="color:var(--indigo)">${APT_NAME}</span>
        </div>
        <div style="font-size:13px;color:var(--text2);max-width:320px;line-height:1.6;margin-bottom:24px">
          No flats have been added yet. Set up your blocks and flats to start tracking payments, expenses, and more.
        </div>
        <button onclick="switchView('structure')" class="btn btn-indigo" style="padding:11px 22px">
          <i class="ti ti-plus"></i> Set Up Society Structure
        </button>
      </div>`;
    return;
  } else {
    // Flats exist — make sure grid is visible and empty state hidden
    const layoutGrid = document.querySelector('#analyticsView .an-layout-grid');
    if (layoutGrid) layoutGrid.style.display = '';
    const emptyEl = document.getElementById('anEmptyState');
    if (emptyEl) emptyEl.style.display = 'none';
  }

  /* ── 1. Collect every month/year that appears in real payments ── */
  const monthSet = new Set();
  exps.forEach(records => records.forEach(e => { if (e.month) monthSet.add(e.month); }));
  monthSet.add(AM); // always include current month
  const sortedMonths = [...monthSet].sort().reverse();
  const yearSet = new Set(sortedMonths.map(m => m.slice(0, 4)));
  const sortedYears = [...yearSet].sort().reverse();

  /* ── 2. Build / update filter bar inside #phAct ── */
  // Preserve previous selections across re-renders
  const prevYear  = document.getElementById('payFilterYear')?.value  || sortedYears[0]  || '';
  const prevMonth = document.getElementById('payFilterMonth')?.value || AM;

  document.getElementById('phAct').innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;width:100%;gap:12px;flex-wrap:wrap;">
      <div style="display:flex;gap:8px;">
        <button class="btn btn-indigo" onclick="window._oA()"><i class="ti ti-plus"></i> Add Payment</button>
        <button class="btn btn-indigo" onclick="window._oPresExp()"><i class="ti ti-receipt"></i> Add Expense</button>
      </div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
        <select id="payFilterBlock"
          style="font-size:11px;height:32px;padding:0 8px;border:1.5px solid var(--border2);border-radius:var(--r-md);background:#fff;color:var(--text);font-family:var(--font);font-weight:600;cursor:pointer;outline:none;"
          onchange="window._anOnBlockChange()">
          <option value="">All Blocks</option>
        </select>
        <select id="payFilterYear"
          style="font-size:11px;height:32px;padding:0 8px;border:1.5px solid var(--border2);border-radius:var(--r-md);background:#fff;color:var(--text);font-family:var(--font);font-weight:600;cursor:pointer;outline:none;"
          onchange="window._anOnYearChange()">
        </select>
        <select id="payFilterMonth"
          style="font-size:11px;height:32px;padding:0 8px;border:1.5px solid var(--border2);border-radius:var(--r-md);background:#fff;color:var(--text);font-family:var(--font);font-weight:600;cursor:pointer;outline:none;"
          onchange="window._anOnMonthChange()">
        </select>
      </div>
    </div>`;

  /* ── 3. Populate Year dropdown ── */
  const ySel = document.getElementById('payFilterYear');
  ySel.innerHTML = `<option value="">All years</option>` +
    sortedYears.map(y => `<option value="${y}">${y}</option>`).join('');
  // Restore or default
  if (sortedYears.includes(prevYear)) ySel.value = prevYear;
  else ySel.value = sortedYears[0] || '';

  /* ── 4. Populate Month dropdown based on selected year ── */
  _anPopulateMonths(sortedMonths);

  // Populate block dropdown
  const blkSel = document.getElementById('payFilterBlock');
  if (blkSel) {
    const prevBlk = blkSel.value || '';
    const blks = [...new Set([...flats.values()].map(f=>f.block||'').filter(Boolean))].sort();
    blkSel.innerHTML = '<option value="">All Blocks</option>' +
      blks.map(b=>`<option value="${b}"${prevBlk===b?' selected':''}>Block ${b}</option>`).join('');
  }

  // Restore month selection
  const mSel = document.getElementById('payFilterMonth');
  const monthsForYear = sortedMonths.filter(m =>
    !ySel.value || m.startsWith(ySel.value));
  if (monthsForYear.includes(prevMonth)) mSel.value = prevMonth;

  /* ── 5. Compute stats from real exps data ── */
  _anRender();
}

/* Called when year dropdown changes */
window._anOnYearChange = function () {
  const monthSet = new Set();
  exps.forEach(records => records.forEach(e => { if (e.month) monthSet.add(e.month); }));
  monthSet.add(AM);
  _anPopulateMonths([...monthSet].sort().reverse());
  _anRender();
};

/* Called when month dropdown changes */
window._anOnMonthChange = function () { _anRender(); };

window._anOnBlockChange = function () {
  const b = document.getElementById('payFilterBlock')?.value || '';
  _anBlock = b || 'all';
  ['anBlockFilter','anBlockFilter2'].forEach(id => { const el=document.getElementById(id); if(el) el.value=_anBlock; });
  _anRender();
};

/* Repopulate month <select> filtered by chosen year */
function _anPopulateMonths(sortedMonths) {
  const ySel = document.getElementById('payFilterYear');
  const mSel = document.getElementById('payFilterMonth');
  if (!mSel) return;
  const selectedYear = ySel?.value || '';
  const filtered = selectedYear
    ? sortedMonths.filter(m => m.startsWith(selectedYear))
    : sortedMonths;

  mSel.innerHTML = `<option value="">All months</option>` +
    filtered.map(m => {
      const lbl = new Date(m + '-01').toLocaleDateString('en-IN',
        { month: 'long', year: 'numeric' });
      return `<option value="${m}">${lbl}</option>`;
    }).join('');

  // Default to current month (AM) if available, otherwise first available month
  if (filtered.length) mSel.value = filtered.includes(AM) ? AM : filtered[0];
}

/* Core render: reads exps Map, no paymentHistory needed */
function _anRender() {
  const selectedYear  = document.getElementById('payFilterYear')?.value  || '';
  const selectedMonth = document.getElementById('payFilterMonth')?.value || '';

  /* ── period label ── */
  let periodLabel = 'All time';
  if (selectedMonth) {
    periodLabel = new Date(selectedMonth + '-01')
      .toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  } else if (selectedYear) {
    periodLabel = `Year ${selectedYear}`;
  }

  /* ── filter helper: does an expense record fall in the chosen period? ── */
  function inPeriod(e) {
    const m = e.month || (e.rawDate || '').slice(0, 7) || '';
    if (selectedMonth) return m === selectedMonth;
    if (selectedYear)  return m.startsWith(selectedYear);
    return true; // all time
  }

  /* ── aggregate per flat ── */
  const selBlock = document.getElementById('payFilterBlock')?.value || '';
  let totalCollected = 0, totalDue = 0;
  let paid = 0, partial = 0, pending = 0, vacant = 0;

  flats.forEach((f, fid) => {
    if (selBlock && f.block !== selBlock) return;
    const isVacant = !(f.owner || '').trim();
    if (isVacant) { vacant++; return; }

    // Due: for a month filter use f.due; for year/all multiply
    let due = f.due || 0;
    if (selectedYear && !selectedMonth) {
      // count months in the year that appear in data for this flat
      const flatMonths = new Set(
        (exps.get(fid) || [])
          .map(e => e.month || (e.rawDate || '').slice(0, 7))
          .filter(m => m.startsWith(selectedYear))
      );
      due = due * (flatMonths.size || 1);
    } else if (!selectedMonth && !selectedYear) {
      const flatMonths = new Set(
        (exps.get(fid) || [])
          .map(e => e.month || (e.rawDate || '').slice(0, 7))
          .filter(Boolean)
      );
      due = due * (flatMonths.size || 1);
    }

    // Collected: sum matching expense records
    const collected = (exps.get(fid) || [])
      .filter(inPeriod)
      .reduce((s, e) => s + (e.amt || 0), 0);

    totalDue       += due;
    totalCollected += collected;

    if      (collected >= due && due > 0) paid++;
    else if (collected > 0)               partial++;
    else                                  pending++;
  });

  const outstanding = Math.max(0, totalDue - totalCollected);
  const pct = totalDue ? Math.round(totalCollected / totalDue * 100) : 0;

  /* ── All-time outstanding (regardless of filter) ── */
  let allTimeCollected = 0, allTimeDue = 0;
  flats.forEach((f, fid) => {
    if (selBlock && f.block !== selBlock) return;
    const isVacant = !(f.owner || '').trim();
    if (isVacant) return;

    const due = f.due || 0;
    const flatMonths = new Set(
      (exps.get(fid) || [])
        .map(e => e.month || (e.rawDate || '').slice(0, 7))
        .filter(Boolean)
    );
    allTimeDue += due * (flatMonths.size || 1);
    
    const collected = (exps.get(fid) || [])
      .reduce((s, e) => s + (e.amt || 0), 0);
    allTimeCollected += collected;
  });
  
  /* ── Calculate current month collected ── */
  const currentMonthCollected = Array.from(exps.values())
    .flat()
    .filter(e => {
      const m = e.month || (e.rawDate || '').slice(0, 7) || '';
      return m === AM;
    })
    .reduce((s, e) => s + (e.amt || 0), 0);
  
  const currentMonthRecords = Array.from(exps.values())
    .flat()
    .filter(e => {
      const m = e.month || (e.rawDate || '').slice(0, 7) || '';
      return m === AM;
    }).length;

  /* ── Calculate total society expenses ── */
  const totalSocietyExpenses = socExps.reduce((s, e) => s + (e.amt || 0), 0);
  
  /* ── Outstanding = Corpus Fund - Expenses + Payments ── */
  const outstandingBalance = APT_CORPUS_FUND - totalSocietyExpenses + allTimeCollected;

  /* ── Pie chart segments ── */
  const segments = [
    { label:'Paid',    value:paid,    color:'#22c55e', displayValue:`${paid} flats`    },
    { label:'Partial', value:partial, color:'#f59e0b', displayValue:`${partial} flats` },
    { label:'Pending', value:pending, color:'#ef4444', displayValue:`${pending} flats` },
    { label:'Vacant',  value:vacant,  color:'#d1d5db', displayValue:`${vacant} flats`  },
  ].filter(s => s.value > 0);

  const totalFlats = paid + partial + pending + vacant;

  requestAnimationFrame(() => {
    drawPie('payPie', segments, 'payTooltip');
    buildLegend('payLegend', segments.map(s => ({ ...s, count: s.value })), totalFlats);
  });

  /* ── Summary cards: Current Month and Outstanding Balance ── */
  const cardsDiv = document.getElementById('analyticsTotals');
  if (cardsDiv) {
    const currentMonthLabel = new Date(AM + '-01').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
    cardsDiv.innerHTML = `
    <div class="vscard indigo">
      <div>
        <div class="vscard-label" style="color:#000">${currentMonthLabel}</div>
        <div class="vscard-val" style="color:#000">${inr(currentMonthCollected)}</div>
        <div style="font-size:10px;color:#000;margin-top:4px">${currentMonthRecords} record${currentMonthRecords!==1?'s':''}</div>
      </div>
    </div>
    <div class="vscard indigo" style="position:relative">
      <div>
        <div class="vscard-label" style="color:#000">Outstanding Balance</div>
        <div class="vscard-val" style="color:#000">${inr(Math.max(0, outstandingBalance))}</div>
        <div style="font-size:10px;color:#000;margin-top:4px">Corpus: ${inr(APT_CORPUS_FUND)}</div>
      </div>
      <button onclick="window._editCorpusFund()" style="position:absolute;top:8px;right:8px;background:none;border:none;cursor:pointer;color:#000;font-size:16px;padding:4px"><i class="ti ti-edit"></i></button>
    </div>`;
  }

  /* ── Payment records table ── */
  renderAnPayTable('month', selectedMonth || AM, selectedYear, selBlock || 'all');
}
window.rAnalytics = rAnalytics;

let _resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    const av = document.getElementById('analyticsView');
    if (av && av.style.display !== 'none') rAnalytics();
    const pv = document.getElementById('presView');
    if (pv && pv.style.display !== 'none') rPresident();
  }, 150);
});

/* ── Pending Flats Modal ── */
function showPending() {
  const all     = [...flats.values()];
  const pending = all.filter(f=>st(f)==='pending').sort((a,b)=>(b.due-b.paid)-(a.due-a.paid));
  const partial = all.filter(f=>st(f)==='partial').sort((a,b)=>(b.due-b.paid)-(a.due-a.paid));
  const rows    = [...pending, ...partial];

  const totalBal = rows.reduce((s,f)=>s+(f.due-f.paid),0);
  const modal    = document.getElementById('pendingModal');
  const subtitle = document.getElementById('pendingSubtitle');
  const summary  = document.getElementById('pendingSummary');
  const tbody    = document.getElementById('pendingTableBody');

  subtitle.textContent = `${rows.length} flat${rows.length!==1?'s':''} · ${new Date(AM+'-01').toLocaleDateString('en-IN',{month:'long',year:'numeric'})}`;

  summary.innerHTML = `
    <div style="flex:1;background:var(--red-bg);border:1px solid var(--red-border);border-radius:var(--r-md);padding:8px 12px;text-align:center">
      <div style="font-size:9px;font-weight:700;color:var(--red);text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px">Not Paid</div>
      <div style="font-size:16px;font-weight:800;color:var(--red)">${pending.length}</div>
    </div>
    <div style="flex:1;background:var(--amber-bg);border:1px solid var(--amber-border);border-radius:var(--r-md);padding:8px 12px;text-align:center">
      <div style="font-size:9px;font-weight:700;color:var(--amber);text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px">Partial</div>
      <div style="font-size:16px;font-weight:800;color:var(--amber)">${partial.length}</div>
    </div>
    <div style="flex:1;background:var(--surface2);border:1px solid var(--border2);border-radius:var(--r-md);padding:8px 12px;text-align:center">
      <div style="font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px">Total Due</div>
      <div style="font-size:16px;font-weight:800;color:var(--red)">${inr(totalBal)}</div>
    </div>`;

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="padding:32px;text-align:center;color:var(--muted);font-size:13px"><i class="ti ti-circle-check" style="font-size:24px;color:var(--green);display:block;margin-bottom:8px"></i>All flats are paid!</td></tr>`;
  } else {
    tbody.innerHTML = rows.map((f,i) => {
      const s   = st(f);
      const bal = f.due - f.paid;
      const sc  = s==='partial' ? '#f59e0b' : '#ef4444';
      const sl  = s==='partial' ? '⚠️ Partial' : '❌ Not Paid';
      const bg  = i%2===0 ? 'var(--surface)' : 'var(--surface2)';
      return `<tr style="background:${bg};border-bottom:1px solid var(--border)" onclick="window._closePending();window._oFl('${f.flatId}')" style="cursor:pointer">
        <td style="padding:10px 18px;font-weight:800;color:var(--indigo);font-size:12px">${f.flatId}</td>
        <td style="padding:10px 14px;font-size:12px;font-weight:600;color:var(--text);max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${f.owner||'<em style="color:var(--muted);font-weight:400">No owner</em>'}</td>
        <td style="padding:10px 14px;text-align:center"><span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:99px;background:${sc}18;color:${sc};border:1px solid ${sc}40">${sl}</span></td>
        <td style="padding:10px 14px;text-align:right;font-weight:700;color:var(--green);font-size:12px">${inr(f.paid)}</td>
        <td style="padding:10px 18px;text-align:right;font-weight:800;color:#ef4444;font-size:12px">${inr(bal)}</td>
      </tr>`;
    }).join('') +
    `<tr style="background:var(--surface3);border-top:2px solid var(--border2)">
      <td colspan="3" style="padding:10px 18px;font-size:11px;font-weight:800;color:var(--text2)">Total (${rows.length} flats)</td>
      <td style="padding:10px 14px;text-align:right;font-weight:800;color:var(--green);font-size:12px">${inr(rows.reduce((s,f)=>s+f.paid,0))}</td>
      <td style="padding:10px 18px;text-align:right;font-weight:800;color:#ef4444;font-size:12px">${inr(totalBal)}</td>
    </tr>`;
  }

  modal.style.display = 'flex';
}
function closePending() {
  document.getElementById('pendingModal').style.display = 'none';
}
window._showPending  = showPending;
window._closePending = closePending;

function anSetStatus(s) {
  _anStatus = s;
  const el = document.getElementById('anStatusFilter');
  if (el) el.value = s;
  renderAnPayTable();
}
window.anSetStatus = anSetStatus;

function anSetBlock(b) {
  _anBlock = b;
  // Sync both block selects
  ['anBlockFilter','anBlockFilter2'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = b;
  });
  rAnalytics();
}
window.anSetBlock = anSetBlock;

function renderAnPayTable(filterType, selMonth, selYear, selBlock) {
  if (filterType !== undefined) _anFilterType = filterType;
  if (selMonth   !== undefined) _anSelMonth   = selMonth || AM;
  if (selYear    !== undefined) _anSelYear    = selYear  || new Date().getFullYear().toString();
  if (selBlock   !== undefined) _anBlock      = selBlock || 'all';

  const ft = _anFilterType || 'month';
  const sm = _anSelMonth   || AM;
  const sy = _anSelYear    || new Date().getFullYear().toString();
  const sb = _anBlock      || 'all';

  let rows = _buildFlatSummary(ft, sm, sy, sb);
  if (_anStatus !== 'all') rows = rows.filter(f => f._status === _anStatus);

  const tbody   = document.getElementById('anPayTable');
  const empty   = document.getElementById('anPayEmpty');
  const counter = document.getElementById('anPayCount');
  if (!tbody) return;

  if (!rows.length) {
    tbody.innerHTML = '';
    if (empty)   empty.style.display   = 'block';
    if (counter) counter.textContent   = '';
    return;
  }
  if (empty)   empty.style.display   = 'none';
  if (counter) counter.textContent   = `(${rows.length} flats)`;

  tbody.innerHTML = rows.map((f,i) => {
    const s        = f._status || 'pending';
    const bal      = (f.due||0) - (f.paid||0);
    const balColor = bal > 0 ? 'var(--red)' : 'var(--green)';
    const v        = vehicles.get(f.flatId) || { tw: 0, fw: 0 };
    const tw       = parseInt(v.tw) || 0;
    const fw       = parseInt(v.fw) || 0;
    const vehCell  = (tw === 0 && fw === 0)
      ? `<span style="font-size:11px;color:var(--muted)">—</span>`
      : `<span style="display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;color:var(--text)">
           ${tw > 0 ? `<span>${tw}</span>` : ''}
           ${tw > 0 && fw > 0 ? `<span style="color:var(--text2)">/ </span>` : ''}
           ${fw > 0 ? `<span>${fw}</span>` : ''}
         </span>`;
    const isVacant = !(f.owner||'').trim();
    const resType  = isVacant ? 'vacant' : (f.resType||'owner');
    const typeBadge = isVacant
      ? `<span style="font-size:9px;font-weight:700;color:var(--muted)">Vacant</span>`
      : resType === 'tenant'
        ? `<span style="font-size:9px;font-weight:700;color:var(--amber)">🔑 Tenant</span>`
        : `<span style="font-size:9px;font-weight:700;color:var(--indigo)">🏠 Owner</span>`;
    
    const statusText = {
      paid: 'Paid',
      partial: 'Partial',
      pending: 'Pending',
      vacant: 'Vacant'
    }[s] || 'Pending';
    
    return `<tr
      onclick="window._openPayHistory('${f.flatId}')"
      style="cursor:pointer;transition:background .12s"
      onmouseover="this.style.background='var(--indigo-bg)'"
      onmouseout="this.style.background=''">
      <td style="padding:10px 12px;font-weight:800;color:var(--indigo);font-size:12px;border-bottom:1px solid var(--border);vertical-align:middle;white-space:nowrap">${f.flatId}</td>
      <td style="padding:10px 12px;border-bottom:1px solid var(--border);overflow:hidden;vertical-align:middle">
        <div style="font-size:12px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${f.owner||'<em style="color:var(--muted);font-weight:400">Vacant</em>'}</div>
        <div style="margin-top:2px">${typeBadge}</div>
      </td>
      <td style="padding:10px 12px;text-align:center;border-bottom:1px solid var(--border);vertical-align:middle;font-size:12px">${vehCell}</td>
      <td style="padding:10px 12px;text-align:right;font-weight:800;color:${balColor};font-size:13px;border-bottom:1px solid var(--border);white-space:nowrap;vertical-align:middle">${f.due?inr(Math.abs(bal)):'—'}</td>
      <td style="padding:10px 12px;text-align:center;border-bottom:1px solid var(--border);vertical-align:middle;position:relative" class="status-col">
        <span class="status-text" style="display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;padding:4px 8px;border-radius:6px;${s==='paid'?'background:#dcfce7;color:#16a34a':s==='partial'?'background:#fef9c3;color:#d97706':s==='pending'?'background:#fee2e2;color:#dc2626':'background:#f3f4f6;color:#9ca3af'}">${statusText}</span>
        <span class="status-icon" style="display:none;font-size:20px;${s==='paid'?'color:#16a34a':s==='partial'?'color:#d97706':'color:#dc2626'}" title="${statusText}">
          <i class="ti ti-circle-filled"></i>
        </span>
      </td>
    </tr>`;
  }).join('');

  // Totals row
  const totBal = rows.reduce((s,f)=>s+((f.due||0)-(f.paid||0)),0);
  const totTw  = rows.reduce((s,f)=>s+(parseInt((vehicles.get(f.flatId)||{}).tw)||0),0);
  const totFw  = rows.reduce((s,f)=>s+(parseInt((vehicles.get(f.flatId)||{}).fw)||0),0);
  tbody.innerHTML += `<tr style="background:var(--surface3);border-top:2px solid var(--border2)">
    <td style="padding:10px 12px;font-size:11px;font-weight:800;color:var(--text2)" colspan="2">Total — ${rows.length} flats</td>
    <td style="padding:10px 12px;text-align:center;font-size:12px;font-weight:700;color:var(--text)">${totTw>0?`${totTw}`:''} ${totTw>0&&totFw>0?'/ ':''} ${totFw>0?`${totFw}`:''}</td>
    <td style="padding:10px 12px;text-align:right;font-weight:800;color:${totBal>0?'var(--red)':'var(--green)'};font-size:13px;white-space:nowrap">${inr(Math.abs(totBal))}</td>
    <td style="padding:10px 12px;text-align:center;font-size:10px;color:var(--muted)">—</td>
  </tr>`;
}

/* rStructure is defined inline above */

/* ════════════════════════════════
   MONTHLY SUMMARY REPORT
════════════════════════════════ */

function oMonthlySummary() {
  const el = document.getElementById('monthlySummaryM');
  if (!el) return;

  // Populate month selector
  const monthSet = new Set();
  exps.forEach(records => records.forEach(e => { if (e.month) monthSet.add(e.month); }));
  monthSet.add(AM);
  const months = [...monthSet].sort().reverse();

  const mSel = document.getElementById('msMonth');
  mSel.innerHTML = months.map(m => {
    const [y, mo] = m.split('-');
    const label = new Date(y, mo - 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
    return `<option value="${m}"${m === AM ? ' selected' : ''}>${label}</option>`;
  }).join('');

  // Block filter
  const bSel = document.getElementById('msBlock');
  const blks = bks();
  bSel.innerHTML = '<option value="all">All Blocks</option>' +
    blks.map(b => `<option value="${b}">Block ${b}</option>`).join('');

  el.style.display = 'flex';
  _renderSummary();
}

window._oMonthlySummary = oMonthlySummary;
window._cMonthlySummary = () => { document.getElementById('monthlySummaryM').style.display = 'none'; };


function _renderSummary() {
  const month  = document.getElementById('msMonth')?.value  || AM;
  const block  = document.getElementById('msBlock')?.value  || 'all';
  const status = document.getElementById('msStatus')?.value || 'all';

  if (!month) return;

  const [y, mo] = month.split('-');
  const monthLabel = new Date(+y, +mo - 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

  // Compute per-flat payment for selected month (use flatId as key — matches exps Map)
  let allRows = [...flats.values()].map(f => {
    const fid      = f.flatId;                                        // correct key
    const monthExps = (exps.get(fid) || []).filter(e => e.month === month);
    const paid = monthExps.reduce((s, e) => s + (e.amt || 0), 0);
    const due  = f.due || 0;
    const bal  = due - paid;
    const s    = paid >= due ? 'paid' : paid > 0 ? 'partial' : 'pending';
    return { ...f, _paid: paid, _due: due, _bal: bal, _status: s, _monthExps: monthExps };
  });

  // Apply block filter
  if (block !== 'all') allRows = allRows.filter(f => (f.block || '') === block);

  // Store block-filtered totals for print (before status filter)
  const printRows = [...allRows].sort((a, b) =>
    (a.block||'').localeCompare(b.block||'') || (a.flatId||'').localeCompare(b.flatId||''));
  const printTotDue  = printRows.reduce((s, f) => s + f._due,  0);
  const printTotPaid = printRows.reduce((s, f) => s + f._paid, 0);
  const printTotBal  = printRows.reduce((s, f) => s + f._bal,  0);

  // Apply status filter for display
  let rows = block !== 'all' || status !== 'all'
    ? allRows.filter(f => status === 'all' || f._status === status)
    : allRows;

  rows.sort((a, b) => (a.block||'').localeCompare(b.block||'') || (a.flatId||'').localeCompare(b.flatId||''));

  // Display totals reflect current visible rows
  const totDue  = rows.reduce((s, f) => s + f._due,  0);
  const totPaid = rows.reduce((s, f) => s + f._paid, 0);
  const totBal  = rows.reduce((s, f) => s + f._bal,  0);
  const paidCnt = allRows.filter(f => f._status === 'paid').length;
  const partCnt = allRows.filter(f => f._status === 'partial').length;
  const pendCnt = allRows.filter(f => f._status === 'pending').length;

  const statusBadge = s => ({
    paid:    '<span style="background:#D1FAE5;color:#065F46;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:800">✅ Paid</span>',
    partial: '<span style="background:#FEF3C7;color:#92400E;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:800">⚠️ Partial</span>',
    pending: '<span style="background:#FEE2E2;color:#991B1B;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:800">❌ Pending</span>',
  }[s]);

  const collPctHead = totDue > 0 ? Math.round(totPaid / totDue * 100) : 0;
  document.getElementById('msSummaryHead').innerHTML = `
    <style>
      .ms-kpi-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:10px}
      .ms-kpi{border-radius:12px;padding:12px;position:relative;overflow:hidden}
      .ms-kpi-lbl{font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.6px;white-space:nowrap;opacity:.85}
      .ms-kpi-val{font-size:16px;font-weight:800;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:-.3px}
      .ms-kpi-sub{font-size:9px;margin-top:3px;font-weight:600;opacity:.75}
      .ms-prog-wrap{padding:10px 14px;background:var(--surface2);border-radius:12px;margin-bottom:10px}
      .ms-prog-track{height:7px;background:#fff;border-radius:99px;overflow:hidden;margin-top:6px}
      .ms-chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:2px}
      .ms-chip{font-size:10px;font-weight:700;padding:4px 10px;border-radius:20px;white-space:nowrap;display:inline-flex;align-items:center;gap:4px}
      @media(max-width:420px){
        .ms-kpi-grid{grid-template-columns:1fr 1fr;gap:6px}
        .ms-kpi-val{font-size:14px}
        .ms-kpi:last-child{grid-column:1/-1}
      }
    </style>
    <div class="ms-kpi-grid">
      <div class="ms-kpi" style="background:linear-gradient(135deg,#EEF2FF,#E0E7FF);color:#4338CA">
        <div class="ms-kpi-lbl">Total Due</div>
        <div class="ms-kpi-val">${inr(totDue)}</div>
        <div class="ms-kpi-sub">${rows.length} flats</div>
      </div>
      <div class="ms-kpi" style="background:linear-gradient(135deg,#ECFDF5,#D1FAE5);color:#047857">
        <div class="ms-kpi-lbl">Collected</div>
        <div class="ms-kpi-val">${inr(totPaid)}</div>
        <div class="ms-kpi-sub">${collPctHead}% of due</div>
      </div>
      <div class="ms-kpi" style="background:${totBal>0?'linear-gradient(135deg,#FEF2F2,#FEE2E2)':'linear-gradient(135deg,#ECFDF5,#D1FAE5)'};color:${totBal>0?'#B91C1C':'#047857'}">
        <div class="ms-kpi-lbl">${totBal>0?'Balance':'Status'}</div>
        <div class="ms-kpi-val">${inr(Math.abs(totBal))}</div>
        <div class="ms-kpi-sub">${totBal>0?'Pending':'Fully collected 🎉'}</div>
      </div>
    </div>
    <div class="ms-prog-wrap">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.5px">Collection Progress</span>
        <span style="font-size:12px;font-weight:800;color:var(--indigo)">${collPctHead}%</span>
      </div>
      <div class="ms-prog-track">
        <div style="height:100%;width:${collPctHead}%;background:linear-gradient(90deg,#6366F1,#10B981);border-radius:99px;transition:width .4s"></div>
      </div>
    </div>
    <div class="ms-chips">
      <span class="ms-chip" style="background:#D1FAE5;color:#065F46">✓ ${paidCnt} Paid</span>
      <span class="ms-chip" style="background:#FEF3C7;color:#92400E">◐ ${partCnt} Partial</span>
      <span class="ms-chip" style="background:#FEE2E2;color:#991B1B">✕ ${pendCnt} Pending</span>
    </div>`;

  const statusDot = s => ({ paid:'#10B981', partial:'#F59E0B', pending:'#EF4444' }[s]);
  const statusBg   = s => ({ paid:'#ECFDF5', partial:'#FFFBEB', pending:'#FEF2F2' }[s]);
  const barPct     = f => f._due > 0 ? Math.min(100, Math.round(f._paid / f._due * 100)) : 0;
  const initials   = n => (n||'?').trim().split(/\s+/).map(w=>w[0]).slice(0,2).join('').toUpperCase();

  document.getElementById('msSummaryBody').innerHTML = rows.length === 0
    ? '<div style="padding:40px 20px;text-align:center;color:var(--muted)"><i class="ti ti-inbox" style="font-size:28px;display:block;margin-bottom:10px;opacity:.5"></i><div style="font-size:13px;font-weight:600">No flats match the selected filters</div></div>'
    : `<div style="display:flex;flex-direction:column;gap:8px;padding:10px">` +
      rows.map(f => {
        const pct = barPct(f);
        return `<div style="background:#fff;border:1.5px solid var(--border2);border-radius:12px;padding:12px 14px;transition:box-shadow .15s,border-color .15s"
          onmouseover="this.style.boxShadow='0 4px 12px rgba(0,0,0,.06)';this.style.borderColor='${statusDot(f._status)}'"
          onmouseout="this.style.boxShadow='';this.style.borderColor='var(--border2)'">

          <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
            <div style="width:36px;height:36px;border-radius:10px;background:${statusBg(f._status)};color:${statusDot(f._status)};
              display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;flex-shrink:0">
              ${initials(f.owner)}
            </div>
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                <span style="font-size:14px;font-weight:800;color:var(--text)">${f.flatId}</span>
                ${f.block ? `<span style="font-size:9px;font-weight:700;color:var(--muted);background:var(--surface3);padding:2px 6px;border-radius:5px">Block ${f.block}</span>` : ''}
              </div>
              <div style="font-size:11px;color:var(--text2);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${f.owner || 'Vacant'}${(f.phone||f.ownerPhone) ? ' · '+(f.phone||f.ownerPhone) : ''}</div>
            </div>
            <span style="flex-shrink:0;font-size:9px;font-weight:800;padding:3px 9px;border-radius:20px;
              background:${statusBg(f._status)};color:${statusDot(f._status)};white-space:nowrap;text-transform:uppercase;letter-spacing:.3px">
              ${f._status === 'paid' ? '✓ Paid' : f._status === 'partial' ? '◐ Partial' : '✕ Pending'}
            </span>
          </div>

          <div style="height:5px;background:var(--surface3);border-radius:99px;overflow:hidden;margin-bottom:8px">
            <div style="height:100%;width:${pct}%;background:${statusDot(f._status)};border-radius:99px;transition:width .3s"></div>
          </div>

          <div style="display:flex;justify-content:space-between;font-size:11px">
            <span style="color:var(--muted)">Due <strong style="color:var(--text)">${inr(f._due)}</strong></span>
            <span style="color:var(--muted)">Paid <strong style="color:#10B981">${inr(f._paid)}</strong></span>
            <span style="color:var(--muted)">Bal <strong style="color:${f._bal>0?'#EF4444':'#10B981'}">${inr(Math.abs(f._bal))}</strong></span>
          </div>
        </div>`;
      }).join('') + `</div>`;

  // Store print data = all rows for the month (ignores status filter so print is complete)
  window._msSummaryData = { rows: printRows, monthLabel, totDue: printTotDue, totPaid: printTotPaid, totBal: printTotBal };
}

window._renderSummary = _renderSummary;

function _printMonthlySummary() {
  const d = window._msSummaryData;
  if (!d) return;
  const { rows, monthLabel, totDue, totPaid, totBal } = d;

  const paidCnt  = rows.filter(f => f._status === 'paid').length;
  const partCnt  = rows.filter(f => f._status === 'partial').length;
  const pendCnt  = rows.filter(f => f._status === 'pending').length;
  const collPct  = totDue > 0 ? Math.round(totPaid / totDue * 100) : 0;
  const genDate  = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });

  /* ── Society expenses for the selected month ── */
  const msMonth = document.getElementById('msMonth')?.value || AM;
  const monthExps = socExps.filter(e => (e.month || (e.date||'').slice(0,7)) === msMonth);
  const totSocExp = monthExps.reduce((s, e) => s + (e.amt || 0), 0);

  /* ── Category breakdown of society expenses ── */
  const catMap = {};
  monthExps.forEach(e => { catMap[e.cat || 'Other'] = (catMap[e.cat || 'Other'] || 0) + (e.amt || 0); });
  const catRows = Object.entries(catMap).sort((a, b) => b[1] - a[1]);

  const netBalance = totPaid - totSocExp;

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<title>${APT_NAME} — Summary — ${monthLabel}</title>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet"/>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Plus Jakarta Sans',sans-serif;background:#fff;color:#0f172a;font-size:12px;-webkit-print-color-adjust:exact;print-color-adjust:exact;padding:28px 32px}

  /* HEADER */
  .header{background:linear-gradient(135deg,#4F46E5 0%,#7C3AED 60%,#9333EA 100%);border-radius:14px;padding:22px 28px;color:#fff;margin-bottom:22px;display:flex;justify-content:space-between;align-items:center}
  .h-left .apt{font-size:22px;font-weight:800;letter-spacing:-.3px}
  .h-left .sub{font-size:11px;opacity:.75;font-weight:500;margin-top:3px}
  .h-right{text-align:right}
  .h-right .pct{font-size:32px;font-weight:800;line-height:1}
  .h-right .pct-lbl{font-size:10px;opacity:.7;font-weight:600;margin-top:2px}

  /* SECTION TITLE */
  .sec-title{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.7px;color:#6366F1;margin-bottom:10px;display:flex;align-items:center;gap:6px}
  .sec-title::after{content:'';flex:1;height:1.5px;background:#e0e7ff}

  /* KPI GRID */
  .kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:22px}
  .kpi{border-radius:10px;padding:14px 16px;border:1.5px solid #e2e8f0}
  .kpi-lbl{font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.6px;color:#94a3b8;margin-bottom:5px}
  .kpi-val{font-size:18px;font-weight:800;letter-spacing:-.3px}
  .kpi-sub{font-size:9px;color:#94a3b8;margin-top:3px;font-weight:500}
  .kpi.indig{border-color:#c7d2fe;background:#EEF2FF}.kpi.indig .kpi-val{color:#4F46E5}
  .kpi.grn  {border-color:#6EE7B7;background:#F0FDF4}.kpi.grn   .kpi-val{color:#059669}
  .kpi.red  {border-color:#FCA5A5;background:#FFF1F2}.kpi.red   .kpi-val{color:#DC2626}
  .kpi.netg {border-color:#6EE7B7;background:#F0FDF4}.kpi.netg  .kpi-val{color:#059669}
  .kpi.netr {border-color:#FCA5A5;background:#FFF1F2}.kpi.netr  .kpi-val{color:#DC2626}

  /* PROGRESS BAR */
  .prog-wrap{margin-bottom:22px}
  .prog-row{display:flex;justify-content:space-between;font-size:10px;font-weight:700;color:#64748b;margin-bottom:6px}
  .prog-track{height:10px;background:#f1f5f9;border-radius:99px;overflow:hidden}
  .prog-fill{height:100%;border-radius:99px;background:linear-gradient(90deg,#4F46E5,#10B981)}

  /* STATUS ROW */
  .status-row{display:flex;gap:10px;margin-bottom:22px}
  .st-chip{flex:1;border-radius:10px;padding:12px 14px;text-align:center;border:1.5px solid}
  .st-chip .st-cnt{font-size:22px;font-weight:800;line-height:1}
  .st-chip .st-lbl{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-top:3px}
  .st-chip.paid {border-color:#86EFAC;background:#F0FDF4}.st-chip.paid .st-cnt{color:#166534}.st-chip.paid .st-lbl{color:#4ade80}
  .st-chip.partial{border-color:#FCD34D;background:#FFFBEB}.st-chip.partial .st-cnt{color:#92400E}.st-chip.partial .st-lbl{color:#F59E0B}
  .st-chip.pending{border-color:#FCA5A5;background:#FFF1F2}.st-chip.pending .st-cnt{color:#9F1239}.st-chip.pending .st-lbl{color:#F87171}

  /* TWO-COLUMN LAYOUT */
  .two-col{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:22px}

  /* TABLES */
  .tbl-card{border:1.5px solid #e2e8f0;border-radius:10px;overflow:hidden}
  .tbl-card-head{background:#f8fafc;padding:10px 14px;font-size:10px;font-weight:800;color:#374151;border-bottom:1.5px solid #e2e8f0;text-transform:uppercase;letter-spacing:.5px}
  table{width:100%;border-collapse:collapse}
  th{padding:7px 10px;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:#94a3b8;border-bottom:1px solid #f1f5f9;text-align:left}
  th.r{text-align:right}
  td{padding:7px 10px;font-size:11px;border-bottom:1px solid #f8fafc;vertical-align:middle}
  td.r{text-align:right;font-weight:700}
  tr:last-child td{border-bottom:none}
  .badge{padding:2px 8px;border-radius:99px;font-size:9px;font-weight:800}
  .badge.paid{background:#D1FAE5;color:#065F46}
  .badge.partial{background:#FEF3C7;color:#92400E}
  .badge.pending{background:#FEE2E2;color:#991B1B}
  .cat-dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:5px}
  .tfoot-row td{background:#f8fafc;font-weight:800;border-top:1.5px solid #e2e8f0}

  /* FOOTER */
  .footer{display:flex;justify-content:space-between;align-items:center;padding-top:14px;border-top:1.5px solid #e2e8f0;margin-top:4px}
  .footer-l{font-size:10px;color:#94a3b8}
  .powered{font-size:9px;font-weight:800;letter-spacing:.5px;background:#4F46E5;color:#fff;padding:3px 9px;border-radius:4px}

  @media print{body{padding:0}@page{margin:12mm 14mm;size:A4}tr{page-break-inside:avoid}}
</style>
</head>
<body>

<!-- HEADER -->
<div class="header">
  <div class="h-left">
    <div class="apt">🏢 ${APT_NAME}</div>
    <div class="sub">Monthly Maintenance Summary &nbsp;·&nbsp; ${monthLabel}</div>
    <div class="sub" style="margin-top:2px;opacity:.55">Generated ${genDate}</div>
  </div>
  <div class="h-right">
    <div class="pct">${collPct}%</div>
    <div class="pct-lbl">Collected</div>
  </div>
</div>

<!-- KPI CARDS -->
<div class="sec-title">Financial Overview</div>
<div class="kpi-grid">
  <div class="kpi indig">
    <div class="kpi-lbl">Total Due</div>
    <div class="kpi-val">₹${Number(totDue).toLocaleString('en-IN')}</div>
    <div class="kpi-sub">${rows.length} flats</div>
  </div>
  <div class="kpi grn">
    <div class="kpi-lbl">Maintenance Collected</div>
    <div class="kpi-val">₹${Number(totPaid).toLocaleString('en-IN')}</div>
    <div class="kpi-sub">${collPct}% of due</div>
  </div>
  <div class="kpi red">
    <div class="kpi-lbl">Society Expenses</div>
    <div class="kpi-val">₹${Number(totSocExp).toLocaleString('en-IN')}</div>
    <div class="kpi-sub">${monthExps.length} expense${monthExps.length !== 1 ? 's' : ''}</div>
  </div>
  <div class="kpi ${netBalance >= 0 ? 'netg' : 'netr'}">
    <div class="kpi-lbl">Net Balance</div>
    <div class="kpi-val">₹${Number(Math.abs(netBalance)).toLocaleString('en-IN')}</div>
    <div class="kpi-sub">${netBalance >= 0 ? 'Surplus' : 'Deficit'}</div>
  </div>
</div>

<!-- PROGRESS BAR -->
<div class="prog-wrap">
  <div class="prog-row"><span>Collection Progress</span><span style="color:#4F46E5;font-weight:800">${collPct}% collected</span></div>
  <div class="prog-track"><div class="prog-fill" style="width:${collPct}%"></div></div>
</div>

<!-- STATUS CHIPS -->
<div class="sec-title">Payment Status</div>
<div class="status-row">
  <div class="st-chip paid">
    <div class="st-cnt">${paidCnt}</div>
    <div class="st-lbl">Fully Paid</div>
  </div>
  <div class="st-chip partial">
    <div class="st-cnt">${partCnt}</div>
    <div class="st-lbl">Partial</div>
  </div>
  <div class="st-chip pending">
    <div class="st-cnt">${pendCnt}</div>
    <div class="st-lbl">Not Paid</div>
  </div>
</div>

<!-- PAYMENTS + EXPENSES SIDE BY SIDE -->
<div class="sec-title">Details</div>
<div class="two-col">

  <!-- PAYMENTS SUMMARY BY BLOCK -->
  <div class="tbl-card">
    <div class="tbl-card-head">💰 Payments by Block</div>
    <table>
      <thead><tr><th>Block</th><th class="r">Due</th><th class="r">Collected</th><th class="r">Pending</th></tr></thead>
      <tbody>
        ${(() => {
          const blks = [...new Set(rows.map(f => f.block || '–'))].sort();
          return blks.map(b => {
            const bRows = rows.filter(f => (f.block || '–') === b);
            const bDue  = bRows.reduce((s,f) => s + f._due, 0);
            const bPaid = bRows.reduce((s,f) => s + f._paid, 0);
            const bBal  = bDue - bPaid;
            return `<tr>
              <td><strong>Block ${b}</strong><br><span style="font-size:9px;color:#94a3b8">${bRows.length} flats</span></td>
              <td class="r" style="color:#64748b">₹${Number(bDue).toLocaleString('en-IN')}</td>
              <td class="r" style="color:#059669">₹${Number(bPaid).toLocaleString('en-IN')}</td>
              <td class="r" style="color:${bBal>0?'#DC2626':'#059669'}">₹${Number(bBal).toLocaleString('en-IN')}</td>
            </tr>`;
          }).join('') + `<tr class="tfoot-row">
            <td>Total</td>
            <td class="r">₹${Number(totDue).toLocaleString('en-IN')}</td>
            <td class="r" style="color:#059669">₹${Number(totPaid).toLocaleString('en-IN')}</td>
            <td class="r" style="color:${totBal>0?'#DC2626':'#059669'}">₹${Number(Math.abs(totBal)).toLocaleString('en-IN')}</td>
          </tr>`;
        })()}
      </tbody>
    </table>
  </div>

  <!-- SOCIETY EXPENSES BY CATEGORY -->
  <div class="tbl-card">
    <div class="tbl-card-head">🧾 Society Expenses</div>
    ${monthExps.length === 0
      ? `<div style="padding:24px;text-align:center;color:#94a3b8;font-size:11px">No expenses recorded for ${monthLabel}</div>`
      : `<table>
          <thead><tr><th>Category</th><th>Description</th><th class="r">Amount</th></tr></thead>
          <tbody>
            ${monthExps.sort((a,b)=>(b.amt||0)-(a.amt||0)).map(e => `<tr>
              <td style="font-size:10px;font-weight:700;color:#6366F1">${e.cat||'Other'}</td>
              <td style="font-size:10px;color:#64748b">${e.title||'–'}</td>
              <td class="r" style="color:#DC2626">₹${Number(e.amt||0).toLocaleString('en-IN')}</td>
            </tr>`).join('')}
          </tbody>
          <tfoot><tr class="tfoot-row">
            <td colspan="2">Total Expenses</td>
            <td class="r" style="color:#DC2626">₹${Number(totSocExp).toLocaleString('en-IN')}</td>
          </tr></tfoot>
        </table>`
    }
  </div>

</div>

<!-- FOOTER -->
<div class="footer">
  <div class="footer-l">${APT_NAME} &nbsp;·&nbsp; ${monthLabel} Maintenance Report</div>
  <div style="display:flex;align-items:center;gap:8px">
    <span style="font-size:10px;color:#94a3b8">Powered by</span>
    <span class="powered">GATEBOOK</span>
  </div>
</div>

<script>window.onload = () => { window.print(); }<\/script>
</body></html>`;

  const w = window.open('', '_blank');
  w.document.write(html);
  w.document.close();
}

window._printMonthlySummary = _printMonthlySummary;

/* ════════════════════════════════
   SERVICE CONTACTS
════════════════════════════════ */
const CONTACT_ICONS = {
  Plumber:'ti-droplet', Electrician:'ti-bolt', Maid:'ti-broom', Security:'ti-shield-lock',
  Gardener:'ti-plant-2', Carpenter:'ti-hammer', Painter:'ti-paint', 'Pest Control':'ti-bug',
  'AC Repair':'ti-air-conditioning', Other:'ti-tool'
};
const CONTACT_COLORS = {
  Plumber:'#0EA5E9', Electrician:'#F59E0B', Maid:'#EC4899', Security:'#6366F1',
  Gardener:'#22C55E', Carpenter:'#A16207', Painter:'#A855F7', 'Pest Control':'#EF4444',
  'AC Repair':'#06B6D4', Other:'#6B7280'
};

window._rContacts = function() {
  const filter = document.getElementById('contactCatFilter')?.value || 'all';
  const vis = filter === 'all' ? contacts : contacts.filter(c => c.cat === filter);
  const el = document.getElementById('contactsList');
  if (!el) return;
  el.style.gridTemplateColumns = 'repeat(auto-fill,minmax(min(100%,230px),1fr))';
  el.style.gap = '10px';

  if (!vis.length) {
    el.innerHTML = `<div style="grid-column:1/-1;padding:40px 20px;text-align:center;color:var(--muted)">
      <i class="ti ti-address-book-off" style="font-size:28px;display:block;margin-bottom:10px;opacity:.5"></i>
      <div style="font-size:13px;font-weight:600">No service contacts ${filter!=='all'?'in this category':'yet'}</div>
      <div style="font-size:11px;margin-top:4px">Tap "Add Contact" to save plumber, electrician, maid etc.</div>
    </div>`;
    return;
  }

  el.innerHTML = vis.map(c => {
    const icon  = CONTACT_ICONS[c.cat] || 'ti-tool';
    const color = CONTACT_COLORS[c.cat] || '#6B7280';
    const digits = (c.phone || '').replace(/\D/g, '');
    const btn = 'flex:1 1 96px;min-height:38px;display:inline-flex;align-items:center;justify-content:center;gap:6px;border-radius:8px;font-size:13px;font-weight:700;text-decoration:none;padding:0 10px;';
    return `<div onclick="window._oContact('${c.id}')"
      style="display:flex;flex-direction:column;gap:10px;min-width:0;background:#fff;border:1.5px solid var(--border2);
        border-radius:12px;padding:12px;cursor:pointer;transition:box-shadow .12s,border-color .12s"
      onmouseover="this.style.boxShadow='0 2px 8px rgba(0,0,0,.06)';this.style.borderColor='${color}'"
      onmouseout="this.style.boxShadow='';this.style.borderColor='var(--border2)'">
      <div style="display:flex;align-items:center;gap:10px;min-width:0">
        <div style="width:38px;height:38px;border-radius:10px;background:${color}18;color:${color};
          display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">
          <i class="ti ${icon}"></i>
        </div>
        <div style="min-width:0;flex:1">
          <div class="ct-name" style="font-size:14px;font-weight:700;color:var(--text);line-height:1.25;overflow-wrap:anywhere;
            display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${_esc(c.name || 'Unnamed')}</div>
          <div class="ct-meta" style="font-size:12px;font-weight:600;color:var(--text2);margin-top:2px">${_esc(c.cat || 'Other')}</div>
        </div>
      </div>
      ${c.phone ? `<div data-t style="font-size:13px;font-weight:700;color:var(--text);letter-spacing:.2px;overflow-wrap:anywhere">${_esc(c.phone)}${c.phone2 ? ` <span style="color:var(--text2);font-weight:600">· ${_esc(c.phone2)}</span>` : ''}</div>` : ''}
      ${c.note ? `<div data-t style="font-size:12px;color:var(--text2);line-height:1.35;overflow-wrap:anywhere">${_esc(c.note)}</div>` : ''}
      ${digits ? `<div style="display:flex;gap:8px;flex-wrap:wrap" onclick="event.stopPropagation()">
        <a href="tel:${digits}" title="Call" style="${btn}background:var(--indigo-bg);color:#4338CA"><i class="ti ti-phone" style="font-size:15px"></i>Call</a>
        <a href="https://wa.me/91${digits}" target="_blank" rel="noopener" title="WhatsApp" style="${btn}background:#D1FAE5;color:#065F46"><i class="ti ti-brand-whatsapp" style="font-size:16px"></i>WhatsApp</a>
      </div>` : ''}
    </div>`;
  }).join('');
};

window._oContact = function(id) {
  const modal = document.getElementById('contactM');
  if (!modal) return;
  const isEdit = !!id;
  document.getElementById('contactMTitle').textContent = isEdit ? 'Edit Service Contact' : 'Add Service Contact';
  document.getElementById('contactDelBtn').style.display = isEdit ? '' : 'none';
  document.getElementById('contactSaveLbl').textContent  = isEdit ? 'Update Contact' : 'Save Contact';

  if (isEdit) {
    const c = contacts.find(x => x.id === id);
    if (!c) return;
    document.getElementById('contactId').value     = id;
    document.getElementById('contactName').value    = c.name || '';
    document.getElementById('contactCat').value     = c.cat || 'Plumber';
    document.getElementById('contactPhone').value   = c.phone || '';
    document.getElementById('contactPhone2').value  = c.phone2 || '';
    document.getElementById('contactNote').value    = c.note || '';
  } else {
    document.getElementById('contactId').value    = '';
    document.getElementById('contactName').value   = '';
    document.getElementById('contactCat').value    = 'Plumber';
    document.getElementById('contactPhone').value  = '';
    document.getElementById('contactPhone2').value = '';
    document.getElementById('contactNote').value   = '';
  }
  modal.classList.add('open');
};

window._cContact = function() {
  document.getElementById('contactM').classList.remove('open');
};

window._sContact = async function() {
  const id     = document.getElementById('contactId').value;
  const name   = (document.getElementById('contactName').value || '').trim();
  const cat    = document.getElementById('contactCat').value;
  const phone  = (document.getElementById('contactPhone').value || '').trim();
  const phone2 = (document.getElementById('contactPhone2').value || '').trim();
  const note   = (document.getElementById('contactNote').value || '').trim();

  if (!name)  { toast('Enter a name', 'error'); return; }
  if (!phone) { toast('Enter a phone number', 'error'); return; }

  const btn = document.getElementById('contactSaveBtn');
  if (btn) btn.disabled = true;
  sync('saving');
  try {
    const payload = { name, cat, phone, phone2, note, updatedAt: serverTimestamp() };
    if (id) {
      await updateDoc(contactRef(id), payload);
    } else {
      payload.createdAt = serverTimestamp();
      payload.createdByUid = auth.currentUser?.uid || null;
      payload.addedBy = isMember() ? `${MY_NAME}${MY_FLAT ? ' (' + MY_FLAT + ')' : ''}` : 'Admin';
      await addDoc(contactsColl(), payload);
    }
    sync('live'); toast(id ? 'Contact updated ✓' : 'Contact added ✓');
    window._cContact();
    // Force immediate re-render in case the snapshot listener is slow/detached
    setTimeout(() => { try { window._rContacts(); } catch(e) {} }, 300);
  } catch (e) {
    console.error('Contact save error:', e);
    sync('error');
    toast('Save failed: ' + (e.message || 'unknown error'), 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
};

window._delContact = async function() {
  const id = document.getElementById('contactId').value;
  if (!id) return;
  const c = contacts.find(x => x.id === id);
  if (!confirm(`Delete contact "${c?.name || 'this contact'}"?`)) return;
  sync('saving');
  try {
    await deleteDoc(contactRef(id));
    sync('live'); toast('Contact deleted ✓');
    window._cContact();
  } catch (e) {
    console.error(e); sync('error'); toast('Delete failed', 'error');
  }
};

/* ════════════════════════════════
   EDIT CORPUS FUND
════════════════════════════════ */
window._editCorpusFund = function() {
  const newAmount = prompt('Enter new Corpus Fund amount:', APT_CORPUS_FUND);
  if (newAmount === null) return; // User cancelled
  
  const corpusValue = parseInt(newAmount) || 0;
  if (corpusValue < 0) {
    toast('Amount cannot be negative', 'error');
    return;
  }
  
  sync('saving');
  updateDoc(aptDocRef(), { corpusFund: corpusValue })
    .then(() => {
      APT_CORPUS_FUND = corpusValue;
      sync('live');
      toast('Corpus Fund updated ✓');
      // Refresh both tabs
      if(document.getElementById('presidentView').style.display !== 'none') rPresident();
      if(document.getElementById('analyticsView').style.display !== 'none') rAnalytics();
    })
    .catch(e => {
      console.error(e);
      sync('error');
      toast('Update failed', 'error');
    });
};

/* ════════════════════════════════
   ISSUES / CONTACTS SUB-TAB TOGGLE
════════════════════════════════ */
window._issSubTab = function(which) {
  const issuesBtn    = document.getElementById('issSubTabIssues');
  const contactsBtn  = document.getElementById('issSubTabContacts');
  const reportsBtn   = document.getElementById('issSubTabReports');
  const issuesPanel  = document.getElementById('issSubPanelIssues');
  const contactsPanel= document.getElementById('issSubPanelContacts');
  const reportsPanel = document.getElementById('issSubPanelReports');
  if (!issuesBtn || !contactsBtn || !reportsBtn || !issuesPanel || !contactsPanel || !reportsPanel) return;

  const active = { border:'var(--indigo)', bg:'var(--indigo)', color:'#fff' };
  const inactive = { border:'var(--border2)', bg:'#fff', color:'var(--text2)' };

  // Reset all
  issuesPanel.style.display = 'none';
  contactsPanel.style.display = 'none';
  reportsPanel.style.display = 'none';
  Object.assign(issuesBtn.style, { borderColor: inactive.border, background: inactive.bg, color: inactive.color });
  Object.assign(contactsBtn.style, { borderColor: inactive.border, background: inactive.bg, color: inactive.color });
  Object.assign(reportsBtn.style, { borderColor: inactive.border, background: inactive.bg, color: inactive.color });

  if (which === 'issues') {
    issuesPanel.style.display = '';
    Object.assign(issuesBtn.style, { borderColor: active.border, background: active.bg, color: active.color });
    try { rIssues(); } catch(e) { console.error(e); }
  } else if (which === 'contacts') {
    contactsPanel.style.display = '';
    Object.assign(contactsBtn.style, { borderColor: active.border, background: active.bg, color: active.color });
    try { window._rContacts(); } catch(e) { console.error(e); }
  } else if (which === 'reports') {
    reportsPanel.style.display = '';
    Object.assign(reportsBtn.style, { borderColor: active.border, background: active.bg, color: active.color });
    // Add report initialization if needed
  }
};


/* ═══════════════════════════════════════════════════════════
   ROLES — admin vs flat member
   (guards, read-only UI, member banner, admin approval screen)
═══════════════════════════════════════════════════════════ */

// Buttons wired to these handlers are hidden for flat members.
// Add a handler name here if you add a new write feature.
const ADMIN_ONLY_HANDLERS = [
  '_oA','_oAFor','_oAF','_sNF','_sE','_oPresExp','_sPresExp','_oPresM','_sPres',
  '_oContact(?=\\s*\\(\\s*[^)\\s])','_delContact','_delIssue','_saveIss','_delExp','_delCat',
  '_addCat','_addInlineCat','_oVehM','_oVehFor','_sVeh','_delVeh',
  '_delPresHist','_editPresHist','_savePresHistEdit','_delSEModal','_openSEModal','_saveSEModal',
  '_deletePayment','_deleteStayPeriod','_addPayment','_addStayPeriod','_addNewFlatRow','_editPayment',
  '_editCorpusFund','_saveFlat','_saveResEdit','_saveExpEdit','_openExpEdit',
  '_saveNewStructure','_openStructureManager','_renameBlockPrompt','_toggleResEdit','_setResidentStatus',
  '_toggleStayingEdit','_updateStayingDates','_togglePaymentEdit','_phSave','_phEdit','_phDelete','_wizLaunch',
  '_deleteBlock','_deleteFlat','_wizAddBlock','wizRemoveBlock',
];
const _esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function applyRoleUI() {
  if (!isMember()) return;
  document.body.classList.add('role-member');
  const re = new RegExp('(?<![\\w$])(?:window\\.)?(?:' + ADMIN_ONLY_HANDLERS.join('|') + ')\\s*\\(');
  const sweep = () => {
    document.querySelectorAll('[onclick]').forEach(el => {
      if (!re.test(el.getAttribute('onclick') || '')) return;
      // A whole row or card that is clickable to edit (expense row, contact card): keep it
      // visible so members can read it, just make it non-clickable. Buttons are hidden.
      if (['TR', 'TD', 'LI', 'DIV'].includes(el.tagName)) { el.removeAttribute('onclick'); el.style.cursor = 'default'; }
      else {
        el.style.setProperty('display', 'none', 'important');
        if (/_oPresM\s*\(/.test(el.getAttribute('onclick') || '') && !el.dataset.roHist) {
          el.dataset.roHist = '1';
          el.insertAdjacentHTML('afterend', el.classList.contains('pres-chip-edit')
            ? '<button class="pres-chip-edit" onclick="window._viewPresHistory()" title="President history"><i class="ti ti-history"></i></button>'
            : '<button class="btn btn-white btn-sm" onclick="window._viewPresHistory()"><i class="ti ti-history"></i> President history</button>');
        }
      }
    });
    document.querySelectorAll('[id^="redit_"] input, [id^="redit_"] select').forEach(el => { el.disabled = true; });
    // Flat details window: show everything, allow nothing to be typed or changed
    const dBody = document.getElementById('dBody');
    if (dBody) {
      dBody.querySelectorAll('input, select, textarea').forEach(el => {
        if (!el.classList.contains('hist-search') && !el.classList.contains('hist-cat-sel')) el.disabled = true;
      });
      if (dBody.firstElementChild && !dBody.querySelector('.ro-note'))
        dBody.insertAdjacentHTML('afterbegin', '<div class="ro-note" style="background:#CCFBF1;color:#115E59;border-radius:8px;padding:8px 12px;margin:0 0 10px;font-size:12px;font-weight:700;display:flex;gap:6px;align-items:center"><i class="ti ti-eye"></i>View only. Only the admin can make changes.</div>');
    }
  };
  sweep();
  let raf = 0;
  new MutationObserver(() => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; sweep(); }); })
    .observe(document.body, { childList: true, subtree: true });
}

// Flat members: open the Society President window on the History tab only (no Elect tab)
window._viewPresHistory = () => {
  const t1 = document.getElementById('presTab1'); if (t1) t1.style.display = 'none';
  const sub = document.querySelector('#presM .msub'); if (sub) sub.textContent = 'Past presidents (view only)';
  window._presSwTab(2);
  document.getElementById('presM').classList.add('open');
};

function showMemberBanner() {
  const nav = document.querySelector('.navbar'); if (!nav) return;
  nav.insertAdjacentHTML('afterend',
    `<div style="background:#CCFBF1;color:#115E59;padding:9px 24px;font-size:13px;font-weight:600;display:flex;gap:8px;align-items:center">
       <i class="ti ti-eye"></i>View-only access${MY_FLAT ? ' · Flat ' + _esc(MY_FLAT) : ''}. You can see all details, raise issues and add service contacts from the Services tab. Only the admin can make other changes.
     </div>`);
}

/* ── Admin: add / reset / remove flat members (mobile + 6-character code) ── */
let MEMBERS = [], _deduping = false;

async function initMembershipUI() {
  const right = document.querySelector('.nav-right'); if (!right) return;
  const btn = document.createElement('button');
  btn.className = 'btn btn-white btn-sm'; btn.id = 'memBtn';
  btn.innerHTML = '<i class="ti ti-users-group"></i> Flat members';
  btn.onclick = () => { fillMemberForm(); document.getElementById('memM').classList.add('open'); };
  right.insertBefore(btn, right.firstChild);

  const m = document.createElement('div'); m.className = 'mbg'; m.id = 'memM';
  m.innerHTML = `<div class="modal">
    <div class="mhead">
      <div style="display:flex;align-items:center;gap:12px">
        <div class="micon detail"><i class="ti ti-users-group"></i></div>
        <div><div class="mtitle">Flat members</div><div class="msub">Add a resident, then share their mobile number and code</div></div>
      </div>
      <button class="mclose" onclick="document.getElementById('memM').classList.remove('open');document.getElementById('memCode').innerHTML=''"><i class="ti ti-x"></i></button>
    </div>
    <div class="fg2">
      <div class="fg"><label>Flat</label><select id="mmFlat" onchange="window._memPick()"></select></div>
      <div class="fg"><label>Name</label><input type="text" id="mmName" placeholder="Resident name"/></div>
    </div>
    <div class="fg2">
      <div class="fg"><label>Mobile number</label><input type="tel" id="mmMobile" inputmode="numeric" maxlength="10" placeholder="10 digits"/></div>
      <div class="fg"><label>6-character code</label>
        <div style="display:flex;gap:6px"><input type="text" id="mmPin" maxlength="6" autocapitalize="characters" style="flex:1;text-transform:uppercase"/>
        <button class="btn btn-white btn-sm" type="button" onclick="document.getElementById('mmPin').value=window._randomPin()" title="New random code"><i class="ti ti-refresh"></i></button></div></div>
    </div>
    <button class="btn btn-indigo" id="mmAdd" style="width:100%;justify-content:center;margin-bottom:12px" onclick="window._memAdd()"><i class="ti ti-user-plus"></i> Add member</button>
    <div id="memCode"></div>
    <div id="memList"></div></div>`;
  document.body.appendChild(m);
  window._randomPin = randomPin;

  onSnapshot(collection(db, 'apartments', UID, 'members'), s => {
    MEMBERS = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => String(a.flatId).localeCompare(String(b.flatId), undefined, { numeric: true }));
    renderMembers();
    dedupeMembers();
  }, e => console.error(e));
}

function fillMemberForm() {
  const sel = document.getElementById('mmFlat'); if (!sel) return;
  document.getElementById('memCode').innerHTML = '';
  const keep = sel.value;
  sel.innerHTML = [...flats.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map(f => `<option value="${_esc(f)}">${_esc(f)}${flats.get(f)?.owner ? ' — ' + _esc(flats.get(f).owner) : ''}</option>`).join('');
  if (keep && flats.has(keep)) sel.value = keep;
  document.getElementById('mmPin').value = randomPin();
  window._memPick();
}
// Pre-fill name and mobile from the flat's existing resident details
window._memPick = () => {
  const f = flats.get(document.getElementById('mmFlat').value) || {};
  document.getElementById('mmName').value = f.owner || '';
  document.getElementById('mmMobile').value = String(f.phone || '').replace(/\D/g, '').slice(-10);
};

// Shows the code once, right after Add / Reset. It is never stored, so it cannot be viewed later.
function showCodeOnce(name, mobile, pin) {
  const el = document.getElementById('memCode'); if (!el) return;
  el.innerHTML = `<div style="background:var(--indigo-bg);border-radius:12px;padding:12px 14px;margin-bottom:14px;display:flex;align-items:center;gap:10px">
    <div style="flex:1"><div style="font-size:12px;font-weight:700">${_esc(name)}: note this code now</div>
    <div style="font-size:18px;font-weight:800;letter-spacing:1px;margin-top:2px">${_esc(mobile)} · ${_esc(pin)}</div>
    <div style="font-size:11px;color:var(--text2);margin-top:2px">Shown only once. It cannot be viewed again later.</div></div>
    <button class="btn btn-white btn-sm" onclick="document.getElementById('memCode').innerHTML=''">Done</button></div>`;
}

function renderMembers() {
  const list = document.getElementById('memList'); if (!list) return;
  const row = r => `<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid var(--border)">
      <div style="flex:1"><div style="font-size:13px;font-weight:700">${_esc(r.name || '—')}</div>
      <div style="font-size:11px;color:var(--text2)">Flat ${_esc(r.flatId)} · ${_esc(r.phone || '')}</div></div>
      <button class="btn btn-white btn-sm" onclick="window._memReset('${_esc(r.id)}')">Reset code</button>
      <button class="btn btn-white btn-sm" onclick="window._memRemove('${_esc(r.id)}')">Remove</button></div>`;
  list.innerHTML = `<div style="font-size:12px;font-weight:700;margin:6px 0 4px">Members (${MEMBERS.length})</div>` +
    (MEMBERS.length ? MEMBERS.map(row).join('') : '<div style="font-size:12px;color:var(--text2);padding:8px 0">No members yet.</div>');
}

// One mobile number = one member. If duplicates exist (e.g. from retries), keep the one that
// the login lookup points to (otherwise the newest) and delete the rest.
async function dedupeMembers() {
  if (_deduping) return;
  const groups = {};
  MEMBERS.forEach(m => { if (m.phone) (groups[m.phone] = groups[m.phone] || []).push(m); });
  const dups = Object.entries(groups).filter(([, g]) => g.length > 1);
  if (!dups.length) return;
  _deduping = true;
  try {
    for (const [phone, g] of dups) {
      let liveEmail = null;
      try { liveEmail = (await getDoc(doc(db, 'phoneLogins', phone))).data()?.email || null; } catch (e) {}
      const keep = g.find(x => x.email === liveEmail) ||
        [...g].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
      for (const x of g) if (x.id !== keep.id) await deleteDoc(doc(db, 'apartments', UID, 'members', x.id));
    }
  } catch (e) { console.error('dedupe', e); }
  finally { _deduping = false; }
}

// Creates the member's sign-in WITHOUT signing the admin out (uses a temporary second Firebase app).
async function provisionMember(flatId, name, mobile, pin) {
  const email = `m${mobile}-${Math.random().toString(36).slice(2, 8)}@gatebook.app`;
  const secApp = initializeApp(app.options, 'sec-' + Date.now());
  try {
    const secAuth = getAuth(secApp), secDb = getFirestore(secApp);
    const cred = await createUserWithEmailAndPassword(secAuth, email, pinToPassword(mobile, pin));
    await updateProfile(cred.user, { displayName: name });
    await _setDoc(doc(secDb, 'users', cred.user.uid), { aptId: UID, flatId, name, role: 'member' });
    await signOut(secAuth);
    return { uid: cred.user.uid, email };
  } finally { await deleteApp(secApp).catch(() => {}); }
}

function memberErr(e, step) {
  const c = e.code || '';
  if (c.includes('permission-denied')) return `Permission denied (${step}). Publish the latest firestore.rules in Firebase.`;
  if (c === 'auth/email-already-in-use') return 'This mobile number already has a login. Use "Reset code" on the member.';
  if (c === 'auth/operation-not-allowed') return 'Email/Password sign-in is not enabled in Firebase.';
  if (c === 'auth/network-request-failed') return 'Network error. Check your internet and try again.';
  return `Could not ${step}: ${c || e.message}`;
}

window._memAdd = async () => {
  const flatId = document.getElementById('mmFlat').value;
  const name = document.getElementById('mmName').value.trim();
  const mobile = document.getElementById('mmMobile').value.trim();
  const pin = normalizePin(document.getElementById('mmPin').value);
  if (!flatId) { toast('Pick a flat.', 'error'); return; }
  if (!name) { toast('Enter the resident name.', 'error'); return; }
  if (!isValidMobile(mobile)) { toast('Enter a 10-digit mobile number.', 'error'); return; }
  if (!isValidPin(pin)) { toast('The code must be 6 letters or digits.', 'error'); return; }
  if (MEMBERS.some(m => m.phone === mobile)) { toast('This mobile number is already added. Use "Reset code" to change its code.', 'error'); return; }
  const btn = document.getElementById('mmAdd'); btn.disabled = true;
  let step = 'check the mobile number';
  try {
    if ((await getDoc(doc(db, 'phoneLogins', mobile))).exists()) { toast('This mobile number is already registered.', 'error'); return; }
    step = 'create the sign-in';
    const { uid, email } = await provisionMember(flatId, name, mobile, pin);
    step = 'save the member';
    await setDoc(doc(db, 'apartments', UID, 'members', uid), { flatId, name, phone: mobile, email, createdAt: new Date().toISOString() });
    step = 'save the mobile lookup';
    await setDoc(doc(db, 'phoneLogins', mobile), { email, aptId: UID });
    document.getElementById('mmPin').value = randomPin(); window._memPick();
    toast(`${name} added ✓`);
    showCodeOnce(name, mobile, pin);
  } catch (e) { console.error('Add member failed at:', step, e); toast(memberErr(e, step), 'error'); }
  finally { btn.disabled = false; }
};

window._memReset = async oldUid => {
  const m = MEMBERS.find(x => x.id === oldUid); if (!m) return;
  const pin = normalizePin(prompt(`New 6-character code for ${m.name}:`, randomPin()) || '');
  if (!pin) return;
  if (!isValidPin(pin)) { toast('The code must be 6 letters or digits.', 'error'); return; }
  let step = 'create the sign-in';
  try {
    const { uid, email } = await provisionMember(m.flatId, m.name, m.phone, pin);
    step = 'save the member';
    await setDoc(doc(db, 'apartments', UID, 'members', uid), { flatId: m.flatId, name: m.name, phone: m.phone, email, createdAt: new Date().toISOString() });
    step = 'remove the old record';
    for (const x of MEMBERS.filter(x => x.phone === m.phone && x.id !== uid)) await deleteDoc(doc(db, 'apartments', UID, 'members', x.id));
    step = 'save the mobile lookup';
    await setDoc(doc(db, 'phoneLogins', m.phone), { email, aptId: UID });
    toast(`Code reset for ${m.name} ✓`);
    showCodeOnce(m.name, m.phone, pin);
  } catch (e) { console.error('Reset code failed at:', step, e); toast(memberErr(e, step), 'error'); }
};

window._memRemove = async uid => {
  const m = MEMBERS.find(x => x.id === uid); if (!m) return;
  if (!confirm(`Remove ${m.name}? They will lose access.`)) return;
  try {
    await deleteDoc(doc(db, 'apartments', UID, 'members', uid));
    await deleteDoc(doc(db, 'phoneLogins', m.phone));
    toast('Member removed');
  } catch (e) { console.error(e); toast('Remove failed.', 'error'); }
};
/* ── Flat member: change own code ── */
function initChangeCode() {
  const right = document.querySelector('.nav-right'); if (!right) return;
  const btn = document.createElement('button');
  btn.className = 'btn btn-white btn-sm'; btn.innerHTML = '<i class="ti ti-key"></i> Change code';
  btn.onclick = () => document.getElementById('ccM').classList.add('open');
  right.insertBefore(btn, right.firstChild);

  const m = document.createElement('div'); m.className = 'mbg'; m.id = 'ccM';
  m.innerHTML = `<div class="modal">
    <div class="mhead">
      <div style="display:flex;align-items:center;gap:12px">
        <div class="micon detail"><i class="ti ti-key"></i></div>
        <div><div class="mtitle">Change your code</div><div class="msub">Choose a new 6-character code (letters and digits)</div></div>
      </div>
      <button class="mclose" onclick="document.getElementById('ccM').classList.remove('open')"><i class="ti ti-x"></i></button>
    </div>
    <div class="fg"><label>Current code</label><input type="password" id="ccOld" maxlength="6" autocapitalize="characters" autocomplete="off"/></div>
    <div class="fg2">
      <div class="fg"><label>New code</label><input type="password" id="ccNew" maxlength="6" autocapitalize="characters" autocomplete="off"/></div>
      <div class="fg"><label>Confirm new code</label><input type="password" id="ccNew2" maxlength="6" autocapitalize="characters" autocomplete="off"/></div>
    </div>
    <button class="btn btn-indigo" id="ccSave" style="width:100%;justify-content:center" onclick="window._changeCode()"><i class="ti ti-check"></i> Save new code</button></div>`;
  document.body.appendChild(m);
}

window._changeCode = async () => {
  const o = normalizePin(document.getElementById('ccOld').value), n = normalizePin(document.getElementById('ccNew').value), n2 = normalizePin(document.getElementById('ccNew2').value);
  if (!isValidPin(o) || !isValidPin(n)) { toast('Codes must be 6 letters or digits.', 'error'); return; }
  if (n !== n2) { toast('The new codes do not match.', 'error'); return; }
  if (n === o) { toast('Choose a different code.', 'error'); return; }
  const btn = document.getElementById('ccSave'); btn.disabled = true;
  try {
    const u = auth.currentUser;
    await reauthenticateWithCredential(u, EmailAuthProvider.credential(u.email, pinToPassword(MY_PHONE, o)));
    await updatePassword(u, pinToPassword(MY_PHONE, n));
    ['ccOld', 'ccNew', 'ccNew2'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('ccM').classList.remove('open');
    toast('Code changed ✓');
  } catch (e) {
    console.error(e);
    toast(e.code === 'auth/invalid-credential' || e.code === 'auth/wrong-password' ? 'Current code is wrong.' : 'Could not change the code. Try again.', 'error');
  } finally { btn.disabled = false; }
};
