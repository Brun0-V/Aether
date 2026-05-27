/**
 * AETHER FOURIER LAB ENGINE
 * Real-Time Digital Signal Processing & Additive Audio Synthesizer
 */

// Global Application State
const STATE = {
  activePreset: 'sine',     // 'sine', 'cosine', 'square', 'triangle', 'sawtooth', 'custom'
  amplitude: 0.7,
  frequency: 1.0,           // visual display cycle speed
  phase: 0.0,
  harmonicsLimit: 16,
  
  // Modifiers
  rectification: 'none',    // 'none', 'half', 'full'
  clippingEnabled: false,
  clippingLevel: 1.0,
  
  // Noise
  noiseMode: 'none',        // 'none', 'white', 'sine'
  noiseAmplitude: 0.1,
  noiseFreqMultiple: 10,
  
  // Buffers
  samplesCount: 512,
  inputBuffer: new Float32Array(512),
  reconstructedBuffer: new Float32Array(512),
  
  // DFT Coefficients (Size 101 for harmonics 0 to 100)
  coefCount: 100,
  an: new Float32Array(101), // Cosine terms
  bn: new Float32Array(101), // Sine terms
  
  // Interaction states
  isDrawing: false,
  hoveredHarmonic: null,
  activeSpectrumDrag: null, // { type: 'sine'|'cosine', index: number }
  hoveredScope: null,       // { x, y } when hovering over scopeCanvas
  
  // Audio state
  soundEnabled: false,
  playingFreq: 440,         // pitch in Hz
  
  // Animation clock
  tOffset: 0
};

// Web Audio API Elements (100 Harmonics Additive Synthesizer Bank)
let audioCtx = null;
let masterGainNode = null;
const oscBank = new Array(101);
const gainBank = new Array(101);

// Initialize Canvases
let scopeCanvas, scopeCtx;
let sineCanvas, sineCtx;
let cosineCanvas, cosineCtx;
let phasorCanvas, phasorCtx;

// DOM Elements
const elements = {};

// Log scale helper for Pitch frequency (50Hz - 2000Hz)
function sliderToFreq(sliderVal) {
  // Input: 1.3 to 3.3. Output: 10^sliderVal (approx 20Hz to 2000Hz)
  return Math.round(Math.pow(10, sliderVal));
}

function freqToSlider(freq) {
  return Math.log10(freq);
}

// -------------------------------------------------------------
// SIGNAL MATH GENERATORS
// -------------------------------------------------------------

function generateBaseSignal(t, type, amp, phase) {
  // t is normalized time in range [0, 1) representing one full cycle
  const theta = 2 * Math.PI * t + phase;
  
  switch (type) {
    case 'sine':
      return amp * Math.sin(theta);
      
    case 'cosine':
      return amp * Math.cos(theta);
      
    case 'square':
      // Basic square wave, sign of sine
      return amp * (Math.sin(theta) >= 0 ? 1.0 : -1.0);
      
    case 'triangle':
      // Triangle wave ramps from 0 to amp to -amp back to 0
      return amp * (2 / Math.PI) * Math.asin(Math.sin(theta));
      
    case 'sawtooth':
      // Ramps from -amp to +amp
      // Normalize t + phase shift
      let phiNorm = phase / (2 * Math.PI);
      let progress = (t + phiNorm) % 1.0;
      if (progress < 0) progress += 1.0;
      return amp * (2.0 * progress - 1.0);
      
    case 'custom':
    default:
      // Return custom buffer interpolation
      const idx = Math.floor(t * STATE.samplesCount) % STATE.samplesCount;
      return STATE.inputBuffer[idx];
  }
}

function computeInputWaveform() {
  if (STATE.activePreset !== 'custom') {
    const N = STATE.samplesCount;
    for (let i = 0; i < N; i++) {
      const t = i / N;
      let val = generateBaseSignal(t, STATE.activePreset, STATE.amplitude, STATE.phase);
      
      // Inject Noise
      if (STATE.noiseMode === 'white') {
        val += (Math.random() * 2 - 1) * STATE.noiseAmplitude;
      } else if (STATE.noiseMode === 'sine') {
        const noiseTheta = 2 * Math.PI * t * STATE.noiseFreqMultiple;
        val += STATE.noiseAmplitude * Math.sin(noiseTheta);
      }
      
      // Apply Rectification
      if (STATE.rectification === 'half') {
        val = Math.max(0, val);
      } else if (STATE.rectification === 'full') {
        val = Math.abs(val);
      }
      
      // Apply Clipping
      if (STATE.clippingEnabled) {
        val = Math.max(-STATE.clippingLevel, Math.min(STATE.clippingLevel, val));
      }
      
      STATE.inputBuffer[i] = val;
    }
  }
}

// -------------------------------------------------------------
// DFT MATH ENGINE
// -------------------------------------------------------------

function performDFT() {
  const N = STATE.samplesCount;
  const K = STATE.coefCount;
  
  // Calculate average / DC Offset (a0)
  let sum = 0;
  for (let i = 0; i < N; i++) {
    sum += STATE.inputBuffer[i];
  }
  STATE.an[0] = sum / N;
  STATE.bn[0] = 0; // Sine has no DC term
  
  // Calculate an (cosines) and bn (sines) for n = 1 to 64
  for (let n = 1; n <= K; n++) {
    let cosSum = 0;
    let sinSum = 0;
    
    for (let i = 0; i < N; i++) {
      const angle = (2 * Math.PI * n * i) / N;
      cosSum += STATE.inputBuffer[i] * Math.cos(angle);
      sinSum += STATE.inputBuffer[i] * Math.sin(angle);
    }
    
    STATE.an[n] = (2 * cosSum) / N;
    STATE.bn[n] = (2 * sinSum) / N;
  }
}

function reconstructWaveform() {
  const N = STATE.samplesCount;
  const M = STATE.harmonicsLimit;
  
  for (let i = 0; i < N; i++) {
    let val = STATE.an[0]; // DC offset
    
    for (let n = 1; n <= M; n++) {
      const angle = (2 * Math.PI * n * i) / N;
      val += STATE.an[n] * Math.cos(angle) + STATE.bn[n] * Math.sin(angle);
    }
    
    STATE.reconstructedBuffer[i] = val;
  }
  
  updateStatistics();
  updateAudioSynthesis();
}

/**
 * Re-synthesizes the input buffer based on ALL 64 harmonics.
 * Used when user manually overrides the DFT coefficients in custom mode,
 * to ensure that the input (amber) wave matches their adjustments.
 */
function updateInputFromCoefficients() {
  const N = STATE.samplesCount;
  const K = STATE.coefCount;
  
  for (let i = 0; i < N; i++) {
    let val = STATE.an[0];
    for (let n = 1; n <= K; n++) {
      const angle = (2 * Math.PI * n * i) / N;
      val += STATE.an[n] * Math.cos(angle) + STATE.bn[n] * Math.sin(angle);
    }
    STATE.inputBuffer[i] = val;
  }
}

// Calculates RMS and energy stats
function updateStatistics() {
  const N = STATE.samplesCount;
  
  // Input RMS & Energy
  let inputSqSum = 0;
  for (let i = 0; i < N; i++) {
    inputSqSum += STATE.inputBuffer[i] * STATE.inputBuffer[i];
  }
  const inputRMS = Math.sqrt(inputSqSum / N);
  const inputEnergy = inputSqSum / N;
  
  // Reconstructed RMS & Energy
  let reconSqSum = 0;
  for (let i = 0; i < N; i++) {
    reconSqSum += STATE.reconstructedBuffer[i] * STATE.reconstructedBuffer[i];
  }
  const reconEnergy = reconSqSum / N;
  
  // Update UI Elements
  if (elements.rmsReading) {
    elements.rmsReading.textContent = `RMS: ${inputRMS.toFixed(4)}`;
  }
  if (elements.inputEnergyVal) {
    elements.inputEnergyVal.textContent = `${inputEnergy.toFixed(3)} W`;
  }
  if (elements.reconEnergyVal) {
    elements.reconEnergyVal.textContent = `${reconEnergy.toFixed(3)} W`;
  }
  
  // Synthesis Accuracy (Percentage of signal power captured by M harmonics)
  let accuracy = 0.0;
  if (inputEnergy > 0.0001) {
    accuracy = Math.min(100.0, (reconEnergy / inputEnergy) * 100);
  } else if (inputEnergy <= 0.0001 && reconEnergy <= 0.0001) {
    accuracy = 100.0;
  }
  if (elements.synthesisAccuracyVal) {
    elements.synthesisAccuracyVal.textContent = `${accuracy.toFixed(1)} %`;
  }
  
  // Fundamental Period
  if (elements.fundamentalPeriodVal) {
    const period = 1.0 / STATE.frequency;
    elements.fundamentalPeriodVal.textContent = `${period.toFixed(2)} s`;
  }
}

// -------------------------------------------------------------
// WEB AUDIO SYNTHESIS
// -------------------------------------------------------------

function initAudio() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioContextClass();
    
    // Master gain node
    masterGainNode = audioCtx.createGain();
    masterGainNode.gain.setValueAtTime(0.0, audioCtx.currentTime);
    masterGainNode.connect(audioCtx.destination);
    
    // Spawn oscillator bank for 100 harmonics
    for (let n = 1; n <= 100; n++) {
      const osc = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      
      // Harmonic frequency = n * f0
      osc.frequency.setValueAtTime(n * STATE.playingFreq, audioCtx.currentTime);
      g.gain.setValueAtTime(0.0, audioCtx.currentTime);
      
      osc.connect(g);
      g.connect(masterGainNode);
      
      osc.start();
      
      oscBank[n] = osc;
      gainBank[n] = g;
    }
  } catch (e) {
    console.error("Web Audio API not supported or blocked", e);
  }
}

function updateAudioSynthesis() {
  if (!audioCtx) return;
  
  const M = STATE.harmonicsLimit;
  const isSoundOn = STATE.soundEnabled;
  
  // Safe scaling factor to prevent clipping when up to 100 harmonics are summed
  const baseScale = 0.06; 
  
  for (let n = 1; n <= 100; n++) {
    if (!gainBank[n]) continue;
    
    if (isSoundOn && n <= M) {
      const an = STATE.an[n];
      const bn = STATE.bn[n];
      const magnitude = Math.sqrt(an * an + bn * bn);
      
      // Calculate target gain relative to coefficient magnitude and amplitude slider
      // Applying high-frequency attenuation (1/sqrt(n)) makes high harmonic overtones smooth rather than sharp
      const targetGain = magnitude * STATE.amplitude * baseScale * (1.0 / Math.sqrt(n)); 
      
      gainBank[n].gain.setTargetAtTime(targetGain, audioCtx.currentTime, 0.03);
    } else {
      // Fade active oscillators to zero when toggled off or beyond limits
      gainBank[n].gain.setTargetAtTime(0.0, audioCtx.currentTime, 0.015);
    }
  }
}

function toggleSound() {
  if (!audioCtx) {
    initAudio();
  }
  
  if (!audioCtx) return;
  
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  
  STATE.soundEnabled = !STATE.soundEnabled;
  
  if (STATE.soundEnabled) {
    masterGainNode.gain.setTargetAtTime(1.0, audioCtx.currentTime, 0.05);
    elements.soundToggle.classList.add('active');
    elements.soundToggle.querySelector('span').textContent = "Audio Synth: ON";
    updateAudioSynthesis();
  } else {
    masterGainNode.gain.setTargetAtTime(0.0, audioCtx.currentTime, 0.05);
    elements.soundToggle.classList.remove('active');
    elements.soundToggle.querySelector('span').textContent = "Audio Synth: OFF";
    // Mute all active generators inside the bank as well for safety
    updateAudioSynthesis();
  }
}

// -------------------------------------------------------------
// RENDER ENGINE (HTML5 CANVAS)
// -------------------------------------------------------------

// Helper to scale canvas for High-DPI screens
function resizeCanvasToDisplaySize(canvas, ctx) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  
  if (canvas.width !== width || canvas.height !== height) {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);
    return true;
  }
  return false;
}

// Renders the glowing CRT oscilloscope
function drawScope() {
  resizeCanvasToDisplaySize(scopeCanvas, scopeCtx);
  const w = scopeCanvas.width / (window.devicePixelRatio || 1);
  const h = scopeCanvas.height / (window.devicePixelRatio || 1);
  
  // Background
  scopeCtx.fillStyle = '#02040a';
  scopeCtx.fillRect(0, 0, w, h);
  
  // Render grid lines
  scopeCtx.strokeStyle = 'rgba(6, 182, 212, 0.05)';
  scopeCtx.lineWidth = 1;
  
  const gridCells = 16;
  const gridRows = 8;
  
  // Vertical grid
  for (let i = 0; i <= gridCells; i++) {
    const x = (i / gridCells) * w;
    scopeCtx.beginPath();
    scopeCtx.moveTo(x, 0);
    scopeCtx.lineTo(x, h);
    scopeCtx.stroke();
  }
  
  // Horizontal grid
  for (let i = 0; i <= gridRows; i++) {
    const y = (i / gridRows) * h;
    scopeCtx.beginPath();
    scopeCtx.moveTo(0, y);
    scopeCtx.lineTo(w, y);
    scopeCtx.stroke();
  }
  
  // Center axis lines
  scopeCtx.strokeStyle = 'rgba(6, 182, 212, 0.15)';
  scopeCtx.lineWidth = 1.5;
  
  // Horiz center
  scopeCtx.beginPath();
  scopeCtx.moveTo(0, h / 2);
  scopeCtx.lineTo(w, h / 2);
  scopeCtx.stroke();
  
  // Vert center
  scopeCtx.beginPath();
  scopeCtx.moveTo(w / 2, 0);
  scopeCtx.lineTo(w / 2, h);
  scopeCtx.stroke();
  
  // 1. Draw Original Waveform (Faint Amber glow)
  const N = STATE.samplesCount;
  
  scopeCtx.lineWidth = 1.5;
  scopeCtx.strokeStyle = 'rgba(245, 158, 11, 0.45)';
  scopeCtx.beginPath();
  
  // Draw two cycles for visual depth
  for (let i = 0; i < w; i++) {
    // Map canvas pixel X to sample coordinate
    // STATE.frequency determines how many cycles fit in the screen width
    const t = (i / w) * STATE.frequency;
    const sampleIdx = Math.floor((t % 1.0) * N);
    
    // Scale amplitude: +/- 1.0 maps to +/- 35% of scope height
    const val = STATE.inputBuffer[sampleIdx];
    const y = h / 2 - val * (h * 0.35);
    
    if (i === 0) scopeCtx.moveTo(i, y);
    else scopeCtx.lineTo(i, y);
  }
  scopeCtx.stroke();
  
  // 2. Draw Reconstructed Waveform (Intense Neon Cyber Cyan Glow)
  scopeCtx.shadowColor = 'rgba(6, 182, 212, 0.8)';
  scopeCtx.shadowBlur = 8;
  scopeCtx.strokeStyle = '#22d3ee';
  scopeCtx.lineWidth = 2.5;
  scopeCtx.beginPath();
  
  for (let i = 0; i < w; i++) {
    const t = (i / w) * STATE.frequency;
    const sampleIdx = Math.floor((t % 1.0) * N);
    
    const val = STATE.reconstructedBuffer[sampleIdx];
    const y = h / 2 - val * (h * 0.35);
    
    if (i === 0) scopeCtx.moveTo(i, y);
    else scopeCtx.lineTo(i, y);
  }
  scopeCtx.stroke();
  
  // Reset shadow effects
  scopeCtx.shadowBlur = 0;
  
  // 3. Draw high-precision HUD cursor & tooltip if hovering
  if (STATE.hoveredScope && !STATE.isDrawing) {
    const x = STATE.hoveredScope.x;
    
    // Draw vertical tracking guide-line
    scopeCtx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    scopeCtx.lineWidth = 1;
    scopeCtx.setLineDash([3, 3]);
    scopeCtx.beginPath();
    scopeCtx.moveTo(x, 0);
    scopeCtx.lineTo(x, h);
    scopeCtx.stroke();
    scopeCtx.setLineDash([]); // reset
    
    // Compute values at this column
    const t = (x / w) * STATE.frequency;
    let progress = t % 1.0;
    if (progress < 0) progress += 1.0;
    const sampleIdx = Math.floor(progress * N);
    
    if (sampleIdx >= 0 && sampleIdx < N) {
      const yOriginal = STATE.inputBuffer[sampleIdx];
      const yRecon = STATE.reconstructedBuffer[sampleIdx];
      
      const pyOriginal = h / 2 - yOriginal * (h * 0.35);
      const pyRecon = h / 2 - yRecon * (h * 0.35);
      
      // Draw highlight indicator dots on the waveforms
      // Original dot (Amber)
      scopeCtx.fillStyle = '#f59e0b';
      scopeCtx.shadowColor = '#f59e0b';
      scopeCtx.shadowBlur = 6;
      scopeCtx.beginPath();
      scopeCtx.arc(x, pyOriginal, 4, 0, 2 * Math.PI);
      scopeCtx.fill();
      
      // Reconstructed dot (Cyan)
      scopeCtx.fillStyle = '#22d3ee';
      scopeCtx.shadowColor = '#22d3ee';
      scopeCtx.shadowBlur = 6;
      scopeCtx.beginPath();
      scopeCtx.arc(x, pyRecon, 4, 0, 2 * Math.PI);
      scopeCtx.fill();
      scopeCtx.shadowBlur = 0; // reset
      
      // Render high-tech HUD Tooltip Box
      const pad = 8;
      const boxW = 120;
      const boxH = 65;
      
      // Position box to the right of cursor by default, flip to left if near right boundary
      let boxX = x + 15;
      if (boxX + boxW > w) {
        boxX = x - boxW - 15;
      }
      
      // Vertically center box relative to mouse Y, constrain within canvas height
      let boxY = STATE.hoveredScope.y - boxH / 2;
      boxY = Math.max(10, Math.min(h - boxH - 10, boxY));
      
      // Draw HUD box background (glassmorphic dark zinc-950)
      scopeCtx.fillStyle = 'rgba(9, 9, 11, 0.88)';
      scopeCtx.strokeStyle = 'rgba(6, 182, 212, 0.45)';
      scopeCtx.lineWidth = 1;
      
      scopeCtx.beginPath();
      if (scopeCtx.roundRect) {
        scopeCtx.roundRect(boxX, boxY, boxW, boxH, 6);
      } else {
        scopeCtx.rect(boxX, boxY, boxW, boxH);
      }
      scopeCtx.fill();
      scopeCtx.stroke();
      
      // Write text details
      scopeCtx.fillStyle = '#f3f4f6';
      scopeCtx.font = '10px monospace';
      scopeCtx.textAlign = 'left';
      
      const textX = boxX + pad;
      let textY = boxY + 14;
      
      // 1. Time / Phase progress
      scopeCtx.fillStyle = '#9ca3af';
      scopeCtx.fillText(`t/T: `, textX, textY);
      scopeCtx.fillStyle = '#ffffff';
      scopeCtx.fillText(`${progress.toFixed(3)}`, textX + 30, textY);
      
      // 2. Input Wave amplitude (Amber)
      textY += 15;
      scopeCtx.fillStyle = '#9ca3af';
      scopeCtx.fillText(`In : `, textX, textY);
      scopeCtx.fillStyle = '#f59e0b';
      scopeCtx.fillText(`${yOriginal.toFixed(3)}`, textX + 30, textY);
      
      // 3. Reconstructed Wave amplitude (Cyan)
      textY += 15;
      scopeCtx.fillStyle = '#9ca3af';
      scopeCtx.fillText(`Rec: `, textX, textY);
      scopeCtx.fillStyle = '#22d3ee';
      scopeCtx.fillText(`${yRecon.toFixed(3)}`, textX + 30, textY);
      
      // 4. Phase in Degrees
      textY += 13;
      const phaseDeg = Math.round(progress * 360);
      scopeCtx.fillStyle = '#6b7280';
      scopeCtx.fillText(`Phase: ${phaseDeg}°`, textX, textY);
    }
  }
}

// Renders the Sines / Cosines stems
function drawSpectrum(canvas, ctx, type) {
  resizeCanvasToDisplaySize(canvas, ctx);
  const w = canvas.width / (window.devicePixelRatio || 1);
  const h = canvas.height / (window.devicePixelRatio || 1);
  
  // Background
  ctx.fillStyle = '#02040a';
  ctx.fillRect(0, 0, w, h);
  
  // Draw center axis (0)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();
  
  // Draw harmonic grid lines
  const K = STATE.coefCount; // 64
  const paddingX = 20;
  const availWidth = w - paddingX * 2;
  const stepX = availWidth / K;
  
  // Draw stems
  const coefs = (type === 'sine') ? STATE.bn : STATE.an;
  const glowColor = (type === 'sine') ? 'rgba(244, 63, 94, 0.7)' : 'rgba(139, 92, 246, 0.7)';
  const stemColor = (type === 'sine') ? '#f43f5e' : '#a78bfa';
  
  ctx.lineWidth = 2;
  
  for (let n = 1; n <= K; n++) {
    const x = paddingX + (n - 1) * stepX;
    
    // Scale coefficient value: amplitude of 1.0 maps to 80% of half height
    const val = coefs[n];
    const y = h / 2 - val * (h * 0.4);
    
    // Highlight if harmonic is inside the terms reconstruction limit
    const isActive = n <= STATE.harmonicsLimit;
    
    ctx.strokeStyle = isActive ? stemColor : 'rgba(75, 85, 99, 0.3)';
    ctx.beginPath();
    ctx.moveTo(x, h / 2);
    ctx.lineTo(x, y);
    ctx.stroke();
    
    // Draw dot
    ctx.fillStyle = isActive ? stemColor : '#4b5563';
    
    // Hover / Active dot sizes
    let radius = 3;
    if (STATE.hoveredHarmonic && STATE.hoveredHarmonic.type === type && STATE.hoveredHarmonic.index === n) {
      radius = 6;
      ctx.shadowColor = glowColor;
      ctx.shadowBlur = 10;
      
      // Draw tooltip text
      ctx.fillStyle = '#ffffff';
      ctx.font = '10px monospace';
      ctx.fillText(`n=${n}: ${val.toFixed(2)}`, x - 15, (y < h/2 ? y - 10 : y + 15));
      ctx.fillStyle = stemColor;
    }
    
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, 2 * Math.PI);
    ctx.fill();
    ctx.shadowBlur = 0;
  }
}

function drawPhasors() {
  resizeCanvasToDisplaySize(phasorCanvas, phasorCtx);
  const w = phasorCanvas.width / (window.devicePixelRatio || 1);
  const h = phasorCanvas.height / (window.devicePixelRatio || 1);
  
  // Background
  phasorCtx.fillStyle = '#02040a';
  phasorCtx.fillRect(0, 0, w, h);
  
  // Center of epicycles (left side of screen)
  const cx = w * 0.28;
  const cy = h / 2;
  
  // Wave region (right side of screen)
  const waveStartX = w * 0.52;
  const waveEndX = w - 10;
  const waveWidth = waveEndX - waveStartX;
  
  // Animation speed factor (slightly slower for smoother scrolling)
  STATE.tOffset = (STATE.tOffset + 0.006) % 1.0;
  const t = STATE.tOffset;
  
  const M = STATE.harmonicsLimit;
  
  // Collect chained vectors
  let currentX = cx;
  let currentY = cy;
  
  // Scaling scale: A coefficient amplitude of 1.0 maps to 65px radius
  const scale = 65;
  
  // Include DC offset in center coordinate (canvas Y goes down, so subtract to move up)
  currentY -= STATE.an[0] * scale;
  
  // Draw starting crosshair for epicycles
  phasorCtx.strokeStyle = 'rgba(255, 255, 255, 0.02)';
  phasorCtx.lineWidth = 1;
  phasorCtx.beginPath();
  phasorCtx.moveTo(cx, 0); phasorCtx.lineTo(cx, h);
  phasorCtx.moveTo(0, cy); phasorCtx.lineTo(waveStartX, cy);
  phasorCtx.stroke();
  
  // Draw grid backing for scrolling wave
  phasorCtx.strokeStyle = 'rgba(6, 182, 212, 0.04)';
  phasorCtx.beginPath();
  phasorCtx.moveTo(waveStartX, cy);
  phasorCtx.lineTo(waveEndX, cy);
  // Grid lines
  for (let gy = cy - 2 * scale; gy <= cy + 2 * scale; gy += scale) {
    phasorCtx.moveTo(waveStartX, gy);
    phasorCtx.lineTo(waveEndX, gy);
  }
  phasorCtx.stroke();
  
  // Add harmonics terms tip to tail
  for (let n = 1; n <= M; n++) {
    const an = STATE.an[n];
    const bn = STATE.bn[n];
    
    // Magnitude (radius)
    const r = Math.sqrt(an*an + bn*bn) * scale;
    if (r < 0.5) continue; // skip tiny circles for optimization
    
    // Phasor angle at current time progress t
    const angle = 2 * Math.PI * n * t;
    
    // 2D components of rotating vector:
    // Y matches standard term: an * cos(nθ) + bn * sin(nθ)
    // X matches orthogonal phase shift: an * sin(nθ) - bn * cos(nθ)
    const dx = (an * Math.sin(angle) - bn * Math.cos(angle)) * scale;
    const dy = (an * Math.cos(angle) + bn * Math.sin(angle)) * scale;
    
    const nextX = currentX + dx;
    const nextY = currentY - dy; // Subtract because canvas Y points downwards
    
    // Draw vector circle
    phasorCtx.strokeStyle = `rgba(59, 130, 246, ${Math.max(0.15, 0.45 - n * 0.015)})`;
    phasorCtx.lineWidth = 1;
    phasorCtx.beginPath();
    phasorCtx.arc(currentX, currentY, r, 0, 2 * Math.PI);
    phasorCtx.stroke();
    
    // Draw vector line arrow
    phasorCtx.strokeStyle = n === 1 ? 'rgba(245, 158, 11, 0.95)' : 'rgba(6, 182, 212, 0.85)';
    phasorCtx.lineWidth = n === 1 ? 1.5 : 1;
    phasorCtx.beginPath();
    phasorCtx.moveTo(currentX, currentY);
    phasorCtx.lineTo(nextX, nextY);
    phasorCtx.stroke();
    
    // Advance center
    currentX = nextX;
    currentY = nextY;
  }
  
  // Draw final pointer dot
  phasorCtx.fillStyle = '#22d3ee';
  phasorCtx.shadowColor = '#22d3ee';
  phasorCtx.shadowBlur = 4;
  phasorCtx.beginPath();
  phasorCtx.arc(currentX, currentY, 3.5, 0, 2 * Math.PI);
  phasorCtx.fill();
  phasorCtx.shadowBlur = 0;
  
  // Draw dashed horizontal tracker line
  phasorCtx.strokeStyle = 'rgba(34, 211, 238, 0.45)';
  phasorCtx.lineWidth = 1;
  phasorCtx.setLineDash([4, 4]);
  phasorCtx.beginPath();
  phasorCtx.moveTo(currentX, currentY);
  phasorCtx.lineTo(waveStartX, currentY);
  phasorCtx.stroke();
  phasorCtx.setLineDash([]); // reset dash
  
  // Draw the scrolling 1D wave on the right side
  phasorCtx.strokeStyle = '#22d3ee';
  phasorCtx.shadowColor = 'rgba(6, 182, 212, 0.4)';
  phasorCtx.shadowBlur = 4;
  phasorCtx.lineWidth = 1.8;
  phasorCtx.beginPath();
  
  for (let x = waveStartX; x <= waveEndX; x++) {
    const dx = (x - waveStartX) / waveWidth;
    // t_col represents phase moving backward from current pointer t
    const t_col = t - dx;
    
    // Wrap safely
    let progress = t_col % 1.0;
    if (progress < 0) progress += 1.0;
    
    // Calculate reconstructed sum at this phase progress
    let val = STATE.an[0];
    for (let n = 1; n <= M; n++) {
      const angle = 2 * Math.PI * n * progress;
      val += STATE.an[n] * Math.cos(angle) + STATE.bn[n] * Math.sin(angle);
    }
    
    const yVal = cy - val * scale;
    
    if (x === waveStartX) {
      phasorCtx.moveTo(x, yVal);
    } else {
      phasorCtx.lineTo(x, yVal);
    }
  }
  phasorCtx.stroke();
  phasorCtx.shadowBlur = 0;
}

// -------------------------------------------------------------
// EVENT HANDLERS & MOUSE INTERACTION
// -------------------------------------------------------------

function setupEventListeners() {
  // Sound toggle button
  elements.soundToggle.addEventListener('click', toggleSound);
  
  // Playing frequency (pitch) slider
  elements.playingFreq.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    STATE.playingFreq = sliderToFreq(val);
    elements.playingFreqVal.textContent = `${STATE.playingFreq} Hz`;
    
    if (audioCtx) {
      for (let n = 1; n <= 100; n++) {
        if (oscBank[n]) {
          oscBank[n].frequency.setTargetAtTime(n * STATE.playingFreq, audioCtx.currentTime, 0.03);
        }
      }
    }
  });

  // Harmonics count slider
  elements.harmonicsCount.addEventListener('input', (e) => {
    STATE.harmonicsLimit = parseInt(e.target.value);
    elements.harmonicsCountVal.textContent = STATE.harmonicsLimit;
    reconstructWaveform();
  });

  // Signal Generator controls
  elements.amplitude.addEventListener('input', (e) => {
    STATE.amplitude = parseFloat(e.target.value);
    elements.amplitudeVal.textContent = STATE.amplitude.toFixed(2);
    setPresetMode(STATE.activePreset);
  });

  elements.freq.addEventListener('input', (e) => {
    STATE.frequency = parseFloat(e.target.value);
    elements.freqVal.textContent = `${STATE.frequency.toFixed(1)} Hz`;
    setPresetMode(STATE.activePreset);
  });

  elements.phase.addEventListener('input', (e) => {
    STATE.phase = parseFloat(e.target.value);
    elements.phaseVal.textContent = `${STATE.phase.toFixed(2)} rad`;
    setPresetMode(STATE.activePreset);
  });

  // Presets buttons
  elements.presets.forEach(btn => {
    btn.addEventListener('click', () => {
      elements.presets.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const presetName = btn.dataset.preset;
      
      // Update state
      STATE.activePreset = presetName;
      computeInputWaveform();
      performDFT();
      reconstructWaveform();
    });
  });

  // Rectification controls
  elements.rectifyNone.addEventListener('click', () => {
    elements.rectifyNone.classList.add('active');
    elements.rectifyHalf.classList.remove('active');
    elements.rectifyFull.classList.remove('active');
    STATE.rectification = 'none';
    setPresetMode(STATE.activePreset);
  });

  elements.rectifyHalf.addEventListener('click', () => {
    elements.rectifyNone.classList.remove('active');
    elements.rectifyHalf.classList.add('active');
    elements.rectifyFull.classList.remove('active');
    STATE.rectification = 'half';
    setPresetMode(STATE.activePreset);
  });

  elements.rectifyFull.addEventListener('click', () => {
    elements.rectifyNone.classList.remove('active');
    elements.rectifyHalf.classList.remove('active');
    elements.rectifyFull.classList.add('active');
    STATE.rectification = 'full';
    setPresetMode(STATE.activePreset);
  });

  // Clipping Toggle
  elements.toggleClipping.addEventListener('click', () => {
    STATE.clippingEnabled = !STATE.clippingEnabled;
    if (STATE.clippingEnabled) {
      elements.toggleClipping.classList.add('active');
      elements.toggleClipping.textContent = "Clipping ON";
      elements.clippingSliderGroup.style.opacity = '1.0';
      elements.clippingSliderGroup.style.pointerEvents = 'auto';
    } else {
      elements.toggleClipping.classList.remove('active');
      elements.toggleClipping.textContent = "Clipping OFF";
      elements.clippingSliderGroup.style.opacity = '0.4';
      elements.clippingSliderGroup.style.pointerEvents = 'none';
    }
    setPresetMode(STATE.activePreset);
  });

  elements.clipping.addEventListener('input', (e) => {
    STATE.clippingLevel = parseFloat(e.target.value);
    elements.clippingVal.textContent = STATE.clippingLevel.toFixed(2);
    setPresetMode(STATE.activePreset);
  });

  // Clear button
  elements.btnClear.addEventListener('click', () => {
    // Flatten input buffer
    STATE.activePreset = 'custom';
    elements.presets.forEach(b => b.classList.remove('active'));
    
    for (let i = 0; i < STATE.samplesCount; i++) {
      STATE.inputBuffer[i] = 0;
    }
    
    // Clear spectrum coefficients
    STATE.an.fill(0);
    STATE.bn.fill(0);
    
    reconstructWaveform();
  });

  // Noise Insertion Controls
  elements.noiseNone.addEventListener('click', () => {
    setNoiseMode('none');
  });
  elements.noiseWhite.addEventListener('click', () => {
    setNoiseMode('white');
  });
  elements.noiseSine.addEventListener('click', () => {
    setNoiseMode('sine');
  });

  elements.noiseAmp.addEventListener('input', (e) => {
    STATE.noiseAmplitude = parseFloat(e.target.value);
    elements.noiseAmpVal.textContent = STATE.noiseAmplitude.toFixed(2);
    setPresetMode(STATE.activePreset);
  });

  elements.noiseFreq.addEventListener('input', (e) => {
    STATE.noiseFreqMultiple = parseInt(e.target.value);
    elements.noiseFreqVal.textContent = `${STATE.noiseFreqMultiple}x`;
    setPresetMode(STATE.activePreset);
  });

  // Helper trigger to maintain preset state updates
  function setPresetMode(preset) {
    computeInputWaveform();
    performDFT();
    reconstructWaveform();
  }

  function setNoiseMode(mode) {
    elements.noiseNone.classList.remove('active');
    elements.noiseWhite.classList.remove('active');
    elements.noiseSine.classList.remove('active');
    
    STATE.noiseMode = mode;
    
    if (mode === 'none') {
      elements.noiseNone.classList.add('active');
      elements.noiseAmpSliderGroup.style.opacity = '0.4';
      elements.noiseAmpSliderGroup.style.pointerEvents = 'none';
      elements.noiseFreqSliderGroup.style.opacity = '0.4';
      elements.noiseFreqSliderGroup.style.pointerEvents = 'none';
    } else if (mode === 'white') {
      elements.noiseWhite.classList.add('active');
      elements.noiseAmpSliderGroup.style.opacity = '1.0';
      elements.noiseAmpSliderGroup.style.pointerEvents = 'auto';
      elements.noiseFreqSliderGroup.style.opacity = '0.4';
      elements.noiseFreqSliderGroup.style.pointerEvents = 'none';
    } else if (mode === 'sine') {
      elements.noiseSine.classList.add('active');
      elements.noiseAmpSliderGroup.style.opacity = '1.0';
      elements.noiseAmpSliderGroup.style.pointerEvents = 'auto';
      elements.noiseFreqSliderGroup.style.opacity = '1.0';
      elements.noiseFreqSliderGroup.style.pointerEvents = 'auto';
    }
    
    setPresetMode(STATE.activePreset);
  }

  // -------------------------------------------------------------
  // OSCILLOSCOPE DRAWING CAPTURE
  // -------------------------------------------------------------
  
  // Safe wrapping modulo helper to prevent negative indexes in JS
  const wrapIdx = (val, max) => ((val % max) + max) % max;

  function handleOscilloscopeDraw(e) {
    const rect = scopeCanvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    
    const w = rect.width;
    const h = rect.height;
    
    // Normalize coordinates: X to time scale, Y to amplitude scale
    // Map scope width coordinates to cycles based on active frequency (multiplied, not divided!)
    const t = (x / w) * STATE.frequency;
    
    // Amplitude: central line is 0, upward is positive, downward is negative
    // Range of canvas values are +/- 1.0 mapped to +/- 35% height
    const ampVal = (h / 2 - y) / (h * 0.35);
    
    // Constrain custom values inside reasonable scope [-1.2, 1.2]
    const clampedAmp = Math.max(-1.2, Math.min(1.2, ampVal));
    
    // Calculate discrete sample index in buffer wrapping appropriately
    let progress = t % 1.0;
    if (progress < 0) progress += 1.0;
    const sampleIdx = Math.floor(progress * STATE.samplesCount);
    
    if (sampleIdx >= 0 && sampleIdx < STATE.samplesCount) {
      STATE.activePreset = 'custom';
      elements.presets.forEach(b => b.classList.remove('active'));
      
      STATE.inputBuffer[sampleIdx] = clampedAmp;
      
      // Interpolate gap fill (smooth out jumps if mouse moves fast)
      if (this.lastDrawIndex !== undefined) {
        let start = this.lastDrawIndex;
        let end = sampleIdx;
        
        // Wrap around path if drawing direction crosses period boundary
        if (Math.abs(end - start) > STATE.samplesCount / 2) {
          if (start > end) end += STATE.samplesCount;
          else start += STATE.samplesCount;
        }
        
        const step = start < end ? 1 : -1;
        const steps = Math.abs(end - start);
        
        for (let s = 1; s < steps; s++) {
          const currIdx = wrapIdx(start + s * step, STATE.samplesCount);
          const pct = s / steps;
          const interpVal = this.lastDrawVal + (clampedAmp - this.lastDrawVal) * pct;
          STATE.inputBuffer[currIdx] = interpVal;
        }
      }
      
      this.lastDrawIndex = sampleIdx;
      this.lastDrawVal = clampedAmp;
      
      // Calculate real-time coefficients & reconstruction on modifications
      performDFT();
      reconstructWaveform();
    }
  }
  
  scopeCanvas.addEventListener('mousedown', (e) => {
    STATE.isDrawing = true;
    handleOscilloscopeDraw.call(scopeCanvas, e);
  });
  
  window.addEventListener('mouseup', () => {
    STATE.isDrawing = false;
    if (scopeCanvas) {
      scopeCanvas.lastDrawIndex = undefined;
      scopeCanvas.lastDrawVal = undefined;
    }
  });
  
  scopeCanvas.addEventListener('mousemove', (e) => {
    const rect = scopeCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    if (STATE.isDrawing) {
      handleOscilloscopeDraw.call(scopeCanvas, e);
      STATE.hoveredScope = null;
    } else {
      STATE.hoveredScope = { x, y };
    }
  });

  scopeCanvas.addEventListener('mouseleave', () => {
    STATE.hoveredScope = null;
  });

  // Touch support for tablets/mobiles
  scopeCanvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    STATE.isDrawing = true;
    STATE.hoveredScope = null;
    handleOscilloscopeDraw.call(scopeCanvas, e);
  }, { passive: false });
  
  scopeCanvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (STATE.isDrawing) {
      handleOscilloscopeDraw.call(scopeCanvas, e);
      STATE.hoveredScope = null;
    } else {
      const rect = scopeCanvas.getBoundingClientRect();
      const x = e.touches[0].clientX - rect.left;
      const y = e.touches[0].clientY - rect.top;
      STATE.hoveredScope = { x, y };
    }
  }, { passive: false });
  
  scopeCanvas.addEventListener('touchend', () => {
    STATE.hoveredScope = null;
  });

  // -------------------------------------------------------------
  // DRAGGABLE HARMONICS INTERACTION (Sweep-to-Draw Spectrum Editor)
  // -------------------------------------------------------------
  
  function getSpectrumHarmonicAtCoord(canvas, e, type) {
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    
    const w = rect.width;
    const h = rect.height;
    
    const K = STATE.coefCount;
    const paddingX = 20;
    const availWidth = w - paddingX * 2;
    const stepX = availWidth / K;
    
    // Find closest horizontal harmonic column index n
    const n = Math.round(((x - paddingX) / stepX) + 1);
    
    if (n >= 1 && n <= K) {
      return { type, index: n, x, y, width: w, height: h };
    }
    return null;
  }
  
  function handleSpectrumDragUpdate(canvas, e, type) {
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    
    const w = rect.width;
    const h = rect.height;
    
    const K = STATE.coefCount;
    const paddingX = 20;
    const availWidth = w - paddingX * 2;
    const stepX = availWidth / K;
    
    // Smoothly drag across multiple harmonic columns (Sweep to Draw!)
    const n = Math.max(1, Math.min(K, Math.round(((x - paddingX) / stepX) + 1)));
    
    // Calculate new coefficient value: amplitude scale maps to +/- 80% half height
    const val = (h / 2 - y) / (h * 0.4);
    const clampedVal = Math.max(-1.1, Math.min(1.1, val));
    
    // Update coefficient
    if (type === 'sine') {
      STATE.bn[n] = clampedVal;
    } else {
      STATE.an[n] = clampedVal;
    }
    
    // Auto-update hovered coordinate details
    STATE.hoveredHarmonic = { type, index: n };
    
    // Re-synthesize waveform additively from modified terms
    STATE.activePreset = 'custom';
    elements.presets.forEach(b => b.classList.remove('active'));
    
    updateInputFromCoefficients();
    reconstructWaveform();
  }
  
  // Set listeners on Sine canvas
  sineCanvas.addEventListener('mousedown', (e) => {
    const hit = getSpectrumHarmonicAtCoord(sineCanvas, e, 'sine');
    if (hit) {
      STATE.activeSpectrumDrag = hit;
      handleSpectrumDragUpdate(sineCanvas, e, 'sine');
    }
  });
  
  sineCanvas.addEventListener('mousemove', (e) => {
    const hit = getSpectrumHarmonicAtCoord(sineCanvas, e, 'sine');
    STATE.hoveredHarmonic = hit;
    
    if (STATE.activeSpectrumDrag && STATE.activeSpectrumDrag.type === 'sine') {
      handleSpectrumDragUpdate(sineCanvas, e, 'sine');
    }
  });

  // Set listeners on Cosine canvas
  cosineCanvas.addEventListener('mousedown', (e) => {
    const hit = getSpectrumHarmonicAtCoord(cosineCanvas, e, 'cosine');
    if (hit) {
      STATE.activeSpectrumDrag = hit;
      handleSpectrumDragUpdate(cosineCanvas, e, 'cosine');
    }
  });
  
  cosineCanvas.addEventListener('mousemove', (e) => {
    const hit = getSpectrumHarmonicAtCoord(cosineCanvas, e, 'cosine');
    STATE.hoveredHarmonic = hit;
    
    if (STATE.activeSpectrumDrag && STATE.activeSpectrumDrag.type === 'cosine') {
      handleSpectrumDragUpdate(cosineCanvas, e, 'cosine');
    }
  });

  // General release on window
  window.addEventListener('mouseup', () => {
    STATE.activeSpectrumDrag = null;
  });
  
  // Touch support for spectrums
  sineCanvas.addEventListener('touchstart', (e) => {
    const hit = getSpectrumHarmonicAtCoord(sineCanvas, e, 'sine');
    if (hit) {
      e.preventDefault();
      STATE.activeSpectrumDrag = hit;
      handleSpectrumDragUpdate(sineCanvas, e, 'sine');
    }
  }, { passive: false });
  
  sineCanvas.addEventListener('touchmove', (e) => {
    if (STATE.activeSpectrumDrag && STATE.activeSpectrumDrag.type === 'sine') {
      e.preventDefault();
      handleSpectrumDragUpdate(sineCanvas, e, 'sine');
    }
  }, { passive: false });
  
  cosineCanvas.addEventListener('touchstart', (e) => {
    const hit = getSpectrumHarmonicAtCoord(cosineCanvas, e, 'cosine');
    if (hit) {
      e.preventDefault();
      STATE.activeSpectrumDrag = hit;
      handleSpectrumDragUpdate(cosineCanvas, e, 'cosine');
    }
  }, { passive: false });
  
  cosineCanvas.addEventListener('touchmove', (e) => {
    if (STATE.activeSpectrumDrag && STATE.activeSpectrumDrag.type === 'cosine') {
      e.preventDefault();
      handleSpectrumDragUpdate(cosineCanvas, e, 'cosine');
    }
  }, { passive: false });
}

// -------------------------------------------------------------
// ENGINE INITIALIZATION & LOOPS
// -------------------------------------------------------------

function getDOMReferences() {
  elements.soundToggle = document.getElementById('soundToggle');
  elements.playingFreq = document.getElementById('playingFreq');
  elements.playingFreqVal = document.getElementById('playingFreqVal');
  elements.harmonicsCount = document.getElementById('harmonicsCount');
  elements.harmonicsCountVal = document.getElementById('harmonicsCountVal');
  elements.amplitude = document.getElementById('amplitude');
  elements.amplitudeVal = document.getElementById('amplitudeVal');
  elements.freq = document.getElementById('freq');
  elements.freqVal = document.getElementById('freqVal');
  elements.phase = document.getElementById('phase');
  elements.phaseVal = document.getElementById('phaseVal');
  elements.presets = document.querySelectorAll('[data-preset]');
  
  // rects
  elements.rectifyNone = document.getElementById('rectifyNone');
  elements.rectifyHalf = document.getElementById('rectifyHalf');
  elements.rectifyFull = document.getElementById('rectifyFull');
  elements.toggleClipping = document.getElementById('toggleClipping');
  elements.clipping = document.getElementById('clipping');
  elements.clippingVal = document.getElementById('clippingVal');
  elements.clippingSliderGroup = document.getElementById('clippingSliderGroup');
  
  // Noise elements
  elements.noiseNone = document.getElementById('noiseNone');
  elements.noiseWhite = document.getElementById('noiseWhite');
  elements.noiseSine = document.getElementById('noiseSine');
  elements.noiseAmp = document.getElementById('noiseAmp');
  elements.noiseAmpVal = document.getElementById('noiseAmpVal');
  elements.noiseFreq = document.getElementById('noiseFreq');
  elements.noiseFreqVal = document.getElementById('noiseFreqVal');
  elements.noiseAmpSliderGroup = document.getElementById('noiseAmpSliderGroup');
  elements.noiseFreqSliderGroup = document.getElementById('noiseFreqSliderGroup');
  
  // Buttons
  elements.btnClear = document.getElementById('btnClear');
  
  // Reading outputs
  elements.rmsReading = document.getElementById('rmsReading');
  elements.inputEnergyVal = document.getElementById('inputEnergyVal');
  elements.reconEnergyVal = document.getElementById('reconEnergyVal');
  elements.synthesisAccuracyVal = document.getElementById('synthesisAccuracyVal');
  elements.fundamentalPeriodVal = document.getElementById('fundamentalPeriodVal');
}

function appInit() {
  // Canvases
  scopeCanvas = document.getElementById('scopeCanvas');
  scopeCtx = scopeCanvas.getContext('2d');
  
  sineCanvas = document.getElementById('sineSpectrumCanvas');
  sineCtx = sineCanvas.getContext('2d');
  
  cosineCanvas = document.getElementById('cosineSpectrumCanvas');
  cosineCtx = cosineCanvas.getContext('2d');
  
  phasorCanvas = document.getElementById('phasorCanvas');
  phasorCtx = phasorCanvas.getContext('2d');
  
  getDOMReferences();
  setupEventListeners();
  
  // Generate initial state
  computeInputWaveform();
  performDFT();
  reconstructWaveform();
  
  // Run primary animation loop (60 FPS requestAnimationFrame)
  function renderLoop() {
    drawScope();
    drawSpectrum(sineCanvas, sineCtx, 'sine');
    drawSpectrum(cosineCanvas, cosineCtx, 'cosine');
    drawPhasors();
    
    requestAnimationFrame(renderLoop);
  }
  
  requestAnimationFrame(renderLoop);
}

// Initialise app on window load
window.addEventListener('DOMContentLoaded', appInit);
