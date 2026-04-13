const CACHE_NAME = "detox-v1";
const ASSETS = [
    "/",
    "/index.html",
    "/css/style.css",
    "/js/dashboard.js",
    "/images/logo.webp",
    "/images/freeze.webp",
    "/images/todo.webp",
    "/images/double.webp",
];

// تخزين الملفات عند التثبيت
self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)),
    );
});

// استدعاء الملفات من الكاش بدلاً من الشبكة (مع استثناء قواعد البيانات)
self.addEventListener("fetch", (event) => {
    // 1. الجدار العازل: تجاهل أي طلبات للـ API أو فايربيز أو أي طلب ليس GET
    const requestUrl = event.request.url;

    if (
        event.request.method !== "GET" ||
        requestUrl.includes("firestore.googleapis.com") ||
        requestUrl.includes("firebaseio.com") ||
        requestUrl.includes("identitytoolkit.googleapis.com") ||
        requestUrl.includes("google.com")
    ) {
        // دع المتصفح يتعامل معها بشكل طبيعي دون تدخل الـ Service Worker
        return;
    }

    // 2. التعامل مع ملفات الموقع العادية (صور، CSS، HTML)
    event.respondWith(
        caches
            .match(event.request)
            .then((response) => {
                return response || fetch(event.request);
            })
            .catch(() => {
                // حماية إضافية لو انقطع النت ولم يجد الملف في الكاش
                return null;
            }),
    );
});
