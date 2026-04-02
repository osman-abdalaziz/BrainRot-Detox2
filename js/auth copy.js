import { auth, db } from "./firebase-config.js";
import {
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import {
    doc,
    getDoc,
    setDoc,
    updateDoc,
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

// ==============================
// 1. نظام منع الدخول للمسجلين مسبقاً
// ==============================
onAuthStateChanged(auth, async (user) => {
    if (user) {
        // إخفاء الفورم فوراً لمنع الوميض المزعج قبل التوجيه
        document.querySelector(".auth-container").style.display = "none";

        try {
            const userDoc = await getDoc(doc(db, "users", user.uid));
            if (userDoc.exists() && userDoc.data().role === "admin") {
                window.location.replace("admin.html");
            } else {
                window.location.replace("dashboard.html");
            }
        } catch (error) {
            console.error("Error redirecting:", error);
        }
    }
});

// ==============================
// 2. نظام الإشعارات الاحترافي (Toast) بديل الـ alert المزعج
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

    // إزالة الإشعار من الـ DOM بعد انتهاء الأنيميشن (5 ثواني)
    setTimeout(() => toast.remove(), 5000);
}

// ==============================
// 3. التبديل بين الشاشات والتحقق
// ==============================
const loginForm = document.getElementById("login-form");
const registerForm = document.getElementById("register-form");

document.getElementById("show-register").addEventListener("click", () => {
    loginForm.style.display = "none";
    registerForm.style.display = "block";
});

document.getElementById("show-login").addEventListener("click", () => {
    registerForm.style.display = "none";
    loginForm.style.display = "block";
});

// دالة التحقق من صحة الإيميل
function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ==============================
// 4. نظام إنشاء الحساب مع التحقق القوي (Validation)
// ==============================
document.getElementById("register-btn").addEventListener("click", async (e) => {
    e.preventDefault();

    const name = document.getElementById("reg-name").value.trim();
    const email = document.getElementById("reg-email").value.trim();
    const password = document.getElementById("reg-password").value;
    const inviteCode = document.getElementById("reg-invite-code").value.trim();

    // التحقق من الحقول الفارغة
    if (!name || !email || !password || !inviteCode) {
        showToast("جميع الحقول مطلوبة، لا تترك شيئاً فارغاً.", "error");
        return;
    }

    // التحقق من صيغة الإيميل
    if (!isValidEmail(email)) {
        showToast("صيغة البريد الإلكتروني غير صحيحة.", "error");
        return;
    }

    // التحقق من قوة كلمة المرور
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

    try {
        const codeRef = doc(db, "inviteCodes", inviteCode);
        const codeSnap = await getDoc(codeRef);

        if (!codeSnap.exists() || codeSnap.data().used) {
            showToast("كود التفعيل غير صحيح أو تم استخدامه مسبقاً.", "error");
            btn.innerText = originalText;
            btn.disabled = false;
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
            points: 0,
            status: "active",
            createdAt: new Date(),
        });

        await updateDoc(codeRef, {
            used: true,
            usedBy: user.uid,
        });

        showToast("تم إنشاء الحساب بنجاح! أهلاً بك يا محارب.", "success");
        // التوجيه سيعمل تلقائياً من خلال onAuthStateChanged في الأعلى
    } catch (error) {
        console.error("Error:", error);
        // معالجة أخطاء فايربيز الشائعة لتعريبها
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
// 5. نظام تسجيل الدخول مع التحقق
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

    try {
        await signInWithEmailAndPassword(auth, email, password);
        showToast("تم تسجيل الدخول بنجاح!", "success");
        // التوجيه سيعمل تلقائياً من خلال onAuthStateChanged
    } catch (error) {
        console.error("Login Error:", error);
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
            this.classList.add("fa-eye-slash"); // أيقونة عين مشطوبة
            this.style.color = "var(--gold-primary)"; // إضاءة الأيقونة للدلالة على الإظهار
        } else {
            input.type = "password";
            this.classList.remove("fa-eye-slash");
            this.classList.add("fa-eye"); // أيقونة عين عادية
            this.style.color = "var(--text-muted)";
        }
    });
});
