// استيراد مكتبات فايربيز لعمال الخدمة
importScripts(
    "https://www.gstatic.com/firebasejs/10.8.1/firebase-app-compat.js",
);
importScripts(
    "https://www.gstatic.com/firebasejs/10.8.1/firebase-messaging-compat.js",
);

// ⚠️ ضع هنا نفس إعدادات فايربيز الموجودة في ملف firebase-config.js الخاص بك
const firebaseConfig = {
    apiKey: "AIzaSyBq-jE1Hi0U9MkYVFCNp37czT8l0po3wBM",
    authDomain: "brainrot-detox.firebaseapp.com",
    projectId: "brainrot-detox",
    storageBucket: "brainrot-detox.firebasestorage.app",
    messagingSenderId: "274779527121",
    appId: "1:274779527121:web:b2f9f556b3e765063572f0",
};

// تهيئة فايربيز في الخلفية
firebase.initializeApp(firebaseConfig);
const messaging = firebase.messaging();

// التقاط الإشعارات وعرضها عندما يكون التطبيق في الخلفية
// messaging.onBackgroundMessage((payload) => {
//     console.log("[firebase-messaging-sw.js] رسالة في الخلفية:", payload);
//     const notificationTitle = payload.notification.title;
//     const notificationOptions = {
//         body: payload.notification.body,
//         icon: "/images/icon-512.png", // تأكد أن هذا المسار للوجو صحيح
//         badge: "/images/icon-512.png",
//         dir: "rtl",
//     };
//     self.registration.showNotification(notificationTitle, notificationOptions);
// });
