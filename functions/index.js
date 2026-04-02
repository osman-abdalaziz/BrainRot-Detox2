const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");

// admin.initializeApp();

// إذا لم تكن هذه الأسطر موجودة، أضفها في الأعلى
if (!admin.apps.length) {
    admin.initializeApp();
}

// استدعاء الموديل مع تمرير المفتاح السري من بيئة السيرفر الآمنة
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

exports.processDailyReflection = onDocumentCreated(
    {
        document: "users/{userId}/ai_reflections/{dateStr}",
        secrets: ["GEMINI_API_KEY"], // السماح للدالة باستخدام المفتاح السري
    },
    async (event) => {
        const snap = event.data;
        if (!snap) return;

        const data = snap.data();

        // 1. حاجز أمني لمنع الدخول في حلقة مفرغة
        if (data.status !== "processing") return null;

        try {
            // 2. التلقين الصارم والداعم
            const systemPrompt = `
            أنت "موجه الانضباط" في منصة (BrainRot Detox). دورك هو مساعدة المحاربين على التخلص من المشتتات وبناء عادات حقيقية بأسلوب "الحزم الداعم" (Tough Love).
            
            قواعد التحليل والرد:
            1. إذا نجح في التحدي: احتفل بإنجازه! أكد له أن التزامه اليوم هو انتصار يستحق الفخر، وشجعه للحفاظ على الزخم غداً.
            2. إذا فشل واختلق أعذاراً واهية: كن حازماً ومباشراً. ذكره بأن الأعذار لن تبني مستقبله. لا تهنه، بل أيقظه.
            3. إذا فشل لكنه كان صريحاً وتحمل المسؤولية: ادعمه بقوة. أخبره أن التعثر جزء من الرحلة، وطالبه بخطة تعويض.
            4. الأسلوب: احترافي، محفز، مباشر. لا تلقي التحية أبداً.
            5. الحد الأقصى للرد: 80 كلمة فقط.
            `;

            const model = genAI.getGenerativeModel({
                model: "gemini-2.5-flash",
                systemInstruction: systemPrompt,
            });

            // 3. دمج بيانات المستخدم لإرسالها
            const userState = data.passed
                ? "نجح في الوصول للهدف اليومي"
                : "فشل في الوصول للهدف اليومي";
            const promptText = `
            - النتيجة: ${userState}
            - إجمالي النقاط: ${data.points}
            - تقرير المحارب: "${data.userText}"
            `;

            // 4. الاتصال بـ Gemini
            const result = await model.generateContent(promptText);
            const aiResponseText = result.response.text();

            // 5. تحديث المستند في قاعدة البيانات بالرد النهائي
            return snap.ref.update({
                status: "completed",
                aiResponse: aiResponseText,
            });
        } catch (error) {
            console.error("Gemini AI Error:", error);
            // في حالة فشل الـ API، نضع رداً احتياطياً وننهي العملية
            const fallbackMessage = data.passed
                ? "عمل ممتاز اليوم! لقد حققت هدفك وهذا إنجاز حقيقي. (ملاحظة: الموجه غير متاح حالياً للتحليل التفصيلي، لكن إنجازك محفوظ. استمر!)"
                : "التعثر يحدث للجميع. المهم هو أن تنهض غداً بخطة أقوى. (ملاحظة: الموجه غير متاح حالياً، راجع أهدافك وانطلق من جديد).";

            return snap.ref.update({
                status: "completed",
                aiResponse: fallbackMessage,
            });
        }
    },
);

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
