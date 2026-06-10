// ==========================================
// 1. نظام الدخول والخروج الصارم
// ==========================================
window.enterStudyRoom = async function (roomId) {
    if (activeRoomId) return; // منع الدخول لغرفتين في نفس الوقت
    activeRoomId = roomId;
    localStorage.setItem("activeStudyRoomId", roomId);

    // التبديل الإجباري للواجهة
    document
        .getElementById("lobby-view")
        .style.setProperty("display", "none", "important");
    document
        .getElementById("active-room-view")
        .style.setProperty("display", "block", "important");

    const roomRef = dbRef(rtdb, `study_rooms/${roomId}`);
    activeRoomListener = roomRef; // حفظ المسار لقتله لاحقاً

    // تسجيل الحضور (وإزالة العضو عند انقطاع الإنترنت)
    // استدعاء الاسم الحقيقي للمستخدم من قاعدة البيانات
    const userDocRef = doc(db, "users", currentUser.uid);
    const userSnap = await getDoc(userDocRef);
    const realName = userSnap.exists() ? userSnap.data().name : "مستخدم";
    const realAvatar = userSnap.exists()
        ? userSnap.data().photoURL
        : "images/profile.webp";

    const myPresenceRef = dbRef(
        rtdb,
        `study_rooms/${roomId}/participants/${currentUser.uid}`,
    );
    onDisconnect(myPresenceRef).remove();
    await set(myPresenceRef, {
        name: realName,
        avatar: realAvatar || "images/profile.webp",
        isOnline: true,
    });

    // إضافة مراقب التركيز (Visibility Change)
    const handleVisibilityChange = () => {
        if (activeRoomId) {
            const focusRef = dbRef(
                rtdb,
                `study_rooms/${activeRoomId}/participants/${currentUser.uid}/isFocused`,
            );
            set(focusRef, document.visibilityState === "visible");
        }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    // الرادار اللحظي للغرفة
    onValue(roomRef, (snapshot) => {
        if (!snapshot.exists()) {
            // الغرفة تم مسحها (تُنفذ مرة واحدة فقط لجميع الأعضاء ما عدا الهوست)
            leaveRoom(true);
            return;
        }
        renderRoomUI(snapshot.val());
    });

    listenToRoomChat(roomId);
};

// دالة المغادرة (تم إصلاح شبح المستخدم وإلغاء الرادار)
window.leaveRoom = async function (isKicked = false) {
    if (!activeRoomId) return;

    // 1. إيقاف العداد والرادار فوراً لمنع التكرار (50 ألف Popup)
    if (roomTimerInterval) clearInterval(roomTimerInterval);
    if (activeRoomListener) off(activeRoomListener);

    // 2. مسح المستخدم من الغرفة في السيرفر (يحل مشكلة شبح المستخدم)
    if (!isKicked) {
        const myPresenceRef = dbRef(
            rtdb,
            `study_rooms/${activeRoomId}/participants/${currentUser.uid}`,
        );
        await remove(myPresenceRef).catch((e) =>
            console.log("Ignore error on delete"),
        );
    }

    // 3. تنظيف الواجهة والذاكرة
    activeRoomId = null;
    activeRoomListener = null;
    localStorage.removeItem("activeStudyRoomId");
    document.getElementById("room-messages").innerHTML = "";
    lastPlayedPhaseId = null; // تصفير ذاكرة الأصوات
    // 4. العودة للوبي
    document
        .getElementById("active-room-view")
        .style.setProperty("display", "none", "important");
    document
        .getElementById("lobby-view")
        .style.setProperty("display", "block", "important");
    if (typeof listenToLobby === "function") listenToLobby();
    if (isKicked) {
        CustomDialog.alert("تم إنهاء الغرفة من قبل القائد.", "انتهت الجلسة");
    }
};

// ==========================================
// 2. محرك الواجهة والصلاحيات
// ==========================================
window.renderRoomUI = function (room) {
    document.getElementById("active-room-title").innerText =
        `${room.title} (جلسة ${room.currentSessionIndex || 0}/${room.totalSessions})`;

    // إصلاح خطأ [object Object] (حساب الطول الصحيح للـ Object)
    const participantsCount = room.participants
        ? Object.keys(room.participants).length
        : 0;

    // الحماية الصارمة: من هو القائد؟
    const isHost = room.hostUid === currentUser.uid;
    const hostControls = document.getElementById("room-host-controls");
    const startBtn = document.getElementById("start-session-btn");
    const pauseBtn = document.getElementById("pause-session-btn"); // تعريف الزر

    if (isHost) {
        hostControls.style.display = "flex";
        startBtn.style.display =
            room.status === "waiting" || room.status === "finished"
                ? "block"
                : "none";

        // منطق ظهور زر الإيقاف المؤقت
        if (room.status === "studying" || room.status === "break") {
            pauseBtn.style.display = "block";
            if (room.isPaused) {
                pauseBtn.innerHTML = '<i class="fa-solid fa-play"></i> استئناف';
                pauseBtn.style.background = "rgba(16, 185, 129, 0.2)";
                pauseBtn.style.color = "#10b981";
            } else {
                pauseBtn.innerHTML =
                    '<i class="fa-solid fa-pause"></i> إيقاف مؤقت';
                pauseBtn.style.background = "rgba(245, 158, 11, 0.2)";
                pauseBtn.style.color = "#f59e0b";
            }
        } else {
            pauseBtn.style.display = "none";
        }
    } else {
        hostControls.style.display = "none";
    }

    document.getElementById("active-room-title").innerText = room.title;
    document.getElementById("active-room-session-badge").innerText =
        `جلسة ${room.currentSessionIndex || 0}/${room.totalSessions}`;

    // رسم قائمة المتواجدين (الملك للهوست فقط)
    const list = document.getElementById("room-participants-list");
    list.innerHTML = "";
    let realParticipantsCount = 0; // 1. إنشاء العداد الحقيقي
    if (room.participants) {
        Object.keys(room.participants).forEach((uid) => {
            const p = room.participants[uid];
            // 🛑 الحل القطعي: فلترة الأشباح (إذا كان العضو لا يملك اسماً، تجاهله ولا ترسمه)
            if (!p || !p.name) return;
            realParticipantsCount++; // 2. زيادة العداد الحقيقي

            const isHost = room.hostUid === uid; // فحص صارم عن طريق الـ ID وليس الاسم
            // المنطق الجديد: أخضر لو مركز، أحمر لو يلهو، رمادي لو أوفلاين
            let statusColor = "#9ca3af"; // رمادي افتراضي
            if (p.isOnline) {
                statusColor = p.isFocused !== false ? "#10b981" : "#ef4444";
            }
            list.innerHTML += `
                <div style="display: flex; align-items: center; gap: 10px; background: rgba(255,255,255,0.05); padding: 8px; border-radius: 8px;">
                    <div style="position: relative; display: flex; align-items: center; justify-content: flex-start;">
                        <img src="${p.avatar}" style="width: 30px; height: 30px; border-radius: 50%; object-fit: cover;">
                        <div style="position: absolute; top: -2px; right: -1px; width: 12px; height: 12px; background: ${statusColor}; border-radius: 50%; border: 2px solid #000;"></div>
                    </div>
                    <span style="font-size: 13px; color: ${p.isOnline ? "#fff" : "var(--text-muted)"}">${p.name} ${isHost ? "👑" : ""}</span>
                </div>
            `;
        });
    }

    // تحديث عدد المتواجدين في الغرفة
    document.getElementById("current-online-count").innerText =
        realParticipantsCount;

    manageTimerState(room, isHost); // تمرير صلاحية القائد للمؤقت
};

// دالة حذف الغرفة للقائد (تحل مشكلة الغرفة الـ undefined)
window.deleteRoom = async function () {
    if (!activeRoomId) return;
    const isSure = await CustomDialog.confirm(
        "هل أنت متأكد من إنهاء الغرفة وطرد الجميع؟",
        "تأكيد إنهاء الغرفة",
    );
    if (!isSure) return;

    try {
        const refToDelete = dbRef(rtdb, `study_rooms/${activeRoomId}`);
        // عند مسح الغرفة، كل الأعضاء سيصلهم snapshot فارغ ويتم طردهم عبر leaveRoom(true)
        await remove(refToDelete);
        leaveRoom(false); // خروج الهوست نفسه
    } catch (error) {
        console.error("Delete room error:", error);
    }
};

// ==========================================
// 3. محرك الوقت المتزامن (Sync Timer)
// ==========================================
window.startRoomTimer = async function () {
    if (!activeRoomId) return;
    const roomRef = dbRef(rtdb, `study_rooms/${activeRoomId}`);
    const snap = await rtdbGet(roomRef);
    const room = snap.val();
    if (!room || room.hostUid !== currentUser.uid) return;

    const now = Date.now();
    const phaseEndTime = now + room.sessionDuration * 60 * 1000;

    // المنطق الجديد: إذا كانت الغرفة منتهية بالفعل، نبدأ الجلسة التالية (Current + 1)
    let nextSessionIndex = 1;
    if (room.status === "finished") {
        nextSessionIndex = (room.currentSessionIndex || 0) + 1;
        // فحص أمان: لا تبدأ إذا لم يقم الهوست بزيادة عدد الجلسات أولاً
        if (nextSessionIndex > room.totalSessions) {
            return CustomDialog.alert(
                "يجب زيادة 'عدد الجلسات الكلي' من الإعدادات أولاً لتتمكن من البدء مجدداً.",
                "تنبيه",
            );
        }
    }

    await update(roomRef, {
        status: "studying",
        currentSessionIndex: nextSessionIndex,
        phaseEndTime: phaseEndTime,
        isPaused: false,
        pausedRemainingTime: null,
    });
};

function manageTimerState(room, isHost) {
    if (roomTimerInterval) clearInterval(roomTimerInterval);

    const timerStatus = document.getElementById("timer-status");
    const timerDisplay = document.getElementById("main-timer");
    const chatOverlay = document.getElementById("chat-lock-overlay");
    const chatOverlayText = chatOverlay.querySelector("h4");

    // 1. نظام الشات الصارم: مقفول دائماً في الدراسة، ويقفل أيضاً لو تم إيقاف البريك مؤقتاً
    if (room.status === "waiting" || room.status === "done") {
        chatOverlay.style.display = "none";
    } else if (room.status === "break") {
        chatOverlay.style.display = room.isPaused ? "flex" : "none";
    } else {
        chatOverlay.style.display = "flex";
    }

    const currentPhaseId = `${room.status}_${room.currentSessionIndex || 0}`;

    // 2. تحديث النصوص بناءً على حالة الإيقاف
    if (room.status === "waiting") {
        timerStatus.innerText = "في انتظار القائد لبدء الجلسة...";
        timerStatus.style.color = "var(--text-muted)";
        timerDisplay.innerText = "00:00";
        lastPlayedPhaseId = "waiting";
        return;
    } else if (room.status === "studying") {
        if (room.isPaused) {
            timerStatus.innerText = "⏸️ الجلسة متوقفة مؤقتاً...";
            timerStatus.style.color = "var(--text-muted)";
            if (chatOverlayText)
                chatOverlayText.innerText = "الشات مغلق (الجلسة متوقفة) ⏸️";
        } else {
            timerStatus.innerText = "وقت التركيز.. ممنوع الكلام! 🤫";
            timerStatus.style.color = "var(--gold-primary)";
            if (chatOverlayText)
                chatOverlayText.innerText = "وقت التركيز جاري 🤫";
            hasAnnouncedCompletion = false;
            lastPlayedPhaseId = currentPhaseId;
        }
    } else if (room.status === "break") {
        if (room.isPaused) {
            timerStatus.innerText = "⏸️ الاستراحة متوقفة مؤقتاً...";
            timerStatus.style.color = "var(--text-muted)";
            if (chatOverlayText)
                chatOverlayText.innerText = "الشات مغلق (الجلسة متوقفة) ⏸️";
        } else {
            timerStatus.innerText = "وقت البريك.. خذ نفساً عميقاً ☕";
            timerStatus.style.color = "var(--success)";
            if (lastPlayedPhaseId !== currentPhaseId) {
                new Audio(
                    "https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3",
                )
                    .play()
                    .catch(() => {});
                lastPlayedPhaseId = currentPhaseId;
            }
        }
    } else if (room.status === "finished") {
        timerStatus.innerText = "انتهت جميع الجلسات.. عمل عظيم! 🏆";
        timerStatus.style.color = "var(--success)";
        timerDisplay.innerText = "انتهت";
        chatOverlay.style.display = "none";

        if (!hasAnnouncedCompletion) {
            new Audio(
                "https://cdn.pixabay.com/download/audio/2021/08/04/audio_0625c1539c.mp3?filename=success-1-6297.mp3",
            )
                .play()
                .catch(() => {});
            CustomDialog.alert(
                "مبروك! لقد أتممتم جميع جلسات الدراسة بنجاح. 🔥",
                "انتصار ساحق ⚔️",
            );
            hasAnnouncedCompletion = true;
        }
        return;
    }

    // 3. المحرك الزمني (إما يعرض الوقت المجمد، أو يشغل العداد)
    if (room.isPaused) {
        // رسم الوقت المتجمد والخروج بدون تشغيل (setInterval)
        const remaining = room.pausedRemainingTime || 0;
        const mins = Math.floor(remaining / 60000);
        const secs = Math.floor((remaining % 60000) / 1000);
        timerDisplay.innerText = `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
        return;
    }

    roomTimerInterval = setInterval(() => {
        const remaining = Math.max(0, room.phaseEndTime - Date.now());

        if (remaining <= 0) {
            clearInterval(roomTimerInterval);
            if (isHost) transitionRoomPhase(room); // ملاحظة: لا يمكن أن يعمل هذا أثناء التوقف لأن العداد أصلاً لا يعمل
        }

        const mins = Math.floor(remaining / 60000);
        const secs = Math.floor((remaining % 60000) / 1000);
        timerDisplay.innerText = `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
    }, 1000);
}

async function transitionRoomPhase(room) {
    const roomRef = dbRef(rtdb, `study_rooms/${activeRoomId}`);
    const now = Date.now();

    if (room.status === "studying") {
        if (room.currentSessionIndex >= room.totalSessions) {
            await update(roomRef, { status: "finished" });
        } else {
            await update(roomRef, {
                status: "break",
                phaseEndTime: now + room.breakDuration * 60 * 1000,
            });
        }
    } else if (room.status === "break") {
        await update(roomRef, {
            status: "studying",
            currentSessionIndex: (room.currentSessionIndex || 0) + 1,
            phaseEndTime: now + room.sessionDuration * 60 * 1000,
        });
    }
}

// ==========================================
// 4. رادار اللوبي الاحترافي (بيانات كاملة + أيقونات)
// ==========================================
window.listenToLobby = function () {
    const roomsLobbyGrid = document.getElementById("rooms-lobby-grid");
    if (!roomsLobbyGrid) return;

    const roomsRef = dbRef(rtdb, "study_rooms");

    onValue(roomsRef, (snapshot) => {
        roomsLobbyGrid.innerHTML = "";

        if (!snapshot.exists()) {
            roomsLobbyGrid.innerHTML =
                '<p style="color: var(--text-muted); text-align: center; grid-column: 1 / -1; font-size: 16px; margin-top: 50px;">ليس هنالك غرف الان كن اول من ينشئ غرفه 🚀</p>';
            return;
        }

        const rooms = snapshot.val();
        let validRoomsCount = 0;

        Object.keys(rooms).forEach((roomId) => {
            const room = rooms[roomId];
            if (!room || !room.title) return;

            validRoomsCount++;

            // 1. حسابات الوقت (المنطق الذي أتقناه سابقاً)
            const totalMinutes =
                room.sessionDuration * room.totalSessions +
                room.breakDuration * (room.totalSessions - 1);
            const totalHours = (totalMinutes / 60).toFixed(1);

            // const pCount = room.participants
            //     ? Object.keys(room.participants).length
            //     : 0;

            // 🛑 فلترة الأشباح للوبي: عد الأشخاص الحقيقيين الذين يملكون اسماً فقط
            let pCount = 0;
            if (room.participants) {
                Object.keys(room.participants).forEach((uid) => {
                    if (room.participants[uid] && room.participants[uid].name) {
                        pCount++;
                    }
                });
            }

            // 2. شارة الحالة (Badge)
            let statusBadge = "";
            if (room.status === "waiting") {
                statusBadge = `<span style="position: absolute; top: 10px; left: 10px; background: rgba(16, 185, 129, 0.2); color: #10b981; padding: 3px 8px; border-radius: 6px; font-size: 11px; border: 1px solid rgba(16, 185, 129, 0.3);">في الانتظار <i class="fa-solid fa-circle fa-fw" style="margin-right: 3px;"></i></span>`;
            } else if (room.status === "finished") {
                statusBadge = `<span style="position: absolute; top: 10px; left: 10px; background: rgba(156, 163, 175, 0.2); color: #9ca3af; padding: 3px 8px; border-radius: 6px; font-size: 11px; border: 1px solid rgba(156, 163, 175, 0.3);">انتهت الجلسة <i class="fa-solid fa-circle fa-fw" style="margin-right: 3px;"></i></span>`;
            } else {
                statusBadge = `<span style="position: absolute; top: 10px; left: 10px; background: rgba(244, 63, 94, 0.2); color: #f43f5e; padding: 3px 8px; border-radius: 6px; font-size: 11px; border: 1px solid rgba(244, 63, 94, 0.3);">جلسة جارية <i class="fa-solid fa-circle fa-fw" style="margin-right: 3px;"></i></span>`;
            }
            const roomCard = document.createElement("div");
            roomCard.className = "glass-card";
            roomCard.style.cssText =
                "padding: 18px; border: 1px solid var(--gold-primary); position: relative; transition: transform 0.2s; display: flex; flex-direction: column; justify-content: space-between;";

            // 3. تصميم محتوى الكرت بالأيقونات
            roomCard.innerHTML = `
                ${statusBadge}
                <h3 style="font-size: 18px; margin-bottom: 12px; color: #fff; padding-left: 70px; line-height: 1.4;">${room.title}</h3>
                
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 15px; font-size: 13px; color: var(--text-muted);">
                    <div title="القائد"><i class="fa-solid fa-crown" style="color: var(--gold-primary); width: 18px;"></i> <strong>${room.hostName}</strong></div>
                    <div title="المدة الكلية"><i class="fa-solid fa-hourglass-half" style="color: #a855f7; width: 18px;"></i> ${totalHours} ساعة</div>
                    <div title="نظام الجلسات"><i class="fa-solid fa-fire" style="color: #f97316; width: 18px;"></i> ${room.totalSessions} × ${room.sessionDuration}د</div>
                    <div title="السعة الحالية"><i class="fa-solid fa-users" style="color: #3b82f6; width: 18px;"></i> ${pCount} / ${room.maxUsers}</div>
                </div>

                <button onclick="joinStudyRoom('${roomId}')" class="gold-btn" style="width: 100%; padding: 10px; font-size: 14px; font-weight: bold; margin-top: auto;" ${pCount >= room.maxUsers ? "disabled" : ""}>
                    ${pCount >= room.maxUsers ? '<i class="fa-solid fa-lock"></i> الغرفة ممتلئة' : '<i class="fa-solid fa-shield-halved"></i> انضمام '}
                </button>
            `;

            // تأثير Hover بسيط
            roomCard.onmouseover = () =>
                (roomCard.style.transform = "translateY(-5px)");
            roomCard.onmouseout = () =>
                (roomCard.style.transform = "translateY(0)");

            roomsLobbyGrid.appendChild(roomCard);
        });

        if (validRoomsCount === 0) {
            roomsLobbyGrid.innerHTML =
                '<p style="color: var(--text-muted); text-align: center; grid-column: 1 / -1; font-size: 16px; margin-top: 50px;">ليس هنالك غرف الان كن اول من ينشئ غرفه 🚀</p>';
        }
    });
};

// ==========================================
// 5. أزرار التفاعل (الإنشاء، الانضمام، الشات)
// ==========================================

// دالة إنشاء غرفة جديدة (تخصم الرصيد وتدفعك للغرفة)
document
    .getElementById("confirm-create-room-btn")
    ?.addEventListener("click", async (e) => {
        if (!currentUser || activeRoomId) return;
        const btn = e.target;

        const title = document.getElementById("room-title-input").value.trim();
        const sessionTime =
            parseInt(document.getElementById("room-session-time").value) || 50;
        const breakTime =
            parseInt(document.getElementById("room-break-time").value) || 10;
        const sessionsCount =
            parseInt(document.getElementById("room-sessions-count").value) || 4;
        const maxUsers =
            parseInt(document.getElementById("room-max-users").value) || 5;

        if (!title)
            return CustomDialog.alert("يجب كتابة عنوان للغرفة.", "تنبيه");

        btn.disabled = true;
        btn.innerText = "جاري الإنشاء... ⏳";

        try {
            // سحب البيانات الحقيقية للهوست من Firestore
            const userDocRef = doc(db, "users", currentUser.uid);
            const userDocSnap = await getDoc(userDocRef);
            const userData = userDocSnap.data();

            if ((userData.walletCoins || 0) < 25) {
                btn.disabled = false;
                btn.innerHTML =
                    "إنشاء وخصم 25 <i class='fa-solid fa-coins fa-fw'></i>";
                return CustomDialog.alert(
                    "عملاتك لا تكفي لإنشاء غرفة.",
                    "رصيد غير كافٍ",
                );
            }

            const realName = userData.name || "مستخدم"; // هذا هو الاسم الذي سيظهر في اللوبي

            await updateDoc(userDocRef, { walletCoins: increment(-25) });

            const roomsRef = dbRef(rtdb, "study_rooms");
            const newRoomRef = push(roomsRef);

            await set(newRoomRef, {
                id: newRoomRef.key,
                title: title,
                hostUid: currentUser.uid,
                hostName: realName, // تم استبدال "محارب" بالاسم الحقيقي
                sessionDuration: sessionTime,
                breakDuration: breakTime,
                totalSessions: sessionsCount,
                maxUsers: maxUsers,
                status: "waiting",
                createdAt: serverTimestamp(),
            });

            document
                .getElementById("create-room-modal")
                .classList.remove("show");
            btn.disabled = false;
            btn.innerHTML =
                "إنشاء وخصم 25 <i class='fa-solid fa-coins fa-fw'></i>";

            enterStudyRoom(newRoomRef.key);
        } catch (error) {
            console.error(error);
            btn.disabled = false;
            btn.innerHTML =
                "إنشاء وخصم 25 <i class='fa-solid fa-coins fa-fw'></i>";
        }
    });
// دالة الانضمام للغرفة
window.joinStudyRoom = async function (roomId) {
    if (!currentUser || activeRoomId) return;

    // فحص السعة قبل الدخول
    const roomRef = dbRef(rtdb, `study_rooms/${roomId}`);
    const snap = await rtdbGet(roomRef);
    const room = snap.val();

    if (!room) return CustomDialog.alert("هذه الغرفة لم تعد موجودة.", "خطأ");

    let pCount = 0;
    if (room.participants) {
        Object.keys(room.participants).forEach((uid) => {
            if (room.participants[uid] && room.participants[uid].name) {
                pCount++;
            }
        });
    }
    if (pCount >= room.maxUsers) {
        return CustomDialog.alert("عذراً، الغرفة ممتلئة.", "دخول مرفوض");
    }

    // الدخول التلقائي (دالة enterStudyRoom ستسجله في participants تلقائياً)
    enterStudyRoom(roomId);
};

const chatInput = document.getElementById("chat-input");
chatInput?.addEventListener("keypress", (e) => {
    // إذا ضغط المستخدم Enter (رقم الكود 13)
    if (e.key === "Enter" || e.keyCode === 13) {
        e.preventDefault(); // منع السطر الجديد
        sendRoomMessage();
    }
});
// دالة إرسال رسالة الشات
window.sendRoomMessage = async function () {
    const input = document.getElementById("chat-input");
    const text = input.value.trim();
    if (!text || !activeRoomId) return;

    try {
        // سحب اسم المرسل الحقيقي
        const userDocRef = doc(db, "users", currentUser.uid);
        const userSnap = await getDoc(userDocRef);
        const realName = userSnap.exists() ? userSnap.data().name : "مستخدم";

        const chatRef = dbRef(rtdb, `study_rooms/${activeRoomId}/messages`);
        await push(chatRef, {
            senderName: realName, // الاسم الحقيقي
            senderUid: currentUser.uid,
            text: text,
            timestamp: serverTimestamp(),
        });
        input.value = "";
    } catch (e) {
        console.error(e);
    }
};

// ==========================================
// مصفاة الشات (تحويل الروابط + حماية XSS)
// ==========================================
window.formatChatMessage = function (text, isMe = false) {
    if (!text) return "";

    // 1. تنظيف النص من أي أكواد خبيثة (حماية إجبارية)
    let safeText = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");

    // 2. البحث عن الروابط وتحويلها لأزرار قابلة للضغط
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    return safeText.replace(urlRegex, function (url) {
        // استخدمنا لون أزرق فاتح ليكون واضحاً على الخلفيات الداكنة والبنفسجية
        return `<a href="${url}" target="_blank" style="color: ${isMe ? "#000" : "var(--gold-primary)"}; text-decoration: underline; word-break: break-all; font-weight: bold;">${url}</a>`;
    });
};

// دالة الاستماع للشات (رادار الرسائل)
window.listenToRoomChat = function (roomId) {
    const messagesContainer = document.getElementById("room-messages");
    const chatRef = dbRef(rtdb, `study_rooms/${roomId}/messages`);

    onValue(chatRef, (snapshot) => {
        messagesContainer.innerHTML = "";
        if (snapshot.exists()) {
            const msgs = snapshot.val();

            // استخدام entries بدلاً من values للحصول على الـ ID الخاص بكل رسالة
            Object.entries(msgs).forEach(([msgId, msg]) => {
                const isMe = msg.senderUid === currentUser.uid;
                const msgDiv = document.createElement("div");

                // تنسيق الوقت
                let timeString = "";
                if (msg.timestamp) {
                    const date = new Date(msg.timestamp);
                    timeString = date.toLocaleTimeString("ar-EG", {
                        hour: "2-digit",
                        minute: "2-digit",
                        hour12: true,
                    });
                }

                msgDiv.style.cssText = `
                    padding: 8px 12px 4px 12px; 
                    border-radius: 12px; 
                    max-width: 80%; 
                    font-size: 13px; 
                    margin-bottom: 8px;
                    display: flex;
                    flex-direction: column;
                    box-shadow: 0 2px 5px rgba(0,0,0,0.2);
                    ${isMe ? "align-self: flex-end; background: var(--gold-primary); color: #000; border-bottom-left-radius: 2px;" : "align-self: flex-start; background: rgba(255,255,255,0.1); border-bottom-right-radius: 2px;"}
                `;

                msgDiv.innerHTML = `
                    <div style="margin-bottom: 4px; line-height: 1.4;">
                        ${isMe ? "" : '<strong style="color: var(--gold-primary); margin-bottom: 5px;">' + msg.senderName + "</strong><br> "} ${formatChatMessage(msg.text, isMe)}
                    </div>
                    <div style="user-select: none; font-size: 10px; text-align: ${isMe ? "left" : "right"}; opacity: 0.7; margin-top: -3px;">
                        ${timeString}
                    </div>
                `;

                // إضافة حدث الكليك يمين (أو الضغط المطول) لحذف رسائلك فقط
                if (isMe) {
                    msgDiv.addEventListener("contextmenu", (e) => {
                        e.preventDefault(); // منع ظهور قائمة المتصفح العادية
                        showDeleteContextMenu(e.pageX, e.pageY, msgId);
                    });
                }

                messagesContainer.appendChild(msgDiv);
            });
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }
    });
};

// ==========================================
// دالة تحديث إعدادات الغرفة (Clean & Real-time)
// ==========================================
window.openEditRoomModal = async function () {
    if (!activeRoomId) return;

    try {
        // 1. جلب البيانات الحالية لملء الحقول
        const roomRef = dbRef(rtdb, `study_rooms/${activeRoomId}`);
        const snap = await rtdbGet(roomRef);
        const room = snap.val();

        if (!room) return;

        // 2. تعبئة كافة المدخلات بالقيم الحالية
        document.getElementById("room-title-input").value = room.title;
        document.getElementById("room-session-time").value =
            room.sessionDuration;
        document.getElementById("room-break-time").value = room.breakDuration;
        document.getElementById("room-sessions-count").value =
            room.totalSessions || 4;
        document.getElementById("room-max-users").value = room.maxUsers || 5;

        // 3. تجهيز زر التأكيد
        const confirmBtn = document.getElementById("confirm-create-room-btn");
        confirmBtn.innerText = "تحديث الإعدادات 🛠️";

        // فك أي ارتباط سابق للضغط (لتجنب تكرار العمليات)
        confirmBtn.onclick = null;

        confirmBtn.onclick = async () => {
            const newTitle = document
                .getElementById("room-title-input")
                .value.trim();
            const newSession = parseInt(
                document.getElementById("room-session-time").value,
            );
            const newBreak = parseInt(
                document.getElementById("room-break-time").value,
            );
            const newSessionsCount = parseInt(
                document.getElementById("room-sessions-count").value,
            );
            const newMax = parseInt(
                document.getElementById("room-max-users").value,
            );

            if (!newTitle) return CustomDialog.alert("العنوان مطلوب", "تنبيه");

            confirmBtn.disabled = true;
            confirmBtn.innerText = "جاري الحفظ... ⏳";

            // 4. التحديث في Realtime Database
            const updates = {
                title: newTitle,
                sessionDuration: newSession,
                breakDuration: newBreak,
                totalSessions: newSessionsCount,
                maxUsers: newMax,
            };

            try {
                await update(roomRef, updates); // سيقوم بتحديث الحقول المذكورة فقط

                document
                    .getElementById("create-room-modal")
                    .classList.remove("show");
                confirmBtn.disabled = false;
                confirmBtn.innerText = "تحديث الإعدادات 🛠️";

                // ملاحظة: لا نحتاج لريفريش هنا لأن دالة enterStudyRoom
                // تمتلك مستمع onValue سيقوم بتشغيل renderRoomUI تلقائياً فور الحفظ.
            } catch (err) {
                console.error("Update Error:", err);
                confirmBtn.disabled = false;
            }
        };

        document.getElementById("create-room-modal").classList.add("show");
    } catch (error) {
        console.error("Fetch Room Error:", error);
    }
};
document.getElementById("cancel-room-btn")?.addEventListener("click", () => {
    const modal = document.getElementById("create-room-modal");
    modal.classList.remove("show");
    // إعادة ضبط نص الزر تحسباً للمرة القادمة
    document.getElementById("confirm-create-room-btn").innerHTML =
        `إنشاء وخصم 25 <i class="fa-solid fa-coins fa-fw"></i>`;
});

// ==========================================
// 7. محرك أزرار الإدخال الرقمي والحماية
// ==========================================

// دالة الزيادة والنقصان (مع احترام الحد الأدنى والأقصى)
window.adjustNumberInput = function (inputId, change) {
    const input = document.getElementById(inputId);
    if (!input) return;

    let val = parseInt(input.value) || 0;
    const min = parseInt(input.getAttribute("min")) || 1;
    const max = parseInt(input.getAttribute("max")) || 999;

    val += change;

    if (val < min) val = min;
    if (val > max) val = max;

    input.value = val;
};

// دالة الحماية: منع كتابة أي أحرف والسماح بالأرقام فقط
window.validateNumberInput = function (event) {
    const charCode = event.which ? event.which : event.keyCode;
    // إذا لم يكن الزر المضغوط رقماً (0-9) يتم منعه فوراً
    if (charCode > 31 && (charCode < 48 || charCode > 57)) {
        event.preventDefault();
        return false;
    }
    return true;
};

// الحماية الفورية أثناء الكتابة (يمنع تخطي الحد الأقصى)
window.enforceMaxInput = function (input) {
    let max = parseInt(input.getAttribute("max"));
    let val = parseInt(input.value);

    if (val > max) {
        input.value = max; // إجباره على الحد الأقصى فوراً
    }
};

// الحماية عند الخروج من الحقل (يمنع تركه فارغاً أو أقل من الحد الأدنى)
window.enforceMinBlur = function (input) {
    let min = parseInt(input.getAttribute("min")) || 1;
    let val = parseInt(input.value);

    if (isNaN(val) || val < min) {
        input.value = min; // إجباره على الحد الأدنى
    }
};

// ==========================================
// 9. محرك الإيقاف المؤقت (للصلاة والطوارئ)
// ==========================================
window.togglePauseRoom = async function () {
    if (!activeRoomId) return;
    const roomRef = dbRef(rtdb, `study_rooms/${activeRoomId}`);
    const snap = await rtdbGet(roomRef);
    const room = snap.val();

    if (!room || room.hostUid !== currentUser.uid) return;

    // الإيقاف مسموح فقط أثناء تشغيل المؤقت (الدراسة أو البريك)
    if (room.status !== "studying" && room.status !== "break") return;

    if (room.isPaused) {
        // استئناف الجلسة: صناعة وقت انتهاء جديد بناءً على الوقت المتبقي المجمد
        const newEndTime = Date.now() + (room.pausedRemainingTime || 0);
        await update(roomRef, {
            isPaused: false,
            phaseEndTime: newEndTime,
        });
    } else {
        // إيقاف مؤقت: حساب الوقت المتبقي وتجميده
        const remaining = Math.max(0, room.phaseEndTime - Date.now());
        await update(roomRef, {
            isPaused: true,
            pausedRemainingTime: remaining,
        });
    }
};

// ==========================================
// محرك القائمة المنبثقة وحذف الرسائل
// ==========================================
let currentChatContextMenu = null;

window.showDeleteContextMenu = function (x, y, msgId) {
    // إزالة أي قائمة مفتوحة مسبقاً
    if (currentChatContextMenu) currentChatContextMenu.remove();

    const menu = document.createElement("div");
    menu.className = "chat-context-menu glass-card";

    // ضبط المكان بناءً على الضغطة (مع حماية عدم خروجها عن الشاشة)
    const menuWidth = 140;
    const adjustX = x + menuWidth > window.innerWidth ? x - menuWidth : x;

    menu.style.top = `${y}px`;
    menu.style.left = `${adjustX}px`;

    const deleteBtn = document.createElement("button");
    deleteBtn.innerHTML = 'حذف الرسالة <i class="fa-solid fa-trash"></i>';

    deleteBtn.onclick = async () => {
        menu.remove();
        await deleteChatMessage(msgId);
    };

    menu.appendChild(deleteBtn);
    document.body.appendChild(menu);
    currentChatContextMenu = menu;

    // إغلاق القائمة عند الضغط في أي مكان آخر
    setTimeout(() => {
        const closeMenu = (e) => {
            if (
                currentChatContextMenu &&
                !currentChatContextMenu.contains(e.target)
            ) {
                currentChatContextMenu.remove();
                currentChatContextMenu = null;
            }
            document.removeEventListener("click", closeMenu);
            document.removeEventListener("scroll", closeMenu, true);
        };
        document.addEventListener("click", closeMenu);
        document.addEventListener("scroll", closeMenu, true); // يغلقها لو عمل سكرول للشات
    }, 0);
};

window.deleteChatMessage = async function (msgId) {
    if (!activeRoomId) return;
    try {
        const msgRef = dbRef(
            rtdb,
            `study_rooms/${activeRoomId}/messages/${msgId}`,
        );
        await remove(msgRef); // سيتم الحذف اللحظي وسيقوم رادار onValue بتحديث الشاشة عند الجميع
    } catch (error) {
        console.error("Delete Msg Error:", error);
        CustomDialog.alert("حدث خطأ أثناء الحذف.", "خطأ");
    }
};

// ==========================================
// 10. نظام المؤقت العائم الذكي (Picture in Picture) - النسخة الفولاذية
// ==========================================
function initFloatingTimer() {
    // منع تكرار إنشاء البطاقة
    if (document.getElementById("floating-timer-card")) return;

    // 1. بناء الواجهة زجاجية التصميم برمجياً
    const floatingCard = document.createElement("div");
    floatingCard.id = "floating-timer-card";
    floatingCard.className = "glass-card";
    // استخدام !important لضمان عدم طمسها من أي CSS آخر
    floatingCard.style.cssText = `
        display: none !important; 
        position: fixed !important; 
        bottom: 90px !important; 
        left: 20px !important; 
        z-index: 9999999 !important; 
        width: 170px !important; 
        padding: 12px !important; 
        cursor: grab; 
        flex-direction: column; 
        gap: 10px; 
        box-shadow: 0 10px 40px rgba(0,0,0,0.8) !important; 
        border: 2px solid var(--gold-primary) !important;
        border-radius: 12px !important;
        background: rgba(10, 5, 20, 0.95) !important;
        backdrop-filter: blur(10px);
        touch-action: none;
        user-select: none;
    `;

    floatingCard.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center;">
            <span id="floating-status-icon" style="font-size: 11px; color: var(--gold-primary); font-weight: bold;"><i class="fa-solid fa-stopwatch"></i> جاري التركيز</span>
            <button id="close-floating-btn" style="background: rgba(244, 63, 94, 0.1); border: 1px solid var(--danger); color: var(--danger); cursor: pointer; padding: 2px 6px; border-radius: 6px; transition: 0.2s;"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div id="floating-time-display" style="font-size: 28px; font-weight: 900; text-align: center; color: #fff; letter-spacing: 2px; text-shadow: 0 0 10px rgba(255,255,255,0.3);">00:00</div>
        <button id="return-room-btn" class="gold-btn" style="padding: 6px; font-size: 12px; margin-top: 0;"><i class="fa-solid fa-arrow-right-to-bracket"></i> العودة للغرفة</button>
    `;
    document.body.appendChild(floatingCard);

    let isFloatingClosedByUser = false;

    // 2. أوامر الأزرار
    document.getElementById("close-floating-btn").onclick = () => {
        isFloatingClosedByUser = true;
        floatingCard.style.setProperty("display", "none", "important");
    };

    document.getElementById("return-room-btn").onclick = () => {
        const roomsTabBtn = document.querySelector(
            '[data-target="study-rooms-page"]',
        );
        if (roomsTabBtn) roomsTabBtn.click();

        document
            .getElementById("lobby-view")
            .style.setProperty("display", "none", "important");
        document
            .getElementById("active-room-view")
            .style.setProperty("display", "block", "important");

        isFloatingClosedByUser = false;
        floatingCard.style.setProperty("display", "none", "important");
    };

    // 3. المحرك الصامت (يراقب التغيرات كل نصف ثانية)
    setInterval(() => {
        const roomView = document.getElementById("active-room-view");
        const mainTimer = document.getElementById("main-timer");
        const timerStatus = document.getElementById("timer-status");

        if (!roomView || !mainTimer) return;

        // الحل القطعي لمعرفة هل الغرفة مخفية: إذا كان عرضها 0 فهي مخفية
        const isRoomVisible =
            roomView.offsetWidth > 0 || roomView.offsetHeight > 0;
        const timeText = mainTimer.innerText.trim();

        // التحقق من أن العداد يعمل (ليس صفراً وليس منتهياً ويوجد غرفة نشطة)
        const isTimerActive =
            typeof activeRoomId !== "undefined" &&
            activeRoomId !== null &&
            timeText !== "00:00" &&
            timeText !== "انتهت";

        if (isRoomVisible) {
            // إذا كنت داخل الغرفة -> أخفِ الـ Popup
            isFloatingClosedByUser = false;
            floatingCard.style.setProperty("display", "none", "important");
        } else if (isTimerActive && !isFloatingClosedByUser) {
            // إذا خرجت لصفحة أخرى والعداد يعمل -> أظهر الـ Popup
            floatingCard.style.setProperty("display", "flex", "important");
            document.getElementById("floating-time-display").innerText =
                timeText;

            // تغيير الألوان حسب الحالة (بريك / دراسة)
            const statusIcon = document.getElementById("floating-status-icon");
            if (timerStatus && timerStatus.innerText.includes("البريك")) {
                statusIcon.innerHTML =
                    '<i class="fa-solid fa-mug-hot"></i> وقت البريك';
                statusIcon.style.color = "#10b981";
                floatingCard.style.setProperty(
                    "border-color",
                    "#10b981",
                    "important",
                );
            } else {
                statusIcon.innerHTML =
                    '<i class="fa-solid fa-stopwatch"></i> وقت التركيز';
                statusIcon.style.color = "var(--gold-primary)";
                floatingCard.style.setProperty(
                    "border-color",
                    "var(--gold-primary)",
                    "important",
                );
            }
        } else {
            floatingCard.style.setProperty("display", "none", "important");
        }
    }, 500);

    // 4. محرك السحب والإفلات (يدعم الماوس واللمس)
    let pos1 = 0,
        pos2 = 0,
        pos3 = 0,
        pos4 = 0;

    floatingCard.onmousedown = dragMouseDown;
    floatingCard.ontouchstart = dragTouchStart;

    function dragMouseDown(e) {
        if (e.target.closest("button")) return;
        e.preventDefault();
        pos3 = e.clientX;
        pos4 = e.clientY;
        document.onmouseup = closeDragElement;
        document.onmousemove = elementDrag;
        floatingCard.style.cursor = "grabbing";
    }

    function elementDrag(e) {
        e.preventDefault();
        pos1 = pos3 - e.clientX;
        pos2 = pos4 - e.clientY;
        pos3 = e.clientX;
        pos4 = e.clientY;
        applyNewPosition();
    }

    function dragTouchStart(e) {
        if (e.target.closest("button")) return;
        pos3 = e.touches[0].clientX;
        pos4 = e.touches[0].clientY;
        document.ontouchend = closeDragElement;
        document.ontouchmove = elementTouchDrag;
    }

    function elementTouchDrag(e) {
        pos1 = pos3 - e.touches[0].clientX;
        pos2 = pos4 - e.touches[0].clientY;
        pos3 = e.touches[0].clientX;
        pos4 = e.touches[0].clientY;
        applyNewPosition();
    }

    function applyNewPosition() {
        let newTop = floatingCard.offsetTop - pos2;
        let newLeft = floatingCard.offsetLeft - pos1;

        // حدود الشاشة (لمنع ضياع الـ Popup)
        const maxTop = window.innerHeight - floatingCard.offsetHeight;
        const maxLeft = window.innerWidth - floatingCard.offsetWidth;

        if (newTop < 0) newTop = 0;
        if (newTop > maxTop) newTop = maxTop;
        if (newLeft < 0) newLeft = 0;
        if (newLeft > maxLeft) newLeft = maxLeft;

        floatingCard.style.top = newTop + "px";
        floatingCard.style.left = newLeft + "px";
        floatingCard.style.bottom = "auto";
        floatingCard.style.right = "auto";
    }

    function closeDragElement() {
        document.onmouseup = null;
        document.onmousemove = null;
        document.ontouchend = null;
        document.ontouchmove = null;
        floatingCard.style.cursor = "grab";
    }
}
// استدعاء الدالة لتشغيل النظام فوراً
initFloatingTimer();


-------

// ==========================================
// 2. مستمع زر اعتماد اليوم (النظام الجديد مع تحليل الدوبامين بالـ AI)
// ==========================================
document
    .getElementById("submit-day-btn")
    ?.addEventListener("click", async () => {
        if (!currentUser || isTodayFinalized) return;
        // ==========================================
        // 🛑 جدار الحماية الزمني الديناميكي
        // ==========================================
        const now = getRealNow();
        const cairoTimeStr = now.toLocaleString("en-US", {
            timeZone: "Africa/Cairo",
            hour12: false,
        });
        const cairoDate = new Date(cairoTimeStr);
        const currentHour = cairoDate.getHours();

        const startH = window.submissionStartHour;
        const endH = window.dayStartHour;

        // إذا لم يكن الوقت داخل النافذة (من وقت فتح الاعتماد وحتى وقت نهاية اليوم)
        if (!(currentHour >= startH || currentHour < endH)) {
            // دالة صغيرة لتحويل نظام الـ 24 إلى 12 ساعة لرسالة الخطأ
            const formatHour = (h) => {
                let ampm = h >= 12 ? "مساءً" : "صباحاً";
                let hours12 = h % 12 || 12;
                return `${hours12}:00 ${ampm}`;
            };

            return await CustomDialog.alert(
                `لا يمكنك اعتماد مهام اليوم الآن. نافذة التقييم تفتح فقط من ${formatHour(startH)} وحتى ${formatHour(endH)} بتوقيت القاهرة.`,
                "النافذة مغلقة 🛑",
            );
        }
        // ==========================================
        // // --- 1. التحقق من محلل الدوبامين ---
        // const dopamineData = calculateTotalDopamineTime();
        // if (!dopamineData.isValid) {
        //     return await CustomDialog.alert(
        //         "يجب إدخال وقت الشاشة لجهاز واحد على الأقل لتجاوز الفحص.",
        //         "تنبيه ⚠️",
        //     );
        // }
        // if (dopamineData.files.length === 0) {
        //     return await CustomDialog.alert(
        //         "يجب إرفاق صورة إثبات (Screenshot) لوقت الشاشة. لا يمكن المرور بدونها.",
        //         "إثبات مطلوب 📸",
        //     );
        // }

        // --- 1. التحقق من محلل الدوبامين ---
        const dopamineData = calculateTotalDopamineTime();
        if (!dopamineData.isValid) {
            return await CustomDialog.alert(
                "يجب إدخال وقت الشاشة لجهاز واحد على الأقل لتجاوز الفحص.",
                "تنبيه ⚠️",
            );
        }
        if (dopamineData.files.length === 0) {
            return await CustomDialog.alert(
                "يجب إرفاق صورة إثبات (Screenshot) لوقت الشاشة. لا يمكن المرور بدونها.",
                "إثبات مطلوب 📸",
            );
        }

        const justification = document
            .getElementById("dopamine-justification")
            .value.trim();
        if (!justification) {
            return await CustomDialog.alert(
                "يجب كتابة تبرير لاستهلاكك. كن صادقاً، الذكاء الاصطناعي يحلل كل حرف ولن يتهاون.",
                "التبرير مطلوب ✍️",
            );
        }

        // 🛑 فحص صلاحية كل صورة (التاريخ + الوقت)
        for (let i = 0; i < dopamineData.files.length; i++) {
            const file = dopamineData.files[i];
            const validation = await validateProofImage(file);
            if (!validation.valid) {
                return await CustomDialog.alert(
                    `صورة الجهاز رقم ${i + 1} مرفوضة:\n\n${validation.reason}`,
                    "صورة غير صالحة ❌",
                );
            }
        }

        // --- 2. سحب نقاط المهام الدنيوية والدينية ---
        const {
            totalPoints: taskPoints,
            selections,
            missingNormalImportant,
        } = getCurrentSelectionsAndPoints();

        const currentRelSelections = {};
        document.querySelectorAll(".rel-task-select").forEach((s) => {
            currentRelSelections[s.getAttribute("data-task-id")] = parseInt(
                s.options[s.selectedIndex].getAttribute("data-index"),
            );
        });
        document.querySelectorAll(".rel-checklist-container").forEach((c) => {
            let arr = [];
            c.querySelectorAll(".rel-task-checkbox:checked").forEach((cb) =>
                arr.push(parseInt(cb.getAttribute("data-index"))),
            );
            if (arr.length === 0) arr = [0];
            currentRelSelections[c.getAttribute("data-task-id")] = arr;
        });

        let missingRelImportant = false;
        for (let id of window.importantRelTaskIds || []) {
            let sel = currentRelSelections[id];
            let isDone = false;
            if (Array.isArray(sel)) {
                if (sel.length > 1 || (sel.length === 1 && sel[0] !== 0))
                    isDone = true;
            } else {
                if (sel > 0) isDone = true;
            }
            if (!isDone) {
                missingRelImportant = true;
                break;
            }
        }

        // --- 3. الفحص الإجباري وتأكيد الإرسال ---
        if (missingNormalImportant || missingRelImportant) {
            const isSure = await CustomDialog.confirm(
                "لقد تجاهلت مهام إجبارية أساسية. الاعتماد الآن سيؤدي حتماً إلى الفشل وكسر الستريك مهما كانت نقاطك. هل أنت متأكد من هذا التخاذل؟",
                "تحذير صارم 🛑",
            );
            if (!isSure) return;
        } else {
            const confirmSubmit = await CustomDialog.confirm(
                "سيتم الآن دمج صور الأجهزة وإرسالها للقاضي الآلي (Gemini) لتقييم استهلاكك واعتماد اليوم. هل أنت مستعد لمواجهة نتيجتك؟",
                "تحكيم الذكاء الاصطناعي 🤖",
            );
            if (!confirmSubmit) return;
        }

        const btn = document.getElementById("submit-day-btn");
        const originalText = btn.innerText;
        btn.innerText = "القاضي الآلي يحلل بياناتك... 🤖⏳";
        btn.disabled = true;

        try {
            const realNow = getRealNow();
            const today = getCairoDateString(realNow);

            // --- 4. دمج الصور ورفعها للسيرفر ---
            const mergedFile = await window.mergeDeviceImagesToCanvas(
                dopamineData.files,
            );
            const storagePath = `dopamine_proofs/${currentUser.uid}_${Date.now()}.jpg`;
            const storageRefPath = ref(storage, storagePath);
            await uploadBytes(storageRefPath, mergedFile);
            const imageUrl = await getDownloadURL(storageRefPath);

            // --- 5. طلب الحكم من السيرفر السحابي ---
            const evaluateScreenTimeFunc = httpsCallable(
                functions,
                "evaluateScreenTime",
            );
            const aiResult = await evaluateScreenTimeFunc({
                totalScreenMinutes: dopamineData.totalScreenMinutes,
                totalShortsMinutes: dopamineData.totalShortsMinutes,
                justification: justification,
                imageUrl: imageUrl,
            });

            if (!aiResult.data.success) throw new Error("فشل التحليل الذكي.");

            const wastedScreen = aiResult.data.wastedScreenMinutes;
            const wastedShorts = aiResult.data.wastedShortsMinutes;

            // --- 6. تطبيق معادلة الدوبامين العكسية (Capped Linear Decay) ---
            // أقصى نقاط للشاشة: 100 | حد التسامح: 4 ساعات (300 دقيقة)
            let screenPoints = 100 * (1 - wastedScreen / 300);
            if (screenPoints < 0) screenPoints = 0;

            // أقصى نقاط للشورتس: 100 | حد التسامح: 45 دقيقة
            let shortsPoints = 100 * (1 - wastedShorts / 45);
            if (shortsPoints < 0) shortsPoints = 0;

            const dopaminePoints = Math.floor(screenPoints + shortsPoints);
            const finalTotalPoints = taskPoints + dopaminePoints;

            // --- 7. تحديد النجاح الفعلي ---
            const passedToday =
                finalTotalPoints >= dailyTargetPoints &&
                !missingRelImportant &&
                !missingNormalImportant;

            // --- 8. توثيق السجل اليومي ---
            await setDoc(
                doc(db, `users/${currentUser.uid}/dailyLogs`, today),
                {
                    date: today,
                    pointsEarned: finalTotalPoints,
                    selections: selections,
                    religiousSelections: currentRelSelections,
                    passed: passedToday,
                    isFinalized: true,
                    timestamp: realNow,
                    dopamineData: {
                        // حفظ بيانات الدوبامين للإحصائيات المستقبلية
                        reportedScreenMinutes: dopamineData.totalScreenMinutes,
                        reportedShortsMinutes: dopamineData.totalShortsMinutes,
                        justification: justification,
                        proofImageUrl: imageUrl,
                        aiEvaluatedWastedScreen: wastedScreen,
                        aiEvaluatedWastedShorts: wastedShorts,
                        pointsAwarded: dopaminePoints,
                    },
                },
                { merge: true },
            );

            const pointsDisplay = document.getElementById("today-points");
            if (pointsDisplay) pointsDisplay.innerText = finalTotalPoints;

            // --- 9. تحديث الحساب وتطبيق العقوبات أو الجوائز ---
            const userDocRef = doc(db, "users", currentUser.uid);
            const userDocSnap = await getDoc(userDocRef);
            const userDataLocal = userDocSnap.data() || {};

            let currentZone = userDataLocal.currentZone || "green";
            const hasDoubleXP = userDataLocal.hasDoubleXP || false;
            let dbUpdates = { lastEvalDate: today };

            if (passedToday) {
                // حالة النجاح
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

                const newStreak = (userDataLocal.currentStreak || 0) + 1;
                let streakMultiplier = 1.0;
                if (newStreak >= 21) streakMultiplier = 2.0;
                else if (newStreak >= 14) streakMultiplier = 1.6;
                else if (newStreak >= 7) streakMultiplier = 1.4;
                else if (newStreak >= 3) streakMultiplier = 1.2;

                const multipliedPoints = Math.floor(
                    finalTotalPoints * streakMultiplier,
                );
                let earnedCoins = Math.floor(multipliedPoints / 1.5);
                let earnedXP = multipliedPoints;
                let xpLabel = "";
                let streakLabel =
                    streakMultiplier > 1
                        ? `<span style="color:#f97316; display: block; font-size: 14px; margin-top: 5px;">(مضاعف الستريك: x${streakMultiplier} 🔥)</span>`
                        : "";

                dbUpdates.walletCoins = increment(earnedCoins);
                dbUpdates.currentStreak = increment(1);
                dbUpdates.currentZone = currentZone;
                dbUpdates.currentMultiplier = streakMultiplier;

                if (hasDoubleXP) {
                    earnedXP *= 2;
                    dbUpdates.cycleScore = increment(earnedXP);
                    dbUpdates.lifetimeScore = increment(earnedXP);
                    dbUpdates.hasDoubleXP = false;
                    dbUpdates.usedDoubleXP = true;
                    xpLabel = `<span style="color:#eab308; display: block;">(مضاعف المتجر ⚡)</span>`;
                } else {
                    dbUpdates.cycleScore = increment(earnedXP);
                    dbUpdates.lifetimeScore = increment(earnedXP);
                }

                await updateDoc(userDocRef, dbUpdates);
                await CustomDialog.alert(
                    `<span style="display: block;">🔥 تم الاعتماد بنجاح!</span> 
                <span style="font-size: 13px; color: var(--text-muted); display: block; margin-top: 5px;">تقييم القاضي الآلي للدوبامين: +${dopaminePoints} نقطة</span>
                ${streakLabel} ${xpLabel} \n <span><span class="win-info-boxs xp">+${earnedXP} XP</span> <span class="win-info-boxs coins">+${earnedCoins} <i class="fa-solid fa-coins fa-fw"></i></span> <span class="win-info-boxs ">+1 <i class="fa-solid fa-fire fa-fw"></i></span></span>`,
                    "عمل عظيم ",
                );
            } else {
                // حالة الفشل
                const hasFreeze = (userDataLocal.freezeCount || 0) > 0;

                if (hasFreeze) {
                    dbUpdates.freezeCount = increment(-1);
                    await updateDoc(userDocRef, dbUpdates);
                    await CustomDialog.alert(
                        `جمعت ${finalTotalPoints} نقطة فقط. تم استهلاك "تجميد الستريك" ❄️ بنجاح للحماية من السقوط.`,
                        "تفعيل التجميد التلقائي ❄️",
                    );
                } else {
                    if (currentZone === "green") currentZone = "yellow";
                    else if (currentZone === "yellow") currentZone = "red";

                    const penaltyCoins = Math.floor(dailyTargetPoints / 2);

                    // 🛑 التعديل الجراحي الثاني: حفظ الستريك الميت في التحديثات
                    dbUpdates.lostStreak = userDataLocal.currentStreak || 0;
                    dbUpdates.streakDeathTimestamp = getRealNow().getTime(); // 🛑 تسجيل لحظة الوفاة
                    dbUpdates.currentStreak = 0;
                    dbUpdates.currentZone = currentZone;
                    dbUpdates.walletCoins = increment(-penaltyCoins);
                    dbUpdates.currentMultiplier = 1.0;

                    await updateDoc(userDocRef, dbUpdates);

                    await CustomDialog.alert(
                        `المجموع ${finalTotalPoints} نقطة (القاضي أعطاك ${dopaminePoints} لدوبامينك). تم اعتماد اليوم كفشل! تصفير الستريك وخصم ${penaltyCoins} عملة ديون. 💔\nأنت الآن في المنطقة: ${currentZone === "yellow" ? "الصفراء ⚠️" : "الحمراء 🛑"}`,
                        "تحذير شديد اللهجة",
                    );
                }
            }

            isTodayFinalized = true;
            window.syncUserUI();
            if (typeof applyZoneUI === "function") applyZoneUI(currentZone);
        } catch (error) {
            console.error(error);
            await CustomDialog.alert(
                "حدث خطأ أثناء تقييم القاضي الآلي: " + error.message,
                "خطأ ⚠️",
            );
            btn.innerText = originalText;
            btn.disabled = false;
        }
    });