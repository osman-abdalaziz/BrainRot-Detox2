const CACHE_NAME = "detox-v1";
const ASSETS = [
    "/",
    "/index.html",
    "/css/style.css",
    "/js/dashboard.js",
    "/images/logo.png",
    "/images/freeze.png",
    "/images/todo.png",
    "/images/double.png",
];

// تخزين الملفات عند التثبيت
self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)),
    );
});

// استدعاء الملفات من الكاش بدلاً من الشبكة
self.addEventListener("fetch", (event) => {
    event.respondWith(
        caches
            .match(event.request)
            .then((response) => response || fetch(event.request)),
    );
});
