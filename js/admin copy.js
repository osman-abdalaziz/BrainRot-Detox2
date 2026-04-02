import { auth, db, storage } from "./firebase-config.js";
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
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import {
    ref,
    uploadBytes,
    getDownloadURL,
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js";

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

            // تفعيل الأنيميشن
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

onAuthStateChanged(auth, async (user) => {
    if (user) {
        const userDoc = await getDoc(doc(db, "users", user.uid));
        if (!userDoc.exists() || userDoc.data().role !== "admin") {
            window.location.href = "dashboard.html";
        } else {
            loadCodes();
            loadTasks();
            loadCurrentChallenge();
            loadUsers();
        }
    } else {
        window.location.href = "index.html";
    }
});

document.getElementById("logout-btn").addEventListener("click", () => {
    signOut(auth).then(() => (window.location.href = "index.html"));
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
// إدارة المهام
// ==============================
async function loadTasks() {
    const tbody = document.getElementById("tasks-table-body");
    tbody.innerHTML = "";
    const snap = await getDocs(collection(db, "tasks"));
    snap.forEach((docSnap) => {
        const data = docSnap.data();
        let optionsHtml =
            '<ul style="list-style: none; padding: 0; margin: 0; font-size: 13px;">';
        if (data.options && data.options.length > 0) {
            data.options.forEach(
                (opt) =>
                    (optionsHtml += `<li style="margin-bottom: 5px;">- ${opt.name}: <span class="gold-text" style="font-weight:bold;">${opt.points}</span> نقطة</li>`),
            );
        } else {
            optionsHtml += `<li>مهمة قديمة: <span class="gold-text" style="font-weight:bold;">${data.points}</span> نقطة</li>`;
        }
        optionsHtml += "</ul>";

        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td style="font-weight: bold;">${data.name}</td>
            <td>${optionsHtml}</td>
            <td><span class="badge ${data.isActive ? "badge-active" : "badge-inactive"}">${data.isActive ? "نشط" : "معطل"}</span></td>
            <td>
                <button class="action-btn btn-edit" onclick="toggleTaskStatus('${docSnap.id}', ${data.isActive})">${data.isActive ? "تعطيل" : "تفعيل"}</button>
                <button class="action-btn btn-delete" onclick="deleteTask('${docSnap.id}')">حذف</button>
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

document.getElementById("add-task-btn").addEventListener("click", async () => {
    const name = document.getElementById("task-name").value.trim();
    if (!name)
        return await CustomDialog.alert("يرجى إدخال اسم المهمة الأساسي.");

    const optionRows = document.querySelectorAll(".option-row");
    const options = [{ name: "لم أقم بها (0 نقطة)", points: 0 }];
    let hasError = false;

    optionRows.forEach((row) => {
        const optName = row.querySelector(".opt-name").value.trim();
        const optPoints = parseInt(row.querySelector(".opt-points").value);
        if (optName && !isNaN(optPoints))
            options.push({ name: optName, points: optPoints });
        else if (optName || !isNaN(optPoints)) hasError = true;
    });

    if (hasError)
        return await CustomDialog.alert("يرجى تعبئة بيانات الخيارات بالكامل.");
    if (options.length === 1)
        return await CustomDialog.alert(
            "يجب إضافة خيار واحد على الأقل للمهمة.",
        );

    const btn = document.getElementById("add-task-btn");
    btn.innerText = "جاري الحفظ...";
    btn.disabled = true;

    try {
        await addDoc(collection(db, "tasks"), {
            name: name,
            options: options,
            isActive: true,
            createdAt: new Date(),
        });
        document.getElementById("task-name").value = "";
        document.getElementById("options-container").innerHTML = `
            <div class="option-row" style="display: flex; gap: 10px; margin-bottom: 10px;">
                <input type="text" class="opt-name" placeholder="اسم الخيار (مثال: في المسجد)" style="margin: 0; flex-grow: 2;">
                <input type="number" class="opt-points" placeholder="النقاط (مثال: 20)" style="margin: 0; flex-grow: 1;">
            </div>
        `;
        loadTasks();
    } catch (error) {
        await CustomDialog.alert("حدث خطأ أثناء حفظ المهمة.");
    } finally {
        btn.innerText = "حفظ المهمة بالكامل";
        btn.disabled = false;
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
        if (data.role === "admin") return;
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
                <div style="display: flex; gap: 5px; justify-content: flex-end;">
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

// دالة تعديل الستريك يدوياً
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
            loadUsers(); // تحديث الجدول
            await CustomDialog.alert("تم تحديث الستريك بنجاح!", "نجاح");
        } catch (error) {
            await CustomDialog.alert("حدث خطأ أثناء تحديث الستريك.");
        }
    }
};

window.toggleUserStatus = async (uid, currentStatus) => {
    const newStatus = currentStatus === "failed" ? "active" : "failed";
    const msg =
        newStatus === "failed"
            ? "هل أنت متأكد من إقصاء هذا العضو؟ سيظهر له شاشة Game Over."
            : "هل أنت متأكد من إعادة إحياء هذا العضو ليعود للتحدي؟";
    if (await CustomDialog.confirm(msg, "تغيير حالة العضو")) {
        try {
            await updateDoc(doc(db, "users", uid), {
                challengeStatus: newStatus,
            });
            loadUsers();
        } catch (error) {
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
