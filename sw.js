// sw.js
const CACHE_VERSION = "v63"; // 🛑 تم رفع الإصدار لإجبار الأجهزة على حذف النسخة القديمة
const CACHE_NAME = `brainrot-cache-${CACHE_VERSION}`;

const CORE_FILES = [
    "/",
    "/index.html",
    "/dashboard.html",
    "/images/logo.webp",
    "/images/favicon.webp",
];

self.addEventListener("install", (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(CORE_FILES).catch((err) => {
                console.warn("فشل كاش بعض الملفات:", err);
            });
        }),
    );
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        Promise.all([
            caches.keys().then((cacheNames) => {
                return Promise.all(
                    cacheNames
                        .filter((name) => name !== CACHE_NAME)
                        .map((name) => caches.delete(name)),
                );
            }),
            self.clients.claim(),
        ]),
    );
});

self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);

    // تجاهل الفايربيز والـ APIs
    if (
        url.hostname.includes("firebase") ||
        url.hostname.includes("google") ||
        url.hostname.includes("googleapis") ||
        url.hostname.includes("pixabay") ||
        url.hostname.includes("cdnjs") ||
        url.hostname.includes("jsdelivr") ||
        event.request.method !== "GET"
    ) {
        return;
    }

    if (
        url.pathname.endsWith(".js") ||
        url.pathname.endsWith(".css") ||
        url.pathname.endsWith(".html")
    ) {
        event.respondWith(networkFirstStrategy(event.request));
        return;
    }

    if (url.pathname.match(/\.(webp|png|jpg|jpeg|svg|ico)$/)) {
        event.respondWith(cacheFirstStrategy(event.request));
        return;
    }

    event.respondWith(networkFirstStrategy(event.request));
});

async function networkFirstStrategy(request) {
    try {
        const networkResponse = await fetch(request);
        if (networkResponse.ok) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, networkResponse.clone());
        }
        return networkResponse;
    } catch (error) {
        const cachedResponse = await caches.match(request);
        if (cachedResponse) return cachedResponse;
        return new Response("لا يوجد اتصال بالإنترنت", {
            status: 503,
            statusText: "Service Unavailable",
        });
    }
}

async function cacheFirstStrategy(request) {
    const cachedResponse = await caches.match(request);
    if (cachedResponse) return cachedResponse;

    try {
        const networkResponse = await fetch(request);
        if (networkResponse.ok) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, networkResponse.clone());
        }
        return networkResponse;
    } catch (error) {
        return new Response("", { status: 404 });
    }
}

self.addEventListener("message", (event) => {
    if (event.data === "SKIP_WAITING") {
        self.skipWaiting();
    }
});
