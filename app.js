// Initialize Supabase Client
// Note: We use window.location to determine keys, using placeholders if not defined.
// The user will set these environment variables in their Vercel dashboard.
const SUPABASE_URL = "https://your-supabase-project.supabase.co"; // Will be overridden dynamically if config is provided
const SUPABASE_ANON_KEY = "your-anon-key";

// We read them dynamically from a global config object if injected, or fallback
const supabaseUrl = window.SUPABASE_URL || SUPABASE_URL;
const supabaseKey = window.SUPABASE_ANON_KEY || SUPABASE_ANON_KEY;

// Create client
let supabaseClient = null;
try {
    if (typeof supabase !== 'undefined') {
        const url = supabaseUrl;
        const key = supabaseKey;
        if (url && key && url !== 'https://your-supabase-project.supabase.co') {
            supabaseClient = supabase.createClient(url, key);
        }
    }
} catch (e) {
    console.error("Failed to initialize Supabase client", e);
}

// App State
const state = {
    currentImage: null,
    isProcessing: false,
    session: null,
    profile: null,
    usage: null,
    authMode: 'login' // 'login' or 'signup'
};

// DOM Elements
const sections = {
    uploader: document.getElementById('uploaderSection'),
    analysis: document.getElementById('analysisSection'),
    results: document.getElementById('resultsSection'),
    admin: document.getElementById('adminSection')
};

const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const previewImage = document.getElementById('previewImage');

const loadingText = document.getElementById('loadingText');
const loadingSubtext = document.getElementById('loadingSubtext');
const progressFill = document.querySelector('.progress-fill');

const resetBtn = document.getElementById('resetBtn');

// Auth DOM Elements
const userStatusContainer = document.getElementById('userStatusContainer');
const usageLimitBanner = document.getElementById('usageLimitBanner');
const dailyLimitVal = document.getElementById('dailyLimitVal');
const monthlyLimitVal = document.getElementById('monthlyLimitVal');
const adminBadge = document.getElementById('adminBadge');

// Modals
const authModal = document.getElementById('authModal');
const closeAuthModal = document.getElementById('closeAuthModal');
const authForm = document.getElementById('authForm');
const authEmail = document.getElementById('authEmail');
const authPassword = document.getElementById('authPassword');
const authSubmitBtn = document.getElementById('authSubmitBtn');
const authErrorMsg = document.getElementById('authErrorMsg');
const toggleAuthMode = document.getElementById('toggleAuthMode');
const authModalTitle = document.getElementById('authModalTitle');

// Admin Modal
const editLimitModal = document.getElementById('editLimitModal');
const closeLimitModal = document.getElementById('closeLimitModal');
const cancelLimitBtn = document.getElementById('cancelLimitBtn');
const editLimitForm = document.getElementById('editLimitForm');
const editUserId = document.getElementById('editUserId');
const editUserEmail = document.getElementById('editUserEmail');
const editDailyLimit = document.getElementById('editDailyLimit');
const editMonthlyLimit = document.getElementById('editMonthlyLimit');
const adminUserList = document.getElementById('adminUserList');

// Initialize
async function init() {
    setupEventListeners();
    
    if (supabaseClient) {
        // Monitor session auth state
        supabaseClient.auth.onAuthStateChange(async (event, session) => {
            state.session = session;
            if (session) {
                await fetchUserData();
            } else {
                state.profile = null;
                state.usage = null;
                updateAuthUI();
            }
        });

        // Get initial session
        const { data: { session } } = await supabaseClient.auth.getSession();
        state.session = session;
        if (session) {
            await fetchUserData();
        } else {
            updateAuthUI();
        }
    } else {
        console.error("Supabase client is not initialized. Please verify SUPABASE_URL and SUPABASE_ANON_KEY.");
    }
}


// Event Listeners
function setupEventListeners() {
    // Auth Modals
    const authBtn = document.getElementById('authBtn');
    if (authBtn) {
        authBtn.addEventListener('click', () => {
            if (state.session) {
                // Logout action
                supabaseClient.auth.signOut();
            } else {
                state.authMode = 'login';
                authModalTitle.textContent = 'Sign In';
                authSubmitBtn.textContent = 'Sign In';
                authErrorMsg.style.display = 'none';
                authModal.classList.add('show');
            }
        });
    }

    closeAuthModal.addEventListener('click', () => authModal.classList.remove('show'));
    toggleAuthMode.addEventListener('click', () => {
        if (state.authMode === 'login') {
            state.authMode = 'signup';
            authModalTitle.textContent = 'Create Account';
            authSubmitBtn.textContent = 'Sign Up';
            toggleAuthMode.textContent = 'Sign In';
            toggleAuthMode.parentNode.innerHTML = 'Already have an account? <span id="toggleAuthMode" style="color: var(--primary); cursor: pointer; text-decoration: underline;">Sign In</span>';
            // re-bind as node was replaced
            document.getElementById('toggleAuthMode').addEventListener('click', () => toggleAuthMode.click());
        } else {
            state.authMode = 'login';
            authModalTitle.textContent = 'Sign In';
            authSubmitBtn.textContent = 'Sign In';
            toggleAuthMode.parentNode.innerHTML = 'Don\'t have an account? <span id="toggleAuthMode" style="color: var(--primary); cursor: pointer; text-decoration: underline;">Sign Up</span>';
            // re-bind
            document.getElementById('toggleAuthMode').addEventListener('click', () => toggleAuthMode.click());
        }
    });

    authForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        authErrorMsg.style.display = 'none';
        authSubmitBtn.disabled = true;
        authSubmitBtn.textContent = state.authMode === 'login' ? 'Signing In...' : 'Signing Up...';

        const email = authEmail.value.trim();
        const password = authPassword.value;

        try {
            let res;
            if (state.authMode === 'login') {
                res = await supabaseClient.auth.signInWithPassword({ email, password });
            } else {
                res = await supabaseClient.auth.signUp({ email, password });
            }

            if (res.error) throw res.error;
            
            authModal.classList.remove('show');
            authForm.reset();
        } catch (err) {
            authErrorMsg.textContent = err.message;
            authErrorMsg.style.display = 'block';
        } finally {
            authSubmitBtn.disabled = false;
            authSubmitBtn.textContent = state.authMode === 'login' ? 'Sign In' : 'Sign Up';
        }
    });

    // Close Limit Modals
    closeLimitModal.addEventListener('click', () => editLimitModal.classList.remove('show'));
    cancelLimitBtn.addEventListener('click', () => editLimitModal.classList.remove('show'));

    // Submit limits
    editLimitForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const targetUserId = editUserId.value;
        const dailyLimit = editDailyLimit.value;
        const monthlyLimit = editMonthlyLimit.value;

        try {
            const response = await fetch('/api/admin', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${state.session.access_token}`
                },
                body: JSON.stringify({ targetUserId, dailyLimit, monthlyLimit })
            });

            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Failed to update limits');

            alert('Limits updated successfully!');
            editLimitModal.classList.remove('show');
            await loadAdminDashboard();
        } catch (err) {
            alert('Error updating limits: ' + err.message);
        }
    });

    // Reset
    resetBtn.addEventListener('click', () => {
        state.currentImage = null;
        fileInput.value = '';
        showSection('uploader');
    });

    // Drag & Drop
    dropZone.addEventListener('click', () => fileInput.click());
    
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, preventDefaults, false);
        document.body.addEventListener(eventName, preventDefaults, false);
    });

    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.add('dragover'), false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.remove('dragover'), false);
    });

    dropZone.addEventListener('drop', handleDrop, false);
    fileInput.addEventListener('change', handleFileSelect, false);
}

function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
}

function handleDrop(e) {
    const dt = e.dataTransfer;
    const files = dt.files;
    if (files && files.length > 0) {
        processFile(files[0]);
    }
}

function handleFileSelect(e) {
    if (e.target.files && e.target.files.length > 0) {
        processFile(e.target.files[0]);
    }
}

function showSection(sectionName) {
    Object.values(sections).forEach(sec => sec.classList.remove('active'));
    sections[sectionName].classList.add('active');
}

// Main Processing Flow
async function processFile(file) {
    if (!file.type.startsWith('image/')) {
        alert('Please upload an image file (JPG, PNG, WEBP, etc.).');
        return;
    }

    if (state.isProcessing) return;

    state.currentImage = file;
    state.isProcessing = true;
    
    // Setup preview
    const reader = new FileReader();
    reader.onload = async (e) => {
        previewImage.src = e.target.result;
        showSection('analysis');
        
        await runAnalysisPipeline(file, e.target.result);
        state.isProcessing = false;
    };
    reader.onerror = () => {
        alert('Failed to read the image file. Please try again.');
        state.isProcessing = false;
    };
    reader.readAsDataURL(file);
}

async function runAnalysisPipeline(file, base64Data) {
    try {
        // 1. Metadata Analysis
        updateProgress('Extracting EXIF & Metadata...', 'Checking camera signatures', 20);
        const metadata = await extractMetadata(file);
        
        // 2. AI Inference
        updateProgress('Running AI Inference...', 'Querying Hugging Face Model', 50);
        const aiResults = await detectAI(file);
        
        updateProgress('Finalizing Results...', 'Compiling health score', 90);
        
        setTimeout(() => {
            renderResults(aiResults, metadata);
            showSection('results');
        }, 1000);

    } catch (error) {
        console.error(error);
        showSection('uploader');
        alert('Analysis error: ' + error.message);
    }
}

function updateProgress(title, subtext, percentage) {
    loadingText.textContent = title;
    loadingSubtext.textContent = subtext;
    progressFill.style.width = `${percentage}%`;
}

async function compressImage(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;
                const MAX_SIZE = 800;
                
                if (width > height && width > MAX_SIZE) {
                    height *= MAX_SIZE / width;
                    width = MAX_SIZE;
                } else if (height > MAX_SIZE) {
                    width *= MAX_SIZE / height;
                    height = MAX_SIZE;
                }
                
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                
                canvas.toBlob((blob) => {
                    if (blob) resolve(blob.arrayBuffer());
                    else reject(new Error('Image compression failed'));
                }, 'image/jpeg', 0.8);
            };
            img.onerror = () => reject(new Error('Invalid image file'));
            img.src = e.target.result;
        };
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsDataURL(file);
    });
}

// API Integration
async function detectAI(file) {
    if (!state.session) {
        throw new Error('Please login to analyze images.');
    }

    const buffer = await compressImage(file);
    const API_URL = "/api/detect";
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    
    try {
        const response = await fetch(API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/octet-stream",
                "Authorization": `Bearer ${state.session.access_token}`
            },
            body: buffer,
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        const data = await response.json().catch(() => ({ error: `Server error ${response.status}` }));

        if (!response.ok) {
            throw new Error(data.error || `Server returned ${response.status}`);
        }

        // Refresh user scan stats dynamically after a successful scan
        await fetchUserData();

        return data;

    } catch (error) {
        clearTimeout(timeoutId);
        
        if (error.name === 'AbortError') {
            throw new Error('Request timed out. The AI model may still be loading. Please try again in 20 seconds.');
        }
        throw error;
    }
}

// User Profile & Limits Logic
async function fetchUserData() {
    if (!state.session) return;

    try {
        const response = await fetch('/api/user', {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${state.session.access_token}`
            }
        });

        if (!response.ok) throw new Error('Failed to retrieve user status');
        const data = await response.json();

        state.profile = data.profile;
        state.usage = data.usage;

        updateAuthUI();

        // If user is Admin, render the Admin Panel
        if (state.profile.role === 'admin') {
            sections.admin.style.display = 'block';
            await loadAdminDashboard();
        } else {
            sections.admin.style.display = 'none';
        }

    } catch (err) {
        console.error('Error loading user data:', err);
    }
}

function updateAuthUI() {
    if (state.session) {
        userStatusContainer.innerHTML = `
            <span class="user-email">${state.session.user.email}</span>
            <button id="authBtn" class="logout-btn">Log Out</button>
        `;
        document.getElementById('authBtn').addEventListener('click', () => {
            supabaseClient.auth.signOut();
        });

        // Update Limits Badges
        if (state.profile && state.usage) {
            dailyLimitVal.textContent = `${state.usage.daily}/${state.profile.daily_limit}`;
            monthlyLimitVal.textContent = `${state.usage.monthly}/${state.profile.monthly_limit}`;
            usageLimitBanner.style.display = 'inline-flex';

            if (state.profile.role === 'admin') {
                adminBadge.style.display = 'inline-block';
            } else {
                adminBadge.style.display = 'none';
            }
        }
    } else {
        userStatusContainer.innerHTML = `
            <button id="authBtn" class="btn primary">Login / Sign Up</button>
        `;
        document.getElementById('authBtn').addEventListener('click', () => {
            state.authMode = 'login';
            authModalTitle.textContent = 'Sign In';
            authSubmitBtn.textContent = 'Sign In';
            authErrorMsg.style.display = 'none';
            authModal.classList.add('show');
        });
        usageLimitBanner.style.display = 'none';
        sections.admin.style.display = 'none';
    }
}

// Admin Panel Logic
async function loadAdminDashboard() {
    if (!state.session || !state.profile || state.profile.role !== 'admin') return;

    try {
        const response = await fetch('/api/admin', {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${state.session.access_token}`
            }
        });

        if (!response.ok) throw new Error('Failed to retrieve user directory');
        const data = await response.json();

        adminUserList.innerHTML = '';
        if (data.users && data.users.length > 0) {
            data.users.forEach(user => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td>${user.email}</td>
                    <td><span class="badge">${user.role}</span></td>
                    <td>${user.daily_limit}</td>
                    <td>${user.monthly_limit}</td>
                    <td>
                        <button class="btn secondary edit-limit-btn" data-id="${user.id}" data-email="${user.email}" data-daily="${user.daily_limit}" data-monthly="${user.monthly_limit}">Edit Limits</button>
                    </td>
                `;
                adminUserList.appendChild(tr);
            });

            // Bind click to edit buttons
            document.querySelectorAll('.edit-limit-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const id = e.target.dataset.id;
                    const email = e.target.dataset.email;
                    const daily = e.target.dataset.daily;
                    const monthly = e.target.dataset.monthly;

                    editUserId.value = id;
                    editUserEmail.value = email;
                    editDailyLimit.value = daily;
                    editMonthlyLimit.value = monthly;

                    editLimitModal.classList.add('show');
                });
            });
        } else {
            adminUserList.innerHTML = '<tr><td colspan="5" style="text-align: center;">No users registered yet.</td></tr>';
        }
    } catch (err) {
        console.error('Error loading admin dashboard:', err);
        adminUserList.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--danger);">Error: ${err.message}</td></tr>`;
    }
}

async function extractMetadata(file) {
    try {
        if (typeof exifr !== 'undefined') {
            const exif = await exifr.parse(file);
            return exif || null;
        }
    } catch (e) {
        console.warn('EXIF parsing failed', e);
    }
    return null;
}

// Render Results
function renderResults(aiResults, metadata) {
    let fakeScore = 0;
    
    if (Array.isArray(aiResults)) {
        const fakeResult = aiResults.find(r => r.label.toLowerCase().includes('artificial') || r.label.toLowerCase().includes('fake'));
        if (fakeResult) {
            fakeScore = fakeResult.score;
        } else {
            const realResult = aiResults.find(r => r.label.toLowerCase().includes('human') || r.label.toLowerCase().includes('real'));
            if (realResult) {
                fakeScore = 1 - realResult.score;
            }
        }
    }

    const aiPercentage = Math.round(fakeScore * 100);

    const circle = document.getElementById('scoreCirclePath');
    const scoreValue = document.getElementById('scoreValue');
    const scoreLabel = document.getElementById('scoreLabel');

    scoreValue.textContent = `${aiPercentage}%`;
    circle.setAttribute('stroke-dasharray', `${aiPercentage}, 100`);
    
    scoreLabel.className = 'score-label';
    if (aiPercentage > 75) {
        circle.style.stroke = 'var(--danger)';
        scoreLabel.textContent = 'Likely AI Generated';
        scoreLabel.classList.add('score-ai');
    } else if (aiPercentage > 40) {
        circle.style.stroke = 'var(--warning)';
        scoreLabel.textContent = 'Suspicious / Mixed';
        scoreLabel.classList.add('score-mixed');
    } else {
        circle.style.stroke = 'var(--success)';
        scoreLabel.textContent = 'Likely Real Photo';
        scoreLabel.classList.add('score-real');
    }

    const breakdownList = document.getElementById('breakdownList');
    breakdownList.innerHTML = '';
    
    if (Array.isArray(aiResults)) {
        aiResults.forEach(res => {
            const scorePct = Math.round(res.score * 100);
            const color = res.label.includes('artificial') ? 'var(--danger)' : 'var(--success)';
            
            breakdownList.innerHTML += `
                <div class="breakdown-item">
                    <div class="breakdown-label" style="text-transform: capitalize;">${res.label}</div>
                    <div class="breakdown-bar-container">
                        <div class="breakdown-bar" style="width: ${scorePct}%; background: ${color}"></div>
                    </div>
                    <div class="breakdown-value">${scorePct}%</div>
                </div>
            `;
        });
    }

    const metadataStatus = document.getElementById('metadataStatus');
    const metadataDetails = document.getElementById('metadataDetails');
    
    metadataDetails.innerHTML = '';
    
    if (metadata && Object.keys(metadata).length > 0) {
        metadataStatus.innerHTML = `
            <div class="status-icon success">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
            </div>
            <p>Camera EXIF Data Found</p>
        `;
        
        const keysToShow = ['Make', 'Model', 'Software', 'DateTimeOriginal', 'LensModel'];
        let addedProps = 0;
        
        keysToShow.forEach(key => {
            if (metadata[key]) {
                let val = metadata[key];
                if (val instanceof Date) val = val.toLocaleString();
                metadataDetails.innerHTML += `<li>${key} <span>${val}</span></li>`;
                addedProps++;
            }
        });
        
        if (addedProps === 0) {
            metadataDetails.innerHTML = `<li>Raw EXIF keys found <span>${Object.keys(metadata).length}</span></li>`;
        }

    } else {
        metadataStatus.innerHTML = `
            <div class="status-icon warning">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
            </div>
            <p>No Camera Metadata (EXIF) Found</p>
        `;
        metadataDetails.innerHTML = `
            <li>EXIF Signature <span>Missing</span></li>
            <li>Camera Data <span>Stripped or absent</span></li>
            <li style="margin-top: 10px; color: var(--warning); font-size: 0.8rem;">Note: AI generators rarely produce EXIF data, but some platforms strip it too.</li>
        `;
    }
}

// Start App
init();
