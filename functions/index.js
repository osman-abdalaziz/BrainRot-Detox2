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
// 🚀 القاضي الآلي: تقييم الجمعة، وتصفير الدورة (V4 - محصنة بالكامل ومنظفة)
// ========================================================
exports.weeklyWipeAndEvaluate = onSchedule(
    {
        schedule: "1 0 * * 6", // الدقيقة 1، الساعة 0 (منتصف الليل)، كل يوم سبت
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
            now.setHours(now.getHours() - 2);
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

                // 🛑 تم تأمين جلب هذه المتغيرات
                let lifetimeScore = userData.lifetimeScore || 0;
                let hasDoubleXP = userData.hasDoubleXP || false;
                let currentMultiplier = userData.currentMultiplier || 1.0;

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

                        // الفحص القاطع للمهام الدينية الإجبارية (بالصيغة الجديدة + التوافق العكسي)
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

                            // 🛑 حساب وتحديث المضاعف
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
                                newStreak = 0;
                                if (newZone === "green") newZone = "yellow";
                                else if (newZone === "yellow") newZone = "red";

                                // 🛑 تصفير المضاعف عند الفشل
                                currentMultiplier = 1.0;

                                const penaltyCoins = Math.floor(
                                    targetPoints / 2,
                                );
                                walletCoins -= penaltyCoins;
                            }
                        }

                        // 🛑 استخدام السلة الديناميكية للحفظ
                        batch.set(
                            logRef,
                            {
                                date: dateStr,
                                isFinalized: true,
                                passed: passedToday,
                                pointsEarned: calcPoints,
                                selections: selections,
                                religiousSelections: religiousSelections,
                                timestamp: new Date().toISOString(),
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
                        badges.push({
                            id: `streak_${m}`,
                            title: `بطل صمود - ${m} أيام`,
                            imagePath: `images/badge.webp`,
                            date: new Date().toISOString(),
                            type: "streak",
                        });
                    }
                }

                // 🛑 إصلاح الخلل: دفع جميع المتغيرات للمصفوفة لكي لا يتم مسحها لاحقاً
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
                });
            }

            usersList.sort((a, b) => b.cycleScore - a.cycleScore);

            let rank = 1;
            for (let i = 0; i < usersList.length; i++) {
                let u = usersList[i];
                if (rank <= 3 && u.cycleScore > 0) {
                    u.badges.push({
                        id: `top${rank}_cycle_${currentCycle}`,
                        title: `TOP ${rank} للدورة رقم ${currentCycle}`,
                        imagePath: `images/rank-${rank}-bg.webp`,
                        date: new Date().toISOString(),
                        type: "cycle",
                    });
                    rank++;
                }

                const uRef = db.doc(`users/${u.uid}`);

                // 🛑 استخدام السلة الديناميكية للحفظ وتمرير المتغيرات بشكل صحيح
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
                    coreTasksCompletedToday: false,
                    lastEvalDate: u.lastEvalDate,
                });

                operationCount++;
                await commitBatchIfNeeded();
            }

            batch.update(sysRef, {
                currentCycle: currentCycle + 1,
                lastReset: new Date().toISOString(),
            });
            operationCount++;

            // 🛑 تفريغ أي عمليات متبقية في السلة الأخيرة
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
المستخدم معاقب، وللخروج من العقوبة يجب أن يرفع إثباتاً عبارة عن لقطة شاشة (Screenshot) توضح أن وقت استخدام الهاتف (Screen Time) اليوم أقل من ساعة، أو صورة واضحة تثبت تواجده في الجيم لأداء تمرين رياضي شاق.

قم بتحليل الصورة بدقة بناءً على هذه القواعد الصارمة التي لا تقبل الاستثناء:
1. دقق في الساعة الظاهرة في شريط إشعارات الهاتف (أعلى الشاشة). يجب أن يكون الوقت الظاهر ليلاً (حصراً بين الساعة 10:00 PM وحتى 04:00 AM). إذا كانت الساعة في الصورة تشير للنهار أو العصر (مثلاً 2:00 PM)، ارفضها فوراً لأنها صورة قديمة.
2. هل هي صورة حقيقية لـ Screen time يقل عن ساعة؟ أو تمرين رياضي؟
3. هل تبدو معدلة ببرامج، أو صورة عامة من الإنترنت، أو شاشة سوداء؟
4. لا تقبل الصور التي تحتوي على نصوص أو علامات مائية تشير إلى أنها من الإنترنت أو معدلة.

التعليمات الصارمة للإجابة:
- إذا كانت الصورة إثباتاً حقيقياً ومقنعاً والوقت فيها سليم، اكتب كلمة واحدة فقط: قبول
- إذا كانت الصورة احتيالية، قديمة، وقتها غير مطابق، أو لا علاقة لها بالمطلوب، اكتب: رفض: [اكتب سبب الرفض باختصار شديد]`;

            const result = await model.generateContent([prompt, ...imageParts]);
            const responseText = result.response.text().trim();

            // 5. اتخاذ القرار برمجياً
            if (responseText.startsWith("قبول")) {
                // فك القيود وتحديث قاعدة البيانات من الخادم (آمن 100%)
                const imageUrl = request.data.imageUrl || ""; // نستقبل الرابط الجاهز من العميل
                await admin.firestore().collection("users").doc(uid).update({
                    currentZone: "green",
                    currentStreak: 0,
                    lastUnchainingProof: imageUrl,
                    unchainingTimestamp: new Date().toISOString(),
                });
                return { success: true, message: "تمت الموافقة" };
            } else {
                // الرفض وإرسال السبب للمستخدم
                const reason = responseText.replace("رفض:", "").trim();
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

            // 3. التلقين الصارم للذكاء الاصطناعي (Strict Prompt)
            const prompt = `
أنت قاضي ذكاء اصطناعي صارم جداً في منصة "BrainRot Detox".
يجب عليك تحليل الصورة المرفقة (والتي قد تكون مدمجة لعدة لقطات شاشة من أجهزة المستخدم) لتحديد "وقت الشاشة المهدر" بدقة.

معلومات أدخلها المستخدم:
- إجمالي وقت الشاشة المبلغ عنه: ${totalScreenMinutes} دقيقة.
- وقت Shorts/Reels/TikTok: ${totalShortsMinutes} دقيقة.
- التبرير المقدم: "${justification}"

القواعد العسكرية للتقييم:
1. تحقق أن الصور المرفقة هي بالفعل لقطات شاشة توضح وقت الاستهلاك (Screen Time / Digital Wellbeing / Battery Usage).
2. إذا كانت الصورة لا علاقة لها بوقت الشاشة (صورة سوداء، حائط، سيلفي، احتيال)، قم بمعاقبته فوراً بجعل "الوقت المهدر" 999 دقيقة.
3. اقرأ التبرير بتمعن. إذا كان منطقياً ويشرح استهلاكاً دراسياً أو عملاً (مثل تطبيقات إنتاجية، Zoom، منصات تعليمية)، اطرح هذا الوقت من الإجمالي لتصل إلى "الوقت المهدر الفعلي".
4. السوشيال ميديا، الألعاب، والشورتس (TikTok/Reels/Shorts) تعتبر ترفيه وضياع وقت (مهدر كلياً)، ولا يقبل تبريرها تحت أي ظرف دراسي.

الرد المطلوب:
يجب أن يكون ردك عبارة عن كائن JSON فقط، بدون أي نصوص تمهيدية وبدون علامات Markdown، مطابق لهذا الهيكل بالضبط:
{
  "wastedScreenMinutes": [الرقم الصافي للوقت المهدر],
  "wastedShortsMinutes": [الرقم الصافي لشورتس المهدر]
}
`;
            // 4. استخراج الحكم
            // const result = await model.generateContent([prompt, imagePart]);
            // let text = result.response.text().trim();

            // // تنظيف الـ JSON لضمان عدم انهيار الكود
            // if (text.startsWith("\`\`\`json"))
            //     text = text.replace(/\`\`\`json/g, "");
            // if (text.startsWith("\`\`\`")) text = text.replace(/\`\`\`/g, "");
            // text = text.trim();

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
