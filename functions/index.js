const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

// تعريف المفتاح السري
const geminiApiKey = defineSecret("GEMINI_API_KEY");

// إذا لم تكن هذه الأسطر موجودة، أضفها في الأعلى
if (!admin.apps.length) {
    admin.initializeApp();
}
const db = admin.firestore();

// ==========================================
// 1. إشعارات مخصصة من لوحة الإدارة (التحديات والتسجيل) - إصدار V2
// ==========================================
exports.sendAdminBroadcast = onCall(async (request) => {
    // حماية أمنية: نستخدم request.auth في V2 بدلاً من context.auth
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "يجب تسجيل الدخول.");
    }

    const callerSnap = await admin
        .firestore()
        .collection("users")
        .doc(request.auth.uid)
        .get();
    if (!callerSnap.exists || callerSnap.data().role !== "admin") {
        throw new HttpsError(
            "permission-denied",
            "هذا الإجراء مسموح للإدارة فقط.",
        );
    }

    const { title, body } = request.data;
    if (!title || !body) {
        throw new HttpsError("invalid-argument", "عنوان ونص الإشعار مطلوبان.");
    }

    try {
        const usersSnap = await admin.firestore().collection("users").get();
        let allTokens = [];

        usersSnap.forEach((doc) => {
            const userData = doc.data();
            if (userData.fcmTokens && Array.isArray(userData.fcmTokens)) {
                allTokens = allTokens.concat(userData.fcmTokens);
            }
        });

        if (allTokens.length === 0) {
            return {
                success: false,
                message: "لا يوجد مستخدمين مفعلين للإشعارات.",
            };
        }

        const response = await admin.messaging().sendEachForMulticast({
            tokens: allTokens,
            notification: { title, body },
            // --- السلاح السري لاختراق وضع السكون في أندرويد ---
            android: {
                priority: "high", // إجبار النظام على إيقاظ التطبيق فوراً
                notification: {
                    sound: "default",
                },
            },
            // --- الإضافة الجديدة ---
            webpush: {
                notification: {
                    icon: "/images/icon-512.png",
                    badge: "/images/badge.png",
                    dir: "rtl",
                },
            },
            // -----------------------
        });

        return {
            success: true,
            message: `تم إرسال الإشعار بنجاح إلى ${response.successCount} جهاز.`,
        };
    } catch (error) {
        console.error("خطأ في إرسال البث:", error);
        throw new HttpsError("internal", "حدث خطأ داخلي أثناء الإرسال.");
    }
});

// ==========================================
// إشعار الطوارئ القناص: (قبل النهاية بساعتين) - صيغة V2
// ==========================================
exports.doomsdayWarning = onSchedule(
    {
        schedule: "0 22 * * *",
        timeZone: "Africa/Cairo",
    },
    async (event) => {
        try {
            const challengeDoc = await admin
                .firestore()
                .doc("settings/currentChallenge")
                .get();
            if (
                !challengeDoc.exists ||
                challengeDoc.data().status !== "active"
            ) {
                return null;
            }

            const now = new Date();
            const todayStr = now.toLocaleDateString("en-CA", {
                timeZone: "Africa/Cairo",
            });

            const usersSnap = await admin
                .firestore()
                .collection("users")
                .where("challengeStatus", "==", "active")
                .where(
                    "joinedChallengeId",
                    "==",
                    challengeDoc.data().challengeId,
                )
                .get();

            let targetTokens = [];

            for (const userDoc of usersSnap.docs) {
                const userData = userDoc.data();
                if (!userData.fcmTokens || userData.fcmTokens.length === 0)
                    continue;

                const logDoc = await admin
                    .firestore()
                    .doc(`users/${userDoc.id}/dailyLogs/${todayStr}`)
                    .get();

                // القنص: من لم يعتمد يومه بعد
                if (!logDoc.exists || logDoc.data().isFinalized !== true) {
                    targetTokens.push(...userData.fcmTokens);
                }
            }

            if (targetTokens.length > 0) {
                await admin.messaging().sendEachForMulticast({
                    tokens: targetTokens,
                    notification: {
                        title: "⚠️ المعسكر لا يرحم المتكاسلين!",
                        body: "باقي ساعتين فقط على الإغلاق. ادخل الآن وأنهِ مهامك واعتمد يومك قبل أن يتم إقصاؤك.",
                    },
                    android: {
                        priority: "high",
                        notification: { sound: "default" },
                    },
                    webpush: {
                        notification: {
                            icon: "/images/icon-512.png",
                            badge: "/images/badge.png",
                            dir: "rtl",
                            requireInteraction: true,
                        },
                    },
                });
            }
        } catch (error) {
            console.error("حدث خطأ في إشعار القناص:", error);
        }
        return null;
    },
);

// ========================================================
// 🚀 القاضي الآلي: تقييم الجمعة، وتصفير الدورة (V4 - الإزاحة الوقتية)
// ========================================================
exports.weeklyWipeAndEvaluate = onSchedule(
    {
        // 🛑 تأخير الإطلاق إلى 4 فجراً يوم السبت لإعطاء مهلة للمحاربين
        schedule: "0 4 * * 6",
        timeZone: "Africa/Cairo",
        timeoutSeconds: 300, // 5 دقائق لاستيعاب عدد كبير من المستخدمين
    },
    async (event) => {
        const db = admin.firestore();

        // 🛑 نظام السلال المتعددة (Chunking) لتجاوز حد الـ 500 عملية
        let batch = db.batch();
        let operationCount = 0;

        async function commitBatchIfNeeded() {
            if (operationCount >= 450) {
                await batch.commit();
                batch = db.batch(); // فتح سلة جديدة
                operationCount = 0;
            }
        }

        try {
            const sysRef = db.doc("configs/system");
            const sysDoc = await sysRef.get();
            const currentCycle = sysDoc.exists
                ? sysDoc.data().currentCycle || 1
                : 1;

            const challengeDoc = await db
                .doc("settings/currentChallenge")
                .get();
            const targetPoints =
                challengeDoc.exists && challengeDoc.data().dailyTargetPoints
                    ? challengeDoc.data().dailyTargetPoints
                    : 100;

            const tasksSnap = await db.collection("tasks").get();
            const allTasks = {};
            const importantTaskIds = [];
            tasksSnap.forEach((doc) => {
                const data = doc.data();
                allTasks[doc.id] = data;
                if (data.isImportant && data.isActive !== false)
                    importantTaskIds.push(doc.id);
            });

            const relTasksSnap = await db.collection("religiousTasks").get();
            const importantRelTaskIds = [];
            relTasksSnap.forEach((doc) => {
                const data = doc.data();
                if (data.isImportant && data.isActive !== false)
                    importantRelTaskIds.push(doc.id);
            });

            const now = new Date();

            // 🛑 الإزاحة الوقتية (Time Offset)
            // إذا انطلق القاضي 4 فجراً (السبت)، خصم 6 ساعات يرجعه لـ 10 مساءً (الجمعة)
            // هذا يضمن أن اليوم المستهدف للتقييم هو الجمعة بدون أي خطأ منطقي
            now.setHours(now.getHours() - 6);

            const formatter = new Intl.DateTimeFormat("en-CA", {
                timeZone: "Africa/Cairo",
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
            });
            const targetDateStr = formatter.format(now);

            const limitParts = targetDateStr.split("-");
            const limitDate = new Date(
                limitParts[0],
                limitParts[1] - 1,
                limitParts[2],
            );

            const usersSnap = await db.collection("users").get();
            let usersList = [];

            for (const userDoc of usersSnap.docs) {
                let userData = userDoc.data();
                let uid = userDoc.id;

                let newStreak = userData.currentStreak || 0;
                let newZone = userData.currentZone || "green";
                let earnedStreakBadges = userData.earnedStreakBadges || [];
                let badges = userData.badges || [];
                let cycleScore = userData.cycleScore || 0;
                let freezeCount = userData.freezeCount || 0;
                let walletCoins = userData.walletCoins || 0;

                let lifetimeScore = userData.lifetimeScore || 0;
                let hasDoubleXP = userData.hasDoubleXP || false;
                let currentMultiplier = userData.currentMultiplier || 1.0;

                // 🛑 تعريف المتغيرات المحلية بشكل صحيح
                let lostStreak = userData.lostStreak || 0;
                let streakDeathTimestamp =
                    userData.streakDeathTimestamp || null;

                let currentEvalDateStr = userData.lastEvalDate;

                if (!currentEvalDateStr) {
                    let t = new Date(now);
                    t.setDate(t.getDate() - 1);
                    currentEvalDateStr = formatter.format(t);
                }

                let parts = currentEvalDateStr.split("-");
                let evalDate = new Date(parts[0], parts[1] - 1, parts[2]);
                evalDate.setDate(evalDate.getDate() + 1);

                // المراجعة الرجعية
                while (evalDate <= limitDate) {
                    const yyyy = evalDate.getFullYear();
                    const mm = String(evalDate.getMonth() + 1).padStart(2, "0");
                    const dd = String(evalDate.getDate()).padStart(2, "0");
                    const dateStr = `${yyyy}-${mm}-${dd}`;

                    const logRef = db
                        .collection(`users/${uid}/dailyLogs`)
                        .doc(dateStr);
                    const logDoc = await logRef.get();

                    if (!logDoc.exists || !logDoc.data().isFinalized) {
                        let logData = logDoc.exists ? logDoc.data() : {};
                        let selections = logData.selections || {};
                        let religiousSelections =
                            logData.religiousSelections || {};

                        let missingRel = false;
                        for (let id of importantRelTaskIds) {
                            let sel = religiousSelections[id];
                            let isDone = false;

                            if (typeof sel === "boolean") {
                                isDone = sel;
                            } else if (Array.isArray(sel)) {
                                if (
                                    sel.length > 1 ||
                                    (sel.length === 1 && sel[0] !== 0)
                                )
                                    isDone = true;
                            } else {
                                if (sel > 0) isDone = true;
                            }

                            if (!isDone) {
                                missingRel = true;
                                break;
                            }
                        }

                        let missingImportant = false;
                        for (let id of importantTaskIds) {
                            let sel = selections[id];
                            let isDone = false;
                            if (Array.isArray(sel)) {
                                if (
                                    sel.length > 1 ||
                                    (sel.length === 1 && sel[0] !== 0)
                                )
                                    isDone = true;
                            } else {
                                if (sel > 0) isDone = true;
                            }
                            if (!isDone) {
                                missingImportant = true;
                                break;
                            }
                        }

                        let calcPoints = 0;
                        for (let [taskId, sel] of Object.entries(selections)) {
                            let task = allTasks[taskId];
                            if (task && task.options) {
                                let selArray = Array.isArray(sel) ? sel : [sel];
                                for (let idx of selArray) {
                                    if (task.options[idx])
                                        calcPoints +=
                                            task.options[idx].points || 0;
                                }
                            }
                        }

                        const passedToday =
                            !missingImportant &&
                            !missingRel &&
                            calcPoints >= targetPoints;

                        if (passedToday) {
                            newStreak++;
                            if (newZone === "yellow") newZone = "green";

                            if (newStreak >= 21) currentMultiplier = 2.0;
                            else if (newStreak >= 14) currentMultiplier = 1.6;
                            else if (newStreak >= 7) currentMultiplier = 1.4;
                            else if (newStreak >= 3) currentMultiplier = 1.2;
                            else currentMultiplier = 1.0;

                            const multipliedPoints = Math.floor(
                                calcPoints * currentMultiplier,
                            );
                            let earnedCoins = Math.floor(
                                multipliedPoints / 1.5,
                            );
                            let earnedXP = multipliedPoints;

                            if (hasDoubleXP) {
                                earnedXP *= 2;
                                hasDoubleXP = false;
                            }

                            lifetimeScore += earnedXP;
                            walletCoins += earnedCoins;
                            cycleScore += multipliedPoints;
                        } else {
                            if (freezeCount > 0) {
                                freezeCount--;
                            } else {
                                // 🛑 التعديل الجراحي: تسجيل الستريك وتاريخ الوفاة باستخدام المتغيرات المحلية الصحيحة
                                lostStreak = newStreak;
                                streakDeathTimestamp = Date.now();
                                newStreak = 0;
                                currentMultiplier = 1.0;

                                // 🛑 فرز الجندي وتحديد رتبته العسكرية
                                let isBeginner = lifetimeScore <= 1000;
                                let isIntermediate =
                                    lifetimeScore > 1000 &&
                                    lifetimeScore <= 5000;
                                let isPro = lifetimeScore > 5000;

                                // 🛑 تطبيق العقوبات الصارمة بناءً على الرتبة
                                if (isBeginner) {
                                    // المبتدئ: لا يُخصم منه شيء ولا يطرد للمناطق
                                } else if (isIntermediate) {
                                    if (newZone === "green") newZone = "yellow";
                                    else if (newZone === "yellow")
                                        newZone = "red";

                                    const penaltyCoins = Math.floor(
                                        targetPoints / 2,
                                    );
                                    walletCoins =
                                        (Number(walletCoins) || 0) -
                                        penaltyCoins;
                                } else if (isPro) {
                                    if (newZone === "green") newZone = "yellow";
                                    else if (newZone === "yellow")
                                        newZone = "red";

                                    const penaltyCoins = targetPoints;
                                    walletCoins =
                                        (Number(walletCoins) || 0) -
                                        penaltyCoins;
                                }
                            }
                        }

                        const logicalTimestamp = new Date(evalDate);
                        logicalTimestamp.setHours(23, 59, 59);

                        batch.set(
                            logRef,
                            {
                                date: dateStr,
                                isFinalized: true,
                                passed: passedToday,
                                pointsEarned: calcPoints,
                                selections: selections,
                                religiousSelections: religiousSelections,
                                timestamp: logicalTimestamp.toISOString(),
                            },
                            { merge: true },
                        );

                        operationCount++;
                        await commitBatchIfNeeded();
                    }
                    currentEvalDateStr = dateStr;
                    evalDate.setDate(evalDate.getDate() + 1);
                }

                const milestones = [7, 14, 21, 28, 35, 42, 50, 60, 90, 100];
                for (let m of milestones) {
                    if (newStreak >= m && !earnedStreakBadges.includes(m)) {
                        earnedStreakBadges.push(m);

                        let dayWord = "";
                        if (m >= 3 && m <= 10) dayWord = "أيام";
                        else if (m >= 11 && m <= 99) dayWord = "يوماً";
                        else dayWord = "يوم";

                        badges.push({
                            id: `streak_${m}`,
                            title: `بطل صمود - ${m} ${dayWord}`,
                            description: `أكملت ${m} ${dayWord} من الالتزام المتتالي القاسي .`,
                            imagePath: `images/streaks/streak-${m}.webp`,
                            date: new Date().toISOString(),
                            type: "streak",
                        });
                    }
                }

                // 🛑 تم إزالة u. من المتغيرات لأنها تمرر مباشرة من الـ Scope المحلي
                usersList.push({
                    uid,
                    cycleScore,
                    newStreak,
                    newZone,
                    freezeCount,
                    walletCoins,
                    lifetimeScore,
                    hasDoubleXP,
                    currentMultiplier,
                    earnedStreakBadges,
                    badges,
                    lastEvalDate: currentEvalDateStr,
                    lostStreak: lostStreak,
                    streakDeathTimestamp: streakDeathTimestamp,
                });
            }

            usersList.sort((a, b) => b.cycleScore - a.cycleScore);

            let rank = 1;
            for (let i = 0; i < usersList.length; i++) {
                let u = usersList[i]; // 🛑 هنا فقط يتم تعريف u.
                if (rank <= 3 && u.cycleScore > 0) {
                    u.badges.push({
                        id: `top${rank}_cycle_${currentCycle}`,
                        title: `TOP ${rank}`,
                        description: `تصدرت المرتبة ${rank} على المعسكر وتفوقت على الجميع في الدورة التنافسية رقم ${currentCycle}.`,
                        imagePath: `images/top-${rank}.webp`,
                        date: new Date().toISOString(),
                        type: "cycle",
                    });
                    rank++;
                }

                const uRef = db.doc(`users/${u.uid}`);

                batch.update(uRef, {
                    currentStreak: u.newStreak,
                    currentZone: u.newZone,
                    freezeCount: u.freezeCount,
                    walletCoins: u.walletCoins,
                    lifetimeScore: u.lifetimeScore,
                    hasDoubleXP: u.hasDoubleXP,
                    currentMultiplier: u.currentMultiplier,
                    earnedStreakBadges: u.earnedStreakBadges,
                    badges: u.badges,
                    cycleScore: 0,
                    usedDoubleXP: false,
                    coreTasksCompletedToday: false,
                    lastEvalDate: u.lastEvalDate,
                    lostStreak: u.lostStreak,
                    streakDeathTimestamp: u.streakDeathTimestamp || null,
                    isStreakRestoreUsed: false,
                });

                operationCount++;
                await commitBatchIfNeeded();
            }

            batch.update(sysRef, {
                currentCycle: currentCycle + 1,
                lastReset: new Date().toISOString(),
            });
            operationCount++;

            if (operationCount > 0) {
                await batch.commit();
            }

            console.log(
                `تم إغلاق الدورة ${currentCycle} بنجاح. تم استخدام ${Math.ceil(operationCount / 450)} سلال حفظ.`,
            );
            return null;
        } catch (error) {
            console.error("حدث خطأ أثناء تصفير الدورة:", error);
            return null;
        }
    },
);
// ========================================================
// 🤖 القاضي الآلي: تحليل صور فك القيود بواسطة Gemini
// ========================================================
exports.verifyUnchainingProof = onCall(
    { secrets: [geminiApiKey] },
    async (request) => {
        // 1. حماية أمنية: التأكد أن الطلب قادم من مستخدم مسجل
        const uid = request.auth?.uid;
        if (!uid)
            throw new HttpsError(
                "unauthenticated",
                "غير مصرح لك بإجراء هذه العملية.",
            );

        const storagePath = request.data.storagePath;
        const justification = request.data.justification || ""; // 🛑 سحب التبرير
        if (!storagePath)
            throw new HttpsError(
                "invalid-argument",
                "لم يتم العثور على مسار الصورة.",
            );

        try {
            // 2. سحب الصورة من Firebase Storage مباشرة داخل الخادم
            const bucket = admin.storage().bucket();
            const file = bucket.file(storagePath);
            const [buffer] = await file.download();

            // 3. تهيئة الصورة لـ Gemini
            const imageParts = [
                {
                    inlineData: {
                        data: buffer.toString("base64"),
                        mimeType: "image/jpeg", // Gemini يتعامل بمرونة مع امتدادات الصور
                    },
                },
            ];

            // 4. استدعاء الذكاء الاصطناعي مع Prompt المحقق الصارم
            const genAI = new GoogleGenerativeAI(geminiApiKey.value());
            const model = genAI.getGenerativeModel({
                model: "gemini-2.5-flash",
            });

            const prompt = `أنت قاضٍ آلي صارم في منصة تحديات قاسية. 
المستخدم معاقب، وللخروج من العقوبة يجب أن يرفع إثباتاً يوضح أن "الوقت المهدر الصافي" على الهاتف أقل من ساعتين.

التبرير المقدم من المستخدم لأوقات العمل/الدراسة: "${justification}"

قم بتحليل الصورة بدقة بناءً على هذه القواعد الصارمة:
1. اقرأ "إجمالي وقت الشاشة" (Total Screen Time) من الصورة.
2. اقرأ التبرير المقدم: إذا كان منطقياً ويشرح استخداماً إنتاجياً (منصات تعليمية، عمل، محاضرات، ملفات PDF)، اطرح هذا الوقت "الإنتاجي" من "إجمالي وقت الشاشة" لتحصل على "وقت الشاشة المهدر الصافي".
3. يجب أن يكون "وقت الشاشة المهدر الصافي" أقل من ساعتين (120 دقيقة). (مثال: إذا كان إجمالي الشاشة 5 ساعات، ولكن التبرير أثبت أن هناك 4 ساعات دراسة، فالمهدر هو ساعة واحدة، وهذا يعتبر مقبول).
4. يجب أن يكون الوقت المستهلك على تطبيقات الفيديوهات القصيرة (TikTok, Reels, Shorts, Instagram, YouTube) أقل من 30 دقيقة. (هذا الوقت لا يقبل التبرير أبداً ويعتبر مهدراً دائماً).
5. هل تبدو معدلة ببرامج، أو صورة عامة من الإنترنت، أو شاشة سوداء؟ ارفضها فوراً.

التعليمات الصارمة للإجابة:
- إذا كان "الوقت المهدر الصافي" أقل من ساعتين، والشورتس أقل من 30 دقيقة، اكتب كلمة واحدة فقط: قبول
- إذا كان "الوقت المهدر الصافي" ساعتين فأكثر، أو الشورتس 30 دقيقة فأكثر، اكتب: رفض: [اكتب سبب الرفض باختصار مع ذكر كم كان الوقت المهدر الصافي بعد الحساب]`;

            const result = await model.generateContent([prompt, ...imageParts]);
            const responseText = result.response.text().trim();

            // 5. اتخاذ القرار برمجياً وحفظه في سجلات اليوم (dailyLogs) للرادار
            const imageUrl = request.data.imageUrl || "";

            // توليد تاريخ القاهرة لربط المحاولة بسجل اليوم
            const now = new Date();
            const formatter = new Intl.DateTimeFormat("en-CA", {
                timeZone: "Africa/Cairo",
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
            });
            const todayStr = formatter.format(now);
            const logRef = admin
                .firestore()
                .doc(`users/${uid}/dailyLogs/${todayStr}`);

            if (responseText.startsWith("قبول")) {
                // فك القيود للمستخدم
                await admin.firestore().collection("users").doc(uid).update({
                    currentZone: "green",
                    currentStreak: 0,
                });

                // توثيق المحاولة الناجحة للرادار
                await logRef.set(
                    {
                        unchainingData: {
                            proofImageUrl: imageUrl,
                            status: "accepted",
                            message: "تم فك القيود والعودة للمنطقة الخضراء",
                            timestamp: now.toISOString(),
                        },
                    },
                    { merge: true },
                );

                return { success: true, message: "تمت الموافقة" };
            } else {
                // توثيق المحاولة الفاشلة للرادار (لا نغير منطقة المستخدم)
                const reason = responseText.replace("رفض:", "").trim();

                await logRef.set(
                    {
                        unchainingData: {
                            proofImageUrl: imageUrl,
                            status: "rejected",
                            message: reason,
                            timestamp: now.toISOString(),
                        },
                    },
                    { merge: true },
                );

                return { success: false, message: reason };
            }
        } catch (error) {
            console.error("Gemini Verification Error:", error);
            throw new HttpsError(
                "internal",
                "حدث خطأ أثناء تحليل الصورة بواسطة الذكاء الاصطناعي.",
            );
        }
    },
);

// ==========================================
// 🤖 القاضي الآلي: مُحلل الدوبامين واستهلاك الشاشة (Canvas AI)
// ==========================================
exports.evaluateScreenTime = onCall(
    { secrets: [geminiApiKey] },
    async (request) => {
        // 1. حاجز الأمان
        if (!request.auth) {
            throw new HttpsError(
                "unauthenticated",
                "يجب تسجيل الدخول لإجراء التقييم.",
            );
        }

        const {
            totalScreenMinutes,
            totalShortsMinutes,
            justification,
            imageUrl,
        } = request.data;

        try {
            const genAI = new GoogleGenerativeAI(geminiApiKey.value());
            const model = genAI.getGenerativeModel({
                model: "gemini-2.5-flash",
            });

            // 2. سحب الصورة من رابط Firebase Storage (باستخدام fetch المدمج في Node 18+)
            const response = await fetch(imageUrl);
            if (!response.ok) throw new Error("فشل في تحميل الصورة من التخزين");
            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);

            const imagePart = {
                inlineData: {
                    data: buffer.toString("base64"),
                    mimeType:
                        response.headers.get("content-type") || "image/jpeg",
                },
            };
            // توليد التاريخ والوقت الحالي بتوقيت القاهرة لتمريره للـ AI
            const now = new Date();
            const cairoFormatter = new Intl.DateTimeFormat("en-CA", {
                timeZone: "Africa/Cairo",
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
            });
            const cairoTimeFormatter = new Intl.DateTimeFormat("en-US", {
                timeZone: "Africa/Cairo",
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
            });
            const todayStr = cairoFormatter.format(now);
            const submissionTimeStr = cairoTimeFormatter.format(now);

            // 3. التلقين الصارم للذكاء الاصطناعي (Strict Prompt)
            const prompt = `
أنت قاضي ذكاء اصطناعي صارم جداً في منصة "BrainRot Detox".
يجب عليك تحليل الصورة المرفقة (والتي قد تكون مدمجة لعدة لقطات شاشة من أجهزة المستخدم) لتحديد "وقت الشاشة المهدر" بدقة.

معلومات أدخلها المستخدم:
- إجمالي وقت الشاشة المبلغ عنه: ${totalScreenMinutes} دقيقة.
- وقت Shorts/Reels/TikTok: ${totalShortsMinutes} دقيقة.
- التبرير المقدم: "${justification}"
- وقت رفع الصورة (توقيت القاهرة): ${submissionTimeStr}
- تاريخ اليوم المطلوب (توقيت القاهرة): ${todayStr}


━━━━━━━━━━━━━━━━━━━
القواعد العسكرية للتقييم (مرتبة بالأولوية):
━━━━━━━━━━━━━━━━━━━

[1] فحص صحة الصورة (الأهم):
- يجب أن تكون لقطة شاشة حقيقية لـ Screen Time / Digital Wellbeing / إعدادات الاستخدام.
- إذا كانت الصورة لا علاقة لها بوقت الشاشة (سوداء، سيلفي، احتيال، صورة من الإنترنت) → اجعل wastedScreenMinutes = 999.

[2] فحص التوقيت:
- ابحث في الصورة عن أي مؤشر زمني: ساعة الجهاز، تاريخ التقرير، عبارات مثل "اليوم" / "Today" / "آخر 24 ساعة".
- إذا وجدت تاريخاً في الصورة وكان مختلفاً عن تاريخ اليوم (${todayStr}) → اجعل wastedScreenMinutes = 999 وأضف سبب الرفض.
- إذا وجدت ساعة في الصورة وكانت قبل الساعة 9 مساءً (21:00) بتوقيت القاهرة → اجعل wastedScreenMinutes = 999.
- إذا لم يظهر في الصورة أي تاريخ أو ساعة → تجاوز هذا الفحص (لا تعاقب على غياب المعلومة).

[3] تقييم الاستهلاك:
- اقرأ التبرير: إذا كان منطقياً ويشرح استخداماً إنتاجياً (Zoom، منصات تعليمية، عمل)، اطرح هذا الوقت من الإجمالي.
- السوشيال ميديا، الألعاب، والشورتس = مهدر كلياً بلا استثناء.


الرد المطلوب:
يجب أن يكون ردك عبارة عن كائن JSON فقط، بدون أي نصوص تمهيدية وبدون علامات Markdown، مطابق لهذا الهيكل بالضبط:
{
  "wastedScreenMinutes": [الرقم الصافي للوقت المهدر],
  "wastedShortsMinutes": [الرقم الصافي لشورتس المهدر]
}
`;

            // const aiData = JSON.parse(text);
            // 4. استخراج الحكم
            const result = await model.generateContent([prompt, imagePart]);
            const text = result.response.text().trim();

            // استخراج كائن JSON فقط وتجاهل أي نصوص إضافية أو علامات Markdown حوله
            const jsonMatch = text.match(/\{[\s\S]*\}/);

            if (!jsonMatch) {
                console.error("Gemini Raw Response:", text);
                throw new Error("لم يقم الذكاء الاصطناعي بإرجاع JSON صالح.");
            }

            const aiData = JSON.parse(jsonMatch[0]);
            return {
                success: true,
                wastedScreenMinutes:
                    aiData.wastedScreenMinutes !== undefined
                        ? aiData.wastedScreenMinutes
                        : totalScreenMinutes,
                wastedShortsMinutes:
                    aiData.wastedShortsMinutes !== undefined
                        ? aiData.wastedShortsMinutes
                        : totalShortsMinutes,
            };
        } catch (error) {
            console.error("Gemini Dopamine Evaluation Error:", error);
            throw new HttpsError(
                "internal",
                "حدث خطأ أثناء تحليل الذكاء الاصطناعي.",
            );
        }
    },
);
// ==========================================
// 🤖 3. القاضي الآلي: استخراج جراحي مع نظام طوارئ (Fallback Models)
// ==========================================
exports.analyzeScreenTimeProof = onCall(
    { secrets: [geminiApiKey] },
    async (request) => {
        if (!request.auth) {
            throw new HttpsError("unauthenticated", "يجب تسجيل الدخول.");
        }

        const imageUrls = request.data.imageUrls;
        if (!imageUrls || !Array.isArray(imageUrls) || imageUrls.length === 0) {
            throw new HttpsError("invalid-argument", "لم يتم إرسال صور صالحة.");
        }

        try {
            const genAI = new GoogleGenerativeAI(geminiApiKey.value());

            // 🛑 مصفوفة الطوارئ: ترتيب الموديلات من الأساسي إلى الاحتياطي
            const fallbackModels = [
                "gemini-3.1-flash-lite",
                "gemini-2.5-flash-lite",
                "gemini-2.5-flash",
                "gemini-3-flash",
                "gemini-3.5-flash",
            ];

            const prompt = `
You are an expert OCR engine. Analyze this screen time image.
Extract EVERY SINGLE APP visible and its duration.

RULES:
1. Convert ALL times to total minutes (e.g., "1h 30m" = 90, "45m" = 45).
2. Classify EVERY app into exactly one of these 3 arrays based ONLY on these whitelists:
   - "study_apps": [@HOME, Matary, MedC, EasyMed, PDF Apps, Ecourses, Anki, Microsoft Teams].
   - "shorts_apps": [Instagram, Tiktok].
   - "neutral_apps": EVERY OTHER APP IN EXISTENCE (e.g., WhatsApp, YouTube, Chrome, Facebook, Telegram, ChatGPT, Phone, Settings, etc).

3. DO NOT calculate any totals. Just return the arrays.
4. MUST RETURN ONLY A VALID JSON OBJECT. NO markdown, NO code blocks.

Expected JSON format:
{
  "study_apps": [],
  "shorts_apps": [],
  "neutral_apps": [{ "name": "WhatsApp", "minutes": 45 }]
}
`;

            let total_minutes = 0;
            let explicit_study = 0;
            let explicit_shorts = 0;
            let combinedNeutralApps = [];
            const seenNeutralKeys = new Set();

            for (const url of imageUrls) {
                const imageResponse = await fetch(url);
                if (!imageResponse.ok) continue;

                const arrayBuffer = await imageResponse.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);
                const base64Image = buffer.toString("base64");
                const mimeType =
                    imageResponse.headers.get("content-type") || "image/jpeg";

                let result = null;
                let lastError = null;

                // 🛑 محرك التبديل التلقائي (Model Rotation Loop)
                for (const modelName of fallbackModels) {
                    try {
                        const model = genAI.getGenerativeModel({
                            model: modelName,
                        });
                        result = await model.generateContent([
                            prompt,
                            {
                                inlineData: {
                                    data: base64Image,
                                    mimeType: mimeType,
                                },
                            },
                        ]);
                        // إذا نجح الموديل، نكسر الحلقة ونتوقف عن المحاولة
                        break;
                    } catch (error) {
                        console.warn(
                            `فشل الموديل [${modelName}]. جاري تجربة الموديل التالي... السبب:`,
                            error.message,
                        );
                        lastError = error;
                    }
                }

                // إذا فشلت جميع الموديلات في المصفوفة، نرمي الخطأ الأخير
                if (!result) {
                    throw (
                        lastError ||
                        new Error(
                            "جميع موديلات الذكاء الاصطناعي فشلت في الاستجابة.",
                        )
                    );
                }

                let responseText = result.response.text();
                responseText = responseText
                    .replace(/```json/g, "")
                    .replace(/```/g, "")
                    .trim();

                const parsedData = JSON.parse(responseText);

                const studyApps = (parsedData.study_apps || []).filter(
                    (app) => app.minutes > 0,
                );
                studyApps.forEach((app) => {
                    explicit_study += app.minutes;
                    total_minutes += app.minutes;
                });

                const shortsApps = (parsedData.shorts_apps || []).filter(
                    (app) => app.minutes > 0,
                );
                shortsApps.forEach((app) => {
                    explicit_shorts += app.minutes;
                    total_minutes += app.minutes;
                });

                const neutralApps = (parsedData.neutral_apps || []).filter(
                    (app) => app.minutes > 0,
                );
                neutralApps.forEach((app) => {
                    const uniqueKey = `${app.name}_${app.minutes}`;
                    if (!seenNeutralKeys.has(uniqueKey)) {
                        seenNeutralKeys.add(uniqueKey);
                        combinedNeutralApps.push(app);
                        total_minutes += app.minutes;
                    }
                });
            }

            return {
                success: true,
                result: {
                    total_minutes: total_minutes,
                    explicit_study: explicit_study,
                    explicit_others: 0,
                    explicit_shorts: explicit_shorts,
                    neutral_apps: combinedNeutralApps,
                },
            };
        } catch (error) {
            console.error("Server AI Detailed Analysis Error:", error);
            throw new HttpsError(
                "internal",
                "فشل التحليل البرمجي المشترك: " + error.message,
            );
        }
    },
);
