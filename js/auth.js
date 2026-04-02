import { auth, db } from "./firebase-config.js";
import {
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    onAuthStateChanged,
    sendPasswordResetEmail,
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import {
    doc,
    getDoc,
    setDoc,
    updateDoc,
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

// ==============================
// 0. قفل الأمان لمنع التوجيه المبكر (Race Condition Fix)
// ==============================
let isAuthenticating = false;

// ==============================
// 1. نظام منع الدخول للمسجلين مسبقاً
// ==============================
onAuthStateChanged(auth, async (user) => {
    // لن يعمل التوجيه التلقائي إذا كان المستخدم في منتصف عملية إنشاء الحساب أو الدخول
    if (user && !isAuthenticating) {
        document.querySelector(".auth-container").style.display = "none";

        try {
            const userDoc = await getDoc(doc(db, "users", user.uid));
            if (userDoc.exists() && userDoc.data().role === "admin") {
                window.location.replace("dashboard.html");
            } else {
                window.location.replace("dashboard.html");
            }
        } catch (error) {
            console.error("Error redirecting:", error);
        }
    }
});

// ==============================
// 2. نظام الإشعارات الاحترافي (Toast)
// ==============================
function showToast(message, type = "error") {
    let container = document.getElementById("toast-container");
    if (!container) {
        container = document.createElement("div");
        container.id = "toast-container";
        document.body.appendChild(container);
    }

    const toast = document.createElement("div");
    toast.className = `custom-toast ${type}`;
    const icon = type === "error" ? "⚠️" : "✅";
    toast.innerHTML = `<span style="font-size: 1.2rem;">${icon}</span> <span>${message}</span>`;

    container.appendChild(toast);

    setTimeout(() => toast.remove(), 5000);
}

// ==============================
// 3. التبديل بين الشاشات والتحقق
// ==============================
const loginForm = document.getElementById("login-form");
const registerForm = document.getElementById("register-form");
const resetForm = document.getElementById("reset-password-form");

document.getElementById("show-register").addEventListener("click", () => {
    loginForm.style.display = "none";
    resetForm.style.display = "none";
    registerForm.style.display = "block";
});

document.getElementById("show-login").addEventListener("click", () => {
    registerForm.style.display = "none";
    resetForm.style.display = "none";
    loginForm.style.display = "block";
});

document
    .getElementById("forgot-password-link")
    .addEventListener("click", (e) => {
        e.preventDefault();
        loginForm.style.display = "none";
        registerForm.style.display = "none";
        resetForm.style.display = "block";
    });

document.getElementById("back-to-login").addEventListener("click", () => {
    resetForm.style.display = "none";
    loginForm.style.display = "block";
});

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ==============================
// 4. نظام إنشاء الحساب (مصحح)
// ==============================
document.getElementById("register-btn").addEventListener("click", async (e) => {
    e.preventDefault();

    const name = document.getElementById("reg-name").value.trim();
    const email = document.getElementById("reg-email").value.trim();
    const password = document.getElementById("reg-password").value;
    const inviteCode = document.getElementById("reg-invite-code").value.trim();

    if (!name || !email || !password || !inviteCode) {
        showToast("جميع الحقول مطلوبة، لا تترك شيئاً فارغاً.", "error");
        return;
    }

    if (!isValidEmail(email)) {
        showToast("صيغة البريد الإلكتروني غير صحيحة.", "error");
        return;
    }

    if (password.length < 6) {
        showToast(
            "كلمة المرور ضعيفة! يجب أن تتكون من 6 أحرف أو أرقام على الأقل.",
            "error",
        );
        return;
    }

    const btn = document.getElementById("register-btn");
    const originalText = btn.innerText;
    btn.innerText = "جاري الإنشاء... ⏳";
    btn.disabled = true;

    // تفعيل القفل لمنع المتصفح من الهرب أثناء حفظ الداتا
    isAuthenticating = true;

    try {
        const codeRef = doc(db, "inviteCodes", inviteCode);
        const codeSnap = await getDoc(codeRef);

        if (!codeSnap.exists() || codeSnap.data().used) {
            showToast("كود التفعيل غير صحيح أو تم استخدامه مسبقاً.", "error");
            btn.innerText = originalText;
            btn.disabled = false;
            isAuthenticating = false; // فك القفل
            return;
        }

        const userCredential = await createUserWithEmailAndPassword(
            auth,
            email,
            password,
        );
        const user = userCredential.user;

        await setDoc(doc(db, "users", user.uid), {
            name: name,
            email: email,
            role: "user",
            status: "active",
            // --- النظام الجديد: الأعمدة الأربعة ---
            currentXP: 0, // نقاط التحدي الحالي (تُصفر مع كل تحدي)
            currentStreak: 0, // الستريك الحالي (يُصفر مع كل تحدي)
            walletCoins: 0, // العملات الشرائية (تراكمية)
            lifetimeScore: 0, // مستوى الشرف (تراكمي)
            // ------------------------------------
            createdAt: new Date(),
        });

        await updateDoc(codeRef, {
            used: true,
            usedBy: user.uid,
        });

        showToast("تم إنشاء الحساب بنجاح! أهلاً بك يا محارب.", "success");

        // التوجيه اليدوي بعد اكتمال جميع العمليات بأمان
        setTimeout(() => {
            window.location.replace("dashboard.html");
        }, 1000);
    } catch (error) {
        console.error("Error:", error);
        isAuthenticating = false; // فك القفل في حالة الخطأ

        let errorMsg = "حدث خطأ غير متوقع.";
        if (error.code === "auth/email-already-in-use")
            errorMsg = "هذا البريد الإلكتروني مسجل مسبقاً.";
        else if (error.code === "auth/network-request-failed")
            errorMsg = "تأكد من اتصالك بالإنترنت.";

        showToast(errorMsg, "error");
        btn.innerText = originalText;
        btn.disabled = false;
    }
});

// ==============================
// 5. نظام تسجيل الدخول (مصحح)
// ==============================
document.getElementById("login-btn").addEventListener("click", async (e) => {
    e.preventDefault();

    const email = document.getElementById("login-email").value.trim();
    const password = document.getElementById("login-password").value;

    if (!email || !password) {
        showToast("يرجى إدخال البريد الإلكتروني وكلمة المرور.", "error");
        return;
    }

    if (!isValidEmail(email)) {
        showToast("صيغة البريد الإلكتروني غير صحيحة.", "error");
        return;
    }

    const btn = document.getElementById("login-btn");
    const originalText = btn.innerText;
    btn.innerText = "جاري الدخول... ⏳";
    btn.disabled = true;

    // تفعيل القفل
    isAuthenticating = true;

    try {
        await signInWithEmailAndPassword(auth, email, password);
        showToast("تم تسجيل الدخول بنجاح!", "success");

        // جلب بيانات المستخدم وتوجيهه يدوياً
        const user = auth.currentUser;
        const userDoc = await getDoc(doc(db, "users", user.uid));

        setTimeout(() => {
            if (userDoc.exists() && userDoc.data().role === "admin") {
                window.location.replace("dashboard.html");
            } else {
                window.location.replace("dashboard.html");
            }
        }, 1000);
    } catch (error) {
        console.error("Login Error:", error);
        isAuthenticating = false; // فك القفل في حالة الخطأ
        showToast(
            "بيانات الدخول غير صحيحة. تأكد من الإيميل وكلمة المرور.",
            "error",
        );
        btn.innerText = originalText;
        btn.disabled = false;
    }
});

// ==============================
// 6. إظهار/إخفاء كلمة المرور (أيقونة العين)
// ==============================
document.querySelectorAll(".toggle-password").forEach((icon) => {
    icon.addEventListener("click", function () {
        const targetId = this.getAttribute("data-target");
        const input = document.getElementById(targetId);

        if (input.type === "password") {
            input.type = "text";
            this.classList.remove("fa-eye");
            this.classList.add("fa-eye-slash");
            this.style.color = "var(--gold-primary)";
        } else {
            input.type = "password";
            this.classList.remove("fa-eye-slash");
            this.classList.add("fa-eye");
            this.style.color = "var(--text-muted)";
        }
    });
});

// ==============================
// 7. نظام استعادة كلمة المرور
// ==============================
document.getElementById("reset-btn").addEventListener("click", async (e) => {
    e.preventDefault();
    const email = document.getElementById("reset-email").value.trim();

    if (!isValidEmail(email)) {
        showToast("الرجاء إدخال بريد إلكتروني صحيح.", "error");
        return;
    }

    const btn = document.getElementById("reset-btn");
    const originalText = btn.innerText;
    btn.innerText = "جاري الإرسال... ⏳";
    btn.disabled = true;

    try {
        await sendPasswordResetEmail(auth, email);
        showToast(
            "تم إرسال رابط الاستعادة! تفقد بريدك الوارد (أو الـ Spam).",
            "success",
        );
        setTimeout(() => {
            document.getElementById("back-to-login").click();
            btn.innerText = originalText;
            btn.disabled = false;
        }, 3000);
    } catch (error) {
        console.error("Reset Error:", error);
        showToast("حدث خطأ. تأكد من أن هذا البريد مسجل لدينا.", "error");
        btn.innerText = originalText;
        btn.disabled = false;
    }
});
