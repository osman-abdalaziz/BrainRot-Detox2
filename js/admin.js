import { auth, db, storage, app, messaging } from "./firebase-config.js";
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
    where, // <--- أضف هذه الكلمة هنا
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
            loadSystemConfigs();
            loadUsers();
            loadRedeemCodes(); // <--- أضف هذا السطر
            loadReligiousTasks(); // <--- أضف هذا السطر هنا
            loadWillpowerChallenges(); // <--- سحب بنك التحديات
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
                    <button class="action-btn btn-edit" style="background: #f59e0b; border: none;" onclick="editTask('${docSnap.id}')">تعديل <i class="fa-solid fa-edit"></i></button>
                    <button class="action-btn btn-edit" onclick="toggleTaskStatus('${docSnap.id}', ${data.isActive})">${data.isActive ? "تعطيل <i class='fa-solid fa-pause'></i>" : "تفعيل <i class='fa-solid fa-play'></i>"}</button>
                    <button class="action-btn btn-delete" onclick="deleteTask('${docSnap.id}')">حذف <i class="fa-solid fa-trash"></i></button>
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

document.getElementById("add-option-row-btn").addEventListener("click", () => {
    const container = document.getElementById("options-container");
    const row = document.createElement("div");
    row.className = "option-row-wrapper";
    row.innerHTML = `
        <div style="flex-grow: 2;"><input type="text" class="opt-name admin-input" placeholder="اسم الخيار إضافي" style="margin: 0;"></div>
        <div style="width: 120px;"><input type="number" class="opt-points admin-input" placeholder="النقاط" style="margin: 0;"></div>
        <button class="remove-opt-btn btn-icon" style="background: rgba(239, 68, 68, 0.15); color: var(--danger); border: 1px solid var(--danger);"><i class="fa-solid fa-trash"></i></button>
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
                const row = document.createElement("div");
                row.className = "option-row-wrapper";
                row.innerHTML = `
                    <div style="flex-grow: 2;"><input type="text" class="opt-name admin-input" placeholder="اسم الخيار إضافي" value="${opt.name}" style="margin: 0;"></div>
                    <div style="width: 120px;"><input type="number" class="opt-points admin-input" placeholder="النقاط" value="${opt.points}" style="margin: 0;"></div>
                    <button class="remove-opt-btn btn-icon" style="background: rgba(239, 68, 68, 0.15); color: var(--danger); border: 1px solid var(--danger);"><i class="fa-solid fa-trash"></i></button>
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
            btn.innerHTML =
                "تحديث المهمة <i class='fa-solid fa-pen-to-square'></i>";
            btn.style.background = "#f59e0b"; // برتقالي

            // إظهار زر الإلغاء
            let cancelBtn = document.getElementById("cancel-edit-btn");
            if (!cancelBtn) {
                cancelBtn = document.createElement("button");
                cancelBtn.id = "cancel-edit-btn";
                cancelBtn.innerHTML = "إلغاء <i class='fa-solid fa-xmark'></i>";
                cancelBtn.style.cssText =
                    "background: transparent; width: 120px; display:flex; justify-content: center; align-items: center; color: var(--danger); border: 1px solid var(--danger); padding: 12px 20px; border-radius: 8px; cursor: pointer; flex-grow: 0;";
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
        <div class="option-row-wrapper">
            <div style="flex-grow: 2;"><input type="text" class="opt-name admin-input" placeholder="اسم الخيار (مثال: قراءة 10 صفحات)" style="margin: 0;"></div>
            <div style="width: 120px;"><input type="number" class="opt-points admin-input" placeholder="النقاط" style="margin: 0;"></div>
        </div>
    `;
    const btn = document.getElementById("add-task-btn");
    btn.innerHTML = "حفظ المهمة بالكامل <i class='fa-solid fa-save'></i>";
    btn.style.background = "";
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

    const optionRows = document.querySelectorAll(
        "#options-container .option-row-wrapper",
    );
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
            btn.innerHTML =
                "تحديث المهمة <i class='fa-solid fa-pen-to-square'></i>";
        } else {
            btn.innerHTML =
                "حفظ المهمة بالكامل <i class='fa-solid fa-save'></i>";
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
// إعدادات النظام (System Configs V2)
// ==============================

// سحب الإعدادات الحالية من قاعدة البيانات وعرضها في الحقول
async function loadSystemConfigs() {
    try {
        // سحب الهدف اليومي
        const challengeDoc = await getDoc(
            doc(db, "settings", "currentChallenge"),
        );
        if (challengeDoc.exists()) {
            document.getElementById("sys-daily-target").value =
                challengeDoc.data().dailyTargetPoints || 100;
        }

        // سحب إعدادات الوقت
        const sysDoc = await getDoc(doc(db, "configs", "system"));
        if (sysDoc.exists()) {
            const data = sysDoc.data();
            document.getElementById("sys-day-start").value =
                data.dayStartHour !== undefined ? data.dayStartHour : 4;
            document.getElementById("sys-submit-start").value =
                data.submissionStartHour !== undefined
                    ? data.submissionStartHour
                    : 21;
        }
    } catch (error) {
        console.error("خطأ في سحب الإعدادات:", error);
    }
}

// حفظ الإعدادات عند الضغط على الزر
document
    .getElementById("save-configs-btn")
    ?.addEventListener("click", async () => {
        const target = parseInt(
            document.getElementById("sys-daily-target").value,
        );
        const dayStart = parseInt(
            document.getElementById("sys-day-start").value,
        );
        const submitStart = parseInt(
            document.getElementById("sys-submit-start").value,
        );

        // التحقق من صحة المدخلات
        if (isNaN(target) || isNaN(dayStart) || isNaN(submitStart)) {
            return CustomDialog.alert("يرجى إدخال أرقام صحيحة في جميع الحقول.");
        }
        if (
            dayStart < 0 ||
            dayStart > 23 ||
            submitStart < 0 ||
            submitStart > 23
        ) {
            return CustomDialog.alert(
                "الساعات يجب أن تكون بنظام 24 ساعة (من 0 إلى 23).",
            );
        }

        const btn = document.getElementById("save-configs-btn");
        const originalText = btn.innerHTML;
        btn.innerHTML = "جاري الحفظ... ⏳";
        btn.disabled = true;

        try {
            // تحديث الهدف اليومي
            await setDoc(
                doc(db, "settings", "currentChallenge"),
                {
                    dailyTargetPoints: target,
                    isActive: true, // للحفاظ على توافق النظام القديم
                },
                { merge: true },
            );

            // تحديث إعدادات التوقيت
            await setDoc(
                doc(db, "configs", "system"),
                {
                    dayStartHour: dayStart,
                    submissionStartHour: submitStart,
                },
                { merge: true },
            );

            await CustomDialog.alert(
                "تم تحديث إعدادات النظام بنجاح! ستُطبق التغييرات فوراً.",
                "نجاح ✅",
            );
        } catch (error) {
            console.error(error);
            await CustomDialog.alert("حدث خطأ أثناء الحفظ.");
        } finally {
            btn.innerHTML = originalText;
            btn.disabled = false;
        }
    });

// ==============================
// إدارة الأعضاء (V2) - النسخة المنقحة والمؤمنة
// ==============================

async function loadUsers() {
    const tbody = document.getElementById("users-table-body");
    tbody.innerHTML =
        "<tr><td colspan='5' style='text-align:center;'>جاري سحب بيانات الجنود... ⏳</td></tr>";

    const snap = await getDocs(collection(db, "users"));
    tbody.innerHTML = "";

    snap.forEach((docSnap) => {
        const data = docSnap.data();
        // if (data.role === "admin") return; // إخفاء الإدارة من الجدول

        // 🛑 القائمة المنسدلة التفاعلية لتغيير المنطقة (Select)
        const zoneSelectHtml = `
            <select onchange="changeUserZone('${docSnap.id}', this.value)" style="background: rgba(0,0,0,0.5); color: white; border: 1px solid var(--border-color); padding: 5px; border-radius: 6px; font-family: 'Cairo', sans-serif; font-size: 12px; margin-bottom: 5px; outline: none; cursor: pointer;">
                <option value="green" ${data.currentZone === "green" ? "selected" : ""}>🟢 منطقة خضراء</option>
                <option value="yellow" ${data.currentZone === "yellow" ? "selected" : ""}>🟡 منطقة صفراء</option>
                <option value="red" ${data.currentZone === "red" ? "selected" : ""}>🔴 منطقة حمراء</option>
            </select>
        `;

        const challengeStatus =
            data.challengeStatus === "failed"
                ? `<span class="badge badge-inactive" style="display:inline-block; width: 100%; text-align: center;">مُقصى 💀</span>`
                : `<span class="badge badge-active" style="display:inline-block; width: 100%; text-align: center;">صامد ⚔️</span>`;

        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td>
                <strong style="color: var(--gold-primary); font-size: 15px;">${data.name}</strong><br>
                <span style="font-size: 11px; color: var(--text-muted);">${data.email}</span>
            </td>
            <td>
                <div style="font-size: 13px;">⭐ XP: <strong style="color:var(--success);">${data.lifetimeScore || 0}</strong></div>
                <div style="font-size: 13px;">🪙 عملات: <strong style="${(data.walletCoins || 0) < 0 ? "color:var(--danger);" : "color:var(--gold-primary);"}">${data.walletCoins || 0}</strong></div>
            </td>
            <td>
                <div style="font-size: 13px;">🏆 الدورة: <strong>${data.cycleScore || 0}</strong></div>
                <div style="font-size: 13px;">🔥 ستريك: <strong style="color:#f97316;">${data.currentStreak || 0}</strong></div>
            </td>
            <td>
                <div style="display: flex; flex-direction: column; gap: 5px; max-width: 120px;">
                    ${zoneSelectHtml}
                    ${challengeStatus}
                </div>
            </td>
            <td>
                <div style="display: flex; gap: 5px; flex-wrap: wrap; max-width: 250px;">
                    <button class="action-btn" style="background: #3b82f6;" onclick="editUserValue('${docSnap.id}', 'walletCoins', ${data.walletCoins || 0}, 'تعديل العملات 🪙')">العملات</button>
                    <button class="action-btn" style="background: #8b5cf6;" onclick="editUserValue('${docSnap.id}', 'lifetimeScore', ${data.lifetimeScore || 0}, 'تعديل الـ XP ⭐')">الـ XP</button>
                    <button class="action-btn" style="background: #f97316;" onclick="editUserValue('${docSnap.id}', 'currentStreak', ${data.currentStreak || 0}, 'تعديل الستريك 🔥')">الستريك</button>
                    <button class="action-btn" style="background: ${data.challengeStatus === "failed" ? "#10b981" : "#f59e0b"};" onclick="toggleUserStatus('${docSnap.id}', '${data.challengeStatus}')">${data.challengeStatus === "failed" ? "إحياء 🕊️" : "إقصاء 💀"}</button>
                    <button class="action-btn btn-delete" style="background: transparent; border: 1px solid var(--danger); color: var(--danger);" onclick="deleteUserAccount('${docSnap.id}')">حذف نهائي ❌</button>
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

// 🛑 الدالة الجديدة لتغيير المنطقة فوراً من الـ Select
window.changeUserZone = async (uid, newZone) => {
    try {
        await updateDoc(doc(db, "users", uid), { currentZone: newZone });
        console.log(`User ${uid} zone changed to ${newZone}`);
        // لا نحتاج لعمل loadUsers() هنا لتجنب إعادة تحميل الجدول بالكامل وإزعاجك أثناء العمل
        // التعديل يتم في الخلفية بصمت.
    } catch (error) {
        await CustomDialog.alert("حدث خطأ أثناء تغيير المنطقة.");
        loadUsers(); // إعادة التحميل فقط في حالة الخطأ لإصلاح الواجهة
    }
};

window.editUserValue = async (uid, fieldObj, currentValue, title) => {
    const newValue = await CustomDialog.prompt(
        `أدخل القيمة الجديدة لـ (${title}):`,
        currentValue,
        title,
    );
    if (newValue !== null && newValue.trim() !== "" && !isNaN(newValue)) {
        try {
            let updateData = {};
            updateData[fieldObj] = parseInt(newValue);
            await updateDoc(doc(db, "users", uid), updateData);
            loadUsers();
        } catch (error) {
            await CustomDialog.alert("حدث خطأ أثناء التحديث.");
        }
    }
};

window.toggleUserStatus = async (uid, currentStatus) => {
    const newStatus = currentStatus === "failed" ? "active" : "failed";
    const msg =
        newStatus === "failed"
            ? "هل أنت متأكد من إقصاء هذا العضو؟ سيظهر له شاشة Game Over وتُغلق أمامه المهام."
            : "هل أنت متأكد من إعادة إحياء هذا العضو؟ سيعود للمنطقة الخضراء ليبدأ من جديد.";

    if (await CustomDialog.confirm(msg, "تغيير حالة العضو")) {
        try {
            let updateData = { challengeStatus: newStatus };

            // 🛑 حقن كود العفو العام المطابق تماماً لكودك القديم الدقيق
            if (newStatus === "active") {
                const now = new Date();
                const cairoTimeStr = now.toLocaleString("en-US", {
                    timeZone: "Africa/Cairo",
                });
                const cairoDate = new Date(cairoTimeStr);
                cairoDate.setDate(cairoDate.getDate() - 1); // نرجعه للأمس

                const year = cairoDate.getFullYear();
                const month = String(cairoDate.getMonth() + 1).padStart(2, "0");
                const day = String(cairoDate.getDate()).padStart(2, "0");

                updateData.lastEvalDate = `${year}-${month}-${day}`;
                updateData.currentZone = "green"; // إعادته للمنطقة الخضراء
            }

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
// إعادة ضبط المصنع للجميع (فرمتة V2)
// ==============================
document
    .getElementById("factory-reset-btn")
    ?.addEventListener("click", async () => {
        const isSure = await CustomDialog.confirm(
            "⚠️ تحذير كارثي: هذا الزر سيقوم بتصفير (العملات، الـ XP، نقاط الدورة، الستريك) وإرجاع الجميع لحالة (نشط) في المنطقة الخضراء، وضبط تاريخ آخر تقييم لليوم. هل أنت متأكد 100% أنك تريد مسح كل شيء؟",
            "إعادة ضبط المصنع ☢️",
        );

        if (!isSure) return;

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
            // 🛑 التوليد اليدوي الدقيق للتاريخ كما طلبت لمنع أي أخطاء
            const now = new Date();
            const cairoTimeStr = now.toLocaleString("en-US", {
                timeZone: "Africa/Cairo",
            });
            const cairoDate = new Date(cairoTimeStr);

            const year = cairoDate.getFullYear();
            const month = String(cairoDate.getMonth() + 1).padStart(2, "0");
            const day = String(cairoDate.getDate()).padStart(2, "0");
            const todayStr = `${year}-${month}-${day}`;

            const usersSnap = await getDocs(collection(db, "users"));
            const batch = writeBatch(db); // استخدام Batch لأداء أقوى وأسرع

            usersSnap.forEach((userDoc) => {
                const uData = userDoc.data();
                // if (uData.role === "admin") return; // تجاهل حسابك كأدمن

                const userRef = doc(db, "users", userDoc.id);
                batch.update(userRef, {
                    lifetimeScore: 0,
                    walletCoins: 0,
                    cycleScore: 0,
                    currentStreak: 0,
                    currentZone: "green",
                    currentMultiplier: 1.0,
                    freezeCount: 0,
                    hasDoubleXP: false,
                    usedDoubleXP: false,
                    hasTodoList: false,
                    challengeStatus: "active",
                    lastEvalDate: todayStr, // التاريخ المولد يدوياً وبدقة
                    points: 0, // تصفير النقاط القديمة أيضاً
                });
            });

            await batch.commit();

            await CustomDialog.alert(
                "تمت فرمتة جميع الأعضاء بنجاح. الكل يبدأ من الصفر اليوم.",
                "عملية ناجحة ✅",
            );
            loadUsers();
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
                <button class="action-btn btn-edit" onclick="toggleRedeemCode('${docSnap.id}', ${data.isActive})">${data.isActive ? "تعطيل <i class='fa-solid fa-pause'></i>" : "تفعيل <i class='fa-solid fa-play'></i>"}</button>
                <button class="action-btn btn-delete" onclick="deleteRedeemCode('${docSnap.id}')">حذف <i class='fa-solid fa-trash'></i></button>
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
// نظام بث الإشعارات المخصصة للأدمن
// ==============================
const sendBroadcast = httpsCallable(functions, "sendAdminBroadcast");

document
    .getElementById("send-custom-notif-btn")
    ?.addEventListener("click", async (e) => {
        const title = document.getElementById("notif-title").value.trim();
        const body = document.getElementById("notif-body").value.trim();

        if (!title || !body) {
            return CustomDialog.alert("يجب إدخال عنوان ونص الإشعار أولاً.");
        }

        if (
            await CustomDialog.confirm(
                `هل أنت متأكد من إرسال هذا الإشعار لجميع الجنود؟\n\nالعنوان: ${title}\nالرسالة: ${body}`,
                "تأكيد البث 📢",
            )
        ) {
            const btn = e.target;
            const originalText = btn.innerHTML;
            btn.disabled = true;
            btn.innerHTML = "جاري الإرسال ⏳...";

            try {
                const result = await sendBroadcast({ title, body });
                if (result.data.success) {
                    await CustomDialog.alert(
                        result.data.message,
                        "نجاح الإرسال ✅",
                    );
                    document.getElementById("notif-title").value = "";
                    document.getElementById("notif-body").value = "";
                } else {
                    await CustomDialog.alert(result.data.message, "تنبيه");
                }
            } catch (error) {
                console.error("Broadcast Error:", error);
                await CustomDialog.alert(
                    "فشل الإرسال. تأكد من إعدادات السيرفر أو صلاحياتك كمدير.",
                    "خطأ ❌",
                );
            } finally {
                btn.disabled = false;
                btn.innerHTML = originalText;
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
// 📊 نظام التقرير الاستخباراتي الشامل (V2)
// ==========================================
window.generateComprehensiveReport = async () => {
    const btn = document.getElementById("generate-report-btn");
    if (!btn) return;

    const originalText = btn.innerHTML;
    btn.innerHTML =
        "<i class='fa-solid fa-spinner fa-spin'></i> جاري سحب البيانات الاستخباراتية... ⏳";
    btn.disabled = true;

    try {
        // 1. جلب إعدادات النظام الحالية
        const sysDoc = await getDoc(doc(db, "configs", "system"));
        const currentCycle = sysDoc.exists()
            ? sysDoc.data().currentCycle || 1
            : 1;

        // 2. بناء خريطة المهام (الدنيوية والدينية)
        const allTasksStats = {};

        const tasksSnap = await getDocs(collection(db, "tasks"));
        tasksSnap.forEach((doc) => {
            const data = doc.data();
            allTasksStats[doc.id] = {
                name: data.name,
                category: data.category || "عام",
                type: "دنيوي",
                totalSelections: 0,
            };
        });

        const relTasksSnap = await getDocs(collection(db, "religiousTasks"));
        relTasksSnap.forEach((doc) => {
            const data = doc.data();
            allTasksStats[doc.id] = {
                name: data.title,
                category: "الأساسيات",
                type: "ديني",
                totalSelections: 0,
            };
        });

        // 3. جلب وتحليل بيانات الجنود
        const usersSnap = await getDocs(collection(db, "users"));
        const users = [];
        let globalStats = {
            totalUsers: 0,
            activeUsers: 0,
            failedUsers: 0,
            totalLifetimeXP: 0,
            totalCycleScore: 0,
            totalCoinsInMarket: 0,
            zones: { green: 0, yellow: 0, red: 0 },
        };

        usersSnap.forEach((doc) => {
            const u = doc.data();
            // u.role !== "admin" && u.role !== "tester"
            if (true) {
                users.push({ id: doc.id, ...u });
                globalStats.totalUsers++;

                if (u.challengeStatus === "active") globalStats.activeUsers++;
                if (u.challengeStatus === "failed") globalStats.failedUsers++;

                globalStats.totalLifetimeXP += u.lifetimeScore || 0;
                globalStats.totalCycleScore += u.cycleScore || 0;
                globalStats.totalCoinsInMarket += u.walletCoins || 0;

                const zone = u.currentZone || "green";
                if (globalStats.zones[zone] !== undefined)
                    globalStats.zones[zone]++;
            }
        });

        // 4. تحليل إنجازات آخر 7 أيام فقط (لحماية السيرفر من الانفجار)
        const now = new Date();
        const sevenDaysAgo = new Date(now);
        sevenDaysAgo.setDate(now.getDate() - 7);
        const dateLimitStr = sevenDaysAgo.toLocaleDateString("en-CA", {
            timeZone: "Africa/Cairo",
        });

        for (let user of users) {
            const logsQuery = query(
                collection(db, `users/${user.id}/dailyLogs`),
                where("date", ">=", dateLimitStr),
            );
            const logsSnap = await getDocs(logsQuery);

            logsSnap.forEach((logDoc) => {
                const log = logDoc.data();
                if (log.isFinalized) {
                    // دمج الاختيارات الدنيوية والدينية للمسح
                    const combinedSelections = {
                        ...(log.selections || {}),
                        ...(log.religiousSelections || {}),
                    };

                    for (const [taskId, selection] of Object.entries(
                        combinedSelections,
                    )) {
                        if (allTasksStats[taskId]) {
                            // تحويل الاختيار لمصفوفة لتسهيل الفحص
                            let selArray = Array.isArray(selection)
                                ? selection
                                : [selection];

                            // توافق عكسي للمهام الدينية القديمة (True/False)
                            if (typeof selection === "boolean") {
                                if (selection)
                                    allTasksStats[taskId].totalSelections++;
                            }
                            // إذا اختار أي فهرس أكبر من صفر (صفر هو دائماً الرفض/لم أفعل)
                            else if (selArray.some((val) => val > 0)) {
                                allTasksStats[taskId].totalSelections++;
                            }
                        }
                    }
                }
            });
        }

        // 5. ترتيب البيانات للتقرير
        const top10Cycle = [...users]
            .filter((u) => u.challengeStatus === "active")
            .sort((a, b) => (b.cycleScore || 0) - (a.cycleScore || 0))
            .slice(0, 10);

        const tasksArray = Object.values(allTasksStats).sort(
            (a, b) => b.totalSelections - a.totalSelections,
        );

        // ==========================================
        // 🎨 بناء صفحة التقرير للطباعة
        // ==========================================
        const reportDate = new Date().toLocaleDateString("ar-EG", {
            timeZone: "Africa/Cairo",
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
        });

        let htmlContent = `
            <!DOCTYPE html>
            <html lang="ar" dir="rtl">
            <head>
                <meta charset="UTF-8">
                <title>تقرير المعسكر العسكري - دورة ${currentCycle}</title>
                <style>
                    @import url('https://fonts.googleapis.com/css2?family=Cairo:wght@400;700;900&display=swap');
                    body { font-family: 'Cairo', sans-serif; padding: 40px; color: #111; background: #fff; line-height: 1.6; }
                    h1 { color: #b91c1c; border-bottom: 3px solid #b91c1c; padding-bottom: 10px; text-align: center; font-weight: 900; }
                    h2 { color: #1e3a8a; border-bottom: 2px solid #e5e7eb; padding-bottom: 10px; margin-top: 40px; }
                    .header-info { text-align: center; margin-bottom: 40px; font-weight: bold; color: #4b5563; }
                    .stats-grid { display: flex; flex-wrap: wrap; gap: 15px; margin-bottom: 30px; }
                    .stat-box { flex: 1; min-width: 120px; background: #f9fafb; padding: 15px; border-radius: 8px; text-align: center; border: 1px solid #d1d5db; }
                    .stat-box h4 { margin: 0 0 5px 0; color: #6b7280; font-size: 13px; }
                    .stat-box span { font-size: 22px; font-weight: bold; color: #111827; }
                    table { width: 100%; border-collapse: collapse; margin-bottom: 40px; font-size: 14px; }
                    th, td { padding: 10px; text-align: right; border: 1px solid #d1d5db; }
                    th { background: #e5e7eb; font-weight: bold; color: #1f2937; }
                    tr:nth-child(even) { background-color: #f9fafb; }
                    .zone-green { color: #059669; font-weight: bold; }
                    .zone-yellow { color: #d97706; font-weight: bold; }
                    .zone-red { color: #dc2626; font-weight: bold; }
                    @media print {
                        body { padding: 0; }
                        .page-break { page-break-before: always; }
                    }
                </style>
            </head>
            <body>
                <h1>🛡️ التقرير الاستخباراتي الشامل للمنصة</h1>
                <div class="header-info">
                    <p>الدورة التنافسية الحالية: ${currentCycle} | تاريخ الاستخراج: ${reportDate}</p>
                </div>

                <h2>📊 نظرة عامة على التعداد والاقتصاد</h2>
                <div class="stats-grid">
                    <div class="stat-box"><h4>إجمالي المحاربين</h4><span>${globalStats.totalUsers}</span></div>
                    <div class="stat-box"><h4>الصامدون (Active)</h4><span style="color: #059669;">${globalStats.activeUsers}</span></div>
                    <div class="stat-box"><h4>المُقصون (Failed)</h4><span style="color: #dc2626;">${globalStats.failedUsers}</span></div>
                    <div class="stat-box"><h4>الـ XP المتراكم</h4><span>${globalStats.totalLifetimeXP}</span></div>
                    <div class="stat-box"><h4>العملات في السوق</h4><span>${globalStats.totalCoinsInMarket}</span></div>
                </div>

                <h2>🗺️ التوزيع الديموغرافي للمناطق (Zones)</h2>
                <div class="stats-grid">
                    <div class="stat-box" style="border-color: #059669; background: #ecfdf5;">
                        <h4 style="color: #059669;">المنطقة الخضراء (أمان)</h4>
                        <span class="zone-green">${globalStats.zones.green} جندي</span>
                    </div>
                    <div class="stat-box" style="border-color: #d97706; background: #fffbeb;">
                        <h4 style="color: #d97706;">المنطقة الصفراء (إنذار)</h4>
                        <span class="zone-yellow">${globalStats.zones.yellow} جندي</span>
                    </div>
                    <div class="stat-box" style="border-color: #dc2626; background: #fef2f2;">
                        <h4 style="color: #dc2626;">المنطقة الحمراء (خطر)</h4>
                        <span class="zone-red">${globalStats.zones.red} جندي</span>
                    </div>
                </div>

                <h2>🏆 أفضل 10 جنود في الدورة الحالية (Cycle ${currentCycle})</h2>
                <table>
                    <thead><tr><th>المركز</th><th>الاسم</th><th>نقاط الدورة 🏆</th><th>الـ XP التراكمي ⭐</th><th>الستريك 🔥</th><th>المنطقة</th></tr></thead>
                    <tbody>
                        ${top10Cycle
                            .map((u, i) => {
                                let zoneLabel =
                                    u.currentZone === "red"
                                        ? "<span class='zone-red'>حمراء 🔴</span>"
                                        : u.currentZone === "yellow"
                                          ? "<span class='zone-yellow'>صفراء 🟡</span>"
                                          : "<span class='zone-green'>خضراء 🟢</span>";
                                return `
                            <tr>
                                <td>#${i + 1}</td>
                                <td>${u.name}</td>
                                <td style="font-weight:bold;">${u.cycleScore || 0}</td>
                                <td>${u.lifetimeScore || 0}</td>
                                <td>${u.currentStreak || 0}</td>
                                <td>${zoneLabel}</td>
                            </tr>
                        `;
                            })
                            .join("")}
                    </tbody>
                </table>

                <div class="page-break"></div>

                <h2>📋 تحليل أداء المهام (لآخر 7 أيام فقط)</h2>
                <p style="color: #4b5563; font-size: 13px;">* المهام في الأعلى يسهل إنجازها، والمهام في الأسفل يتجنبها الجنود (راجع توزيع النقاط بناءً على هذا الجدول).</p>
                <table>
                    <thead><tr><th>الترتيب</th><th>اسم المهمة</th><th>النوع</th><th>القسم</th><th>مرات الإنجاز</th></tr></thead>
                    <tbody>
                        ${tasksArray
                            .map(
                                (t, i) => `
                            <tr>
                                <td>${i + 1}</td>
                                <td><strong>${t.name}</strong></td>
                                <td style="color: ${t.type === "ديني" ? "#10b981" : "#6b7280"}; font-weight: bold;">${t.type}</td>
                                <td>${t.category}</td>
                                <td>${t.totalSelections} مرة</td>
                            </tr>
                        `,
                            )
                            .join("")}
                    </tbody>
                </table>

                <script>
                    window.onload = function() { setTimeout(() => window.print(), 500); }
                </script>
            </body>
            </html>
        `;

        // 6. فتح التقرير في نافذة جديدة
        const printWindow = window.open("", "_blank");
        printWindow.document.write(htmlContent);
        printWindow.document.close();
    } catch (error) {
        console.error("Error generating report:", error);
        await CustomDialog.alert(
            "حدث خطأ أثناء سحب البيانات. راجع الكونسول للتفاصيل.",
            "خطأ تقني ❌",
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
    const categoryDatalist = document.getElementById("category-list"); // القائمة الجديدة

    if (!filterSelect) return;

    const currentSelection = filterSelect.value;

    try {
        const snap = await getDocs(collection(db, "tasks"));
        const categories = new Set();

        snap.forEach((doc) => {
            const data = doc.data();
            const cat =
                data.category && data.category.trim() !== ""
                    ? data.category.trim()
                    : "مهام عامة";
            categories.add(cat);
        });

        filterSelect.innerHTML = '<option value="all">كل الأقسام</option>';
        if (categoryDatalist) categoryDatalist.innerHTML = "";

        categories.forEach((category) => {
            // إضافة الخيار للفلتر
            const option = document.createElement("option");
            option.value = category;
            option.innerText = category;
            filterSelect.appendChild(option);

            // إضافة الخيار للـ Datalist للإكمال التلقائي
            if (categoryDatalist) {
                const dlOption = document.createElement("option");
                dlOption.value = category;
                categoryDatalist.appendChild(dlOption);
            }
        });

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
                <button class="action-btn btn-edit" style="background: #f59e0b; border: none;" onclick="editReligiousTask('${docSnap.id}')">تعديل <i class="fa-solid fa-edit"></i></button>
                <button class="action-btn btn-delete" onclick="deleteReligiousTask('${docSnap.id}')">حذف <i class="fa-solid fa-trash"></i></button>
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
        row.className = "option-row-wrapper";
        row.innerHTML = `
        <div style="flex-grow: 1;"><input type="text" class="rel-opt-name admin-input" placeholder="اسم الخيار الإضافي" style="margin: 0;"></div>
        <button class="remove-rel-opt-btn btn-icon" style="background: rgba(239, 68, 68, 0.15); color: var(--danger); border: 1px solid var(--danger);"><i class="fa-solid fa-trash"></i></button>
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

        const optionRows = document.querySelectorAll(
            "#rel-options-container .option-row-wrapper",
        );
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
            btn.innerHTML = editingRelTaskId
                ? "تحديث المهمة <i class='fa-solid fa-pen-to-square'></i>"
                : "حفظ المهمة الدينية <i class='fa-solid fa-save'></i>";
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
                row.className = "option-row-wrapper";
                row.innerHTML = `
                    <div style="flex-grow: 1;"><input type="text" class="rel-opt-name admin-input" value="${opt.name}" style="margin: 0;"></div>
                    <button class="remove-rel-opt-btn btn-icon" style="background: rgba(239, 68, 68, 0.15); color: var(--danger); border: 1px solid var(--danger);"><i class="fa-solid fa-trash"></i></button>
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
        btn.innerHTML =
            "تحديث المهمة <i class='fa-solid fa-pen-to-square'></i>";
        btn.style.background = "#f59e0b";

        let cancelBtn = document.getElementById("cancel-rel-edit-btn");
        if (!cancelBtn) {
            cancelBtn = document.createElement("button");
            cancelBtn.id = "cancel-rel-edit-btn";
            cancelBtn.innerHTML = "إلغاء <i class='fa-solid fa-xmark'></i>";
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
        <div class="option-row-wrapper">
            <div style="flex-grow: 1;"><input type="text" class="rel-opt-name admin-input" placeholder="اسم الخيار" style="margin: 0;"></div>
        </div>`;

    const btn = document.getElementById("add-rel-task-btn");
    btn.innerHTML = "حفظ المهمة الدينية <i class='fa-solid fa-save'></i>";
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

// ==========================================
// 👁️ محرك رادار المراقبة (AI Audit Radar)
// ==========================================

// تعيين تاريخ اليوم كقيمة افتراضية عند تحميل الصفحة
document.addEventListener("DOMContentLoaded", () => {
    const today = new Date().toLocaleDateString("en-CA", {
        timeZone: "Africa/Cairo",
    });
    const dateInput = document.getElementById("radar-date-input");
    if (dateInput) dateInput.value = today;
});

// دالة تكبير الصور
window.enlargeRadarImage = function (url) {
    const overlay = document.getElementById("image-enlarge-overlay");
    const img = document.getElementById("enlarged-radar-image");
    if (overlay && img) {
        img.src = url;
        overlay.classList.add("show");
    }
};

// محرك سحب البيانات
document
    .getElementById("fetch-radar-btn")
    ?.addEventListener("click", async () => {
        const dateStr = document.getElementById("radar-date-input").value;
        if (!dateStr) return CustomDialog.alert("يرجى تحديد تاريخ أولاً.");

        const btn = document.getElementById("fetch-radar-btn");
        const originalText = btn.innerHTML;
        btn.innerHTML =
            "<i class='fa-solid fa-spinner fa-spin'></i> جاري المسح...";
        btn.disabled = true;

        const dopContainer = document.getElementById(
            "radar-dopamine-container",
        );
        const uncContainer = document.getElementById(
            "radar-unchaining-container",
        );

        dopContainer.innerHTML =
            "<p style='color: var(--gold-primary); text-align: center; grid-column: 1/-1;'>جاري سحب تقارير الدوبامين... ⏳</p>";
        uncContainer.innerHTML =
            "<p style='color: var(--danger); text-align: center; grid-column: 1/-1;'>جاري سحب تقارير فك القيود... ⏳</p>";

        try {
            const usersSnap = await getDocs(collection(db, "users"));
            const promises = [];
            const usersMap = {};

            let dopCardsHtml = "";
            let uncCardsHtml = "";

            // تجهيز مصفوفة الوعود (Promises) لسحب سجلات اليوم المحدد لكل جندي بصورة متوازية وسريعة
            usersSnap.forEach((userDoc) => {
                const uData = userDoc.data();
                //uData.role !== "admin" && uData.role !== "tester"
                if (true) {
                    usersMap[userDoc.id] = {
                        name: uData.name,
                        email: uData.email,
                        unchainingData: uData,
                    };

                    const logRef = doc(
                        db,
                        `users/${userDoc.id}/dailyLogs`,
                        dateStr,
                    );
                    promises.push(
                        getDoc(logRef).then((snap) => ({
                            snap,
                            uid: userDoc.id,
                        })),
                    );
                }
            });

            const logsResults = await Promise.all(promises);

            logsResults.forEach((result) => {
                const user = usersMap[result.uid];

                // ==========================================
                // 1. النظام القديم (لضمان عدم ضياع الصور السابقة)
                // ==========================================
                if (
                    user.unchainingData &&
                    user.unchainingData.unchainingTimestamp
                ) {
                    // استخراج التاريخ من الصيغة القديمة (مثال: 2026-06-05T01:55:00)
                    const uncDate =
                        user.unchainingData.unchainingTimestamp.split("T")[0];
                    if (
                        uncDate === dateStr &&
                        user.unchainingData.lastUnchainingProof
                    ) {
                        uncCardsHtml += `
                        <div class="glass-card" style="padding: 15px; border-color: #10b981; background: rgba(16, 185, 129, 0.05);">
                            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px;">
                                <div>
                                    <h4 style="color: white; margin: 0; font-size: 15px;">${user.name}</h4>
                                    <span style="font-size: 11px; color: var(--text-muted);">${user.email}</span>
                                </div>
                                <span class="badge" style="background: rgba(16, 185, 129, 0.2); color: #10b981;">قُبل وفُك قيده ✅ (قديم)</span>
                            </div>
                            <img src="${user.unchainingData.lastUnchainingProof}" onclick="enlargeRadarImage('${user.unchainingData.lastUnchainingProof}')" style="width: 100%; height: 180px; object-fit: cover; object-position: top; border-radius: 8px; border: 1px solid #10b981; cursor: zoom-in; margin-bottom: 10px;">
                        </div>
                    `;
                    }
                }

                // ==========================================
                // 2. النظام الجديد (السجلات اليومية والمرفوضين)
                // ==========================================
                if (result.snap.exists()) {
                    const logData = result.snap.data();

                    // معالجة تقارير فك القيود (نجاح وفشل)
                    if (
                        logData.unchainingData &&
                        logData.unchainingData.proofImageUrl
                    ) {
                        const unc = logData.unchainingData;
                        const isAccepted = unc.status === "accepted";

                        const badgeHtml = isAccepted
                            ? `<span class="badge" style="background: rgba(16, 185, 129, 0.2); color: #10b981;">قُبل وفُك قيده ✅</span>`
                            : `<span class="badge" style="background: rgba(220, 38, 38, 0.2); color: #dc2626;">رفضه القاضي ❌</span>`;

                        uncCardsHtml += `
                        <div class="glass-card" style="padding: 15px; border-color: ${isAccepted ? "#10b981" : "var(--danger)"}; background: ${isAccepted ? "rgba(16, 185, 129, 0.05)" : "rgba(220, 38, 38, 0.05)"};">
                            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px;">
                                <div>
                                    <h4 style="color: white; margin: 0; font-size: 15px;">${user.name}</h4>
                                    <span style="font-size: 11px; color: var(--text-muted);">${user.email}</span>
                                </div>
                                ${badgeHtml}
                            </div>
                            
                            <img src="${unc.proofImageUrl}" onclick="enlargeRadarImage('${unc.proofImageUrl}')" style="width: 100%; height: 180px; object-fit: cover; object-position: top; border-radius: 8px; border: 1px solid ${isAccepted ? "#10b981" : "var(--danger)"}; cursor: zoom-in; margin-bottom: 10px;">
                            
                            <div style="background: rgba(0,0,0,0.3); padding: 10px; border-radius: 8px; margin-bottom: 10px; font-size: 13px;">
                                <strong style="color: ${isAccepted ? "#10b981" : "var(--danger)"}; display: block; margin-bottom: 5px;">تعليق القاضي الآلي:</strong>
                                <div style="color: white; max-height: 60px; overflow-y: auto; line-height: 1.4;">"${unc.message || "بدون تعليق"}"</div>
                            </div>
                        </div>
                    `;
                    }

                    // معالجة تقارير الدوبامين اليومية
                    if (
                        logData.dopamineData &&
                        logData.dopamineData.proofImageUrl
                    ) {
                        const dop = logData.dopamineData;
                        const isPassed = logData.passed;
                        const statusBadge = isPassed
                            ? `<span class="badge" style="background: rgba(16, 185, 129, 0.2); color: #10b981;">اعتمده القاضي ✅</span>`
                            : `<span class="badge" style="background: rgba(220, 38, 38, 0.2); color: #dc2626;">أسقطه القاضي ❌</span>`;

                        dopCardsHtml += `
                        <div class="glass-card" style="padding: 15px; border-color: ${isPassed ? "#10b981" : "#dc2626"}40;">
                            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px;">
                                <div>
                                    <h4 style="color: var(--gold-primary); margin: 0; font-size: 15px;">${user.name}</h4>
                                    <span style="font-size: 11px; color: var(--text-muted);">${user.email}</span>
                                </div>
                                ${statusBadge}
                            </div>
                            
                            <img src="${dop.proofImageUrl}" onclick="enlargeRadarImage('${dop.proofImageUrl}')" style="width: 100%; height: 180px; object-fit: cover; object-position: top; border-radius: 8px; border: 1px solid var(--border-color); cursor: zoom-in; margin-bottom: 10px;">
                            
                            <div style="background: rgba(0,0,0,0.3); padding: 10px; border-radius: 8px; margin-bottom: 10px; font-size: 13px;">
                                <strong style="color: var(--gold-light); display: block; margin-bottom: 5px;">تبرير الجندي:</strong>
                                <div style="color: white; max-height: 60px; overflow-y: auto; line-height: 1.4;">"${dop.justification || "لم يكتب تبريراً"}"</div>
                            </div>

                            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 12px; background: rgba(255,255,255,0.02); padding: 10px; border-radius: 8px; border: 1px dashed var(--border-color);">
                                <div>
                                    <span style="color: var(--text-muted); display: block;">أبلغ به (شاشة):</span>
                                    <strong style="color: white;">${dop.reportedScreenMinutes || 0} د</strong>
                                </div>
                                <div>
                                    <span style="color: var(--text-muted); display: block;">حسبه الـ AI:</span>
                                    <strong style="color: #f97316;">${dop.aiEvaluatedWastedScreen !== undefined ? dop.aiEvaluatedWastedScreen : "-"} د</strong>
                                </div>
                                <div>
                                    <span style="color: var(--text-muted); display: block;">أبلغ به (Shorts):</span>
                                    <strong style="color: white;">${dop.reportedShortsMinutes || 0} د</strong>
                                </div>
                                <div>
                                    <span style="color: var(--text-muted); display: block;">حسبه الـ AI:</span>
                                    <strong style="color: #f97316;">${dop.aiEvaluatedWastedShorts !== undefined ? dop.aiEvaluatedWastedShorts : "-"} د</strong>
                                </div>
                            </div>
                            <div style="margin-top: 10px; text-align: center; background: rgba(168, 85, 247, 0.1); padding: 5px; border-radius: 6px; color: var(--gold-primary); font-weight: bold; font-size: 13px;">
                                نقاط الدوبامين: +${dop.pointsAwarded || 0}
                            </div>
                        </div>
                    `;
                    }
                }
            });

            dopContainer.innerHTML =
                dopCardsHtml ||
                "<p style='color: var(--text-muted); grid-column: 1/-1; text-align: center;'>لا توجد إثباتات دوبامين مسجلة في هذا التاريخ.</p>";
            uncContainer.innerHTML =
                uncCardsHtml ||
                "<p style='color: var(--text-muted); grid-column: 1/-1; text-align: center;'>لا توجد إثباتات فك قيود مسجلة في هذا التاريخ.</p>";
        } catch (error) {
            console.error("Radar Error:", error);
            CustomDialog.alert(
                "حدث خطأ أثناء تشغيل الرادار. راجع الكونسول.",
                "خطأ ❌",
            );
        } finally {
            btn.innerHTML = originalText;
            btn.disabled = false;
        }
    });

// ==========================================
// 🔥 إدارة بنك تحديات الإرادة (Willpower Challenges)
// ==========================================
let editingWpId = null;

async function loadWillpowerChallenges() {
    const tbody = document.getElementById("willpower-table-body");
    if (!tbody) return;
    tbody.innerHTML =
        "<tr><td colspan='4' style='text-align:center;'>جاري تحميل البنك... ⏳</td></tr>";

    try {
        const snap = await getDocs(collection(db, "willpowerChallenges"));
        tbody.innerHTML = "";

        if (snap.empty) {
            tbody.innerHTML =
                "<tr><td colspan='4' style='text-align:center; color: var(--text-muted);'>البنك فارغ حالياً. أضف تحديات جديدة للجنود.</td></tr>";
            return;
        }

        snap.forEach((docSnap) => {
            const data = docSnap.data();
            const statusBadge = data.isActive
                ? `<span class="badge badge-active" style="background: rgba(16, 185, 129, 0.2); color: #10b981;">متاح للسحب</span>`
                : `<span class="badge badge-inactive" style="background: rgba(239, 68, 68, 0.2); color: #ef4444;">معطل</span>`;

            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td>
                    <strong style="color: var(--gold-primary); font-size: 15px;">${data.title}</strong><br>
                    <span style="font-size: 12px; color: var(--text-muted);">${data.description}</span>
                </td>
                <td>
                    <div style="font-size: 13px;">⭐ XP: <strong style="color:var(--success);">${data.xpReward || 0}</strong></div>
                    <div style="font-size: 13px;">🪙 عملات: <strong style="color:var(--gold-primary);">${data.coinReward || 0}</strong></div>
                </td>
                <td>${statusBadge}</td>
                <td>
                    <div style="display: flex; gap: 5px; flex-wrap: wrap; justify-content: flex-end;">
                        <button class="action-btn btn-edit" style="background: #f59e0b;" onclick="editWillpower('${docSnap.id}')">تعديل <i class="fa-solid fa-edit"></i></button>
                        <button class="action-btn btn-edit" style="background: ${data.isActive ? "#6b7280" : "#10b981"};" onclick="toggleWillpowerStatus('${docSnap.id}', ${data.isActive})">${data.isActive ? "تعطيل <i class='fa-solid fa-pause'></i>" : "تفعيل <i class='fa-solid fa-play'></i>"}</button>
                        <button class="action-btn btn-delete" onclick="deleteWillpower('${docSnap.id}')">حذف <i class="fa-solid fa-trash"></i></button>
                    </div>
                </td>
            `;
            tbody.appendChild(tr);
        });
    } catch (error) {
        console.error("Error loading willpower challenges:", error);
        tbody.innerHTML =
            "<tr><td colspan='4' style='text-align:center; color: var(--danger);'>حدث خطأ أثناء جلب البيانات.</td></tr>";
    }
}

document.getElementById("add-wp-btn")?.addEventListener("click", async () => {
    const title = document.getElementById("wp-title").value.trim();
    const description = document.getElementById("wp-desc").value.trim();
    const xpReward = parseInt(document.getElementById("wp-xp").value);
    const coinReward = parseInt(document.getElementById("wp-coins").value);

    if (!title || !description || isNaN(xpReward) || isNaN(coinReward)) {
        return CustomDialog.alert(
            "يرجى تعبئة جميع الحقول وإدخال أرقام صحيحة للمكافآت.",
        );
    }

    const btn = document.getElementById("add-wp-btn");
    const originalText = btn.innerHTML;
    btn.innerHTML = "جاري الحفظ... ⏳";
    btn.disabled = true;

    try {
        if (editingWpId) {
            await updateDoc(doc(db, "willpowerChallenges", editingWpId), {
                title,
                description,
                xpReward,
                coinReward,
            });
            await CustomDialog.alert("تم تحديث تحدي الإرادة بنجاح!", "نجاح ✅");
        } else {
            await addDoc(collection(db, "willpowerChallenges"), {
                title,
                description,
                xpReward,
                coinReward,
                isActive: true,
                createdAt: new Date(),
            });
            await CustomDialog.alert("تم إضافة التحدي للبنك بنجاح!", "نجاح ✅");
        }
        cancelWpEditMode();
        loadWillpowerChallenges();
    } catch (error) {
        await CustomDialog.alert("حدث خطأ أثناء الحفظ.");
        console.error(error);
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
});

window.editWillpower = async (id) => {
    const docRef = await getDoc(doc(db, "willpowerChallenges", id));
    if (docRef.exists()) {
        const data = docRef.data();
        editingWpId = id;
        document.getElementById("wp-title").value = data.title;
        document.getElementById("wp-desc").value = data.description;
        document.getElementById("wp-xp").value = data.xpReward;
        document.getElementById("wp-coins").value = data.coinReward;

        const btn = document.getElementById("add-wp-btn");
        btn.innerHTML =
            "تحديث التحدي <i class='fa-solid fa-pen-to-square'></i>";
        btn.style.background = "#f59e0b";

        let cancelBtn = document.getElementById("cancel-wp-edit-btn");
        if (!cancelBtn) {
            cancelBtn = document.createElement("button");
            cancelBtn.id = "cancel-wp-edit-btn";
            cancelBtn.innerHTML = "إلغاء <i class='fa-solid fa-xmark'></i>";
            cancelBtn.style.cssText =
                "background: transparent; color: var(--danger); border: 1px solid var(--danger); padding: 12px 20px; border-radius: 8px; cursor: pointer; flex-grow: 1;";
            cancelBtn.onclick = cancelWpEditMode;
            document.getElementById("wp-btn-container").appendChild(cancelBtn);
        }
        cancelBtn.style.display = "flex";
        cancelBtn.style.justifyContent = "center";

        document
            .getElementById("willpower-page")
            .scrollIntoView({ behavior: "smooth" });
    }
};

function cancelWpEditMode() {
    editingWpId = null;
    document.getElementById("wp-title").value = "";
    document.getElementById("wp-desc").value = "";
    document.getElementById("wp-xp").value = "";
    document.getElementById("wp-coins").value = "";

    const btn = document.getElementById("add-wp-btn");
    btn.innerHTML = "حفظ التحدي في البنك <i class='fa-solid fa-save'></i>";
    btn.style.background = ""; // يرجع للون الذهبي

    const cancelBtn = document.getElementById("cancel-wp-edit-btn");
    if (cancelBtn) cancelBtn.style.display = "none";
}

window.toggleWillpowerStatus = async (id, currentStatus) => {
    await updateDoc(doc(db, "willpowerChallenges", id), {
        isActive: !currentStatus,
    });
    loadWillpowerChallenges();
};

window.deleteWillpower = async (id) => {
    if (
        await CustomDialog.confirm(
            "هل أنت متأكد من حذف هذا التحدي نهائياً من البنك؟",
            "حذف التحدي ❌",
        )
    ) {
        await deleteDoc(doc(db, "willpowerChallenges", id));
        loadWillpowerChallenges();
    }
};
