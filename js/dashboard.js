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
let currentChallengeData = null;
let dailyTargetPoints = 0;
let lifeSaverCost = 0;
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
        const challengeDoc = await getDoc(
            doc(db, "settings", "currentChallenge"),
        );

        if (challengeDoc.exists() && challengeDoc.data().isActive) {
            currentChallengeData = challengeDoc.data();
            dailyTargetPoints = currentChallengeData.dailyTargetPoints;
            lifeSaverCost = dailyTargetPoints * 1.5;
            const endDate = currentChallengeData.endDate.toDate();
            // استخدام الوقت الحقيقي لحساب الأيام المتبقية
            const diffDays = Math.ceil(
                (endDate - getRealNow()) / (1000 * 60 * 60 * 24),
            );
            const displayDays = diffDays > 0 ? diffDays : "انتهى";
            const isJoined =
                userData.joinedChallengeId === currentChallengeData.challengeId;
            const hasFailed = userData.challengeStatus === "failed" && isJoined;

            if (currentChallengeData.status === "registration")
                renderRegistrationPhase(isJoined);
            else if (currentChallengeData.status === "active") {
                if (hasFailed) renderFailedState(displayDays);
                else if (isJoined)
                    await processActiveParticipant(
                        userData,
                        userDocRef,
                        displayDays,
                    );
                else renderSpectatorState(displayDays);
            }
        } else renderNoChallengeState();

        loadLeaderboard();
        loadAnalytics();
        applyZoneUI(userData.currentZone || "green");
        const loader = document.getElementById("global-loader");
        if (loader) loader.classList.add("hidden");
        // // ==========================================
        // // 6. الإقلاع الذكي (توجيه المستخدم لمكانه الصحيح)
        // // ==========================================
        // const savedRoomId = localStorage.getItem("activeStudyRoomId");
        // if (savedRoomId) {
        //     // لو كان مسجلاً في غرفة، أعده إليها غصباً عن الواجهة
        //     enterStudyRoom(savedRoomId);
        // } else {
        //     // غير ذلك، شغل رادار اللوبي
        //     if (typeof listenToLobby === "function") listenToLobby();
        // }
        // إخفاء شاشة التحميل بنعومة بعد الانتهاء من تجهيز وتحديث كل الواجهات
    } else window.location.href = "index.html";
});

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

    if (!banner) return;

    // تصفير الحالات الافتراضية للواجهة
    document.body.classList.remove("red-zone");
    banner.className = "zone-alert";
    banner.innerHTML = "";

    if (unchainingContainer) unchainingContainer.style.display = "none";
    if (normalTasksContainer) normalTasksContainer.style.display = "block";
    if (submitDayBtn) submitDayBtn.style.display = "block";

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

function renderRegistrationPhase(isJoined) {
    const container = document.querySelector(".tasks-container");
    const infoBox = document.getElementById("challenge-info");
    infoBox.innerHTML = `<h2 style="color: var(--gold-primary); text-align: center; margin-bottom: 10px;">⏳ يوم التسجيل مفتوح</h2><p style="text-align: center; font-size: 18px;">تحدي: <strong>${currentChallengeData.title}</strong></p><p style="text-align: center; color: var(--text-muted);">المدة: ${currentChallengeData.durationDays} أيام | الهدف اليومي: ${currentChallengeData.dailyTargetPoints} نقطة</p>`;
    if (isJoined)
        container.innerHTML = `<div style="text-align: center; padding: 40px;"><h3 style="color: var(--success); font-size: 24px;">✅ أنت مسجل ومستعد!</h3><p style="color: var(--text-muted); margin-top: 10px;">سيتم فتح المهام بمجرد أن يطلق الإدمن إشارة البدء. استعد.</p></div>`;
    else {
        container.innerHTML = `<div style="text-align: center; padding: 30px; background: rgba(168, 85, 247, 0.1); border: 1px dashed var(--gold-primary); border-radius: 12px;"><h3 style="margin-bottom: 15px;">التسجيل متاح الآن</h3><p style="margin-bottom: 20px; color: var(--text-muted);">إذا لم تنضم الآن، فلن تتمكن من الدخول بعد بدء التحدي.</p><button id="join-challenge-btn" class="gold-btn" style="width: auto; padding: 12px 40px; font-size: 18px;">انضمام للتحدي بقوة 🔥</button></div>`;
        document
            .getElementById("join-challenge-btn")
            .addEventListener("click", joinChallenge);
    }
}

async function joinChallenge() {
    const btn = document.getElementById("join-challenge-btn");
    btn.disabled = true;
    btn.innerText = "جاري التسجيل...";
    try {
        await updateDoc(doc(db, "users", currentUser.uid), {
            joinedChallengeId: currentChallengeData.challengeId,
            challengeStatus: "active",
            streak: 0, // تصفير الستريك مع التحدي الجديد
        });
        window.syncUserUI();
    } catch (error) {
        await CustomDialog.alert("حدث خطأ أثناء الانضمام.", "خطأ");
        btn.disabled = false;
    }
}

function renderSpectatorState(displayDays) {
    document.getElementById("challenge-info").style.display = "none";
    document.querySelector(".tasks-container").innerHTML =
        `<div style="text-align: center; padding: 40px; background: rgba(0,0,0,0.2); border-radius: 16px; border: 1px solid var(--border-color);"><h2 style="color: var(--text-muted); font-size: 28px;">التحدي جاري حالياً 🔒</h2><p style="margin-top: 15px; font-size: 18px;">لقد فوتّ يوم التسجيل في تحدي <strong style="color: var(--gold-primary);">${currentChallengeData.title}</strong> (${currentChallengeData.durationDays} أيام).</p><div style="margin: 25px auto; padding: 20px; background: rgba(168, 85, 247, 0.1); border: 1px dashed var(--gold-primary); border-radius: 12px; display: inline-block;"><p style="font-size: 16px; margin: 0; color: var(--text-main);">الوقت المتبقي لانتهاء التحدي وبدء تسجيل جديد:</p><p style="font-size: 32px; font-weight: bold; color: var(--gold-primary); margin: 5px 0 0 0;">${displayDays} <span style="font-size: 16px;">أيام</span></p></div><p style="margin-top: 10px; font-size: 16px; color: var(--text-muted);">يجب عليك الانتظار حتى ينتهي التحدي الحالي للانضمام.</p></div>`;
}

function renderFailedState(displayDays) {
    document.getElementById("challenge-info").style.display = "none";
    document.querySelector(".tasks-container").innerHTML =
        `<div style="text-align: center; padding: 40px; background: rgba(244, 63, 94, 0.1); border: 1px solid var(--danger); border-radius: 16px;"><h1 style="color: var(--danger); font-size: 40px; text-shadow: 0 0 20px rgba(244,63,94,0.5);">💀 GAME OVER 💀</h1><p style="margin-top: 15px; font-size: 18px;">لقد فشلت في التحدي الحالي وتم إقصاؤك.</p><div style="margin: 25px auto; padding: 20px; background: rgba(0,0,0,0.3); border-radius: 12px; display: inline-block;"><p style="font-size: 16px; margin: 0; color: var(--text-muted);">الوقت المتبقي لانتهاء فترة عقوبتك:</p><p style="font-size: 32px; font-weight: bold; color: var(--danger); margin: 5px 0 0 0;">${displayDays} <span style="font-size: 16px;">أيام</span></p></div><p style="margin-top: 10px; color: var(--text-muted);">رصيدك ونقاطك محفوظة، لكنك ستبقى متفرجاً حتى يتم إعلان تحدٍ جديد.</p></div>`;
}

function renderNoChallengeState() {
    document.getElementById("challenge-info").style.display = "none";
    document.querySelector(".tasks-container").innerHTML =
        `<div style="text-align: center; padding: 50px;"><h2 style="color: var(--text-muted);">لا يوجد تحدي نشط حالياً. خذ قسطاً من الراحة واستعد للمعركة القادمة.</h2></div>`;
}

async function processActiveParticipant(userData, userDocRef, displayDays) {
    const titleEl = document.getElementById("challenge-title");
    if (titleEl) titleEl.innerText = "تحدي: " + currentChallengeData.title;

    const targetEl = document.getElementById("daily-target");
    if (targetEl) targetEl.innerText = dailyTargetPoints;

    const daysLeftEl = document.getElementById("days-left");
    if (daysLeftEl) daysLeftEl.innerText = displayDays;

    // ==========================================
    // 1. جلب المهام الإجبارية (الدينية والدنيوية) لفحصها بأثر رجعي
    // ==========================================
    const importantRelTaskIds = [];
    const relSnap = await getDocs(query(collection(db, "religiousTasks")));
    relSnap.forEach((d) => {
        const data = d.data();
        // تجاهل المهام المعطلة لكي لا يُعاقب المستخدم عليها بأثر رجعي
        if (data.isImportant && data.isActive !== false)
            importantRelTaskIds.push(d.id);
    });

    const importantNormTaskIds = [];
    const normSnap = await getDocs(query(collection(db, "tasks")));
    normSnap.forEach((d) => {
        const data = d.data();
        // تجاهل المهام المعطلة لكي لا يُعاقب المستخدم عليها بأثر رجعي
        if (data.isImportant && data.isActive !== false)
            importantNormTaskIds.push(d.id);
    });

    // ==========================================
    // 2. تجهيز التواريخ
    // ==========================================
    const realNow = getRealNow();
    const todayStr = getCairoDateString(realNow);

    const yesterdayDate = new Date(realNow);
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterdayStr = getCairoDateString(yesterdayDate);

    const endDateStr = getCairoDateString(
        currentChallengeData.endDate.toDate(),
    );
    const limitStr = yesterdayStr < endDateStr ? yesterdayStr : endDateStr;

    if (!userData.lastEvalDate) {
        await updateDoc(userDocRef, { lastEvalDate: yesterdayStr });
        userData.lastEvalDate = yesterdayStr;
    }
    let currentEvalDateStr = userData.lastEvalDate;

    // ==========================================
    // 3. المنقذ الذكي (مراجعة الأيام الفائتة)
    // ==========================================
    if (currentEvalDateStr < limitStr) {
        let currentXP = userData.currentXP || 0;
        let currentStreak = userData.currentStreak || 0;
        let walletCoins = userData.walletCoins || 0;
        let lifetimeScore = userData.lifetimeScore || 0;
        let cycleScore = userData.cycleScore || 0; // التعديل الجديد
        let currentZone = userData.currentZone || "green"; // التعديل الجديد
        let freezeCount = userData.freezeCount || 0;

        let parts = currentEvalDateStr.split("-");
        let evalDate = new Date(parts[0], parts[1] - 1, parts[2]);
        evalDate.setDate(evalDate.getDate() + 1);

        const challengeStartStr = getCairoDateString(
            currentChallengeData.startDate.toDate(),
        );
        let startParts = challengeStartStr.split("-");
        let challengeStartDate = new Date(
            startParts[0],
            startParts[1] - 1,
            startParts[2],
        );

        if (evalDate < challengeStartDate) {
            evalDate = new Date(challengeStartDate);
            let prepDate = new Date(challengeStartDate);
            prepDate.setDate(prepDate.getDate() - 1);
            currentEvalDateStr = getCairoDateString(prepDate);
        }

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

            // الفحص القاطع للمهام الدينية الإجبارية
            let missingRel = false;
            for (let id of importantRelTaskIds) {
                if (!religiousSelections[id]) {
                    missingRel = true;
                    break;
                }
            }

            // الفحص القاطع للمهام الدنيوية الإجبارية
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

            // إذا تم تقييمه من السيرفر سابقاً نعتمد النتيجة، وإلا نقيمه محلياً بصرامة
            let passedToday = isLogFinalized
                ? passedByServer
                : pointsEarned >= dailyTargetPoints &&
                  !missingRel &&
                  !missingNorm;

            if (passedToday) {
                // --- النجاح بأثر رجعي ---
                let earnedCoins = Math.floor(pointsEarned / 1.5);
                let earnedXP = pointsEarned;
                let xpLabel = "";

                if (userData.hasDoubleXP) {
                    earnedXP = pointsEarned * 2;
                    userData.hasDoubleXP = false;
                    userData.usedDoubleXP = true;
                    xpLabel = " ⚡";
                }

                currentXP += earnedXP;
                lifetimeScore += earnedXP;
                walletCoins += earnedCoins;
                cycleScore += pointsEarned;
                currentStreak++;

                if (currentZone === "yellow") currentZone = "green"; // الخروج من الإنذار

                messages.push(
                    `✅ يوم ${dateStr}: تم الاعتماد بنجاح (+${earnedXP} XP${xpLabel}) | الستريك: <i class="fa-solid fa-fire fa-fw"></i>${currentStreak}`,
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
                // --- الفشل بأثر رجعي ---
                if (freezeCount > 0) {
                    freezeCount--;
                    messages.push(
                        `❄️ يوم ${dateStr}: تم استخدام "تجميد الستريك"! تم حماية الستريك من الكسر.`,
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

                    messages.push(
                        `⚠️ يوم ${dateStr}: فشلت! انكسر الستريك 💔 | حالتك الآن: ${currentZone === "yellow" ? "منطقة صفراء ⚠️" : "منطقة حمراء 🛑"}`,
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

        // حفظ التحديثات في ملف المستخدم
        let updates = {
            currentXP,
            lifetimeScore,
            walletCoins,
            currentStreak,
            cycleScore,
            currentZone,
            freezeCount,
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

    // ==========================================
    // 4. فحص انتهاء التحدي كلياً
    // ==========================================
    if (todayStr > endDateStr) {
        document.querySelector(".tasks-container").innerHTML = `
            <div style="text-align: center; padding: 40px; background: rgba(168, 85, 247, 0.1); border-radius: 16px; border: 1px solid var(--gold-primary);">
                <h2 style="color: var(--gold-primary); font-size: 28px; margin-bottom: 15px;">انتهى التحدي! 🏁</h2>
                <p style="font-size: 18px; margin-bottom: 10px;">لقد صمدت حتى النهاية، وتوقف عداد المهام الآن.</p>
                <p style="font-size: 15px; color: var(--text-muted); line-height: 1.6;">نحن في انتظار الإدارة لإنهاء التحدي رسمياً وتوزيع الأوسمة على الصامدين.<br>استرح قليلاً استعداداً للمعركة القادمة.</p>
            </div>
        `;
        return;
    }

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
        // tasks.forEach((task) => {
        //     const taskDiv = document.createElement("div");
        //     taskDiv.className = "task-item";
        //     taskDiv.style.flexDirection = "column";
        //     taskDiv.style.alignItems = "flex-start";

        //     let selectedIndex = 0;
        //     if (
        //         todayLogData &&
        //         todayLogData.selections &&
        //         todayLogData.selections[task.id] !== undefined
        //     ) {
        //         selectedIndex = todayLogData.selections[task.id];
        //     }

        //     let nativeSelectHtml = `<select class="task-select hidden-select" data-task-id="${task.id}" style="display:none;">`;
        //     let customOptionsHtml = "";
        //     let selectedText = "";

        //     if (task.options && task.options.length > 0) {
        //         task.options.forEach((opt, index) => {
        //             const isSelected =
        //                 index === selectedIndex ? "selected" : "";
        //             const optText = `${opt.name} (+${opt.points})`;
        //             if (index === selectedIndex) selectedText = optText;
        //             nativeSelectHtml += `<option value="${opt.points}" data-index="${index}" ${isSelected}>${optText}</option>`;
        //             customOptionsHtml += `<span class="custom-option ${isSelected}" data-value="${opt.points}" data-index="${index}">${optText}</span>`;
        //         });
        //     }
        //     nativeSelectHtml += `</select>`;

        //     let customSelectHtml = `<div class="custom-select-wrapper">${nativeSelectHtml}<div class="custom-select"><div class="custom-select-trigger"><span class="trigger-text">${selectedText}</span><i class="fa-solid fa-chevron-down"></i></div><div class="custom-options">${customOptionsHtml}</div></div></div>`;
        //     taskDiv.innerHTML = `<span style="font-size: 16px; font-weight: bold;">${task.name}</span>${customSelectHtml}`;
        //     tasksList.appendChild(taskDiv);
        // });
    }

    initializeCustomSelects();
    initializeChecklists(); // <--- أضف هذا السطر هنا
    if (isTodayFinalized) disableSubmitButton();
    else autoSaveTasks(false);

    setTimeout(startTour, 800);
}

async function loadReligiousTasks(todayLogData) {
    const list = document.getElementById("religious-tasks-list");
    if (!list) return;

    const q = query(collection(db, "religiousTasks"), orderBy("order", "asc"));
    const snap = await getDocs(q);

    list.innerHTML = "";
    window.importantRelTaskIds = []; // تصفير وتجهيز مصفوفة المهام الدينية الإجبارية

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

        // حفظ الـ ID إذا كانت المهمة أساسية إجبارية
        if (task.isImportant && task.isActive !== false) {
            window.importantRelTaskIds.push(taskId);
        }

        const isChecked = savedRel[taskId] ? "checked" : "";
        const borderStyle = task.isImportant
            ? "border: 1px solid #f59e0b;"
            : "border: 1px solid var(--border-color);";
        const badge = task.isImportant
            ? `<span style="font-size: 10px; color: #f59e0b; background: rgba(245, 158, 11, 0.1); padding: 2px 6px; border-radius: 4px;">أساسية إجبارية</span>`
            : `<span style="font-size: 10px; color: #a855f7; background: rgba(168, 85, 247, 0.1); padding: 2px 6px; border-radius: 4px;">إضافية مستحبة</span>`;

        const div = document.createElement("div");
        div.className = "task-item";
        div.style.cssText = `flex-direction: row; justify-content: space-between; align-items: center; ${borderStyle} margin-bottom: 10px; padding: 15px;`;

        div.innerHTML = `
            <div style="display: flex; flex-direction: column; gap: 5px;">
                <span style="font-size: 16px; font-weight: bold; color: var(--text-main);">${task.title} ${badge}</span>
                ${task.note ? `<span style="font-size: 12px; color: var(--text-muted);">${task.note}</span>` : ""}
            </div>
            <input type="checkbox" class="rel-task-checkbox" data-task-id="${taskId}" ${isChecked} ${isTodayFinalized ? "disabled" : ""} style="accent-color: var(--gold-primary); width: 22px; height: 22px; cursor: pointer; margin: 0; flex-shrink: 0;">
        `;
        list.appendChild(div);
    });

    document.querySelectorAll(".rel-task-checkbox").forEach((cb) => {
        cb.addEventListener("change", async function () {
            if (isTodayFinalized) {
                this.checked = !this.checked;
                return;
            }
            await autoSaveReligiousTasks();
        });
    });
}

async function autoSaveReligiousTasks() {
    if (!currentUser || isTodayFinalized) return;

    let selections = {};
    document.querySelectorAll(".rel-task-checkbox").forEach((cb) => {
        selections[cb.getAttribute("data-task-id")] = cb.checked;
    });

    const realNow = getRealNow();
    const today = getCairoDateString(realNow);
    await setDoc(
        doc(db, `users/${currentUser.uid}/dailyLogs`, today),
        {
            religiousSelections: selections,
            timestamp: realNow,
        },
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
// 2. مستمع زر اعتماد اليوم (النظام الجديد الصارم)
// ==========================================
document
    .getElementById("submit-day-btn")
    ?.addEventListener("click", async () => {
        if (!currentUser || isTodayFinalized) return;

        // 1. استخراج النقاط والمهام
        const { totalPoints, selections, missingNormalImportant } =
            getCurrentSelectionsAndPoints();

        // 2. فحص المهام الدينية
        const currentRelSelections = {};
        document.querySelectorAll(".rel-task-checkbox").forEach((cb) => {
            currentRelSelections[cb.getAttribute("data-task-id")] = cb.checked;
        });

        let missingRelImportant = false;
        for (let i = 0; i < (window.importantRelTaskIds || []).length; i++) {
            if (!currentRelSelections[window.importantRelTaskIds[i]]) {
                missingRelImportant = true;
                break;
            }
        }

        // 3. تحديد النجاح الفعلي
        const passedToday =
            totalPoints >= dailyTargetPoints &&
            !missingRelImportant &&
            !missingNormalImportant;

        if (!passedToday && totalPoints >= dailyTargetPoints) {
            const ignore = await CustomDialog.confirm(
                "لقد وصلت للهدف الرقمي، لكنك تجاهلت مهام أساسية (دينية)! إذا ضغطت تأكيد الآن، سيُحسب هذا اليوم كـ 'فشل' وسينكسر الستريك. هل أنت متأكد من هذا التخاذل؟",
                "تحذير صارم 🛑",
            );
            if (!ignore) return;
        } else if (!passedToday) {
            const isSure = await CustomDialog.confirm(
                `مجموعك ${totalPoints} نقطة فقط (أقل من الهدف). هذا يعني الفشل وكسر الستريك. هل أنت متأكد من إنهاء يومك هكذا؟`,
                "تأكيد الفشل 📝",
            );
            if (!isSure) return;
        } else {
            const isSure = await CustomDialog.confirm(
                `أنجزت الأساسيات وجمعت ${totalPoints} نقطة. هل أنت متأكد من إنهاء اليوم بنجاح؟`,
                "تأكيد الإنجاز 🏆",
            );
            if (!isSure) return;
        }

        const btn = document.getElementById("submit-day-btn");
        const originalText = btn.innerText;
        btn.innerText = "جاري الاعتماد...";
        btn.disabled = true;

        const realNow = getRealNow();
        const today = getCairoDateString(realNow);

        try {
            // حفظ سجل اليوم (بدون أي AI Reflections)
            await setDoc(
                doc(db, `users/${currentUser.uid}/dailyLogs`, today),
                {
                    date: today,
                    pointsEarned: totalPoints,
                    selections,
                    passed: passedToday,
                    isFinalized: true,
                    timestamp: realNow,
                },
                { merge: true },
            );

            const pointsDisplay = document.getElementById("today-points");
            if (pointsDisplay) pointsDisplay.innerText = totalPoints;

            const userDocRef = doc(db, "users", currentUser.uid);
            const userDocSnap = await getDoc(userDocRef);
            const userDataLocal = userDocSnap.data() || {};

            let currentZone = userDataLocal.currentZone || "green";
            const hasDoubleXP = userDataLocal.hasDoubleXP || false;
            let dbUpdates = { lastEvalDate: today };

            if (passedToday) {
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

                let earnedCoins = Math.floor(totalPoints / 1.5);
                let earnedXP = totalPoints;
                let xpLabel = "";

                dbUpdates.walletCoins = increment(earnedCoins);
                dbUpdates.currentStreak = increment(1);
                dbUpdates.currentZone = currentZone;
                dbUpdates.cycleScore = increment(totalPoints); // هنا فقط تضاف نقاط المنافسة

                if (hasDoubleXP) {
                    earnedXP *= 2;
                    dbUpdates.currentXP = increment(earnedXP);
                    dbUpdates.lifetimeScore = increment(earnedXP);
                    dbUpdates.hasDoubleXP = false;
                    dbUpdates.usedDoubleXP = true;
                    xpLabel = `<span style="color:#eab308; display: block;">(مضاعف ⚡)</span>`;
                } else {
                    dbUpdates.currentXP = increment(earnedXP);
                    dbUpdates.lifetimeScore = increment(earnedXP);
                }

                await updateDoc(userDocRef, dbUpdates);
                await CustomDialog.alert(
                    `<span style="display: block;">🔥 تم الاعتماد بنجاح! لقد كسبت: </span> ${xpLabel} \n <span><span class="win-info-boxs xp">+${earnedXP} XP</span> <span class="win-info-boxs coins">+${earnedCoins} <i class="fa-solid fa-coins fa-fw"></i></span> <span class="win-info-boxs ">+1 <i class="fa-solid fa-fire fa-fw"></i></span></span>`,
                    "عمل عظيم ",
                );
            } else {
                const hasFreeze = (userDataLocal.freezeCount || 0) > 0;

                if (hasFreeze) {
                    dbUpdates.freezeCount = increment(-1);
                    await updateDoc(userDocRef, dbUpdates);
                    await CustomDialog.alert(
                        `تم استهلاك "تجميد الستريك" ❄️ بنجاح.\nتم حمايتك من السقوط بسبب هذا اليوم الفاشل وحافظت على الستريك الخاص بك.`,
                        "تفعيل التجميد التلقائي ❄️",
                    );
                } else {
                    if (currentZone === "green") currentZone = "yellow";
                    else if (currentZone === "yellow") currentZone = "red";

                    dbUpdates.currentStreak = 0;
                    dbUpdates.currentZone = currentZone;
                    await updateDoc(userDocRef, dbUpdates);

                    await CustomDialog.alert(
                        `تم اعتماد اليوم كفشل! تم تصفير الستريك. 💔\nأنت الآن في المنطقة: ${currentZone === "yellow" ? "الصفراء ⚠️" : "الحمراء 🛑"}`,
                        "تحذير شديد اللهجة",
                    );
                }
            }

            isTodayFinalized = true;
            window.syncUserUI();
            if (typeof applyZoneUI === "function") applyZoneUI(currentZone);
        } catch (error) {
            await CustomDialog.alert(
                "حدث خطأ غير متوقع: " + error.message,
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

        if (usersArray.length === 0) {
            listContainer.innerHTML =
                '<p style="text-align: center; color: var(--text-muted);">لا يوجد متصدرين حتى الآن.</p>';
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
    // إضافة اللقب في الـ Modal
    document.getElementById("modal-user-name").innerHTML +=
        `<br><span class="rank-tag ${rankInfo.tagClass}" style="display: block; margin: auto; font-size: 13px;">${rankInfo.title}</span>`;

    document.getElementById("modal-user-rank").innerText = `#${user.rank}`;
    document.getElementById("modal-user-points").innerText =
        user.currentXP + " XP ";
    document.getElementById("modal-user-streak").innerHTML =
        `<i class="fa-solid fa-fire fa-fw"></i> ${user.currentStreak || 0}`;

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
// 8. محرك الضغط المطول (Long Press) للأرقام
// ==========================================
let adjustInterval;
let adjustTimeout;
let isAdjusting = false;
let currentActiveButton = null; // متغير لتذكر الزر المضغوط حالياً

window.startAdjust = function (btnElement, inputId, change, event) {
    if (event && event.type === "touchstart") {
        event.preventDefault();
    }

    if (isAdjusting) return;
    isAdjusting = true;
    currentActiveButton = btnElement; // حفظ الزر

    // 1. تلوين الزر للضغطة العادية فوراً
    currentActiveButton.classList.add("is-active");

    adjustNumberInput(inputId, change);

    adjustTimeout = setTimeout(() => {
        // 2. تغيير لون الزر للضغطة المطولة بعد 400 ملي ثانية
        if (currentActiveButton) {
            currentActiveButton.classList.add("is-long-press");
        }

        adjustInterval = setInterval(() => {
            adjustNumberInput(inputId, change);
        }, 120);
    }, 400);
};

window.stopAdjust = function () {
    clearTimeout(adjustTimeout);
    clearInterval(adjustInterval);
    isAdjusting = false;

    // 3. إزالة كل الألوان وإعادة الزر لشكله الطبيعي عند رفع الإصبع
    if (currentActiveButton) {
        currentActiveButton.classList.remove("is-active", "is-long-press");
        currentActiveButton = null;
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
    document.body.style.opacity = "0.8";

    try {
        const userDocSnap = await getDoc(doc(db, "users", currentUser.uid));
        if (!userDocSnap.exists()) return;
        const userData = userDocSnap.data();

        updateProfileUI(userData);

        if (typeof renderDailyTrivia === "function") {
            renderDailyTrivia(userData);
        }

        const challengeDoc = await getDoc(
            doc(db, "settings", "currentChallenge"),
        );
        if (challengeDoc.exists() && challengeDoc.data().isActive) {
            const challengeData = challengeDoc.data();
            const endDate = challengeData.endDate.toDate();
            const diffDays = Math.ceil(
                (endDate - getRealNow()) / (1000 * 60 * 60 * 24),
            );
            const displayDays = diffDays > 0 ? diffDays : "انتهى";

            const titleEl = document.getElementById("challenge-title");
            if (titleEl) titleEl.innerText = "تحدي: " + challengeData.title;

            const targetEl = document.getElementById("daily-target");
            if (targetEl) targetEl.innerText = challengeData.dailyTargetPoints;

            const costEl = document.getElementById("life-saver-cost");
            if (costEl)
                costEl.innerText = challengeData.dailyTargetPoints * 1.5;

            const daysEl = document.getElementById("days-left");
            if (daysEl) daysEl.innerText = displayDays;
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
        document.body.style.opacity = "1";
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
