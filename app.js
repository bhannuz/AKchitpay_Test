// ═══════════════════════════════════════════════════════════
// AK Chit Funds — app.js (Script Loader)
// CDN libs load in <head>. This loads only app JS files in strict order.
// Change BUILD_VER on every deploy to bust browser cache.
// ═══════════════════════════════════════════════════════════
(function(){
    var BUILD_VER = '20260320_v6';

    var scripts = [
        'js/firebase.js',
        'js/helpers.js',
        'js/ui.js',
        'js/ledger.js',
        'js/members.js',
        'js/groups.js',
        'js/payments.js',
        'js/backup.js',
        'js/planner.js',
        'js/print.js',
        'js/auth.js',
        'js/quickview.js',
        'js/qr.js',
        'js/init.js'
    ];

    function loadNext(i){
        if(i >= scripts.length) return;
        var s   = document.createElement('script');
        s.src   = scripts[i] + '?v=' + BUILD_VER;
        s.onload  = function(){ loadNext(i + 1); };
        s.onerror = function(){ console.error('Failed: ' + scripts[i]); loadNext(i + 1); };
        document.head.appendChild(s);
    }

    loadNext(0);
})();
