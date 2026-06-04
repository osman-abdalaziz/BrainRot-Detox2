import { auth, db, storage, messaging, app } from "./firebase-config.js";
import {
    getFunctions,
    httpsCallable,
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-functions.js";
import dailyQuestions from "./daily-questions.js?v=2";
import {
    getToken,
    onMessage,
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-messaging.js";
import {
    onAuthStateChanged,
    signOut,
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import {
    doc,
    getDoc,
    collection,
    getDocs,
    setDoc,
    updateDoc,
    increment,
    query,
    orderBy,
    deleteDoc,
    arrayUnion,
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import {
    ref,
    uploadBytes,
    getDownloadURL,
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js";
// قم بإضافة هذا السطر في أعلى ملف dashboard.js
import { rtdb } from "./firebase-config.js";
import {
    ref as dbRef,
    set,
    push,
    onValue,
    serverTimestamp,
    remove,
    update,
    onDisconnect,
    get as rtdbGet,
    off,
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
const functions = getFunctions(app);
let activeRoomId = null; // رقم الغرفة الحالية
let activeRoomListener = null; // رادار الغرفة (لكي نقتله عند الخروج)
let roomTimerInterval = null; // محرك الوقت (لكي نوقفه عند الخروج)
let hasAnnouncedCompletion = false; // لمنع تكرار صوت النجاح والتنبيه عند المزامنة
let lastPlayedPhaseId = null; // يمنع تكرار الأصوات عند تحديث الداتا بيز
// إنعاش التطبيق الإجباري في أجهزة iOS عند العودة من الخلفية
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
        // إذا كان المستخدم غائباً لفترة طويلة ورجع، قد يكون الاتصال قد مات
        if (!navigator.onLine) {
            CustomDialog.alert(
                "انقطع الاتصال بالإنترنت، يرجى التأكد من الشبكة.",
                "تنبيه شبكة ⚠️",
            );
        }
    }
});
// ==============================
// 🛡️ سد ثغرة السحب للخلف في iOS (Bfcache)
// ==============================
window.addEventListener("pageshow", function (event) {
    if (event.persisted) {
        window.location.reload();
    }
});
// ==============================
// النظام الحواري الذكي (Custom Dialog)
// ==============================
window.CustomDialog = {
    show: function ({ type, title, message, defaultValue = "" }) {
        return new Promise((resolve) => {
            const overlay = document.createElement("div");
            overlay.className = "custom-dialog-overlay";
            const box = document.createElement("div");
            box.className = "glass-card custom-dialog-box";

            let html = `
                <h3 class="dialog-title">${title || "تنبيه"}</h3>
                <p class="dialog-message">${message}</p>
            `;

            if (type === "prompt") {
                html += `<input type="text" id="dialog-input" class="dialog-input" value="${defaultValue}" autocomplete="off">`;
            }

            html += `<div class="dialog-buttons">`;
            if (type !== "alert") {
                html += `<button id="dialog-cancel" class="dialog-btn-cancel">إلغاء</button>`;
            }
            html += `<button id="dialog-ok" class="gold-btn dialog-btn-confirm">${type === "alert" ? "حسناً" : "تأكيد"}</button>`;
            html += `</div>`;

            box.innerHTML = html;
            overlay.appendChild(box);
            document.body.appendChild(overlay);

            setTimeout(() => overlay.classList.add("show"), 10);
            if (type === "prompt")
                setTimeout(
                    () => document.getElementById("dialog-input").focus(),
                    100,
                );

            const closeDialog = (returnValue) => {
                overlay.classList.remove("show");
                setTimeout(() => {
                    document.body.removeChild(overlay);
                    resolve(returnValue);
                }, 300);
            };

            document
                .getElementById("dialog-ok")
                .addEventListener("click", () => {
                    if (type === "prompt")
                        closeDialog(
                            document.getElementById("dialog-input").value,
                        );
                    else closeDialog(true);
                });

            if (type !== "alert") {
                document
                    .getElementById("dialog-cancel")
                    .addEventListener("click", () => {
                        closeDialog(type === "prompt" ? null : false);
                    });
            }
        });
    },
    alert: function (msg, title = "تنبيه") {
        return this.show({ type: "alert", message: msg, title });
    },
    confirm: function (msg, title = "تأكيد الإجراء") {
        return this.show({ type: "confirm", message: msg, title });
    },
    prompt: function (msg, defaultVal = "", title = "إدخال بيانات") {
        return this.show({
            type: "prompt",
            message: msg,
            defaultValue: defaultVal,
            title,
        });
    },
};

// ==============================
// 🛡️ نظام مزامنة الوقت الفائق (Google Edge Servers)
// لا للغش، لا للبطء!
// ==============================
let serverTimeAtLoad = null;
let performanceAtLoad = null;

async function syncTime() {
    try {
        // خدعة عبقرية: جلب التوقيت من سيرفر موقعك نفسه (فايربيز/جوجل)
        // هذا الاتصال يستغرق مللي ثواني ولا يمكن حظره برمجياً
        const response = await fetch(window.location.href.split("#")[0], {
            method: "HEAD",
            cache: "no-store",
        });
        const serverDateStr = response.headers.get("Date");

        if (serverDateStr) {
            serverTimeAtLoad = new Date(serverDateStr).getTime();
            console.log("تمت مزامنة الوقت من سيرفرات جوجل بسرعة البرق ⚡🛡️");
        } else {
            throw new Error("No Date Header");
        }
    } catch (error) {
        console.error("فشل التحقق من التوقيت الحقيقي. لا يوجد إنترنت.");
        serverTimeAtLoad = null; // 🛑 نمنع استخدام وقت الموبايل نهائياً
    }
    performanceAtLoad = performance.now();
}

// هذه الدالة هي الوحيدة المسؤولة عن إعطائنا الوقت في كل الكود
function getRealNow() {
    // 1. نظام الحماية الصارم (Fail-Secure)
    if (serverTimeAtLoad === null) {
        // لو الطالب فصل النت ولعب في الساعة، الكود هينفجر في وشه ويرفض يشتغل
        CustomDialog.alert(
            "لا يمكن التحقق من التوقيت الحقيقي! يرجى التأكد من اتصالك بالإنترنت وعدم التلاعب بساعة الجهاز.",
            "خطأ أمني 🛑",
        );
        throw new Error("Anti-Cheat Triggered: No secure time available.");
    }

    // 2. إذا كان كل شيء سليماً، نحسب الوقت الحقيقي
    const elapsed = performance.now() - performanceAtLoad;
    return new Date(serverTimeAtLoad + elapsed);
}

// دالة صارمة لتحويل أي وقت إلى تاريخ بتوقيت القاهرة حصراً (YYYY-MM-DD)
function getCairoDateString(dateObj) {
    return dateObj.toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
}

let currentUser = null;
let currentCycle = 1; // الدورة الأسبوعية الحالية
let dailyTargetPoints = 0;
let isTodayFinalized = false;

onAuthStateChanged(auth, async (user) => {
    if (user) {
        // 1. مزامنة الوقت الحقيقي أولاً قبل أي شيء!
        await syncTime();

        currentUser = user;
        const userDocRef = doc(db, "users", user.uid);
        const userDoc = await getDoc(userDocRef);
        if (!userDoc.exists()) {
            window.location.href = "index.html";
            return;
        }

        const userData = userDoc.data();
        updateProfileUI(userData);
        // جلب الهدف اليومي (سنحتفظ بهذا المستند كإعدادات عامة فقط)
        const challengeDoc = await getDoc(
            doc(db, "settings", "currentChallenge"),
        );
        if (challengeDoc.exists()) {
            dailyTargetPoints = challengeDoc.data().dailyTargetPoints || 100;
        } else {
            dailyTargetPoints = 100;
        }

        // جلب رقم الدورة الأسبوعية الحالية من السيرفر
        const sysDoc = await getDoc(doc(db, "configs", "system"));
        if (sysDoc.exists()) {
            currentCycle = sysDoc.data().currentCycle || 1;
        }

        // إخفاء نافذة الانضمام القديمة نهائياً
        const joinModal = document.getElementById("join-challenge-modal");
        if (joinModal)
            joinModal.style.setProperty("display", "none", "important");

        // الدخول المباشر للمعركة للجميع
        await processActiveParticipant(userData, userDocRef);
        await checkAndCelebrateBadges(userData, userDocRef);

        loadLeaderboard();
        loadAnalytics();
        applyZoneUI(userData.currentZone || "green");
        const loader = document.getElementById("global-loader");
        if (loader) loader.classList.add("hidden");
        window.syncUserUI();
        // إخفاء شاشة التحميل بنعومة بعد الانتهاء من تجهيز وتحديث كل الواجهات
    } else window.location.href = "index.html";
});

// ==========================================
// 🎉 محرك الاحتفال الأسطوري (صندوق الهدايا + تخطي حظر الصوت)
// ==========================================
async function checkAndCelebrateBadges(userData, userDocRef) {
    const allBadges = userData.badges || [];
    if (allBadges.length === 0) return;

    const celebratedIds = userData.celebratedBadgeIds || [];
    const newBadges = allBadges.filter((b) => !celebratedIds.includes(b.id));

    if (newBadges.length > 0) {
        const container = document.getElementById("new-badges-container");
        const overlay = document.getElementById("badge-celebration-overlay");
        const giftBox = document.getElementById("badge-gift-box");
        const revealContent = document.getElementById("badge-reveal-content");
        const glowBg = document.getElementById("epic-glow-bg");
        const openBtn = document.getElementById("open-gift-btn");
        const closeBtn = document.getElementById("close-celebration-btn");

        if (!container || !overlay || !openBtn) return;

        // تجهيز شكل الأوسمة للظهور لاحقاً
        container.innerHTML = newBadges
            .map(
                (badge) => `
            <div style="background: rgba(30, 20, 50, 0.6); border: 1px solid #eab308; padding: 20px 15px; border-radius: 16px; width: 130px; text-align: center; box-shadow: 0 0 20px rgba(234, 179, 8, 0.2); animation: floatBadge 3s ease-in-out infinite;">
                <img src="${badge.imagePath || badge.icon || "images/badge.webp"}" alt="Badge" style="width: 80px; height: 80px; object-fit: contain; margin-bottom: 12px; filter: drop-shadow(0 0 15px rgba(234,179,8,0.8));">
                <h4 style="font-size: 14px; color: #fef08a; margin: 0; line-height: 1.5; font-weight: bold; text-shadow: 0 2px 4px rgba(0,0,0,0.8);">${badge.title}</h4>
            </div>
        `,
            )
            .join("");

        // إعادة ضبط الشاشات: إظهار الصندوق المغلق وإخفاء الاحتفال
        giftBox.style.display = "block";
        revealContent.style.display = "none";
        glowBg.style.display = "none";
        overlay.style.display = "flex";
        overlay.style.opacity = "1";
        overlay.style.visibility = "visible";
        let fireworkInterval = null;

        // 🛑 السر هنا: يتم تفعيل الصوت والألعاب النارية فقط بعد "النقرة"
        openBtn.onclick = () => {
            // 1. إخفاء الصندوق وإظهار التوهج والأوسمة
            giftBox.style.display = "none";
            revealContent.style.display = "block";
            glowBg.style.display = "block";

            // إضافة حركة الدخول للنافذة الجديدة
            revealContent.style.animation =
                "epicDrop 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards";

            // 2. تشغيل الصوت (سيعمل 100% الآن لأنه تم بناءً على تفاعل Click)
            const epicSound = new Audio("../audios/tadaaa.mp3");
            epicSound.volume = 0.8;
            epicSound
                .play()
                .catch((e) =>
                    console.log("الصوت محظور إعدادات جهاز المستخدم:", e),
                );

            // 3. تشغيل الألعاب النارية الذهبية
            const duration = 5000;
            const animationEnd = Date.now() + duration;
            const defaults = {
                startVelocity: 30,
                spread: 360,
                ticks: 60,
                zIndex: 9999999,
                colors: ["#eab308", "#facc15", "#fef08a", "#ffffff"],
            };

            function randomInRange(min, max) {
                return Math.random() * (max - min) + min;
            }

            fireworkInterval = setInterval(function () {
                const timeLeft = animationEnd - Date.now();
                if (timeLeft <= 0) return clearInterval(fireworkInterval);

                const particleCount = 50 * (timeLeft / duration);
                confetti(
                    Object.assign({}, defaults, {
                        particleCount,
                        origin: {
                            x: randomInRange(0.1, 0.3),
                            y: Math.random() - 0.2,
                        },
                    }),
                );
                confetti(
                    Object.assign({}, defaults, {
                        particleCount,
                        origin: {
                            x: randomInRange(0.7, 0.9),
                            y: Math.random() - 0.2,
                        },
                    }),
                );
            }, 250);
        };

        // تحديث الداتابيز لكي لا يظهر الاحتفال مجدداً في الأجهزة الأخرى
        const newIds = newBadges.map((b) => b.id);
        await updateDoc(userDocRef, {
            celebratedBadgeIds: arrayUnion(...newIds),
        });

        // إغلاق الشاشة بالكامل عند الضغط على الاستلام
        closeBtn.onclick = () => {
            overlay.style.display = "none";
            if (fireworkInterval) clearInterval(fireworkInterval);
        };
    }
}

function updateProfileUI(userData) {
    const firstName = userData.name.split(" ")[0];
    document.getElementById("welcome-text").innerText =
        `مرحباً يا ${firstName}`;
    document.getElementById("nav-user-name").innerText = userData.name;
    document.getElementById("profile-name-input").value = userData.name;
    const userAvatarUrl = userData.photoURL || "images/profile.webp";
    document.getElementById("nav-avatar").src = userAvatarUrl;
    document.getElementById("profile-avatar-preview").src = userAvatarUrl;

    // إظهار علامة مضاعف النقاط لو كان مفعلاً
    const doubleXpTag = document.getElementById("double-xp-tag");
    if (doubleXpTag) {
        doubleXpTag.style.display = userData.hasDoubleXP ? "block" : "none";
    }

    // --- النظام الجديد: الرتبة تعتمد على السكور التراكمي ---
    const rankClass = getRankFrameClass(userData.lifetimeScore || 0);
    document.getElementById("nav-avatar-wrapper").className =
        `avatar-wrapper ${rankClass}`;
    document.getElementById("profile-avatar-wrapper").className =
        `avatar-wrapper ${rankClass}`;

    // ==============================
    // تفعيل شارة الستريك في الشريط العلوي (من النظام الجديد)
    // ==============================
    const streak = userData.currentStreak || 0;
    const streakEl = document.getElementById("nav-user-streak");
    if (streakEl) {
        if (streak > 0) {
            streakEl.style.display = "inline-flex";
            streakEl.innerHTML = `<i class="fa-solid fa-fire fa-fw"></i> ${streak}`;
        } else {
            streakEl.style.display = "none";
        }
    }

    // --- تعديل لإظهار علامة التجميد ---
    const hasFreeze = userData.freezeCount > 0;
    const freezeEl = document.getElementById("nav-user-freeze");
    if (freezeEl) {
        if (hasFreeze) freezeEl.style.display = "inline-flex";
        else freezeEl.style.display = "none";
    }

    // --- النظام الجديد: عرض محفظة العملات (Coins) في الأعلى بدلاً من النقاط القديمة ---
    const coins = userData.walletCoins || 0;
    const pointsEl = document.getElementById("nav-user-points");
    if (pointsEl) {
        pointsEl.style.display = "inline-flex";
        pointsEl.innerHTML = `${coins} <i class="fa-solid fa-wallet fa-fw"></i>`;
    }

    // ==============================
    // 🛑 نظام إغلاق المتجر بسبب الديون (Debt Lock)
    // ==============================
    const storeDebtBanner = document.getElementById("store-debt-banner");
    const storeBtns = document.querySelectorAll(".store-item .gold-btn");

    if (coins < 0) {
        if (storeDebtBanner) {
            storeDebtBanner.style.display = "block";
            storeDebtBanner.innerHTML = `⚠️ أنت مديون للنظام بـ <span style="font-size: 22px;">${Math.abs(coins)}</span> عملة.<br> التزم بمهامك اليومية لتسديد ديون التخاذل قبل أن تتمكن من شراء أي عتاد مجدداً.`;
        }
        // تعطيل جميع أزرار المتجر بهدوء
        storeBtns.forEach((btn) => {
            btn.disabled = true;
            btn.style.opacity = "0.4";
            btn.style.cursor = "not-allowed";
        });
    } else {
        if (storeDebtBanner) storeDebtBanner.style.display = "none";
        // إعادة تفعيل الأزرار إذا تم سداد الدين
        storeBtns.forEach((btn) => {
            btn.disabled = false;
            btn.style.opacity = "1";
            btn.style.cursor = "pointer";
        });
    }

    const badgesContainer = document.getElementById("badges-container");
    if (userData.badges && userData.badges.length > 0) {
        badgesContainer.innerHTML = "";

        // ترتيب الأوسمة بحيث يظهر الأحدث أولاً
        const sortedBadges = [...userData.badges].sort(
            (a, b) => new Date(b.date) - new Date(a.date),
        );

        sortedBadges.forEach((badge) => {
            const dateStr = new Date(badge.date).toLocaleDateString("en-GB"); // صيغة DD/MM/YYYY
            const imgPath =
                badge.imagePath || badge.icon || "images/badge.webp"; // التوافق مع القديم والجديد

            badgesContainer.innerHTML += `
            <div style="background: rgba(168, 85, 247, 0.1); border: 1px solid var(--border-color); padding: 15px; border-radius: 12px; width: 130px; text-align: center; box-shadow: 0 4px 15px rgba(0,0,0,0.2);">
                <div style="display: flex; justify-content: center; align-items: center; font-size: 35px; margin-bottom: 10px; text-shadow: 0 0 10px var(--gold-glow);">
                    <img src="${imgPath}" alt="${badge.title}" style="width: 80px; height: 80px; object-fit: contain; filter: drop-shadow(0 4px 6px rgba(0,0,0,0.4));">
                </div>
                <h4 style="font-size: 13px; color: var(--text-main); margin-bottom: 5px; line-height: 1.3;">${badge.title}</h4>
                <span style="font-size: 11px; color: var(--gold-primary); font-weight: bold;">${dateStr}</span>
            </div>`;
        });
    }
    // ==============================
    // فحص صلاحية مفكرة المهام الحرة
    // ==============================
    const todoLink = document.getElementById("nav-todo-link");
    const storeTodoBtn = document.getElementById("store-todo-btn");

    if (userData.hasTodoList) {
        if (todoLink) todoLink.style.display = "block"; // إظهارها في القائمة الجانبية
        if (storeTodoBtn) {
            storeTodoBtn.innerText = "إلغاء الأداة"; // تغيير النص)";
            storeTodoBtn.classList.add("delete-todo-btn"); // تغيير اللون إلى الأحمر
            storeTodoBtn.style.background = "rgba(244, 63, 94, 0.2)"; // أحمر شفاف
            storeTodoBtn.style.borderColor = "var(--danger)";
            storeTodoBtn.style.color = "var(--danger)";
        }
    } else {
        if (todoLink) todoLink.style.display = "none"; // إخفاؤها
        if (storeTodoBtn) {
            storeTodoBtn.classList.remove("delete-todo-btn"); // تغيير اللون إلى الأحمر
            // الحل القطعي: تصفير الألوان الملتصقة ليعود الزر لشكله الذهبي الطبيعي
            storeTodoBtn.style.background = "";
            storeTodoBtn.style.borderColor = "";
            storeTodoBtn.style.color = "";
            storeTodoBtn.innerHTML = `شراء (150 <i class="fa-solid fa-coins fa-fw"></i>)`;
        }
    }

    // ==============================
    // تحديث شارة الرتبة والتقدم (النظام الجديد)
    // ==============================
    const lifetimeScore = userData.lifetimeScore || 0;
    const rankDetails = getRankDetails(lifetimeScore);

    const titleEl = document.getElementById("profile-rank-title");
    const scoreEl = document.getElementById("profile-lifetime-score");
    const progressEl = document.getElementById("profile-rank-progress");
    const nextRankTextEl = document.getElementById("profile-next-rank-text");
    const nextRankNameEl = document.getElementById("profile-next-rank-name");

    if (titleEl) titleEl.innerHTML = rankDetails.title;
    if (scoreEl) scoreEl.innerText = `${lifetimeScore} XP`;

    if (rankDetails.nextGoal) {
        const progressRange = rankDetails.nextGoal - rankDetails.currentBase;
        const currentProgress = lifetimeScore - rankDetails.currentBase;
        const percentage = Math.min(
            100,
            Math.max(0, (currentProgress / progressRange) * 100),
        );

        if (progressEl) progressEl.style.width = `${percentage}%`;
        if (nextRankTextEl)
            nextRankTextEl.innerHTML = `متبقي : <span style="direction: ltr; display: inline-flex; flex-direction: row;">${rankDetails.nextGoal - lifetimeScore} XP</span>`;
        if (nextRankNameEl)
            nextRankNameEl.innerHTML = `${rankDetails.nextTitle} <i class="fa-solid fa-lock fa-fw" style="font-size: 10px;"></i>`;
    } else {
        // حالة الوصول لأعلى رتبة (أسطورة)
        if (progressEl) progressEl.style.width = `100%`;
        if (nextRankTextEl)
            nextRankTextEl.innerText = `وصلت لأعلى قمة في المعسكر 🏆`;
        if (nextRankNameEl) nextRankNameEl.innerText = "";
    }
}

function applyZoneUI(zone) {
    const banner = document.getElementById("zone-warning-banner");
    const normalTasksContainer = document.getElementById("tasks-list");
    const submitDayBtn = document.getElementById("submit-day-btn");
    const unchainingContainer = document.getElementById(
        "unchaining-task-container",
    );
    const dopamineCard = document.getElementById("dopamine-analyzer-card"); // 🛑 تم إضافة البطاقة

    if (!banner) return;

    // تصفير الحالات الافتراضية للواجهة
    document.body.classList.remove("red-zone");
    banner.className = "zone-alert";
    banner.innerHTML = "";

    if (unchainingContainer) unchainingContainer.style.display = "none";
    if (normalTasksContainer) normalTasksContainer.style.display = "block";
    if (submitDayBtn) submitDayBtn.style.display = "block";
    if (dopamineCard) dopamineCard.style.display = "block"; // 🛑 إظهار افتراضي

    if (zone === "yellow") {
        banner.classList.add("yellow");
        banner.innerHTML =
            "⚠️ <b>إنذار أصفر:</b> لقد فشلت بالأمس وتم تصفير الستريك. أثبت جديتك اليوم لتخرج من هنا.";
    } else if (zone === "red") {
        document.body.classList.add("red-zone");
        banner.classList.add("red");
        banner.innerHTML =
            "🛑 <b>أنت في المنطقة الحمراء:</b> لقد انهار الستريك. تم حجب المهام والمتجر والمتصدرين. أنجز مهمة فك القيود للعودة.";

        // إخفاء المهام العادية وزر الاعتماد، وإظهار واجهة فك القيود
        if (normalTasksContainer) normalTasksContainer.style.display = "none";
        if (submitDayBtn) submitDayBtn.style.display = "none";
        if (dopamineCard) dopamineCard.style.display = "none"; // 🛑 إخفاء وقت العقاب
        if (unchainingContainer) unchainingContainer.style.display = "block";

        // الطرد من الصفحات المحظورة
        const activePage = document.querySelector(".page-section.active");
        if (
            activePage &&
            (activePage.id === "leaderboard-page" ||
                activePage.id === "store-page")
        ) {
            document.querySelector('[data-target="tasks-page"]').click();
        }
    }
}

// function renderRegistrationPhase(isJoined) {
//     const container = document.querySelector(".tasks-container");
//     const infoBox = document.getElementById("challenge-info");
//     infoBox.innerHTML = `<h2 style="color: var(--gold-primary); text-align: center; margin-bottom: 10px;">⏳ يوم التسجيل مفتوح</h2><p style="text-align: center; font-size: 18px;">تحدي: <strong>${currentChallengeData.title}</strong></p><p style="text-align: center; color: var(--text-muted);">المدة: ${currentChallengeData.durationDays} أيام | الهدف اليومي: ${currentChallengeData.dailyTargetPoints} نقطة</p>`;
//     if (isJoined)
//         container.innerHTML = `<div style="text-align: center; padding: 40px;"><h3 style="color: var(--success); font-size: 24px;">✅ أنت مسجل ومستعد!</h3><p style="color: var(--text-muted); margin-top: 10px;">سيتم فتح المهام بمجرد أن يطلق الإدمن إشارة البدء. استعد.</p></div>`;
//     else {
//         container.innerHTML = `<div style="text-align: center; padding: 30px; background: rgba(168, 85, 247, 0.1); border: 1px dashed var(--gold-primary); border-radius: 12px;"><h3 style="margin-bottom: 15px;">التسجيل متاح الآن</h3><p style="margin-bottom: 20px; color: var(--text-muted);">إذا لم تنضم الآن، فلن تتمكن من الدخول بعد بدء التحدي.</p><button id="join-challenge-btn" class="gold-btn" style="width: auto; padding: 12px 40px; font-size: 18px;">انضمام للتحدي بقوة 🔥</button></div>`;
//         document
//             .getElementById("join-challenge-btn")
//             .addEventListener("click", joinChallenge);
//     }
// }

// async function joinChallenge() {
//     const btn = document.getElementById("join-challenge-btn");
//     btn.disabled = true;
//     btn.innerText = "جاري التسجيل...";
//     try {
//         await updateDoc(doc(db, "users", currentUser.uid), {
//             joinedChallengeId: currentChallengeData.challengeId,
//             challengeStatus: "active",
//             streak: 0, // تصفير الستريك مع التحدي الجديد
//         });
//         window.syncUserUI();
//     } catch (error) {
//         await CustomDialog.alert("حدث خطأ أثناء الانضمام.", "خطأ");
//         btn.disabled = false;
//     }
// }

// function renderSpectatorState(displayDays) {
//     document.getElementById("challenge-info").style.display = "none";
//     document.querySelector(".tasks-container").innerHTML =
//         `<div style="text-align: center; padding: 40px; background: rgba(0,0,0,0.2); border-radius: 16px; border: 1px solid var(--border-color);"><h2 style="color: var(--text-muted); font-size: 28px;">التحدي جاري حالياً 🔒</h2><p style="margin-top: 15px; font-size: 18px;">لقد فوتّ يوم التسجيل في تحدي <strong style="color: var(--gold-primary);">${currentChallengeData.title}</strong> (${currentChallengeData.durationDays} أيام).</p><div style="margin: 25px auto; padding: 20px; background: rgba(168, 85, 247, 0.1); border: 1px dashed var(--gold-primary); border-radius: 12px; display: inline-block;"><p style="font-size: 16px; margin: 0; color: var(--text-main);">الوقت المتبقي لانتهاء التحدي وبدء تسجيل جديد:</p><p style="font-size: 32px; font-weight: bold; color: var(--gold-primary); margin: 5px 0 0 0;">${displayDays} <span style="font-size: 16px;">أيام</span></p></div><p style="margin-top: 10px; font-size: 16px; color: var(--text-muted);">يجب عليك الانتظار حتى ينتهي التحدي الحالي للانضمام.</p></div>`;
// }

// function renderFailedState(displayDays) {
//     document.getElementById("challenge-info").style.display = "none";
//     document.querySelector(".tasks-container").innerHTML =
//         `<div style="text-align: center; padding: 40px; background: rgba(244, 63, 94, 0.1); border: 1px solid var(--danger); border-radius: 16px;"><h1 style="color: var(--danger); font-size: 40px; text-shadow: 0 0 20px rgba(244,63,94,0.5);">💀 GAME OVER 💀</h1><p style="margin-top: 15px; font-size: 18px;">لقد فشلت في التحدي الحالي وتم إقصاؤك.</p><div style="margin: 25px auto; padding: 20px; background: rgba(0,0,0,0.3); border-radius: 12px; display: inline-block;"><p style="font-size: 16px; margin: 0; color: var(--text-muted);">الوقت المتبقي لانتهاء فترة عقوبتك:</p><p style="font-size: 32px; font-weight: bold; color: var(--danger); margin: 5px 0 0 0;">${displayDays} <span style="font-size: 16px;">أيام</span></p></div><p style="margin-top: 10px; color: var(--text-muted);">رصيدك ونقاطك محفوظة، لكنك ستبقى متفرجاً حتى يتم إعلان تحدٍ جديد.</p></div>`;
// }

// function renderNoChallengeState() {
//     document.getElementById("challenge-info").style.display = "none";
//     document.querySelector(".tasks-container").innerHTML =
//         `<div style="text-align: center; padding: 50px;"><h2 style="color: var(--text-muted);">لا يوجد تحدي نشط حالياً. خذ قسطاً من الراحة واستعد للمعركة القادمة.</h2></div>`;
// }

async function processActiveParticipant(userData, userDocRef) {
    // تحديث الرأسية الديناميكية
    const titleEl = document.getElementById("challenge-title");
    if (titleEl)
        titleEl.innerHTML = `🏆 الدورة التنافسية رقم: <span style="color: var(--gold-primary); font-size: 24px;">${currentCycle}</span>`;

    const targetEl = document.getElementById("daily-target");
    if (targetEl) targetEl.innerText = dailyTargetPoints;

    // إخفاء ملاحظة "طوق النجاة" القديمة إن وجدت
    const costEl = document.getElementById("life-saver-cost");
    if (costEl) {
        const noteEl =
            costEl.closest(".challenge-note") || costEl.parentElement;
        if (noteEl) noteEl.style.display = "none";
    }

    // 1. جلب المهام الإجبارية (النشطة فقط)
    const importantRelTaskIds = [];
    const relSnap = await getDocs(query(collection(db, "religiousTasks")));
    relSnap.forEach((d) => {
        if (d.data().isImportant && d.data().isActive !== false)
            importantRelTaskIds.push(d.id);
    });

    const importantNormTaskIds = [];
    const normSnap = await getDocs(query(collection(db, "tasks")));
    normSnap.forEach((d) => {
        if (d.data().isImportant && d.data().isActive !== false)
            importantNormTaskIds.push(d.id);
    });

    const realNow = getRealNow();
    const todayStr = getCairoDateString(realNow);

    const yesterdayDate = new Date(realNow);
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterdayStr = getCairoDateString(yesterdayDate);

    // سقف التقييم هو دائماً "البارحة"، التحدي لا ينتهي أبداً
    const limitStr = yesterdayStr;

    if (!userData.lastEvalDate) {
        await updateDoc(userDocRef, { lastEvalDate: yesterdayStr });
        userData.lastEvalDate = yesterdayStr;
    }
    let currentEvalDateStr = userData.lastEvalDate;

    // 2. المنقذ الذكي (التقييم بأثر رجعي)
    if (currentEvalDateStr < limitStr) {
        let currentStreak = userData.currentStreak || 0;
        let walletCoins = userData.walletCoins || 0;
        let lifetimeScore = userData.lifetimeScore || 0;
        let cycleScore = userData.cycleScore || 0;
        let currentZone = userData.currentZone || "green";
        let freezeCount = userData.freezeCount || 0;

        let parts = currentEvalDateStr.split("-");
        let evalDate = new Date(parts[0], parts[1] - 1, parts[2]);
        evalDate.setDate(evalDate.getDate() + 1);

        let limitParts = limitStr.split("-");
        let limitDate = new Date(
            limitParts[0],
            limitParts[1] - 1,
            limitParts[2],
        );
        let messages = [];

        while (evalDate <= limitDate) {
            const dateStr = getCairoDateString(evalDate);
            const logRef = doc(
                db,
                `users/${currentUser.uid}/dailyLogs`,
                dateStr,
            );
            const logSnap = await getDoc(logRef);

            let pointsEarned = 0;
            let selections = {};
            let religiousSelections = {};
            let isLogFinalized = false;
            let passedByServer = false;

            if (logSnap.exists()) {
                const logData = logSnap.data();
                pointsEarned = logData.pointsEarned || 0;
                selections = logData.selections || {};
                religiousSelections = logData.religiousSelections || {};
                isLogFinalized = logData.isFinalized || false;
                passedByServer = logData.passed || false;
            }

            // الفحص القاطع للمهام الدينية الإجبارية (بالصيغة الجديدة + التوافق العكسي)
            let missingRel = false;
            for (let id of importantRelTaskIds) {
                let sel = religiousSelections[id];
                let isDone = false;

                if (typeof sel === "boolean") {
                    isDone = sel; // الأيام القديمة
                } else if (Array.isArray(sel)) {
                    if (sel.length > 1 || (sel.length === 1 && sel[0] !== 0))
                        isDone = true; // التشيك ليست الجديدة
                } else {
                    if (sel > 0) isDone = true; // القائمة المنسدلة الجديدة
                }

                if (!isDone) {
                    missingRel = true;
                    break;
                }
            }

            let missingNorm = false;
            for (let id of importantNormTaskIds) {
                let sel = selections[id];
                let isDone = false;
                if (Array.isArray(sel)) {
                    if (sel.length > 1 || (sel.length === 1 && sel[0] !== 0))
                        isDone = true;
                } else {
                    if (sel > 0) isDone = true;
                }
                if (!isDone) {
                    missingNorm = true;
                    break;
                }
            }

            let passedToday = isLogFinalized
                ? passedByServer
                : pointsEarned >= dailyTargetPoints &&
                  !missingRel &&
                  !missingNorm;

            if (passedToday) {
                currentStreak++;
                if (currentZone === "yellow") currentZone = "green";

                // 🛑 حساب المضاعف
                let streakMultiplier = 1.0;
                if (currentStreak >= 21) streakMultiplier = 2.0;
                else if (currentStreak >= 14) streakMultiplier = 1.6;
                else if (currentStreak >= 7) streakMultiplier = 1.4;
                else if (currentStreak >= 3) streakMultiplier = 1.2;

                const multipliedPoints = Math.floor(
                    pointsEarned * streakMultiplier,
                );
                let earnedCoins = Math.floor(multipliedPoints / 1.5);
                let earnedXP = multipliedPoints;
                let xpLabel = "";

                if (userData.hasDoubleXP) {
                    earnedXP *= 2;
                    userData.hasDoubleXP = false;
                    userData.usedDoubleXP = true;
                    xpLabel = " ⚡";
                }

                lifetimeScore += earnedXP;
                walletCoins += earnedCoins;
                cycleScore += multipliedPoints;

                // 🛑 تحديث متغير المضاعف ليتم حفظه لاحقاً في الـ updates
                userData.currentMultiplier = streakMultiplier;

                let multiMsg =
                    streakMultiplier > 1 ? `(مضاعف x${streakMultiplier}) ` : "";
                messages.push(
                    `✅ يوم ${dateStr}: تم الاعتماد بنجاح ${multiMsg}(+${earnedXP} XP${xpLabel}) | الستريك: <i class="fa-solid fa-fire fa-fw"></i>${currentStreak}`,
                );

                await setDoc(
                    logRef,
                    {
                        passed: true,
                        isFinalized: true,
                        pointsEarned,
                        date: dateStr,
                        selections,
                        religiousSelections,
                        timestamp: getRealNow(),
                    },
                    { merge: true },
                );
            } else {
                if (freezeCount > 0) {
                    freezeCount--;
                    messages.push(
                        `❄️ يوم ${dateStr}: تم استخدام "تجميد الستريك"! تم حماية الستريك.`,
                    );
                    await setDoc(
                        logRef,
                        {
                            passed: false,
                            isFinalized: true,
                            pointsEarned,
                            date: dateStr,
                            timestamp: getRealNow(),
                        },
                        { merge: true },
                    );
                } else {
                    currentStreak = 0;
                    if (currentZone === "green") currentZone = "yellow";
                    else if (currentZone === "yellow") currentZone = "red";

                    // 🛑 خصم الغرامة الديناميكية والسماح بالديون (السالب)
                    const penaltyCoins = Math.floor(dailyTargetPoints / 2);
                    walletCoins -= penaltyCoins;

                    messages.push(
                        `⚠️ يوم ${dateStr}: فشلت! انكسر الستريك 💔 وتم خصم ${penaltyCoins} عملة كغرامة 📉 | حالتك الآن: ${currentZone === "yellow" ? "منطقة صفراء ⚠️" : "منطقة حمراء 🛑"}`,
                    );

                    await setDoc(
                        logRef,
                        {
                            passed: false,
                            isFinalized: true,
                            pointsEarned,
                            date: dateStr,
                            selections,
                            religiousSelections,
                            timestamp: getRealNow(),
                        },
                        { merge: true },
                    );
                }
            }
            currentEvalDateStr = dateStr;
            evalDate.setDate(evalDate.getDate() + 1);
        }

        let updates = {
            lifetimeScore,
            walletCoins,
            currentStreak,
            cycleScore,
            currentZone,
            freezeCount,
            currentMultiplier: userData.currentMultiplier || 1,
            lastEvalDate: currentEvalDateStr,
        };
        if (userData.usedDoubleXP) {
            updates.hasDoubleXP = false;
            updates.usedDoubleXP = true;
        }

        await updateDoc(userDocRef, updates);

        const loader = document.getElementById("global-loader");
        if (loader) loader.classList.add("hidden");

        if (messages.length > 0) {
            await CustomDialog.alert(
                "تقرير المنقذ الذكي للأيام الفائتة:\n\n" + messages.join("\n"),
                "المنقذ الذكي 🤖",
            );
        }
    }

    // 3. جلب بيانات اليوم الحالي للمهام
    const todayLogSnap = await getDoc(
        doc(db, `users/${currentUser.uid}/dailyLogs`, todayStr),
    );
    let todayLogData = null;
    if (todayLogSnap.exists()) {
        todayLogData = todayLogSnap.data();
        document.getElementById("today-points").innerText =
            todayLogData.pointsEarned || 0;
        isTodayFinalized = todayLogData.isFinalized || false;
    }

    const loader = document.getElementById("global-loader");
    if (loader) loader.classList.add("hidden");

    if (typeof checkNiyyahReminder === "function") {
        await checkNiyyahReminder(userData);
    }

    loadTasks(todayLogData, userData);
    startDoomsdayClock();
    startCycleCountdown();
    renderDailyTrivia(userData);
    loadReligiousTasks(todayLogData);
}

async function loadTasks(todayLogData, userData) {
    const tasksList = document.getElementById("tasks-list");
    // tasksList.innerHTML = "";

    const q = query(collection(db, "tasks"), orderBy("order", "asc"));
    const querySnapshot = await getDocs(q);

    const groupedTasks = {};
    window.importantNormalTaskIds = []; // تصفير مصفوفة المهام الدنيوية

    // --- منطق الرتب الجديد: المختبر والآدمن يرون كل شيء، العادي يرى النشط فقط ---
    const canSeeHidden =
        userData && (userData.role === "admin" || userData.role === "tester");

    querySnapshot.forEach((docSnap) => {
        const task = docSnap.data();
        const taskId = docSnap.id;
        if (task.isImportant && task.isActive !== false) {
            window.importantNormalTaskIds.push(taskId);
        }
        // تظهر المهمة إذا كانت نشطة، أو إذا كان المستخدم يملك صلاحية الرؤية
        if (task.isActive || canSeeHidden) {
            const cat = task.category || "مهام عامة";
            if (!groupedTasks[cat]) groupedTasks[cat] = [];

            // إضافة وسم تمييز للمهام المخفية لكي يعرف التيستر أنها تحت الاختبار
            const displayTask = { id: taskId, ...task };
            if (!task.isActive)
                displayTask.name = `[إصدار تجريبي] ${task.name}`;

            groupedTasks[cat].push(displayTask);
        }
    });

    tasksList.innerHTML = "";

    // رسم المهام مرتبة تحت أقسامها
    for (const [category, tasks] of Object.entries(groupedTasks)) {
        const catHeader = document.createElement("h4");
        catHeader.className = "gold-text";
        catHeader.style.cssText =
            "margin: 25px 0 15px 0; border-bottom: 1px dashed var(--gold-primary); padding-bottom: 5px; font-size: 18px;";
        catHeader.innerText = category;
        tasksList.appendChild(catHeader);

        tasks.forEach((task) => {
            const taskDiv = document.createElement("div");
            taskDiv.className = "task-item";
            taskDiv.style.flexDirection = "column";
            taskDiv.style.alignItems = "flex-start";

            let savedSel = 0;
            if (
                todayLogData &&
                todayLogData.selections &&
                todayLogData.selections[task.id] !== undefined
            ) {
                savedSel = todayLogData.selections[task.id];
            }

            if (task.isMultiSelect) {
                // ==========================================
                // 📝 رسم نظام الاختيار المتعدد (Checklists)
                // ==========================================
                let selectionsForTask = Array.isArray(savedSel)
                    ? savedSel
                    : [savedSel];

                let checkboxesHtml = `<div class="checklist-container" data-task-id="${task.id}" style="width: 100%; margin-top: 10px;">`;
                if (task.options && task.options.length > 0) {
                    task.options.forEach((opt, index) => {
                        const isChecked = selectionsForTask.includes(index);
                        const checkedAttr = isChecked ? "checked" : "";
                        const borderColor = isChecked
                            ? "var(--gold-primary)"
                            : "var(--border-color)";
                        const textColor = isChecked
                            ? "var(--gold-primary)"
                            : "var(--text-main)";
                        let optPoint = "+";
                        if (opt.points < 0) {
                            optPoint = "";
                        }
                        checkboxesHtml += `
                        <label class="checklist-item" style="display:flex; align-items:center; gap:10px; margin-bottom:8px; cursor:pointer; background: rgba(0,0,0,0.2); padding: 10px 15px; border-radius: 8px; border: 1px solid ${borderColor}; transition: 0.2s;">
                            <input type="checkbox" class="task-checkbox" data-index="${index}" value="${opt.points}" ${checkedAttr} style="accent-color: var(--gold-primary); width: 18px; height: 18px; cursor: pointer; margin: 0;">
                            <span class="checklist-text" style="font-size: 14px; color: ${textColor}; transition: 0.2s;">${opt.name} <strong style="color:var(--text-muted); font-size:12px;">(${optPoint}${opt.points})</strong></span>
                        </label>`;
                    });
                }
                checkboxesHtml += `</div>`;
                taskDiv.innerHTML = `<span style="font-size: 16px; font-weight: bold; color: var(--gold-primary);">${task.name}</span> <span style="font-size:11px; color:var(--text-muted); font-weight:normal; margin-top:3px;">(يمكنك اختيار أكثر من خيار معاً)</span>${checkboxesHtml}`;
                tasksList.appendChild(taskDiv);
            } else {
                // ==========================================
                // 🔄 رسم نظام القائمة المنسدلة العادي (Select)
                // ==========================================
                let selectedIndex = Array.isArray(savedSel)
                    ? savedSel[0]
                    : savedSel; // توافق عكسي

                let nativeSelectHtml = `<select class="task-select hidden-select" data-task-id="${task.id}" style="display:none;">`;
                let customOptionsHtml = "";
                let selectedText = "";

                if (task.options && task.options.length > 0) {
                    task.options.forEach((opt, index) => {
                        const isSelected =
                            index === selectedIndex ? "selected" : "";
                        let optPoint = "+";
                        if (opt.points < 0) {
                            optPoint = "";
                        }
                        const optText = `${opt.name} (${optPoint}${opt.points})`;
                        if (index === selectedIndex) selectedText = optText;
                        nativeSelectHtml += `<option value="${opt.points}" data-index="${index}" ${isSelected}>${optText}</option>`;
                        customOptionsHtml += `<span class="custom-option ${isSelected}" data-value="${opt.points}" data-index="${index}">${optText}</span>`;
                    });
                }
                nativeSelectHtml += `</select>`;

                let customSelectHtml = `<div class="custom-select-wrapper">${nativeSelectHtml}<div class="custom-select"><div class="custom-select-trigger"><span class="trigger-text">${selectedText}</span><i class="fa-solid fa-chevron-down"></i></div><div class="custom-options">${customOptionsHtml}</div></div></div>`;
                taskDiv.innerHTML = `<span style="font-size: 16px; font-weight: bold;">${task.name}</span>${customSelectHtml}`;
                tasksList.appendChild(taskDiv);
            }
        });
    }

    initializeCustomSelects();
    initializeChecklists(); // <--- أضف هذا السطر هنا
    if (isTodayFinalized) disableSubmitButton();
    else autoSaveTasks(false);

    setTimeout(startTour, 800);
    if (
        document.getElementById("devices-container") &&
        document.getElementById("devices-container").children.length === 0
    ) {
        window.addDeviceBlock();
    }
}

// ==========================================
// 🕌 رسم وتحديث المهام الدينية (بنظام الخيارات المنسدلة)
// ==========================================
async function loadReligiousTasks(todayLogData) {
    const list = document.getElementById("religious-tasks-list");
    if (!list) return;

    const q = query(collection(db, "religiousTasks"), orderBy("order", "asc"));
    const snap = await getDocs(q);

    list.innerHTML = "";
    window.importantRelTaskIds = [];

    let savedRel =
        todayLogData && todayLogData.religiousSelections
            ? todayLogData.religiousSelections
            : {};

    if (snap.empty) {
        list.innerHTML =
            "<p style='text-align: center; color: var(--text-muted);'>لا توجد مهام حالياً.</p>";
        return;
    }

    snap.forEach((docSnap) => {
        const task = docSnap.data();
        const taskId = docSnap.id;

        if (task.isImportant && task.isActive !== false) {
            window.importantRelTaskIds.push(taskId);
        }

        const badge = task.isImportant
            ? `<span style="font-size: 10px; color: #f59e0b; background: rgba(245, 158, 11, 0.1); padding: 2px 6px; border-radius: 4px; margin-right: 5px;">أساسية إجبارية</span>`
            : `<span style="font-size: 10px; color: #a855f7; background: rgba(168, 85, 247, 0.1); padding: 2px 6px; border-radius: 4px; margin-right: 5px;">إضافية مستحبة</span>`;

        const div = document.createElement("div");
        div.className = task.isImportant ? "task-item important" : "task-item";
        div.style.cssText = task.isImportant
            ? "flex-direction: column; align-items: flex-start; border-color: rgba(245, 158, 11, 0.4);"
            : "flex-direction: column; align-items: flex-start;";

        // توافق عكسي: إذا كان الحفظ القديم true/false نحوله لـ 1 و 0
        let savedSel = 0;
        if (savedRel[taskId] !== undefined) {
            if (typeof savedRel[taskId] === "boolean")
                savedSel = savedRel[taskId] ? 1 : 0;
            else savedSel = savedRel[taskId];
        }

        if (task.isMultiSelect) {
            let selectionsForTask = Array.isArray(savedSel)
                ? savedSel
                : [savedSel];
            let checkboxesHtml = `<div class="rel-checklist-container" data-task-id="${taskId}" style="width: 100%; margin-top: 10px;">`;

            if (task.options && task.options.length > 0) {
                task.options.forEach((opt, index) => {
                    const isChecked = selectionsForTask.includes(index);
                    const checkedAttr = isChecked ? "checked" : "";
                    const borderColor = isChecked
                        ? "var(--gold-primary)"
                        : "var(--border-color)";
                    const textColor = isChecked
                        ? "var(--gold-primary)"
                        : "var(--text-main)";
                    checkboxesHtml += `
                    <label class="rel-checklist-item" style="display:flex; align-items:center; gap:10px; margin-bottom:8px; cursor:pointer; background: rgba(0,0,0,0.2); padding: 10px 15px; border-radius: 8px; border: 1px solid ${borderColor}; transition: 0.2s;">
                        <input type="checkbox" class="rel-task-checkbox" data-index="${index}" ${checkedAttr} ${isTodayFinalized ? "disabled" : ""} style="accent-color: var(--gold-primary); width: 18px; height: 18px; cursor: pointer; margin: 0;">
                        <span class="rel-checklist-text" style="font-size: 14px; color: ${textColor}; transition: 0.2s;">${opt.name}</span>
                    </label>`;
                });
            }
            checkboxesHtml += `</div>`;
            div.innerHTML = `
                <div style="display: flex; flex-direction: column; gap: 3px; width: 100%;">
                    <span style="font-size: 16px; font-weight: bold; color: var(--text-main);">${task.title} ${badge}</span>
                    ${task.note ? `<span style="font-size: 12px; color: var(--text-muted);">${task.note}</span>` : ""}
                </div>
                ${checkboxesHtml}
            `;
        } else {
            let selectedIndex = Array.isArray(savedSel)
                ? savedSel[0]
                : savedSel;
            let nativeSelectHtml = `<select class="rel-task-select hidden-select" data-task-id="${taskId}" style="display:none;" ${isTodayFinalized ? "disabled" : ""}>`;
            let customOptionsHtml = "";
            let selectedText = "";

            if (task.options && task.options.length > 0) {
                task.options.forEach((opt, index) => {
                    const isSelected =
                        index === selectedIndex ? "selected" : "";
                    if (index === selectedIndex) selectedText = opt.name;
                    nativeSelectHtml += `<option data-index="${index}" ${isSelected}>${opt.name}</option>`;
                    customOptionsHtml += `<span class="custom-option ${isSelected}" data-index="${index}">${opt.name}</span>`;
                });
            }
            nativeSelectHtml += `</select>`;

            let customSelectHtml = `<div class="custom-select-wrapper rel-custom-select-wrapper ${isTodayFinalized ? "disabled" : ""}">${nativeSelectHtml}<div class="custom-select"><div class="custom-select-trigger"><span class="trigger-text">${selectedText}</span><i class="fa-solid fa-chevron-down"></i></div><div class="custom-options">${customOptionsHtml}</div></div></div>`;
            div.innerHTML = `
                <div style="display: flex; flex-direction: column; gap: 3px; width: 100%;">
                    <span style="font-size: 16px; font-weight: bold; color: var(--text-main);">${task.title} ${badge}</span>
                    ${task.note ? `<span style="font-size: 12px; color: var(--text-muted);">${task.note}</span>` : ""}
                </div>
                ${customSelectHtml}
            `;
        }
        list.appendChild(div);
    });

    // تفعيل المحركات المنفصلة للمهام الدينية (نفس حركة الدنيوية ولكن بدون نقاط)
    initializeRelCustomSelects();
    initializeRelChecklists();
}

function initializeRelCustomSelects() {
    document
        .querySelectorAll(".rel-custom-select-wrapper")
        .forEach((wrapper) => {
            if (wrapper.classList.contains("disabled")) return;
            const select = wrapper.querySelector(".custom-select");
            const trigger = wrapper.querySelector(".custom-select-trigger");
            const triggerText = wrapper.querySelector(".trigger-text");
            const options = wrapper.querySelectorAll(".custom-option");
            const nativeSelect = wrapper.querySelector(".rel-task-select");
            const taskItemParent = wrapper.closest(".task-item"); // 🛑 تم إضافة الأب هنا

            trigger.addEventListener("click", function (e) {
                if (isTodayFinalized) return;

                // 🛑 إغلاق باقي القوائم المفتوحة وإعادة طبقاتها (z-index) للوضع الطبيعي
                document.querySelectorAll(".custom-select").forEach((s) => {
                    if (s !== select) {
                        s.classList.remove("open");
                        const parent = s.closest(".task-item");
                        if (parent) parent.style.zIndex = "1";
                    }
                });

                const isOpen = select.classList.toggle("open");

                // 🛑 رفع القائمة الحالية فوق كل شيء لتجنب اختفائها تحت المهام الأخرى
                if (taskItemParent) {
                    taskItemParent.style.position = "relative";
                    taskItemParent.style.zIndex = isOpen ? "999" : "1";
                }

                e.stopPropagation();
            });

            options.forEach((option) => {
                option.addEventListener("click", function () {
                    options.forEach((opt) => opt.classList.remove("selected"));
                    this.classList.add("selected");
                    triggerText.textContent = this.textContent;
                    const dataIndex = this.getAttribute("data-index");
                    Array.from(nativeSelect.options).forEach((opt, idx) => {
                        opt.selected = idx == dataIndex;
                    });

                    select.classList.remove("open");

                    // 🛑 إعادة الطبقة للوضع الطبيعي بعد اختيار العنصر
                    if (taskItemParent) taskItemParent.style.zIndex = "1";

                    autoSaveReligiousTasks();
                });
            });
        });
}

function initializeRelChecklists() {
    document
        .querySelectorAll(".rel-checklist-container")
        .forEach((container) => {
            const checkboxes = container.querySelectorAll(".rel-task-checkbox");
            const labels = container.querySelectorAll(".rel-checklist-item");
            const texts = container.querySelectorAll(".rel-checklist-text");

            checkboxes.forEach((cb, idx) => {
                cb.addEventListener("change", function () {
                    if (isTodayFinalized) {
                        this.checked = !this.checked;
                        return;
                    }
                    const clickedIndex = parseInt(
                        this.getAttribute("data-index"),
                    );

                    if (clickedIndex === 0 && this.checked) {
                        checkboxes.forEach((otherCb, otherIdx) => {
                            if (otherIdx !== 0) otherCb.checked = false;
                        });
                    } else if (clickedIndex > 0 && this.checked) {
                        checkboxes[0].checked = false;
                    }

                    checkboxes.forEach((c, i) => {
                        labels[i].style.borderColor = c.checked
                            ? "var(--gold-primary)"
                            : "var(--border-color)";
                        texts[i].style.color = c.checked
                            ? "var(--gold-primary)"
                            : "var(--text-main)";
                    });

                    autoSaveReligiousTasks();
                });
            });
        });
}

async function autoSaveReligiousTasks() {
    if (!currentUser || isTodayFinalized) return;

    let selections = {};

    // سحب الداتا من قوائم Select
    document.querySelectorAll(".rel-task-select").forEach((select) => {
        selections[select.getAttribute("data-task-id")] = parseInt(
            select.options[select.selectedIndex].getAttribute("data-index"),
        );
    });

    // سحب الداتا من التشيك ليست
    document
        .querySelectorAll(".rel-checklist-container")
        .forEach((container) => {
            const taskId = container.getAttribute("data-task-id");
            const checkedBoxes = container.querySelectorAll(
                ".rel-task-checkbox:checked",
            );
            let taskSelections = [];
            checkedBoxes.forEach((cb) =>
                taskSelections.push(parseInt(cb.getAttribute("data-index"))),
            );
            if (taskSelections.length === 0) taskSelections = [0];
            selections[taskId] = taskSelections;
        });

    const realNow = getRealNow();
    const today = getCairoDateString(realNow);
    await setDoc(
        doc(db, `users/${currentUser.uid}/dailyLogs`, today),
        { religiousSelections: selections, timestamp: realNow },
        { merge: true },
    );
}

function initializeCustomSelects() {
    document.querySelectorAll(".custom-select-wrapper").forEach((wrapper) => {
        const select = wrapper.querySelector(".custom-select");
        const trigger = wrapper.querySelector(".custom-select-trigger");
        const triggerText = wrapper.querySelector(".trigger-text");
        const options = wrapper.querySelectorAll(".custom-option");
        const nativeSelect = wrapper.querySelector(".task-select");
        const taskItemParent = wrapper.closest(".task-item");

        trigger.addEventListener("click", function (e) {
            document.querySelectorAll(".custom-select").forEach((s) => {
                if (s !== select) {
                    s.classList.remove("open");
                    const parent = s.closest(".task-item");
                    if (parent) parent.style.zIndex = "1";
                }
            });
            const isOpen = select.classList.toggle("open");
            if (taskItemParent) {
                taskItemParent.style.position = "relative";
                taskItemParent.style.zIndex = isOpen ? "999" : "1";
            }
            e.stopPropagation();
        });

        options.forEach((option) => {
            option.addEventListener("click", function () {
                options.forEach((opt) => opt.classList.remove("selected"));
                this.classList.add("selected");
                triggerText.textContent = this.textContent;
                nativeSelect.value = this.getAttribute("data-value");
                const dataIndex = this.getAttribute("data-index");
                Array.from(nativeSelect.options).forEach((opt, idx) => {
                    opt.selected = idx == dataIndex;
                });
                select.classList.remove("open");
                if (taskItemParent) taskItemParent.style.zIndex = "1";
                autoSaveTasks();
            });
        });
    });

    document.addEventListener("click", function (e) {
        if (!e.target.closest(".custom-select-wrapper")) {
            document.querySelectorAll(".custom-select").forEach((s) => {
                s.classList.remove("open");
                const parent = s.closest(".task-item");
                if (parent) parent.style.zIndex = "1";
            });
        }
    });
}

// ==========================================
// 📱 محرك استهلاك الدوبامين والأجهزة المتعددة (Canvas Merger)
// ==========================================
let deviceCount = 0;

window.addDeviceBlock = function () {
    const container = document.getElementById("devices-container");
    if (!container) return;

    deviceCount++;
    const deviceId = `device-${deviceCount}`;
    const div = document.createElement("div");
    div.className = "device-block";
    div.id = deviceId;
    div.style.cssText =
        "background: rgba(0,0,0,0.2); border: 1px solid var(--border-color); padding: 15px; border-radius: 8px; margin-bottom: 15px; position: relative;";

    // زر الحذف يظهر فقط إذا كان هناك أكثر من جهاز
    const deleteBtnHtml =
        deviceCount > 1
            ? `<button onclick="document.getElementById('${deviceId}').remove()" style="position: absolute; top: 10px; left: 10px; background: none; border: none; color: var(--danger); cursor: pointer; font-size: 16px;"><i class="fa-solid fa-trash"></i></button>`
            : "";

    div.innerHTML = `
        ${deleteBtnHtml}
        <h4 style="color: var(--gold-primary); margin-bottom: 15px; font-size: 14px;">جهاز رقم ${deviceCount}</h4>
        
        <div style="display: flex; gap: 10px; margin-bottom: 15px;">
            <div style="flex: 1;">
                <label style="font-size: 11px; color: var(--text-muted);">إجمالي وقت الشاشة</label>
                <div style="display: flex; gap: 5px; margin-top: 5px;">
                    <input type="number" class="dialog-input st-h" min="0" max="24" placeholder="ساعة" style="margin: 0; text-align: center; padding: 8px; flex: 1;">
                    <span style="display: flex; align-items: center; color: var(--text-muted);">:</span>
                    <input type="number" class="dialog-input st-m" min="0" max="59" placeholder="دقيقة" style="margin: 0; text-align: center; padding: 8px; flex: 1;">
                </div>
            </div>
            <div style="flex: 1;">
                <label style="font-size: 11px; color: var(--text-muted);">منها Shorts/Reels</label>
                <div style="display: flex; gap: 5px; margin-top: 5px;">
                    <input type="number" class="dialog-input sh-h" min="0" max="24" placeholder="ساعة" style="margin: 0; text-align: center; padding: 8px; flex: 1;">
                    <span style="display: flex; align-items: center; color: var(--text-muted);">:</span>
                    <input type="number" class="dialog-input sh-m" min="0" max="59" placeholder="دقيقة" style="margin: 0; text-align: center; padding: 8px; flex: 1;">
                </div>
            </div>
        </div>

        <div>
            <label style="font-size: 12px; color: var(--text-muted); display: block; margin-bottom: 5px;">صورة الإثبات (Screenshot):</label>
            <input type="file" accept="image/*" class="device-proof-file" style="width: 100%; font-size: 12px; padding: 8px; border: 1px dashed var(--border-color); border-radius: 6px; background: rgba(0,0,0,0.3); color: white;">
        </div>
    `;
    container.appendChild(div);
};

// تهيئة أول جهاز عند تحميل المهام
document.addEventListener("DOMContentLoaded", () => {
    // استخدمنا setTimeout لضمان أن DOM جاهز تماماً
    setTimeout(() => {
        if (
            document.getElementById("devices-container") &&
            document.getElementById("devices-container").children.length === 0
        ) {
            window.addDeviceBlock();
        }
        const addBtn = document.getElementById("add-device-btn");
        if (addBtn) addBtn.addEventListener("click", window.addDeviceBlock);
    }, 500);
});

// دالة جمع الوقت من كل الأجهزة المضافة
window.calculateTotalDopamineTime = function () {
    let totalScreenMinutes = 0;
    let totalShortsMinutes = 0;
    let isValid = false; // تصبح true لو أدخل بيانات جهاز واحد على الأقل
    let files = [];

    document.querySelectorAll(".device-block").forEach((block) => {
        const stH = parseInt(block.querySelector(".st-h").value) || 0;
        const stM = parseInt(block.querySelector(".st-m").value) || 0;
        const shH = parseInt(block.querySelector(".sh-h").value) || 0;
        const shM = parseInt(block.querySelector(".sh-m").value) || 0;

        const fileInput = block.querySelector(".device-proof-file");
        if (fileInput && fileInput.files.length > 0) {
            files.push(fileInput.files[0]);
        }

        const deviceScreenMinutes = stH * 60 + stM;
        const deviceShortsMinutes = shH * 60 + shM;

        totalScreenMinutes += deviceScreenMinutes;
        totalShortsMinutes += deviceShortsMinutes;

        // إذا أدخل وقتاً أكبر من صفر، نعتبر الإدخال صالحاً
        if (deviceScreenMinutes > 0) isValid = true;
    });

    return { totalScreenMinutes, totalShortsMinutes, isValid, files };
};

// ==========================================
// 🎨 دالة دمج الصور في صورة بانورامية واحدة
// ==========================================
window.mergeDeviceImagesToCanvas = async function (filesArray) {
    if (filesArray.length === 0) return null;
    if (filesArray.length === 1) return filesArray[0]; // لا ندمج لو كان جهاز واحد

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    // تحويل الملفات إلى كائنات صور (Images)
    const images = await Promise.all(
        filesArray.map((file) => {
            return new Promise((resolve) => {
                const img = new Image();
                img.onload = () => resolve(img);
                img.src = URL.createObjectURL(file);
            });
        }),
    );

    // تحديد العرض المستهدف لكل صورة لضمان جودة منخفضة وحجم صغير للـ AI
    const targetWidth = 500;
    let totalWidth = 0;
    let maxHeight = 0;

    const scaledImages = images.map((img) => {
        const ratio = targetWidth / img.width;
        const height = img.height * ratio;
        totalWidth += targetWidth;
        if (height > maxHeight) maxHeight = height;
        return { img, width: targetWidth, height };
    });

    canvas.width = totalWidth;
    canvas.height = maxHeight;

    // خلفية سوداء (في حال كانت الصور بأطوال مختلفة)
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    let currentX = 0;
    scaledImages.forEach((item, index) => {
        // رسم الصورة
        ctx.drawImage(item.img, currentX, 0, item.width, item.height);

        // رسم شريط علوي يحمل اسم الجهاز لتسهيل قراءة الذكاء الاصطناعي
        ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
        ctx.fillRect(currentX, 0, item.width, 40);
        ctx.fillStyle = "#a855f7";
        ctx.font = "bold 20px Arial";
        ctx.fillText(`Device ${index + 1}`, currentX + 15, 28);

        currentX += item.width;
    });

    // إرجاع النتيجة كملف مضغوط (JPEG)
    return new Promise((resolve) => {
        canvas.toBlob(
            (blob) => {
                resolve(
                    new File([blob], "merged_dopamine_proof.jpg", {
                        type: "image/jpeg",
                    }),
                );
            },
            "image/jpeg",
            0.85,
        );
    });
};

// ==========================================
// 1. دالة حساب النقاط والاختيارات (تمت مراجعتها)
// ==========================================
function getCurrentSelectionsAndPoints() {
    let totalPoints = 0;
    let selections = {};

    document.querySelectorAll(".task-select").forEach((select) => {
        totalPoints += parseInt(select.value) || 0;
        selections[select.getAttribute("data-task-id")] = parseInt(
            select.options[select.selectedIndex].getAttribute("data-index"),
        );
    });

    document.querySelectorAll(".checklist-container").forEach((container) => {
        const taskId = container.getAttribute("data-task-id");
        const checkedBoxes = container.querySelectorAll(
            ".task-checkbox:checked",
        );
        let taskSelections = [];

        checkedBoxes.forEach((cb) => {
            totalPoints += parseInt(cb.value) || 0;
            taskSelections.push(parseInt(cb.getAttribute("data-index")));
        });

        if (taskSelections.length === 0) taskSelections = [0];
        selections[taskId] = taskSelections;
    });

    // الفحص الصارم للمهام الدنيوية الإجبارية
    let missingNormalImportant = false;
    for (let id of window.importantNormalTaskIds || []) {
        let sel = selections[id];
        let isDone = false;

        if (Array.isArray(sel)) {
            if (sel.length > 1 || (sel.length === 1 && sel[0] !== 0))
                isDone = true;
        } else {
            if (sel > 0) isDone = true;
        }

        if (!isDone) {
            missingNormalImportant = true;
            break;
        }
    }

    return { totalPoints, selections, missingNormalImportant };
}

async function autoSaveTasks(saveToDb = true) {
    if (!currentUser || isTodayFinalized) return;
    // let totalPoints = 0;
    // let selections = {};
    // document.querySelectorAll(".task-select").forEach((select) => {
    //     totalPoints += parseInt(select.value);
    //     selections[select.getAttribute("data-task-id")] = parseInt(
    //         select.options[select.selectedIndex].getAttribute("data-index"),
    //     );
    // });
    const { totalPoints, selections } = getCurrentSelectionsAndPoints();
    document.getElementById("today-points").innerText = totalPoints;

    if (saveToDb) {
        const realNow = getRealNow();
        const today = getCairoDateString(realNow); // التعديل هنا
        await setDoc(
            doc(db, `users/${currentUser.uid}/dailyLogs`, today),
            {
                date: today,
                pointsEarned: totalPoints,
                selections: selections,
                isFinalized: false,
                timestamp: realNow,
            },
            { merge: true },
        );
    }
}

// ==========================================
// 2. مستمع زر اعتماد اليوم (النظام الجديد مع تحليل الدوبامين بالـ AI)
// ==========================================
document
    .getElementById("submit-day-btn")
    ?.addEventListener("click", async () => {
        if (!currentUser || isTodayFinalized) return;
        // ==========================================
        // 🛑 جدار الحماية الزمني (مسموح من 9 مساءً وحتى 4 فجراً فقط)
        // ==========================================
        const now = getRealNow();
        const cairoTimeStr = now.toLocaleString("en-US", {
            timeZone: "Africa/Cairo",
            hour12: false,
        });
        const cairoDate = new Date(cairoTimeStr);
        const currentHour = cairoDate.getHours(); // يجلب الساعة من 0 إلى 23

        // إذا لم تكن الساعة أكبر من أو تساوي 21 (9 مساءً) ولم تكن أقل من 4 (فجراً)
        if (!(currentHour >= 21 || currentHour < 4)) {
            return await CustomDialog.alert(
                "لا يمكنك اعتماد مهام اليوم الآن. نافذة التقييم تفتح فقط من الساعة 9:00 مساءً وحتى 4:00 فجراً بتوقيت القاهرة.",
                "نافذة مغلقة 🛑",
            );
        }
        // ==========================================
        // --- 1. التحقق من محلل الدوبامين ---
        const dopamineData = calculateTotalDopamineTime();
        if (!dopamineData.isValid) {
            return await CustomDialog.alert(
                "يجب إدخال وقت الشاشة لجهاز واحد على الأقل لتجاوز الفحص.",
                "تنبيه ⚠️",
            );
        }
        if (dopamineData.files.length === 0) {
            return await CustomDialog.alert(
                "يجب إرفاق صورة إثبات (Screenshot) لوقت الشاشة. لا يمكن المرور بدونها.",
                "إثبات مطلوب 📸",
            );
        }
        const justification = document
            .getElementById("dopamine-justification")
            .value.trim();
        if (!justification) {
            return await CustomDialog.alert(
                "يجب كتابة تبرير لاستهلاكك. كن صادقاً، الذكاء الاصطناعي يحلل كل حرف ولن يتهاون.",
                "التبرير مطلوب ✍️",
            );
        }

        // --- 2. سحب نقاط المهام الدنيوية والدينية ---
        const {
            totalPoints: taskPoints,
            selections,
            missingNormalImportant,
        } = getCurrentSelectionsAndPoints();

        const currentRelSelections = {};
        document.querySelectorAll(".rel-task-select").forEach((s) => {
            currentRelSelections[s.getAttribute("data-task-id")] = parseInt(
                s.options[s.selectedIndex].getAttribute("data-index"),
            );
        });
        document.querySelectorAll(".rel-checklist-container").forEach((c) => {
            let arr = [];
            c.querySelectorAll(".rel-task-checkbox:checked").forEach((cb) =>
                arr.push(parseInt(cb.getAttribute("data-index"))),
            );
            if (arr.length === 0) arr = [0];
            currentRelSelections[c.getAttribute("data-task-id")] = arr;
        });

        let missingRelImportant = false;
        for (let id of window.importantRelTaskIds || []) {
            let sel = currentRelSelections[id];
            let isDone = false;
            if (Array.isArray(sel)) {
                if (sel.length > 1 || (sel.length === 1 && sel[0] !== 0))
                    isDone = true;
            } else {
                if (sel > 0) isDone = true;
            }
            if (!isDone) {
                missingRelImportant = true;
                break;
            }
        }

        // --- 3. الفحص الإجباري وتأكيد الإرسال ---
        if (missingNormalImportant || missingRelImportant) {
            const isSure = await CustomDialog.confirm(
                "لقد تجاهلت مهام إجبارية أساسية. الاعتماد الآن سيؤدي حتماً إلى الفشل وكسر الستريك مهما كانت نقاطك. هل أنت متأكد من هذا التخاذل؟",
                "تحذير صارم 🛑",
            );
            if (!isSure) return;
        } else {
            const confirmSubmit = await CustomDialog.confirm(
                "سيتم الآن دمج صور الأجهزة وإرسالها للقاضي الآلي (Gemini) لتقييم استهلاكك واعتماد اليوم. هل أنت مستعد لمواجهة نتيجتك؟",
                "تحكيم الذكاء الاصطناعي 🤖",
            );
            if (!confirmSubmit) return;
        }

        const btn = document.getElementById("submit-day-btn");
        const originalText = btn.innerText;
        btn.innerText = "القاضي الآلي يحلل بياناتك... 🤖⏳";
        btn.disabled = true;

        try {
            const realNow = getRealNow();
            const today = getCairoDateString(realNow);

            // --- 4. دمج الصور ورفعها للسيرفر ---
            const mergedFile = await window.mergeDeviceImagesToCanvas(
                dopamineData.files,
            );
            const storagePath = `dopamine_proofs/${currentUser.uid}_${Date.now()}.jpg`;
            const storageRefPath = ref(storage, storagePath);
            await uploadBytes(storageRefPath, mergedFile);
            const imageUrl = await getDownloadURL(storageRefPath);

            // --- 5. طلب الحكم من السيرفر السحابي ---
            const evaluateScreenTimeFunc = httpsCallable(
                functions,
                "evaluateScreenTime",
            );
            const aiResult = await evaluateScreenTimeFunc({
                totalScreenMinutes: dopamineData.totalScreenMinutes,
                totalShortsMinutes: dopamineData.totalShortsMinutes,
                justification: justification,
                imageUrl: imageUrl,
            });

            if (!aiResult.data.success) throw new Error("فشل التحليل الذكي.");

            const wastedScreen = aiResult.data.wastedScreenMinutes;
            const wastedShorts = aiResult.data.wastedShortsMinutes;

            // --- 6. تطبيق معادلة الدوبامين العكسية (Capped Linear Decay) ---
            // أقصى نقاط للشاشة: 100 | حد التسامح: 4 ساعات (240 دقيقة)
            let screenPoints = 100 * (1 - wastedScreen / 240);
            if (screenPoints < 0) screenPoints = 0;

            // أقصى نقاط للشورتس: 100 | حد التسامح: 30 دقيقة
            let shortsPoints = 100 * (1 - wastedShorts / 30);
            if (shortsPoints < 0) shortsPoints = 0;

            const dopaminePoints = Math.floor(screenPoints + shortsPoints);
            const finalTotalPoints = taskPoints + dopaminePoints;

            // --- 7. تحديد النجاح الفعلي ---
            const passedToday =
                finalTotalPoints >= dailyTargetPoints &&
                !missingRelImportant &&
                !missingNormalImportant;

            // --- 8. توثيق السجل اليومي ---
            await setDoc(
                doc(db, `users/${currentUser.uid}/dailyLogs`, today),
                {
                    date: today,
                    pointsEarned: finalTotalPoints,
                    selections: selections,
                    religiousSelections: currentRelSelections,
                    passed: passedToday,
                    isFinalized: true,
                    timestamp: realNow,
                    dopamineData: {
                        // حفظ بيانات الدوبامين للإحصائيات المستقبلية
                        reportedScreenMinutes: dopamineData.totalScreenMinutes,
                        reportedShortsMinutes: dopamineData.totalShortsMinutes,
                        justification: justification,
                        proofImageUrl: imageUrl,
                        aiEvaluatedWastedScreen: wastedScreen,
                        aiEvaluatedWastedShorts: wastedShorts,
                        pointsAwarded: dopaminePoints,
                    },
                },
                { merge: true },
            );

            const pointsDisplay = document.getElementById("today-points");
            if (pointsDisplay) pointsDisplay.innerText = finalTotalPoints;

            // --- 9. تحديث الحساب وتطبيق العقوبات أو الجوائز ---
            const userDocRef = doc(db, "users", currentUser.uid);
            const userDocSnap = await getDoc(userDocRef);
            const userDataLocal = userDocSnap.data() || {};

            let currentZone = userDataLocal.currentZone || "green";
            const hasDoubleXP = userDataLocal.hasDoubleXP || false;
            let dbUpdates = { lastEvalDate: today };

            if (passedToday) {
                // حالة النجاح
                const successSound = new Audio(
                    "https://cdn.pixabay.com/download/audio/2021/08/04/audio_0625c1539c.mp3?filename=success-1-6297.mp3",
                );
                successSound.volume = 0.7;
                successSound.play().catch(() => {});

                const end = Date.now() + 3000;
                (function frame() {
                    confetti({
                        particleCount: 5,
                        angle: 60,
                        spread: 55,
                        origin: { x: 0 },
                        colors: ["#a855f7", "#d946ef", "#eab308"],
                        zIndex: 10005,
                    });
                    confetti({
                        particleCount: 5,
                        angle: 120,
                        spread: 55,
                        origin: { x: 1 },
                        colors: ["#a855f7", "#d946ef", "#eab308"],
                        zIndex: 10005,
                    });
                    if (Date.now() < end) requestAnimationFrame(frame);
                })();

                if (currentZone === "yellow") currentZone = "green";

                const newStreak = (userDataLocal.currentStreak || 0) + 1;
                let streakMultiplier = 1.0;
                if (newStreak >= 21) streakMultiplier = 2.0;
                else if (newStreak >= 14) streakMultiplier = 1.6;
                else if (newStreak >= 7) streakMultiplier = 1.4;
                else if (newStreak >= 3) streakMultiplier = 1.2;

                const multipliedPoints = Math.floor(
                    finalTotalPoints * streakMultiplier,
                );
                let earnedCoins = Math.floor(multipliedPoints / 1.5);
                let earnedXP = multipliedPoints;
                let xpLabel = "";
                let streakLabel =
                    streakMultiplier > 1
                        ? `<span style="color:#f97316; display: block; font-size: 14px; margin-top: 5px;">(مضاعف الستريك: x${streakMultiplier} 🔥)</span>`
                        : "";

                dbUpdates.walletCoins = increment(earnedCoins);
                dbUpdates.currentStreak = increment(1);
                dbUpdates.currentZone = currentZone;
                dbUpdates.cycleScore = increment(multipliedPoints);
                dbUpdates.currentMultiplier = streakMultiplier;

                if (hasDoubleXP) {
                    earnedXP *= 2;
                    dbUpdates.lifetimeScore = increment(earnedXP);
                    dbUpdates.hasDoubleXP = false;
                    dbUpdates.usedDoubleXP = true;
                    xpLabel = `<span style="color:#eab308; display: block;">(مضاعف المتجر ⚡)</span>`;
                } else {
                    dbUpdates.lifetimeScore = increment(earnedXP);
                }

                await updateDoc(userDocRef, dbUpdates);
                await CustomDialog.alert(
                    `<span style="display: block;">🔥 تم الاعتماد بنجاح!</span> 
                <span style="font-size: 13px; color: var(--text-muted); display: block; margin-top: 5px;">تقييم القاضي الآلي للدوبامين: +${dopaminePoints} نقطة</span>
                ${streakLabel} ${xpLabel} \n <span><span class="win-info-boxs xp">+${earnedXP} XP</span> <span class="win-info-boxs coins">+${earnedCoins} <i class="fa-solid fa-coins fa-fw"></i></span> <span class="win-info-boxs ">+1 <i class="fa-solid fa-fire fa-fw"></i></span></span>`,
                    "عمل عظيم ",
                );
            } else {
                // حالة الفشل
                const hasFreeze = (userDataLocal.freezeCount || 0) > 0;

                if (hasFreeze) {
                    dbUpdates.freezeCount = increment(-1);
                    await updateDoc(userDocRef, dbUpdates);
                    await CustomDialog.alert(
                        `جمعت ${finalTotalPoints} نقطة فقط. تم استهلاك "تجميد الستريك" ❄️ بنجاح للحماية من السقوط.`,
                        "تفعيل التجميد التلقائي ❄️",
                    );
                } else {
                    if (currentZone === "green") currentZone = "yellow";
                    else if (currentZone === "yellow") currentZone = "red";

                    const penaltyCoins = Math.floor(dailyTargetPoints / 2);
                    dbUpdates.currentStreak = 0;
                    dbUpdates.currentZone = currentZone;
                    dbUpdates.walletCoins = increment(-penaltyCoins);
                    dbUpdates.currentMultiplier = 1.0;

                    await updateDoc(userDocRef, dbUpdates);

                    await CustomDialog.alert(
                        `المجموع ${finalTotalPoints} نقطة (القاضي أعطاك ${dopaminePoints} لدوبامينك). تم اعتماد اليوم كفشل! تصفير الستريك وخصم ${penaltyCoins} عملة ديون. 💔\nأنت الآن في المنطقة: ${currentZone === "yellow" ? "الصفراء ⚠️" : "الحمراء 🛑"}`,
                        "تحذير شديد اللهجة",
                    );
                }
            }

            isTodayFinalized = true;
            window.syncUserUI();
            if (typeof applyZoneUI === "function") applyZoneUI(currentZone);
        } catch (error) {
            console.error(error);
            await CustomDialog.alert(
                "حدث خطأ أثناء تقييم القاضي الآلي: " + error.message,
                "خطأ ⚠️",
            );
            btn.innerText = originalText;
            btn.disabled = false;
        }
    });

function disableSubmitButton() {
    isTodayFinalized = true;
    const btn = document.getElementById("submit-day-btn");
    if (!btn) return;

    // تعطيل زر الإرسال
    btn.disabled = true;
    btn.innerText = "تم اعتماد مهام اليوم 🏆";

    // تعطيل قوائم المهام (الـ Select)
    document.querySelectorAll(".custom-select-wrapper").forEach((wrapper) => {
        wrapper.style.pointerEvents = "none";
        wrapper.style.opacity = "0.5";
    });
    document.querySelectorAll(".task-select").forEach((s) => {
        s.disabled = true;
    });

    // تعطيل مربعات الاختيار (Checklists)
    document
        .querySelectorAll(".task-checkbox")
        .forEach((cb) => (cb.disabled = true));
    document.querySelectorAll(".checklist-item").forEach((lbl) => {
        lbl.style.cursor = "not-allowed";
        lbl.style.opacity = "0.5";
    });

    // 🛑 تجميد محلل الدوبامين بالكامل
    const dopamineCard = document.getElementById("dopamine-analyzer-card");
    if (dopamineCard) {
        dopamineCard.style.pointerEvents = "none";
        dopamineCard.style.opacity = "0.5";
    }
}

document
    .getElementById("logout-btn")
    .addEventListener("click", () =>
        signOut(auth).then(() => window.location.replace("index.html")),
    );

// ==========================================
// قائمة المتصدرين (الستايل القديم الموحد للجميع مع إصلاح محاذاة الأسماء)
// ==========================================
async function loadLeaderboard() {
    const listContainer = document.getElementById("leaderboard-list");
    const podiumContainer = document.getElementById("podium-container");

    // إخفاء حاوية المنصة تماماً بناءً على طلبك
    if (podiumContainer) podiumContainer.style.display = "none";

    try {
        const querySnapshot = await getDocs(collection(db, "users"));
        let usersArray = [];
        querySnapshot.forEach((doc) => {
            usersArray.push(doc.data());
        });

        usersArray = usersArray.filter((u) => u.role !== "tester"); // استبعاد التيستر من المتصدرين

        // 1. خوارزمية الفرز المزدوجة التنافسية (تعتمد على الدورة الأسبوعية)
        usersArray.sort((a, b) => {
            if (currentLeaderboardMode === "challenge") {
                const scoreA = a.cycleScore || 0; // التعديل الجذري: استخدام نقاط الدورة
                const scoreB = b.cycleScore || 0;
                const streakA = a.currentStreak || 0;
                const streakB = b.currentStreak || 0;

                if (scoreA !== scoreB) return scoreB - scoreA;
                if (streakA !== streakB) return streakB - streakA;
            } else {
                const scoreA = a.lifetimeScore || 0;
                const scoreB = b.lifetimeScore || 0;
                if (scoreA !== scoreB) return scoreB - scoreA;
            }

            const nameA = a.name ? a.name.toLowerCase() : "";
            const nameB = b.name ? b.name.toLowerCase() : "";
            return nameA.localeCompare(nameB);
        });

        listContainer.innerHTML = "";

        // 🛑 التعديل الأول: زراعة عنوان ديناميكي يوضح نوع القائمة ورقم الدورة
        if (currentLeaderboardMode === "challenge") {
            listContainer.innerHTML = `
            <div style="text-align: center; margin-bottom: 20px; padding: 12px; background: rgba(168, 85, 247, 0.1); border: 1px dashed var(--gold-primary); border-radius: 12px;">
                <h3 style="color: var(--gold-primary); font-size: 16px; margin: 0;">🏆 ساحة المعركة - الدورة رقم (${currentCycle})</h3>
                <p style="font-size: 12px; color: var(--text-muted); margin: 5px 0 0 0;">هذه القائمة تحدد أبطال الأسبوع وتُصَفَّر كل يوم سبت</p>
            </div>`;
        } else {
            listContainer.innerHTML = `
            <div style="text-align: center; margin-bottom: 20px; padding: 12px; background: rgba(16, 185, 129, 0.1); border: 1px dashed #10b981; border-radius: 12px;">
                <h3 style="color: #10b981; font-size: 16px; margin: 0;">🎖️ أساطير المعسكر (الترتيب التراكمي)</h3>
                <p style="font-size: 12px; color: var(--text-muted); margin: 5px 0 0 0;">سجل الشرف الدائم والأوسمة التاريخية</p>
            </div>`;
        }

        if (usersArray.length === 0) {
            listContainer.innerHTML +=
                '<p style="text-align: center; color: var(--text-muted); margin-top: 20px;">لا يوجد متصدرين حتى الآن.</p>';
            return;
        }

        // 2. حساب المراكز الحقيقية العادلة
        let actualPosition = 1;
        let displayRank = 1;
        let previousUser = null;

        usersArray.forEach((user) => {
            if (previousUser) {
                let samePrimary, sameSecondary;

                if (currentLeaderboardMode === "challenge") {
                    samePrimary =
                        (user.cycleScore || 0) ===
                        (previousUser.cycleScore || 0);
                    sameSecondary =
                        (user.currentStreak || 0) ===
                        (previousUser.currentStreak || 0);
                } else {
                    samePrimary =
                        (user.lifetimeScore || 0) ===
                        (previousUser.lifetimeScore || 0);
                    sameSecondary = true;
                }

                if (!samePrimary || !sameSecondary) {
                    displayRank = actualPosition;
                }
            }
            user.computedRank = displayRank;
            previousUser = user;
            actualPosition++;
        });

        const getDisplayScore = (u) => {
            // التعديل هنا: عرض علامة الكأس ونقاط الدورة في التبويب الحالي
            return currentLeaderboardMode === "challenge"
                ? `${u.cycleScore || 0} 🏆`
                : `${u.lifetimeScore || 0} 🎖️`;
        };

        // 3. بناء القائمة الموحدة (الستايل القديم)
        usersArray.forEach((user) => {
            const currentRank = user.computedRank;

            // استعادة أوسمة وتأثيرات المراكز الثلاثة الأولى (الأكاليل والتوهج)
            let badgeClass = "";
            let hoverClass = "";
            let customStyle = "";

            if (currentRank === 1) {
                badgeClass = "top-1";
                hoverClass = "rank-1-hover";
            } else if (currentRank === 2) {
                badgeClass = "top-2";
                hoverClass = "rank-2-hover";
            } else if (currentRank === 3) {
                badgeClass = "top-3";
                hoverClass = "rank-3-hover";
            } else {
                customStyle =
                    "color: var(--text-muted); font-size: 15px; text-shadow: none; font-weight: bold;";
            }

            const streakHtml =
                user.currentStreak > 0 && currentLeaderboardMode === "challenge"
                    ? `<span class="streak-badge"><i class="fa-solid fa-fire fa-fw"></i> ${user.currentStreak}</span>`
                    : "";

            const rankInfo = getRankDetails(user.lifetimeScore || 0);
            const frameClass = getRankFrameClass(user.lifetimeScore || 0);
            const displayedScore = getDisplayScore(user);

            const userDiv = document.createElement("div");
            userDiv.className = `leaderboard-item ${hoverClass}`;

            // الحل الهندسي لمشكلة الأسماء الإنجليزية (align-items: flex-start + dir="auto")
            userDiv.innerHTML = `
                <div class="leaderboard-user-info" style="min-width: 0;">
                    <div class="rank-badge ${badgeClass}" style="${customStyle}">#${currentRank}</div>
                    <div class="avatar-wrapper ${frameClass}" style="width: 45px; height: 45px; flex-shrink: 0;">
                        <img src="${user.photoURL || "images/profile.webp"}" alt="Avatar">
                    </div>
                    <div style="display: flex; flex-direction: column; gap: 3px; min-width: 0; align-items: flex-start; text-align: right;">
                        <span class="leaderboard-name" dir="auto" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${user.name}</span>
                        <span class="rank-tag ${rankInfo.tagClass}">${rankInfo.title}</span>
                    </div>
                </div>
                
                <div class="leaderboard-stats" style="flex-shrink: 0;">
                    ${streakHtml}
                    <span class="task-points-badge">${displayedScore}</span>
                </div>
            `;

            userDiv.addEventListener("click", () =>
                openUserProfileModal({ ...user, rank: currentRank }),
            );
            listContainer.appendChild(userDiv);
        });
    } catch (error) {
        console.error(error);
    }
}

function openUserProfileModal(user) {
    const modal = document.getElementById("user-modal-overlay");
    const rankInfo = getRankDetails(user.lifetimeScore || 0);

    document.getElementById("modal-user-name").innerText = user.name;
    document.getElementById("modal-user-name").innerHTML +=
        `<br><span class="rank-tag ${rankInfo.tagClass}" style="display: block; margin: auto; font-size: 13px;">${rankInfo.title}</span>`;

    document.getElementById("modal-user-rank").innerText = `#${user.rank}`;

    const pointsEl = document.getElementById("modal-user-points");
    const streakEl = document.getElementById("modal-user-streak");

    if (currentLeaderboardMode === "challenge") {
        // في الدورة الحالية: نظهر نقاط الدورة والستريك الحالي
        pointsEl.innerHTML = `${user.cycleScore || 0} <i class="fa-solid fa-trophy" style="color: var(--gold-primary);"></i>`;
        streakEl.style.display = "inline-block";
        streakEl.innerHTML = `<i class="fa-solid fa-fire fa-fw"></i> ${user.currentStreak || 0}`;
        document
            .getElementById("streak-box")
            ?.style.setProperty("display", "inline", "important");
    } else {
        // في التراكمي: نظهر الـ lifetimeScore ونخفي الستريك لأنه لا يخص الترتيب التراكمي
        pointsEl.innerHTML = `${user.lifetimeScore || 0} <i class="fa-solid fa-medal" style="color: #10b981;"></i>`;
        document
            .getElementById("streak-box")
            ?.style.setProperty("display", "none", "important");
        streakEl.style.display = "none";
    }

    const avatarWrapper = document.getElementById("modal-avatar-wrapper");
    avatarWrapper.className = `avatar-wrapper ${getRankFrameClass(user.lifetimeScore)}`;
    document.getElementById("modal-user-avatar").src =
        user.photoURL || "images/profile.webp";

    const badgesContainer = document.getElementById("modal-badges-container");
    if (user.badges && user.badges.length > 0) {
        const sortedBadges = [...user.badges].sort(
            (a, b) => new Date(b.date) - new Date(a.date),
        );
        badgesContainer.innerHTML = sortedBadges
            .map((badge) => {
                const dateStr = new Date(badge.date).toLocaleDateString(
                    "en-GB",
                );
                const imgPath =
                    badge.imagePath || badge.icon || "images/badge.webp";

                return `
            <div style="background: rgba(168, 85, 247, 0.1); border: 1px solid var(--border-color); padding: 15px; border-radius: 12px; width: 110px; text-align: center; box-shadow: 0 4px 15px rgba(0,0,0,0.2);">
                <div style="display: flex; justify-content: center; align-items: center; font-size: 30px; margin-bottom: 5px; text-shadow: 0 0 10px var(--gold-glow);">
                    <img src="${imgPath}" alt="${badge.title}" style="width: 70px; height: 70px; object-fit: contain;">
                </div>
                <h4 style="font-size: 12px; color: var(--text-main); margin-bottom: 5px; line-height: 1.3;">${badge.title}</h4>
                <span style="font-size: 10px; color: var(--gold-primary); font-weight: bold;">${dateStr}</span>
            </div>`;
            })
            .join("");
    } else {
        badgesContainer.innerHTML =
            '<p style="color: var(--text-muted); font-size: 15px; width: 100%; text-align: center; padding: 20px 0;">هذا المحارب لم يثبت نفسه ولم يحصد أي أوسمة بعد! 🏳️</p>';
    }
    modal.classList.add("show");
}

document
    .getElementById("close-modal-btn")
    ?.addEventListener("click", () =>
        document.getElementById("user-modal-overlay").classList.remove("show"),
    );

document
    .getElementById("user-modal-overlay")
    ?.addEventListener("click", (e) => {
        if (e.target.id === "user-modal-overlay")
            e.target.classList.remove("show");
    });

document
    .getElementById("save-profile-btn")
    .addEventListener("click", async () => {
        const newName = document
            .getElementById("profile-name-input")
            .value.trim();
        if (!newName) return await CustomDialog.alert("الاسم مطلوب.");
        await updateDoc(doc(db, "users", currentUser.uid), { name: newName });
        window.syncUserUI();
    });

// ==========================================
// نظام قص ورفع الصورة الاحترافي (Cropper.js)
// ==========================================
let cropper = null;
const cropModal = document.getElementById("crop-modal-overlay");
const cropImageTarget = document.getElementById("crop-image-target");

document.getElementById("avatar-upload").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file || !currentUser) return;

    // التأكد من أنها صورة
    if (!file.type.startsWith("image/")) {
        CustomDialog.alert("الرجاء اختيار ملف صورة صالح.");
        return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
        cropImageTarget.src = event.target.result;
        cropModal.classList.add("show");

        // تدمير أي نسخة قديمة من الكروبر لو العضو فتح كذا مرة
        if (cropper) cropper.destroy();

        // تفعيل أداة القص
        cropper = new Cropper(cropImageTarget, {
            aspectRatio: 1, // إجبار القص على شكل مربع 1:1
            viewMode: 1, // منع خروج مربع القص عن حدود الصورة
            dragMode: "move", // السماح بتحريك الصورة نفسها
            autoCropArea: 0.9, // حجم المربع الافتراضي
            guides: true, // إظهار الخطوط الإرشادية
            center: true,
            highlight: false,
            cropBoxMovable: true,
            cropBoxResizable: true,
        });
    };
    reader.readAsDataURL(file);
    e.target.value = ""; // تفريغ الحقل للسماح باختيار نفس الصورة مرة أخرى
});

// زر الإلغاء
document.getElementById("cancel-crop-btn")?.addEventListener("click", () => {
    cropModal.classList.remove("show");
    if (cropper) {
        cropper.destroy();
        cropper = null;
    }
});

// زر التأكيد والرفع
document
    .getElementById("confirm-crop-btn")
    ?.addEventListener("click", async () => {
        if (!cropper || !currentUser) return;

        const btn = document.getElementById("confirm-crop-btn");
        const originalText = btn.innerText;
        btn.innerText = "جاري الرفع... ⏳";
        btn.disabled = true;

        // استخراج الصورة بعد القص بجودة عالية وأبعاد ثابتة 400x400
        const canvas = cropper.getCroppedCanvas({
            width: 400,
            height: 400,
            imageSmoothingEnabled: true,
            imageSmoothingQuality: "high",
        });

        // تحويل الكانفاس لملف ورفعه لفايربيز
        canvas.toBlob(
            async (blob) => {
                try {
                    const storageRef = ref(
                        storage,
                        `avatars/${currentUser.uid}`,
                    );
                    await uploadBytes(storageRef, blob);
                    const photoURL = await getDownloadURL(storageRef);
                    await updateDoc(doc(db, "users", currentUser.uid), {
                        photoURL,
                    });
                    window.syncUserUI();
                } catch (err) {
                    await CustomDialog.alert(
                        "حدث خطأ أثناء الاتصال بقاعدة البيانات لرفع الصورة.",
                    );
                    btn.innerText = originalText;
                    btn.disabled = false;
                }
            },
            "image/jpeg",
            0.9,
        );
    });

async function loadAnalytics() {
    if (!currentUser) return;
    try {
        // 1. جلب المهام لبناء مرجع وحساب الحد الأقصى الممكن لكل قسم ديناميكياً
        const tasksSnap = await getDocs(collection(db, "tasks"));
        const tasksMap = {};
        const maxDailyPointsPerCategory = {};

        tasksSnap.forEach((doc) => {
            const taskData = doc.data();
            tasksMap[doc.id] = taskData;

            // حساب أعلى نقاط ممكنة لهذه المهمة (بشرط أن تكون نشطة)
            if (
                taskData.isActive &&
                taskData.options &&
                taskData.options.length > 0
            ) {
                const cat = taskData.category || "مهام عامة";
                let maxPointsForThisTask = 0;

                // --- الإصلاح الأول: التفرقة بين المهام العادية والمتعددة في حساب الحد الأقصى ---
                if (taskData.isMultiSelect) {
                    // إذا كانت مهمة متعددة، الحد الأقصى هو مجموع نقاط كل الخيارات
                    taskData.options.forEach((opt) => {
                        if (opt.points > 0) maxPointsForThisTask += opt.points;
                    });
                } else {
                    // إذا كانت قائمة عادية، الحد الأقصى هو أعلى خيار فقط
                    maxPointsForThisTask = Math.max(
                        ...taskData.options.map((opt) => opt.points || 0),
                    );
                }

                maxDailyPointsPerCategory[cat] =
                    (maxDailyPointsPerCategory[cat] || 0) +
                    maxPointsForThisTask;
            }
        });

        // 2. جلب سجلات المستخدم
        const logsSnap = await getDocs(
            collection(db, `users/${currentUser.uid}/dailyLogs`),
        );
        let passedCount = 0,
            failedCount = 0,
            dates = [],
            points = [];
        let logsArray = [];
        let categoryPoints = {};

        logsSnap.forEach((doc) => logsArray.push(doc.data()));
        logsArray.sort((a, b) => new Date(a.date) - new Date(b.date));

        logsArray.forEach((log) => {
            if (log.isFinalized === true) {
                if (log.passed) passedCount++;
                else failedCount++;
            }

            dates.push(log.date);
            points.push(log.pointsEarned || 0);

            // --- الإصلاح الثاني: حساب النقاط المكتسبة للـ Checklists والـ Select ---
            if (log.selections) {
                for (const [taskId, selectionData] of Object.entries(
                    log.selections,
                )) {
                    const task = tasksMap[taskId];
                    if (task && task.options) {
                        const cat = task.category || "مهام عامة";

                        // تحويل الاختيار المفرد إلى مصفوفة لتوحيد المعاملة البرمجية
                        const selectedIndices = Array.isArray(selectionData)
                            ? selectionData
                            : [selectionData];

                        selectedIndices.forEach((idx) => {
                            if (task.options[idx]) {
                                const pts = task.options[idx].points || 0;
                                categoryPoints[cat] =
                                    (categoryPoints[cat] || 0) + pts;
                            }
                        });
                    }
                }
            }
        });

        document.getElementById("stat-passed").innerText = passedCount;
        document.getElementById("stat-failed").innerText = failedCount;

        // ==========================================
        // المخطط الأول: معدل النقاط اليومي (Line Chart)
        // ==========================================
        const ctxProgress = document
            .getElementById("progressChart")
            .getContext("2d");
        if (window.myProgressChart) window.myProgressChart.destroy();

        const chartContainer = document.getElementById(
            "progress-chart-container",
        );
        if (chartContainer) {
            const calculatedWidth = dates.length * 45;
            chartContainer.style.minWidth =
                calculatedWidth > window.innerWidth
                    ? `${calculatedWidth}px`
                    : "100%";
        }

        window.myProgressChart = new Chart(ctxProgress, {
            type: "line",
            data: {
                labels: dates,
                datasets: [
                    {
                        label: "النقاط المحصلة",
                        data: points,
                        borderColor: "#a855f7",
                        backgroundColor: "rgba(168, 85, 247, 0.15)",
                        borderWidth: 2,
                        fill: true,
                        tension: 0.4,
                        pointBackgroundColor: "#a855f7",
                        pointRadius: 4,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        labels: { color: "#f3f4f6", font: { family: "Cairo" } },
                    },
                },
                scales: {
                    x: {
                        ticks: { color: "#9ca3af" },
                        grid: { color: "#2a2a35" },
                    },
                    y: {
                        ticks: { color: "#9ca3af" },
                        grid: { color: "#2a2a35" },
                    },
                },
            },
        });

        // ==========================================
        // المخطط الثاني: تحليل الأقسام (Radar Chart) - مبرمج لآخر 7 أيام
        // ==========================================
        const ctxCategory = document
            .getElementById("categoryChart")
            .getContext("2d");
        if (window.myCategoryChart) window.myCategoryChart.destroy();

        // عزل بيانات آخر 7 أيام فقط لمنع الماضي من تدمير النسبة الحالية
        const recentLogs = logsArray.slice(-7);
        const recentTotalDays = recentLogs.length > 0 ? recentLogs.length : 1;
        let recentCategoryPoints = {};

        // حساب النقاط المكتسبة في هذه الأيام السبعة فقط
        recentLogs.forEach((log) => {
            if (log.selections) {
                for (const [taskId, selectionData] of Object.entries(
                    log.selections,
                )) {
                    const task = tasksMap[taskId];
                    if (task && task.options) {
                        const cat = task.category || "مهام عامة";
                        const selectedIndices = Array.isArray(selectionData)
                            ? selectionData
                            : [selectionData];
                        selectedIndices.forEach((idx) => {
                            if (task.options[idx]) {
                                recentCategoryPoints[cat] =
                                    (recentCategoryPoints[cat] || 0) +
                                    (task.options[idx].points || 0);
                            }
                        });
                    }
                }
            }
        });

        // تحويل النقاط المكتسبة حديثاً إلى نسبة مئوية
        const catLabels = Object.keys(maxDailyPointsPerCategory);
        const catDataPercentages = [];

        catLabels.forEach((cat) => {
            const earnedPoints = recentCategoryPoints[cat] || 0;
            const maxDaily = maxDailyPointsPerCategory[cat] || 1;
            const maxTotalPossible = maxDaily * recentTotalDays;

            let percentage =
                Math.round((earnedPoints / maxTotalPossible) * 100) || 0;
            if (percentage > 100) percentage = 100;

            catDataPercentages.push(percentage);
        });

        if (catLabels.length > 0) {
            window.myCategoryChart = new Chart(ctxCategory, {
                type: "radar",
                data: {
                    labels: catLabels,
                    datasets: [
                        {
                            label: "نسبة الإنجاز (آخر 7 أيام)",
                            data: catDataPercentages,
                            backgroundColor: "rgba(217, 70, 239, 0.12)",
                            borderColor: "#9ca3af",
                            pointBackgroundColor: "#9ca3af",
                            pointBorderColor: "#fff",
                            pointHoverBackgroundColor: "#fff",
                            pointHoverBorderColor: "#9ca3af",
                            borderWidth: 2,
                        },
                    ],
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                label: function (context) {
                                    return context.raw + "%";
                                },
                            },
                        },
                    },
                    scales: {
                        r: {
                            min: 0,
                            max: 100,
                            angleLines: { color: "rgba(255, 255, 255, 0.1)" },
                            grid: { color: "rgba(255, 255, 255, 0.1)" },
                            pointLabels: {
                                color: "#f3f4f6",
                                font: { family: "Cairo", size: 12 },
                            },
                            ticks: { stepSize: 20, display: false },
                        },
                    },
                },
            });
        }
    } catch (e) {
        console.error("خطأ في تحميل الإحصائيات:", e);
    }
}

function getRankFrameClass(points) {
    if (points <= 1000) return "frame-wood";
    if (points <= 3000) return "frame-bronze";
    if (points <= 6000) return "frame-silver";
    if (points <= 10000) return "frame-gold";
    return "frame-diamond";
}

// خوارزمية تحديد الرتبة والتقدم بناءً على السكور التراكمي (مع أيقونات حقيقية)
function getRankDetails(score) {
    if (score < 1000)
        return {
            title: '<i class="fa-solid fa-graduation-cap"></i> متدرب',
            tagClass: "rank-trainee",
            currentBase: 0,
            nextGoal: 1000,
            nextTitle: "محارب",
        };
    if (score < 3000)
        return {
            title: '<i class="fa-solid fa-shield"></i> محارب',
            tagClass: "rank-warrior",
            currentBase: 1000,
            nextGoal: 3000,
            nextTitle: "مخضرم",
        };
    if (score < 6000)
        return {
            title: '<i class="fa-solid fa-medal"></i> مخضرم',
            tagClass: "rank-veteran",
            currentBase: 3000,
            nextGoal: 6000,
            nextTitle: "نُخبة",
        };
    if (score < 10000)
        return {
            title: '<i class="fa-solid fa-gem"></i> نُخبة',
            tagClass: "rank-elite",
            currentBase: 6000,
            nextGoal: 10000,
            nextTitle: "أسطورة",
        };
    return {
        title: '<i class="fa-solid fa-crown"></i> أسطورة',
        tagClass: "rank-legend",
        currentBase: 10000,
        nextGoal: null,
        nextTitle: null,
    };
}

// ==========================================
// محرك التنقل الموحد (التبديل الصامت بدون ريفريش)
// ==========================================

window.silentRefreshTasks = async function () {
    // 🛑 تطبيق القفل هنا أيضاً
    if (!currentUser || window.isUIUpdating) return;

    window.isUIUpdating = true;
    const tasksList = document.getElementById("tasks-list");
    if (tasksList) tasksList.style.opacity = "0.4";

    try {
        const realNow = getRealNow();
        const todayStr = getCairoDateString(realNow);

        const [userDocSnap, todayLogSnap] = await Promise.all([
            getDoc(doc(db, "users", currentUser.uid)),
            getDoc(doc(db, `users/${currentUser.uid}/dailyLogs`, todayStr)),
        ]);

        const userData = userDocSnap.data();
        let todayLogData = null;

        if (todayLogSnap.exists()) {
            todayLogData = todayLogSnap.data();
            isTodayFinalized = todayLogData.isFinalized || false;
        } else {
            isTodayFinalized = false;
        }

        const pointsDisplay = document.getElementById("today-points");
        if (pointsDisplay)
            pointsDisplay.innerText = todayLogData
                ? todayLogData.pointsEarned || 0
                : 0;

        await loadTasks(todayLogData, userData);
        await loadReligiousTasks(todayLogData);
    } catch (error) {
        console.error("فشل التحديث الصامت:", error);
    } finally {
        if (tasksList) tasksList.style.opacity = "1";
        window.isUIUpdating = false; // 🔓 فتح القفل
    }
};

const navItems = document.querySelectorAll("[data-target]");

navItems.forEach((item) => {
    item.addEventListener("click", async function (e) {
        e.preventDefault(); // منع أي سلوك افتراضي مزعج
        const targetId = this.getAttribute("data-target");
        if (!targetId) return;

        // 1. التبديل البصري للأزرار (UI)
        navItems.forEach((i) => i.classList.remove("active"));
        if (this.id !== "profile-btn") {
            this.classList.add("active");
        }

        // 2. إظهار الصفحة المطلوبة وإخفاء الباقي فوراً
        const allTargets = Array.from(navItems).map((btn) =>
            btn.getAttribute("data-target"),
        );
        allTargets.forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.classList.remove("active");
        });
        const targetSection = document.getElementById(targetId);
        if (targetSection) targetSection.classList.add("active");

        // 3. حفظ الصفحة في الذاكرة
        localStorage.setItem("dashboardActiveTab", targetId);

        // 4. جلب البيانات صامتاً بناءً على الصفحة المفتوحة
        if (targetId === "tasks-page") {
            await window.silentRefreshTasks();
        } else if (targetId === "leaderboard-page") {
            if (typeof loadLeaderboard === "function") loadLeaderboard();
        } else if (targetId === "analytics-page" || targetId === "stats-page") {
            if (typeof loadAnalytics === "function") loadAnalytics();
        }
    });
});

// دالة شراء تجميد الستريك
window.buyFreeze = async function () {
    if (!currentUser) return;

    const userRef = doc(db, "users", currentUser.uid);
    const userDoc = await getDoc(userRef);
    const userData = userDoc.data();

    const freezeCost = 500; // حدد التكلفة التي تراها مناسبة
    const currentCoins = userData.walletCoins || 0;
    const hasFreeze = userData.freezeCount > 0;

    if (currentCoins < 0) {
        return CustomDialog.alert(
            "أنت مديون للنظام. قم بتسديد ديون التخاذل أولاً قبل محاولة الشراء.",
            "المتجر مغلق 🛑",
        );
    }

    if (hasFreeze) {
        return CustomDialog.alert(
            "أنت تمتلك بالفعل تجميداً مخزناً. استهلكه أولاً لتستطيع شراء غيره.",
            "المخزن ممتلئ",
        );
    }

    if (currentCoins < freezeCost) {
        return CustomDialog.alert(
            `عملاتك لا تكفي. تحتاج إلى ${freezeCost} عملات.`,
            "رصيد غير كافٍ",
        );
    }

    const confirmBuy = await CustomDialog.confirm(
        `هل تريد شراء "تجميد الستريك" مقابل ${freezeCost} نقطة؟`,
    );

    if (confirmBuy) {
        try {
            await updateDoc(userRef, {
                walletCoins: increment(-freezeCost),
                freezeCount: 1,
            });
            await CustomDialog.alert(
                "تمت عملية الشراء بنجاح! سيتم استهلاكها تلقائياً عند أول إخفاق.",
                "مبروك ❄️",
            );
            window.syncUserUI(); // لتحديث الواجهة والنقاط
        } catch (error) {
            CustomDialog.alert("حدث خطأ أثناء الشراء.");
        }
    }
};

// ==========================================
// شراء أو إلغاء مفكرة المهام الحرة من المتجر
// ==========================================
window.toggleTodoListFeature = async function () {
    if (!currentUser) return;

    const userRef = doc(db, "users", currentUser.uid);
    const userDoc = await getDoc(userRef);
    const userData = userDoc.data();

    const hasTodo = userData.hasTodoList || false;
    const currentCoins = userData.walletCoins || 0;
    const cost = 150;

    if (hasTodo) {
        // حالة الإلغاء
        const confirmCancel = await CustomDialog.confirm(
            `هل أنت متأكد من إلغاء 'مفكرة المهام الحرة'؟\nلن يتم استرداد الـ ${cost} نقطة التي دفعتها، وستضطر لشرائها مجدداً إذا أردتها لاحقاً.`,
            "إلغاء الأداة 🗑️",
        );

        if (confirmCancel) {
            await updateDoc(userRef, { hasTodoList: false });

            // طرده لصفحة المهام إذا كان يقف في المفكرة
            if (localStorage.getItem("dashboardActiveTab") === "todo-page") {
                document.querySelector('[data-target="tasks-page"]')?.click();
            }

            window.syncUserUI();
        }
    } else {
        // حالة الشراء
        if (currentCoins < 0) {
            return CustomDialog.alert(
                "أنت مديون للنظام. قم بتسديد ديون التخاذل أولاً قبل محاولة الشراء.",
                "المتجر مغلق 🛑",
            );
        }
        if (currentCoins < cost) {
            return CustomDialog.alert(
                `عملاتك لا تكفي. تحتاج إلى ${cost} عملات لفتح هذه الأداة.`,
                "رصيد غير كافٍ",
            );
        }

        const confirmBuy = await CustomDialog.confirm(
            `هل تريد فتح 'مفكرة المهام الحرة' بشكل دائم مقابل ${cost} عملات؟`,
            "شراء أداة 📝",
        );

        if (confirmBuy) {
            await updateDoc(userRef, {
                walletCoins: increment(-cost),
                hasTodoList: true,
            });

            await CustomDialog.alert(
                "تم فتح الأداة بنجاح! ستجدها الآن في القائمة الجانبية.",
                "عملية ناجحة 🎉",
            );
            window.syncUserUI();
        }
    }
};

// ==========================================
// شراء جرعة مضاعف النقاط (Double XP) - مرة واحدة بالتحدي
// ==========================================
window.buyDoubleXP = async function () {
    if (!currentUser) return;
    const userRef = doc(db, "users", currentUser.uid);
    const userDoc = await getDoc(userRef);
    const userData = userDoc.data();
    // 3. هل يملك المال وهل هو غير مديون؟
    if ((userData.walletCoins || 0) < 0) {
        return CustomDialog.alert(
            "أنت مديون للنظام. قم بتسديد ديون التخاذل أولاً قبل محاولة الشراء.",
            "المتجر مغلق 🛑",
        );
    }
    // 1. هل استخدمها مسبقاً في هذا التحدي؟
    if (userData.usedDoubleXP) {
        return CustomDialog.alert(
            "لقد استخدمت مضاعف النقاط بالفعل في هذا التحدي. لا يمكنك استخدامه مرة أخرى.",
            "مرفوض ❌",
        );
    }
    // 2. هل اشتراها ولم ينهِ يومه بعد؟
    if (userData.hasDoubleXP) {
        return CustomDialog.alert(
            "المضاعف نشط بالفعل في حسابك وينتظر إنهاء يومك بنجاح.",
            "نشط مسبقاً ⚡",
        );
    }
    // 3. هل يملك المال؟
    const cost = 500; // حدد التكلفة التي تراها مناسبة
    if ((userData.walletCoins || 0) < cost) {
        return CustomDialog.alert(
            `عملاتك لا تكفي. تحتاج إلى ${cost} عملة.`,
            "رصيد غير كافٍ",
        );
    }

    const confirmBuy = await CustomDialog.confirm(
        `شراء الجرعة بـ ${cost} عملة؟ ستتضاعف نقاط הـ XP لمرة واحدة فقط عند اعتماد يومك الحالي بنجاح.`,
        "تأكيد ⚡",
    );

    if (confirmBuy) {
        try {
            await updateDoc(userRef, {
                walletCoins: increment(-cost),
                hasDoubleXP: true,
            });
            new Audio(
                "https://cdn.pixabay.com/download/audio/2021/08/04/audio_0625c1539c.mp3?filename=success-1-6297.mp3",
            )
                .play()
                .catch(() => {});
            await CustomDialog.alert(
                "تم التفعيل! أكمل مهام اليوم واعتمدها لتحصل على ضعف النقاط.",
                "عملية ناجحة ⚡",
            );
            window.syncUserUI();
        } catch (error) {
            CustomDialog.alert("حدث خطأ أثناء عملية الشراء.");
        }
    }
};

// ==========================================
// نظام المهام الحرة (To-Do List) - LocalStorage
// ==========================================
const todoInput = document.getElementById("todo-input");
const addTodoBtn = document.getElementById("add-todo-btn");
const todoList = document.getElementById("todo-list");
const todoTotal = document.getElementById("todo-total");
const todoCompleted = document.getElementById("todo-completed");

// استدعاء المهام من المتصفح أو إنشاء مصفوفة فارغة
let todos = JSON.parse(localStorage.getItem("brainrot_todos")) || [];

function saveTodos() {
    localStorage.setItem("brainrot_todos", JSON.stringify(todos));
    renderTodos();
}

function renderTodos() {
    if (!todoList) return;
    todoList.innerHTML = "";
    let completedCount = 0;

    if (todos.length === 0) {
        todoList.innerHTML =
            '<p style="text-align: center; color: var(--text-muted); font-size: 13px; padding: 20px;">الساحة فارغة. أضف مهامك لتنظيم فوضى يومك.</p>';
        todoTotal.innerText = "0";
        todoCompleted.innerText = "0";
        return;
    }

    todos.forEach((todo, index) => {
        if (todo.completed) completedCount++;

        const li = document.createElement("li");
        li.className = `todo-item ${todo.completed ? "completed" : ""}`;
        li.innerHTML = `
            <input type="checkbox" class="todo-checkbox" ${todo.completed ? "checked" : ""} onchange="toggleTodo(${index})">
            <span class="todo-text" onclick="toggleTodo(${index})">${todo.text}</span>
            <button class="todo-delete-btn" onclick="deleteTodo(${index})" title="حذف المهمة"><i class="fa-solid fa-trash"></i></button>
        `;
        todoList.appendChild(li);
    });

    if (todoTotal) todoTotal.innerText = todos.length;
    if (todoCompleted) todoCompleted.innerText = completedCount;
}

// إضافة مهمة جديدة
if (addTodoBtn) {
    addTodoBtn.addEventListener("click", () => {
        const text = todoInput.value.trim();
        if (text) {
            todos.push({ text: text, completed: false });
            todoInput.value = "";
            saveTodos();
        }
    });
}

// دعم الضغط على زر Enter لإضافة المهمة
if (todoInput) {
    todoInput.addEventListener("keypress", (e) => {
        if (e.key === "Enter") {
            addTodoBtn.click();
        }
    });
}

// تحديد إكمال المهمة أو التراجع عنه
window.toggleTodo = function (index) {
    todos[index].completed = !todos[index].completed;
    saveTodos();
};

// حذف المهمة
window.deleteTodo = function (index) {
    todos.splice(index, 1);
    saveTodos();
};

// تشغيل العرض الأولي عند تحميل الصفحة
renderTodos();

// ==========================================
// الجولة التعريفية (Smart Onboarding Tour)
// ==========================================
function startTour() {
    // 1. هل أتم الجولة مسبقاً؟

    if (localStorage.getItem("brainrot_tour_completed")) return;

    // 2. هل هو يقف في صفحة المهام حالياً؟ (لتجنب تشغيلها إذا فتح المتجر مباشرة)
    const activeTab =
        localStorage.getItem("dashboardActiveTab") || "tasks-page";
    if (activeTab !== "tasks-page") return;

    // 3. الحاجز الأمني: هل الواجهة مرسومة بالكامل؟ (إذا لم يكن هناك تحدي، سيتوقف الكود هنا)
    const reflectionBox = document.getElementById("reflection-container");
    if (!reflectionBox || reflectionBox.offsetParent === null) return;

    const driver = window.driver.js.driver;
    const tour = driver({
        showProgress: true,
        allowClose: false,
        doneBtnText: "فهمت، لننطلق ⚔️",
        nextBtnText: "التالي ❯",
        prevBtnText: "❮ السابق",
        // --- هذا هو التعديل الجديد ---
        onDestroyed: async () => {
            const tasksBtn = document.querySelector(
                '[data-target="tasks-page"]',
            );
            if (tasksBtn) tasksBtn.click();

            // طلب تفعيل الإشعارات بعد الجولة مباشرة
            await CustomDialog.alert(
                "لضمان التزامك بالمعسكر، يجب تفعيل الإشعارات الآن لتصلك تنبيهات المهام اليومية.",
                "تفعيل الإشعارات 🔔",
            );
            requestNotificationPermission();
        },
        steps: [
            {
                element: ".sidebar",
                popover: {
                    title: "مرحباً بك في المعسكر 🛡️",
                    description:
                        "هنا تبدأ رحلتك. القائمة الجانبية هي مركز القيادة للتنقل بين المهام، المتجر، والإحصائيات.",
                    side: "left",
                    align: "start",
                },
            },
            {
                element: ".user-menu",
                popover: {
                    title: "معلومات المستخدم 👤",
                    description:
                        "انقر على صورتك لعرض ملفك الشخصي، حيث يمكنك رؤية تقدمك، الأوسمة التي حصلت عليها، وتعديل اسمك أو صورتك.",
                    side: "bottom",
                    align: "center",
                },
            },
            {
                element: ".points-div-info",
                popover: {
                    title: "لوحة المعلومات 📊",
                    description:
                        "هنا يظهر مستواك الحالي، نقاطك، والستريك (أيام التزامك). إياك أن تكسر الستريك!",
                    side: "bottom",
                    align: "center",
                },
            },
            {
                element: "#challenge-info",
                popover: {
                    title: "معلومات التحدي 🎯",
                    description:
                        "هنا ستجد معلومات عن التحدي مدتة, الحد الادنى للنقاط اليومية, ونقاطك التي جمعتها خلال اليوم. تأكد من تحقيق الحد الأدنى كل يوم لتتجنب العقوبات القاسية!",
                    side: "bottom",
                    align: "center",
                },
            },
            {
                element: ".challenge-note",
                popover: {
                    title: "تنبيه التحدي ⚠️",
                    description:
                        "في حال لم تستطع تجميع نقاط كافية للنجاح في هذا اليوم ستجد تكلفة (طوق النجاة) مكتوبة هنا.",
                    side: "bottom",
                    align: "center",
                },
            },
            {
                element: ".tasks-list-class",
                popover: {
                    title: "ساحة المعركة ⚔️",
                    description:
                        "هذه مهامك اليومية. اختر مستوى إنجازك لكل مهمة بصدق، الموجه الذكي سيحاسبك لاحقاً.",
                    side: "top",
                    align: "center",
                },
            },
            {
                element: "#submit-day-btn",
                popover: {
                    title: "إنهاء اليوم 🕒",
                    description:
                        "عند الضغط هنا، ستُقفل مهام اليوم وسيبدأ الموجه الذكي بتحليل تقريرك. كن صادقاً، فهو لا يغفر الكذب أو الأعذار.",
                    side: "top",
                    align: "center",
                },
            },
            {
                element: '[data-target="store-page"]',
                popover: {
                    title: "متجر الادوات 🛒",
                    description:
                        "استخدم نقاطك بحكمة هنا لشراء أو فتح أدوات جديدة.",
                    side: "left",
                    align: "center",
                },
                // هذا السطر يجبر النظام على فتح صفحة المتجر فوراً بمجرد وصول الجولة له
                onHighlightStarted: () => {
                    const storeBtn = document.querySelector(
                        '[data-target="store-page"]',
                    );
                    if (storeBtn) storeBtn.click();
                },
            },
            {
                element: '[data-target="leaderboard-page"]',
                popover: {
                    title: "جدول القيادة 🏆",
                    description:
                        "اطلع على ترتيبك بين المستخدمين الآخرين وتحقيق إنجازاتك.",
                    side: "left",
                    align: "center",
                },
                // هذا السطر يجبر النظام على فتح صفحة المتجر فوراً بمجرد وصول الجولة له
                onHighlightStarted: () => {
                    const storeBtn = document.querySelector(
                        '[data-target="leaderboard-page"]',
                    );
                    if (storeBtn) storeBtn.click();
                },
            },
            // {
            //     element: '[data-target="analytics-page"]',
            //     popover: {
            //         title: "لوحة الاحصائيات 📊",
            //         description:
            //             "هنا يمكنك رؤية تقدمك اليومي، تحليل نقاطك، وأداءك في الجوانب المختلفة. استخدم هذه البيانات لتعديل استراتيجيتك وتحسين أدائك.",
            //         side: "left",
            //         align: "center",
            //     },
            //     // هذا السطر يجبر النظام على فتح صفحة المتجر فوراً بمجرد وصول الجولة له
            //     onHighlightStarted: () => {
            //         const storeBtn = document.querySelector(
            //             '[data-target="analytics-page"]',
            //         );
            //         if (storeBtn) storeBtn.click();
            //     },
            // },
        ],
    });

    // تشغيل الجولة بعد التأكد من كل شيء
    tour.drive();
    localStorage.setItem("brainrot_tour_completed", "true");
}

// ==========================================
// نظام أكواد الهدايا (Redeem Codes)
// ==========================================
document
    .getElementById("open-redeem-btn")
    ?.addEventListener("click", async () => {
        if (!currentUser) return;

        const codeInput = await CustomDialog.prompt(
            "أدخل كود الهدية الخاص بك هنا:",
            "",
            "استرداد هدية 🎁",
        );
        if (!codeInput || codeInput.trim() === "") return;

        // تحويل الكود لحروف كبيرة لمنع مشاكل الـ Case Sensitivity
        const code = codeInput.trim().toUpperCase();

        try {
            const codeRef = doc(db, "redeemCodes", code);
            const codeSnap = await getDoc(codeRef);

            if (!codeSnap.exists()) {
                return await CustomDialog.alert(
                    "الكود غير صحيح أو غير موجود.",
                    "خطأ ❌",
                );
            }

            const codeData = codeSnap.data();

            if (!codeData.isActive) {
                return await CustomDialog.alert(
                    "هذا الكود منتهي الصلاحية أو تم إيقافه.",
                    "عذراً ⚠️",
                );
            }

            const currentUses = codeData.usedBy ? codeData.usedBy.length : 0;
            const maxUses = codeData.maxUses || 0;
            if (currentUses >= maxUses) {
                return await CustomDialog.alert(
                    "عذراً، لقد وصل هذا الكود إلى الحد الأقصى من الاستخدامات وانتهت الكمية.",
                    "نفدت الكمية 🏃‍♂️",
                );
            }

            if (codeData.usedBy && codeData.usedBy.includes(currentUser.uid)) {
                return await CustomDialog.alert(
                    "لقد قمت باستخدام هذا الكود مسبقاً! لا يمكنك استخدامه مرتين.",
                    "عذراً ⚠️",
                );
            }

            // إضافة الهدية كـ "عملات" (Coins) للمحفظة بدلاً من النقاط القديمة
            const userRef = doc(db, "users", currentUser.uid);
            await updateDoc(userRef, {
                walletCoins: increment(codeData.points),
            });

            // تسجيل الـ UID الخاص بالمستخدم في الكود لمنع التكرار
            await updateDoc(codeRef, {
                usedBy: arrayUnion(currentUser.uid),
            });

            // تشغيل صوت الإنجاز
            new Audio(
                "https://cdn.pixabay.com/download/audio/2021/08/04/audio_0625c1539c.mp3?filename=success-1-6297.mp3",
            )
                .play()
                .catch(() => {});

            await CustomDialog.alert(
                `مبروك! 🎉 تم استرداد الكود بنجاح. تمت إضافة ${codeData.points} عملة لمحفظتك.`,
                "عملية ناجحة 🎁",
            );
            window.syncUserUI();
        } catch (error) {
            console.error("Redeem Error:", error);
            await CustomDialog.alert(
                "حدث خطأ أثناء فحص الكود. تأكد من اتصالك بالإنترنت.",
                "خطأ",
            );
        }
    });

// ==========================================
// نظام الإشعارات (Push Notifications)
// ==========================================

window.requestNotificationPermission = async function () {
    if (!currentUser) {
        console.warn("المستخدم غير مسجل الدخول، لا يمكن طلب الإشعارات.");
        return false;
    }

    // ⚠️ لا تنسَ وضع كود الـ VAPID الخاص بك هنا
    const VAPID_KEY =
        "BFwSq3rLOPCWa1pBQaGPHWk3gGvJmJCXQ-y4O2J-z013YU8U-PuFNZpauMghn80iYu5DtMhuKDtoNOc8Qrk1IfA";

    try {
        const permission = await Notification.requestPermission();

        if (permission === "granted") {
            console.log("تم منح صلاحية الإشعارات.");

            // --- التعديل الجذري: إجبار الـ PWA على التقاط ملف الخلفية ---
            const registration = await navigator.serviceWorker.register(
                "/firebase-messaging-sw.js",
            );
            await navigator.serviceWorker.ready; // ننتظر حتى يصبح الملف جاهزاً للعمل

            // نمرر الـ registration صراحةً لفايربيز لكي يعمل داخل التطبيق المثبت
            const token = await getToken(messaging, {
                vapidKey: VAPID_KEY,
                serviceWorkerRegistration: registration,
            });
            // -----------------------------------------------------------

            if (token) {
                // حفظ الرمز في الداتا بيز
                const userRef = doc(db, "users", currentUser.uid);
                await updateDoc(userRef, {
                    fcmTokens: arrayUnion(token),
                });
                console.log("تم حفظ رمز التطبيق بنجاح.");
                return true;
            } else {
                console.log("لم يتم توليد رمز الإشعار.");
                return false;
            }
        } else {
            console.warn("تم رفض صلاحية الإشعارات.");
            return false;
        }
    } catch (error) {
        console.error("خطأ أثناء طلب صلاحية الإشعارات:", error);
        return false;
    }
};

// التقاط الإشعارات والموقع مفتوح (Foreground)
if (messaging) {
    onMessage(messaging, (payload) => {
        console.log("وصل إشعار وأنت داخل الموقع:", payload);

        // إجبار المتصفح على عرض الإشعار
        if (Notification.permission === "granted") {
            new Notification(payload.notification.title, {
                body: payload.notification.body,
                icon: "/images/icon-512.webp", // تأكد من مسار الأيقونة
            });
        }
    });
}

// ==========================================
// زر التفعيل اليدوي للإشعارات
// ==========================================
document
    .getElementById("manual-notify-btn")
    ?.addEventListener("click", async (e) => {
        const btn = e.target;

        // منع الضغط المزدوج وتغيير شكل الزر
        if (btn.disabled) return;
        btn.disabled = true;
        const originalText = btn.innerText;
        btn.innerText = "جاري التفعيل والربط ⏳...";

        // استدعاء الدالة الصارمة التي برمجناها مسبقاً
        const isSuccess = await window.requestNotificationPermission();

        if (isSuccess) {
            btn.innerText = "الإشعارات مفعلة بهذا الجهاز ✅";
            await CustomDialog.alert(
                "تم ربط هذا الجهاز بنجاح. ستصلك إشعارات المعسكر هنا من الآن فصاعداً.",
                "تم التفعيل ✅",
            );
        } else {
            btn.innerText = originalText;
            btn.disabled = false;
            await CustomDialog.alert(
                "لم نتمكن من تفعيل الإشعارات. تأكد من أنك لم تقم بحظرها من إعدادات المتصفح أو الهاتف.",
                "فشل التفعيل ⚠️",
            );
        }
    });

// ==========================================
// عداد الطوارئ (آخر ساعتين قبل الإغلاق)
// ==========================================
function startDoomsdayClock() {
    // تحديد المكان الذي سيظهر فيه العداد (صندوق معلومات التحدي)
    const container = document.getElementById("challenge-info");
    if (!container) return;

    let clockEl = document.getElementById("doomsday-clock");
    if (!clockEl) {
        clockEl = document.createElement("div");
        clockEl.id = "doomsday-clock";
        // تصميم مرعب وأحمر متوهج
        clockEl.style.cssText =
            "display: none; text-align: center; font-size: 18px; font-weight: bold; color: var(--danger); text-shadow: 0 0 15px rgba(244,63,94,0.8); margin-top: 15px; padding: 10px; border: 1px dashed var(--danger); border-radius: 8px; background: rgba(244,63,94,0.1); animation: pulseAlert 1.5s infinite;";
        container.appendChild(clockEl);

        // إضافة تأثير النبض (Pulse) عبر CSS برمجياً
        if (!document.getElementById("doomsday-styles")) {
            const style = document.createElement("style");
            style.id = "doomsday-styles";
            style.innerHTML = `@keyframes pulseAlert { 0% { opacity: 1; } 50% { opacity: 0.5; } 100% { opacity: 1; } }`;
            document.head.appendChild(style);
        }
    }

    // تحديث العداد كل ثانية
    setInterval(() => {
        // إذا كان المستخدم قد أنهى يومه بالفعل، أخفِ العداد ولا تزعجه
        if (isTodayFinalized) {
            clockEl.style.display = "none";
            return;
        }

        const now = getRealNow();

        // خدعة هندسية لحساب الوقت المتبقي لمنتصف ليل القاهرة بدقة
        const cairoTimeStr = now.toLocaleString("en-US", {
            timeZone: "Africa/Cairo",
            hour12: false,
        });
        const cairoDate = new Date(cairoTimeStr);
        // إنشاء موعد منتصف الليل لنفس اليوم
        const cairoMidnight = new Date(
            cairoDate.getFullYear(),
            cairoDate.getMonth(),
            cairoDate.getDate() + 1,
            0,
            0,
            0,
        );

        // حساب الفارق بالمللي ثانية
        const diffMs = cairoMidnight - cairoDate;
        const hoursLeft = diffMs / (1000 * 60 * 60);

        // التفعيل فقط إذا تبقى ساعتين أو أقل
        if (hoursLeft <= 2 && hoursLeft > 0) {
            clockEl.style.display = "block";
            const h = Math.floor((diffMs / (1000 * 60 * 60)) % 24);
            const m = Math.floor((diffMs / 1000 / 60) % 60);
            const s = Math.floor((diffMs / 1000) % 60);
            clockEl.innerHTML = `⏳ الوقت ينفد! متبقي للإغلاق: <span style="font-size: 22px; margin-right: 5px;">${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}</span>`;
        } else {
            clockEl.style.display = "none";
        }
    }, 1000);
}

// ==========================================
// عداد الدورة الأسبوعية (يحسب الوقت حتى منتصف ليل الجمعة/السبت)
// ==========================================
function startCycleCountdown() {
    const daysLeftEl = document.getElementById("days-left");
    if (!daysLeftEl) return;

    function update() {
        const now = getRealNow();
        const currentDay = now.getDay(); // الأحد = 0, الاثنين = 1, ... الجمعة = 5, السبت = 6

        // حساب الأيام المتبقية حتى يوم السبت القادم
        let daysUntilSat = 6 - currentDay;

        // إذا كان اليوم هو السبت، فالدورة تنتهي السبت القادم (بعد 7 أيام)
        if (daysUntilSat === 0) {
            daysUntilSat = 7;
        }

        // تحديد الهدف: السبت القادم الساعة 00:00:00 (منتصف ليل الجمعة)
        const targetDate = new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate() + daysUntilSat,
            0,
            0,
            0,
        );
        const diffMs = targetDate - now;

        if (diffMs <= 0) {
            daysLeftEl.innerHTML = `<span style="color: var(--danger); font-weight: bold;">جاري المحاسبة والتصفير ⚖️...</span>`;
            return;
        }

        const d = Math.floor(diffMs / (1000 * 60 * 60 * 24));
        const h = Math.floor((diffMs / (1000 * 60 * 60)) % 24);
        const m = Math.floor((diffMs / 1000 / 60) % 60);

        if (d > 0) {
            daysLeftEl.innerHTML = `<span style="font-weight:bold; color: var(--gold-primary); font-size: 20px;">${d}</span> أيام و <span style="font-weight:bold; color: var(--gold-primary);">${h}</span> ساعات`;
            daysLeftEl.style.color = "var(--text-main)";
            daysLeftEl.style.textShadow = "none";
        } else {
            // في اليوم الأخير (الجمعة) يتحول العداد للون الأحمر للتنبيه
            daysLeftEl.innerHTML = `⚠️ <span style="font-weight:bold; font-size: 20px;">${h}</span> ساعة و <span style="font-weight:bold;">${m}</span> دقيقة`;
            daysLeftEl.style.color = "var(--danger)";
            daysLeftEl.style.textShadow = "0 0 10px rgba(244,63,94,0.5)";
        }
    }

    update(); // تشغيل فوري
    setInterval(update, 60000); // تحديث كل دقيقة (كافي جداً لعداد الأيام/الساعات)
}

function initializeChecklists() {
    document.querySelectorAll(".checklist-container").forEach((container) => {
        const checkboxes = container.querySelectorAll(".task-checkbox");
        const labels = container.querySelectorAll(".checklist-item");
        const texts = container.querySelectorAll(".checklist-text");

        checkboxes.forEach((cb, idx) => {
            cb.addEventListener("change", function () {
                if (isTodayFinalized) {
                    this.checked = !this.checked; // منع التغيير إذا تم إنهاء اليوم
                    return;
                }

                const clickedIndex = parseInt(this.getAttribute("data-index"));

                // منطق الإلغاء المتبادل الذكي
                if (clickedIndex === 0 && this.checked) {
                    // إذا اختار الخيار الأول (صفر نقطة - لم أفعل)، قم بإلغاء باقي الخيارات
                    checkboxes.forEach((otherCb, otherIdx) => {
                        if (otherIdx !== 0) otherCb.checked = false;
                    });
                } else if (clickedIndex > 0 && this.checked) {
                    // إذا اختار مهمة فعلية، قم بإلغاء تحديد خيار الصفر
                    checkboxes[0].checked = false;
                }

                // تحديث الألوان والتصميم (UI)
                checkboxes.forEach((c, i) => {
                    labels[i].style.borderColor = c.checked
                        ? "var(--gold-primary)"
                        : "var(--border-color)";
                    texts[i].style.color = c.checked
                        ? "var(--gold-primary)"
                        : "var(--text-main)";
                });

                autoSaveTasks(); // الحفظ التلقائي للنقاط والمصفوفة
            });
        });
    });
}

// حالة المتصدرين الافتراضية
let currentLeaderboardMode = "challenge";

document.querySelectorAll(".toggle-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
        const mode = e.target.getAttribute("data-type");
        if (currentLeaderboardMode === mode) return; // منع إعادة التحميل لو ضغط على نفس الزر

        currentLeaderboardMode = mode;

        // تحريك الخلفية وتغيير الألوان (UI)
        document
            .querySelectorAll(".toggle-btn")
            .forEach((b) => b.classList.remove("active"));
        e.target.classList.add("active");

        const toggleContainer = document.getElementById("lb-toggle-container");
        if (mode === "global") {
            toggleContainer.classList.add("global-active");
        } else {
            toggleContainer.classList.remove("global-active");
        }

        // إعادة تحميل القائمة بالبيانات الجديدة
        loadLeaderboard();
    });
});

// ==========================================
// نظام البونص اليومي
// ==========================================
window.renderDailyTrivia = function (userData) {
    const container = document.getElementById("daily-trivia-container");
    if (!container) return;

    const realNow = getRealNow();
    const todayStr = getCairoDateString(realNow);

    const dateParts = todayStr.split("-");
    const numericDate = parseInt(dateParts[0] + dateParts[1] + dateParts[2]);
    const questionIndex = numericDate % dailyQuestions.length;
    const qData = dailyQuestions[questionIndex];

    const correctAnswerText = qData.answers.find((a) => a.t === 1).answer;

    // 1. جلب حالة إجابة اليوم من بيانات المستخدم
    const hasAnsweredToday = userData.lastDailyQuestionDate === todayStr;
    const userLastChoice = userData.lastDailyTriviaChoice; // النص الذي اختاره المستخدم

    let optionsHtml = qData.answers
        .map((opt) => {
            // ==========================================
            // حالة التجميد: المستخدم أجاب مسبقاً اليوم
            // ==========================================
            if (hasAnsweredToday) {
                let btnStyle =
                    "background: rgba(0,0,0,0.3); border: 1px solid var(--border-color); opacity: 0.4;";
                let iconHtml = "";

                if (opt.t === 1) {
                    // الإجابة الصحيحة دائماً تظهر بالأخضر
                    btnStyle =
                        "background: rgba(16, 185, 129, 0.15); border: 1px solid #10b981; opacity: 1;";
                    iconHtml =
                        '<i class="fa-solid fa-circle-check" style="color: #10b981; font-size: 18px;"></i>';
                } else if (opt.answer === userLastChoice) {
                    // الخيار الخاطئ الذي نقر عليه المستخدم يظهر بالأحمر
                    btnStyle =
                        "background: rgba(239, 68, 68, 0.15); border: 1px solid #ef4444; opacity: 1;";
                    iconHtml =
                        '<i class="fa-solid fa-circle-xmark" style="color: #ef4444; font-size: 18px;"></i>';
                }

                return `
                <button disabled class="gold-btn trivia-btn" style="${btnStyle} margin-bottom: 8px; text-align: right; display: flex; justify-content: space-between; align-items: center; width: 100%; cursor: not-allowed;">
                    <span>${opt.answer}</span>
                    <span class="status-icon">${iconHtml}</span>
                </button>`;
            }

            // ==========================================
            // الحالة النشطة: المستخدم لم يُجب بعد
            // ==========================================
            // مررنا opt.answer كمعامل جديد لنتمكن من حفظ اختياره
            return `
            <button onclick="submitTriviaAnswer(event, ${opt.t}, \`${opt.answer}\`, \`${correctAnswerText}\`, '${qData.link}')" class="gold-btn trivia-btn" data-correct="${opt.t}" style="background: rgba(0,0,0,0.3); border: 1px solid var(--border-color); margin-bottom: 8px; text-align: right; display: flex; justify-content: space-between; align-items: center; width: 100%; transition: all 0.3s ease;">
                <span>${opt.answer}</span>
                <span class="status-icon"></span>
            </button>`;
        })
        .join("");

    // رسالة العودة غداً والمصدر تظهر فقط إذا أجاب
    let messageHtml = "";
    if (hasAnsweredToday) {
        messageHtml = `
        <div style="text-align: center; margin-top: 15px;">
            <p style="font-weight: bold; color: var(--gold-primary); font-size: 14px;">تم تسجيل إجابتك. عد غداً لسؤال جديد ⏳</p>
            <a href="${qData.link}" target="_blank" style="display: inline-block; background: rgba(168, 85, 247, 0.1); border: 1px solid var(--gold-primary); padding: 5px 12px; border-radius: 8px; color: var(--gold-light); text-decoration: none; font-size: 12px; margin-top: 8px;"><i class="fa-solid fa-book-open"></i> اقرأ المصدر للاستزادة</a>
        </div>`;
    }

    container.innerHTML = `
        <div class="glass-card" style="border-color: var(--gold-primary); padding: 15px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                <h4 class="gold-text"><i class="fa-solid fa-question-circle"></i> سؤال اليوم</h4>
                <span style="direction: ltr; font-size: 13px; background: rgba(168, 85, 247, 0.2); padding: 2px 8px; border-radius: 12px; color: var(--gold-light);">+25 Score | +15 <i class="fa-solid fa-coins"></i></span>
            </div>
            <p style="font-size: 18px; margin-bottom: 15px; line-height: 1.6;">${qData.q}</p>
            <div style="display: flex; flex-direction: column;">
                ${optionsHtml}
            </div>
            ${messageHtml}
        </div>
    `;
};

window.submitTriviaAnswer = async function (
    event,
    isCorrect,
    selectedAnswerText, // المتغير الجديد لحفظ اختياره
    correctAnswerText,
    sourceLink,
) {
    if (!currentUser) return;

    const clickedBtn = event.currentTarget;
    const allBtns = document.querySelectorAll(".trivia-btn");

    // 1. تلوين الأزرار فوراً قبل النافذة المنبثقة
    allBtns.forEach((btn) => {
        btn.disabled = true;
        btn.style.cursor = "not-allowed";
        btn.style.opacity = "0.4";

        if (btn.getAttribute("data-correct") === "1") {
            btn.style.borderColor = "#10b981";
            btn.style.background = "rgba(16, 185, 129, 0.15)";
            btn.style.opacity = "1";
            btn.querySelector(".status-icon").innerHTML =
                '<i class="fa-solid fa-circle-check" style="color: #10b981; font-size: 18px;"></i>';
        }
    });

    if (isCorrect !== 1) {
        clickedBtn.style.borderColor = "#ef4444";
        clickedBtn.style.background = "rgba(239, 68, 68, 0.15)";
        clickedBtn.style.opacity = "1";
        clickedBtn.querySelector(".status-icon").innerHTML =
            '<i class="fa-solid fa-circle-xmark" style="color: #ef4444; font-size: 18px;"></i>';
    }

    setTimeout(async () => {
        const realNow = getRealNow();
        const todayStr = getCairoDateString(realNow);
        const userRef = doc(db, "users", currentUser.uid);

        const linkHtml = `<br><br><a href="${sourceLink}" target="_blank" style="display: inline-block; background: rgba(168, 85, 247, 0.1); border: 1px solid var(--gold-primary); padding: 8px 15px; border-radius: 8px; color: var(--gold-light); text-decoration: none; font-size: 13px; margin-top: 10px;"><i class="fa-solid fa-book-open"></i> اقرأ المصدر للاستزادة</a>`;

        // 2. تحديثات الداتا بيز (حفظ التاريخ + النص المختار)
        let dbUpdates = {
            lastDailyQuestionDate: todayStr,
            lastDailyTriviaChoice: selectedAnswerText,
        };

        if (isCorrect === 1) {
            dbUpdates.lifetimeScore = increment(25);
            dbUpdates.walletCoins = increment(15);
            try {
                await updateDoc(userRef, dbUpdates);
                new Audio(
                    "https://cdn.pixabay.com/download/audio/2021/08/04/audio_0625c1539c.mp3?filename=success-1-6297.mp3",
                )
                    .play()
                    .catch(() => {});
                await CustomDialog.alert(
                    "إجابة دقيقة! 🎉\nتمت إضافة +25 Score و +15 عملة لمحفظتك." +
                        linkHtml,
                    "بونص مستحق 🎁",
                );
                window.syncUserUI(); // عند التحديث سيُرسم السؤال وهو مجمد طوال اليوم
            } catch (error) {
                console.error(error);
            }
        } else {
            try {
                await updateDoc(userRef, dbUpdates);
                await CustomDialog.alert(
                    `إجابة خاطئة! ❌\nالإجابة الصحيحة هي: [ ${correctAnswerText} ]` +
                        linkHtml,
                    "للأسف",
                );
                window.syncUserUI();
            } catch (error) {
                console.error(error);
            }
        }
    }, 800);
};

// ==========================================
// نظام تجديد النية اليومي (Niyyah Reminder)
// ==========================================

// 1. تحويل الفحص إلى "بوابة انتظار" تجمد باقي الموقع
window.checkNiyyahReminder = function (userData) {
    return new Promise((resolve) => {
        const realNow = getRealNow();
        const todayStr = getCairoDateString(realNow);

        if (userData.lastNiyyahDate !== todayStr) {
            document.getElementById("niyyah-modal").style.display = "flex";
            // نربط فتح البوابة بمتغير عالمي لكي يستخدمه الزر لاحقاً
            window.resolveNiyyah = resolve;
        } else {
            // إذا كان مجدد النية مسبقاً، افتح البوابة فوراً بصمت
            resolve();
        }
    });
};

// 2. دالة الإخفاء تقوم بفتح البوابة والسماح للمنقذ بالظهور
window.dismissNiyyahReminder = async function () {
    if (!currentUser) return;

    const btn = document.getElementById("niyyah-btn");
    btn.innerHTML =
        'جاري توثيق النية... <i class="fa-solid fa-spinner fa-spin"></i>';
    btn.disabled = true;

    const realNow = getRealNow();
    const todayStr = getCairoDateString(realNow);
    const userRef = doc(db, "users", currentUser.uid);

    try {
        await updateDoc(userRef, { lastNiyyahDate: todayStr });
        document.getElementById("niyyah-modal").style.opacity = "0";

        setTimeout(() => {
            document.getElementById("niyyah-modal").style.display = "none";
            // إعادة الزر لحالته الأصلية
            btn.innerHTML = "فهمت";
            btn.disabled = false;

            // 🔥 هنا السحر: إعطاء الضوء الأخضر للمنقذ الذكي وباقي الموقع للعمل
            if (window.resolveNiyyah) window.resolveNiyyah();
        }, 300);
    } catch (error) {
        console.error("حدث خطأ أثناء حفظ النية:", error);
        btn.innerHTML = "حدث خطأ، حاول مجدداً";
        btn.disabled = false;
    }
};

// ==========================================
// تشغيل محرك الكاش (Service Worker)
// ==========================================
if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker
            .register("/sw.js")
            .then((registration) => {
                console.log(
                    "✅ تم تشغيل Service Worker بنجاح، النطاق:",
                    registration.scope,
                );
            })
            .catch((error) => {
                console.error("❌ فشل تشغيل Service Worker:", error);
            });
    });
}

// ==========================================
// 11. محرك المزامنة الشامل فولاذي (مزود بنظام القفل لمنع التداخل)
// ==========================================
window.isUIUpdating = false; // المتغير المسؤول عن القفل

window.syncUserUI = async function () {
    // 🛑 القفل: إذا لم يكن هناك مستخدم، أو كانت المزامنة جارية بالفعل، ارفض التنفيذ فوراً
    if (!currentUser || window.isUIUpdating) return;

    window.isUIUpdating = true; // إغلاق القفل

    try {
        const userDocSnap = await getDoc(doc(db, "users", currentUser.uid));
        if (!userDocSnap.exists()) return;
        const userData = userDocSnap.data();

        updateProfileUI(userData);

        await checkAndCelebrateBadges(
            userData,
            doc(db, "users", currentUser.uid),
        );

        if (typeof renderDailyTrivia === "function") {
            renderDailyTrivia(userData);
        }

        // تحديث الرأسية الديناميكية أثناء المزامنة
        const titleEl = document.getElementById("challenge-title");
        if (titleEl)
            titleEl.innerHTML = `🏆 الدورة التنافسية رقم: <span style="color: var(--gold-primary); font-size: 24px;">${currentCycle}</span>`;

        const targetEl = document.getElementById("daily-target");
        if (targetEl) targetEl.innerText = dailyTargetPoints;

        const costEl = document.getElementById("life-saver-cost");
        if (costEl) {
            const noteEl =
                costEl.closest(".challenge-note") || costEl.parentElement;
            if (noteEl) noteEl.style.display = "none";
        }

        const roomView = document.getElementById("active-room-view");
        const isRoomVisible =
            roomView && (roomView.offsetWidth > 0 || roomView.offsetHeight > 0);

        if (
            isRoomVisible &&
            typeof activeRoomId !== "undefined" &&
            activeRoomId
        ) {
            const roomRef = dbRef(rtdb, `study_rooms/${activeRoomId}`);
            const snap = await rtdbGet(roomRef);
            if (snap.exists()) {
                if (typeof renderRoomUI === "function")
                    renderRoomUI(snap.val());
            }
        } else {
            const activeTab =
                localStorage.getItem("dashboardActiveTab") || "tasks-page";

            if (activeTab === "tasks-page") {
                const realNow = getRealNow();
                const todayStr = getCairoDateString(realNow);
                const todayLogSnap = await getDoc(
                    doc(db, `users/${currentUser.uid}/dailyLogs`, todayStr),
                );
                let todayLogData = null;
                if (todayLogSnap.exists()) {
                    todayLogData = todayLogSnap.data();
                    isTodayFinalized = todayLogData.isFinalized || false;
                } else {
                    isTodayFinalized = false;
                }

                const pointsDisplay = document.getElementById("today-points");
                if (pointsDisplay)
                    pointsDisplay.innerText = todayLogData
                        ? todayLogData.pointsEarned || 0
                        : 0;

                await loadTasks(todayLogData, userData);
            } else if (activeTab === "leaderboard-page") {
                if (typeof loadLeaderboard === "function") loadLeaderboard();
            } else if (
                activeTab === "analytics-page" ||
                activeTab === "stats-page"
            ) {
                if (typeof loadAnalytics === "function") loadAnalytics();
            }
        }
    } catch (error) {
        console.error("فشل المزامنة الشاملة:", error);
    } finally {
        window.isUIUpdating = false; // 🔓 فتح القفل بعد انتهاء كل شيء
    }
};

// ==========================================
// 12. محرك السحب للتحديث (Pull-to-Refresh) - النسخة الديناميكية (Dynamic Safe Area)
// ==========================================
(function initPullToRefresh() {
    if (!document.getElementById("custom-ptr-style")) {
        const style = document.createElement("style");
        style.id = "custom-ptr-style";
        style.innerHTML = `
            #custom-ptr-indicator {
                position: fixed;
                /* إخفاء ديناميكي: يرتفع فوق منطقة الكاميرا بمسافة كافية */
                top: calc(-80px - env(safe-area-inset-top, 0px));
                left: 50%;
                transform: translateX(-50%);
                z-index: 999999;
                background: rgba(15, 10, 30, 0.95);
                border: 1px solid var(--gold-primary);
                color: var(--gold-primary);
                padding: 8px 24px;
                border-radius: 30px;
                font-size: 13px;
                font-weight: bold;
                display: flex;
                align-items: center;
                gap: 10px;
                box-shadow: 0 5px 20px rgba(0,0,0,0.8);
                transition: top 0.2s ease, background 0.2s ease, color 0.2s ease;
                backdrop-filter: blur(8px);
                -webkit-backdrop-filter: blur(8px);
                pointer-events: none;
            }
        `;
        document.head.appendChild(style);
    }

    if (document.getElementById("custom-ptr-indicator")) {
        document.getElementById("custom-ptr-indicator").remove();
    }

    const ptrIndicator = document.createElement("div");
    ptrIndicator.id = "custom-ptr-indicator";
    ptrIndicator.innerHTML =
        '<i class="fa-solid fa-arrow-down"></i> <span>اسحب للتحديث</span>';
    document.body.appendChild(ptrIndicator);

    function isScrolled(element) {
        let el = element;
        while (el && el !== document.body && el !== document.documentElement) {
            if (el.scrollTop > 0) return true;
            el = el.parentNode;
        }
        return window.scrollY > 0;
    }

    let startY = 0;
    let currentY = 0;
    let isPulling = false;
    const threshold = 80;

    document.addEventListener(
        "touchstart",
        (e) => {
            if (!isScrolled(e.target)) {
                startY = e.touches[0].clientY;
                currentY = startY;
                isPulling = true;
            } else {
                isPulling = false;
            }
        },
        { passive: true },
    );

    document.addEventListener(
        "touchmove",
        (e) => {
            if (!isPulling) return;

            currentY = e.touches[0].clientY;
            let pullDistance = currentY - startY;

            if (pullDistance > 0) {
                ptrIndicator.style.transition = "none";

                // حساب النزول ديناميكياً باستخدام calc و env
                let pullOffset = Math.min(pullDistance / 2 - 80, 25);
                ptrIndicator.style.top = `calc(${pullOffset}px + env(safe-area-inset-top, 0px))`;

                if (pullDistance > threshold) {
                    ptrIndicator.innerHTML =
                        '<i class="fa-solid fa-bolt"></i> <span>أفلت للتحديث</span>';
                    ptrIndicator.style.color = "#10b981";
                    ptrIndicator.style.borderColor = "#10b981";
                } else {
                    ptrIndicator.innerHTML =
                        '<i class="fa-solid fa-arrow-down"></i> <span>اسحب للتحديث</span>';
                    ptrIndicator.style.color = "var(--gold-primary)";
                    ptrIndicator.style.borderColor = "var(--gold-primary)";
                }

                if (e.cancelable) e.preventDefault();
            } else {
                isPulling = false;
            }
        },
        { passive: false },
    );

    document.addEventListener("touchend", async () => {
        if (!isPulling) return;
        isPulling = false;

        let pullDistance = currentY - startY;
        ptrIndicator.style.transition = "top 0.3s ease";

        if (pullDistance > threshold) {
            ptrIndicator.innerHTML =
                '<i class="fa-solid fa-spinner fa-spin"></i> <span>جاري المزامنة...</span>';

            // الوقوف بدقة تحت منطقة الكاميرا (مساحة الكاميرا + 25 بكسل)
            ptrIndicator.style.top =
                "calc(25px + env(safe-area-inset-top, 0px))";

            if (typeof window.syncUserUI === "function") {
                await window.syncUserUI();
            }

            setTimeout(() => {
                ptrIndicator.style.top =
                    "calc(-80px - env(safe-area-inset-top, 0px))";
            }, 600);
        } else {
            ptrIndicator.style.top =
                "calc(-80px - env(safe-area-inset-top, 0px))";
        }
    });
})();

// =========================================
// 🔓 محرك مهام فك القيود
// =========================================
const unchainingFileInput = document.getElementById("unchaining-proof-file");
const uploadUnchainingBtn = document.getElementById("upload-unchaining-btn");
const unchainingPreviewContainer = document.getElementById(
    "unchaining-preview-container",
);
const unchainingPreviewImg = document.getElementById("unchaining-preview-img");
const submitUnchainingBtn = document.getElementById("submit-unchaining-btn");

let unchainingImageFile = null;

uploadUnchainingBtn?.addEventListener("click", () => {
    unchainingFileInput.click();
});

// معاينة الصورة عند اختيارها
unchainingFileInput?.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) {
        unchainingImageFile = file;
        const reader = new FileReader();
        reader.onload = function (event) {
            unchainingPreviewImg.src = event.target.result;
            unchainingPreviewContainer.style.display = "block";
            submitUnchainingBtn.style.display = "block";
            uploadUnchainingBtn.innerText = "تغيير الصورة 🔄";
        };
        reader.readAsDataURL(file);
    }
});

// إرسال الإثبات للقاضي الآلي (مع التحقق المسبق الصارم)
submitUnchainingBtn?.addEventListener("click", async () => {
    if (!unchainingImageFile || !currentUser) return;

    // ==========================================
    // 🛡️ جدار الحماية المحلي (Pre-AI Firewall) - بتحديث السهر
    // ==========================================
    const now = new Date();
    const currentHour = now.getHours();

    // 1. التحقق من الوقت: مسموح بالرفع فقط من 10 مساءً (22) وحتى 4 فجراً (4)
    // بما أن الساعة الآن 2 صباحاً، هذا الشرط سيسمح لك بالمرور لتجربته.
    if (!(currentHour >= 22 || currentHour < 4)) {
        return CustomDialog.alert(
            "لا يمكنك فك القيود الآن. يجب رفع الإثبات في نهاية اليوم (بين 10 مساءً و 4 فجراً).",
            "مرفوض 🛑",
        );
    }

    // 2. فحص حداثة الصورة (يجب أن تكون التقطت خلال آخر 30 دقيقة كحد أقصى)
    // هذا يغنينا عن مشاكل اختلاف التاريخ بعد منتصف الليل، ويمنع التلاعب نهائياً.
    const fileTime = new Date(unchainingImageFile.lastModified);
    const diffMinutes = (now - fileTime) / (1000 * 60);

    if (diffMinutes > 30 || diffMinutes < 0) {
        return CustomDialog.alert(
            "هذا الإثبات قديم. يجب التقاط لقطة الشاشة ورفعها فوراً (خلال 30 دقيقة كحد أقصى). التقط واحدة جديدة الآن.",
            "إثبات باطل ❌",
        );
    }
    // ==========================================

    const confirmSubmit = await CustomDialog.confirm(
        "تجاوزت الفحص الأولي. سيتم الآن عرض صورتك على قاضي ذكاء اصطناعي صارم للتحقق من خلوها من التعديلات ومطابقتها للشروط. هل أنت جاهز؟",
        "تحليل الذكاء الاصطناعي 🤖",
    );
    if (!confirmSubmit) return;

    const originalText = submitUnchainingBtn.innerText;
    submitUnchainingBtn.innerText =
        "جاري التحليل بواسطة الذكاء الاصطناعي... 🤖⏳";
    submitUnchainingBtn.disabled = true;

    try {
        // 1. رفع الصورة لـ Storage وجلب الرابط مباشرة
        const storagePath = `unchaining_proofs/${currentUser.uid}_${Date.now()}`;
        const storageRefPath = ref(storage, storagePath);
        await uploadBytes(storageRefPath, unchainingImageFile);
        const imageUrl = await getDownloadURL(storageRefPath);

        // 2. إرسال المسار والرابط للقاضي الآلي
        const verifyProof = httpsCallable(functions, "verifyUnchainingProof");
        const result = await verifyProof({
            storagePath: storagePath,
            imageUrl: imageUrl,
        });

        // 3. استقبال الحكم
        if (result.data.success) {
            await CustomDialog.alert(
                "تم قبول الإثبات! لقد تحررت وعدت إلى المنطقة الخضراء.",
                "تم فك القيود ✅",
            );
            window.location.reload();
        } else {
            await CustomDialog.alert(
                `تم الرفض بواسطة الذكاء الاصطناعي 🤖:\n\n${result.data.message}`,
                "مرفوض ❌",
            );
            submitUnchainingBtn.innerText = originalText;
            submitUnchainingBtn.disabled = false;
        }
    } catch (error) {
        console.error("Error calling AI verification:", error);
        await CustomDialog.alert(
            "حدث خطأ أثناء التواصل مع القاضي الآلي. تأكد من اتصالك بالإنترنت.",
            "خطأ ❌",
        );
        submitUnchainingBtn.innerText = originalText;
        submitUnchainingBtn.disabled = false;
    }
});
