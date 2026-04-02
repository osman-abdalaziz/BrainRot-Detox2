import { auth, db, storage } from "./firebase-config.js";
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
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import {
    ref,
    uploadBytes,
    getDownloadURL,
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js";

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

        // إخفاء شاشة التحميل بنعومة بعد الانتهاء من تجهيز وتحديث كل الواجهات
        setTimeout(() => {
            const loader = document.getElementById("global-loader");
            if (loader) loader.classList.add("hidden");
        }, 600);
    } else window.location.href = "index.html";
});

function updateProfileUI(userData) {
    const firstName = userData.name.split(" ")[0];
    document.getElementById("welcome-text").innerText =
        `مرحباً يا ${firstName}`;
    document.getElementById("nav-user-name").innerText = userData.name;
    document.getElementById("profile-name-input").value = userData.name;
    const userAvatarUrl = userData.photoURL || "images/profile.jpg";
    document.getElementById("nav-avatar").src = userAvatarUrl;
    document.getElementById("profile-avatar-preview").src = userAvatarUrl;
    const rankClass = getRankFrameClass(userData.points);
    document.getElementById("nav-avatar-wrapper").className =
        `avatar-wrapper ${rankClass}`;
    document.getElementById("profile-avatar-wrapper").className =
        `avatar-wrapper ${rankClass}`;

    // ==============================
    // تفعيل شارة الستريك في الشريط العلوي
    // ==============================
    const streak = userData.streak || 0;
    const streakEl = document.getElementById("nav-user-streak");
    if (streakEl) {
        if (streak > 0) {
            streakEl.style.display = "inline-block";
            streakEl.innerHTML = `<i class="fa-solid fa-fire fa-fw"></i> ${streak}`;
        } else {
            streakEl.style.display = "none";
        }
    }

    // --- تعديل لإظهار علامة التجميد الزرقاء بجانب الاسم ❄️ ---
    const hasFreeze = userData.freezeCount > 0;
    const freezeEl = document.getElementById("nav-user-freeze");
    if (freezeEl) {
        if (hasFreeze) {
            freezeEl.style.display = "inline-block"; // إظهارها
        } else {
            freezeEl.style.display = "none"; // إخفاؤها
        }
    }

    const points = userData.points || 0;
    const pointsEl = document.getElementById("nav-user-points");
    if (pointsEl) {
        pointsEl.style.display = "inline-block";
        pointsEl.innerHTML = `${points} <i class="fa-solid fa-coins fa-fw"></i>`;
    }

    const badgesContainer = document.getElementById("badges-container");
    if (userData.badges && userData.badges.length > 0) {
        badgesContainer.innerHTML = "";
        userData.badges.forEach((badge) => {
            badgesContainer.innerHTML += `<div style="background: rgba(168, 85, 247, 0.1); border: 1px solid var(--border-color); padding: 15px; border-radius: 12px; width: 130px; text-align: center; box-shadow: 0 4px 15px rgba(0,0,0,0.2);">
                <div style="display: flex; justify-content: center; align-items: center; font-size: 35px; margin-bottom: 10px; text-shadow: 0 0 10px var(--gold-glow);"><img src="${badge.icon}" alt="${badge.title}" style="width: 100%; height: 100%; object-fit: cover;"></div>
                <h4 style="font-size: 13px; color: var(--text-main); margin-bottom: 5px;">${badge.title}</h4><span style="font-size: 11px; color: var(--gold-primary); font-weight: bold;">${badge.date}</span></div>`;
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
        storeTodoBtn.classList.remove("delete-todo-btn"); // تغيير اللون إلى الأحمر
        if (storeTodoBtn) {
            storeTodoBtn.innerText = "شراء (150pt)";
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
        location.reload();
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
    document.getElementById("challenge-title").innerText =
        currentChallengeData.title;
    document.getElementById("daily-target").innerText = dailyTargetPoints;
    document.getElementById("life-saver-cost").innerText = lifeSaverCost;
    document.getElementById("days-left").innerText = displayDays;

    // استخدام الوقت الحقيقي والمحمي بدلاً من وقت الجهاز
    const realNow = getRealNow();
    const todayStr = realNow.toLocaleDateString("en-CA");
    const yesterdayDate = new Date(realNow);
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterdayStr = yesterdayDate.toLocaleDateString("en-CA");

    // استخراج تاريخ نهاية التحدي كـ String للمقارنة
    const endDateStr = currentChallengeData.endDate
        .toDate()
        .toLocaleDateString("en-CA");

    // حد التقييم الرجعي: الأقدم بين (الأمس) أو (تاريخ نهاية التحدي)
    const limitStr = yesterdayStr < endDateStr ? yesterdayStr : endDateStr;

    if (!userData.lastEvalDate) {
        await updateDoc(userDocRef, { lastEvalDate: yesterdayStr });
        userData.lastEvalDate = yesterdayStr;
    }
    let currentEvalDateStr = userData.lastEvalDate;

    if (currentEvalDateStr < limitStr) {
        let currentPoints = userData.points || 0;
        let currentStreak = userData.streak || 0; // مراقبة الستريك أثناء الفحص الرجعي
        let challengeStatus = userData.challengeStatus;

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

        while (evalDate <= limitDate && challengeStatus !== "failed") {
            const dateStr = evalDate.toLocaleDateString("en-CA");
            const logRef = doc(
                db,
                `users/${currentUser.uid}/dailyLogs`,
                dateStr,
            );
            const logSnap = await getDoc(logRef);
            let pointsEarned = 0;
            let selections = {};

            if (logSnap.exists()) {
                const logData = logSnap.data();
                pointsEarned = logData.pointsEarned || 0;
                selections = logData.selections || {};
            }

            if (pointsEarned >= dailyTargetPoints) {
                currentPoints += pointsEarned;
                currentStreak++; // زيادة الستريك للنجاح الرجعي
                messages.push(
                    `✅ يوم ${dateStr}: تم الاعتماد بنجاح (+${pointsEarned} نقطة) | الستريك: <i class="fa-solid fa-fire fa-fw"></i>${currentStreak}`,
                );
                await setDoc(
                    logRef,
                    {
                        passed: true,
                        isFinalized: true,
                        pointsEarned,
                        date: dateStr,
                        selections,
                        timestamp: getRealNow(),
                    },
                    { merge: true },
                );
            } else {
                // 1. الأولوية لتجميد الستريك (بدون خسارة نقاط أو ستريك)
                if (userData.freezeCount > 0) {
                    userData.freezeCount--; // استهلاك التجميد في الذاكرة المؤقتة
                    messages.push(
                        `❄️ يوم ${dateStr}: تم استخدام "تجميد الستريك"! تم حماية الستريك من الكسر.`,
                    );

                    // تحديث قاعدة البيانات
                    await updateDoc(userDocRef, { freezeCount: increment(-1) });
                    await setDoc(
                        logRef,
                        {
                            passed: false, // 🛑 تعديل: يسجل كفشل في الإحصائيات لأنه لم يكمل المهام
                            isFinalized: true,
                            pointsEarned,
                            date: dateStr,
                            timestamp: getRealNow(),
                        },
                        { merge: true },
                    );

                    currentPoints += pointsEarned;
                    // 🛑 تم حذف سطر currentStreak++ لمنع الزيادة المجانية للستريك
                } else if (currentPoints >= lifeSaverCost) {
                    currentPoints -= lifeSaverCost;
                    currentStreak = 0; // كسر الستريك بسبب طوق النجاة
                    messages.push(
                        `⚠️ يوم ${dateStr}: تم سحب طوق النجاة (-${lifeSaverCost} نقطة) | انكسر الستريك 💔`,
                    );
                    await setDoc(
                        logRef,
                        {
                            passed: false,
                            isFinalized: true,
                            pointsEarned,
                            date: dateStr,
                            selections,
                            timestamp: getRealNow(),
                        },
                        { merge: true },
                    );
                } else {
                    challengeStatus = "failed";
                    currentStreak = 0; // كسر الستريك بسبب الفشل
                    messages.push(
                        `💀 يوم ${dateStr}: فشلت ورصيدك لا يكفي للنجاة. تم إقصاؤك!`,
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
                    break;
                }
            }
            currentEvalDateStr = dateStr;
            evalDate.setDate(evalDate.getDate() + 1);
        }

        // تحديث النقاط والستريك في قاعدة البيانات
        let updates = {
            points: currentPoints,
            lastEvalDate: currentEvalDateStr,
            streak: currentStreak,
        };
        if (challengeStatus === "failed") updates.challengeStatus = "failed";
        await updateDoc(userDocRef, updates);

        if (messages.length > 0)
            await CustomDialog.alert(
                "تقرير المنقذ الذكي للأيام الفائتة:\n\n" + messages.join("\n"),
                "المنقذ الذكي 🤖",
            );

        if (challengeStatus === "failed") {
            location.reload();
            return;
        }
    }

    // =======================================
    // الإغلاق الإجباري عند تجاوز تاريخ النهاية
    // =======================================
    if (todayStr > endDateStr) {
        document.querySelector(".tasks-container").innerHTML = `
            <div style="text-align: center; padding: 40px; background: rgba(168, 85, 247, 0.1); border-radius: 16px; border: 1px solid var(--gold-primary);">
                <h2 style="color: var(--gold-primary); font-size: 28px; margin-bottom: 15px;">انتهى التحدي! 🏁</h2>
                <p style="font-size: 18px; margin-bottom: 10px;">لقد صمدت حتى النهاية، وتوقف عداد المهام الآن.</p>
                <p style="font-size: 15px; color: var(--text-muted); line-height: 1.6;">نحن في انتظار الإدارة لإنهاء التحدي رسمياً وتوزيع الأوسمة على الصامدين.<br>استرح قليلاً استعداداً للمعركة القادمة.</p>
            </div>
        `;
        return; // قطع التنفيذ هنا يمنع ظهور المهام نهائياً
    }

    // تحميل مهام اليوم العادية إذا كان التحدي مستمراً
    const todayLogSnap = await getDoc(
        doc(db, `users/${currentUser.uid}/dailyLogs`, todayStr),
    );
    let todayLogData = null;
    if (todayLogSnap.exists()) {
        todayLogData = todayLogSnap.data();
        document.getElementById("today-points").innerText =
            todayLogData.pointsEarned;
        isTodayFinalized = todayLogData.isFinalized || false;
    }

    loadTasks(todayLogData);
}

async function loadTasks(todayLogData) {
    const tasksList = document.getElementById("tasks-list");
    tasksList.innerHTML = "";

    // سحب المهام مرتبة كما برمجناها سابقاً
    const q = query(collection(db, "tasks"), orderBy("order", "asc"));
    const querySnapshot = await getDocs(q);

    // تجميع المهام في كائن (Object) بناءً على القسم
    const groupedTasks = {};
    querySnapshot.forEach((docSnap) => {
        const task = docSnap.data();
        const taskId = docSnap.id;
        if (task.isActive) {
            const cat = task.category || "مهام عامة";
            if (!groupedTasks[cat]) groupedTasks[cat] = [];
            groupedTasks[cat].push({ id: taskId, ...task });
        }
    });

    // رسم المهام مرتبة تحت أقسامها
    for (const [category, tasks] of Object.entries(groupedTasks)) {
        // إنشاء عنوان القسم
        const catHeader = document.createElement("h4");
        catHeader.className = "gold-text";
        catHeader.style.cssText =
            "margin: 25px 0 15px 0; border-bottom: 1px dashed var(--gold-primary); padding-bottom: 5px; font-size: 18px;";
        catHeader.innerText = category;
        tasksList.appendChild(catHeader);

        // إنشاء مهام هذا القسم
        tasks.forEach((task) => {
            const taskDiv = document.createElement("div");
            taskDiv.className = "task-item";
            taskDiv.style.flexDirection = "column";
            taskDiv.style.alignItems = "flex-start";

            let selectedIndex = 0;
            if (
                todayLogData &&
                todayLogData.selections &&
                todayLogData.selections[task.id] !== undefined
            ) {
                selectedIndex = todayLogData.selections[task.id];
            }

            let nativeSelectHtml = `<select class="task-select hidden-select" data-task-id="${task.id}" style="display:none;">`;
            let customOptionsHtml = "";
            let selectedText = "";

            if (task.options && task.options.length > 0) {
                task.options.forEach((opt, index) => {
                    const isSelected =
                        index === selectedIndex ? "selected" : "";
                    const optText = `${opt.name} (+${opt.points})`;
                    if (index === selectedIndex) selectedText = optText;
                    nativeSelectHtml += `<option value="${opt.points}" data-index="${index}" ${isSelected}>${optText}</option>`;
                    customOptionsHtml += `<span class="custom-option ${isSelected}" data-value="${opt.points}" data-index="${index}">${optText}</span>`;
                });
            }
            nativeSelectHtml += `</select>`;

            let customSelectHtml = `<div class="custom-select-wrapper">${nativeSelectHtml}<div class="custom-select"><div class="custom-select-trigger"><span class="trigger-text">${selectedText}</span><i class="fa-solid fa-chevron-down"></i></div><div class="custom-options">${customOptionsHtml}</div></div></div>`;
            taskDiv.innerHTML = `<span style="font-size: 16px; font-weight: bold;">${task.name}</span>${customSelectHtml}`;
            tasksList.appendChild(taskDiv);
        });
    }

    initializeCustomSelects();
    if (isTodayFinalized) disableSubmitButton();
    else autoSaveTasks(false);

    // ==============================
    // إطلاق الجولة التعريفية هنا فقط (بعد رسم المهام)
    // ==============================
    setTimeout(startTour, 800);
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

async function autoSaveTasks(saveToDb = true) {
    if (!currentUser || isTodayFinalized) return;
    let totalPoints = 0;
    let selections = {};
    document.querySelectorAll(".task-select").forEach((select) => {
        totalPoints += parseInt(select.value);
        selections[select.getAttribute("data-task-id")] = parseInt(
            select.options[select.selectedIndex].getAttribute("data-index"),
        );
    });
    document.getElementById("today-points").innerText = totalPoints;

    if (saveToDb) {
        const realNow = getRealNow();
        const today = realNow.toLocaleDateString("en-CA");
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

document
    .getElementById("submit-day-btn")
    ?.addEventListener("click", async () => {
        if (!currentUser || isTodayFinalized) return;

        // 1. حساب النقاط
        let totalPoints = 0;
        let selections = {};
        document.querySelectorAll(".task-select").forEach((select) => {
            totalPoints += parseInt(select.value);
            selections[select.getAttribute("data-task-id")] = parseInt(
                select.options[select.selectedIndex].getAttribute("data-index"),
            );
        });

        // 2. التحقق من صندوق المحاكمة (الجديد)
        const reflectionText =
            document.getElementById("daily-reflection-text")?.value.trim() ||
            "";
        const wordsCount =
            reflectionText === "" ? 0 : reflectionText.split(/\s+/).length;

        if (wordsCount > 0 && wordsCount < 30) {
            return await CustomDialog.alert(
                "محاكمة الذات يجب أن تكون صريحة وعميقة (30 كلمة على الأقل). أكمل كتابتك أو اترك الصندوق فارغاً تماماً لتجاهل المحاكمة.",
                "عذراً ✋",
            );
        }

        const passedToday = totalPoints >= dailyTargetPoints;
        const isSure = await CustomDialog.confirm(
            `مجموعك الحالي هو ${totalPoints} نقطة. هل أنت متأكد من الاعتماد؟ لا تراجع بعد ذلك.`,
            "تأكيد إنهاء اليوم 📝",
        );
        if (!isSure) return;

        const btn = document.getElementById("submit-day-btn");
        btn.innerText = "جاري الاعتماد...";
        btn.disabled = true;
        const realNow = getRealNow();
        const today = realNow.toLocaleDateString("en-CA");

        try {
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
            document.getElementById("today-points").innerText = totalPoints;
            // ==============================
            // إرسال البيانات (السيرفر سيتولى الباقي تلقائياً)
            // ==============================
            if (wordsCount >= 30) {
                const reflectionRef = doc(
                    db,
                    `users/${currentUser.uid}/ai_reflections`,
                    today,
                );
                // مجرد حفظ المستند بحالة processing سيفعل دالة السيرفر فوراً
                await setDoc(reflectionRef, {
                    date: today,
                    userText: reflectionText,
                    points: totalPoints,
                    passed: passedToday,
                    status: "processing",
                    aiResponse: "",
                    timestamp: realNow,
                });

                await CustomDialog.alert(
                    "تم تسجيل يومك. الموجه يقرأ تقريرك الآن في الخلفية. راجع صفحة 'تحليل التقدم' لاحقاً لترى رده.",
                    "تقريرك قيد المراجعة ⏳",
                );
            }
            // ==============================

            // ==============================
            // زيادة أو كسر الستريك بناءً على النتيجة
            // ==============================
            if (passedToday) {
                // تشغيل صوت الإنجاز (عملات ذهبية/Level Up)
                const successSound = new Audio(
                    "https://cdn.pixabay.com/download/audio/2021/08/04/audio_0625c1539c.mp3?filename=success-1-6297.mp3",
                );
                successSound.volume = 0.7; // مستوى الصوت 70%
                successSound
                    .play()
                    .catch((e) => console.log("تم منع تشغيل الصوت من المتصفح"));

                await updateDoc(doc(db, "users", currentUser.uid), {
                    lastEvalDate: today,
                    points: increment(totalPoints),
                    streak: increment(1), // زيادة الستريك
                });
                await CustomDialog.alert(
                    `تم الاعتماد بنجاح! جمعت ${totalPoints} نقطة 🔥\nتمت زيادة الستريك الخاص بك، استمر!`,
                    "عمل عظيم",
                );
                location.reload();
            } else {
                const currentPoints = (
                    await getDoc(doc(db, "users", currentUser.uid))
                ).data().points;
                // جلب بيانات المستخدم للتأكد من وجود تجميد أو نقاط كافية
                const userDocSnap = await getDoc(
                    doc(db, "users", currentUser.uid),
                );
                const userDataObj = userDocSnap.data();
                //const currentPoints = userDataObj.points || 0;
                const hasFreeze = (userDataObj.freezeCount || 0) > 0;

                // 1. الأولوية لتجميد الستريك ❄️
                if (hasFreeze) {
                    await CustomDialog.alert(
                        `لم تصل للهدف اليوم! ولكن تم استهلاك "تجميد الستريك" ❄️ بنجاح.\nتم حمايتك من الطرد وحافظت على الستريك الخاص بك.`,
                        "تفعيل التجميد التلقائي ❄️",
                    );
                    await updateDoc(doc(db, "users", currentUser.uid), {
                        freezeCount: increment(-1), // خصم التجميد
                        lastEvalDate: today,
                    });
                    location.reload();
                } else if (currentPoints >= lifeSaverCost) {
                    const useSaver = await CustomDialog.confirm(
                        `فشلت في الوصول للهدف! رصيدك يسمح بشراء نجاة مقابل ${lifeSaverCost} نقطة. هل تستخدمه لتجنب الطرد？\n(ملاحظة: هذا سيكسر الستريك 💔)`,
                        "تفعيل النجاة 🛟",
                    );
                    if (useSaver) {
                        await updateDoc(doc(db, "users", currentUser.uid), {
                            points: increment(-lifeSaverCost),
                            lastEvalDate: today,
                            streak: 0, // كسر الستريك
                        });
                        location.reload();
                    } else {
                        await updateDoc(doc(db, "users", currentUser.uid), {
                            challengeStatus: "failed",
                            streak: 0, // كسر الستريك
                        });
                        location.reload();
                    }
                } else {
                    await updateDoc(doc(db, "users", currentUser.uid), {
                        challengeStatus: "failed",
                        streak: 0, // كسر الستريك
                    });
                    await CustomDialog.alert(
                        "رصيدك لا يكفي للنجاة. تم طردك من هذا التحدي 💀",
                        "للأسف",
                    );
                    location.reload();
                }
            }
        } catch (error) {
            await CustomDialog.alert("حدث خطأ غير متوقع.");
            btn.innerText = "إنهاء اليوم وتسجيل النقاط";
            btn.disabled = false;
        }
    });

// function disableSubmitButton() {
//     isTodayFinalized = true;
//     const btn = document.getElementById("submit-day-btn");
//     if (!btn) return;
//     btn.disabled = true;
//     btn.innerText = "تم اعتماد مهام اليوم 🏆";
//     document.querySelectorAll(".custom-select-wrapper").forEach((wrapper) => {
//         wrapper.style.pointerEvents = "none";
//         wrapper.style.opacity = "0.5";
//     });
//     document.querySelectorAll(".task-select").forEach((s) => {
//         s.disabled = true;
//     });
// }

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

    // تعطيل صندوق المحاكمة (الـ Textarea)
    const reflectionInput = document.getElementById("daily-reflection-text");
    if (reflectionInput) {
        reflectionInput.disabled = true;
        reflectionInput.style.opacity = "0.5";
        reflectionInput.style.cursor = "not-allowed";
        reflectionInput.placeholder = "تم إغلاق المحاكمة لهذا اليوم.";
    }
}

document
    .getElementById("logout-btn")
    .addEventListener("click", () =>
        signOut(auth).then(() => (window.location.replace = "index.html")),
    );

// ==========================================
// قائمة المتصدرين (نظام التصنيف الأولمبي الأول - Shared Rank)
// ==========================================
async function loadLeaderboard() {
    const listContainer = document.getElementById("leaderboard-list");
    listContainer.innerHTML = "";

    try {
        const querySnapshot = await getDocs(collection(db, "users"));

        let usersArray = [];
        querySnapshot.forEach((doc) => {
            usersArray.push(doc.data());
        });

        // 1. تصفية حساب الإدارة أولاً لكي لا يفسد الحسابات والمراكز
        //usersArray = usersArray.filter((u) => u.role !== "admin");

        // 2. خوارزمية الفرز (الستريك -> النقاط -> الترتيب الأبجدي)
        usersArray.sort((a, b) => {
            const streakA = a.streak || 0;
            const streakB = b.streak || 0;
            const pointsA = a.points || 0;
            const pointsB = b.points || 0;

            if (streakA !== streakB) return streakB - streakA; // الأولوية للستريك
            if (pointsA !== pointsB) return pointsB - pointsA; // عند تعادل الستريك، الأولوية للنقاط

            // عند التعادل التام، نرتب أبجدياً لمنع العشوائية وتغيير الأماكن عند تحديث الصفحة
            const nameA = a.name ? a.name.toLowerCase() : "";
            const nameB = b.name ? b.name.toLowerCase() : "";
            return nameA.localeCompare(nameB);
        });

        // 3. بناء الواجهة وتوزيع المراكز المكررة
        let actualPosition = 1; // العداد الحقيقي للمقاعد
        let displayRank = 1; // المركز الذي سيظهر للمستخدم (قد يكون مكرراً)
        let previousUser = null;

        usersArray.forEach((user) => {
            // التحقق من التعادل مع الشخص السابق
            if (previousUser) {
                const sameStreak =
                    (user.streak || 0) === (previousUser.streak || 0);
                const samePoints =
                    (user.points || 0) === (previousUser.points || 0);

                // إذا لم يكن هناك تعادل تام، نقوم بتحديث المركز ليطابق العداد الحقيقي
                if (!sameStreak || !samePoints) {
                    displayRank = actualPosition;
                }
                // إذا كان هناك تعادل، سيتخطى هذا الشرط ويحتفظ بالمركز المكرر (مثلاً #1، #1)
            }

            const currentRank = displayRank;

            // تحديد كلاس الشارة بناءً على المركز الظاهر
            let rankClass = "rank-badge";
            if (currentRank === 1) rankClass += " top-1";
            else if (currentRank === 2) rankClass += " top-2";
            else if (currentRank === 3) rankClass += " top-3";

            const nameGlow =
                currentRank <= 3
                    ? "text-shadow: 0 0 8px var(--gold-glow);"
                    : "";

            // إزالة الـ style المكتوب داخلياً ليأخذ خصائص الـ CSS الجديدة
            const streakHtml =
                user.streak > 0
                    ? `<span class="streak-badge"><i class="fa-solid fa-fire fa-fw"></i> ${user.streak}</span>`
                    : "";

            const userDiv = document.createElement("div");

            let itemClass = "leaderboard-item";
            if (currentRank === 1) itemClass += " rank-1-hover";
            else if (currentRank === 2) itemClass += " rank-2-hover";
            else if (currentRank === 3) itemClass += " rank-3-hover";

            userDiv.className = itemClass;
            userDiv.innerHTML = `
                <div class="leaderboard-user-info">
                    <div class="${rankClass}">#${currentRank}</div>
                    <div class="avatar-wrapper ${getRankFrameClass(user.points)}" style="width: 45px; height: 45px;">
                        <img src="${user.photoURL || "images/profile.jpg"}" alt="Avatar">
                    </div>
                    <span class="leaderboard-name" style="${nameGlow}">${user.name}</span>
                </div>
                
                <div class="leaderboard-stats">
                    ${streakHtml}
                    <span class="task-points-badge" style="direction: ltr;">${user.points} pt</span>
                </div>
            `;

            userDiv.addEventListener("click", () =>
                openUserProfileModal({ ...user, rank: currentRank }),
            );
            listContainer.appendChild(userDiv);

            previousUser = user;
            actualPosition++; // زيادة عدد المقاعد المحجوزة دائماً
        });

        if (actualPosition === 1) {
            listContainer.innerHTML =
                '<p style="text-align: center; color: var(--text-muted);">لا يوجد متصدرين حتى الآن.</p>';
        }
    } catch (error) {
        console.error(error);
    }
}

function openUserProfileModal(user) {
    const modal = document.getElementById("user-modal-overlay");
    document.getElementById("modal-user-name").innerText = user.name;
    document.getElementById("modal-user-rank").innerText = `#${user.rank}`;
    document.getElementById("modal-user-points").innerText = user.points;
    document.getElementById("modal-user-streak").innerHTML =
        `<i class="fa-solid fa-fire fa-fw"></i> ${user.streak || 0}`;

    const avatarWrapper = document.getElementById("modal-avatar-wrapper");
    avatarWrapper.className = `avatar-wrapper ${getRankFrameClass(user.points)}`;
    document.getElementById("modal-user-avatar").src =
        user.photoURL || "images/profile.jpg";
    const badgesContainer = document.getElementById("modal-badges-container");
    if (user.badges && user.badges.length > 0) {
        badgesContainer.innerHTML = user.badges
            .map(
                (badge) =>
                    `<div style="background: rgba(168, 85, 247, 0.1); border: 1px solid var(--border-color); padding: 15px; border-radius: 12px; width: 110px; text-align: center; box-shadow: 0 4px 15px rgba(0,0,0,0.2);"><div style="display: flex; justify-content: center; align-items: center; font-size: 30px; margin-bottom: 5px; text-shadow: 0 0 10px var(--gold-glow);"><img src="${badge.icon}" alt="${badge.title}" style="width: 100px; object-fit: contain;"></div><h4 style="font-size: 12px; color: var(--text-main); margin-bottom: 5px;">${badge.title}</h4><span style="font-size: 10px; color: var(--gold-primary); font-weight: bold;">${badge.date}</span></div>`,
            )
            .join("");
    } else
        badgesContainer.innerHTML =
            '<p style="color: var(--text-muted); font-size: 15px; width: 100%; text-align: center; padding: 20px 0;">هذا المحارب لم يثبت نفسه ولم يحصد أي أوسمة بعد! 🏳️</p>';
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
        location.reload();
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
                    location.reload();
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
        // 1. جلب المهام لبناء مرجع (Dictionary) يربط الـ ID بالقسم والنقاط
        const tasksSnap = await getDocs(collection(db, "tasks"));
        const tasksMap = {};
        tasksSnap.forEach((doc) => {
            tasksMap[doc.id] = doc.data();
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
        let categoryPoints = {}; // لتخزين مجموع النقاط لكل قسم

        logsSnap.forEach((doc) => logsArray.push(doc.data()));
        logsArray.sort((a, b) => new Date(a.date) - new Date(b.date));

        logsArray.forEach((log) => {
            if (log.passed) passedCount++;
            else failedCount++;
            dates.push(log.date);
            points.push(log.pointsEarned);

            // حساب نقاط الأقسام من اختيارات هذا اليوم
            if (log.selections) {
                for (const [taskId, optionIndex] of Object.entries(
                    log.selections,
                )) {
                    const task = tasksMap[taskId];
                    if (task && task.options && task.options[optionIndex]) {
                        const cat = task.category || "مهام عامة";
                        const pts = task.options[optionIndex].points;
                        categoryPoints[cat] = (categoryPoints[cat] || 0) + pts;
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
        // المخطط الثاني: تحليل الأقسام (Radar Chart)
        // ==========================================
        const ctxCategory = document
            .getElementById("categoryChart")
            .getContext("2d");
        if (window.myCategoryChart) window.myCategoryChart.destroy();

        const catLabels = Object.keys(categoryPoints);
        const catData = Object.values(categoryPoints);

        if (catLabels.length > 0) {
            window.myCategoryChart = new Chart(ctxCategory, {
                type: "radar",
                data: {
                    labels: catLabels,
                    datasets: [
                        {
                            label: "إجمالي النقاط المكتسبة",
                            data: catData,
                            backgroundColor: "rgba(217, 70, 239, 0.12)", // لون ذهبي شفاف
                            borderColor: "#9ca3af", // لون ذهبي
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
                        legend: { display: false }, // إخفاء المفتاح لتوفير المساحة
                    },
                    scales: {
                        r: {
                            angleLines: { color: "rgba(255, 255, 255, 0.1)" },
                            grid: { color: "rgba(255, 255, 255, 0.1)" },
                            pointLabels: {
                                color: "#f3f4f6",
                                font: { family: "Cairo", size: 12 },
                            },
                            ticks: { display: false }, // إخفاء الأرقام الداخلية لشكل أنظف
                        },
                    },
                },
            });
        }
    } catch (e) {
        console.error("خطأ في تحميل الإحصائيات:", e);
    }
    // تشغيل جلب سجلات الذكاء الاصطناعي
    await loadAIReflections();
}

function getRankFrameClass(points) {
    if (points <= 500) return "frame-wood";
    if (points <= 1500) return "frame-bronze";
    if (points <= 3000) return "frame-silver";
    if (points <= 5000) return "frame-gold";
    return "frame-diamond";
}

// ==============================
// حل المشكلة 2 و 3: حفظ التاب النشط + تحديث البيانات تلقائياً (Live Fetch)
// بدون DOMContentLoaded لأن type="module" يتم تنفيذه بعد جاهزية الصفحة تلقائياً
// ==============================
const navItems = document.querySelectorAll("[data-target]");

navItems.forEach((item) => {
    item.addEventListener("click", function () {
        const target = this.getAttribute("data-target");
        if (!target) return;

        // 1. حفظ الصفحة الحالية في الذاكرة
        localStorage.setItem("dashboardActiveTab", target);

        // 2. تحديث البيانات الصامت حسب الصفحة المفتوحة
        if (target.includes("leaderboard")) {
            if (typeof loadLeaderboard === "function") loadLeaderboard();
        } else if (target.includes("analytics") || target.includes("stats")) {
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
    const currentPoints = userData.points || 0;
    const hasFreeze = userData.freezeCount > 0;

    if (hasFreeze) {
        return CustomDialog.alert(
            "أنت تمتلك بالفعل تجميداً مخزناً. استهلكه أولاً لتستطيع شراء غيره.",
            "المخزن ممتلئ",
        );
    }

    if (currentPoints < freezeCost) {
        return CustomDialog.alert(
            `نقاطك لا تكفي. تحتاج إلى ${freezeCost} نقطة.`,
            "رصيد غير كافٍ",
        );
    }

    const confirmBuy = await CustomDialog.confirm(
        `هل تريد شراء "تجميد الستريك" مقابل ${freezeCost} نقطة؟`,
    );

    if (confirmBuy) {
        try {
            await updateDoc(userRef, {
                points: increment(-freezeCost),
                freezeCount: 1,
            });
            await CustomDialog.alert(
                "تمت عملية الشراء بنجاح! سيتم استهلاكها تلقائياً عند أول إخفاق.",
                "مبروك ❄️",
            );
            location.reload(); // لتحديث الواجهة والنقاط
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
    const currentPoints = userData.points || 0;
    const cost = 150;

    if (hasTodo) {
        // حالة الإلغاء
        const confirmCancel = await CustomDialog.confirm(
            "هل أنت متأكد من إلغاء 'مفكرة المهام الحرة'؟\nلن يتم استرداد الـ 150 نقطة التي دفعتها، وستضطر لشرائها مجدداً إذا أردتها لاحقاً.",
            "إلغاء الأداة 🗑️",
        );

        if (confirmCancel) {
            await updateDoc(userRef, { hasTodoList: false });

            // طرد المستخدم للرئيسية إذا كان داخل صفحة المهام الحرة وقت الإلغاء
            if (localStorage.getItem("dashboardActiveTab") === "todo-page") {
                localStorage.setItem("dashboardActiveTab", "tasks-page");
            }

            location.reload();
        }
    } else {
        // حالة الشراء
        if (currentPoints < cost) {
            return CustomDialog.alert(
                `نقاطك لا تكفي. تحتاج إلى ${cost} نقطة لفتح هذه الأداة.`,
                "رصيد غير كافٍ",
            );
        }

        const confirmBuy = await CustomDialog.confirm(
            `هل تريد فتح 'مفكرة المهام الحرة' بشكل دائم مقابل ${cost} نقطة؟`,
            "شراء أداة 📝",
        );

        if (confirmBuy) {
            await updateDoc(userRef, {
                points: increment(-cost),
                hasTodoList: true,
            });

            await CustomDialog.alert(
                "تم فتح الأداة بنجاح! ستجدها الآن في القائمة الجانبية.",
                "عملية ناجحة 🎉",
            );
            location.reload();
        }
    }
};

// ==========================================
// مراقب كلمات صندوق المحاكمة (Word Counter)
// ==========================================
const reflectionInput = document.getElementById("daily-reflection-text");
const wordCountDisplay = document.getElementById("word-count-display");

if (reflectionInput) {
    reflectionInput.addEventListener("input", function () {
        // تنظيف النص من المسافات الزائدة وحساب الكلمات الفعلية
        let text = this.value.trim();
        let words = text === "" ? [] : text.split(/\s+/);
        let count = words.length;

        wordCountDisplay.innerText = count;

        // تغيير اللون للتحذير إذا تجاوز 300 أو قل عن 30
        if (count > 0 && count < 30) {
            wordCountDisplay.style.color = "#f59e0b"; // برتقالي (تحذير)
        } else if (count > 300) {
            wordCountDisplay.style.color = "var(--danger)"; // أحمر (مرفوض)
            // منع المستخدم من كتابة المزيد برمجياً
            this.value = words.slice(0, 300).join(" ");
            wordCountDisplay.innerText = 300;
        } else {
            wordCountDisplay.style.color = "var(--success)"; // أخضر (مقبول)
        }
    });
}

// ==========================================
// محرك الذكاء الاصطناعي (موجه الانضباط الداعم) - متصل بـ API حقيقي
// ==========================================
async function processAIJudgment(uid, dateStr, userText, points, passed) {
    try {
        // التلقين (Prompt) المعدل: صارم ولكن منصف ومشجع
        const systemPrompt = `
        أنت "موجه الانضباط" في منصة (BrainRot Detox). دورك هو مساعدة المحاربين على التخلص من المشتتات وبناء عادات حقيقية بأسلوب "الحزم الداعم" (Tough Love).
        
        بيانات اليوم:
        - النتيجة: ${passed ? "نجح في الوصول للهدف اليومي" : "فشل في الوصول للهدف اليومي"}
        - إجمالي النقاط: ${points}
        - تقرير المحارب: "${userText}"

        قواعد التحليل والرد:
        1. إذا نجح في التحدي: احتفل بإنجازه! أكد له أن التزامه اليوم هو انتصار حقيقي يستحق الفخر، ثم شجعه بحماس للحفاظ على هذا الزخم غداً.
        2. إذا فشل واختلق أعذاراً واهية: كن حازماً ومباشراً. ذكره بأن الأعذار لن تبني مستقبله، وأن الانضباط يعني العمل حتى في أسوأ الأيام. لا تهنه، بل أيقظه.
        3. إذا فشل لكنه كان صريحاً وتحمل المسؤولية: ادعمه بقوة. أخبره أن التعثر جزء من الرحلة، والمهم هو كيف سينهض غداً. طالبه بخطة تعويض.
        4. الأسلوب: احترافي، محفز، مباشر، وصادق. (تجنب الإهانة أو التحطيم، أنت مدرب ولست جلاداً).
        5. الحد الأقصى للرد: 80 كلمة فقط لتكون الرسالة سريعة وقوية.
        `;

        console.log("جاري الاتصال بالذكاء الاصطناعي الحقيقي...");

        // ==========================================
        // ⚠️ الاتصال الحقيقي بـ Gemini API
        // ==========================================
        const GEMINI_API_KEY = "AIzaSyAuSIOy2VQC-Ulcq7XF0jkU21i12rcQ_fo"; // استبدل هذا بمفتاحك الحقيقي
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{ parts: [{ text: systemPrompt }] }],
            }),
        });

        if (!response.ok)
            throw new Error("فشل الاتصال بـ API الذكاء الاصطناعي");

        const data = await response.json();
        const aiResponseText = data.candidates[0].content.parts[0].text;

        // تحديث قاعدة البيانات بالرد الحقيقي
        await updateDoc(doc(db, `users/${uid}/ai_reflections`, dateStr), {
            status: "completed",
            aiResponse: aiResponseText,
        });

        console.log("تم استلام الرد الحقيقي وحفظه بنجاح.");
    } catch (error) {
        console.error("فشل في جلب رد الذكاء الاصطناعي:", error);

        // رسالة طوارئ في حال تعطل الـ API أو نفاد الرصيد
        const fallbackMessage = passed
            ? "عمل ممتاز اليوم! لقد حققت هدفك وهذا إنجاز حقيقي. (ملاحظة: الموجه غير متاح حالياً، لكن إنجازك محفوظ. استمر!)"
            : "التعثر يحدث للجميع. المهم هو أن تنهض غداً بخطة أقوى. (ملاحظة: الموجه غير متاح حالياً، راجع أهدافك وانطلق من جديد).";

        await updateDoc(doc(db, `users/${uid}/ai_reflections`, dateStr), {
            status: "error", // يمكنك جعلها completed ليظهر النص البديل بشكل طبيعي
            aiResponse: fallbackMessage,
        });
    }
}

// ==========================================
// إدارة سجلات المحاكمة (جلب، تثبيت، حذف)
// ==========================================
async function loadAIReflections() {
    if (!currentUser) return;
    const listContainer = document.getElementById("reflections-list");
    const mainContainer = document.getElementById("ai-reflections-container");
    if (!listContainer || !mainContainer) return;

    try {
        const snap = await getDocs(
            collection(db, `users/${currentUser.uid}/ai_reflections`),
        );
        let reflections = [];
        snap.forEach((doc) => {
            reflections.push({ id: doc.id, ...doc.data() });
        });

        // إخفاء الصندوق بالكامل إذا لم يقم المستخدم بكتابة أي تقرير سابقاً
        if (reflections.length === 0) {
            mainContainer.style.display = "none";
            return;
        } else {
            mainContainer.style.display = "block";
        }

        // الترتيب: المثبت (Pinned) يظهر أولاً، ثم الترتيب حسب الأحدث
        reflections.sort((a, b) => {
            if (a.isPinned && !b.isPinned) return -1;
            if (!a.isPinned && b.isPinned) return 1;
            return new Date(b.date) - new Date(a.date);
        });

        listContainer.innerHTML = "";
        reflections.forEach((refData) => {
            const statusHtml =
                refData.status === "processing"
                    ? `<span style="color: #f59e0b; font-size: 12px;">⏳ جاري التحليل...</span>`
                    : refData.passed
                      ? `<span style="color: var(--success); font-size: 12px;">✅ حقق الهدف</span>`
                      : `<span style="color: var(--danger); font-size: 12px;">❌ فشل</span>`;

            const pinColor = refData.isPinned
                ? "var(--gold-primary)"
                : "var(--text-muted)";

            const aiResponseHtml =
                refData.status === "completed"
                    ? `<div style="background: rgba(168, 85, 247, 0.1); border-right: 3px solid var(--gold-primary); padding: 10px; border-radius: 4px; margin-top: 10px; font-size: 13.5px; line-height: 1.6; color: #f3f4f6;">
                     <strong style="color: var(--gold-primary);">الموجه:</strong> ${refData.aiResponse}
                   </div>`
                    : refData.status === "processing"
                      ? `<p style="color: var(--text-muted); font-size: 12px; margin-top: 10px;">الموجه يقرأ تقريرك الآن...</p>`
                      : "";

            const itemDiv = document.createElement("div");
            itemDiv.style.cssText =
                "background: rgba(0,0,0,0.3); border: 1px solid var(--border-color); border-radius: 8px; padding: 15px;";
            itemDiv.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px;">
                    <div>
                        <span style="font-weight: bold; color: var(--gold-primary); margin-left: 10px; font-size: 14px;">${refData.date}</span>
                        ${statusHtml}
                    </div>
                    <div style="display: flex; gap: 15px;">
                        <button onclick="togglePinReflection('${refData.id}', ${!!refData.isPinned})" style="background: none; border: none; color: ${pinColor}; cursor: pointer; font-size: 16px; transition: 0.2s;" title="تفضيل/تثبيت"><i class="fa-solid fa-thumbtack"></i></button>
                        <button onclick="deleteReflection('${refData.id}')" style="background: none; border: none; color: var(--danger); cursor: pointer; font-size: 16px; transition: 0.2s;" title="حذف نهائي"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </div>
                <p style="font-size: 14px; color: var(--text-main); line-height: 1.6; white-space: pre-wrap;"><strong>تقريرك:</strong> ${refData.userText}</p>
                ${aiResponseHtml}
            `;
            listContainer.appendChild(itemDiv);
        });
    } catch (error) {
        console.error("Error loading reflections:", error);
        listContainer.innerHTML =
            '<p style="color: var(--danger); text-align: center;">حدث خطأ أثناء تحميل السجلات.</p>';
    }
}

// دالة التفضيل (تثبيت السجل)
window.togglePinReflection = async function (id, currentStatus) {
    try {
        await updateDoc(
            doc(db, `users/${currentUser.uid}/ai_reflections`, id),
            {
                isPinned: !currentStatus,
            },
        );
        loadAIReflections(); // إعادة التحميل لترتيب العناصر فوراً
    } catch (error) {
        console.error("Error pinning reflection:", error);
        CustomDialog.alert("حدث خطأ أثناء تثبيت السجل.");
    }
};

// دالة الحذف النهائي
window.deleteReflection = async function (id) {
    if (
        await CustomDialog.confirm(
            "هل أنت متأكد من حذف هذا السجل نهائياً؟",
            "حذف السجل 🗑️",
        )
    ) {
        try {
            await deleteDoc(
                doc(db, `users/${currentUser.uid}/ai_reflections`, id),
            );
            loadAIReflections(); // تحديث الواجهة بعد الحذف
        } catch (e) {
            console.error("Error deleting reflection:", e);
            CustomDialog.alert("حدث خطأ أثناء الحذف.");
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
        onDestroyed: () => {
            // بمجرد انتهاء الجولة، نجبر النظام على العودة لصفحة المهام
            const tasksBtn = document.querySelector(
                '[data-target="tasks-page"]',
            );
            if (tasksBtn) tasksBtn.click();
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
                element: ".reflection-container-class ",
                popover: {
                    title: "محاكمة الذات ⚖️",
                    description:
                        "قبل إنهاء اليوم، اكتب تقريراً مختصراً عن أدائك. الموجه الصارم سيقرأه ويحلل صراحتك.",
                    side: "top",
                    align: "center",
                },
                // هذا السطر يجبر المتصفح على النزول للعنصر ووضعه في منتصف الشاشة
                onHighlightStarted: () => {
                    const reflectionBox = document.getElementById(
                        "reflection-container",
                    );
                    if (reflectionBox) {
                        reflectionBox.scrollIntoView({
                            behavior: "auto",
                            block: "center",
                        });
                    }
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
            {
                element: '[data-target="analytics-page"]',
                popover: {
                    title: "لوحة الاحصائيات 📊",
                    description:
                        "هنا يمكنك رؤية تقدمك اليومي، تحليل نقاطك، وأداءك في الجوانب المختلفة. استخدم هذه البيانات لتعديل استراتيجيتك وتحسين أدائك.",
                    side: "left",
                    align: "center",
                },
                // هذا السطر يجبر النظام على فتح صفحة المتجر فوراً بمجرد وصول الجولة له
                onHighlightStarted: () => {
                    const storeBtn = document.querySelector(
                        '[data-target="analytics-page"]',
                    );
                    if (storeBtn) storeBtn.click();
                },
            },
        ],
    });

    // تشغيل الجولة بعد التأكد من كل شيء
    tour.drive();
    localStorage.setItem("brainrot_tour_completed", "true");
}
