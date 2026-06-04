import { auth, db, storage, app, messaging } from "./firebase-config.js"; // أضفنا app هنا
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
    setDoc,
    collection,
    addDoc,
    getDocs,
    deleteDoc,
    updateDoc,
    arrayUnion,
    query,
    orderBy,
    writeBatch,
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import {
    ref,
    uploadBytes,
    getDownloadURL,
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js";
import {
    getFunctions,
    httpsCallable,
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-functions.js";
const functions = getFunctions(app);
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

let selectedBadgeFile = null;
let editingTaskId = null; // متغير عام لحفظ ID المهمة الجاري تعديلها

onAuthStateChanged(auth, async (user) => {
    if (user) {
        const userDoc = await getDoc(doc(db, "users", user.uid));
        if (!userDoc.exists() || userDoc.data().role !== "admin") {
            window.location.href = "dashboard.html";
        } else {
            loadCodes();
            populateCategoryFilter(); // <--- أضف هذا السطر لملء فلتر الأقسام عند تحميل الصفحة
            loadTasks();
            loadCurrentChallenge();
            loadUsers();
            loadRedeemCodes(); // <--- أضف هذا السطر
            loadReligiousTasks(); // <--- أضف هذا السطر هنا
        }
    } else {
        window.location.href = "index.html";
    }
});

document.getElementById("logout-btn").addEventListener("click", () => {
    signOut(auth).then(() => (window.location.replace = "index.html"));
});

// ==============================
// إدارة الأكواد
// ==============================
async function loadCodes() {
    const tbody = document.getElementById("codes-table-body");
    tbody.innerHTML = "";
    const snap = await getDocs(collection(db, "inviteCodes"));
    snap.forEach((docSnap) => {
        const data = docSnap.data();
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td style="font-weight: bold; color: var(--gold-primary);">${docSnap.id}</td>
            <td><span class="badge ${data.used ? "badge-inactive" : "badge-active"}">${data.used ? "مستخدم" : "متاح"}</span></td>
            <td>${data.usedBy || "---"}</td>
            <td><button class="action-btn btn-delete" onclick="deleteCode('${docSnap.id}')">حذف</button></td>
        `;
        tbody.appendChild(tr);
    });
}

document
    .getElementById("generate-code-btn")
    .addEventListener("click", async () => {
        const code = document.getElementById("new-code-input").value.trim();
        if (!code) return await CustomDialog.alert("أدخل الكود أولاً.");
        await setDoc(doc(db, "inviteCodes", code), {
            used: false,
            createdAt: new Date(),
        });
        document.getElementById("new-code-input").value = "";
        loadCodes();
    });

window.deleteCode = async (codeId) => {
    if (
        await CustomDialog.confirm(
            "هل أنت متأكد من حذف هذا الكود؟",
            "حذف كود تفعيل",
        )
    ) {
        await deleteDoc(doc(db, "inviteCodes", codeId));
        loadCodes();
    }
};

// ==============================
// إدارة المهام (شاملة نظام التعديل الجديد)
// ==============================

async function loadTasks() {
    const tbody = document.getElementById("tasks-table-body");
    tbody.innerHTML =
        "<tr><td colspan='4' style='text-align:center;'>جاري التحميل... ⏳</td></tr>";

    const q = query(collection(db, "tasks"), orderBy("order", "asc"));
    const snap = await getDocs(q);

    tbody.innerHTML = "";

    // سحب قيمة الفلتر الحالي
    const filterElement = document.getElementById("task-category-filter");
    const selectedCategory = filterElement ? filterElement.value : "all";

    snap.forEach((docSnap) => {
        const data = docSnap.data();

        // تطبيق الفلتر: تخطي المهمة إذا لم تكن تطابق القسم المختار
        if (selectedCategory !== "all" && data.category !== selectedCategory) {
            return;
        }

        let optionsHtml =
            '<ul style="list-style: none; padding: 0; margin: 0; font-size: 13px;">';
        if (data.options && data.options.length > 0) {
            data.options.forEach((opt) => {
                optionsHtml += `<li style="margin-bottom: 5px;">- ${opt.name}: <span class="gold-text" style="font-weight:bold;">${opt.points}</span> نقطة</li>`;
            });
        } else {
            optionsHtml += `<li>مهمة قديمة: <span class="gold-text" style="font-weight:bold;">${data.points || 0}</span> نقطة</li>`;
        }
        optionsHtml += "</ul>";

        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td style="font-weight: bold;">${data.name}</td>
            <td>${optionsHtml}</td>
            <td><span class="badge ${data.isActive ? "badge-active" : "badge-inactive"}">${data.isActive ? "نشط" : "معطل"}</span></td>
            <td>
                <div style="display: flex; gap: 5px; flex-wrap: wrap;">
                    <button class="action-btn btn-edit" style="background: #f59e0b; border: none;" onclick="editTask('${docSnap.id}')">تعديل ✏️</button>
                    <button class="action-btn btn-edit" onclick="toggleTaskStatus('${docSnap.id}', ${data.isActive})">${data.isActive ? "تعطيل ⏸️" : "تفعيل ▶️"}</button>
                    <button class="action-btn btn-delete" onclick="deleteTask('${docSnap.id}')">حذف ❌</button>
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

document.getElementById("add-option-row-btn").addEventListener("click", () => {
    const container = document.getElementById("options-container");
    const row = document.createElement("div");
    row.className = "option-row";
    row.style.cssText = "display: flex; gap: 10px; margin-bottom: 10px;";
    row.innerHTML = `
        <input type="text" class="opt-name" placeholder="اسم الخيار إضافي" style="margin: 0; flex-grow: 2;">
        <input type="number" class="opt-points" placeholder="النقاط" style="margin: 0; flex-grow: 1;">
        <button class="remove-opt-btn" style="background: var(--danger); color: white; border: none; padding: 0 15px; border-radius: 8px; cursor: pointer;">X</button>
    `;
    container.appendChild(row);
    row.querySelector(".remove-opt-btn").addEventListener("click", () =>
        row.remove(),
    );
});

// دالة تفعيل وضع التعديل (تسحب البيانات للفورم)
window.editTask = async (taskId) => {
    try {
        const taskDoc = await getDoc(doc(db, "tasks", taskId));
        if (taskDoc.exists()) {
            const taskData = taskDoc.data();
            editingTaskId = taskId; // تفعيل وضع التعديل برمجياً

            // تعبئة الاسم الأساسي
            document.getElementById("task-name").value = taskData.name;

            document.getElementById("task-order").value =
                taskData.order !== undefined ? taskData.order : "";

            document.getElementById("task-category").value =
                taskData.category || "مهام عامة";
            // جلب حالة الاختيار المتعدد
            document.getElementById("task-is-multi").checked =
                taskData.isMultiSelect || false;

            // تفريغ الحاوية وبناء الخيارات
            const container = document.getElementById("options-container");
            container.innerHTML = "";

            taskData.options.forEach((opt, index) => {
                // // تخطي خيار الصفر التلقائي (لم أقم بها) لكي لا يظهر في الفورم
                // if (
                //     index === 0 &&
                //     opt.points === 0 &&
                //     opt.name.includes("لم أقم بها")
                // )
                //     return;

                const row = document.createElement("div");
                row.className = "option-row";
                row.style.cssText =
                    "display: flex; gap: 10px; margin-bottom: 10px;";
                row.innerHTML = `
                    <input type="text" class="opt-name" placeholder="اسم الخيار إضافي" value="${opt.name}" style="margin: 0; flex-grow: 2;">
                    <input type="number" class="opt-points" placeholder="النقاط" value="${opt.points}" style="margin: 0; flex-grow: 1;">
                    <button class="remove-opt-btn" style="background: var(--danger); color: white; border: none; padding: 0 15px; border-radius: 8px; cursor: pointer;">X</button>
                `;
                container.appendChild(row);
                row.querySelector(".remove-opt-btn").addEventListener(
                    "click",
                    () => row.remove(),
                );
            });

            if (container.children.length === 0) {
                document.getElementById("add-option-row-btn").click();
            }

            // تغيير شكل زر الحفظ ليدل على التعديل
            const btn = document.getElementById("add-task-btn");
            btn.innerText = "تحديث المهمة ✏️";
            btn.style.background = "#f59e0b"; // برتقالي

            // إظهار زر الإلغاء
            let cancelBtn = document.getElementById("cancel-edit-btn");
            if (!cancelBtn) {
                cancelBtn = document.createElement("button");
                cancelBtn.id = "cancel-edit-btn";
                cancelBtn.innerText = "إلغاء ❌";
                cancelBtn.style.cssText =
                    "background: transparent; color: var(--danger); border: 1px solid var(--danger); padding: 12px 20px; border-radius: 8px; cursor: pointer; flex-grow: 0;";
                cancelBtn.onclick = cancelEditMode;
                btn.parentNode.appendChild(cancelBtn);
            }
            cancelBtn.style.display = "block";

            // التمرير السلس لأعلى الصفحة
            document
                .getElementById("tasks-page")
                .scrollIntoView({ behavior: "smooth" });
        }
    } catch (error) {
        await CustomDialog.alert("حدث خطأ أثناء جلب بيانات المهمة.");
    }
};

// دالة الخروج من وضع التعديل وتصفير الفورم
function cancelEditMode() {
    editingTaskId = null;
    document.getElementById("task-name").value = "";
    document.getElementById("task-order").value = "";
    document.getElementById("task-category").value = "";
    document.getElementById("task-is-multi").checked = false;
    document.getElementById("options-container").innerHTML = `
        <div class="option-row" style="display: flex; gap: 10px; margin-bottom: 10px;">
            <input type="text" class="opt-name" placeholder="اسم الخيار (مثال: في المسجد)" style="margin: 0; flex-grow: 2;">
            <input type="number" class="opt-points" placeholder="النقاط (مثال: 20)" style="margin: 0; flex-grow: 1;">
        </div>
    `;
    const btn = document.getElementById("add-task-btn");
    btn.innerText = "حفظ المهمة بالكامل";
    btn.style.background = ""; // إعادة لونه الأصلي (css gradient)

    const cancelBtn = document.getElementById("cancel-edit-btn");
    if (cancelBtn) cancelBtn.style.display = "none";
}

document.getElementById("add-task-btn").addEventListener("click", async () => {
    const name = document.getElementById("task-name").value.trim();
    const categoryInput = document.getElementById("task-category").value.trim();
    const taskCategory = categoryInput === "" ? "مهام عامة" : categoryInput;
    const isMultiSelect = document.getElementById("task-is-multi").checked; // <--- اسحب قيمة الزر الخاص بالاختيار المتعدد
    if (!name)
        return await CustomDialog.alert("يرجى إدخال اسم المهمة الأساسي.");

    const optionRows = document.querySelectorAll(".option-row");
    const options = [];
    let hasError = false;

    optionRows.forEach((row) => {
        const optName = row.querySelector(".opt-name").value.trim();
        const optPoints = parseInt(row.querySelector(".opt-points").value);
        if (optName && !isNaN(optPoints))
            options.push({
                name: optName,
                points: optPoints,
            });
        else if (optName || !isNaN(optPoints)) hasError = true;
    });

    if (hasError)
        return await CustomDialog.alert("يرجى تعبئة بيانات الخيارات بالكامل.");
    if (options.length === 0)
        return await CustomDialog.alert(
            "يجب إضافة خيار واحد على الأقل للمهمة.",
        );

    const btn = document.getElementById("add-task-btn");
    btn.innerText = "جاري الحفظ... ⏳";
    btn.disabled = true;

    const orderInput = document.getElementById("task-order").value;
    const taskOrder = orderInput === "" ? 99 : parseInt(orderInput);
    try {
        if (editingTaskId) {
            // تحديث مهمة موجودة
            await updateDoc(doc(db, "tasks", editingTaskId), {
                name: name,
                order: taskOrder,
                options: options,
                category: taskCategory,
                isMultiSelect: isMultiSelect, // <--- إضافتها هنا
            });
            await CustomDialog.alert("تم تحديث المهمة بنجاح!", "نجاح ✅");
        } else {
            // إضافة مهمة جديدة (الكود القديم)
            await addDoc(collection(db, "tasks"), {
                name: name,
                order: taskOrder,
                options: options,
                category: taskCategory,
                isMultiSelect: isMultiSelect, // <--- إضافتها هنا
                isActive: true,
                createdAt: new Date(),
            });
            await CustomDialog.alert("تمت إضافة المهمة بنجاح!", "نجاح ✅");
        }

        cancelEditMode(); // تصفير الفورم بعد النجاح
        await populateCategoryFilter(); // تحديث فلتر الأقسام بعد إضافة/تعديل مهمة جديدة
        loadTasks(); // تحديث الجدول
    } catch (error) {
        await CustomDialog.alert("حدث خطأ أثناء حفظ المهمة.");
    } finally {
        btn.disabled = false;
        if (editingTaskId) {
            btn.innerText = "تحديث المهمة ✏️";
        } else {
            btn.innerText = "حفظ المهمة بالكامل";
        }
    }
});

window.deleteTask = async (taskId) => {
    if (
        await CustomDialog.confirm(
            "هل أنت متأكد من حذف هذه المهمة؟",
            "حذف مهمة",
        )
    ) {
        await deleteDoc(doc(db, "tasks", taskId));
        loadTasks();
    }
};

window.toggleTaskStatus = async (taskId, currentStatus) => {
    await updateDoc(doc(db, "tasks", taskId), { isActive: !currentStatus });
    loadTasks();
};

// ==============================
// إدارة التحديات
// ==============================
document
    .getElementById("trigger-badge-upload")
    .addEventListener("click", () =>
        document.getElementById("challenge-badge-upload").click(),
    );

document
    .getElementById("challenge-badge-upload")
    .addEventListener("change", async (e) => {
        selectedBadgeFile = e.target.files[0];
        if (selectedBadgeFile && selectedBadgeFile.type === "image/png") {
            const reader = new FileReader();
            reader.onload = (event) =>
                (document.getElementById("badge-preview").src =
                    event.target.result);
            reader.readAsDataURL(selectedBadgeFile);
        } else {
            await CustomDialog.alert("يرجى اختيار ملف صورة PNG مفرغة.");
            selectedBadgeFile = null;
            document.getElementById("badge-preview").src =
                "https://via.placeholder.com/40";
        }
    });

async function loadCurrentChallenge() {
    const tbody = document.getElementById("challenge-table-body");
    tbody.innerHTML = "";
    const docSnap = await getDoc(doc(db, "settings", "currentChallenge"));

    if (docSnap.exists() && docSnap.data().isActive) {
        const data = docSnap.data();
        const endDate = data.endDate.toDate().toLocaleDateString("en-CA");
        let statusBadge = "";
        let actionBtn = "";
        if (data.status === "registration") {
            statusBadge = `<span class="badge" style="background: #eab308; color: #000;">مرحلة التسجيل مفتوحة</span>`;
            actionBtn = `<button class="action-btn" style="background: var(--success);" onclick="activateChallenge()">بدء التحدي الآن</button>`;
        } else if (data.status === "active") {
            statusBadge = `<span class="badge badge-active">نشط وجاري</span>`;
            actionBtn = `<button class="action-btn btn-delete" onclick="endChallengeAndAwardBadges()">إنهاء وتوزيع الأوسمة</button>`;
        }

        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td style="color: var(--gold-primary); font-weight: bold;">${data.title}</td><td>${data.dailyTargetPoints}</td><td>${endDate}</td><td>${statusBadge}</td>
            <td>${actionBtn} ${data.status === "registration" ? `<button class="action-btn btn-delete" onclick="endChallengeAndAwardBadges(true)">إلغاء</button>` : ""}</td>
        `;
        tbody.appendChild(tr);
    } else {
        tbody.innerHTML =
            '<tr><td colspan="5" style="text-align: center;">لا يوجد تحدي حالياً. أطلق تحدياً جديداً ليبدأ يوم التسجيل.</td></tr>';
    }
}

document
    .getElementById("start-challenge-btn")
    .addEventListener("click", async () => {
        const title = document.getElementById("challenge-title").value.trim();
        const days = parseInt(document.getElementById("challenge-days").value);
        const dailyTarget = parseInt(
            document.getElementById("challenge-daily-target").value,
        );
        if (!title || isNaN(days) || isNaN(dailyTarget))
            return await CustomDialog.alert("أدخل بيانات التحدي.");

        const btn = document.getElementById("start-challenge-btn");
        btn.innerText = "جاري الإطلاق... ⏳";
        btn.disabled = true;
        try {
            let badgeImageUrl = null;
            const challengeId = Date.now().toString();
            if (selectedBadgeFile) {
                const badgeRef = ref(storage, `badges/${challengeId}.png`);
                await uploadBytes(badgeRef, selectedBadgeFile);
                badgeImageUrl = await getDownloadURL(badgeRef);
            } else {
                badgeImageUrl = "https://via.placeholder.com/100?text=Badge";
            }

            const startDate = new Date();
            const endDate = new Date(startDate);
            endDate.setDate(startDate.getDate() + days);
            // 1. جلب كل المستخدمين من قاعدة البيانات
            const usersSnap = await getDocs(collection(db, "users"));

            // 2. إنشاء مصفوفة بوعود التحديث لتصفير الستريك للجميع (Batch Update)
            const resetPromises = usersSnap.docs.map((uDoc) =>
                updateDoc(doc(db, "users", uDoc.id), {
                    currentStreak: 0,
                    currentXP: 0,
                    hasDoubleXP: false,
                    usedDoubleXP: false,
                }),
            );

            // 3. تنفيذ التصفير للكل قبل الانتقال للخطوة التالية
            await Promise.all(resetPromises);
            console.log("تم تصفير الستريك لجميع المستخدمين.");

            await setDoc(doc(db, "settings", "currentChallenge"), {
                challengeId,
                title,
                badgeImageUrl,
                durationDays: days,
                dailyTargetPoints: dailyTarget,
                startDate,
                endDate,
                status: "registration",
                isActive: true,
                createdAt: new Date(),
            });

            document.getElementById("challenge-title").value = "";
            document.getElementById("challenge-days").value = "";
            document.getElementById("challenge-daily-target").value = "";
            selectedBadgeFile = null;
            document.getElementById("badge-preview").src =
                "https://via.placeholder.com/40";
            loadCurrentChallenge();
            await CustomDialog.alert(
                "تم إطلاق التحدي بنجاح ورفع صورة الوسام المصممة!",
                "عملية ناجحة ✅",
            );
        } catch (error) {
            await CustomDialog.alert("حدث خطأ أثناء إطلاق التحدي.");
        } finally {
            btn.innerText = "إطلاق التحدي";
            btn.disabled = false;
        }
    });

window.activateChallenge = async () => {
    if (
        await CustomDialog.confirm(
            "هل أنت متأكد من إغلاق التسجيل وبدء التحدي الآن للمنضمين؟",
            "انطلاق التحدي 🚀",
        )
    ) {
        await updateDoc(doc(db, "settings", "currentChallenge"), {
            status: "active",
        });
        loadCurrentChallenge();
    }
};

window.endChallengeAndAwardBadges = async (isCancel = false) => {
    const msg = isCancel
        ? "هل أنت متأكد من إلغاء هذا التحدي؟"
        : "هل أنت متأكد من إنهاء التحدي؟ سيتم توزيع الوسام على الصامدين وإعداد الجميع للتحدي القادم.";
    if (await CustomDialog.confirm(msg, "إنهاء التحدي 🏆")) {
        const challengeSnap = await getDoc(
            doc(db, "settings", "currentChallenge"),
        );
        if (challengeSnap.exists() && !isCancel) {
            const data = challengeSnap.data();
            const badgeUrl =
                data.badgeImageUrl ||
                "https://via.placeholder.com/100?text=Badge";
            const usersSnap = await getDocs(collection(db, "users"));
            const updatePromises = [];
            usersSnap.forEach((userDoc) => {
                const ud = userDoc.data();
                if (ud.joinedChallengeId === data.challengeId) {
                    let upData = {
                        joinedChallengeId: null,
                        challengeStatus: "active",
                    };
                    if (ud.challengeStatus !== "failed")
                        upData.badges = arrayUnion({
                            title: data.title,
                            date: new Date().toLocaleDateString("en-CA"),
                            icon: badgeUrl,
                        });
                    updatePromises.push(updateDoc(userDoc.ref, upData));
                }
            });
            await Promise.all(updatePromises);
            await CustomDialog.alert(
                "تم توزيع الأوسمة المصممة على الصامدين، وتم تصفير الحالات لانتظار التحدي القادم!",
                "توزيع الأوسمة 🎉",
            );
        }
        await updateDoc(doc(db, "settings", "currentChallenge"), {
            isActive: false,
            status: "ended",
        });
        loadCurrentChallenge();
    }
};

// ==============================
// إدارة الأعضاء
// ==============================
async function loadUsers() {
    const tbody = document.getElementById("users-table-body");
    tbody.innerHTML = "";
    const snap = await getDocs(collection(db, "users"));
    snap.forEach((docSnap) => {
        const data = docSnap.data();
        // if (data.role === "admin") return;
        const statusBadge =
            data.challengeStatus === "failed"
                ? `<span class="badge badge-inactive">تم إقصاؤه</span>`
                : `<span class="badge badge-active">نشط</span>`;
        const challengeStatus = data.joinedChallengeId
            ? '<span style="color:var(--success);">مسجل</span>'
            : '<span style="color:var(--text-muted);">غير مسجل</span>';

        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td style="font-weight: bold; line-height: 1.4;">${data.name} <br><span style="font-size: 11px; color: var(--text-muted); font-weight: normal;">${data.email}</span></td>
            <td class="gold-text" style="font-weight:bold; font-size: 18px;">${data.points || 0}</td><td>${statusBadge}</td><td>${challengeStatus}</td>
            <td>
                <div style="display: flex; gap: 5px; justify-content: flex-start;">
                <button class="action-btn btn-edit" style="background: #f97316; border: none;" onclick="editUserStreak('${docSnap.id}', ${data.streak || 0})">تعديل الستريك 🔥</button>
                <button class="action-btn btn-edit" onclick="editUserPoints('${docSnap.id}', ${data.points || 0})">تعديل النقاط</button>
                <button class="action-btn" style="background: ${data.challengeStatus === "failed" ? "#10b981" : "#f59e0b"};" onclick="toggleUserStatus('${docSnap.id}', '${data.challengeStatus}')">${data.challengeStatus === "failed" ? "إعادة إحياء" : "إقصاء"}</button>
                <button class="action-btn btn-delete" style="background: transparent; border: 1px solid var(--danger); color: var(--danger);" onclick="deleteUserAccount('${docSnap.id}')">حذف نهائي</button>
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

window.editUserPoints = async (uid, currentPoints) => {
    const newPoints = await CustomDialog.prompt(
        "أدخل رصيد النقاط الجديد لهذا العضو:",
        currentPoints,
        "تعديل النقاط ⚙️",
    );
    if (newPoints !== null && newPoints.trim() !== "" && !isNaN(newPoints)) {
        try {
            await updateDoc(doc(db, "users", uid), {
                points: parseInt(newPoints),
            });
            loadUsers();
        } catch (error) {
            await CustomDialog.alert("حدث خطأ أثناء تحديث النقاط.");
        }
    }
};

window.editUserStreak = async (uid, currentStreak) => {
    const newStreak = await CustomDialog.prompt(
        "أدخل عدد أيام الستريك الجديد لهذا العضو:",
        currentStreak,
        "تعديل الستريك 🔥",
    );

    if (newStreak !== null && newStreak.trim() !== "" && !isNaN(newStreak)) {
        try {
            await updateDoc(doc(db, "users", uid), {
                streak: parseInt(newStreak),
            });
            loadUsers();
            await CustomDialog.alert("تم تحديث الستريك بنجاح!", "نجاح");
        } catch (error) {
            await CustomDialog.alert("حدث خطأ أثناء تحديث الستريك.");
        }
    }
};

// window.toggleUserStatus = async (uid, currentStatus) => {
//     const newStatus = currentStatus === "failed" ? "active" : "failed";
//     const msg =
//         newStatus === "failed"
//             ? "هل أنت متأكد من إقصاء هذا العضو؟ سيظهر له شاشة Game Over."
//             : "هل أنت متأكد من إعادة إحياء هذا العضو ليعود للتحدي؟";
//     if (await CustomDialog.confirm(msg, "تغيير حالة العضو")) {
//         try {
//             await updateDoc(doc(db, "users", uid), {
//                 challengeStatus: newStatus,
//             });
//             loadUsers();
//         } catch (error) {
//             await CustomDialog.alert("حدث خطأ أثناء تغيير الحالة.");
//         }
//     }
// };

window.toggleUserStatus = async (uid, currentStatus) => {
    const newStatus = currentStatus === "failed" ? "active" : "failed";
    const msg =
        newStatus === "failed"
            ? "هل أنت متأكد من إقصاء هذا العضو؟ سيظهر له شاشة Game Over."
            : "هل أنت متأكد من إعادة إحياء هذا العضو ليعود للتحدي؟";

    if (await CustomDialog.confirm(msg, "تغيير حالة العضو")) {
        try {
            // تجهيز البيانات الأساسية للتحديث
            let updateData = {
                challengeStatus: newStatus,
            };

            // حقن كود العفو العام (تصفير التاريخ للأمس) فقط في حالة الإحياء
            if (newStatus === "active") {
                const now = new Date();
                const cairoTimeStr = now.toLocaleString("en-US", {
                    timeZone: "Africa/Cairo",
                });
                const cairoDate = new Date(cairoTimeStr);
                cairoDate.setDate(cairoDate.getDate() - 1);

                const year = cairoDate.getFullYear();
                const month = String(cairoDate.getMonth() + 1).padStart(2, "0");
                const day = String(cairoDate.getDate()).padStart(2, "0");

                updateData.lastEvalDate = `${year}-${month}-${day}`;

                // يمكنك إضافة أي متغيرات أخرى تريد تصفيرها هنا مثل:
                // updateData.failedDays = 0;
            }

            // تنفيذ التحديث
            await updateDoc(doc(db, "users", uid), updateData);
            loadUsers();
        } catch (error) {
            console.error(error);
            await CustomDialog.alert("حدث خطأ أثناء تغيير الحالة.");
        }
    }
};

window.deleteUserAccount = async (uid) => {
    if (
        await CustomDialog.confirm(
            "⚠️ تحذير خطير: هل أنت متأكد من حذف هذا العضو نهائياً؟ سيتم مسح بياناته.",
            "حذف نهائي ❌",
        )
    ) {
        try {
            await deleteDoc(doc(db, "users", uid));
            loadUsers();
        } catch (error) {
            await CustomDialog.alert("حدث خطأ أثناء الحذف.");
        }
    }
};

// ==============================
// إعادة ضبط المصنع للجميع (فرمتة)
// ==============================
document
    .getElementById("factory-reset-btn")
    ?.addEventListener("click", async () => {
        const isSure = await CustomDialog.confirm(
            "⚠️ تحذير كارثي: هذا الزر سيقوم بتصفير جميع نقاط الأعضاء، وكسر الستريكات، وإرجاع الجميع لحالة (نشط)، وضبط تاريخ آخر تقييم لليوم. هل أنت متأكد 100% أنك تريد تصفير تعب الجميع؟",
            "إعادة ضبط المصنع ☢️",
        );

        if (!isSure) return;

        // طبقة حماية إضافية لمنع الضغط بالخطأ
        const secondConfirm = await CustomDialog.prompt(
            "اكتب كلمة 'تأكيد' باللغة العربية لتنفيذ الفرمتة:",
            "",
            "تأكيد أخير 🛑",
        );

        if (secondConfirm !== "تأكيد") {
            await CustomDialog.alert("تم إلغاء عملية إعادة الضبط.", "إلغاء");
            return;
        }

        const btn = document.getElementById("factory-reset-btn");
        const originalText = btn.innerText;
        btn.innerText = "جاري الفرمتة... ⏳";
        btn.disabled = true;

        try {
            const todayStr = new Date().toLocaleDateString("en-CA", {
                timeZone: "Africa/Cairo",
            });
            const usersSnap = await getDocs(collection(db, "users"));
            const updatePromises = [];

            usersSnap.forEach((userDoc) => {
                // تحديث جميع الأعضاء (بما فيهم حسابك كلاعب)
                updatePromises.push(
                    updateDoc(userDoc.ref, {
                        points: 0,
                        streak: 0,
                        lastEvalDate: todayStr,
                        challengeStatus: "active",
                    }),
                );
            });

            await Promise.all(updatePromises);

            await CustomDialog.alert(
                "تمت فرمتة جميع الأعضاء بنجاح. الكل يبدأ من الصفر اليوم.",
                "عملية ناجحة ✅",
            );
            loadUsers(); // تحديث الجدول
        } catch (error) {
            console.error(error);
            await CustomDialog.alert("حدث خطأ أثناء إعادة الضبط.");
        } finally {
            btn.innerText = originalText;
            btn.disabled = false;
        }
    });

// ==============================
// إدارة أكواد الهدايا (Redeem Codes)
// ==============================

// توليد كود عشوائي بصيغة XXX-XXX-XXX
document
    .getElementById("auto-generate-code-btn")
    ?.addEventListener("click", () => {
        const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        const randomPart = () =>
            Array.from(
                { length: 3 },
                () => chars[Math.floor(Math.random() * chars.length)],
            ).join("");
        document.getElementById("new-redeem-code").value =
            `${randomPart()}-${randomPart()}-${randomPart()}`;
    });

async function loadRedeemCodes() {
    const tbody = document.getElementById("redeem-table-body");
    if (!tbody) return;
    tbody.innerHTML = "";
    const snap = await getDocs(collection(db, "redeemCodes"));
    snap.forEach((docSnap) => {
        const data = docSnap.data();
        const usersCount = data.usedBy ? data.usedBy.length : 0;
        const maxUses = data.maxUses || "∞";
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td style="font-weight: bold; color: var(--gold-primary);">${docSnap.id}</td>
            <td class="gold-text" style="font-weight:bold; font-size: 16px;">${data.points}</td>
            <td style="${usersCount >= data.maxUses ? "color: var(--danger); font-weight: bold;" : ""}">${usersCount} / ${maxUses}</td>
            <td><span class="badge ${data.isActive ? "badge-active" : "badge-inactive"}">${data.isActive ? "نشط" : "معطل"}</span></td>
            <td>
                <button class="action-btn btn-edit" onclick="toggleRedeemCode('${docSnap.id}', ${data.isActive})">${data.isActive ? "تعطيل ⏸️" : "تفعيل ▶️"}</button>
                <button class="action-btn btn-delete" onclick="deleteRedeemCode('${docSnap.id}')">حذف ❌</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

document
    .getElementById("generate-redeem-btn")
    ?.addEventListener("click", async () => {
        const code = document
            .getElementById("new-redeem-code")
            .value.trim()
            .toUpperCase();
        const points = parseInt(
            document.getElementById("new-redeem-points").value,
        );
        const maxUses = parseInt(
            document.getElementById("new-redeem-max-uses").value,
        );

        if (!code || isNaN(points) || isNaN(maxUses) || maxUses <= 0) {
            return await CustomDialog.alert(
                "أدخل الكود، وقيمة النقاط، وعدد الاستخدامات الصحيح (أكبر من 0).",
            );
        }

        const btn = document.getElementById("generate-redeem-btn");
        btn.innerText = "جاري الحفظ...";
        btn.disabled = true;

        try {
            const codeRef = doc(db, "redeemCodes", code);
            const codeSnap = await getDoc(codeRef);
            if (codeSnap.exists()) {
                btn.innerText = "إضافة الكود";
                btn.disabled = false;
                return await CustomDialog.alert("هذا الكود موجود مسبقاً.");
            }

            await setDoc(codeRef, {
                points: points,
                maxUses: maxUses,
                isActive: true,
                usedBy: [],
                createdAt: new Date(),
            });

            document.getElementById("new-redeem-code").value = "";
            document.getElementById("new-redeem-points").value = "";
            document.getElementById("new-redeem-max-uses").value = "";
            loadRedeemCodes();
            await CustomDialog.alert("تمت إضافة كود الهدية بنجاح!", "نجاح ✅");
        } catch (e) {
            await CustomDialog.alert("حدث خطأ أثناء حفظ الكود.");
        } finally {
            btn.innerText = "إضافة الكود";
            btn.disabled = false;
        }
    });

window.toggleRedeemCode = async (codeId, currentStatus) => {
    await updateDoc(doc(db, "redeemCodes", codeId), {
        isActive: !currentStatus,
    });
    loadRedeemCodes();
};

window.deleteRedeemCode = async (codeId) => {
    if (
        await CustomDialog.confirm(
            "هل أنت متأكد من حذف كود الهدية هذا نهائياً؟",
            "حذف كود",
        )
    ) {
        await deleteDoc(doc(db, "redeemCodes", codeId));
        loadRedeemCodes();
    }
};

// ==============================
// نظام بث الإشعارات للأدمن (محدث ومحمي من التكرار)
// ==============================
const sendBroadcast = httpsCallable(functions, "sendAdminBroadcast");

document
    .getElementById("notify-registration-btn")
    ?.addEventListener("click", async (e) => {
        const btn = e.target;
        if (btn.disabled) return; // منع النقرات المزدوجة

        if (
            await CustomDialog.confirm(
                "هل تريد إرسال إشعار 'فتح التسجيل' لجميع المستخدمين؟",
                "تأكيد الإرسال",
            )
        ) {
            btn.disabled = true;
            btn.innerText = "جاري الإرسال ⏳...";
            try {
                await sendBroadcast({
                    title: "التسجيل متاح الآن 🔓",
                    body: "تم فتح باب التسجيل للتحدي الجديد. سارع بحجز مكانك قبل إغلاق الأبواب.",
                });
                await CustomDialog.alert("تم إرسال الإشعار بنجاح!");
            } catch (e) {
                console.error(e);
                await CustomDialog.alert("فشل الإرسال.");
            } finally {
                btn.disabled = false;
                btn.innerText = "إشعار: فتح التسجيل 🔓";
            }
        }
    });

document
    .getElementById("notify-challenge-btn")
    ?.addEventListener("click", async (e) => {
        const btn = e.target;
        if (btn.disabled) return; // منع النقرات المزدوجة

        if (
            await CustomDialog.confirm(
                "هل تريد إرسال إشعار 'بدء التحدي' لجميع المستخدمين؟",
                "تأكيد الإرسال",
            )
        ) {
            btn.disabled = true;
            btn.innerText = "جاري الإرسال ⏳...";
            try {
                await sendBroadcast({
                    title: "المعسكر بدأ! ⚔️",
                    body: "انطلق التحدي رسمياً. المهام بانتظارك، لا مجال للتراجع الآن.",
                });
                await CustomDialog.alert("تم إرسال الإشعار بنجاح!");
            } catch (e) {
                console.error(e);
                await CustomDialog.alert("فشل الإرسال.");
            } finally {
                btn.disabled = false;
                btn.innerText = "إشعار: بدء التحدي ⚔️";
            }
        }
    });

// التقاط الإشعارات والموقع مفتوح (Foreground)
if (messaging) {
    onMessage(messaging, (payload) => {
        console.log("وصل إشعار وأنت داخل الموقع:", payload);

        // إجبار المتصفح على عرض الإشعار
        if (Notification.permission === "granted") {
            new Notification(payload.notification.title, {
                body: payload.notification.body,
                icon: "/images/icon-512.png", // تأكد من مسار الأيقونة
            });
        }
    });
}

// ==========================================
// 🚀 سكريبت الهجرة إلى النظام الجديد (V2 Migration)
// ==========================================
window.migrateSystemV2 = async () => {
    const confirmMsg =
        "⚠️ تحذير خطير: هل أنت متأكد من تنفيذ هجرة البيانات للنظام الجديد (V2)؟\nهذا الإجراء سيقوم بتحويل نقاط جميع المحاربين إلى عملات وسكور تراكمي، وتصفير الستريك والـ XP.";

    // حاجز أمني مزدوج لمنع الضغط بالخطأ
    if (!(await CustomDialog.confirm(confirmMsg, "هجرة النظام (Migration)")))
        return;

    const btn = document.getElementById("migrate-btn");
    if (btn) {
        btn.innerText = "جاري الهجرة... ⏳";
        btn.disabled = true;
    }

    try {
        const usersSnap = await getDocs(collection(db, "users"));
        let count = 0;

        // تجهيز حزمة التحديثات (Batch) لتنفيذها دفعة واحدة بأمان
        const batch = writeBatch(db);

        usersSnap.forEach((userDoc) => {
            const userData = userDoc.data();

            // سحب النقاط القديمة (إذا لم يكن لديه نقاط نعتبرها 0)
            const oldPoints = userData.points || 0;

            // تطبيق المعادلات الاقتصادية الصارمة
            const newCoins = Math.floor(oldPoints / 1.5);
            const newScore = oldPoints;

            const userRef = doc(db, "users", userDoc.id);

            // حقن البيانات في الحزمة
            batch.update(userRef, {
                lifetimeScore: newScore,
                walletCoins: newCoins,
                currentXP: 0,
                currentStreak: 0,
                // ملاحظة: تركنا حقل `points` القديم كما هو كأرشيف مؤقت، لن يضر النظام لأنه أصبح يتجاهله.
            });
            count++;
        });

        // إطلاق الحزمة للسيرفر (تنفيذ التعديلات فعلياً)
        await batch.commit();

        await CustomDialog.alert(
            `تمت هجرة ${count} محارب بنجاح إلى النظام الجديد! 🎉\nجميع نقاطهم تحولت لعملات ومستويات، وساحة المعركة الآن جاهزة.`,
            "عملية ناجحة",
        );
        loadUsers(); // تحديث الجدول أمامك لترى التغييرات
    } catch (error) {
        console.error("خطأ أثناء الهجرة:", error);
        await CustomDialog.alert(
            "حدث خطأ أثناء هجرة البيانات. تحقق من اتصالك بالإنترنت.",
            "خطأ تقني ❌",
        );
    } finally {
        if (btn) {
            btn.innerText = "تنفيذ الهجرة لـ V2 🚀";
            btn.disabled = false;
        }
    }
};

// ==========================================
// 📊 نظام التقرير الشامل (Data Analytics & PDF)
// ==========================================
window.generateComprehensiveReport = async () => {
    const btn = document.getElementById("generate-report-btn");
    if (!btn) return;

    const originalText = btn.innerHTML;
    btn.innerHTML =
        "<i class='fa-solid fa-spinner fa-spin'></i> جاري طحن البيانات... ⏳";
    btn.disabled = true;

    try {
        // 1. جلب خريطة المهام (Tasks)
        const tasksSnap = await getDocs(collection(db, "tasks"));
        const tasksStats = {};
        tasksSnap.forEach((doc) => {
            const data = doc.data();
            tasksStats[doc.id] = {
                name: data.name,
                category: data.category || "عام",
                totalSelections: 0,
                optionsFreq: {}, // كم مرة تم اختيار كل مستوى من المهمة
            };
        });

        // 2. جلب المستخدمين (Users)
        const usersSnap = await getDocs(collection(db, "users"));
        const users = [];
        let globalStats = {
            totalUsers: 0,
            activeUsers: 0,
            failedUsers: 0,
            totalXP: 0,
            totalCoins: 0,
            totalFreezesUsed: 0,
        };

        // 3. فلترة المستخدمين وحساب الإحصائيات العامة
        usersSnap.forEach((doc) => {
            const u = doc.data();
            if (u.role !== "admin") {
                users.push({ id: doc.id, ...u });
                globalStats.totalUsers++;
                if (u.challengeStatus === "active") globalStats.activeUsers++;
                if (u.challengeStatus === "failed") globalStats.failedUsers++;
                globalStats.totalXP += u.currentXP || 0;
                globalStats.totalCoins += u.walletCoins || 0;
                // حساب التجميدات المستهلكة (بافتراض أن كل شخص بدأ بـ 0 واشترى، أو يمكنك قياسها لاحقاً)
            }
        });

        // 4. جلب السجلات اليومية (Daily Logs) لتحليل المهام
        // هذه الخطوة تستهلك قراءات (Reads) لذلك يجب استخدامها عند الحاجة فقط
        for (let user of users) {
            const logsSnap = await getDocs(
                collection(db, `users/${user.id}/dailyLogs`),
            );
            logsSnap.forEach((logDoc) => {
                const log = logDoc.data();
                if (log.selections) {
                    for (const [taskId, optionIndex] of Object.entries(
                        log.selections,
                    )) {
                        if (tasksStats[taskId]) {
                            // تجاهل الاختيار رقم 0 إذا كان هو خيار "لم أفعل شيئاً"
                            if (optionIndex > 0) {
                                tasksStats[taskId].totalSelections++;
                                tasksStats[taskId].optionsFreq[optionIndex] =
                                    (tasksStats[taskId].optionsFreq[
                                        optionIndex
                                    ] || 0) + 1;
                            }
                        }
                    }
                }
            });
        }

        // 5. ترتيب البيانات للتقرير
        const top10Users = [...users]
            .sort((a, b) => (b.currentXP || 0) - (a.currentXP || 0))
            .slice(0, 10);

        // تحويل المهام إلى مصفوفة لترتيبها حسب الأكثر إنجازاً
        const tasksArray = Object.values(tasksStats).sort(
            (a, b) => b.totalSelections - a.totalSelections,
        );

        // ==========================================
        // 🎨 بناء صفحة التقرير (HTML + CSS for Print)
        // ==========================================
        const reportDate = new Date().toLocaleDateString("en-CA", {
            timeZone: "Africa/Cairo",
        });

        let htmlContent = `
            <!DOCTYPE html>
            <html lang="ar" dir="rtl">
            <head>
                <meta charset="UTF-8">
                <title>تقرير المعسكر - ${reportDate}</title>
                <style>
                    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 80px; color: #111; background: #fff; line-height: 1.6; }
                    h1, h2, h3 { color: #1e3a8a; border-bottom: 2px solid #e5e7eb; padding-bottom: 10px; }
                    .header { text-align: center; margin-bottom: 40px; }
                    .stats-grid { display: flex; flex-wrap: wrap; gap: 20px; margin-bottom: 40px; }
                    .stat-box { flex: 1; min-width: 150px; background: #f3f4f6; padding: 20px; border-radius: 8px; text-align: center; border: 1px solid #d1d5db; }
                    .stat-box h4 { margin: 0 0 10px 0; color: #4b5563; font-size: 14px; }
                    .stat-box span { font-size: 24px; font-weight: bold; color: #1d4ed8; }
                    table { width: 100%; border-collapse: collapse; margin-bottom: 40px; font-size: 14px; }
                    th, td { padding: 12px; text-align: right; border: 1px solid #d1d5db; }
                    th { background-line: #f9fafb; font-weight: bold; background: #e5e7eb; }
                    tr:nth-child(even) { background-color: #f9fafb; }
                    @media print {
                        body { padding: 0; }
                        button { display: none; }
                        .page-break { page-break-before: always; }
                    }
                </style>
            </head>
            <body>
                <div class="header">
                    <h1>🛡️ التقرير الشامل لبيانات المعسكر (V2)</h1>
                    <p>تاريخ الاستخراج: ${reportDate}</p>
                </div>

                <h2>📊 نظرة عامة على الاقتصاد والمحاربين</h2>
                <div class="stats-grid">
                    <div class="stat-box"><h4>إجمالي المحاربين</h4><span>${globalStats.totalUsers}</span></div>
                    <div class="stat-box"><h4>الصامدون (Active)</h4><span style="color: #059669;">${globalStats.activeUsers}</span></div>
                    <div class="stat-box"><h4>المُقصون (Failed)</h4><span style="color: #dc2626;">${globalStats.failedUsers}</span></div>
                    <div class="stat-box"><h4>إجمالي الـ XP المكتسب</h4><span>${globalStats.totalXP}</span></div>
                    <div class="stat-box"><h4>العملات المتداولة (🪙)</h4><span>${globalStats.totalCoins}</span></div>
                </div>

                <h2>🏆 لوحة الشرف (أفضل 10 محاربين)</h2>
                <table>
                    <thead><tr><th>المركز</th><th>الاسم</th><th>الـ XP الحالي</th><th>العملات المتبقية</th><th>الستريك</th><th>الحالة</th></tr></thead>
                    <tbody>
                        ${top10Users
                            .map(
                                (u, i) => `
                            <tr>
                                <td>#${i + 1}</td>
                                <td>${u.name}</td>
                                <td>${u.currentXP || 0}</td>
                                <td>${u.walletCoins || 0}</td>
                                <td>${u.currentStreak || 0} 🔥</td>
                                <td>${u.challengeStatus === "active" ? "صامد" : "مُقصى"}</td>
                            </tr>
                        `,
                            )
                            .join("")}
                    </tbody>
                </table>

                <div class="page-break"></div>

                <h2>📋 تحليل المهام (أداة ضبط الصعوبة)</h2>
                <p style="color: #4b5563; font-size: 13px;">* المهام في الأعلى هي الأكثر إنجازاً (قد تكون سهلة جداً أو نقاطها مبالغ فيها). المهام في الأسفل يتم تجاهلها (تحتاج لتخفيف أو زيادة نقاط).</p>
                <table>
                    <thead><tr><th>اسم المهمة</th><th>القسم</th><th>مرات الإنجاز</th></tr></thead>
                    <tbody>
                        ${tasksArray
                            .map(
                                (t) => `
                            <tr>
                                <td>${t.name}</td>
                                <td>${t.category}</td>
                                <td><strong>${t.totalSelections}</strong> مرة</td>
                            </tr>
                        `,
                            )
                            .join("")}
                    </tbody>
                </table>

                <script>
                    // تشغيل نافذة الطباعة تلقائياً بمجرد تحميل الصفحة
                    window.onload = function() { window.print(); }
                </script>
            </body>
            </html>
        `;

        // 6. فتح التقرير في نافذة جديدة للطباعة
        const printWindow = window.open("", "_blank");
        printWindow.document.write(htmlContent);
        printWindow.document.close();
    } catch (error) {
        console.error("Error generating report:", error);
        await CustomDialog.alert(
            "حدث خطأ أثناء طحن البيانات. راجع الكونسول.",
            "خطأ تقني",
        );
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
};

// تشغيل الفلترة تلقائياً عند تغيير القسم من القائمة المنسدلة في صفحة الإدارة
document
    .getElementById("task-category-filter")
    ?.addEventListener("change", loadTasks);

// ==========================================
// 🔄 جلب أقسام المهام ديناميكياً للفلتر
// ==========================================
async function populateCategoryFilter() {
    const filterSelect = document.getElementById("task-category-filter");
    if (!filterSelect) return;

    // حفظ الخيار المحدد حالياً حتى لا يتغير عند التحديث
    const currentSelection = filterSelect.value;

    try {
        const snap = await getDocs(collection(db, "tasks"));
        const categories = new Set(); // نستخدم Set لمنع التكرار

        snap.forEach((doc) => {
            const data = doc.data();
            const cat =
                data.category && data.category.trim() !== ""
                    ? data.category.trim()
                    : "مهام عامة";
            categories.add(cat);
        });

        // تصفير القائمة وإبقاء خيار "الكل"
        filterSelect.innerHTML = '<option value="all">كل الأقسام</option>';

        // حقن الأقسام الجديدة
        categories.forEach((category) => {
            const option = document.createElement("option");
            option.value = category;
            option.innerText = category;
            filterSelect.appendChild(option);
        });

        // إعادة اختيار القسم الذي كان يحدده الأدمن (إن وجد)
        if (categories.has(currentSelection) || currentSelection === "all") {
            filterSelect.value = currentSelection;
        }
    } catch (error) {
        console.error("خطأ في جلب الأقسام:", error);
    }
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
    });
});

// ==============================
// 🕌 إدارة الجانب الديني (المهام الروحية) المطورة
// ==============================
let editingRelTaskId = null;

async function loadReligiousTasks() {
    const tbody = document.getElementById("religious-tasks-table-body");
    if (!tbody) return;
    tbody.innerHTML =
        "<tr><td colspan='4' style='text-align:center;'>جاري التحميل... ⏳</td></tr>";

    const q = query(collection(db, "religiousTasks"), orderBy("order", "asc"));
    const snap = await getDocs(q);
    tbody.innerHTML = "";

    if (snap.empty) {
        tbody.innerHTML =
            "<tr><td colspan='4' style='text-align:center; color: var(--text-muted);'>لا توجد مهام دينية مضافة حتى الآن.</td></tr>";
        return;
    }

    snap.forEach((docSnap) => {
        const data = docSnap.data();
        const typeBadge = data.isImportant
            ? `<span class="badge badge-inactive" style="background: rgba(245, 158, 11, 0.2); color: #f59e0b;">أساسية إجبارية ⚠️</span>`
            : `<span class="badge badge-active" style="background: rgba(168, 85, 247, 0.2); color: #c084fc;">إضافية مستحبة</span>`;

        let optionsHtml =
            '<ul style="list-style: none; padding: 0; margin: 0; font-size: 13px;">';
        if (data.options && data.options.length > 0) {
            data.options.forEach((opt) => {
                optionsHtml += `<li style="margin-bottom: 5px;">- ${opt.name}</li>`;
            });
        }
        optionsHtml += "</ul>";

        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td>
                <span style="font-weight: bold; font-size: 15px;">${data.title}</span>
                <br><span style="color: var(--text-muted); font-size: 11px;">${data.note || ""}</span>
            </td>
            <td>${optionsHtml}</td>
            <td>${typeBadge}<br><span style="font-size: 10px; color: gray;">${data.isMultiSelect ? "متعدد الاختيار" : "اختيار واحد"}</span></td>
            <td>
                <button class="action-btn btn-edit" style="background: #f59e0b; border: none;" onclick="editReligiousTask('${docSnap.id}')">تعديل ✏️</button>
                <button class="action-btn btn-delete" onclick="deleteReligiousTask('${docSnap.id}')">حذف ❌</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

document
    .getElementById("add-rel-option-row-btn")
    ?.addEventListener("click", () => {
        const container = document.getElementById("rel-options-container");
        const row = document.createElement("div");
        row.className = "rel-option-row";
        row.style.cssText = "display: flex; gap: 10px; margin-bottom: 8px;";
        row.innerHTML = `
        <input type="text" class="rel-opt-name" placeholder="اسم الخيار الإضافي" style="margin: 0; flex-grow: 1;">
        <button class="remove-rel-opt-btn" style="background: var(--danger); color: white; border: none; padding: 0 15px; border-radius: 8px; cursor: pointer;">X</button>
    `;
        container.appendChild(row);
        row.querySelector(".remove-rel-opt-btn").addEventListener("click", () =>
            row.remove(),
        );
    });

document
    .getElementById("add-rel-task-btn")
    ?.addEventListener("click", async () => {
        const title = document.getElementById("rel-task-name").value.trim();
        const note = document.getElementById("rel-task-note").value.trim();
        const isImportant =
            document.getElementById("rel-task-important").checked;
        const isMultiSelect =
            document.getElementById("rel-task-is-multi").checked;
        const orderInput = document.getElementById("rel-task-order").value;
        const order = orderInput === "" ? 99 : parseInt(orderInput);

        if (!title)
            return await CustomDialog.alert("يجب إدخال عنوان المهمة الدينية.");

        const optionRows = document.querySelectorAll(".rel-option-row");
        const options = [];
        let hasError = false;

        optionRows.forEach((row) => {
            const optName = row.querySelector(".rel-opt-name").value.trim();
            if (optName)
                options.push({ name: optName, points: 0 }); // Points always 0 for religious
            else hasError = true;
        });

        if (hasError || options.length === 0)
            return await CustomDialog.alert(
                "يرجى تعبئة أسماء الخيارات (خيار واحد على الأقل).",
            );

        const btn = document.getElementById("add-rel-task-btn");
        btn.innerText = "جاري الحفظ... ⏳";
        btn.disabled = true;

        try {
            if (editingRelTaskId) {
                await updateDoc(doc(db, "religiousTasks", editingRelTaskId), {
                    title,
                    note,
                    isImportant,
                    isMultiSelect,
                    order,
                    options,
                });
                await CustomDialog.alert("تم تحديث المهمة الدينية بنجاح!");
            } else {
                await addDoc(collection(db, "religiousTasks"), {
                    title,
                    note,
                    isImportant,
                    isMultiSelect,
                    order,
                    options,
                    isActive: true,
                    createdAt: new Date(),
                });
                await CustomDialog.alert("تمت إضافة المهمة الدينية بنجاح!");
            }
            cancelRelEditMode();
            loadReligiousTasks();
        } catch (error) {
            await CustomDialog.alert("حدث خطأ أثناء حفظ المهمة.");
        } finally {
            btn.innerText = editingRelTaskId
                ? "تحديث المهمة ✏️"
                : "حفظ المهمة الدينية";
            btn.disabled = false;
        }
    });

window.editReligiousTask = async (taskId) => {
    const docRef = await getDoc(doc(db, "religiousTasks", taskId));
    if (docRef.exists()) {
        const data = docRef.data();
        editingRelTaskId = taskId;

        document.getElementById("rel-task-name").value = data.title;
        document.getElementById("rel-task-note").value = data.note || "";
        document.getElementById("rel-task-order").value =
            data.order !== undefined ? data.order : "";
        document.getElementById("rel-task-important").checked =
            data.isImportant || false;
        document.getElementById("rel-task-is-multi").checked =
            data.isMultiSelect || false;

        const container = document.getElementById("rel-options-container");
        container.innerHTML = "";
        if (data.options && data.options.length > 0) {
            data.options.forEach((opt) => {
                const row = document.createElement("div");
                row.className = "rel-option-row";
                row.style.cssText =
                    "display: flex; gap: 10px; margin-bottom: 8px;";
                row.innerHTML = `
                    <input type="text" class="rel-opt-name" value="${opt.name}" style="margin: 0; flex-grow: 1;">
                    <button class="remove-rel-opt-btn" style="background: var(--danger); color: white; border: none; padding: 0 15px; border-radius: 8px; cursor: pointer;">X</button>
                `;
                container.appendChild(row);
                row.querySelector(".remove-rel-opt-btn").addEventListener(
                    "click",
                    () => row.remove(),
                );
            });
        } else {
            document.getElementById("add-rel-option-row-btn").click();
        }

        const btn = document.getElementById("add-rel-task-btn");
        btn.innerText = "تحديث المهمة ✏️";
        btn.style.background = "#f59e0b";

        let cancelBtn = document.getElementById("cancel-rel-edit-btn");
        if (!cancelBtn) {
            cancelBtn = document.createElement("button");
            cancelBtn.id = "cancel-rel-edit-btn";
            cancelBtn.innerText = "إلغاء ❌";
            cancelBtn.style.cssText =
                "background: transparent; color: var(--danger); border: 1px solid var(--danger); padding: 12px 20px; border-radius: 8px; cursor: pointer;";
            cancelBtn.onclick = cancelRelEditMode;
            document
                .getElementById("rel-task-btn-container")
                .appendChild(cancelBtn);
        }
        cancelBtn.style.display = "block";
        document
            .getElementById("religious-tasks-page")
            .scrollIntoView({ behavior: "smooth" });
    }
};

function cancelRelEditMode() {
    editingRelTaskId = null;
    document.getElementById("rel-task-name").value = "";
    document.getElementById("rel-task-note").value = "";
    document.getElementById("rel-task-order").value = "";
    document.getElementById("rel-task-important").checked = false;
    document.getElementById("rel-task-is-multi").checked = false;
    document.getElementById("rel-options-container").innerHTML = `
        <div class="rel-option-row" style="display: flex; gap: 10px; margin-bottom: 8px;">
            <input type="text" class="rel-opt-name" placeholder="اسم الخيار" style="margin: 0; flex-grow: 1;">
        </div>`;

    const btn = document.getElementById("add-rel-task-btn");
    btn.innerText = "حفظ المهمة الدينية";
    btn.style.background = "";
    const cancelBtn = document.getElementById("cancel-rel-edit-btn");
    if (cancelBtn) cancelBtn.style.display = "none";
}

window.deleteReligiousTask = async (taskId) => {
    if (
        await CustomDialog.confirm(
            "هل أنت متأكد من حذف هذه المهمة الدينية نهائياً؟",
            "حذف مهمة",
        )
    ) {
        await deleteDoc(doc(db, "religiousTasks", taskId));
        loadReligiousTasks();
    }
};

// ==============================
// 🚀 أداة ترحيل النظام (Migration Script) - المرحلة الأولى
// ==============================
document
    .getElementById("migrate-system-btn")
    ?.addEventListener("click", async () => {
        const confirmMigrate = await CustomDialog.confirm(
            "هل أنت متأكد من تحديث قاعدة البيانات للنظام الجديد؟ (تأكد من تعديل قواعد الحماية في Firebase أولاً).",
            "تحذير أمني ⚠️",
        );
        if (!confirmMigrate) return;

        const btn = document.getElementById("migrate-system-btn");
        const originalText = btn.innerText;
        btn.innerText = "جاري التحديث... ⏳";
        btn.disabled = true;

        try {
            // نستخدم WriteBatch لضمان أمان العملية (نجاح كامل أو فشل كامل)
            const batch = writeBatch(db);

            // 1. إنشاء أو تحديث مستند إعدادات النظام (System Config)
            const systemRef = doc(db, "configs", "system");
            const systemSnap = await getDoc(systemRef);
            if (!systemSnap.exists()) {
                batch.set(systemRef, {
                    currentCycle: 1,
                    lastReset: new Date().toISOString(),
                });
            }

            // 2. تحديث ملفات جميع المستخدمين
            const usersSnap = await getDocs(collection(db, "users"));
            let count = 0;

            usersSnap.forEach((userDoc) => {
                const userRef = doc(db, "users", userDoc.id);
                batch.update(userRef, {
                    currentZone: "green", // المنطقة الافتراضية
                    cycleScore: 0, // نقاط الدورة التنافسية
                    earnedStreakBadges: [], // سجل أوسمة الستريك لمنع التكرار
                    badges: [], // الأوسمة المرئية
                    coreTasksCompletedToday: false, // تتبع الصلوات اليومي
                });
                count++;
            });

            // 3. تنفيذ حزمة التحديثات
            await batch.commit();
            await CustomDialog.alert(
                `تم تحديث النظام بنجاح! تم إضافة الحقول الجديدة لـ ${count} مستخدم.`,
                "نجاح ✅",
            );
        } catch (error) {
            console.error("Migration Error:", error);
            await CustomDialog.alert(
                "حدث خطأ أثناء التحديث: " + error.message,
                "خطأ ❌",
            );
        } finally {
            btn.innerText = originalText;
            btn.disabled = false;
        }
    });
