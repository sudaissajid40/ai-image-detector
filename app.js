// App State
const state = {
    hfToken: '', // Enter your Hugging Face token in Settings modal
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

// Initialize
function init() {
    // Load token from localStorage if exists
    const savedToken = localStorage.getItem('hf_token');
    if (savedToken) {
        state.hfToken = savedToken;
    }
    hfTokenInput.value = state.hfToken;

    setupEventListeners();
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
        alert('Please upload an image file.');
        return;
    }

    if (!state.hfToken) {
        alert('Please configure your Hugging Face API Token in Settings first.');
        settingsModal.classList.add('show');
        return;
    }

    state.currentImage = file;
    
    // Setup preview
    const reader = new FileReader();
    reader.onload = async (e) => {
        previewImage.src = e.target.result;
        showSection('analysis');
        
        await runAnalysisPipeline(file, e.target.result);
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
        alert('An error occurred during analysis: ' + error.message);
        showSection('uploader');
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
                const MAX_SIZE = 800; // Resize to max 800px to ensure it's small!
                
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
                
                // Compress to JPEG 80% quality
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
    const API_URL = "/api/detect";
    
    // We compress the image to ensure it's < 1MB so Vercel doesn't block it!
    const buffer = await compressImage(file);
    
    // Set a 15-second timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    
    try {
        const response = await fetch(API_URL, {
            headers: {
                "x-hf-token": state.hfToken,
                "Content-Type": "application/octet-stream"
            },
            method: "POST",
            body: buffer,
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const err = await response.json();
            if (response.status === 503) {
                throw new Error('Model is currently loading on Hugging Face. Please try again in 10-20 seconds.');
            }
            throw new Error(err.error || 'Failed to analyze image');
        }

        return await response.json(); 
    } catch (error) {
        clearTimeout(timeoutId);
        console.warn("API Error:", error);
        
        // If it's a network error or a timeout, fallback to a simulation so the UI doesn't break
        if (error.name === 'AbortError' || error.message === 'Failed to fetch' || error.name === 'TypeError') {
            alert("Network Error or Timeout: Could not reach Hugging Face API (your network or DNS might be blocking it). Falling back to simulated results so you can see the UI!");
            // Return a simulated response
            return [
                { label: "artificial", score: Math.random() * 0.8 + 0.1 }, 
                { label: "human", score: Math.random() * 0.5 }
            ];
        }
        throw error;
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
    // 1. Parse AI Results
    // The model typically returns 'artificial' and 'human'
    let fakeScore = 0;
    
    if (Array.isArray(aiResults)) {
        // Model might return {label: "artificial", score: ...}
        const fakeResult = aiResults.find(r => r.label.toLowerCase().includes('artificial') || r.label.toLowerCase().includes('fake'));
        if (fakeResult) {
            fakeScore = fakeResult.score;
        } else {
            // Fallback if labels are different
            const realResult = aiResults.find(r => r.label.toLowerCase().includes('human') || r.label.toLowerCase().includes('real'));
            if (realResult) {
                fakeScore = 1 - realResult.score;
            }
        }
    }

    // Convert to percentage
    const aiPercentage = Math.round(fakeScore * 100);
    const isFake = aiPercentage > 50;

    // Render Circle Score
    const circle = document.getElementById('scoreCirclePath');
    const scoreValue = document.getElementById('scoreValue');
    const scoreLabel = document.getElementById('scoreLabel');

    scoreValue.textContent = `${aiPercentage}%`;
    circle.setAttribute('stroke-dasharray', `${aiPercentage}, 100`);
    
    scoreLabel.className = 'score-label'; // Reset
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

    // Render Breakdown
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

    // Render Metadata Health
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
        
        // Show a few key properties
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
            <li style="margin-top: 10px; color: var(--warning); font-size: 0.8rem;">Note: AI generators rarely produce EXIF data, but some social platforms strip it too.</li>
        `;
    }
}

// Start App
init();
