// ═══════════════════════════════════════════════════════════
// AK Chit Funds — HELPERS & DATE UTILS
// Edit only this file when changing shared utilities, date helpers, due date logic
// ═══════════════════════════════════════════════════════════

// HELPERS
// ══════════════════════════════════════════
const _dbCache = {};
let _cacheTs = {};
const CACHE_TTL = 60000;

async function getCollection(col, forceRefresh=false){
    const now = Date.now();
    if(!forceRefresh && _dbCache[col] && (now - (_cacheTs[col]||0)) < CACHE_TTL){
        return _dbCache[col];
    }
    const s = await db.collection(col).get();
    _dbCache[col] = s.docs.map(d=>({id:d.id,...d.data()}));
    _cacheTs[col] = now;
    return _dbCache[col];
}

function bustCache(col){ delete _dbCache[col]; delete _cacheTs[col]; }
function fmtDate(d){if(!d)return"—";const[y,m,day]=d.split("-");const months=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];const mName=months[parseInt(m,10)-1]||m;return`${day}.${mName}.${y}`;}
function fmtDateObj(d){if(!d)return"—";const months=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];const dd=String(d.getDate()).padStart(2,"0");return`${dd}.${months[d.getMonth()]}.${d.getFullYear()}`; }
function fmtAmt(v){return'₹'+(parseFloat(v)||0).toLocaleString('en-IN');}
function ini(n){return(n||'?').split(' ').map(x=>x[0]||'').join('').toUpperCase().slice(0,2)||'??';}
function isAdmin(){ return CURRENT_USER && CURRENT_USER.role === 'admin'; }
function guardAdmin(fn){ return function(...args){ if(!isAdmin()){ showToast('🚫 Access denied',false); return; } return fn(...args); }; }

function openModal(id){document.getElementById(id).style.display='block';}
function closeModal(id){document.getElementById(id).style.display='none';}

function toggleChitPickedName(){document.getElementById('chitPickedNameDiv').style.display=document.getElementById('pChitPicked').value==='Yes'?'block':'none';}

function clearMemberSearch(){
    document.getElementById('summarySearch').value='';
    document.getElementById('summaryView').value='';
    document.getElementById('summaryList').style.display='none';
    document.getElementById('ledgerData').innerHTML='';
    updateUI();
}

function showToast(msg,ok=true){
    const t=document.createElement('div');
    t.style.cssText=`position:fixed;top:20px;left:50%;transform:translateX(-50%);background:${ok?'#10b981':'#ef4444'};color:white;padding:12px 24px;border-radius:12px;font-weight:700;font-size:13px;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.4);white-space:nowrap;`;
    t.textContent=msg;document.body.appendChild(t);setTimeout(()=>t.remove(),3000);
}

function showConfirm(icon,title,msg,onOk){
    document.getElementById('confirmIcon').textContent=icon;
    document.getElementById('confirmTitle').textContent=title;
    document.getElementById('confirmMsg').textContent=msg;
    document.getElementById('confirmOkBtn').onclick=()=>{closeModal('confirmModal');onOk();};
    openModal('confirmModal');
}

// ══════════════════════════════════════════

// DUE DATE HELPERS
// ══════════════════════════════════════════
function getGroupDueDates(group){
    const start=group.startDate||group.gStart;
    if(!start) return[];
    const totalMonths=parseInt(group.duration||group.gDuration)||21;
    const dueDay=parseInt(group.dueDay)||new Date(start).getDate();
    const s=new Date(start+'T00:00:00');
    const startYear=s.getFullYear();
    const startMonth=s.getMonth();
    const pad=n=>String(n).padStart(2,'0');
    const dates=[];
    for(let i=0;i<totalMonths;i++){
        const yr=startYear+Math.floor((startMonth+i)/12);
        const mo=(startMonth+i)%12;
        const maxDay=new Date(yr,mo+1,0).getDate();
        const day=Math.min(dueDay,maxDay);
        dates.push(`${yr}-${pad(mo+1)}-${pad(day)}`);
    }
    return dates;
}

function getMonthSlot(dueDates, payDate){
    if(!dueDates.length) return -1;
    if(payDate<dueDates[0]) return 0;
    for(let i=0;i<dueDates.length;i++){
        const nextDue=dueDates[i+1]||'9999-99-99';
        if(payDate>=dueDates[i]&&payDate<nextDue) return i;
    }
    return dueDates.length-1;
}

// ══════════════════════════════════════════

// ── QR Section toggle ─────────────────────────────────────────────────────────
function toggleQrSection() {
    const body    = document.getElementById('qrSectionBody');
    const chevron = document.getElementById('qrSectionChevron');
    if(!body) return;
    const open = body.style.display === 'none' || body.style.display === '';
    body.style.display    = open ? 'block' : 'none';
    if(chevron) chevron.style.transform = open ? 'rotate(90deg)' : '';
}
