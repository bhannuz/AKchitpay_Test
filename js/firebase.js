// ═══════════════════════════════════════════════════════════
// AK Chit Funds — FIREBASE CONFIG
// ═══════════════════════════════════════════════════════════

const firebaseConfig = {
    apiKey: "AIzaSyCqb7gAbpa3UabPU3g_YhNITuPWtWPY4KU",
    authDomain: "ak-events-2016.firebaseapp.com",
    projectId: "ak-events-2016",
    storageBucket: "ak-events-2016.firebasestorage.app",
    messagingSenderId: "78066764444",
    appId: "1:78066764444:web:5bb9e0d48c128a8632fb59"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

// ── Shared globals (used across ALL js files) ──
let ALL_MEMBERS = [];
let CURRENT_USER = null;  // ← THIS WAS MISSING — caused all the errors
