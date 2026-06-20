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
    where,
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
// 🛡️ نظام مزامنة الوقت الفائق (مضاد للانهيار)
// ==============================
let serverTimeAtLoad = null;
let performanceAtLoad = null;

async function syncTime() {
    try {
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
        console.warn(
            "ضعف في الإنترنت: تعذر جلب وقت السيرفر. سيتم استخدام وقت الجهاز مؤقتاً لتجنب شلل النظام.",
        );
        serverTimeAtLoad = Date.now(); // 🛑 السقوط الآمن: استخدام وقت الجهاز بدلاً من تدمير الموقع
    }
    performanceAtLoad = performance.now();
}

// هذه الدالة هي الوحيدة المسؤولة عن إعطائنا الوقت في كل الكود
function getRealNow() {
    // تمت إزالة throw new Error الكارثي الذي كان يوقف عمل الجافاسكربت بالكامل
    // الدالة الآن تعيد الوقت دائماً (سواء من السيرفر أو من الجهاز) لضمان عدم توقف الواجهة
    if (serverTimeAtLoad === null) {
        serverTimeAtLoad = Date.now();
        if (performanceAtLoad === null) performanceAtLoad = performance.now();
    }

    const elapsed = performance.now() - performanceAtLoad;
    return new Date(serverTimeAtLoad + elapsed);
}

// دالة صارمة لتحويل التاريخ و"إزاحة اليوم" برمجياً بناءً على ساعة السيرفر
function getCairoDateString(dateObj) {
    const cairoTimeStr = dateObj.toLocaleString("en-US", {
        timeZone: "Africa/Cairo",
        hour12: false,
    });
    const cairoDate = new Date(cairoTimeStr);
    const currentHour = cairoDate.getHours();

    // 🛑 السحر المعماري: إزاحة اليوم
    // إذا كانت الساعة الآن أقل من ساعة تصفير اليوم (مثلاً 3 فجراً أقل من 4)
    // نجبر النظام على اعتبارنا ما زلنا في "الأمس"
    if (currentHour < window.dayStartHour) {
        cairoDate.setDate(cairoDate.getDate() - 1);
    }

    // إرجاع التاريخ بصيغة YYYY-MM-DD يدوياً لضمان الدقة وتجنب اختلاف المتصفحات
    const year = cairoDate.getFullYear();
    const month = String(cairoDate.getMonth() + 1).padStart(2, "0");
    const day = String(cairoDate.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

let currentUser = null;
let currentCycle = 1; // الدورة الأسبوعية الحالية
let dailyTargetPoints = 0;
let isTodayFinalized = false;
window.dayStartHour = 4; // الافتراضي: 4 فجراً يبدأ اليوم الجديد
window.submissionStartHour = 21; // الافتراضي: 9 مساءً يفتح باب الاعتماد

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
            const sysData = sysDoc.data();
            currentCycle = sysData.currentCycle || 1;
            window.dayStartHour =
                sysData.dayStartHour !== undefined ? sysData.dayStartHour : 4;
            window.submissionStartHour =
                sysData.submissionStartHour !== undefined
                    ? sysData.submissionStartHour
                    : 21;
        }

        // إخفاء نافذة الانضمام القديمة نهائياً
        const joinModal = document.getElementById("join-challenge-modal");
        if (joinModal)
            joinModal.style.setProperty("display", "none", "important");

        // الدخول المباشر للمعركة للجميع
        await processActiveParticipant(userData, userDocRef);
        await checkAndCelebrateBadges(userData, userDocRef);

        loadLeaderboard();
        loadDailyWillpower(); // <--- تشغيل محرك الإرادة اليومية
        if (typeof window.loadUserReportsHistory === "function") {
            window.loadUserReportsHistory();
        }
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

        // تجهيز شكل الأوسمة للظهور لاحقاً مع دعم الوصف الجديد
        container.innerHTML = newBadges
            .map(
                (badge) => `
            <div style="background: rgba(30, 20, 50, 0.6); border: 1px solid #eab308; padding: 15px; border-radius: 16px; width: 140px; text-align: center; box-shadow: 0 0 20px rgba(234, 179, 8, 0.2); animation: floatBadge 3s ease-in-out infinite;">
                <img src="${badge.imagePath || badge.icon || "images/badge.webp"}" alt="Badge" style="width: 70px; height: 70px; object-fit: contain; margin-bottom: 10px; filter: drop-shadow(0 0 15px rgba(234,179,8,0.8));">
                <h4 style="font-size: 14px; color: #fef08a; margin: 0 0 5px 0; line-height: 1.3; font-weight: bold; text-shadow: 0 2px 4px rgba(0,0,0,0.8);">${badge.title}</h4>
                ${badge.description ? `<p style="font-size: 10px; color: #d1d5db; margin: 0; line-height: 1.4;">${badge.description}</p>` : ""}
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

        // 🛑 السر هنا: يتم تفعيل الصوت والألعاب النارية وتسجيل الاحتفال فقط بعد "النقرة"
        openBtn.onclick = async () => {
            // تحويل الدالة إلى async
            // 1. إخفاء الصندوق وإظهار التوهج والأوسمة
            giftBox.style.display = "none";
            revealContent.style.display = "block";
            glowBg.style.display = "block";

            // إضافة حركة الدخول للنافذة الجديدة
            revealContent.style.animation =
                "epicDrop 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards";

            // 2. تشغيل الصوت
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

            // 4. 🛑 التعديل الجذري: توثيق الاحتفال في الداتابيز "فقط" عند الضغط وفتح الهدية
            try {
                const newIds = newBadges.map((b) => b.id);
                await updateDoc(userDocRef, {
                    celebratedBadgeIds: arrayUnion(...newIds),
                });
            } catch (error) {
                console.error("فشل في توثيق استلام الأوسمة:", error);
            }
        };

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

    // ==============================
    // 🛡️ نظام خزانة الأوسمة والرفوف
    // ==============================
    const trophyContainer = document.getElementById("trophy-room-container");
    if (trophyContainer) {
        if (userData.badges && userData.badges.length > 0) {
            trophyContainer.innerHTML = "";

            const streakBadges = [];
            const topBadges = [];
            const otherBadges = [];

            // تصنيف الأوسمة لرفوف
            userData.badges.forEach((b) => {
                const id = (b.id || "").toLowerCase();
                if (id.includes("streak") || id.includes("fire"))
                    streakBadges.push(b);
                else if (
                    id.includes("top") ||
                    id.includes("rank") ||
                    id.includes("champion")
                )
                    topBadges.push(b);
                else otherBadges.push(b);
            });

            const renderShelf = (badgesArray, shelfName) => {
                if (badgesArray.length === 0) return "";
                badgesArray.sort((a, b) => new Date(b.date) - new Date(a.date));

                let html = `<div class="trophy-shelf" data-shelf-name="${shelfName}">`;
                badgesArray.forEach((badge) => {
                    const dateStr = new Date(badge.date).toLocaleDateString(
                        "en-GB",
                    );
                    const imgPath =
                        badge.imagePath || badge.icon || "images/badge.webp";
                    const descHtml = badge.description
                        ? `<p style="font-size: 10px; color: #9ca3af; margin: 5px 0; line-height: 1.4;">${badge.description}</p>`
                        : `<div style="margin-bottom: 5px;"></div>`;

                    html += `
                    <div class="trophy-item" style="width: 135px; padding: 15px 10px;">
                        <div style="display: flex; justify-content: center; align-items: center; font-size: 30px; margin-bottom: 10px; text-shadow: 0 0 10px var(--gold-glow);">
                            <img src="${imgPath}" alt="${badge.title}" style="width: 75px; height: 75px; object-fit: contain;">
                        </div>
                        <h4 style="font-size: 12px; color: var(--gold-light); margin: 0; line-height: 1.3;">${badge.title}</h4>
                        ${descHtml}
                        <span style="display: inline-block; margin-top: 5px; font-size: 10px; color: var(--text-muted); font-weight: bold; background: rgba(0,0,0,0.3); padding: 3px 8px; border-radius: 6px;">${dateStr}</span>
                    </div>`;
                });
                html += `</div>`;
                return html;
            };

            let finalTrophyHtml = "";
            finalTrophyHtml += renderShelf(
                topBadges,
                "🎖️ أوسمة الصدارة والمعارك",
            );
            finalTrophyHtml += renderShelf(
                streakBadges,
                "🔥 أوسمة الصمود والستريك",
            );
            finalTrophyHtml += renderShelf(otherBadges, "💼 أوسمة عامة");

            trophyContainer.innerHTML = finalTrophyHtml;
        } else {
            trophyContainer.innerHTML = `<p style="color: var(--text-muted); font-size: 14px; text-align: center;">لا توجد أوسمة حتى الآن. المعركة في بدايتها!</p>`;
        }
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

    // // ==============================
    // // تحديث شارة الرتبة والتقدم (النظام الجديد)
    // // ==============================
    // const lifetimeScore = userData.lifetimeScore || 0;
    // const rankDetails = getRankDetails(lifetimeScore);

    // const titleEl = document.getElementById("profile-rank-title");
    const scoreEl = document.getElementById("profile-lifetime-score");
    const progressEl = document.getElementById("profile-rank-progress");
    const nextRankTextEl = document.getElementById("profile-next-rank-text");
    const nextRankNameEl = document.getElementById("profile-next-rank-name");

    // if (titleEl) titleEl.innerHTML = rankDetails.title;

    // نظام الرتب والتخصيص
    const lifetimeScore = userData.lifetimeScore || 0;
    const rankDetails = getRankDetails(lifetimeScore);
    const titleEl = document.getElementById("profile-rank-title");
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

    // بناء اللقب
    // if (titleEl) {
    //     if (userData.customTagText || userData.customTagIcon) {
    //         const rawRankText = rankDetails.title
    //             .replace(/<[^>]*>?/gm, "")
    //             .trim(); // استخراج النص الصافي للرتبة
    //         const icon = userData.customTagIcon || "";
    //         const text = userData.customTagText || rawRankText;
    //         titleEl.innerHTML = `<span class="rank-vip-tag" style="padding: 5px 15px; border-radius: 20px; font-size: 20px;">${icon} ${text}</span>`;
    //     } else {
    //         titleEl.innerHTML = rankDetails.title;
    //     }
    // }
    // 🛑 بناء اللقب (يقرأ النص أو الأيقونة أو اللون، مع دعم الافتراضي)
    if (titleEl) {
        if (
            userData.customTagText ||
            userData.customTagIcon ||
            userData.customTagColor
        ) {
            const rawRankText = rankDetails.title
                .replace(/<[^>]*>?/gm, "")
                .trim();
            const textToUse = userData.customTagText
                ? userData.customTagText
                : rawRankText;
            const iconHtml = userData.customTagIcon
                ? `<i class="${userData.customTagIcon}" style="margin-left: 5px;"></i>`
                : "";

            // إذا لم يختر لوناً مخصصاً، نستخدم ستايل رتبته الأصلية
            const finalTagClass = userData.customTagColor
                ? `${userData.customTagColor}`
                : rankDetails.tagClass;

            titleEl.innerHTML = `<span class="${finalTagClass}" style="padding: 5px 15px; border-radius: 20px; font-size: 20px; display: inline-block;">${iconHtml} ${textToUse}</span>`;
        } else {
            titleEl.innerHTML = rankDetails.title;
        }
    }

    // 🛑 بناء إطار الصورة (الاعتماد على الكلاسات فقط)
    function applyAvatarFrame(wrapperId, customFrameClass) {
        const wrapper = document.getElementById(wrapperId);
        if (!wrapper) return;

        // تنظيف أي صورة قديمة (من النظام السابق لضمان عدم وجود عك في الـ HTML)
        const oldOverlay = wrapper.querySelector(".custom-frame-overlay");
        if (oldOverlay) oldOverlay.remove();

        // 🛑 تحديد الكلاس: إذا كان يمتلك فريم VIP (مثلاً frame-fire) نستخدمه، وإلا نستخدم فريم الرتبة
        const finalFrameClass = customFrameClass
            ? customFrameClass
            : getRankFrameClass(lifetimeScore || 0);
        wrapper.className = `avatar-wrapper ${finalFrameClass}`;
    }

    applyAvatarFrame("nav-avatar-wrapper", userData.customFrame);
    applyAvatarFrame("profile-avatar-wrapper", userData.customFrame);

    // إظهار المتجر الملكي للأساطير
    const vipItem = document.getElementById("vip-cosmetics-item");
    if (vipItem) {
        if ((userData.lifetimeScore || 0) >= 10000)
            vipItem.style.display = "flex";
        else vipItem.style.display = "none";
    }

    // ==============================
    // ⚖️ تحديث بطاقة تصنيف العقوبات (مبتدئ / متوسط / محترف)
    // ==============================
    const penaltyContainer = document.getElementById("penalty-rank-container");
    if (penaltyContainer) {
        const lifetimeScore = userData.lifetimeScore || 0;

        // فرز الجندي
        let isBeginner = lifetimeScore <= 1000;
        let isIntermediate = lifetimeScore > 1000 && lifetimeScore <= 5000;
        let isPro = lifetimeScore > 5000;

        if (isBeginner) {
            penaltyContainer.style.borderRightColor = "#34d399"; // أخضر
            penaltyContainer.style.background = "rgba(52, 211, 153, 0.05)";
            penaltyContainer.innerHTML = `
                <h4 style="color: #34d399; margin: 0 0 5px 0; font-size: 15px;"><i class="fa-solid fa-shield-halved"></i> تصنيف العقوبات: مبتدئ (0 - 1000 XP)</h4>
                <p style="color: var(--text-muted); font-size: 13px; margin: 0; line-height: 1.6;">أنت تتمتع بحصانة تامة. الفشل سيكسر ستريكك فقط، لكنك <b>محمي من الغرامات المالية</b> ولن تُطرد للمناطق الخطرة.</p>
            `;
        } else if (isIntermediate) {
            penaltyContainer.style.borderRightColor = "#fbbf24"; // برتقالي/أصفر
            penaltyContainer.style.background = "rgba(251, 191, 36, 0.05)";
            penaltyContainer.innerHTML = `
                <h4 style="color: #fbbf24; margin: 0 0 5px 0; font-size: 15px;"><i class="fa-solid fa-scale-balanced"></i> تصنيف العقوبات: متوسط (1001 - 5000 XP)</h4>
                <p style="color: var(--text-muted); font-size: 13px; margin: 0; line-height: 1.6;">لقد اشتد عودك. الفشل سيكسر ستريكك، يطردك للمنطقة الصفراء والحمراء، ويعرضك لخصم <span style="color:#fbbf24; font-weight:bold;">نصف الغرامة المالية</span> من محفظتك.</p>
            `;
        } else if (isPro) {
            penaltyContainer.style.borderRightColor = "#f43f5e"; // أحمر
            penaltyContainer.style.background = "rgba(244, 63, 94, 0.05)";
            penaltyContainer.innerHTML = `
                <h4 style="color: #f43f5e; margin: 0 0 5px 0; font-size: 15px;"><i class="fa-solid fa-skull"></i> تصنيف العقوبات: محترف (+5000 XP)</h4>
                <p style="color: var(--text-muted); font-size: 13px; margin: 0; line-height: 1.6;">أنت في ساحة الكبار ولا رحمة هنا. الفشل يطردك للمنطقة الصفراء والحمراء ويعرضك لخصم <span style="color:#f43f5e; font-weight:bold;">الغرامة المالية كاملة</span> بلا أي أعذار.</p>
            `;
        }
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

    // 🛑 الكنّاس الصامت: تنظيف الستريك المتعفن إذا انتهت الـ 24 ساعة
    if (userData.lostStreak > 0 && userData.streakDeathTimestamp) {
        const hoursSinceDeath =
            (getRealNow().getTime() - userData.streakDeathTimestamp) /
            (1000 * 60 * 60);
        if (hoursSinceDeath > 24) {
            userData.lostStreak = 0;
            userData.streakDeathTimestamp = null;
            await updateDoc(userDocRef, {
                lostStreak: 0,
                streakDeathTimestamp: null,
            });
        }
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
        console.log("🤖 [المنقذ الذكي] بدأ العمل...");
        console.log("📅 من تاريخ:", currentEvalDateStr, "إلى تاريخ:", limitStr);

        try {
            let currentStreak = userData.currentStreak || 0;
            let walletCoins = userData.walletCoins || 0;
            let lifetimeScore = userData.lifetimeScore || 0;
            let cycleScore = userData.cycleScore || 0;
            let currentZone = userData.currentZone || "green";
            let freezeCount = userData.freezeCount || 0;

            // 🛑 التعديل الجراحي: تثبيت الساعة 12 ظهراً لقتل ثغرة فرق التوقيت (Timezone Shift)
            let parts = currentEvalDateStr.split("-");
            let evalDate = new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0);
            evalDate.setDate(evalDate.getDate() + 1);

            let limitParts = limitStr.split("-");
            let limitDate = new Date(
                limitParts[0],
                limitParts[1] - 1,
                limitParts[2],
                12,
                0,
                0,
            );
            let messages = [];

            while (evalDate <= limitDate) {
                const dateStr = getCairoDateString(evalDate);
                console.log(`\n⏳ [المنقذ الذكي] جاري فحص يوم: ${dateStr}`);

                const logicalTimestamp = new Date(evalDate);
                logicalTimestamp.setHours(23, 59, 59);
                const logRef = doc(
                    db,
                    `users/${currentUser.uid}/dailyLogs`,
                    dateStr,
                );
                const logSnap = await getDoc(logRef);

                if (logSnap.exists() && logSnap.data().isFinalized) {
                    console.log(
                        `⏭️ [المنقذ الذكي] يوم ${dateStr} معتمد مسبقاً. تخطي.`,
                    );
                    currentEvalDateStr = dateStr;
                    evalDate.setDate(evalDate.getDate() + 1);
                    continue;
                }

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

                let missingRel = false;
                for (let id of importantRelTaskIds) {
                    let sel = religiousSelections[id];
                    let isDone = false;
                    if (typeof sel === "boolean") isDone = sel;
                    else if (Array.isArray(sel))
                        isDone =
                            sel.length > 1 ||
                            (sel.length === 1 && sel[0] !== 0);
                    else if (sel > 0) isDone = true;

                    if (!isDone) {
                        missingRel = true;
                        break;
                    }
                }

                let missingNorm = false;
                for (let id of importantNormTaskIds) {
                    let sel = selections[id];
                    let isDone = false;
                    if (Array.isArray(sel))
                        isDone =
                            sel.length > 1 ||
                            (sel.length === 1 && sel[0] !== 0);
                    else if (sel > 0) isDone = true;

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
                console.log(
                    `📊 [المنقذ الذكي] حالة يوم ${dateStr}: نجاح؟ ${passedToday}`,
                );

                if (passedToday) {
                    currentStreak++;
                    if (currentZone === "yellow") currentZone = "green";

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
                    cycleScore += earnedXP;
                    userData.currentMultiplier = streakMultiplier;

                    // let multiMsg =
                    //     streakMultiplier > 1
                    //         ? `(مضاعف x${streakMultiplier}) `
                    //         : "";
                    // messages.push(
                    //     `✅ يوم ${dateStr}: تم الاعتماد بنجاح ${multiMsg}(+${earnedXP} XP${xpLabel}) | الستريك: <i class="fa-solid fa-fire fa-fw"></i>${currentStreak}`,
                    // );
                    let multiMsg =
                        streakMultiplier > 1
                            ? `<span style="color: var(--gold-primary); font-size: 11px; background: rgba(168, 85, 247, 0.15); border: 1px solid rgba(168,85,247,0.3); padding: 2px 6px; border-radius: 4px; margin-right: 5px;">مضاعف الستريك x${streakMultiplier}</span>`
                            : "";

                    let doubleXPMsg =
                        xpLabel !== ""
                            ? `<span style="color: #fbbf24; font-size: 11px; background: rgba(251, 191, 36, 0.15); border: 1px solid rgba(251,191,36,0.3); padding: 2px 6px; border-radius: 4px; margin-right: 5px;">⚡ دبل XP</span>`
                            : "";

                    messages.push(`
    <div style="background: rgba(16, 185, 129, 0.05); border-right: 3px solid #10b981; padding: 12px; margin-bottom: 10px; border-radius: 6px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <strong style="color: #10b981; font-size: 14px;">✅ يوم ${dateStr}: نجاح مبهر</strong>
            <span style="color: #f8fafc; font-size: 13px; font-weight: bold; background: rgba(249, 115, 22, 0.15); padding: 2px 8px; border-radius: 12px; color: #f97316;"><i class="fa-solid fa-fire"></i> ${currentStreak}</span>
        </div>
        <div style="color: #cbd5e1; font-size: 13px; line-height: 1.8;">
            <i class="fa-solid fa-star fa-fw" style="color: var(--gold-primary);"></i> الخبرة: <b style="color: white;">+${earnedXP} XP</b><br>
            <i class="fa-solid fa-coins fa-fw" style="color: #fbbf24;"></i> العملات: <b style="color: white;">+${earnedCoins}</b>
        </div>
        <div style="margin-top: 10px;">
            ${multiMsg}
            ${doubleXPMsg}
        </div>
    </div>
`);

                    console.log(
                        `💾 [المنقذ الذكي] جاري حفظ نجاح يوم ${dateStr} في الداتابيز...`,
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
                            timestamp: logicalTimestamp,
                        },
                        { merge: true },
                    );
                    console.log(`✅ [المنقذ الذكي] تم حفظ النجاح بنجاح.`);
                } else {
                    if (freezeCount > 0) {
                        freezeCount--;
                        messages.push(`
                            <div style="background: rgba(6, 182, 212, 0.05); border-right: 3px solid #06b6d4; padding: 12px; margin-bottom: 10px; border-radius: 4px;">
                                <strong style="color: #06b6d4; font-size: 14px;">❄️ يوم ${dateStr}: تجميد ستريك</strong><br>
                                <span style="color: #cbd5e1; font-size: 13px;">تم استهلاك طوق نجاة، الستريك محمي من الكسر.</span>
                            </div>
                        `);
                        console.log(
                            `❄️ [المنقذ الذكي] جاري حفظ تجميد يوم ${dateStr}...`,
                        );
                        await setDoc(
                            logRef,
                            {
                                passed: false,
                                isFinalized: true,
                                pointsEarned: pointsEarned || 0,
                                date: dateStr,
                                timestamp: logicalTimestamp,
                            },
                            { merge: true },
                        );
                    } else {
                        console.log(
                            `💀 [المنقذ الذكي] بدء معالجة رسوب يوم ${dateStr}...`,
                        );
                        userData.lostStreak = currentStreak || 0;
                        userData.streakDeathTimestamp = Date.now();
                        currentStreak = 0;

                        // 🛑 1. فرز الجندي وتحديد رتبته العسكرية بناءً على الـ XP المتراكم
                        let isBeginner = lifetimeScore <= 1000;
                        let isIntermediate =
                            lifetimeScore > 1000 && lifetimeScore <= 5000;
                        let isPro = lifetimeScore > 5000;

                        let safeTarget =
                            typeof dailyTargetPoints !== "undefined" &&
                            !isNaN(dailyTargetPoints)
                                ? Number(dailyTargetPoints)
                                : 100;
                        let penaltyCoins = 0;

                        // 🛑 2. تنفيذ العقوبات الطبقية الصارمة وتنسيق التقرير
                        let failCard = `<div style="background: rgba(244, 63, 94, 0.05); border-right: 3px solid #f43f5e; padding: 12px; margin-bottom: 10px; border-radius: 4px;">`;
                        failCard += `<strong style="color: #f43f5e; font-size: 14px;">❌ يوم ${dateStr}: تخاذل وفشل</strong><br>`;
                        failCard += `<span style="color: #cbd5e1; font-size: 13px;">العقوبة الأساسية: كسر الستريك للصفر 💔</span><br>`;

                        if (isBeginner) {
                            failCard += `<hr style="border-color: rgba(255,255,255,0.05); margin: 8px 0;">`;
                            failCard += `<span style="color: #34d399; font-size: 12px;"><i class="fa-solid fa-shield-halved"></i> <b>المستوى [مبتدئ]:</b> إعفاء كامل من الغرامات والطرد.</span>`;
                        } else if (isIntermediate) {
                            if (currentZone === "green") currentZone = "yellow";
                            else if (currentZone === "yellow")
                                currentZone = "red";

                            penaltyCoins = Math.floor(safeTarget / 2);
                            walletCoins =
                                (Number(walletCoins) || 0) - penaltyCoins;

                            failCard += `<span style="color: #fca5a5; font-size: 13px;">الغرامة: -${penaltyCoins} عملة 📉 | الحالة: ${currentZone === "yellow" ? "منطقة صفراء ⚠️" : "منطقة حمراء 🛑"}</span><br>`;
                            failCard += `<hr style="border-color: rgba(255,255,255,0.05); margin: 8px 0;">`;
                            failCard += `<span style="color: var(--text-muted); font-size: 12px;"><i class="fa-solid fa-scale-balanced"></i> <b>المستوى [متوسط]:</b> تم تطبيق نصف الغرامة المالية.</span>`;
                        } else if (isPro) {
                            if (currentZone === "green") currentZone = "yellow";
                            else if (currentZone === "yellow")
                                currentZone = "red";

                            penaltyCoins = safeTarget;
                            walletCoins =
                                (Number(walletCoins) || 0) - penaltyCoins;

                            failCard += `<span style="color: #fca5a5; font-size: 13px;">الغرامة: -${penaltyCoins} عملة 📉 | الحالة: ${currentZone === "yellow" ? "منطقة صفراء ⚠️" : "منطقة حمراء 🛑"}</span><br>`;
                            failCard += `<hr style="border-color: rgba(255,255,255,0.05); margin: 8px 0;">`;
                            failCard += `<span style="color: #ef4444; font-size: 12px;"><i class="fa-solid fa-skull"></i> <b>المستوى [محترف]:</b> تم تطبيق الغرامة القصوى. لا رحمة في هذا المستوى.</span>`;
                        }
                        failCard += `</div>`;
                        messages.push(failCard);

                        console.log(
                            `💾 [المنقذ الذكي] جاري حفظ رسوب يوم ${dateStr} في الداتابيز...`,
                        );
                        await setDoc(
                            logRef,
                            {
                                passed: false,
                                isFinalized: true,
                                pointsEarned: pointsEarned || 0, // لن يتم تصفيرها هنا، التصفير يحدث في الفشل الكارثي (الخطوة 3)
                                date: dateStr,
                                selections: selections || {},
                                religiousSelections: religiousSelections || {},
                                timestamp: new Date(),
                            },
                            { merge: true },
                        );
                        console.log(`✅ [المنقذ الذكي] تم حفظ الرسوب بنجاح.`);
                    }
                }
                currentEvalDateStr = dateStr;
                evalDate.setDate(evalDate.getDate() + 1);
            }

            let updates = {
                lifetimeScore,
                walletCoins,
                currentStreak,
                lostStreak: userData.lostStreak || 0,
                streakDeathTimestamp: userData.streakDeathTimestamp || null,
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

            console.log(
                "📦 [المنقذ الذكي] جاهز لتحديث ملفك الشخصي بالبيانات التالية:",
                updates,
            );
            await updateDoc(userDocRef, updates);
            console.log("✅ [المنقذ الذكي] تم تحديث ملفك الشخصي بنجاح.");

            const loader = document.getElementById("global-loader");
            if (loader) loader.classList.add("hidden");

            if (messages.length > 0) {
                await CustomDialog.alert(
                    `<div style="text-align: right; max-height: 60vh; overflow-y: auto; padding-left: 5px;">${messages.join("")}</div>`,
                    "تقرير التحقق الرجعي 🤖",
                );
            }
        } catch (error) {
            console.error(
                "🚨🚨🚨 [المنقذ الذكي] انهيار قااااتل (CRASH):",
                error,
            );
            const loader = document.getElementById("global-loader");
            if (loader) loader.classList.add("hidden");
            await CustomDialog.alert(
                "انهار المنقذ الذكي! افتح الـ Console (F12) وصور لي الخطأ الأحمر، أو انسخ هذا:\n" +
                    error.message,
                "خطأ برمجي ❌",
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

    await loadTasks(todayLogData, userData);
    startDoomsdayClock();
    startCycleCountdown();
    renderDailyTrivia(userData);
    await loadReligiousTasks(todayLogData);
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
    // 🛑 استرجاع بيانات البكرات من الداتابيز ورسمها
    if (typeof window.restoreTimePickers === "function") {
        window.restoreTimePickers(todayLogData);
    }
    if (isTodayFinalized) disableSubmitButton();
    else autoSaveTasks(false);
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
    document
        .querySelectorAll(
            ".custom-select-wrapper:not(.rel-custom-select-wrapper)",
        )
        .forEach((wrapper) => {
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
// let deviceCount = 0;

// window.addDeviceBlock = function () {
//     const container = document.getElementById("devices-container");
//     if (!container) return;

//     deviceCount++;
//     const deviceId = `device-${deviceCount}`;
//     const div = document.createElement("div");
//     div.className = "device-block";
//     div.id = deviceId;
//     div.style.cssText =
//         "background: rgba(0,0,0,0.2); border: 1px solid var(--border-color); padding: 15px; border-radius: 8px; margin-bottom: 15px; position: relative;";

//     // زر الحذف يظهر فقط إذا كان هناك أكثر من جهاز
//     const deleteBtnHtml =
//         deviceCount > 1
//             ? `<button onclick="document.getElementById('${deviceId}').remove()" style="position: absolute; top: 10px; left: 10px; background: none; border: none; color: var(--danger); cursor: pointer; font-size: 16px;"><i class="fa-solid fa-trash"></i></button>`
//             : "";

//     div.innerHTML = `
//         ${deleteBtnHtml}
//         <h4 style="color: var(--gold-primary); margin-bottom: 15px; font-size: 14px;">جهاز رقم ${deviceCount}</h4>

//         <div style="display: flex; gap: 10px; margin-bottom: 15px;">
//             <div style="flex: 1;">
//                 <label style="font-size: 11px; color: var(--text-muted);">إجمالي وقت الشاشة</label>
//                 <div style="display: flex; gap: 5px; margin-top: 5px;">
//                     <input type="number" class="dialog-input st-h" min="0" max="24" placeholder="ساعة" style="margin: 0; text-align: center; padding: 8px; flex: 1;">
//                     <span style="display: flex; align-items: center; color: var(--text-muted);">:</span>
//                     <input type="number" class="dialog-input st-m" min="0" max="59" placeholder="دقيقة" style="margin: 0; text-align: center; padding: 8px; flex: 1;">
//                 </div>
//             </div>
//             <div style="flex: 1;">
//                 <label style="font-size: 11px; color: var(--text-muted);">منها Shorts/Reels</label>
//                 <div style="display: flex; gap: 5px; margin-top: 5px;">
//                     <input type="number" class="dialog-input sh-h" min="0" max="24" placeholder="ساعة" style="margin: 0; text-align: center; padding: 8px; flex: 1;">
//                     <span style="display: flex; align-items: center; color: var(--text-muted);">:</span>
//                     <input type="number" class="dialog-input sh-m" min="0" max="59" placeholder="دقيقة" style="margin: 0; text-align: center; padding: 8px; flex: 1;">
//                 </div>
//             </div>
//         </div>

//         <div>
//             <label style="font-size: 12px; color: var(--text-muted); display: block; margin-bottom: 5px;">صورة الإثبات (Screenshot):</label>
//             <input type="file" accept="image/*" class="device-proof-file" style="width: 100%; font-size: 12px; padding: 8px; border: 1px dashed var(--border-color); border-radius: 6px; background: rgba(0,0,0,0.3); color: white;">
//         </div>
//     `;
//     container.appendChild(div);
// };

// تهيئة أول جهاز عند تحميل المهام
// document.addEventListener("DOMContentLoaded", () => {
//     // استخدمنا setTimeout لضمان أن DOM جاهز تماماً
//     setTimeout(() => {
//         if (
//             document.getElementById("devices-container") &&
//             document.getElementById("devices-container").children.length === 0
//         ) {
//             window.addDeviceBlock();
//         }
//         const addBtn = document.getElementById("add-device-btn");
//         if (addBtn) addBtn.addEventListener("click", window.addDeviceBlock);
//     }, 500);
// });

// دالة جمع الوقت من كل الأجهزة المضافة
// window.calculateTotalDopamineTime = function () {
//     let totalScreenMinutes = 0;
//     let totalShortsMinutes = 0;
//     let isValid = false; // تصبح true لو أدخل بيانات جهاز واحد على الأقل
//     let files = [];

//     document.querySelectorAll(".device-block").forEach((block) => {
//         const stH = parseInt(block.querySelector(".st-h").value) || 0;
//         const stM = parseInt(block.querySelector(".st-m").value) || 0;
//         const shH = parseInt(block.querySelector(".sh-h").value) || 0;
//         const shM = parseInt(block.querySelector(".sh-m").value) || 0;

//         const fileInput = block.querySelector(".device-proof-file");
//         if (fileInput && fileInput.files.length > 0) {
//             files.push(fileInput.files[0]);
//         }

//         const deviceScreenMinutes = stH * 60 + stM;
//         const deviceShortsMinutes = shH * 60 + shM;

//         totalScreenMinutes += deviceScreenMinutes;
//         totalShortsMinutes += deviceShortsMinutes;

//         // إذا أدخل وقتاً أكبر من صفر، نعتبر الإدخال صالحاً
//         if (deviceScreenMinutes > 0) isValid = true;
//     });

//     return { totalScreenMinutes, totalShortsMinutes, isValid, files };
// };

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
// 🛡️ فحص صلاحية الصورة (التاريخ + الوقت)
// ==========================================
function validateProofImage(file) {
    return new Promise((resolve) => {
        const now = getRealNow();

        // todayStr = التاريخ المنطقي للنظام (مع إزاحة dayStartHour)
        const todayStr = getCairoDateString(now);

        // cairoNow = التاريخ الحقيقي بتوقيت القاهرة بدون إزاحة
        const cairoNowStr = now.toLocaleString("en-US", {
            timeZone: "Africa/Cairo",
            hour12: false,
        });
        const cairoNow = new Date(cairoNowStr);

        // 🛑 بناء قائمة التواريخ المقبولة بدلاً من تاريخ واحد
        // نقبل: تاريخ اليوم المنطقي + التاريخ الحقيقي (لحل مشكلة ما بعد منتصف الليل)
        const acceptedDates = new Set();

        // 1. اليوم المنطقي للنظام (مثلاً: 7 يونيو إذا الساعة 1 فجراً)
        acceptedDates.add(todayStr);

        // 2. التاريخ الميلادي الحقيقي (مثلاً: 8 يونيو إذا الساعة 1 فجراً)
        const realY = cairoNow.getFullYear();
        const realM = String(cairoNow.getMonth() + 1).padStart(2, "0");
        const realD = String(cairoNow.getDate()).padStart(2, "0");
        const realTodayStr = `${realY}-${realM}-${realD}`;
        acceptedDates.add(realTodayStr);

        // 3. أمس المنطقي (للساعات الأولى من الفجر - نسمح بصور الليلة الماضية)
        const yesterdayDate = new Date(now);
        yesterdayDate.setDate(yesterdayDate.getDate() - 1);
        const yesterdayStr = getCairoDateString(yesterdayDate);
        // نسمح بالأمس فقط في الساعات الأولى (قبل dayStartHour)
        if (cairoNow.getHours() < window.dayStartHour) {
            acceptedDates.add(yesterdayStr);
        }

        console.log(`[validateProofImage] التواريخ المقبولة:`, [
            ...acceptedDates,
        ]);

        function checkDateOnly(fileDateStr, source) {
            console.log(
                `[${source}] تاريخ الصورة: ${fileDateStr} | المقبول: ${[...acceptedDates].join(", ")}`,
            );

            if (!acceptedDates.has(fileDateStr)) {
                // نعرض للمستخدم "تاريخ اليوم المنطقي" في رسالة الخطأ لأنه أوضح
                resolve({
                    valid: false,
                    reason: `📅 تاريخ الصورة (${fileDateStr}) لا يطابق تاريخ اليوم (${todayStr}).\nيجب رفع لقطة شاشة التقطتها اليوم فقط.`,
                });
                return;
            }
            resolve({ valid: true });
        }

        // محاولة EXIF أولاً
        if (typeof EXIF !== "undefined") {
            EXIF.getData(file, function () {
                const exifDate = EXIF.getTag(this, "DateTimeOriginal");
                if (exifDate) {
                    const parts = exifDate.split(" ");
                    const d = parts[0].split(":");
                    const t = parts[1].split(":");
                    const exifObj = new Date(
                        +d[0],
                        +d[1] - 1,
                        +d[2],
                        +t[0],
                        +t[1],
                        +t[2],
                    );
                    const cairoStr = exifObj.toLocaleString("en-US", {
                        timeZone: "Africa/Cairo",
                        hour12: false,
                    });
                    const cairoExif = new Date(cairoStr);
                    const y = cairoExif.getFullYear();
                    const m = String(cairoExif.getMonth() + 1).padStart(2, "0");
                    const dd = String(cairoExif.getDate()).padStart(2, "0");
                    checkDateOnly(`${y}-${m}-${dd}`, "EXIF");
                } else {
                    fallbackToLastModified();
                }
            });
        } else {
            fallbackToLastModified();
        }

        function fallbackToLastModified() {
            const fileDate = new Date(file.lastModified);
            const cairoStr = fileDate.toLocaleString("en-US", {
                timeZone: "Africa/Cairo",
                hour12: false,
            });
            const d = new Date(cairoStr);
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, "0");
            const dd = String(d.getDate()).padStart(2, "0");
            checkDateOnly(`${y}-${m}-${dd}`, "lastModified");
        }
    });
}

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
// تحويل صيغة (HH:MM) إلى إجمالي دقائق صافية للحسابات الرياضية
function timeToMinutes(timeStr) {
    if (!timeStr) return 0;
    // فصل الساعات عن الدقائق وتحويلها لأرقام
    const [h, m] = timeStr.split(":").map(Number);
    return h * 60 + m;
}
// ==========================================
// 🔄 استرجاع بيانات بكرات الوقت المحفوظة
// ==========================================
window.restoreTimePickers = function (todayLogData) {
    const totalH_el = document.getElementById("picker-total-h");
    if (totalH_el && totalH_el.children.length === 0) {
        if (typeof initAllTimePickers === "function") initAllTimePickers();
    }

    let th = 0,
        tm = 0,
        sh = 0,
        sm = 0,
        oh = 0,
        om = 0,
        shortsH = 0,
        shortsM = 0;
    const todayStr = getCairoDateString(getRealNow());

    // 1. إذا كان اليوم معتمداً ومسجلاً في الداتابيز، نعرضه كأرشيف
    if (
        isTodayFinalized &&
        todayLogData &&
        todayLogData.dopamineData &&
        todayLogData.dopamineData.evaluationMode === "honor_system"
    ) {
        const dop = todayLogData.dopamineData;

        th = Math.floor((dop.reportedTotalMinutes || 0) / 60);
        tm = (dop.reportedTotalMinutes || 0) % 60;
        sh = Math.floor((dop.reportedStudyMinutes || 0) / 60);
        sm = (dop.reportedStudyMinutes || 0) % 60;
        const totalOthers = dop.reportedOthersMinutes || 0;
        oh = Math.floor(totalOthers / 60);
        om = totalOthers % 60;
        const totalShorts = dop.reportedShortsMinutes || 0;
        shortsH = Math.floor(totalShorts / 60);
        shortsM = totalShorts % 60;
    }
    // 2. إذا لم يُعتمد اليوم، نسحب من المسودة المحلية (LocalStorage) لتخفيف الإحباط
    else {
        try {
            const localData = JSON.parse(
                localStorage.getItem("brainrot_time_pickers"),
            );
            if (localData && localData.date === todayStr) {
                th = localData.th || 0;
                tm = localData.tm || 0;
                sh = localData.sh || 0;
                sm = localData.sm || 0;
                oh = localData.oh || 0;
                om = localData.om || 0;
                shortsH = localData.shortsH || 0;
                shortsM = localData.shortsM || 0;
            } else {
                // إذا كان التاريخ قديماً (يوم جديد)، نحرق المسودة القديمة
                localStorage.removeItem("brainrot_time_pickers");
            }
        } catch (e) {
            console.warn("فشل قراءة البكرات من المتصفح", e);
        }
    }

    const scrollToVal = (columnId, val) => {
        const column = document.getElementById(columnId);
        if (column && column.children.length > 0) {
            column.setAttribute("data-value", val);
            Array.from(column.children).forEach((child, idx) => {
                if (idx === val) child.classList.add("active");
                else child.classList.remove("active");
            });
            column.scrollTop = val * 40;
        }
    };

    scrollToVal("picker-total-h", th);
    scrollToVal("picker-total-m", tm);
    scrollToVal("picker-study-h", sh);
    scrollToVal("picker-study-m", sm);
    scrollToVal("picker-others-h", oh);
    scrollToVal("picker-others-m", om);
    scrollToVal("picker-shorts-h", shortsH);
    scrollToVal("picker-shorts-m", shortsM);

    // تحديث الشاشة الديناميكية فوراً عند استرجاع الكاش
    setTimeout(() => {
        if (typeof window.calculateLiveScores === "function")
            window.calculateLiveScores();
    }, 800);
};

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
    document.querySelectorAll(".tasks-list-class").forEach((wrapper) => {
        wrapper.style.pointerEvents = "none";
        wrapper.style.cursor = "not-allowed";
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
    document.querySelectorAll(".task-item").forEach((lbl) => {
        lbl.style.cursor = "not-allowed";
        lbl.style.opacity = "0.5";
    });

    const dopamineCard = document.getElementById("dopamine-analyzer-card");
    if (dopamineCard) {
        dopamineCard.style.pointerEvents = "none";
        dopamineCard.style.opacity = "0.5";
    }
    const aiBtn = document.getElementById("ai-extract-btn");
    if (aiBtn) {
        aiBtn.style.pointerEvents = "none";
        aiBtn.style.opacity = "0.5";
        aiBtn.style.cursor = "not-allowed";
        aiBtn.title = "تم اعتماد اليوم، لا يمكن تعديل بيانات الدوبامين الآن";
    }
    const evaluationSection = document.getElementById(
        "honor-evaluation-section",
    );
    if (evaluationSection) {
        evaluationSection.style.pointerEvents = "none";
        evaluationSection.style.opacity = "0.5";
    }

    // 🛑 تجميد بكرات محاكمة الضمير (Honor System Lockdown)
    document.querySelectorAll(".time-picker-wrapper").forEach((wrapper) => {
        wrapper.style.pointerEvents = "none"; // يمنع النقر أو تفعيل الكتابة
        wrapper.style.opacity = "0.6"; // يجعلها باهتة قليلاً لتبدو مغلقة
    });

    document.querySelectorAll(".picker-column").forEach((column) => {
        column.style.overflowY = "hidden"; // يمنع السحب (Scroll) نهائياً
    });
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

            // const rankInfo = getRankDetails(user.lifetimeScore || 0);
            // const frameClass = getRankFrameClass(user.lifetimeScore || 0);
            const rankInfo = getRankDetails(user.lifetimeScore || 0);

            // تخصيص اللقب
            // let displayTagText = rankInfo.title;
            // let tagClass = rankInfo.tagClass;

            // if (user.customTagText || user.customTagIcon) {
            //     const rawRankText = rankInfo.title
            //         .replace(/<[^>]*>?/gm, "")
            //         .trim();
            //     const icon = user.customTagIcon || "";
            //     const text = user.customTagText || rawRankText;
            //     displayTagText = `${icon} ${text}`;
            //     tagClass = "rank-vip-tag";
            // }

            // 🛑 تخصيص اللقب في المتصدرين
            let displayTagText = rankInfo.title;
            let tagClass = rankInfo.tagClass;

            if (
                user.customTagText ||
                user.customTagIcon ||
                user.customTagColor
            ) {
                const rawRankText = rankInfo.title
                    .replace(/<[^>]*>?/gm, "")
                    .trim();
                const textToUse = user.customTagText
                    ? user.customTagText
                    : rawRankText;
                const iconHtml = user.customTagIcon
                    ? `<i class="${user.customTagIcon}" style="margin-left: 3px;"></i>`
                    : "";

                displayTagText = `${iconHtml} ${textToUse}`.trim();
                tagClass = user.customTagColor
                    ? `${user.customTagColor}`
                    : rankInfo.tagClass;
            }

            const displayedScore = getDisplayScore(user);

            const userDiv = document.createElement("div");
            userDiv.className = `leaderboard-item ${hoverClass}`;

            // الحل الهندسي لمشكلة الأسماء الإنجليزية (align-items: flex-start + dir="auto")
            // userDiv.innerHTML = `
            //     <div class="leaderboard-user-info" style="min-width: 0;">
            //         <div class="rank-badge ${badgeClass}" style="${customStyle}">#${currentRank}</div>
            //         <div class="avatar-wrapper ${frameClass}" style="width: 45px; height: 45px; flex-shrink: 0;">
            //             <img src="${user.photoURL || "images/profile.webp"}" alt="Avatar">
            //         </div>
            //         <div style="display: flex; flex-direction: column; gap: 3px; min-width: 0; align-items: flex-start; text-align: right;">
            //             <span class="leaderboard-name" dir="auto" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${user.name}</span>
            //             <span class="rank-tag ${rankInfo.tagClass}">${rankInfo.title}</span>
            //         </div>
            //     </div>

            //     <div class="leaderboard-stats" style="flex-shrink: 0;">
            //         ${streakHtml}
            //         <span class="task-points-badge">${displayedScore}</span>
            //     </div>
            // `;

            // 🛑 تخصيص الفريم (الاعتماد على الكلاسات فقط)
            // إذا كان عنده فريم مشتريه (كلاس) نستخدمه، لو لأ نستخدم فريم الرتبة الافتراضي
            const frameClass = user.customFrame
                ? user.customFrame
                : getRankFrameClass(user.lifetimeScore || 0);

            userDiv.innerHTML = `
                <div class="leaderboard-user-info" style="min-width: 0;">
                    <div class="rank-badge ${badgeClass}" style="${customStyle}">#${currentRank}</div>
                    
                    <div class="avatar-wrapper ${frameClass}" style="width: 60px; height: 60px; flex-shrink: 0;">
                        <img src="${user.photoURL || "images/profile.webp"}" alt="Avatar">
                    </div>

                    <div style="display: flex; flex-direction: column; gap: 3px; min-width: 0; align-items: flex-start; text-align: right;">
                        <span class="leaderboard-name" dir="auto" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${user.name}</span>
                        <span class="rank-tag ${tagClass}">${displayTagText}</span>
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

    // 🛑 التعديل 1: معالجة اللقب (Tag) الملكي أو العادي 🛑
    // let displayTagText = rankInfo.title;
    // let tagClass = rankInfo.tagClass;

    // if (user.customTagText || user.customTagIcon) {
    //     const rawRankText = rankInfo.title.replace(/<[^>]*>?/gm, "").trim();
    //     const icon = user.customTagIcon || "";
    //     const text = user.customTagText || rawRankText;
    //     displayTagText = `${icon} ${text}`;
    //     tagClass = "rank-vip-tag"; // إعطاء ستايل VIP
    // }

    // 🛑 معالجة اللقب (Tag) الملكي والألوان والأيقونات 🛑
    let displayTagText = rankInfo.title;
    let tagClass = rankInfo.tagClass;

    if (user.customTagText || user.customTagIcon || user.customTagColor) {
        const rawRankText = rankInfo.title.replace(/<[^>]*>?/gm, "").trim();
        const textToUse = user.customTagText ? user.customTagText : rawRankText;
        const iconHtml = user.customTagIcon
            ? `<i class="${user.customTagIcon}" style="margin-left: 3px;"></i>`
            : "";

        displayTagText = `${iconHtml} ${textToUse}`.trim();
        tagClass = user.customTagColor
            ? `${user.customTagColor}`
            : rankInfo.tagClass;
    }

    document.getElementById("modal-user-name").innerText = user.name;
    document.getElementById("modal-user-name").innerHTML +=
        `<br><span class="rank-tag ${tagClass}" style="display: inline-block; margin-top: 5px; font-size: 13px;">${displayTagText}</span>`;

    document.getElementById("modal-user-rank").innerText = `#${user.rank}`;

    const pointsEl = document.getElementById("modal-user-points");
    const streakEl = document.getElementById("modal-user-streak");

    if (currentLeaderboardMode === "challenge") {
        pointsEl.innerHTML = `${user.cycleScore || 0} <i class="fa-solid fa-trophy" style="color: var(--gold-primary);"></i>`;
        streakEl.style.display = "inline-block";
        streakEl.innerHTML = `<i class="fa-solid fa-fire fa-fw"></i> ${user.currentStreak || 0}`;
        document
            .getElementById("streak-box")
            ?.style.setProperty("display", "inline", "important");
    } else {
        pointsEl.innerHTML = `${user.lifetimeScore || 0} <i class="fa-solid fa-medal"></i>`;
        document
            .getElementById("streak-box")
            ?.style.setProperty("display", "none", "important");
        streakEl.style.display = "none";
    }

    // 🛑 معالجة إطار الصورة الملكي (Frame) عبر الكلاسات النظيفة 🛑
    const avatarWrapper = document.getElementById("modal-avatar-wrapper");

    // تنظيف أي صورة قديمة (من النظام السابق لضمان عدم وجود عك)
    const oldOverlay = avatarWrapper.querySelector(".custom-frame-overlay");
    if (oldOverlay) oldOverlay.remove();

    // 🛑 تحديد الكلاس: إذا كان يمتلك فريم (مثلاً frame-diamond) نستخدمه، وإلا نستخدم فريم الرتبة
    const finalFrameClass = user.customFrame
        ? user.customFrame
        : getRankFrameClass(user.lifetimeScore || 0);
    avatarWrapper.className = `avatar-wrapper ${finalFrameClass}`;

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
                const descHtml = badge.description
                    ? `<p style="font-size: 10px; color: #9ca3af; margin: 5px 0; line-height: 1.4;">${badge.description}</p>`
                    : `<div style="margin-bottom: 5px;"></div>`;

                return `
            <div style="background: rgba(168, 85, 247, 0.05); border: 1px solid rgba(168, 85, 247, 0.3); padding: 15px 10px; border-radius: 12px; width: 135px; text-align: center; box-shadow: 0 4px 15px rgba(0,0,0,0.2);">
                <div style="display: flex; justify-content: center; align-items: center; font-size: 30px; margin-bottom: 10px; text-shadow: 0 0 10px var(--gold-glow);">
                    <img src="${imgPath}" alt="${badge.title}" style="width: 60px; height: 60px; object-fit: contain;">
                </div>
                <h4 style="font-size: 12px; color: var(--gold-light); margin: 0; line-height: 1.3;">${badge.title}</h4>
                ${descHtml}
                <span style="display: inline-block; margin-top: 5px; font-size: 10px; color: var(--text-muted); font-weight: bold; background: rgba(0,0,0,0.3); padding: 3px 8px; border-radius: 6px;">${dateStr}</span>
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
            "لقد استخدمت مضاعف النقاط بالفعل في هذه الدورة. لا يمكنك استخدامه مرة أخرى.",
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
// 🛒 شراء إنعاش الستريك (نظام التضخم العقابي)
// ==========================================
window.buyStreakResurrection = async function () {
    try {
        const userRef = doc(db, "users", auth.currentUser.uid);
        const userSnap = await getDoc(userRef);

        if (!userSnap.exists()) return;
        const userData = userSnap.data();

        // 1. فحص هل يوجد ستريك ميت مسجل في السجل أصلاً؟
        const streakToRestore = userData.lostStreak || 0;
        // 🛑 جدار الـ 24 ساعة (نافذة الموت السريري)
        const deathTime = userData.streakDeathTimestamp || 0;
        if (streakToRestore > 0 && deathTime > 0) {
            const hoursSinceDeath =
                (getRealNow().getTime() - deathTime) / (1000 * 60 * 60);
            if (hoursSinceDeath > 24) {
                await updateDoc(userRef, {
                    lostStreak: 0,
                    streakDeathTimestamp: null,
                });
                return await CustomDialog.alert(
                    "فات الأوان! لقد مر أكثر من 24 ساعة وتعفن ستريكك نهائياً. لم يعد قابلاً للإنعاش.",
                    "الستريك تعفن 💀",
                );
            }
        }
        if (streakToRestore === 0) {
            await CustomDialog.alert(
                "لا يوجد ستريك مفقود مسجل لإنعاشه. أنت تبدأ من الصفر.",
                "مرفوض ❌",
            );
            return;
        }

        // 🛑 معادلة التضخم العقابي (Dynamic Pricing)
        // الحد الأدنى 1000 عملة. وكل يوم مسجل في الستريك يرفع السعر 100 عملة.
        // مثال: ستريك 15 = 1500 عملة، ستريك 30 = 3000 عملة.
        const resurrectionCost = Math.max(1000, streakToRestore * 100);

        // 2. فحص حالة الستريك الحالي (يجب أن يكون مفلساً)
        if ((userData.currentStreak || 0) > 0) {
            await CustomDialog.alert(
                "ستريكك حي! لا يمكنك إنعاش ما لم يمت.",
                "تنبيه ⚠️",
            );
            return;
        }

        // 3. فحص سقف الاستخدام (مرة واحدة بالدورة)
        const usedRestore = userData.isStreakRestoreUsed || false;
        if (usedRestore) {
            await CustomDialog.alert(
                "لقد استخدمت إنعاش الستريك بالفعل في هذه الدورة. لا يمكنك استخدامه مرة أخرى.",
                "مرفوض ❌",
            );
            return;
        }

        // 4. فحص الرصيد بناءً على السعر الديناميكي الجديد
        if ((userData.walletCoins || 0) < resurrectionCost) {
            await CustomDialog.alert(
                `رصيدك لا يكفي لدفع الفدية. استرجاع ستريك (${streakToRestore} يوم) سيكلفك ${resurrectionCost} عملة.\nتذكر: كلما طال ستريكك، زادت تكلفة استعادته!`,
                "مرفوض ❌",
            );
            return;
        }

        // 5. تأكيد العملية الصارمة
        const confirmBuy = await CustomDialog.confirm(
            `هل أنت متأكد من دفع ${resurrectionCost} عملة لاسترجاع ستريكك (${streakToRestore} يوم) والعودة فوراً للمنطقة الخضراء؟`,
            "تأكيد الإنعاش ❤️‍🔥",
        );

        if (!confirmBuy) return;

        // 6. خصم العملات الديناميكية واسترجاع الستريك
        await updateDoc(userRef, {
            walletCoins: increment(-resurrectionCost),
            currentStreak: streakToRestore,
            currentZone: "green",
            lostStreak: 0, // تصفير الميت لكي لا يكرر العملية
            streakDeathTimestamp: null, // 🛑 مسح وقت الوفاة بعد الإنعاش الناجح
            isStreakRestoreUsed: true, // تفعيل الحظر لنهاية الدورة
        });

        await CustomDialog.alert(
            `تم إنعاش ستريكك بنجاح وعاد إلى ${streakToRestore} يوم. لا تخذل المعسكر مرة أخرى!`,
            "عملية ناجحة 🦅",
        );

        if (typeof syncUserUI === "function") {
            syncUserUI();
        } else {
            window.location.reload();
        }
    } catch (error) {
        console.error("حدث خطأ أثناء شراء الإنعاش:", error);
        await CustomDialog.alert(
            "حدث خطأ في الاتصال بالسيرفر. حاول مجدداً.",
            "خطأ ❌",
        );
    }
};

// ==========================================
// 👑 نظام التخصيص الملكي (VIP Cosmetics) - الإصدار الصحيح
// ==========================================

// 1. مصفوفة الإطارات (السلايدر) - الخيار الأول فارغ ليدل على الافتراضي
const vipFrames = [
    { class: "", name: "الافتراضي (حسب الرتبة)", price: 0 },
    { class: "frame-1", name: "الاطار الاول", price: 800 },
    { class: "frame-2", name: "الاطار الثاني", price: 800 },
    { class: "frame-3", name: "الاطار الثالث", price: 800 },
    { class: "frame-4", name: "الاطار الرابع", price: 800 },
    { class: "frame-5", name: "الاطار الخامس", price: 800 },
    { class: "frame-6", name: "الاطار السادس", price: 800 },
    { class: "frame-7", name: "الاطار السابع", price: 800 },
    { class: "frame-8", name: "الاطار الثامن", price: 800 },
    { class: "frame-9", name: "الاطار التاسع", price: 800 },
    { class: "frame-10", name: "الاطار العاشر", price: 800 },
    { class: "frame-11", name: "الاطار الحادي عشر", price: 800 },
    { class: "frame-12", name: "الاطار الثاني عشر", price: 800 },
    { class: "frame-13", name: "الاطار الثالث عشر", price: 800 },
    { class: "frame-14", name: "الاطار الرابع عشر", price: 800 },
    { class: "frame-15", name: "الاطار الخامس عشر", price: 800 },
    { class: "frame-16", name: "الاطار السادس عشر", price: 800 },
    { class: "frame-17", name: "الاطار السابع عشر", price: 800 },
    { class: "frame-18", name: "الاطار الثامن عشر", price: 800 },
];

let currentFrameIndex = 0;
let selectedIcon = "";
let selectedColor = "";

// متغيرات قاعدة البيانات
let dbFrame = "";
let dbTagText = "";
let dbTagIcon = "";
let dbTagColor = "";
let dbLifetimeScore = 0; // 🛑 متغير جديد لحفظ رتبة الجندي لكي نرسم إطاره الافتراضي بدقة

let tagCheckTimeout = null;

window.openVipModal = async function () {
    if (!currentUser) return;
    const userSnap = await getDoc(doc(db, "users", currentUser.uid));

    if (userSnap.exists()) {
        const data = userSnap.data();
        dbFrame = data.customFrame || "";
        dbTagText = data.customTagText || "";
        dbTagIcon = data.customTagIcon || "";
        dbTagColor = data.customTagColor || "";
        dbLifetimeScore = data.lifetimeScore || 0; // 🛑 سحب النقاط لمعرفة رتبته الحالية

        // 🛑 السطرين الجدد: سحب صورة المستخدم الحقيقية وعرضها في السلايدر 🛑
        const previewImg = document.getElementById("vip-avatar-preview-img");
        if (previewImg) previewImg.src = data.photoURL || "images/profile.webp";

        currentFrameIndex = vipFrames.findIndex((f) => f.class === dbFrame);
        if (currentFrameIndex === -1) currentFrameIndex = 0;

        document.getElementById("vip-tag-input").value = dbTagText;
        selectedIcon = dbTagIcon;
        selectedColor = dbTagColor;

        document.querySelectorAll(".icon-box").forEach((box) => {
            box.classList.remove("selected");
            if (box.getAttribute("data-icon") === selectedIcon)
                box.classList.add("selected");
        });

        document.querySelectorAll(".color-box").forEach((box) => {
            box.classList.remove("selected");
            if (box.getAttribute("data-color") === selectedColor)
                box.classList.add("selected");
        });

        updateFrameUI();
        updateLivePreview();
    }

    document.getElementById("tag-error-msg").style.display = "none";
    document.getElementById("vip-modal-overlay").classList.add("show");
};

// --- محرك السلايدر للإطارات ---
function updateFrameUI() {
    const frame = vipFrames[currentFrameIndex];
    const wrapper = document.getElementById("vip-avatar-preview-wrapper");

    wrapper.className = "avatar-wrapper"; // تنظيف الكلاسات

    // 🛑 المنطق القاطع: إذا كان الخيار فارغاً، نعطيه فريم رتبته الحقيقية، وإلا نعطيه فريم الـ VIP
    if (frame.class === "") {
        const userRankClass = getRankFrameClass(dbLifetimeScore);
        wrapper.classList.add(userRankClass);
    } else {
        wrapper.classList.add(frame.class, "has-custom-frame");
    }

    document.getElementById("vip-frame-name").innerText = frame.name;
    document.getElementById("vip-frame-price").innerText =
        frame.price === 0 ? "مجاني" : `${frame.price} 🪙`;

    updateVipPrice();
}

document.getElementById("next-frame-btn")?.addEventListener("click", () => {
    currentFrameIndex = (currentFrameIndex + 1) % vipFrames.length;
    updateFrameUI();
});

document.getElementById("prev-frame-btn")?.addEventListener("click", () => {
    currentFrameIndex =
        (currentFrameIndex - 1 + vipFrames.length) % vipFrames.length;
    updateFrameUI();
});

document.getElementById("reset-frame-btn")?.addEventListener("click", () => {
    currentFrameIndex = 0;
    updateFrameUI();
});

// --- محرك الأيقونات والألوان ---
document.querySelectorAll(".icon-box").forEach((box) => {
    box.addEventListener("click", function () {
        document
            .querySelectorAll(".icon-box")
            .forEach((b) => b.classList.remove("selected"));
        this.classList.add("selected");
        selectedIcon = this.getAttribute("data-icon");
        updateLivePreview();
    });
});

document.querySelectorAll(".color-box").forEach((box) => {
    box.addEventListener("click", function () {
        document
            .querySelectorAll(".color-box")
            .forEach((b) => b.classList.remove("selected"));
        this.classList.add("selected");
        selectedColor = this.getAttribute("data-color");
        updateLivePreview();
    });
});

// --- محرك المعاينة الحية وفحص التكرار ---
document
    .getElementById("vip-tag-input")
    ?.addEventListener("input", function () {
        updateLivePreview();

        clearTimeout(tagCheckTimeout);
        document.getElementById("tag-error-msg").style.display = "none";

        const tagText = this.value.trim();
        if (tagText !== "" && tagText !== dbTagText) {
            tagCheckTimeout = setTimeout(async () => {
                const isAvailable = await checkTagAvailability(tagText);
                if (!isAvailable) {
                    document.getElementById("tag-error-msg").style.display =
                        "block";
                }
            }, 800);
        }
    });

function updateLivePreview() {
    const textInput = document.getElementById("vip-tag-input").value.trim();
    const previewText = document.getElementById("preview-text");
    const previewIcon = document.getElementById("preview-icon");
    const previewTag = document.getElementById("vip-live-preview-tag");

    // 🛑 سحب لقب الرتبة الأصلي إذا كان الحقل فارغاً
    const userRankInfo = getRankDetails(dbLifetimeScore);
    const rawRankText = userRankInfo.title.replace(/<[^>]*>?/gm, "").trim();

    previewText.innerText = textInput || "اللقب";
    previewIcon.className = selectedIcon;
    previewIcon.style.display = selectedIcon ? "inline-block" : "none";

    // 🛑 تطبيق لون الـ VIP أو لون الرتبة الأصلي
    previewTag.className = selectedColor
        ? `${selectedColor}`
        : userRankInfo.tagClass;

    updateVipPrice();
}

async function checkTagAvailability(requestedTag) {
    if (!requestedTag) return true;

    const q = query(
        collection(db, "users"),
        where("customTagText", "==", requestedTag),
    );
    const snap = await getDocs(q);

    let isUsedByOthers = false;
    snap.forEach((doc) => {
        if (doc.id !== currentUser.uid) isUsedByOthers = true;
    });

    return !isUsedByOthers;
}

// --- حساب السعر الديناميكي (صلحنا الأخطاء القديمة هنا) ---
// --- حساب السعر الديناميكي المفصول ---
window.updateVipPrice = function () {
    let cost = 0;
    const currentFrame = vipFrames[currentFrameIndex];
    const currentText = document.getElementById("vip-tag-input").value.trim();

    // 🛑 حدد أسعارك المستقلة هنا 🛑
    const TEXT_PRICE = 200; // سعر تغيير النص
    const ICON_PRICE = 100; // سعر تغيير الأيقونة
    const COLOR_PRICE = 100; // سعر تغيير اللون

    // 1. حساب سعر الفريم
    if (currentFrame.class !== dbFrame) {
        cost += currentFrame.price;
    }

    // 2. حساب سعر تغيير اللقب (النص)
    // يُحاسب إذا كان النص مختلفاً عن المحفوظ، ولا يُحاسب إذا قام بتفريغ الحقل (العودة للافتراضي)
    if (currentText !== dbTagText && currentText !== "") {
        cost += TEXT_PRICE;
    }

    // 3. حساب سعر تغيير الأيقونة
    if (selectedIcon !== dbTagIcon && selectedIcon !== "") {
        cost += ICON_PRICE;
    }

    // 4. حساب سعر تغيير اللون
    if (selectedColor !== dbTagColor && selectedColor !== "") {
        cost += COLOR_PRICE;
    }

    const btn = document.getElementById("vip-save-btn");
    if (btn) {
        btn.innerHTML = `شراء وتطبيق (${cost} <i class="fa-solid fa-coins fa-fw"></i>)`;
        btn.setAttribute("data-total-cost", cost);
    }
};

// --- دالة الحفظ النهائية المربوطة بالزر ---
window.saveVipCosmetics = async function () {
    if (!currentUser) return;

    const currentText = document.getElementById("vip-tag-input").value.trim();
    const currentFrameClass = vipFrames[currentFrameIndex].class;

    // فحص نهائي للتكرار قبل الدفع
    if (currentText !== "" && currentText !== dbTagText) {
        const isAvailable = await checkTagAvailability(currentText);
        if (!isAvailable) {
            document.getElementById("tag-error-msg").style.display = "block";
            return await CustomDialog.alert(
                "لا يمكنك الحفظ. هذا اللقب مأخوذ بواسطة محارب آخر!",
                "لقب محجوز ⚠️",
            );
        }
    }

    const btn = document.getElementById("vip-save-btn");
    const totalCost = parseInt(btn.getAttribute("data-total-cost") || 0);

    const userRef = doc(db, "users", currentUser.uid);
    const userSnap = await getDoc(userRef);
    if (!userSnap.exists()) return;
    const userData = userSnap.data();

    if (totalCost > 0) {
        if ((userData.walletCoins || 0) < totalCost) {
            return await CustomDialog.alert(
                `رصيدك لا يكفي. تحتاج إلى ${totalCost} عملة لتأكيد هويتك الجديدة.`,
                "رصيد غير كافٍ ❌",
            );
        }
        if (userData.lifetimeScore < 10000) {
            return await CustomDialog.alert(
                `عليك أن تكون على الأقل في رتبة "الاسطورة" لشراء التخصيصات. استمر في القتال لترتقي!`,
                "رتبة غير كافية ⚔️",
            );
        }
        const confirmBuy = await CustomDialog.confirm(
            `سيتم خصم ${totalCost} عملة لتطبيق التعديلات. هل أنت متأكد؟`,
            "تأكيد الشراء 👑",
        );
        if (!confirmBuy) return;
    }

    const originalText = btn.innerHTML;
    btn.innerHTML = "جاري نقش هويتك... ⏳";
    btn.disabled = true;

    try {
        let updates = {
            customFrame: currentFrameClass, // سيُحفظ كنص فارغ "" في حال كان الافتراضي
            customTagText: currentText,
            customTagIcon: selectedIcon,
            customTagColor: selectedColor,
        };

        if (totalCost > 0) {
            updates.walletCoins = increment(-totalCost);
        }

        await updateDoc(userRef, updates);
        document.getElementById("vip-modal-overlay").classList.remove("show");

        if (totalCost > 0) {
            new Audio(
                "https://cdn.pixabay.com/download/audio/2021/08/04/audio_0625c1539c.mp3?filename=success-1-6297.mp3",
            )
                .play()
                .catch(() => {});
            await CustomDialog.alert(
                "تم التجهيز بنجاح! هويتك الجديدة مرئية الآن لجميع المحاربين.",
                "مبارك 🛡️",
            );
        }

        window.syncUserUI();
    } catch (error) {
        console.error(error);
        await CustomDialog.alert("حدث خطأ أثناء حفظ التعديلات.");
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
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
        if (isTodayFinalized) {
            clockEl.style.display = "none";
            return;
        }

        const now = getRealNow();
        const cairoTimeStr = now.toLocaleString("en-US", {
            timeZone: "Africa/Cairo",
            hour12: false,
        });
        const cairoDate = new Date(cairoTimeStr);
        const currentHour = cairoDate.getHours();

        const startH = window.submissionStartHour;
        const endH = window.dayStartHour;

        // بناء موعد الإغلاق (الديدلاين) ديناميكياً
        let cairoDeadline = new Date(
            cairoDate.getFullYear(),
            cairoDate.getMonth(),
            cairoDate.getDate(),
            endH,
            0,
            0,
        );

        // إذا كنا بالليل (مثلاً 10 مساءً) والديدلاين فجراً، نزيد يوماً للديدلاين
        if (currentHour >= startH && endH < 12) {
            cairoDeadline.setDate(cairoDeadline.getDate() + 1);
        }

        const diffMs = cairoDeadline - cairoDate;
        const hoursLeft = diffMs / (1000 * 60 * 60);

        // التفعيل فقط لو متبقي ساعتين أو أقل وكان الاعتماد مفتوحاً فعلاً
        if (
            hoursLeft <= 2 &&
            hoursLeft > 0 &&
            (currentHour >= startH || currentHour < endH)
        ) {
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
// function startCycleCountdown() {
//     const daysLeftEl = document.getElementById("days-left");
//     if (!daysLeftEl) return;

//     function update() {
//         const now = getRealNow();
//         const currentDay = now.getDay(); // الأحد = 0, الاثنين = 1, ... الجمعة = 5, السبت = 6

//         // حساب الأيام المتبقية حتى يوم السبت القادم
//         let daysUntilSat = 6 - currentDay;

//         // إذا كان اليوم هو السبت، فالدورة تنتهي السبت القادم (بعد 7 أيام)
//         if (daysUntilSat === 0) {
//             daysUntilSat = 7;
//         }

//         // تحديد الهدف: السبت القادم الساعة 00:00:00 (منتصف ليل الجمعة)
//         const targetDate = new Date(
//             now.getFullYear(),
//             now.getMonth(),
//             now.getDate() + daysUntilSat,
//             0,
//             0,
//             0,
//         );
//         const diffMs = targetDate - now;

//         if (diffMs <= 0) {
//             daysLeftEl.innerHTML = `<span style="color: var(--danger); font-weight: bold;">جاري المحاسبة والتصفير ⚖️...</span>`;
//             return;
//         }

//         const d = Math.floor(diffMs / (1000 * 60 * 60 * 24));
//         const h = Math.floor((diffMs / (1000 * 60 * 60)) % 24);
//         const m = Math.floor((diffMs / 1000 / 60) % 60);

//         if (d > 0) {
//             daysLeftEl.innerHTML = `<span style="font-weight:bold; color: var(--gold-primary); font-size: 20px;">${d}</span> أيام و <span style="font-weight:bold; color: var(--gold-primary);">${h}</span> ساعات`;
//             daysLeftEl.style.color = "var(--text-main)";
//             daysLeftEl.style.textShadow = "none";
//         } else {
//             // في اليوم الأخير (الجمعة) يتحول العداد للون الأحمر للتنبيه
//             daysLeftEl.innerHTML = `⚠️ <span style="font-weight:bold; font-size: 20px;">${h}</span> ساعة و <span style="font-weight:bold;">${m}</span> دقيقة`;
//             daysLeftEl.style.color = "var(--danger)";
//             daysLeftEl.style.textShadow = "0 0 10px rgba(244,63,94,0.5)";
//         }
//     }

//     update(); // تشغيل فوري
//     setInterval(update, 60000); // تحديث كل دقيقة (كافي جداً لعداد الأيام/الساعات)
// }

function startCycleCountdown() {
    const daysLeftEl = document.getElementById("days-left");
    if (!daysLeftEl) return;

    function update() {
        const now = getRealNow(); // توقيت القاهرة
        const currentDay = now.getDay();
        const currentHour = now.getHours();

        // 🛑 تحديد وقت الإغلاق: السبت الساعة 4 فجراً
        let targetDate = new Date(now);

        // حساب عدد الأيام المتبقية حتى السبت
        let daysUntilSat = 6 - currentDay;

        // منطق دقيق:
        // إذا كنا يوم الجمعة، فاليوم هو الجمعة (الهدف السبت).
        // إذا كنا يوم السبت وقبل الساعة 4 فجراً، الهدف هو نفس اليوم (السبت الساعة 4).
        // إذا كنا يوم السبت وبعد الساعة 4 فجراً، الهدف هو السبت القادم.
        if (currentDay === 6 && currentHour >= 4) {
            daysUntilSat = 7;
        } else if (currentDay === 6 && currentHour < 4) {
            daysUntilSat = 0;
        }

        targetDate.setDate(now.getDate() + daysUntilSat);
        targetDate.setHours(4, 0, 0, 0); // 🛑 ضبط الساعة على 4 فجراً

        const diffMs = targetDate - now;

        if (diffMs <= 0) {
            daysLeftEl.innerHTML = `<span style="color: var(--danger); font-weight: bold;">جاري المحاسبة والتصفير ⚖️...</span>`;
            return;
        }

        const d = Math.floor(diffMs / (1000 * 60 * 60 * 24));
        const h = Math.floor((diffMs / (1000 * 60 * 60)) % 24);
        const m = Math.floor((diffMs / 1000 / 60) % 60);

        if (d > 0) {
            daysLeftEl.innerHTML = `<span style="font-weight:bold; color: var(--gold-primary); font-size: 20px;">${d}</span> يوم و <span style="font-weight:bold; color: var(--gold-primary);">${h}</span> ساعة`;
        } else {
            // يوم الجمعة + الساعات الأولى من السبت (حتى الـ 4 فجراً) سيظهر باللون الأحمر
            daysLeftEl.innerHTML = `⚠️ <span style="font-weight:bold; font-size: 20px;">${h}</span> ساعة و <span style="font-weight:bold;">${m}</span> دقيقة`;
            daysLeftEl.style.color = "var(--danger)";
            daysLeftEl.style.textShadow = "0 0 10px rgba(244,63,94,0.5)";
        }
    }

    update();
    setInterval(update, 60000);
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
// تشغيل محرك الكاش (Service Worker)
// ==========================================
if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").then((reg) => {
        // 🛑 إجبار الهاتف على الاتصال بالسيرفر فوراً للبحث عن تحديثات
        reg.update();
    });

    // 🛑 قناص التحديثات: بمجرد أن يسيطر الإصدار الجديد، نفرض إعادة تحميل إجبارية للشاشة
    let refreshing = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (!refreshing) {
            refreshing = true;
            window.location.reload(); // ريفريش إجباري لمسح الكاش من الذاكرة الحية
        }
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

            setTimeout(() => {
                ptrIndicator.style.top =
                    "calc(-80px - env(safe-area-inset-top, 0px))";
                window.location.reload(true);
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
    // const fileTime = new Date(unchainingImageFile.lastModified);
    // const diffMinutes = (now - fileTime) / (1000 * 60);

    // if (diffMinutes > 30 || diffMinutes < 0) {
    //     return CustomDialog.alert(
    //         "هذا الإثبات قديم. يجب التقاط لقطة الشاشة ورفعها فوراً (خلال 30 دقيقة كحد أقصى). التقط واحدة جديدة الآن.",
    //         "إثبات باطل ❌",
    //     );
    // }

    // 🛑 فحص صلاحية صورة فك القيود (التاريخ + الوقت)
    const validation = await validateProofImage(unchainingImageFile);
    if (!validation.valid) {
        return await CustomDialog.alert(
            `الصورة مرفوضة:\n\n${validation.reason}`,
            "إثبات غير صالح ❌",
        );
    }

    // 🛑 فحص وجود التبرير
    const unchainingJustification = document
        .getElementById("unchaining-justification")
        ?.value.trim();
    if (!unchainingJustification) {
        return await CustomDialog.alert(
            "يجب كتابة تبرير لاستهلاكك لكي يخصم القاضي الآلي أوقات دراستك وعملك.",
            "التبرير مطلوب ✍️",
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
            justification: unchainingJustification, // 🛑 إرسال التبرير للسيرفر
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

// ==========================================
// 🔥 محرك تحدي الإرادة اليومي للمستخدمين
// ==========================================
let currentDailyWillpower = null;

async function loadDailyWillpower() {
    const loadingEl = document.getElementById("willpower-loading");
    const contentEl = document.getElementById("willpower-content");
    const completedMsgEl = document.getElementById("willpower-completed-msg");
    const btn = document.getElementById("complete-wp-btn");

    if (!loadingEl || !contentEl) return;

    try {
        const todayStr = getCairoDateString(getRealNow());

        // 1. التحقق مما إذا كان المستخدم قد أتم التحدي اليوم
        const logRef = doc(
            db,
            `users/${auth.currentUser.uid}/dailyLogs/${todayStr}`,
        );
        const logSnap = await getDoc(logRef);

        if (logSnap.exists() && logSnap.data().willpowerCompleted) {
            loadingEl.style.display = "none";
            contentEl.style.display = "none";
            completedMsgEl.style.display = "block";
            return;
        }

        // 2. سحب كل التحديات المتاحة من البنك
        const wpQuery = query(collection(db, "willpowerChallenges"));
        const snap = await getDocs(wpQuery);

        const activeChallenges = [];
        snap.forEach((doc) => {
            if (doc.data().isActive)
                activeChallenges.push({ id: doc.id, ...doc.data() });
        });

        if (activeChallenges.length === 0) {
            loadingEl.style.display = "none";
            contentEl.style.display = "block";
            document.getElementById("wp-user-title").innerText =
                "لا يوجد تحديات";
            document.getElementById("wp-user-desc").innerText =
                "القيادة لم تقم بتذخير بنك التحديات بعد.";
            btn.style.display = "none";
            return;
        }

        // 3. الخوارزمية الحتمية لاختيار التحدي الموحد لجميع الجنود بناءً على تاريخ اليوم
        // (نحول التاريخ إلى رقم ثم نقسمه على عدد التحديات وناخذ الباقي)
        const epochDays = Math.floor(
            new Date(todayStr).getTime() / (1000 * 60 * 60 * 24),
        );
        const challengeIndex = epochDays % activeChallenges.length;

        // ترتيب المصفوفة لضمان نفس الترتيب دائماً
        activeChallenges.sort((a, b) => a.id.localeCompare(b.id));
        currentDailyWillpower = activeChallenges[challengeIndex];

        // 4. عرض التحدي في الواجهة
        document.getElementById("wp-user-title").innerText =
            currentDailyWillpower.title;
        document.getElementById("wp-user-desc").innerText =
            currentDailyWillpower.description;
        document.getElementById("wp-user-xp").innerText =
            `+${currentDailyWillpower.xpReward} Score`;
        document.getElementById("wp-user-coins").innerHTML =
            `+${currentDailyWillpower.coinReward} <i class="fa-solid fa-coins fa-fw"></i>`;

        loadingEl.style.display = "none";
        contentEl.style.display = "block";
    } catch (error) {
        console.error("Error loading Willpower:", error);
        loadingEl.innerHTML =
            "<p style='color: var(--danger);'>فشل تحميل التحدي، تأكد من الإنترنت.</p>";
    }
}

// دالة اعتماد التحدي وحصاد الغنائم
document
    .getElementById("complete-wp-btn")
    ?.addEventListener("click", async () => {
        if (!currentDailyWillpower || !auth.currentUser) return;

        // 🛑 نافذة قَسَم الشرف العسكري لمنع الكذب
        const isHonest = await CustomDialog.confirm(
            "هل تقسم أنك أنجزت هذا التحدي كاملاً وبدون أي تحايل؟\n\nتذكر: الكذب هنا سيدمر نزاهتك النفسية قبل أن يدمر إحصائياتك الرقمية.",
            "قَسَم الشرف ⚖️",
        );

        if (!isHonest) return;

        const btn = document.getElementById("complete-wp-btn");
        const originalText = btn.innerHTML;
        btn.innerHTML =
            "<i class='fa-solid fa-spinner fa-spin'></i> جاري الاعتماد...";
        btn.disabled = true;

        try {
            const uid = auth.currentUser.uid;
            const todayStr = getCairoDateString(getRealNow());

            // 1. تحديث محفظة المستخدم (XP الدورة، XP التراكمي، والعملات) بدالة increment الصارمة
            const userRef = doc(db, "users", uid);
            await updateDoc(userRef, {
                lifetimeScore: increment(currentDailyWillpower.xpReward),
                cycleScore: increment(currentDailyWillpower.xpReward),
                walletCoins: increment(currentDailyWillpower.coinReward),
            });

            // 2. توثيق الإنجاز في سجل اليوم لكي لا يكرره
            const logRef = doc(db, `users/${uid}/dailyLogs/${todayStr}`);
            await setDoc(
                logRef,
                {
                    willpowerCompleted: true,
                    willpowerDetails: {
                        title: currentDailyWillpower.title,
                        xpEarned: currentDailyWillpower.xpReward,
                        coinsEarned: currentDailyWillpower.coinReward,
                    },
                },
                { merge: true },
            );

            // 3. الاحتفال وتحديث الواجهة
            confetti({
                particleCount: 150,
                spread: 70,
                origin: { y: 0.6 },
                colors: ["#f97316", "#10b981", "#fbbf24"],
            });
            await CustomDialog.alert(
                `حصلت على ${currentDailyWillpower.xpReward} XP و ${currentDailyWillpower.coinReward} عملة!`,
                "تم السحق بنجاح ⚔️",
            );

            // تحديث شريط الهيدر للعملات والـ XP فوراً
            syncUserUI(uid);

            document.getElementById("willpower-content").style.display = "none";
            document.getElementById("willpower-completed-msg").style.display =
                "block";
        } catch (error) {
            console.error("Willpower Submit Error:", error);
            await CustomDialog.alert("حدث خطأ أثناء اعتماد التحدي.", "خطأ ❌");
            btn.innerHTML = originalText;
            btn.disabled = false;
        }
    });

// ==========================================
// 📄 محرك التقارير الأسبوعية (النسخة الفولاذية 100% متجاوبة للطباعة والجوال)
// ==========================================
window.downloadReportAsPDF = async function (reportData) {
    const userName =
        document.getElementById("profile-name-input")?.value || "الجندي";

    const oldReport = document.getElementById("native-report-wrapper");
    if (oldReport) oldReport.remove();

    const wrapper = document.createElement("div");
    wrapper.id = "native-report-wrapper";
    wrapper.style.cssText =
        "position: absolute; top: 0; left: 0; width: 100%; min-height: 100vh; background: #f1f5f9; z-index: 9999999; padding: 15px; direction: rtl; font-family: 'Cairo', sans-serif;";

    wrapper.innerHTML = `
        <style>
            /* 1. التأسيس والريسيت */
            #native-report-wrapper * { box-sizing: border-box !important; }
            .report-container { width: 100%; max-width: 850px; margin: 50px auto; background: white; padding: 30px; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.1); color: #111827; }
            
            /* 2. النصوص والعناوين */
            .main-title { color: #1e3a8a; margin: 0 0 5px 0; font-size: 26px; font-weight: 900; text-align: center; }
            .sub-title { color: #64748b; margin: 0; font-size: 14px; text-align: center; }
            .alert-text { color: #ef4444; font-weight: bold; font-size: 12px; text-align: center; margin-top: 5px; }
            .section-title { color: #1e3a8a; font-size: 18px; border-bottom: 2px solid #1e3a8a; padding-bottom: 5px; margin: 30px 0 15px 0; }
            
            /* 3. شبكة الإحصائيات (Grid) */
            .stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 30px; }
            .stat-card { background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 8px; padding: 20px; text-align: center; }
            .stat-card.full-width { grid-column: 1 / -1; display: flex; justify-content: space-between; align-items: center; padding: 15px 20px; text-align: right; }
            .stat-card.green { background: #ecfdf5; border-color: #6ee7b7; }
            .stat-card.blue { background: #eff6ff; border-color: #93c5fd; }
            .stat-title { font-size: 14px; font-weight: bold; display: block; margin-bottom: 5px; }
            .stat-value { font-size: 26px; font-weight: 900; }
            
            /* 4. الجداول */
            .report-table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 14px; text-align: right; }
            .report-table th { padding: 10px; background: #1e3a8a; color: white; border: 1px solid #cbd5e1; font-weight: bold; }
            .report-table td { padding: 10px; border: 1px solid #cbd5e1; color: #1e293b; font-weight: bold; }
            .report-table tr:nth-child(even) td { background-color: #f8fafc; }
            
            /* 5. الرسوم البيانية - رجعنا الأبعاد بتاعتك 100% عشان تملا الشاشة */
            .chart-wrapper { width: 100%; height: 260px; margin-bottom: 10px; border: 1px solid #cbd5e1; border-radius: 8px; padding: 10px; position: relative; background: #fff; }
            .chart-wrapper.large { height: 320px; }
            canvas { width: 100% !important; height: 100% !important; display: block; }
            
            /* 6. صندوق التوجيهات */
            .guidance-box { background: #fdfae5; border: 1px solid #fde047; border-right: 5px solid #eab308; border-radius: 8px; padding: 20px; margin-top: 40px; color: #422006; }
            .guidance-box h3 { margin-top: 0; color: #854d0e; font-size: 16px; margin-bottom: 10px; }
            .guidance-box ul { margin: 0; padding-right: 20px; font-size: 13px; line-height: 1.8; }

            /* 7. قواعد منع القص العشوائي في الطباعة */
            .avoid-break { page-break-inside: avoid; break-inside: avoid; }
            tr { page-break-inside: avoid; page-break-after: auto; }

            /* ======================================= */
            /* 📱 التجاوب مع شاشات الجوال */
            /* ======================================= */
            @media (max-width: 650px) {
                .report-container { padding: 15px; border-radius: 8px; }
                .main-title { font-size: 20px; }
                .section-title { font-size: 16px; }
                
                .stats-grid { grid-template-columns: 1fr; gap: 10px; }
                .stat-card.full-width { flex-direction: column; align-items: flex-start; gap: 10px; }
                .stat-value { font-size: 22px; }
                
                .report-table { font-size: 12px; }
                .report-table th, .report-table td { padding: 6px; }
                
                .chart-wrapper { height: 220px; padding: 5px; }
                .chart-wrapper.large { height: 260px; }
                
                .guidance-box { padding: 15px; }
                .guidance-box ul { font-size: 12px; }
            }

            /* ======================================= */
            /* 🖨️ أوامر الطباعة الصارمة */
            /* ======================================= */
            @media print {
                @page { size: A4 portrait; margin: 10mm; }
                html, body { background: white !important; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
                body > *:not(#native-report-wrapper) { display: none !important; }
                #native-report-wrapper { position: static !important; width: 100% !important; padding: 0 !important; background: white !important; }
                .report-container { box-shadow: none !important; padding: 0 !important; max-width: 100% !important; border: none !important; }
                .no-print { display: none !important; }
                .chart-wrapper { border: none !important; padding: 0 !important; page-break-inside: avoid; }
                .stats-grid { page-break-inside: avoid; }
                table { page-break-inside: auto; }
            }
        </style>
        
        <div class="report-container">
            <div class="no-print" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px; border-bottom: 1px dashed #cbd5e1; padding-bottom: 15px;">
            <h3 style="margin: 0; color: #1e3a8a; font-size: 16px;">المعاينة التحليلية</h3>
            <div>
                <button id="close-report-btn" style="background: #ef4444; color: white; border: none; padding: 6px 10px; border-radius: 6px; cursor: pointer; font-weight: bold; font-family: 'Cairo';"><i class="fa-solid fa-xmark"></i> إغلاق</button>
                <button id="print-report-btn" style="background: #10b981; color: white; border: none; padding: 6px 10px; border-radius: 6px; cursor: pointer; font-weight: bold; font-family: 'Cairo';"><i class="fa-solid fa-print"></i> حفظ كـ PDF</button></div>
            </div>

            <div style="margin-bottom: 30px;">
                <h1 class="main-title">🛡️ التقرير الأسبوعي الشامل 🛡️</h1>
                <p class="sub-title">القيادة المركزية - BrainRot Detox</p>
                <p class="alert-text">(دراسة تحليلية للـ 7 أيام الماضية منتهية بيوم الأمس)</p>
            </div>

            <div class="stats-grid">
                <div class="stat-card full-width avoid-break">
                    <div><b>👤 الجندي:</b> <span style="color: #1e3a8a;">${userName}</span></div>
                    <div><b>📅 تاريخ الإصدار:</b> <span style="color: #1e3a8a;">${reportData.dateStr}</span></div>
                </div>
                
                <div class="stat-card green avoid-break">
                    <span class="stat-title" style="color: #065f46;">أيام النجاح المؤكدة</span>
                    <span class="stat-value" style="color: #10b981;">${reportData.passedDays} <span style="font-size: 14px;">يوم</span></span>
                </div>

                <div class="stat-card blue avoid-break">
                    <span class="stat-title" style="color: #1e40af;">النقاط المكتسبة</span>
                    <span class="stat-value" style="color: #3b82f6;">+${reportData.totalEarnedPoints} <span style="font-size: 14px;">نقطة</span></span>
                </div>
            </div>

            <div>
                <h3 class="section-title">📊 مؤشر النقاط اليومية</h3>
                <div class="chart-wrapper avoid-break"><canvas id="native-points-chart"></canvas></div>
            </div>

            <div>
                <h3 class="section-title" style="color: #f97316; border-color: #f97316;">📱 مؤشر أوقات الشاشة</h3>
                <div class="chart-wrapper large avoid-break"><canvas id="native-time-chart"></canvas></div>
            </div>

            <div>
                <h3 class="section-title" style="color: #10b981; border-color: #10b981;">🕌 جودة الأداء (المهام الدينية)</h3>
                <table class="report-table">
                    <thead><tr><th style="width: 40%;">المهمة</th><th style="width: 60%;">مؤشر الجودة</th></tr></thead>
                    <tbody>${reportData.relQualityHtml}</tbody>
                </table>
            </div>

            <div>
                <h3 class="section-title" style="color: #059669; border-color: #059669;">🔍 التفاصيل (الخيارات الدينية)</h3>
                <table class="report-table">
                    <thead><tr><th style="width: 40%;">المهمة</th><th style="width: 60%;">مرات الاختيار (7 أيام)</th></tr></thead>
                    <tbody>${reportData.relDetailsHtml}</tbody>
                </table>
            </div>

            <div>
                <h3 class="section-title">⚙️ جودة الأداء (المهام العادية)</h3>
                <table class="report-table">
                    <thead><tr><th style="width: 40%;">المهمة</th><th style="width: 60%;">مؤشر الجودة</th></tr></thead>
                    <tbody>${reportData.normalQualityHtml}</tbody>
                </table>
            </div>

            <div>
                <h3 class="section-title" style="color: #1d4ed8; border-color: #1d4ed8;">🔍 التفاصيل (الخيارات العادية)</h3>
                <table class="report-table">
                    <thead><tr><th style="width: 40%;">المهمة</th><th style="width: 60%;">مرات الاختيار (7 أيام)</th></tr></thead>
                    <tbody>${reportData.normalDetailsHtml}</tbody>
                </table>
            </div>

            <div class="guidance-box avoid-break">
                <h3><i class="fa-solid fa-crosshairs"></i> توجيهات القيادة - كيف تقرأ التقرير؟</h3>
                <ul>
                    <li><b>مؤشرات الجودة:</b> المهام الأقل من <b>50%</b> هي ثغرات خطيرة. والمهام فوق <b>80%</b> تعكس انضباطاً ممتازاً.</li>
                    <li><b>الترابط:</b> راقب <i>أوقات الشاشة</i> وقارنها بجودة <i>المهام الدينية</i>. الانفلات في الشاشة يزامنه غالباً انهيار في الصلاة.</li>
                    <li><b>التفاصيل:</b> اختيار بدائل التكاسل (مثل: متأخر) باستمرار سيخفض الجودة الكلية للمهمة حتى لو كنت تؤديها ظاهرياً.</li>
                    <li><b>الهدف:</b> استخدم البيانات بوعي لخطة الأسبوع القادم. اجعل النسب المنخفضة هدفك للتحسين.</li>
                </ul>
            </div>
        </div>
    `;

    document.body.appendChild(wrapper);

    // 🔴 السر كله هنا: إجبار الرسوم على الدقة العالية للهواتف لمنع البكسلة
    const currentDPR = window.devicePixelRatio
        ? Math.max(window.devicePixelRatio, 2)
        : 2;

    const chartOptionsLine = {
        responsive: true,
        maintainAspectRatio: false,
        devicePixelRatio: currentDPR, // يحل مشكلة الجودة الرديئة
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true } },
    };

    const chartOptionsBar = {
        responsive: true,
        maintainAspectRatio: false,
        devicePixelRatio: currentDPR, // يحل مشكلة الجودة الرديئة
        plugins: {
            legend: {
                position: "bottom",
                labels: {
                    font: { family: "'Cairo', sans-serif", size: 11 },
                    boxWidth: 12,
                },
            },
        },
        scales: { y: { beginAtZero: true } },
    };

    new Chart(document.getElementById("native-points-chart"), {
        type: "line",
        data: {
            labels: reportData.dates,
            datasets: [
                {
                    label: "النقاط",
                    data: reportData.points,
                    borderColor: "#3b82f6",
                    backgroundColor: "rgba(59, 130, 246, 0.2)",
                    borderWidth: 2,
                    fill: true,
                    tension: 0.3,
                    pointRadius: 3,
                },
            ],
        },
        options: chartOptionsLine,
    });

    new Chart(document.getElementById("native-time-chart"), {
        type: "bar",
        data: {
            labels: reportData.dates,
            datasets: [
                {
                    label: "دراسة",
                    data: reportData.studyMinsArr,
                    backgroundColor: "#10b981",
                },
                {
                    label: "مهدر",
                    data: reportData.wastedMinsArr,
                    backgroundColor: "#fbbf24",
                },
                {
                    label: "أخرى",
                    data: reportData.othersMinsArr,
                    backgroundColor: "#3b82f6",
                },
                {
                    label: "شورتس",
                    data: reportData.shortsMinsArr,
                    backgroundColor: "#ef4444",
                },
            ],
        },
        options: chartOptionsBar,
    });

    document
        .getElementById("close-report-btn")
        .addEventListener("click", () => {
            wrapper.remove();
        });
    document
        .getElementById("print-report-btn")
        .addEventListener("click", () => {
            window.print();
        });
};
// ==========================================
// 1. أرشيف التقارير الأسبوعية (مع شريط الأوامر العائم)
// ==========================================
window.loadUserReportsHistory = async function () {
    if (!currentUser) return;
    const btn = document.getElementById("generate-user-report-btn");
    if (!btn) return;

    let container = document.getElementById("reports-history-container");
    if (!container) {
        container = document.createElement("div");
        container.id = "reports-history-container";
        container.style.cssText = "margin-top: 20px; text-align: right;";
        btn.parentNode.insertBefore(container, btn.nextSibling);
    }

    container.innerHTML =
        "<p style='color:var(--text-muted); font-size:13px;'><i class='fa-solid fa-spinner fa-spin'></i> جاري جلب أرشيف التقارير...</p>";

    const q = query(
        collection(db, `users/${currentUser.uid}/reports`),
        orderBy("createdAt", "desc"),
    );
    const snap = await getDocs(q);

    if (snap.empty) {
        container.innerHTML =
            "<p style='color:var(--text-muted); font-size:13px; background:rgba(0,0,0,0.2); padding:10px; border-radius:6px;'>لا توجد تقارير سابقة في الأرشيف.</p>";
        return;
    }

    // بناء واجهة الأرشيف بدون الزر القديم
    let html = `
        <div style="margin-bottom:15px;">
            <h4 style="color:var(--gold-primary); font-size:14px; margin:0 0 5px 0;"><i class="fa-solid fa-folder-open"></i> الأرشيف الأسبوعي</h4>
            <p style="font-size: 11px; color: var(--text-muted); margin: 0;">حدد تقريرين لإصدار دراسة مقارنة مفصلة بينهما.</p>
        </div>
        <div style="display:flex; flex-direction:column; gap:10px;" id="reports-list">
    `;

    window.userReportsCache = {};

    snap.forEach((doc) => {
        const data = doc.data();
        window.userReportsCache[doc.id] = data;
        const pointsToShow =
            data.totalEarnedPoints !== undefined
                ? data.totalEarnedPoints
                : data.totalDopamineGained || 0;

        html += `
            <div class="report-row" style="display:flex; justify-content:space-between; align-items:center; background:rgba(168, 85, 247, 0.05); border:1px solid rgba(168,85,247,0.3); padding:10px; border-radius:8px;">
                <div style="display:flex; align-items:center; gap: 10px;">
                    <input type="checkbox" class="compare-cb" data-id="${doc.id}" style="width: 18px; height: 18px; cursor: pointer; accent-color: #10b981;">
                    <div style="display:flex; flex-direction:column;">
                        <strong style="color:var(--text-main); font-size:13px;">تقرير ${data.dateStr}</strong>
                        <span style="color:var(--text-muted); font-size:11px;">نجاح: ${data.passedDays} أيام | نقاط: +${pointsToShow}</span>
                    </div>
                </div>
                <button onclick="reDownloadReport('${doc.id}')" style="background:var(--gold-primary); color:#111; border:none; padding:5px 12px; border-radius:5px; font-weight:bold; cursor:pointer; font-size:12px;">
                    <i class="fa-solid fa-print"></i> عرض
                </button>
            </div>
        `;
    });
    html += `</div>`;
    html += `<div id="comparison-history-container" style="margin-top: 30px;"></div>`;
    container.innerHTML = html;

    // 🛑 زراعة شريط الأوامر العائم في أسفل الشاشة
    let oldBar = document.getElementById("compare-floating-bar");
    if (oldBar) oldBar.remove();

    const floatingBar = document.createElement("div");
    floatingBar.id = "compare-floating-bar";
    floatingBar.style.cssText =
        "position: fixed; bottom: -150px; left: 0; width: 100%; background: #0f172a; color: white; padding: 15px 0; z-index: 999999; transition: bottom 0.4s cubic-bezier(0.4, 0, 0.2, 1); box-shadow: 0 -10px 25px rgba(0,0,0,0.5); border-top: 2px solid #10b981; direction: rtl;";
    floatingBar.innerHTML = `
        <div style="max-width: 800px; margin: 0 auto; display: flex; justify-content: space-between; align-items: center; padding: 0 20px;">
            <div style="text-align: right;">
                <span style="font-weight: 900; font-family: 'Cairo'; font-size: 15px; color: #34d399; display: block;">تم تحديد تقريرين للمواجهة</span>
                <span style="font-size: 12px; color: #94a3b8;">جاهز لإصدار التقرير التحليلي</span>
            </div>
            <button id="compare-reports-btn" style="background: #10b981; color: white; border: none; padding: 10px 20px; border-radius: 6px; font-weight: 900; font-family: 'Cairo'; cursor: pointer; box-shadow: 0 4px 6px rgba(16, 185, 129, 0.3);">
                <i class="fa-solid fa-scale-balanced"></i> إصدار المقارنة (100 عملة)
            </button>
        </div>
    `;
    document.body.appendChild(floatingBar);

    // منطق التحديد وحركة الشريط العائم
    const checkboxes = document.querySelectorAll(".compare-cb");
    checkboxes.forEach((cb) => {
        cb.addEventListener("change", () => {
            const checked = document.querySelectorAll(".compare-cb:checked");
            if (checked.length > 2) {
                cb.checked = false;
                return CustomDialog.alert(
                    "يمكنك تحديد تقريرين فقط للمقارنة.",
                    "تنبيه",
                );
            }
            // إظهار أو إخفاء الشريط العائم
            if (checked.length === 2) {
                floatingBar.style.bottom = "0";
            } else {
                floatingBar.style.bottom = "-150px";
            }
        });
    });

    document
        .getElementById("compare-reports-btn")
        .addEventListener("click", generateComparisonReport);

    loadComparisonReportsHistory();
};

// ==========================================
// 2. أرشيف تقارير المقارنة
// ==========================================
window.loadComparisonReportsHistory = async function () {
    const container = document.getElementById("comparison-history-container");
    if (!container) return;

    const q = query(
        collection(db, `users/${currentUser.uid}/comparisonReports`),
        orderBy("createdAt", "desc"),
    );
    const snap = await getDocs(q);

    if (snap.empty) return;

    let html = `<h4 style="color:#10b981; font-size:14px; margin-bottom:10px; border-top: 1px dashed #374151; padding-top: 15px;"><i class="fa-solid fa-scale-balanced"></i> أرشيف المواجهات (تقارير المقارنة)</h4>`;
    html += `<div style="display:flex; flex-direction:column; gap:10px;">`;

    window.comparisonReportsCache = {};

    snap.forEach((doc) => {
        const data = doc.data();
        window.comparisonReportsCache[doc.id] = data;

        html += `
            <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(16, 185, 129, 0.05); border:1px solid rgba(16, 185, 129, 0.3); padding:10px; border-radius:8px;">
                <div style="display:flex; flex-direction:column;">
                    <strong style="color:var(--text-main); font-size:13px;">مقارنة بين أسبوعين</strong>
                    <span style="color:var(--text-muted); font-size:11px;">تاريخ الإصدار: ${new Date(data.createdAt).toLocaleDateString("en-GB")}</span>
                </div>
                <button onclick="reDownloadComparisonReport('${doc.id}')" style="background:#10b981; color:white; border:none; padding:5px 12px; border-radius:5px; font-weight:bold; cursor:pointer; font-size:12px;">
                    <i class="fa-solid fa-print"></i> عرض
                </button>
            </div>
        `;
    });
    html += `</div>`;
    container.innerHTML = html;
};

window.reDownloadComparisonReport = function (docId) {
    if (window.comparisonReportsCache && window.comparisonReportsCache[docId]) {
        downloadComparisonReportAsPDF(window.comparisonReportsCache[docId]);
    }
};

// ==========================================
// 3. محرك إنشاء تقرير المقارنة والخوارزمية العسكرية
// ==========================================
window.generateComparisonReport = async function () {
    const checked = Array.from(
        document.querySelectorAll(".compare-cb:checked"),
    ).map((cb) => cb.dataset.id);
    if (checked.length !== 2) return;

    const userRef = doc(db, "users", currentUser.uid);
    const userSnap = await getDoc(userRef);
    const userData = userSnap.data() || {};
    const currentCoins = userData.walletCoins || 0;
    const cost = 100;

    if (currentCoins < cost) {
        return await CustomDialog.alert(
            `تحتاج إلى ${cost} عملة لإصدار تقرير المقارنة.`,
            "رصيد غير كافٍ",
        );
    }

    const confirmPrint = await CustomDialog.confirm(
        `سيتم خصم ${cost} عملة لإنشاء دراسة مقارنة بين الأسبوعين المحددين وحفظها في أرشيفك. استمرار؟`,
        "تأكيد الدفع",
    );
    if (!confirmPrint) return;

    const btn = document.getElementById("compare-reports-btn");
    const originalText = btn.innerHTML;
    btn.innerHTML =
        "<i class='fa-solid fa-spinner fa-spin'></i> جاري التحليل...";
    btn.disabled = true;

    try {
        await updateDoc(userRef, { walletCoins: increment(-cost) });
        window.syncUserUI();

        let repA = window.userReportsCache[checked[0]];
        let repB = window.userReportsCache[checked[1]];
        if (repA.createdAt > repB.createdAt) {
            let temp = repA;
            repA = repB;
            repB = temp;
        }

        const sumArr = (arr) => (arr || []).reduce((a, b) => a + b, 0);

        const compData = {
            createdAt: Date.now(),
            oldDateStr: repA.dateStr,
            newDateStr: repB.dateStr,

            oldPoints:
                repA.totalEarnedPoints !== undefined
                    ? repA.totalEarnedPoints
                    : repA.totalDopamineGained || 0,
            newPoints:
                repB.totalEarnedPoints !== undefined
                    ? repB.totalEarnedPoints
                    : repB.totalDopamineGained || 0,

            oldPassedDays: repA.passedDays || 0,
            newPassedDays: repB.passedDays || 0,

            oldStudyMins: sumArr(repA.studyMinsArr),
            newStudyMins: sumArr(repB.studyMinsArr),

            oldWastedMins: sumArr(repA.wastedMinsArr),
            newWastedMins: sumArr(repB.wastedMinsArr),

            oldShortsMins: sumArr(repA.shortsMinsArr),
            newShortsMins: sumArr(repB.shortsMinsArr),
        };

        compData.oldDistractions =
            compData.oldWastedMins + compData.oldShortsMins;
        compData.newDistractions =
            compData.newWastedMins + compData.newShortsMins;

        let conclusion = "";
        let theme = "green";

        const pointsUp = compData.newPoints >= compData.oldPoints;
        const distDown = compData.newDistractions <= compData.oldDistractions;
        const studyUp = compData.newStudyMins >= compData.oldStudyMins;

        if (pointsUp && distDown) {
            theme = "green";
            conclusion =
                "🟢 أداء استثنائي: لقد نجحت في رفع معدل التزامك بالمهام (النقاط) بالتزامن مع ترويضك للمشتتات وتقليل وقت الشاشة المهدر. هذا هو الانضباط الحقيقي، أنت تحكم السيطرة بالكامل. استمر في هذا المسار التصاعدي.";
        } else if (pointsUp && !distDown) {
            theme = "yellow";
            conclusion =
                "🟡 التزام مسموم (هش): الأرقام تظهر أنك تنجز مهامك وتجمع النقاط، لكنك في المقابل تستنزف وقتك وطاقتك بشكل أكبر في المشتتات والشورتس. هذا التقدم هش، وازدياد وقت الشاشة سيسقطك قريباً إن لم تحكم السيطرة وتوازن المعادلة.";
        } else if (!pointsUp && distDown) {
            theme = "yellow";
            conclusion =
                "🟡 تراجع نظيف: رغم انخفاض معدل إنجازك للمهام وحصيلة نقاطك، يُحسب لك قدرتك على تقليل استهلاك الشاشة والمشتتات مقارنة بالأسبوع الماضي. طاقتك الآن محفوظة ولم تُهدر، تحتاج فقط لتوجيهها بجدية وصرامة نحو المهام المتراكمة.";
        } else {
            theme = "red";
            conclusion =
                "🔴 الانهيار الشامل (طوارئ): تراجع واضح في معدل الانضباط والنقاط، يرافقه انفلات خطير في استهلاك الشاشة والملهيات. النظام ينهار وتحتاج إلى وقفة عسكرية صارمة وفورية لإعادة الأمور إلى نصابها قبل أن تفقد السيطرة تماماً.";
        }

        let studyDiffH =
            Math.abs(compData.newStudyMins - compData.oldStudyMins) / 60;
        if (studyUp && studyDiffH > 0)
            conclusion += `<br><br><b>🎯 العمل العميق:</b> لقد زدت من ساعات تركيزك بمقدار ${studyDiffH.toFixed(1)} ساعة هذا الأسبوع. عمل ممتاز.`;
        else if (!studyUp && studyDiffH > 0)
            conclusion += `<br><br><b>⚠️ العمل العميق:</b> لقد خسرت ${studyDiffH.toFixed(1)} ساعة من وقت التركيز والدراسة مقارنة بالأسبوع الماضي. راجع أولوياتك.`;

        compData.militarySummary = conclusion;
        compData.theme = theme;

        const docId = Date.now().toString();
        await setDoc(
            doc(db, `users/${currentUser.uid}/comparisonReports`, docId),
            compData,
        );

        loadComparisonReportsHistory();
        downloadComparisonReportAsPDF(compData);
    } catch (error) {
        console.error("Comparison Error:", error);
        await CustomDialog.alert("حدث خطأ أثناء بناء المقارنة.", "خطأ");
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;

        // تفريغ الاختيارات وإخفاء الشريط العائم
        document
            .querySelectorAll(".compare-cb")
            .forEach((cb) => (cb.checked = false));
        const floatingBar = document.getElementById("compare-floating-bar");
        if (floatingBar) floatingBar.style.bottom = "-100px";
    }
};

// ==========================================
// 4. محرك طباعة تقرير المقارنة (Dynamic Colors & Native Print)
// ==========================================
window.downloadComparisonReportAsPDF = async function (comp) {
    const userName =
        document.getElementById("profile-name-input")?.value || "الجندي";

    const oldReport = document.getElementById("native-report-wrapper");
    if (oldReport) oldReport.remove();

    const getChangeBadge = (oldVal, newVal, reverseLogic = false) => {
        if (oldVal === 0 && newVal === 0)
            return `<span style="font-size:13px; color:#6b7280; background:#f3f4f6; padding:2px 6px; border-radius:4px;">ثبات 0%</span>`;
        const diff = newVal - oldVal;
        const perc =
            oldVal === 0 ? 100 : Math.round((Math.abs(diff) / oldVal) * 100);

        let isGood = diff >= 0;
        if (reverseLogic) isGood = diff <= 0;

        if (diff === 0)
            return `<span style="font-size:13px; color:#6b7280; background:#f3f4f6; padding:2px 6px; border-radius:4px;">ثبات</span>`;

        const color = isGood ? "#10b981" : "#ef4444";
        const bg = isGood ? "#ecfdf5" : "#fef2f2";
        const icon = diff > 0 ? "fa-arrow-trend-up" : "fa-arrow-trend-down";
        const text = diff > 0 ? "زيادة" : "نقصان";

        return `<span style="font-size:13px; color:${color}; background:${bg}; padding:3px 8px; border-radius:4px; font-weight:bold;"><i class="fa-solid ${icon}"></i> ${text} ${perc}%</span>`;
    };

    const formatHours = (mins) => `${Math.floor(mins / 60)}س و ${mins % 60}د`;

    // نظام الألوان الذكي بناءً على نتيجة الأسبوع
    const themes = {
        green: {
            vsBg: "linear-gradient(135deg, #10b981, #059669)",
            vsBadgeText: "#059669",
            sumBg: "#ecfdf5",
            sumBorder: "#10b981",
            sumText: "#064e3b",
            sumTitle: "#047857",
        },
        yellow: {
            vsBg: "linear-gradient(135deg, #f59e0b, #d97706)",
            vsBadgeText: "#d97706",
            sumBg: "#fffbeb",
            sumBorder: "#f59e0b",
            sumText: "#78350f",
            sumTitle: "#b45309",
        },
        red: {
            vsBg: "linear-gradient(135deg, #ef4444, #dc2626)",
            vsBadgeText: "#dc2626",
            sumBg: "#fef2f2",
            sumBorder: "#ef4444",
            sumText: "#7f1d1d",
            sumTitle: "#b91c1c",
        },
    };

    // تأمين القديم ليعمل باللون الأخضر افتراضياً
    const th = themes[comp.theme || "green"];

    const wrapper = document.createElement("div");
    wrapper.id = "native-report-wrapper";
    wrapper.style.cssText =
        "position: absolute; top: 0; left: 0; width: 100%; min-height: 100vh; background: #f1f5f9; z-index: 9999999; padding: 15px; direction: rtl; font-family: 'Cairo', sans-serif;";

    wrapper.innerHTML = `
        <style>
            #native-report-wrapper * { box-sizing: border-box !important; }
            .comp-container { width: 100%; max-width: 850px; margin: 50px auto; background: white; padding: 30px; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.1); color: #111827; }
            .comp-title { color: #1e3a8a; margin: 0 0 5px 0; font-size: 24px; font-weight: 900; text-align: center; }
            .comp-subtitle { color: #64748b; font-size: 14px; text-align: center; margin-bottom: 20px; }
            
            .vs-header { display: flex; justify-content: center; align-items: center; gap: 15px; margin-bottom: 30px; color: white; padding: 20px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
            .vs-box { text-align: center; }
            .vs-box span { display: block; font-size: 13px; color: rgba(255,255,255,0.9); margin-bottom: 5px; }
            .vs-box strong { font-size: 18px; }
            .vs-badge { background: white; font-weight: 900; padding: 6px 12px; border-radius: 50%; font-size: 14px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }

            .cards-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 30px; }
            .comp-card { background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 8px; padding: 20px; }
            .comp-card h4 { margin: 0 0 15px 0; color: #334155; font-size: 15px; border-bottom: 1px solid #e2e8f0; padding-bottom: 8px; }
            .val-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
            .val-old { font-size: 18px; color: #64748b; text-decoration: line-through; }
            .val-new { font-size: 24px; font-weight: 900; color: #0f172a; }
            .val-arrow { color: #cbd5e1; margin: 0 10px; }

            .chart-wrapper { width: 100%; height: 300px; margin-bottom: 30px; border: 1px solid #cbd5e1; border-radius: 8px; padding: 15px; background: #fff; }
            canvas { width: 100% !important; height: 100% !important; display: block; }

            .summary-box { border-radius: 8px; padding: 25px; margin-top: 20px; }
            .summary-box h3 { margin-top: 0; font-size: 18px; margin-bottom: 15px; }

            .avoid-break { page-break-inside: avoid; break-inside: avoid; }

            @media (max-width: 650px) {
                .comp-container { padding: 15px; }
                .cards-grid { grid-template-columns: 1fr; }
                .vs-header { flex-direction: column; gap: 10px; }
                .chart-wrapper { height: 250px; }
            }

            @media print {
                @page { size: A4 portrait; margin: 10mm; }
                html, body { background: white !important; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
                body > *:not(#native-report-wrapper) { display: none !important; }
                #native-report-wrapper { position: static !important; width: 100% !important; padding: 0 !important; background: white !important; }
                .comp-container { box-shadow: none !important; padding: 0 !important; border: none !important; }
                .no-print { display: none !important; }
                .chart-wrapper, .cards-grid { page-break-inside: avoid; }
            }
        </style>
        
        <div class="comp-container">
            <div class="no-print" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px; border-bottom: 1px dashed #cbd5e1; padding-bottom: 15px;">
            <h3 style="margin: 0; color: #1e3a8a; font-size: 16px;">المواجهة</h3>
                <div><button id="close-comp-btn" style="background: #ef4444; color: white; border: none; padding: 6px 10px; border-radius: 6px; font-weight: bold; font-family: 'Cairo'; cursor: pointer;"><i class="fa-solid fa-xmark"></i> إغلاق</button>
                <button id="print-comp-btn" style="background: #10b981; color: white; border: none; padding: 6px 10px; border-radius: 6px; font-weight: bold; font-family: 'Cairo'; cursor: pointer;"><i class="fa-solid fa-print"></i> حفظ كـ PDF</button></div>
            </div>

            <h1 class="comp-title">⚔️ دراسة المقارنة والتقاطع ⚔️</h1>
            <p class="comp-subtitle">القيادة المركزية - تحليل التطور أو التراجع بين أسبوعين</p>

            <div class="vs-header avoid-break" style="background: ${th.vsBg};">
                <div class="vs-box"><span>الأسبوع الأقدم</span><strong>${comp.oldDateStr}</strong></div>
                <div class="vs-badge" style="color: ${th.vsBadgeText};">VS</div>
                <div class="vs-box"><span>الأسبوع الأحدث</span><strong>${comp.newDateStr}</strong></div>
            </div>

            <div class="cards-grid avoid-break">
                <div class="comp-card">
                    <h4>🎯 إجمالي النقاط والالتزام</h4>
                    <div class="val-row">
                        <div><span class="val-old">${comp.oldPoints}</span> <i class="fa-solid fa-arrow-left val-arrow"></i> <span class="val-new">${comp.newPoints}</span></div>
                        ${getChangeBadge(comp.oldPoints, comp.newPoints, false)}
                    </div>
                </div>

                <div class="comp-card">
                    <h4>🏆 أيام النجاح المؤكدة</h4>
                    <div class="val-row">
                        <div><span class="val-old">${comp.oldPassedDays}</span> <i class="fa-solid fa-arrow-left val-arrow"></i> <span class="val-new">${comp.newPassedDays}</span></div>
                        ${getChangeBadge(comp.oldPassedDays, comp.newPassedDays, false)}
                    </div>
                </div>

                <div class="comp-card" style="border-color: #fca5a5;">
                    <h4 style="color: #ef4444;">📱 المشتتات والسموم (مهدر + شورتس)</h4>
                    <div class="val-row">
                        <div><span class="val-old">${formatHours(comp.oldDistractions)}</span> <i class="fa-solid fa-arrow-left val-arrow"></i> <span class="val-new">${formatHours(comp.newDistractions)}</span></div>
                        ${getChangeBadge(comp.oldDistractions, comp.newDistractions, true)}
                    </div>
                </div>

                <div class="comp-card" style="border-color: #6ee7b7;">
                    <h4 style="color: #10b981;">🧠 وقت العمل العميق (الدراسة)</h4>
                    <div class="val-row">
                        <div><span class="val-old">${formatHours(comp.oldStudyMins)}</span> <i class="fa-solid fa-arrow-left val-arrow"></i> <span class="val-new">${formatHours(comp.newStudyMins)}</span></div>
                        ${getChangeBadge(comp.oldStudyMins, comp.newStudyMins, false)}
                    </div>
                </div>
            </div>

            <h3 style="color: #1e3a8a; font-size: 16px; margin-bottom: 10px;">📊 مقارنة أوقات الشاشة (بالساعات)</h3>
            <div class="chart-wrapper avoid-break"><canvas id="comp-screen-chart"></canvas></div>

            <div class="summary-box avoid-break" style="background: ${th.sumBg}; border-right: 5px solid ${th.sumBorder}; color: ${th.sumText};">
                <h3 style="color: ${th.sumTitle};"><i class="fa-solid fa-microchip"></i> استنتاج القيادة المركزية</h3>
                <div style="line-height: 1.8; font-size: 15px;">${comp.militarySummary}</div>
            </div>
        </div>
    `;

    document.body.appendChild(wrapper);

    const oldScreenData = [
        comp.oldStudyMins / 60,
        comp.oldWastedMins / 60,
        comp.oldShortsMins / 60,
    ];
    const newScreenData = [
        comp.newStudyMins / 60,
        comp.newWastedMins / 60,
        comp.newShortsMins / 60,
    ];

    const currentDPR = window.devicePixelRatio
        ? Math.max(window.devicePixelRatio, 2)
        : 2;

    new Chart(document.getElementById("comp-screen-chart"), {
        type: "bar",
        data: {
            labels: ["العمل والدراسة", "الوقت المهدر", "الشورتس"],
            datasets: [
                {
                    label: "الأسبوع القديم",
                    data: oldScreenData,
                    backgroundColor: "#94a3b8",
                    borderRadius: 4,
                },
                {
                    label: "الأسبوع الجديد",
                    data: newScreenData,
                    backgroundColor: ["#10b981", "#f59e0b", "#ef4444"],
                    borderRadius: 4,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            devicePixelRatio: currentDPR,
            plugins: {
                legend: {
                    position: "top",
                    labels: { font: { family: "'Cairo', sans-serif" } },
                },
            },
            scales: {
                y: {
                    beginAtZero: true,
                    title: {
                        display: true,
                        text: "الساعات",
                        font: { family: "'Cairo'" },
                    },
                },
            },
        },
    });

    document
        .getElementById("close-comp-btn")
        .addEventListener("click", () => wrapper.remove());
    document
        .getElementById("print-comp-btn")
        .addEventListener("click", () => window.print());
};

// 3. دالة وسيطة للزر في الأرشيف
window.reDownloadReport = async function (docId) {
    if (!window.userReportsCache || !window.userReportsCache[docId]) return;
    const data = window.userReportsCache[docId];
    CustomDialog.alert(
        "جاري تجهيز وبناء الـ PDF... يرجى الانتظار ثوانٍ.",
        "تحميل التقرير ⏳",
    );
    await window.downloadReportAsPDF(data);
};

// ==========================================
// 4. الزر الأساسي لجمع البيانات وصناعة التقرير (تم إضافة نظام الترتيب)
// ==========================================
document
    .getElementById("generate-user-report-btn")
    ?.addEventListener("click", async () => {
        if (!currentUser) return;

        const userRef = doc(db, "users", currentUser.uid);
        const userSnap = await getDoc(userRef);
        const userData = userSnap.data() || {};

        const currentCoins = userData.walletCoins || 0;
        const reportCost = 50;

        if (currentCoins < reportCost) {
            return await CustomDialog.alert(
                `رصيدك لا يكفي. تحتاج إلى ${reportCost} عملة لاستخراج التقرير.`,
                "رصيد غير كافٍ 💳",
            );
        }

        const confirmPrint = await CustomDialog.confirm(
            `استخراج التقرير سيكلفك ${reportCost} عملة. سيقوم النظام بدراسة آخر 7 أيام (بدون احتساب اليوم الحالي). هل تريد الاستمرار؟`,
            "تأكيد الدفع 💰",
        );
        if (!confirmPrint) return;

        const btn = document.getElementById("generate-user-report-btn");
        const originalText = btn.innerHTML;
        btn.innerHTML =
            "<i class='fa-solid fa-spinner fa-spin'></i> جاري سحب وتحليل البيانات...";
        btn.disabled = true;

        try {
            await updateDoc(userRef, { walletCoins: increment(-reportCost) });
            window.syncUserUI();

            const tasksMap = {};
            const relTasksMap = {};

            const [normSnap, relSnap] = await Promise.all([
                getDocs(collection(db, "tasks")),
                getDocs(collection(db, "religiousTasks")),
            ]);

            // معالجة المهام العادية وسحب الترتيب
            normSnap.forEach((d) => {
                const data = d.data();
                let maxDaily = 0;
                if (data.isMultiSelect) {
                    maxDaily = (data.options || []).reduce(
                        (sum, opt) => sum + (Number(opt.points) || 0),
                        0,
                    );
                } else {
                    maxDaily = Math.max(
                        0,
                        ...(data.options || []).map(
                            (opt) => Number(opt.points) || 0,
                        ),
                    );
                }
                tasksMap[d.id] = {
                    title: data.name,
                    order: data.order !== undefined ? data.order : 99, // 🛑 سحب الترتيب
                    options: data.options || [],
                    maxDaily,
                    earnedPoints: 0,
                    selectionCounts: {},
                };
                (data.options || []).forEach(
                    (_, i) => (tasksMap[d.id].selectionCounts[i] = 0),
                );
            });

            // معالجة المهام الدينية وسحب الترتيب
            relSnap.forEach((d) => {
                const data = d.data();
                let maxDaily = 0;
                if (data.isMultiSelect) {
                    maxDaily = (data.options || []).reduce(
                        (sum, opt) => sum + (Number(opt.points) || 0),
                        0,
                    );
                } else {
                    maxDaily = Math.max(
                        0,
                        ...(data.options || []).map(
                            (opt) => Number(opt.points) || 0,
                        ),
                    );
                }
                relTasksMap[d.id] = {
                    title: data.title,
                    order: data.order !== undefined ? data.order : 99, // 🛑 سحب الترتيب
                    options: data.options || [],
                    maxDaily,
                    earnedPoints: 0,
                    selectionCounts: {},
                };
                (data.options || []).forEach(
                    (_, i) => (relTasksMap[d.id].selectionCounts[i] = 0),
                );
            });

            // توليد تواريخ الـ 7 أيام السابقة (استبعاد اليوم)
            const targetDates = [];
            const realNow =
                typeof getRealNow === "function" ? getRealNow() : new Date();
            for (let i = 7; i >= 1; i--) {
                let d = new Date(realNow);
                d.setDate(d.getDate() - i);
                let yyyy = d.getFullYear();
                let mm = String(d.getMonth() + 1).padStart(2, "0");
                let dd = String(d.getDate()).padStart(2, "0");
                targetDates.push(`${yyyy}-${mm}-${dd}`);
            }

            const logsSnap = await getDocs(
                query(
                    collection(db, `users/${currentUser.uid}/dailyLogs`),
                    orderBy("date", "desc"),
                ),
            );
            const logsMap = {};
            logsSnap.forEach((doc) => {
                if (doc.data().isFinalized)
                    logsMap[doc.data().date] = doc.data();
            });

            // التحقق من وجود سجلات في الأيام الـ 7 المطلوبة
            let hasValidLogs = false;
            targetDates.forEach((d) => {
                if (logsMap[d]) hasValidLogs = true;
            });

            if (!hasValidLogs) {
                await updateDoc(userRef, {
                    walletCoins: increment(reportCost),
                });
                window.syncUserUI();
                await CustomDialog.alert(
                    "لا توجد سجلات معتمدة في الـ 7 أيام السابقة لبناء التقرير. تمت إعادة أموالك.",
                    "لا توجد بيانات",
                );
                return;
            }

            const dates = [];
            const points = [];
            const wastedMinsArr = [];
            const studyMinsArr = [];
            const shortsMinsArr = [];
            const othersMinsArr = [];
            let passedDays = 0;
            let totalEarnedPoints = 0;

            targetDates.forEach((dateStr) => {
                dates.push(dateStr);
                const log = logsMap[dateStr];
                if (log) {
                    let pts = log.pointsEarned || 0;
                    if (
                        pts === 0 &&
                        log.dopamineData &&
                        log.dopamineData.pointsAwarded
                    ) {
                        pts = log.dopamineData.pointsAwarded;
                    }
                    points.push(pts);
                    totalEarnedPoints += pts;

                    if (log.passed) passedDays++;

                    const dop = log.dopamineData;
                    if (dop && dop.evaluationMode === "honor_system") {
                        wastedMinsArr.push(dop.reportedWastedMinutes || 0);
                        studyMinsArr.push(dop.reportedStudyMinutes || 0);
                        shortsMinsArr.push(dop.reportedShortsMinutes || 0);
                        othersMinsArr.push(dop.reportedOthersMinutes || 0);
                    } else {
                        wastedMinsArr.push(0);
                        studyMinsArr.push(0);
                        shortsMinsArr.push(0);
                        othersMinsArr.push(0);
                    }

                    Object.entries(log.selections || {}).forEach(
                        ([taskId, sel]) => {
                            const task = tasksMap[taskId];
                            if (task) {
                                let selArray = Array.isArray(sel) ? sel : [sel];
                                selArray.forEach((idx) => {
                                    if (task.options[idx]) {
                                        task.selectionCounts[idx]++;
                                        task.earnedPoints +=
                                            Number(task.options[idx].points) ||
                                            0;
                                    }
                                });
                            }
                        },
                    );

                    Object.entries(log.religiousSelections || {}).forEach(
                        ([taskId, sel]) => {
                            const task = relTasksMap[taskId];
                            if (task) {
                                let selArray = Array.isArray(sel) ? sel : [sel];
                                selArray.forEach((idx) => {
                                    if (typeof idx === "boolean") return;
                                    if (task.options[idx]) {
                                        task.selectionCounts[idx]++;
                                        task.earnedPoints +=
                                            Number(task.options[idx].points) ||
                                            0;
                                    }
                                });
                            }
                        },
                    );
                } else {
                    points.push(0);
                    wastedMinsArr.push(0);
                    studyMinsArr.push(0);
                    shortsMinsArr.push(0);
                    othersMinsArr.push(0);
                }
            });

            // دالة مجمعة لإنشاء الجداول
            const generateHtmlForTasks = (mapObj) => {
                let qualityHtml = "";
                let detailsHtml = "";

                // 🛑 الضربة القاضية: ترتيب المهام بناءً على قيمة order تصاعدياً
                const sortedTasks = Object.values(mapObj).sort(
                    (a, b) => a.order - b.order,
                );

                sortedTasks.forEach((task) => {
                    const maxTotal = task.maxDaily * 7;
                    let percentage =
                        maxTotal > 0
                            ? Math.round((task.earnedPoints / maxTotal) * 100)
                            : 0;
                    if (percentage > 100) percentage = 100;

                    const barColor =
                        percentage >= 80
                            ? "#10b981"
                            : percentage >= 50
                              ? "#f59e0b"
                              : "#ef4444";

                    qualityHtml += `
                    <tr>
                        <td style="font-weight: bold;">${task.title}</td>
                        <td>
                            <div style="display: flex; align-items: center; gap: 10px;">
                                <div style="flex-grow: 1; background: #e5e7eb; border-radius: 10px; height: 14px; overflow: hidden; border: 1px solid #d1d5db;">
                                    <div style="width: ${percentage}%; background: ${barColor}; height: 100%; border-radius: 10px; transition: width 0.5s;"></div>
                                </div>
                                <span style="font-weight: 900; color: ${barColor}; min-width: 45px; font-size: 14px;">${percentage}%</span>
                            </div>
                        </td>
                    </tr>
                `;

                    let optionsBadges =
                        '<div style="display: flex; flex-wrap: wrap; gap: 8px;">';
                    task.options.forEach((opt, idx) => {
                        const count = task.selectionCounts[idx] || 0;
                        optionsBadges += `<span style="background: #f8fafc; border: 1px solid #cbd5e1; padding: 4px 8px; border-radius: 6px; font-size: 12px; color: #334155;">${opt.name}: <b style="color: ${count > 0 ? "#1e3a8a" : "#94a3b8"};">${count}</b> مرات</span>`;
                    });
                    optionsBadges += "</div>";

                    detailsHtml += `
                    <tr>
                        <td style="font-weight: bold; color: #1e293b;">${task.title}</td>
                        <td>${optionsBadges}</td>
                    </tr>
                `;
                });
                return { qualityHtml, detailsHtml };
            };

            const relHtml = generateHtmlForTasks(relTasksMap);
            const normHtml = generateHtmlForTasks(tasksMap);

            const reportData = {
                createdAt: Date.now(),
                dateStr: new Date().toLocaleDateString("en-GB"),
                passedDays,
                totalEarnedPoints,
                dates,
                points,
                studyMinsArr,
                wastedMinsArr,
                othersMinsArr,
                shortsMinsArr,
                relQualityHtml: relHtml.qualityHtml,
                relDetailsHtml: relHtml.detailsHtml,
                normalQualityHtml: normHtml.qualityHtml,
                normalDetailsHtml: normHtml.detailsHtml,
            };

            const reportDocId = Date.now().toString();
            await setDoc(
                doc(db, `users/${currentUser.uid}/reports`, reportDocId),
                reportData,
            );

            await window.downloadReportAsPDF(reportData);
            if (typeof window.loadUserReportsHistory === "function")
                window.loadUserReportsHistory();
        } catch (error) {
            console.error("Report Generation Error:", error);
            await CustomDialog.alert(
                "حدث خطأ أثناء تجميع البيانات أو الخصم.",
                "خطأ ❌",
            );
        } finally {
            btn.innerHTML = originalText;
            btn.disabled = false;
        }
    });

// ==========================================
// 🧮 محرك التقييم الديناميكي الحي
// ==========================================

window.userMaxWastedTime = 120;
window.userMaxShortsTime = 30;

// سحب حدود المستخدم (بناءً على رتبته) لكي يكون الحساب الحي دقيقاً
window.fetchUserLimitsForLiveScore = async () => {
    try {
        if (!currentUser) return;
        const userSnap = await getDoc(doc(db, "users", currentUser.uid));
        const lifetimeScore = userSnap.data()?.lifetimeScore || 0;

        let userRank =
            lifetimeScore <= 1000
                ? "beginner"
                : lifetimeScore <= 5000
                  ? "intermediate"
                  : "pro";

        const settingsSnap = await getDoc(doc(db, "systemSettings", "levels"));
        if (settingsSnap.exists()) {
            const limits = settingsSnap.data()[userRank];
            if (limits) {
                window.userMaxWastedTime =
                    limits.maxWastedTime !== undefined
                        ? limits.maxWastedTime
                        : 120;
                window.userMaxShortsTime =
                    limits.maxShortsTime !== undefined
                        ? limits.maxShortsTime
                        : 30;
                window.calculateLiveScores(); // تحديث الأرقام فوراً
            }
        }
    } catch (e) {
        console.warn("Failed to fetch limits:", e);
    }
};

// دالة الحساب المباشر التي يتم استدعاؤها مع كل سحبة
window.calculateLiveScores = function () {
    const totalH =
        parseInt(
            document
                .getElementById("picker-total-h")
                ?.getAttribute("data-value"),
        ) || 0;
    const totalM =
        parseInt(
            document
                .getElementById("picker-total-m")
                ?.getAttribute("data-value"),
        ) || 0;
    const studyH =
        parseInt(
            document
                .getElementById("picker-study-h")
                ?.getAttribute("data-value"),
        ) || 0;
    const studyM =
        parseInt(
            document
                .getElementById("picker-study-m")
                ?.getAttribute("data-value"),
        ) || 0;
    const othersH =
        parseInt(
            document
                .getElementById("picker-others-h")
                ?.getAttribute("data-value"),
        ) || 0;
    const othersM =
        parseInt(
            document
                .getElementById("picker-others-m")
                ?.getAttribute("data-value"),
        ) || 0;
    const shortsH =
        parseInt(
            document
                .getElementById("picker-shorts-h")
                ?.getAttribute("data-value"),
        ) || 0;
    const shortsM =
        parseInt(
            document
                .getElementById("picker-shorts-m")
                ?.getAttribute("data-value"),
        ) || 0;

    const totalMins = totalH * 60 + totalM;
    const studyMins = studyH * 60 + studyM;
    const othersMins = othersH * 60 + othersM;
    const shortsMins = shortsH * 60 + shortsM;

    // 🛑 طرح الدراسة والاستخدام العام من الإجمالي
    let wastedMins = totalMins - studyMins - othersMins;
    if (wastedMins < 0) wastedMins = 0;

    let maxW = window.userMaxWastedTime;
    let maxS = window.userMaxShortsTime;

    let wastedPoints = 0;
    if (maxW === 0) wastedPoints = wastedMins === 0 ? 100 : 0;
    else {
        wastedPoints = 100 * (1 - wastedMins / maxW);
        if (wastedPoints < 0) wastedPoints = 0;
    }

    let shortsPoints = 0;
    if (maxS === 0) shortsPoints = shortsMins === 0 ? 75 : 0;
    else {
        shortsPoints = 75 * (1 - shortsMins / maxS);
        if (shortsPoints < 0) shortsPoints = 0;
    }

    const totalDopamine = Math.floor(wastedPoints + shortsPoints);

    const wEl = document.getElementById("live-wasted-score");
    const sEl = document.getElementById("live-shorts-score");
    const tEl = document.getElementById("live-total-score");

    if (wEl) {
        wEl.innerText = Math.floor(wastedPoints);
        wEl.style.color =
            wastedPoints >= 50 ? "var(--success)" : "var(--danger)";
    }
    if (sEl) {
        sEl.innerText = Math.floor(shortsPoints);
        sEl.style.color =
            shortsPoints >= 40 ? "var(--success)" : "var(--danger)";
    }
    if (tEl) tEl.innerText = totalDopamine;
    // 🛑 الحفظ المحلي الصامت (يُحفظ في المتصفح فقط ولا يُرسل للسيرفر لتجنب خداع المنقذ الذكي)
    if (!isTodayFinalized) {
        const todayStr = getCairoDateString(getRealNow());
        localStorage.setItem(
            "brainrot_time_pickers",
            JSON.stringify({
                date: todayStr,
                th: totalH,
                tm: totalM,
                sh: studyH,
                sm: studyM,
                oh: othersH,
                om: othersM,
                shortsH: shortsH,
                shortsM: shortsM,
            }),
        );
    }
};

// جلب الحدود بمجرد دخول المستخدم
setTimeout(() => {
    if (typeof window.fetchUserLimitsForLiveScore === "function")
        window.fetchUserLimitsForLiveScore();
}, 2500);

// ==========================================
// ⚙️ محرك بكرات الوقت (Custom Time Pickers)
// ==========================================

// دالة لبناء وتشغيل البكرات (نسخة صامتة وخفيفة الأداء)
function initAllTimePickers() {
    document.querySelectorAll(".picker-column").forEach((column) => {
        const maxVal = parseInt(column.getAttribute("data-max"));
        column.innerHTML = "";

        for (let i = 0; i <= maxVal; i++) {
            const item = document.createElement("div");
            item.className = "picker-item";
            item.innerText = i.toString().padStart(2, "0");
            column.appendChild(item);
        }

        if (column.children.length > 0)
            column.children[0].classList.add("active");

        let lastIndex = 0;
        let isScrollingTimeout;

        column.addEventListener("scroll", () => {
            column.setAttribute("data-scrolling", "true");
            clearTimeout(isScrollingTimeout);
            isScrollingTimeout = setTimeout(() => {
                column.setAttribute("data-scrolling", "false");
            }, 200);

            const currentIndex = Math.round(column.scrollTop / 40);

            if (
                currentIndex !== lastIndex &&
                currentIndex >= 0 &&
                currentIndex <= maxVal
            ) {
                lastIndex = currentIndex;

                // 🛑 تم إزالة استدعاء الصوت من هنا لتخفيف الضغط على المعالج
                column.setAttribute("data-value", currentIndex);
                setTimeout(() => {
                    if (typeof window.calculateLiveScores === "function")
                        window.calculateLiveScores();
                }, 800);
                Array.from(column.children).forEach((child, idx) => {
                    if (idx === currentIndex) child.classList.add("active");
                    else child.classList.remove("active");
                });
            }
        });

        // =========================================
        // 🛑 الكتابة الحية (In-place Editing) - النسخة المصححة
        // =========================================
        column.addEventListener("click", () => {
            if (column.getAttribute("data-scrolling") === "true") return;

            const activeItem = column.querySelector(".picker-item.active");
            if (!activeItem || activeItem.isContentEditable) return;

            // 🛑 حفظ الرقم الأصلي للعنصر قبل أن يكتب المستخدم فوقه
            const originalVal =
                parseInt(column.getAttribute("data-value")) || 0;

            activeItem.contentEditable = "true";
            activeItem.inputMode = "numeric";
            activeItem.focus();

            const range = document.createRange();
            range.selectNodeContents(activeItem);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);

            activeItem.style.background = "rgba(168, 85, 247, 0.2)";
            activeItem.style.borderRadius = "6px";
            activeItem.style.color = "#fff";

            const finishEditing = () => {
                activeItem.contentEditable = "false";
                activeItem.style.background = "transparent";
                activeItem.style.color = "";
                window.getSelection().removeAllRanges();

                let num = parseInt(activeItem.innerText);
                if (isNaN(num)) num = originalVal;

                if (num < 0) num = 0;
                if (num > maxVal) num = maxVal;

                // 🛑 الكي البرمجي: نعيد العنصر لرقمه الأصلي لكي لا يخرب ترتيب البكرة
                activeItem.innerText = originalVal.toString().padStart(2, "0");

                column.scrollTo({
                    top: num * 40,
                    behavior: "smooth",
                });
                setTimeout(() => {
                    if (typeof window.calculateLiveScores === "function")
                        window.calculateLiveScores();
                }, 800);

                activeItem.removeEventListener("blur", finishEditing);
                activeItem.removeEventListener("keydown", keydownHandler);
            };

            const keydownHandler = (event) => {
                if (event.key === "Enter") {
                    event.preventDefault();
                    activeItem.blur();
                }
            };

            activeItem.addEventListener("blur", finishEditing);
            activeItem.addEventListener("keydown", keydownHandler);
        });
    });
}

// تشغيل البكرات فور تحميل الصفحة لتعمل مباشرة تحت المهام
document.addEventListener("DOMContentLoaded", initAllTimePickers);

// ==========================================
// ⚖️ العقل المدبر: اعتماد المهام + التقييم (زر واحد للكل)
// ==========================================
document
    .getElementById("submit-day-btn")
    ?.addEventListener("click", async () => {
        if (!currentUser || isTodayFinalized) return;

        // 1. حاجز الوقت
        const now = getRealNow();
        const cairoTimeStr = now.toLocaleString("en-US", {
            timeZone: "Africa/Cairo",
            hour12: false,
        });
        const cairoDate = new Date(cairoTimeStr);
        const currentHour = cairoDate.getHours();
        const startH = window.submissionStartHour;
        const endH = window.dayStartHour;

        if (!(currentHour >= startH || currentHour < endH)) {
            const formatHour = (h) => {
                let ampm = h >= 12 ? "مساءً" : "صباحاً";
                let hours12 = h % 12 || 12;
                return `${hours12}:00 ${ampm}`;
            };
            return await CustomDialog.alert(
                `لا يمكنك اعتماد يومك الآن. النافذة تفتح من ${formatHour(startH)} إلى ${formatHour(endH)}.`,
                "النافذة مغلقة 🛑",
            );
        }

        // 2. سحب بيانات بكرات الوقت (بما فيها الاستخدام العام)
        const totalH =
            parseInt(
                document
                    .getElementById("picker-total-h")
                    .getAttribute("data-value"),
            ) || 0;
        const totalM =
            parseInt(
                document
                    .getElementById("picker-total-m")
                    .getAttribute("data-value"),
            ) || 0;
        const studyH =
            parseInt(
                document
                    .getElementById("picker-study-h")
                    .getAttribute("data-value"),
            ) || 0;
        const studyM =
            parseInt(
                document
                    .getElementById("picker-study-m")
                    .getAttribute("data-value"),
            ) || 0;
        const othersH =
            parseInt(
                document
                    .getElementById("picker-others-h")
                    .getAttribute("data-value"),
            ) || 0;
        const othersM =
            parseInt(
                document
                    .getElementById("picker-others-m")
                    .getAttribute("data-value"),
            ) || 0;
        const shortsH =
            parseInt(
                document
                    .getElementById("picker-shorts-h")
                    .getAttribute("data-value"),
            ) || 0;
        const shortsM =
            parseInt(
                document
                    .getElementById("picker-shorts-m")
                    .getAttribute("data-value"),
            ) || 0;

        const totalMins = totalH * 60 + totalM;
        const studyMins = studyH * 60 + studyM;
        const othersMins = othersH * 60 + othersM;
        const shortsMins = shortsH * 60 + shortsM;

        if (
            totalMins === 0 &&
            studyMins === 0 &&
            othersMins === 0 &&
            shortsMins === 0
        ) {
            const isSure = await CustomDialog.confirm(
                "كل أوقات الشاشة أصفار! هل فعلاً لم تلمس هاتفك اليوم؟",
                "تأكيد 🧐",
            );
            if (!isSure) return;
        }

        // 🛑 المعادلة العادلة الجديدة
        let wastedMins = totalMins - studyMins - othersMins;
        if (wastedMins < 0) wastedMins = 0;

        // 3. فحص تخاذل المهام (العادية والدينية)
        const {
            totalPoints: taskPoints,
            selections,
            missingNormalImportant,
        } = getCurrentSelectionsAndPoints();
        let missingRelImportant = false;
        const currentRelSelections = {};

        document.querySelectorAll(".rel-task-select").forEach((s) => {
            let id = s.getAttribute("data-task-id");
            let val = parseInt(
                s.options[s.selectedIndex].getAttribute("data-index"),
            );
            currentRelSelections[id] = val;
            if (window.importantRelTaskIds?.includes(id) && val === 0)
                missingRelImportant = true;
        });

        document.querySelectorAll(".rel-checklist-container").forEach((c) => {
            let id = c.getAttribute("data-task-id");
            let arr = [];
            c.querySelectorAll(".rel-task-checkbox:checked").forEach((cb) =>
                arr.push(parseInt(cb.getAttribute("data-index"))),
            );
            if (arr.length === 0) arr = [0];
            currentRelSelections[id] = arr;
            if (
                window.importantRelTaskIds?.includes(id) &&
                (arr.length === 0 || (arr.length === 1 && arr[0] === 0))
            )
                missingRelImportant = true;
        });

        if (missingNormalImportant || missingRelImportant) {
            const isSure = await CustomDialog.confirm(
                "لقد تجاهلت مهام إجبارية أساسية. الاعتماد الآن سيؤدي حتماً إلى الفشل وكسر الستريك. هل أنت متأكد؟",
                "تحذير صارم 🛑",
            );
            if (!isSure) return;
        }

        const btn = document.getElementById("submit-day-btn");
        const originalText = btn.innerHTML;
        btn.innerHTML =
            "<i class='fa-solid fa-spinner fa-spin'></i> جاري إصدار الحكم... ⏳";
        btn.disabled = true;

        try {
            const userRef = doc(db, "users", currentUser.uid);
            const userSnap = await getDoc(userRef);
            const userDataLocal = userSnap.data() || {};
            const lifetimeScore = userDataLocal.lifetimeScore || 0;

            // 4. تحديد الرتب والحدود
            let isBeginner = lifetimeScore <= 1000;
            let isIntermediate = lifetimeScore > 1000 && lifetimeScore <= 5000;
            let isPro = lifetimeScore > 5000;
            let userRank = isBeginner
                ? "beginner"
                : isIntermediate
                  ? "intermediate"
                  : "pro";

            let maxWastedTime = 120;
            let maxShortsTime = 30;

            try {
                const settingsSnap = await getDoc(
                    doc(db, "systemSettings", "levels"),
                );
                if (settingsSnap.exists()) {
                    const limits = settingsSnap.data()[userRank];
                    if (limits) {
                        maxWastedTime =
                            limits.maxWastedTime !== undefined
                                ? limits.maxWastedTime
                                : maxWastedTime;
                        maxShortsTime =
                            limits.maxShortsTime !== undefined
                                ? limits.maxShortsTime
                                : maxShortsTime;
                    }
                }
            } catch (e) {
                console.warn("Failed to fetch limits:", e);
            }

            // 5. حسابات الدوبامين التناسبية
            let wastedPoints = 100 * (1 - wastedMins / maxWastedTime);
            if (wastedPoints < 0) wastedPoints = 0;

            let shortsPoints = 75 * (1 - shortsMins / maxShortsTime);
            if (shortsPoints < 0) shortsPoints = 0;

            const dopaminePoints = Math.floor(wastedPoints + shortsPoints);
            let finalTotalPoints = taskPoints + dopaminePoints;

            let passedToday =
                finalTotalPoints >= dailyTargetPoints &&
                !missingRelImportant &&
                !missingNormalImportant;

            // عقوبة الفشل الكارثي للمبتدئين
            const isCatastrophic =
                wastedMins > maxWastedTime || shortsMins > maxShortsTime;
            if (!passedToday && isBeginner && isCatastrophic) {
                finalTotalPoints = 0; // تصفير النقاط كلياً
            }

            const realNow = getRealNow();
            const today = getCairoDateString(realNow);
            let dbUpdates = { lastEvalDate: today };

            // 6. توثيق السجل في الداتابيز
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
                        evaluationMode: "honor_system",
                        reportedTotalMinutes: totalMins,
                        reportedStudyMinutes: studyMins,
                        reportedOthersMinutes: othersMins, // حفظ وقت الاستخدام العام
                        reportedWastedMinutes: wastedMins,
                        reportedShortsMinutes: shortsMins,
                        pointsAwarded: dopaminePoints,
                    },
                },
                { merge: true },
            );

            const pointsDisplay = document.getElementById("today-points");
            if (pointsDisplay) pointsDisplay.innerText = finalTotalPoints;

            let currentZone = userDataLocal.currentZone || "green";
            const hasDoubleXP = userDataLocal.hasDoubleXP || false;

            // 7. تطبيق الأحكام (نجاح أو فشل) وإظهار البطاقات
            if (passedToday) {
                new Audio(
                    "https://cdn.pixabay.com/download/audio/2021/08/04/audio_0625c1539c.mp3?filename=success-1-6297.mp3",
                )
                    .play()
                    .catch(() => {});
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

                dbUpdates.walletCoins = increment(earnedCoins);
                dbUpdates.currentStreak = increment(1);
                dbUpdates.currentZone = currentZone;
                dbUpdates.currentMultiplier = streakMultiplier;

                let doubleXPMsg = "";
                if (hasDoubleXP) {
                    earnedXP *= 2;
                    dbUpdates.cycleScore = increment(earnedXP);
                    dbUpdates.lifetimeScore = increment(earnedXP);
                    dbUpdates.hasDoubleXP = false;
                    dbUpdates.usedDoubleXP = true;
                    doubleXPMsg = `<span style="color: #fbbf24; font-size: 11px; background: rgba(251, 191, 36, 0.15); border: 1px solid rgba(251,191,36,0.3); padding: 2px 6px; border-radius: 4px; margin-right: 5px;">⚡ دبل XP</span>`;
                } else {
                    dbUpdates.cycleScore = increment(earnedXP);
                    dbUpdates.lifetimeScore = increment(earnedXP);
                }

                let multiMsg =
                    streakMultiplier > 1
                        ? `<span style="color: var(--gold-primary); font-size: 11px; background: rgba(168, 85, 247, 0.15); border: 1px solid rgba(168,85,247,0.3); padding: 2px 6px; border-radius: 4px; margin-right: 5px;">مضاعف الستريك x${streakMultiplier}</span>`
                        : "";

                await updateDoc(userRef, dbUpdates);

                // 🛑 بطاقة النجاح الفاخرة
                await CustomDialog.alert(
                    `
                <div style="background: rgba(16, 185, 129, 0.05); border-right: 3px solid #10b981; padding: 12px; margin-bottom: 8px; border-radius: 6px; text-align: right;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                        <strong style="color: #10b981; font-size: 14px;">✅ اعتماد ناجح: عمل عظيم</strong>
                        <span style="color: #f8fafc; font-size: 13px; font-weight: bold; background: rgba(249, 115, 22, 0.15); padding: 2px 8px; border-radius: 12px; color: #f97316;"><i class="fa-solid fa-fire"></i> ${newStreak}</span>
                    </div>
                    <div style="color: #cbd5e1; font-size: 13px; line-height: 1.8;">
                        <i class="fa-solid fa-scale-balanced fa-fw" style="color: var(--success-color);"></i> تقييم الضمير: <b style="color: white;">+${dopaminePoints} نقطة</b><br>
                        <i class="fa-solid fa-star fa-fw" style="color: var(--gold-primary);"></i> الخبرة: <b style="color: white;">+${earnedXP} XP</b><br>
                        <i class="fa-solid fa-coins fa-fw" style="color: #fbbf24;"></i> العملات: <b style="color: white;">+${earnedCoins}</b>
                    </div>
                    <div style="margin-top: 10px;">
                        ${multiMsg}
                        ${doubleXPMsg}
                    </div>
                </div>
            `,
                    "نتيجة التقييم ⚖️",
                );
            } else {
                const hasFreeze = (userDataLocal.freezeCount || 0) > 0;
                if (hasFreeze) {
                    dbUpdates.freezeCount = increment(-1);
                    await updateDoc(userRef, dbUpdates);

                    // 🛑 بطاقة التجميد
                    await CustomDialog.alert(
                        `
                    <div style="background: rgba(6, 182, 212, 0.05); border-right: 3px solid #06b6d4; padding: 12px; margin-bottom: 8px; border-radius: 4px; text-align: right;">
                        <strong style="color: #06b6d4; font-size: 14px;">❄️ تفعيل طوق النجاة</strong><br>
                        <span style="color: #cbd5e1; font-size: 13px;">جمعت ${finalTotalPoints} نقطة فقط. تم استهلاك "تجميد الستريك" لحمايتك من السقوط.</span>
                    </div>
                `,
                        "تفعيل التجميد التلقائي ❄️",
                    );
                } else {
                    let penaltyCoins = 0;
                    let failCard = `<div style="background: rgba(244, 63, 94, 0.05); border-right: 3px solid #f43f5e; padding: 12px; margin-bottom: 8px; border-radius: 4px; text-align: right;">`;
                    failCard += `<strong style="color: #f43f5e; font-size: 14px;">❌ يوم معتمد: تخاذل وفشل</strong><br>`;
                    failCard += `<span style="color: #cbd5e1; font-size: 13px;">العقوبة الأساسية: كسر الستريك للصفر 💔</span><br>`;

                    dbUpdates.lostStreak = userDataLocal.currentStreak || 0;
                    dbUpdates.streakDeathTimestamp = getRealNow().getTime();
                    dbUpdates.currentStreak = 0;
                    dbUpdates.currentMultiplier = 1.0;

                    // 🛑 بطاقات الفشل الطبقية
                    if (isBeginner) {
                        failCard += `<hr style="border-color: rgba(255,255,255,0.05); margin: 8px 0;">`;
                        failCard += `<span style="color: #34d399; font-size: 12px;"><i class="fa-solid fa-shield-halved"></i> <b>المستوى [مبتدئ]:</b> إعفاء كامل من الغرامات والطرد.</span>`;
                        if (isCatastrophic) {
                            failCard += `<br><span style="color: #ef4444; font-size: 12px; margin-top: 5px; display: block;"><i class="fa-solid fa-triangle-exclamation"></i> <b>فشل كارثي:</b> تم تصفير نقاط مهامك كعقاب على تجاوزك الحد الأقصى.</span>`;
                        }
                    } else if (isIntermediate) {
                        if (currentZone === "green") currentZone = "yellow";
                        else if (currentZone === "yellow") currentZone = "red";
                        penaltyCoins = Math.floor(dailyTargetPoints / 2);
                        dbUpdates.walletCoins = increment(-penaltyCoins);
                        dbUpdates.currentZone = currentZone;

                        failCard += `<span style="color: #fca5a5; font-size: 13px;">الغرامة: -${penaltyCoins} عملة 📉 | الحالة: ${currentZone === "yellow" ? "منطقة صفراء ⚠️" : "منطقة حمراء 🛑"}</span><br>`;
                        failCard += `<hr style="border-color: rgba(255,255,255,0.05); margin: 8px 0;">`;
                        failCard += `<span style="color: var(--text-muted); font-size: 12px;"><i class="fa-solid fa-scale-balanced"></i> <b>المستوى [متوسط]:</b> تم تطبيق نصف الغرامة المالية.</span>`;
                    } else if (isPro) {
                        if (currentZone === "green") currentZone = "yellow";
                        else if (currentZone === "yellow") currentZone = "red";
                        penaltyCoins = dailyTargetPoints;
                        dbUpdates.walletCoins = increment(-penaltyCoins);
                        dbUpdates.currentZone = currentZone;

                        failCard += `<span style="color: #fca5a5; font-size: 13px;">الغرامة: -${penaltyCoins} عملة 📉 | الحالة: ${currentZone === "yellow" ? "منطقة صفراء ⚠️" : "منطقة حمراء 🛑"}</span><br>`;
                        failCard += `<hr style="border-color: rgba(255,255,255,0.05); margin: 8px 0;">`;
                        failCard += `<span style="color: #ef4444; font-size: 12px;"><i class="fa-solid fa-skull"></i> <b>المستوى [محترف]:</b> تم تطبيق الغرامة القصوى. لا رحمة في هذا المستوى.</span>`;
                    }

                    failCard += `</div>`;
                    await updateDoc(userRef, dbUpdates);
                    await CustomDialog.alert(failCard, "تحكيم الضمير ⚖️");
                }
            }

            isTodayFinalized = true;
            // 🛑 حرق المسودة المؤقتة بعد رفع الحكم النهائي للسيرفر
            localStorage.removeItem("brainrot_time_pickers");
            window.syncUserUI();
            if (typeof applyZoneUI === "function") applyZoneUI(currentZone);
        } catch (error) {
            console.error(error);
            await CustomDialog.alert(
                "حدث خطأ أثناء إصدار الحكم: " + error.message,
                "خطأ ⚠️",
            );
        } finally {
            btn.innerHTML = originalText;
            btn.disabled = false;
        }
    });

// ==========================================
// ℹ️ نظام الشروحات (Info Buttons) لمحاكمة الضمير
// ==========================================
document.addEventListener("click", async (e) => {
    // التنصت على أيقونات الشرح
    if (e.target.classList.contains("explain-btn")) {
        const type = e.target.getAttribute("data-type");
        let title = "";
        let desc = "";

        if (type === "total") {
            title = "إجمالي وقت الشاشة 📱";
            desc =
                "هذا هو <b>الرقم الإجمالي</b> السطحي. افتح إعدادات هاتفك (Digital Wellbeing في الأندرويد، أو Screen Time في الآيفون) وانقل الرقم الإجمالي كما هو بالدقيقة. لا تخمن.";
        } else if (type === "study") {
            title = "وقت الدراسة والعمل 📚";
            desc =
                "الوقت الذي قضيته على الشاشة في إنجاز حقيقي <b>فقط</b> (قراءة PDF، مشاهدة كورس تعليمي، مشاهدة مقطع تعليمي على اليوتيوب، الخ..). التصفح العشوائي وتيك توك لا يُحسبان هنا مطلقاً.";
        } else if (type === "others") {
            title = "الاستخدام العام 💬";
            desc =
                "وقت ضروري لا يمكن اعتباره دراسة ولا ضياعاً. مثل: محادثة الأهل على واتساب،استخدام تطبيق لشراء مشترياتك ، استخدام الخرائط، أو الاستعانة بـ ChatGPT.<br><span style='color: var(--danger);'><b>إياك أن تستخدم هذا القسم كمخبأ لتبرير تماطلك!</b></span>";
        } else if (type === "shorts") {
            title = "الشورتس والريلز ☠️";
            desc =
                "سم الدوبامين السريع. افتح إحصائيات التطبيق وانقل وقت استخدامك له هنا لكي يتم معاقبتك عليه بدقة. هذا الوقت لا يغتفر ويخصم من نقاطك فوراً.";
        }

        // إظهار النافذة المنبثقة
        if (title && desc) {
            await CustomDialog.alert(
                `<div style="line-height: 1.8; font-size: 14px; color: var(--text-muted); text-align: right; padding-top: 5px;">${desc}</div>`,
                title,
            );
        }
    }
});

// ==========================================
// 🤖 محرك استخراج الأوقات الذكي (AI Screen Time Reader)
// ==========================================
const aiExtractBtn = document.getElementById("ai-extract-btn");
const aiProofFile = document.getElementById("ai-proof-file");
let extractedAIData = null;

aiExtractBtn?.addEventListener("click", () => aiProofFile.click());

aiProofFile?.addEventListener("change", async (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0 || !currentUser) return;

    const originalText = aiExtractBtn.innerHTML;
    aiExtractBtn.innerHTML =
        "<i class='fa-solid fa-spinner fa-spin'></i> جاري استجواب الذكاء الاصطناعي... ⏳";
    aiExtractBtn.disabled = true;

    try {
        const imageUrls = [];

        // 1. رفع كل صورة بشكل منفصل تماماً بكامل جودتها وأبعادها الأصلية
        for (let i = 0; i < files.length; i++) {
            const storagePath = `ai_screen_proofs/${currentUser.uid}_${Date.now()}_${i}.jpg`;
            const storageRefPath = ref(storage, storagePath);
            await uploadBytes(storageRefPath, files[i]);
            const url = await getDownloadURL(storageRefPath);
            imageUrls.push(url);
        }

        // 2. إرسال مصفوفة الروابط الصافية إلى الدالة السحابية
        const analyzeScreenTime = httpsCallable(
            functions,
            "analyzeScreenTimeProof",
        );
        const result = await analyzeScreenTime({ imageUrls: imageUrls });

        if (result.data.success) {
            const data = result.data.result;
            extractedAIData = data;

            if (data.neutral_apps && data.neutral_apps.length > 0) {
                openNeutralAppsSortingModal(data.neutral_apps);
            } else {
                applyAIExtractedTimes(
                    data.explicit_study,
                    data.explicit_others,
                    data.explicit_shorts,
                    data.total_minutes,
                );
                CustomDialog.alert(
                    "تم استخراج الأوقات بدقة وتدوير البكرات تلقائياً.",
                    "اكتملت المهمة 🤖",
                );
            }
        } else {
            await CustomDialog.alert(
                `تم رفض التحليل:\n${result.data.message}`,
                "خطأ ❌",
            );
        }
    } catch (error) {
        console.error("AI Extraction Error:", error);
        await CustomDialog.alert("حدث خطأ تقني أثناء تحليل الصور.", "خطأ ❌");
    } finally {
        aiExtractBtn.innerHTML = originalText;
        aiExtractBtn.disabled = false;
        aiProofFile.value = "";
    }
});

function openNeutralAppsSortingModal(neutralApps) {
    const container = document.getElementById("neutral-apps-container");
    container.innerHTML = "";

    neutralApps.forEach((app, index) => {
        container.innerHTML += `
            <div class="neutral-app-item" data-time="${app.minutes}" style="background: rgba(0,0,0,0.3); border: 1px solid var(--border-color); padding: 15px; border-radius: 8px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                    <strong style="color: var(--text-main); font-size: 15px;">${app.name}</strong>
                    <span style="color: #a855f7; font-size: 14px; font-weight: bold; background: rgba(168,85,247,0.1); padding: 2px 8px; border-radius: 6px;">${app.minutes} دقيقة</span>
                </div>
                <select class="dialog-input app-category-select" style="margin: 0; width: 100%; font-size: 13px; cursor: pointer; padding: 10px; background: rgba(15, 10, 30, 0.9);">
                    <option value="wasted" selected>🗑️ ضياع وقت سطحي (مهدر)</option>
                    <option value="study">📚 دراسة / عمل مُنتج</option>
                    <option value="others">💬 استخدام عام (تواصل/بحث ضروري)</option>
                    <option value="shorts">☠️ شورتس / ريلز (تيك توك وما شابه)</option>
                </select>
            </div>
        `;
    });

    document.getElementById("ai-sorting-modal").classList.add("show");
}

document.getElementById("cancel-ai-sorting")?.addEventListener("click", () => {
    document.getElementById("ai-sorting-modal").classList.remove("show");
    extractedAIData = null; // مسح المسودة المؤقتة
});

document.getElementById("confirm-ai-sorting")?.addEventListener("click", () => {
    if (!extractedAIData) return;

    // استدعاء الأساسيات
    let finalStudy = extractedAIData.explicit_study || 0;
    let finalOthers = extractedAIData.explicit_others || 0;
    let finalShorts = extractedAIData.explicit_shorts || 0;
    let finalTotal = extractedAIData.total_minutes || 0;

    // جمع أوقات التطبيقات الرمادية بناءً على ضمير المستخدم
    const items = document.querySelectorAll(".neutral-app-item");
    items.forEach((item) => {
        const time = parseInt(item.getAttribute("data-time")) || 0;
        const category = item.querySelector(".app-category-select").value;

        if (category === "study") finalStudy += time;
        else if (category === "others") finalOthers += time;
        else if (category === "shorts") finalShorts += time;
        // الـ wasted لا نُضيفه للأقسام الثلاثة، لأنه ببساطة سيُطرح تلقائياً من الإجمالي داخل محرك النقاط.
    });

    // تدوير البكرات
    applyAIExtractedTimes(finalStudy, finalOthers, finalShorts, finalTotal);
    document.getElementById("ai-sorting-modal").classList.remove("show");

    CustomDialog.alert(
        "تم تدوير البكرات بنجاح بناءً على تصنيفك. راجع التقييم اللحظي قبل الاعتماد النهائي.",
        "تمت العملية ⚖️",
    );
});

function applyAIExtractedTimes(studyMins, othersMins, shortsMins, totalMins) {
    const scrollToVal = (columnId, val) => {
        const column = document.getElementById(columnId);
        if (column && column.children.length > 0) {
            const maxVal = parseInt(column.getAttribute("data-max"));
            const safeVal = Math.min(Math.max(0, val), maxVal); // تجنب خروج الرقم عن حدود البكرة (مثل أن يكون أكثر من 24 ساعة)

            column.setAttribute("data-value", safeVal);
            Array.from(column.children).forEach((child, idx) => {
                if (idx === safeVal) child.classList.add("active");
                else child.classList.remove("active");
            });
            column.scrollTo({ top: safeVal * 40, behavior: "smooth" });
        }
    };

    // تقسيم الدقائق إلى ساعات ودقائق للبكرات
    scrollToVal("picker-total-h", Math.floor(totalMins / 60));
    scrollToVal("picker-total-m", totalMins % 60);

    scrollToVal("picker-study-h", Math.floor(studyMins / 60));
    scrollToVal("picker-study-m", studyMins % 60);

    scrollToVal("picker-others-h", Math.floor(othersMins / 60));
    scrollToVal("picker-others-m", othersMins % 60);

    scrollToVal("picker-shorts-h", Math.floor(shortsMins / 60));
    scrollToVal("picker-shorts-m", shortsMins % 60);

    // تأخير نصف ثانية للسماح للبكرات بالدوران ثم حساب النقاط الديناميكية والحفظ في الـ LocalStorage
    setTimeout(() => {
        if (typeof window.calculateLiveScores === "function")
            window.calculateLiveScores();
    }, 1000);
}
