import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js";
import { getMessaging } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-messaging.js"; // السطر الجديد

const firebaseConfig = {
    apiKey: "AIzaSyBq-jE1Hi0U9MkYVFCNp37czT8l0po3wBM",
    authDomain: "brainrot-detox.firebaseapp.com",
    projectId: "brainrot-detox",
    storageBucket: "brainrot-detox.firebasestorage.app",
    messagingSenderId: "274779527121",
    appId: "1:274779527121:web:b2f9f556b3e765063572f0",
};

// تهيئة التطبيق
export const app = initializeApp(firebaseConfig);

// تصدير الخدمات
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app); // تم إضافة خدمة التخزين
export const messaging = getMessaging(app); // تم إضافة خدمة المراسلة
