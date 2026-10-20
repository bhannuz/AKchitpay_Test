// ══════════════════════════════════════════════════════════
// AK Chit Funds — MEMBER CRUD
// Edit only this file when changing create / edit / delete members and enrollments
// ══════════════════════════════════════════════════════════

// MEMBER CRUD
// ══════════════════════════════════════════
function genEnrollId(){ return 'enr_' + Date.now() + '_' + Math.random().toString(36).slice(2,7); }

let _enrollGroupOptions = [];

async function openAddMember(){
    if(!isAdmin()){showToast('🚫 Access denied',false);return;}
    document.getElementById('mName').value='';
    document.getElementById('mPhone').value='';
    document.getElementById('editMemberId').value='';
    document.getElementById('memberModalTitle').textContent='👤 Create Member';
    document.getElementById('deleteMemberArea').style.display='none';
    _enrollGroupOptions = await getCollection('groups');
    document.getElementById('enrollmentList').innerHTML='';
    addEnrollmentRow();
    openModal('memberModal');
}

async function openEditMember(mid){
    if(!isAdmin()){showToast('🚫 Access denied',false);return;}
    const ms=await getCollection('members');
    const m=ms.find(x=>x.id===mid);if(!m)return;
    document.getElementById('editMemberId').value=m.id;
    document.getElementById('mName').value=m.name||'';
    document.getElementById('mPhone').value=m.phone||'';
    document.getElementById('memberModalTitle').textContent='✏️ Edit Member';
    document.getElementById('deleteMemberArea').style.display='block';
    _enrollGroupOptions = await getCollection('groups');
    const list = document.getElementById('enrollmentList');
    list.innerHTML='';

    let enrollments = m.enrollments;
    if(!enrollments || !enrollments.length){
        enrollments = (m.groupIds||[]).map(gid=>({enrollmentId: genEnrollId(), groupId: gid, label:''}));
    }
    enrollments.forEach(e=> addEnrollmentRow(e.groupId, e.label, e.enrollmentId, e.qty||1, e.coMemberId||''));
    openModal('memberModal');
}

function addEnrollmentRow(groupId='', label='', enrollmentId='', qty=1, coMemberId=''){
    const id = enrollmentId || genEnrollId();
    const opts = _enrollGroupOptions.map(g=>`<option value="${g.id}" ${g.id===groupId?'selected':''}>${g.name}</option>`).join('');
    const row = document.createElement('div');
    row.className = 'enrollment-row';
    row.dataset.enrollmentId = id;
    row.style.cssText='display:flex;gap:6px;align-items:flex-start;flex-wrap:wrap;background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:10px;padding:8px 10px;';
    row.innerHTML=`
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;width:100%;">
            <select class="enr-group form-input" style="flex:3;margin-bottom:0;padding:8px 10px;font-size:0.92rem;">
                <option value="">-- Select Group --</option>${opts}
            </select>
            <div style="flex-shrink:0;display:flex;flex-direction:column;align-items:center;gap:2px;">
                <span style="font-size:0.5rem;color:var(--text-dim);font-weight:700;text-transform:uppercase;white-space:nowrap;">Chits</span>
                <input type="number" class="enr-qty form-input" min="1" max="20" value="${qty||1}"
                    style="width:54px;margin-bottom:0;padding:8px 6px;font-size:1.05rem;text-align:center;font-weight:800;" title="Number of chits this member takes in this group">
            </div>
            <input type="text" class="enr-label form-input" placeholder="Label (e.g. Chit 1)" value="${label}"
                style="flex:2;margin-bottom:0;padding:8px 10px;font-size:0.92rem;" title="Label to distinguish multiple chits in same group">
            <button type="button" onclick="this.closest('.enrollment-row').remove()"
                style="background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.3);color:#f87171;border-radius:8px;padding:6px 10px;font-size:1.05rem;cursor:pointer;flex-shrink:0;">✕</button>
        </div>
        <!-- Joint Member Row -->
        <div style="width:100%;margin-top:4px;">
            <label style="display:flex;align-items:center;gap:7px;cursor:pointer;font-size:0.8rem;font-weight:700;color:var(--text-dim);">
                <input type="checkbox" class="enr-joint-toggle" onchange="toggleJointMember(this)" style="accent-color:#6366f1;width:14px;height:14px;" ${coMemberId?'checked':''}>
                👥 Joint Chit — shared with another member
            </label>
            <div class="enr-joint-wrap" style="display:${coMemberId?'flex':'none'};gap:8px;align-items:center;margin-top:6px;background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.22);border-radius:8px;padding:8px 10px;">
                <span style="font-size:0.8rem;color:#a5b4fc;font-weight:700;white-space:nowrap;">Co-member:</span>
                <select class="enr-co-member form-input" style="flex:1;margin-bottom:0;padding:7px 10px;font-size:0.88rem;">
                    <option value="">-- Select Co-member --</option>
                </select>
                <span style="font-size:0.72rem;color:var(--text-dim);">Both share 1 chit slot</span>
            </div>
        </div>`;
    document.getElementById('enrollmentList').appendChild(row);
    // Populate co-member dropdown async
    populateCoMemberDropdown(row, coMemberId);
}

async function populateCoMemberDropdown(row, selectedId=''){
    const currentMid = document.getElementById('editMemberId').value;
    const ms = await getCollection('members');
    const sel = row.querySelector('.enr-co-member');
    if(!sel) return;
    sel.innerHTML = '<option value="">-- Select Co-member --</option>' +
        ms.filter(m=>m.id!==currentMid).map(m=>`<option value="${m.id}" ${m.id===selectedId?'selected':''}>${m.name}${m.phone?' ('+m.phone+')':''}</option>`).join('');
}

function toggleJointMember(cb){
    const wrap = cb.closest('.enrollment-row').querySelector('.enr-joint-wrap');
    wrap.style.display = cb.checked ? 'flex' : 'none';
}

async function saveMember(){
    if(!isAdmin()){showToast('🚫 Access denied',false);return;}
    const n=document.getElementById('mName').value.trim();
    const p=document.getElementById('mPhone').value.trim();
    const eid=document.getElementById('editMemberId').value;
    if(!n) return showToast('❌ Enter member name',false);

    const rows = document.querySelectorAll('.enrollment-row');
    const enrollments = [];
    const groupIds = [];
    let valid = true;
    rows.forEach(row=>{
        const gid = row.querySelector('.enr-group').value;
        const lbl = row.querySelector('.enr-label').value.trim();
        const eid2 = row.dataset.enrollmentId;
        if(!gid){ valid=false; return; }
        const qty = parseInt(row.querySelector('.enr-qty')?.value)||1;
        const jointToggle = row.querySelector('.enr-joint-toggle');
        const coMemberSel = row.querySelector('.enr-co-member');
        const coMemberId = (jointToggle&&jointToggle.checked&&coMemberSel) ? (coMemberSel.value||'') : '';
        enrollments.push({enrollmentId:eid2, groupId:gid, label:lbl, qty, ...(coMemberId?{coMemberId}:{})});
        if(!groupIds.includes(gid)) groupIds.push(gid);
    });
    if(!valid || enrollments.length===0) return showToast('❌ Select a group for each enrollment row',false);

    const data = {name:n, phone:p, enrollments, groupIds};
    let memberId = eid;
    if(eid) await db.collection('members').doc(eid).update(data);
    else { const ref = await db.collection('members').add(data); memberId = ref.id; }
    bustCache('members');

    closeModal('memberModal');
    showToast('✅ Member "' + n + '" saved with ' + enrollments.length + ' enrollment' + (enrollments.length!==1?'s':'') + '!');
    updateUI();
}

function deleteMemberFromModal(){
    const eid=document.getElementById('editMemberId').value;if(!eid)return;
    const name=document.getElementById('mName').value;
    showConfirm('🗑','Delete Member?',`This will permanently delete "${name}" and ALL their payment records.`,async()=>{
        const pays=await db.collection('payments').where('memberId','==',eid).get();
        const batch=db.batch();
        pays.docs.forEach(d=>batch.delete(d.ref));
        await batch.commit();
        await db.collection('members').doc(eid).delete();
        bustCache('members');bustCache('payments');
        closeModal('memberModal');
        if(document.getElementById('summaryView').value===eid){
            document.getElementById('summaryView').value='';
            document.getElementById('summarySearch').value='';
            document.getElementById('ledgerData').innerHTML='';
        }
        showToast('🗑 Member & all payments deleted');updateUI();
    });
}

// ══════════════════════════════════════════
