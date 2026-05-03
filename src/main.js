import './style.css'
import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously, onAuthStateChanged } from "firebase/auth";
import { getDatabase, ref, push, onValue, set, off, onDisconnect, serverTimestamp } from "firebase/database";
import { firebaseConfig, APP_ID } from "./firebase-config";

// ==========================================
// 1. INITIALIZATION
// ==========================================
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app, firebaseConfig.databaseURL);

// ==========================================
// 2. APP STATE
// ==========================================
let currentUser = null;
let myNickname = '';
let currentRoomId = '';
let typingTimeout = null;
let pendingImageData = null;

const sessionId = Math.random().toString(36).substring(2, 15);

// ==========================================
// 3. ENCRYPTION ENGINE
// ==========================================
const Crypto = {
    encode: (text, secret) => {
        try {
            const encodedText = encodeURIComponent(text);
            let result = '';
            for(let i = 0; i < encodedText.length; i++) result += String.fromCharCode(encodedText.charCodeAt(i) ^ secret.charCodeAt(i % secret.length));
            return btoa(result);
        } catch(e) { return text; }
    },
    decode: (text, secret) => {
        try {
            let decoded = atob(text);
            let result = '';
            for(let i = 0; i < decoded.length; i++) result += String.fromCharCode(decoded.charCodeAt(i) ^ secret.charCodeAt(i % secret.length));
            return decodeURIComponent(result);
        } catch (e) { return "🔒 [Encrypted Data Error]"; }
    }
};

// ==========================================
// 4. UI ELEMENTS
// ==========================================
const els = {
    landingScreen: document.getElementById('landing-screen'),
    chatScreen: document.getElementById('chat-screen'),
    joinForm: document.getElementById('join-form'),
    nicknameInput: document.getElementById('nickname-input'),
    roomIdInput: document.getElementById('room-id-input'),
    chatForm: document.getElementById('chat-form'),
    messageInput: document.getElementById('message-input'),
    messagesContainer: document.getElementById('messages-container'),
    displayRoomName: document.getElementById('display-room-name'),
    typingIndicator: document.getElementById('typing-indicator'),
    typingText: document.getElementById('typing-text'),
    msgSound: document.getElementById('msg-sound'),
    emojiBtn: document.getElementById('emoji-btn'),
    emojiPickerContainer: document.getElementById('emoji-picker-container'),
    emojiPicker: document.querySelector('emoji-picker'),
    imageUpload: document.getElementById('image-upload'),
    imagePreviewContainer: document.getElementById('image-preview-container'),
    imagePreviewImg: document.getElementById('image-preview-img'),
    cancelImageBtn: document.getElementById('cancel-image-btn'),
    leaveBtn: document.getElementById('leave-btn'),
    copyRoomBtn: document.getElementById('copy-room-btn'),
};

const UI = {
    showToast: (msg) => {
        const toast = document.getElementById('toast');
        document.getElementById('toast-message').textContent = msg;
        toast.style.opacity = '1';
        toast.style.pointerEvents = 'auto';
        setTimeout(() => { 
            toast.style.opacity = '0'; 
            toast.style.pointerEvents = 'none';
        }, 3000);
    },
    
    scrollToBottom: () => {
        setTimeout(() => { els.messagesContainer.scrollTop = els.messagesContainer.scrollHeight; }, 100);
    },
    
    formatTime: (timestamp) => {
        return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    },

    switchView: (toChat) => {
        if (toChat) {
            els.landingScreen.style.opacity = '0';
            setTimeout(() => {
                els.landingScreen.classList.add('hidden');
                els.chatScreen.classList.remove('hidden');
                els.chatScreen.classList.add('flex');
                setTimeout(() => els.chatScreen.style.opacity = '1', 50);
                UI.scrollToBottom();
            }, 500);
        } else {
            els.chatScreen.style.opacity = '0';
            setTimeout(() => {
                els.chatScreen.classList.add('hidden');
                els.chatScreen.classList.remove('flex');
                els.landingScreen.classList.remove('hidden');
                setTimeout(() => els.landingScreen.style.opacity = '1', 50);
            }, 500);
        }
    }
};

// ==========================================
// 5. AUTHENTICATION
// ==========================================
const initAuth = async () => {
    try {
        await signInAnonymously(auth);
        if ("Notification" in window && Notification.permission === "default") {
            console.log("Notifications available, waiting for user gesture to request...");
        }
    } catch (err) {
        console.error("Auth failed:", err);
        UI.showToast("Connection error.");
    }
};

onAuthStateChanged(auth, (user) => {
    currentUser = user;
});

// ==========================================
// 6. EVENT LISTENERS
// ==========================================

els.joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!currentUser) { UI.showToast("Connecting to network..."); return; }
    
    myNickname = els.nicknameInput.value.trim();
    currentRoomId = els.roomIdInput.value.trim().toLowerCase();
    
    if (myNickname && currentRoomId) {
        if ("Notification" in window && Notification.permission === "default") {
            Notification.requestPermission();
        }
        
        els.displayRoomName.textContent = currentRoomId;
        UI.switchView(true);
        loadMessages();
        setupTypingIndicator();
    }
});

els.leaveBtn.addEventListener('click', () => {
    const typingRef = ref(db, `typing_status/${APP_ID}_${currentRoomId}/${myNickname}`);
    set(typingRef, null);

    // Stop listening
    const messagesRef = ref(db, `rooms/${APP_ID}_${currentRoomId}/messages`);
    const statusRef = ref(db, `typing_status/${APP_ID}_${currentRoomId}`);
    off(messagesRef);
    off(statusRef);

    UI.switchView(false);
    els.messagesContainer.innerHTML = '<div class="text-center text-neutral-600 text-xs py-8 font-space tracking-widest uppercase">End of History</div>';
    currentRoomId = '';
});

els.copyRoomBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(currentRoomId);
    UI.showToast("Room ID copied!");
});

els.emojiBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    els.emojiPickerContainer.classList.toggle('hidden');
});

document.addEventListener('click', (e) => {
    if (!els.emojiPickerContainer.contains(e.target) && e.target !== els.emojiBtn && !els.emojiBtn.contains(e.target)) {
        els.emojiPickerContainer.classList.add('hidden');
    }
});

els.emojiPicker.addEventListener('emoji-click', event => {
    els.messageInput.value += event.detail.unicode;
    els.messageInput.focus();
});

els.imageUpload.addEventListener('change', function() {
    const file = this.files[0];
    if (!file) return;
    
    if (file.size > 800000) {
        UI.showToast("Image too large (Max 800KB)");
        this.value = '';
        return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
        pendingImageData = e.target.result;
        els.imagePreviewImg.src = pendingImageData;
        els.imagePreviewContainer.classList.remove('hidden');
        els.messageInput.placeholder = "Add a caption...";
    };
    reader.readAsDataURL(file);
});

els.cancelImageBtn.addEventListener('click', () => {
    pendingImageData = null;
    els.imageUpload.value = '';
    els.imagePreviewContainer.classList.add('hidden');
    els.messageInput.placeholder = "Type a message...";
});

els.messageInput.addEventListener('input', () => {
    if (!currentRoomId) return;
    const typingRef = ref(db, `typing_status/${APP_ID}_${currentRoomId}/${myNickname}`);
    
    set(typingRef, Date.now());

    // Auto-cleanup on disconnect
    onDisconnect(typingRef).set(null);

    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
        set(typingRef, null);
    }, 2000);
});

// ==========================================
// 7. FIREBASE DATA LOGIC
// ==========================================

function loadMessages() {
    const messagesRef = ref(db, `rooms/${APP_ID}_${currentRoomId}/messages`);
    let isInitialLoad = true;
    
    onValue(messagesRef, (snapshot) => {
        const data = snapshot.val();
        let msgs = [];
        
        if (data) {
            msgs = Object.keys(data).map(key => ({ id: key, ...data[key] }));
            msgs.sort((a, b) => a.timestamp - b.timestamp);
        }
        
        // Notifications & Sound
        if (!isInitialLoad && data) {
            // Check for new additions (RTDB onValue sends the whole object, so we check the latest)
            const latestMsg = msgs[msgs.length - 1];
            if (latestMsg && latestMsg.sessionId !== sessionId) {
                els.msgSound.play().catch(() => {});
                
                if (document.visibilityState === 'hidden' && "Notification" in window && Notification.permission === "granted") {
                    const decryptedText = latestMsg.isImage ? "[Shared an image]" : Crypto.decode(latestMsg.text, currentRoomId);
                    new Notification(`Jixu: ${latestMsg.nickname}`, {
                        body: decryptedText,
                        icon: '/favicon.ico'
                    });
                }
            }
        }
        
        renderMessages(msgs);
        isInitialLoad = false;
    });
}

function setupTypingIndicator() {
    const statusRef = ref(db, `typing_status/${APP_ID}_${currentRoomId}`);
    onValue(statusRef, (snapshot) => {
        const data = snapshot.val();
        if (data) {
            const typingUsers = Object.keys(data).filter(name => data[name] !== null && name !== myNickname && (Date.now() - data[name] < 3000));
            
            if (typingUsers.length > 0) {
                els.typingText.textContent = typingUsers.length > 1 
                    ? "Multiple users are typing..." 
                    : `${typingUsers[0]} is typing...`;
                els.typingIndicator.style.opacity = '1';
            } else {
                els.typingIndicator.style.opacity = '0';
            }
        } else {
            els.typingIndicator.style.opacity = '0';
        }
    });
}

function renderMessages(messages) {
    els.messagesContainer.innerHTML = '<div class="text-center text-neutral-600 text-xs py-8 font-space tracking-widest uppercase">End of History</div>';
    
    let lastSender = null;
    
    messages.forEach(msg => {
        const isMine = msg.sessionId === sessionId;
        const showHeader = lastSender !== msg.nickname;
        const timeStr = UI.formatTime(msg.timestamp);
        
        const wrapper = document.createElement('div');
        wrapper.className = `flex w-full mb-1 msg-enter ${isMine ? 'justify-end' : 'justify-start'} ${showHeader ? 'mt-4' : ''}`;
        
        const bubble = document.createElement('div');
        bubble.className = `relative max-w-[85%] sm:max-w-[65%] px-4 py-2.5 rounded-2xl shadow-sm ${isMine ? 'bg-white text-black rounded-br-sm' : 'bg-[#111] text-[#ececec] border border-[#222] rounded-bl-sm'}`;

        let innerHTML = '';
        
        if (showHeader && !isMine) {
            innerHTML += `<div class="text-[11px] font-space font-medium text-neutral-500 mb-1.5 tracking-wide">${msg.nickname}</div>`;
        }

        if (msg.isImage && msg.imageData) {
            innerHTML += `<img src="${msg.imageData}" class="w-full rounded-lg mb-2 bg-[#1a1a1a] object-contain max-h-64 cursor-pointer hover:opacity-90 transition-opacity" onclick="window.open(this.src)">`;
        }

        if (msg.text) {
            const decryptedText = Crypto.decode(msg.text, currentRoomId);
            const textDiv = document.createElement('div');
            textDiv.textContent = decryptedText;
            innerHTML += `<div class="leading-relaxed break-words text-[14px] sm:text-[15px]">${textDiv.innerHTML}</div>`;
        }
        
        innerHTML += `
            <div class="text-[9px] mt-1 text-right flex items-center justify-end space-x-1 ${isMine ? 'text-neutral-500' : 'text-neutral-600'} font-space">
                <span>${timeStr}</span>
            </div>
        `;
        
        bubble.innerHTML = innerHTML;
        wrapper.appendChild(bubble);
        els.messagesContainer.appendChild(wrapper);
        
        lastSender = msg.nickname;
    });
    
    UI.scrollToBottom();
}

els.chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentUser || !currentRoomId) return;

    const text = els.messageInput.value.trim();
    const hasImage = pendingImageData !== null;
    
    if (!text && !hasImage) return;

    const imageDataToSend = pendingImageData;
    els.messageInput.value = '';
    els.messageInput.focus();
    els.emojiPickerContainer.classList.add('hidden');
    els.cancelImageBtn.click();

    try {
        const messagesRef = ref(db, `rooms/${APP_ID}_${currentRoomId}/messages`);
        
        const payload = {
            sessionId: sessionId,
            nickname: myNickname,
            timestamp: serverTimestamp(),
            isImage: hasImage,
            text: text ? Crypto.encode(text, currentRoomId) : ''
        };

        if (hasImage) payload.imageData = imageDataToSend;

        push(messagesRef, payload);
        
        const typingRef = ref(db, `typing_status/${APP_ID}_${currentRoomId}/${myNickname}`);
        set(typingRef, null);

    } catch (err) {
        UI.showToast("Transmission failed.");
        console.error(err);
    }
});

// START
initAuth();
