// App State
const state = {
    hfToken: '',
    currentImage: null,
    isProcessing: false
};

// DOM Elements
const sections = {
    uploader: document.getElementById('uploaderSection'),
    analysis: document.getElementById('analysisSection'),
    results: document.getElementById('resultsSection')
};

const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const previewImage = document.getElementById('previewImage');

const loadingText = document.getElementById('loadingText');
const loadingSubtext = document.getElementById('loadingSubtext');
const progressFill = document.querySelector('.progress-fill');

const settingsBtn = document.getElementById('settingsBtn');
const settingsModal = document.getElementById('settingsModal');
const closeBtn = document.querySelector('.close-btn');
const saveSettingsBtn = document.getElementById('saveSettingsBtn');
const hfTokenInput = document.getElementById('hfToken');
const resetBtn = document.getElementById('resetBtn');
const tokenBanner = document.getElementById('tokenBanner');
const bannerConfigBtn = document.getElementById('bannerConfigBtn');
const bannerDismissBtn = document.getElementById('bannerDismissBtn');

// Initialize
function init() {
    const savedToken = localStorage.getItem('hf_token');
    if (savedToken) {
        state.hfToken = savedToken;
    }
    hfTokenInput.value = state.hfToken;

    // Show banner if no token is set
    updateBanner();

    setupEventListeners();
}

function updateBanner() {
    if (!tokenBanner) return;
    if (!state.hfToken) {
        tokenBanner.style.display = 'flex';
    } else {
        tokenBanner.style.display = 'none';
    }
}

// Event Listeners
function setupEventListeners() {
    // Modal
    settingsBtn.addEventListener('click', () => settingsModal.classList.add('show'));
    closeBtn.addEventListener('click', () => settingsModal.classList.remove('show'));
    saveSettingsBtn.addEventListener('click', () => {
        state.hfToken = hfTokenInput.value.trim();
        localStorage.setItem('hf_token', state.hfToken);
        settingsModal.classList.remove('show');
        updateBanner();
    });

    // Banner buttons
    if (bannerConfigBtn) bannerConfigBtn.addEventListener('click', () => settingsModal.classList.add('show'));
    if (bannerDismissBtn) bannerDismissBtn.addEventListener('click', () => tokenBanner.style.display = 'none');

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
    const buffer = await compressImage(file);
    
    // If running on localhost/file protocol AND a token is entered in settings, query directly to save server requests
    const isLocalStatic = window.location.hostname === 'localhost' || 
                          window.location.hostname === '127.0.0.1' || 
                          window.location.protocol === 'file:';

    if (isLocalStatic && state.hfToken) {
        return await queryHuggingFaceDirectly(buffer);
    }

    // Default: Proxy request securely through Vercel serverless functions (re-routed in US)
    const API_URL = "/api/detect";
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 28000);
    
    try {
        const response = await fetch(API_URL, {
            method: "POST",
            headers: {
                "x-hf-token": state.hfToken || '',
                "Content-Type": "application/octet-stream"
            },
            body: buffer,
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        const data = await response.json().catch(() => ({ error: `Server error ${response.status}` }));

        if (!response.ok) {
            throw new Error(data.error || `Server returned ${response.status}`);
        }

        return data;

    } catch (error) {
        clearTimeout(timeoutId);
        
        if (error.name === 'AbortError') {
            throw new Error('Request timed out. The AI model may still be loading. Please try again in 20 seconds.');
        }
        // Fallback: If Vercel has DNS issues but user is not on a blocked network, try direct browser call
        if (state.hfToken) {
            console.warn("Vercel proxy failed, falling back to direct browser query...", error);
            return await queryHuggingFaceDirectly(buffer);
        }
        throw error;
    }
}

async function queryHuggingFaceDirectly(buffer) {
    const models = [
        'umm-maybe/AI-image-detector',
        'Organika/sdxl-detector'
    ];

    const promises = models.map(async (modelId) => {
        try {
            const res = await fetch(`https://api-inference.huggingface.co/models/${modelId}`, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${state.hfToken}`,
                    "Content-Type": "application/octet-stream"
                },
                body: buffer
            });

            if (res.status === 503) {
                const text = await res.text();
                let est = 20;
                try {
                    const parsed = JSON.parse(text);
                    if (parsed.estimated_time) est = Math.ceil(parsed.estimated_time);
                } catch (_) {}
                return { status: 503, wait: est };
            }

            if (!res.ok) {
                return { status: res.status, error: `Failed to load model ${modelId}` };
            }

            const data = await res.json();
            return { status: 200, data };
        } catch (err) {
            return { status: 500, error: err.message };
        }
    });

    const results = await Promise.all(promises);

    const m1 = results[0];
    const m2 = results[1];

    if (m1.status === 503 || m2.status === 503) {
        const wait = Math.max(m1.wait || 0, m2.wait || 0);
        throw new Error(`AI models are starting up on Hugging Face. Please try again in ${wait} seconds.`);
    }

    let m1Data = m1.status === 200 ? m1.data : null;
    let m2Data = m2.status === 200 ? m2.data : null;

    if (!m1Data && !m2Data) {
        throw new Error(`AI Inference failed on local connection. M1: ${m1.error || 'Err'}, M2: ${m2.error || 'Err'}`);
    }

    let m1Score = 0.5;
    if (m1Data && Array.isArray(m1Data)) {
        const fake = m1Data.find(item => item.label.toLowerCase().includes('artificial') || item.label.toLowerCase().includes('fake'));
        if (fake) m1Score = fake.score;
        else {
            const real = m1Data.find(item => item.label.toLowerCase().includes('human') || item.label.toLowerCase().includes('real'));
            if (real) m1Score = 1 - real.score;
        }
    }

    let m2Score = 0.5;
    if (m2Data && Array.isArray(m2Data)) {
        const fake = m2Data.find(item => 
            item.label.toLowerCase().includes('artificial') || 
            item.label.toLowerCase().includes('fake') || 
            item.label.toLowerCase().includes('sdxl') ||
            item.label.toLowerCase().includes('generated')
        );
        if (fake) m2Score = fake.score;
        else {
            const real = m2Data.find(item => item.label.toLowerCase().includes('human') || item.label.toLowerCase().includes('real'));
            if (real) m2Score = 1 - real.score;
        }
    }

    let finalScore = 0.5;
    if (m1Data && m2Data) {
        finalScore = (m1Score + m2Score) / 2;
    } else {
        finalScore = m1Data ? m1Score : m2Score;
    }

    return [
        { label: 'artificial', score: finalScore },
        { label: 'human', score: 1 - finalScore }
    ];
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
