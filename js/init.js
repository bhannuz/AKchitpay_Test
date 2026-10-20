// ═══════════════════════════════════════════════════════════
// AK Chit Funds — INIT
// ═══════════════════════════════════════════════════════════

(function(){
    // Set today's date in payment form
    var pDate = document.getElementById('pDate');
    if(pDate) pDate.value = new Date().toISOString().split('T')[0];

    // Patch switchTab to trigger tab-specific hooks
    var origSwitchTab = switchTab;
    window.switchTab = function(t){
        origSwitchTab(t);
        if(t === 'backup'){
            if(typeof loadEmailConfigToForm  === 'function') loadEmailConfigToForm();
            if(typeof updateBackupStatusUI   === 'function') updateBackupStatusUI();
            // Default to Statistics sub-tab and load data
            if(typeof switchBackupSubTab === 'function') switchBackupSubTab('stats');
        }
        if(t === 'planner'){
            if(typeof ncpRestoreSession === 'function') ncpRestoreSession();
        }
    };

    // Start the app
    if(typeof migrateData === 'function') setTimeout(migrateData, 800);

    // Migrate old memberCommitments records that lack slotNum field
    // Assigns slotNum=1 explicitly so slot-based filtering works correctly
    setTimeout(async function(){
        if(typeof db === 'undefined') return;
        try {
            var snap = await db.collection('memberCommitments').get();
            var batch = db.batch();
            var count = 0;
            snap.docs.forEach(function(doc){
                var data = doc.data();
                if(data.slotNum == null || data.slotNum === undefined){
                    batch.update(doc.ref, { slotNum: 1 });
                    count++;
                }
            });
            if(count > 0){
                await batch.commit();
                if(typeof bustCache === 'function') bustCache('memberCommitments');
                console.log('[Migration] Fixed slotNum on', count, 'commitment record(s)');
            }
        } catch(e){ console.warn('[Migration] commitment slotNum:', e); }
    }, 2000);
    if(typeof initAuth    === 'function') initAuth();

    // Poll for new access requests every 15s
    setInterval(function(){
        if(CURRENT_USER && CURRENT_USER.role === 'admin' && typeof pollPendingRequests === 'function'){
            pollPendingRequests();
        }
    }, 15000);
})();
