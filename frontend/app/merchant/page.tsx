'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { api, API_URL, CV_SERVICE_URL } from '../../lib/api';

export default function MerchantPage() {
  // --- Core state ---
  const [amount, setAmount] = useState('');
  const [merchantUpi, setMerchantUpi] = useState('merchant@upi');
  const [scanning, setScanning] = useState(false);
  const [faceHash, setFaceHash] = useState('');
  const [fingerprintHash, setFingerprintHash] = useState('');
  const [confidence, setConfidence] = useState(0);
  const [tier, setTier] = useState('');
  const [walletId, setWalletId] = useState('');
  const [balance, setBalance] = useState(0);
  const [requiresFingerprint, setRequiresFingerprint] = useState(false);
  const [requiresOTP, setRequiresOTP] = useState(false);
  const [otp, setOtp] = useState('');
  const [challenge, setChallenge] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [transactionId, setTransactionId] = useState('');
  const [step, setStep] = useState('scan');
  const [displayedConfidence, setDisplayedConfidence] = useState(0);

  // --- New glassmorphism state ---
  const [merchantName, setMerchantName] = useState('Sharma Electronics');
  const [storeId] = useState(() => 'POS-' + Math.random().toString(36).substring(2, 8).toUpperCase());
  const [currentTime, setCurrentTime] = useState(new Date());
  const [riskScore, setRiskScore] = useState<number | null>(null);
  const [riskReasoning, setRiskReasoning] = useState('');
  const [recommendedTier, setRecommendedTier] = useState('');
  const [speaking, setSpeaking] = useState(false);
  const [faceVerified, setFaceVerified] = useState(false);
  const [fingerprintVerified, setFingerprintVerified] = useState(false);
  const [scanningFingerprint, setScanningFingerprint] = useState(false);
  const [showDistressPin, setShowDistressPin] = useState(false);
  const [distressPin, setDistressPin] = useState('');
  const [paymentTimestamp, setPaymentTimestamp] = useState('');

  const videoRef = useRef<HTMLVideoElement>(null);
  const fingerprintVideoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fingerprintStreamRef = useRef<MediaStream | null>(null);
  const isMountedRef = useRef(true);
  const confidenceIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const challenges = [
    'Please blink twice',
    'Turn your head slightly left',
    'Hold up 2 fingers',
  ];

  // --- Live clock ---
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // --- Tier calculation ---
  useEffect(() => {
    const amountNum = parseFloat(amount) || 0;
    if (amountNum < 200) {
      setTier('Face Only');
      setRequiresFingerprint(false);
      setRequiresOTP(false);
    } else if (amountNum < 1000) {
      setTier('Face + Fingerprint');
      setRequiresFingerprint(true);
      setRequiresOTP(false);
    } else {
      setTier('Face + Fingerprint + OTP');
      setRequiresFingerprint(true);
      setRequiresOTP(true);
    }
  }, [amount]);

  // --- Cleanup on unmount ---
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      stopCamera('face');
      stopCamera('fingerprint');
      if (confidenceIntervalRef.current) clearInterval(confidenceIntervalRef.current);
      if (fingerprintTimerRef.current) clearInterval(fingerprintTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startCamera = async (target: 'face' | 'fingerprint') => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 },
      });
      if (target === 'face') {
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
      } else {
        fingerprintStreamRef.current = stream;
        if (fingerprintVideoRef.current) fingerprintVideoRef.current.srcObject = stream;
      }
    } catch {
      setError('Camera access denied. Please enable camera permissions.');
    }
  };

  const stopCamera = (target: 'face' | 'fingerprint') => {
    const ref = target === 'face' ? streamRef : fingerprintStreamRef;
    if (ref.current) {
      ref.current.getTracks().forEach((track) => track.stop());
      ref.current = null;
    }
  };

  const animateConfidence = (targetScore: number) => {
    setDisplayedConfidence(0);
    if (confidenceIntervalRef.current) clearInterval(confidenceIntervalRef.current);
    const duration = 2000;
    const steps = 60;
    const increment = targetScore / steps;
    const intervalTime = duration / steps;
    let currentStep = 0;
    confidenceIntervalRef.current = setInterval(() => {
      currentStep++;
      if (currentStep >= steps) {
        setDisplayedConfidence(targetScore);
        if (confidenceIntervalRef.current) clearInterval(confidenceIntervalRef.current);
      } else {
        setDisplayedConfidence(Math.floor(currentStep * increment));
      }
    }, intervalTime);
  };

  const playPCMAudio = useCallback((base64Data: string): Promise<void> => {
    return new Promise((resolve, reject) => {
      try {
        const audioContext = new AudioContext({ sampleRate: 24000 });
        const pcmData = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
        const float32 = new Float32Array(pcmData.length / 2);
        const dataView = new DataView(pcmData.buffer);
        for (let i = 0; i < float32.length; i++) {
          float32[i] = dataView.getInt16(i * 2, true) / 32768;
        }
        const buffer = audioContext.createBuffer(1, float32.length, 24000);
        buffer.getChannelData(0).set(float32);
        const source = audioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(audioContext.destination);
        source.onended = () => {
          audioContext.close();
          resolve();
        };
        source.start();
      } catch (err) {
        reject(err);
      }
    });
  }, []);

  const speakConfirmation = useCallback(async (
    text: string,
    txAmount?: string,
    txMerchantName?: string,
    txTransactionId?: string,
  ) => {
    setSpeaking(true);

    // Try Nova 2 Sonic backend first
    if (txAmount && txMerchantName && txTransactionId) {
      try {
        const response = await fetch(`${API_URL}/api/voice/confirm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amount: parseFloat(txAmount),
            merchant_name: txMerchantName,
            transaction_id: txTransactionId,
          }),
        });
        const data = await response.json();
        if (data.audio_base64) {
          await playPCMAudio(data.audio_base64);
          setSpeaking(false);
          return;
        }
      } catch (err) {
        console.warn('Nova 2 Sonic voice failed, falling back to SpeechSynthesis:', err);
      }
    }

    // Fallback to browser SpeechSynthesis
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      setSpeaking(false);
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.95;
    utterance.pitch = 1.0;
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    window.speechSynthesis.speak(utterance);
  }, [playPCMAudio]);

  // ===================== FACE SCAN =====================
  const handleScanCustomer = async () => {
    if (!amount || parseFloat(amount) <= 0) {
      setError('Please enter a valid amount');
      return;
    }

    setChallenge(challenges[Math.floor(Math.random() * challenges.length)]);
    setLoading(true);
    setError('');
    setScanning(true);

    await startCamera('face');
    // Give camera time to initialize
    await new Promise((r) => setTimeout(r, 1000));

    try {
      const canvas = document.createElement('canvas');
      const video = videoRef.current!;
      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 480;
      const ctx = canvas.getContext('2d');
      ctx?.drawImage(video, 0, 0);

      const blob = await new Promise<Blob>((resolve) => {
        canvas.toBlob((b) => resolve(b!), 'image/jpeg');
      });

      const formData = new FormData();
      formData.append('image', blob, 'face.jpg');

      const hashResponse = await fetch(`${CV_SERVICE_URL}/hash-face`, {
        method: 'POST',
        body: formData,
      });
      const hashData = await hashResponse.json();

      if (hashData.error) {
        setError(hashData.error);
        setScanning(false);
        stopCamera('face');
        setLoading(false);
        return;
      }

      setFaceHash(hashData.hash);
      setConfidence(hashData.confidence || 85);
      animateConfidence(hashData.confidence || 85);

      // Authenticate with backend
      const authData = await api.post('/api/payment/authenticate', {
        face_hash: hashData.hash,
        amount: parseFloat(amount),
        fingerprint_hash: null,
      });

      if (!authData.authenticated) {
        setError(authData.error || 'Authentication failed');
        setScanning(false);
        stopCamera('face');
        setLoading(false);
        return;
      }

      setWalletId(authData.wallet_id);
      setBalance(authData.balance);
      setConfidence(authData.confidence_score);

      // Extract Nova AI risk data from backend
      if (authData.risk_score !== undefined) setRiskScore(authData.risk_score);
      if (authData.reasoning) setRiskReasoning(authData.reasoning);
      if (authData.recommended_tier) setRecommendedTier(authData.recommended_tier);

      setFaceVerified(true);
      setScanning(false);
      stopCamera('face');

      // Determine next step
      if (requiresFingerprint) {
        setStep('fingerprint');
      } else if (requiresOTP) {
        setStep('otp');
      }
      // Otherwise stay on scan screen -- user clicks COMPLETE PAYMENT
    } catch {
      setError('Scan failed. Please try again.');
      setScanning(false);
      stopCamera('face');
    }
    setLoading(false);
  };

  // ===================== FINGERPRINT =====================
  const [fingerprintProgress, setFingerprintProgress] = useState(0);
  const [fingerprintScanning, setFingerprintScanning] = useState(false);
  const fingerprintTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const handleStartFingerprintScan = async () => {
    setScanningFingerprint(true);
    setFingerprintScanning(false);
    setFingerprintProgress(0);
  };

  /** Simulates a fingerprint scan with progress animation, then verifies. */
  const handleFingerprintTouch = async () => {
    if (fingerprintScanning) return;
    setFingerprintScanning(true);
    setFingerprintProgress(0);
    setError('');

    // Animate progress 0→100 over ~2s
    let prog = 0;
    fingerprintTimerRef.current = setInterval(() => {
      prog += 2;
      setFingerprintProgress(Math.min(prog, 100));
      if (prog >= 100 && fingerprintTimerRef.current) {
        clearInterval(fingerprintTimerRef.current);
        fingerprintTimerRef.current = null;
      }
    }, 40);

    // Wait for animation to complete
    await new Promise((r) => setTimeout(r, 2100));

    setLoading(true);

    try {
      // Generate mock fingerprint hash (simulates CV service response)
      const mockHash = Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

      setFingerprintHash(mockHash);

      // Re-authenticate with fingerprint
      const authData = await api.post('/api/payment/authenticate', {
        face_hash: faceHash,
        fingerprint_hash: mockHash,
        amount: parseFloat(amount),
      });

      if (!authData.authenticated) {
        setError(authData.error || 'Fingerprint verification failed');
        setFingerprintScanning(false);
        setLoading(false);
        return;
      }

      // Update risk data
      if (authData.risk_score !== undefined) setRiskScore(authData.risk_score);
      if (authData.reasoning) setRiskReasoning(authData.reasoning);
      if (authData.recommended_tier) setRecommendedTier(authData.recommended_tier);

      setFingerprintVerified(true);
      setScanningFingerprint(false);
      setFingerprintScanning(false);

      if (requiresOTP) {
        setStep('otp');
      } else {
        setStep('scan');
      }
    } catch {
      setError('Fingerprint verification failed. Please try again.');
      setFingerprintScanning(false);
    }
    setLoading(false);
  };

  // ===================== PAYMENT =====================
  const executePayment = async (wallet_id: string) => {
    setLoading(true);
    setError('');

    try {
      let gps_lat = 28.7041;
      let gps_lng = 77.1025;
      try {
        const position: GeolocationPosition = await new Promise((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 5000 });
        });
        gps_lat = position.coords.latitude;
        gps_lng = position.coords.longitude;
      } catch {
        console.warn('Geolocation unavailable, using fallback coordinates');
      }

      const data = await api.post('/api/payment/execute', {
        wallet_id,
        amount: parseFloat(amount),
        merchant_upi: merchantUpi,
        gps_lat,
        gps_lng,
        confidence_score: confidence,
      });

      if (data.transaction_id) {
        setTransactionId(data.transaction_id);
        setBalance(data.remaining_balance);
        setPaymentTimestamp(new Date().toLocaleString());
        setStep('success');
        setSuccess(true);

        // Voice confirmation (try Nova 2 Sonic, fallback to SpeechSynthesis)
        const confirmText =
          data.voice_confirmation?.text ||
          `Payment of ${amount} rupees to ${merchantName} completed successfully. Transaction ID: ${data.transaction_id.substring(0, 8)}`;
        speakConfirmation(confirmText, amount, merchantName, data.transaction_id);
      } else {
        setError(data.error || 'Payment failed');
        setStep('error');
      }
    } catch {
      setError('Payment execution failed. Please try again.');
      setStep('error');
    }
    setLoading(false);
  };

  const handleCompletePayment = async () => {
    if (!walletId) {
      setError('Please complete biometric verification first.');
      return;
    }
    await executePayment(walletId);
  };

  const handleOTPSubmit = async () => {
    if (otp.length !== 6) {
      setError('Please enter a valid 6-digit OTP');
      return;
    }
    await executePayment(walletId);
  };

  const resetScan = () => {
    setStep('scan');
    setScanning(false);
    setFaceHash('');
    setFingerprintHash('');
    setConfidence(0);
    setDisplayedConfidence(0);
    setWalletId('');
    setBalance(0);
    setOtp('');
    setError('');
    setSuccess(false);
    setTransactionId('');
    setFaceVerified(false);
    setFingerprintVerified(false);
    setScanningFingerprint(false);
    setFingerprintScanning(false);
    setFingerprintProgress(0);
    if (fingerprintTimerRef.current) { clearInterval(fingerprintTimerRef.current); fingerprintTimerRef.current = null; }
    setRiskScore(null);
    setRiskReasoning('');
    setRecommendedTier('');
    setSpeaking(false);
    setShowDistressPin(false);
    setDistressPin('');
    setPaymentTimestamp('');
    if (typeof window !== 'undefined') window.speechSynthesis?.cancel();
  };

  const canCompletePayment = () => {
    if (!faceVerified) return false;
    if (requiresFingerprint && !fingerprintVerified) return false;
    if (requiresOTP && otp.length !== 6) return false;
    return true;
  };

  const getConfidenceColor = () => {
    if (displayedConfidence >= 90) return '#22c55e';
    if (displayedConfidence >= 70) return '#f59e0b';
    return '#ef4444';
  };

  const txnRef = 'TXN-' + Date.now().toString(36).toUpperCase();

  // ======================== RENDER ========================
  return (
    <>
      <style>{`
        .glass-card {
          background: rgba(255, 255, 255, 0.05);
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          border: 1px solid rgba(255, 255, 255, 0.1);
          box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.37);
        }
        .glass-banner {
          background: rgba(245, 158, 11, 0.1);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          border: 1px solid rgba(245, 158, 11, 0.2);
        }
        .glass-success-overlay {
          background: rgba(34, 197, 94, 0.08);
          backdrop-filter: blur(24px);
          -webkit-backdrop-filter: blur(24px);
          border: 1px solid rgba(34, 197, 94, 0.2);
        }
        .glass-error-overlay {
          background: rgba(239, 68, 68, 0.08);
          backdrop-filter: blur(24px);
          -webkit-backdrop-filter: blur(24px);
          border: 1px solid rgba(239, 68, 68, 0.2);
        }
        @keyframes pulse-ring {
          0% { box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.4); }
          70% { box-shadow: 0 0 0 12px rgba(99, 102, 241, 0); }
          100% { box-shadow: 0 0 0 0 rgba(99, 102, 241, 0); }
        }
        @keyframes fade-in-up {
          from { opacity: 0; transform: translateY(24px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes speaker-pulse {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.2); opacity: 0.7; }
        }
        @keyframes scan-line-move {
          0% { top: 0%; }
          50% { top: 88%; }
          100% { top: 0%; }
        }
        @keyframes glow-border {
          0%, 100% { box-shadow: 0 0 20px rgba(99, 102, 241, 0.2), inset 0 0 20px rgba(99, 102, 241, 0.05); }
          50% { box-shadow: 0 0 40px rgba(99, 102, 241, 0.4), inset 0 0 30px rgba(99, 102, 241, 0.08); }
        }
        @keyframes shimmer {
          0% { background-position: -200% center; }
          100% { background-position: 200% center; }
        }
        .animate-fade-in-up {
          animation: fade-in-up 0.6s ease-out forwards;
        }
        .animate-pulse-ring {
          animation: pulse-ring 2s ease-in-out infinite;
        }
        .animate-speaker {
          animation: speaker-pulse 0.8s ease-in-out infinite;
        }
        .animate-glow-border {
          animation: glow-border 3s ease-in-out infinite;
        }
        .scan-line-overlay::after {
          content: '';
          position: absolute;
          left: 5%;
          width: 90%;
          height: 2px;
          background: linear-gradient(90deg, transparent, #6366f1, #a855f7, transparent);
          box-shadow: 0 0 12px rgba(99, 102, 241, 0.6);
          animation: scan-line-move 2.5s ease-in-out infinite;
        }
        .shimmer-btn {
          background-size: 200% auto;
          animation: shimmer 3s linear infinite;
        }
        input[type="number"]::-webkit-inner-spin-button,
        input[type="number"]::-webkit-outer-spin-button {
          -webkit-appearance: none;
          margin: 0;
        }
        input[type="number"] {
          -moz-appearance: textfield;
        }
      `}</style>

      <div
        className="min-h-screen w-full flex flex-col items-center overflow-y-auto"
        style={{
          background: 'linear-gradient(135deg, #0A0E27 0%, #151336 30%, #1E0B3E 60%, #2D004F 100%)',
          fontFamily: "'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif",
        }}
      >
        {/* ================== SUCCESS OVERLAY ================== */}
        {step === 'success' && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            style={{ background: 'rgba(0, 0, 0, 0.85)' }}
          >
            <div className="glass-success-overlay rounded-3xl p-8 md:p-12 max-w-lg w-full animate-fade-in-up text-center">
              {/* Green circle check */}
              <div
                className="mx-auto w-24 h-24 rounded-full flex items-center justify-center mb-6"
                style={{ background: 'rgba(34, 197, 94, 0.15)', border: '2px solid rgba(34, 197, 94, 0.5)' }}
              >
                <svg className="w-12 h-12 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>

              <h2 className="text-3xl font-bold text-green-400 mb-2">Payment Successful</h2>
              <p className="text-5xl font-bold text-white mb-8">
                <span className="text-green-400">&#8377;</span>
                {parseFloat(amount).toLocaleString('en-IN')}
              </p>

              <div className="space-y-3 text-left glass-card rounded-2xl p-6 mb-8">
                <div className="flex justify-between items-center">
                  <span className="text-gray-400 text-sm">Transaction ID</span>
                  <span className="text-white text-sm font-mono">{transactionId.substring(0, 16)}...</span>
                </div>
                <div className="w-full h-px" style={{ background: 'rgba(255,255,255,0.06)' }} />
                <div className="flex justify-between items-center">
                  <span className="text-gray-400 text-sm">Merchant</span>
                  <span className="text-white text-sm">{merchantName}</span>
                </div>
                <div className="w-full h-px" style={{ background: 'rgba(255,255,255,0.06)' }} />
                <div className="flex justify-between items-center">
                  <span className="text-gray-400 text-sm">Auth Tier</span>
                  <span className="text-white text-sm">{tier}</span>
                </div>
                <div className="w-full h-px" style={{ background: 'rgba(255,255,255,0.06)' }} />
                <div className="flex justify-between items-center">
                  <span className="text-gray-400 text-sm">Remaining Balance</span>
                  <span className="text-white text-sm">&#8377;{(balance / 100).toFixed(2)}</span>
                </div>
                <div className="w-full h-px" style={{ background: 'rgba(255,255,255,0.06)' }} />
                <div className="flex justify-between items-center">
                  <span className="text-gray-400 text-sm">Timestamp</span>
                  <span className="text-white text-sm">{paymentTimestamp}</span>
                </div>
              </div>

              {/* Voice confirmation */}
              {speaking && (
                <div className="flex items-center justify-center gap-3 mb-6 text-green-400">
                  <div className="animate-speaker">
                    <svg className="w-7 h-7" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                    </svg>
                  </div>
                  <span className="text-sm font-medium">Speaking confirmation...</span>
                  {/* Sound wave bars */}
                  <div className="flex items-center gap-0.5">
                    {[1, 2, 3, 4, 5].map((i) => (
                      <div
                        key={i}
                        className="w-1 bg-green-400 rounded-full"
                        style={{
                          height: `${8 + Math.random() * 12}px`,
                          animation: `speaker-pulse ${0.4 + i * 0.1}s ease-in-out infinite`,
                          animationDelay: `${i * 0.08}s`,
                        }}
                      />
                    ))}
                  </div>
                </div>
              )}

              <button
                onClick={resetScan}
                className="w-full py-4 rounded-2xl font-bold text-lg text-white transition-all duration-300 hover:scale-[1.02] active:scale-[0.98]"
                style={{ background: 'linear-gradient(135deg, #22c55e, #16a34a)' }}
              >
                New Transaction
              </button>
            </div>
          </div>
        )}

        {/* ================== ERROR OVERLAY ================== */}
        {step === 'error' && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            style={{ background: 'rgba(0, 0, 0, 0.85)' }}
          >
            <div className="glass-error-overlay rounded-3xl p-8 md:p-12 max-w-lg w-full animate-fade-in-up text-center">
              <div
                className="mx-auto w-24 h-24 rounded-full flex items-center justify-center mb-6"
                style={{ background: 'rgba(239, 68, 68, 0.15)', border: '2px solid rgba(239, 68, 68, 0.5)' }}
              >
                <svg className="w-12 h-12 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </div>

              <h2 className="text-3xl font-bold text-red-400 mb-4">Payment Failed</h2>
              <p className="text-gray-300 mb-10 text-lg leading-relaxed">{error || 'An unexpected error occurred.'}</p>

              <button
                onClick={resetScan}
                className="w-full py-4 rounded-2xl font-bold text-lg text-white transition-all duration-300 hover:scale-[1.02] active:scale-[0.98]"
                style={{ background: 'linear-gradient(135deg, #ef4444, #dc2626)' }}
              >
                Try Again
              </button>
            </div>
          </div>
        )}

        {/* ================== MAIN CONTENT ================== */}
        <div className="w-full max-w-2xl mx-auto px-4 py-6 space-y-5">

          {/* ======== HEADER ======== */}
          <header className="glass-card rounded-2xl p-5 animate-fade-in-up">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              {/* Left: merchant info */}
              <div className="flex-1 min-w-0">
                <input
                  type="text"
                  value={merchantName}
                  onChange={(e) => setMerchantName(e.target.value)}
                  className="bg-transparent text-white text-2xl font-bold outline-none border-b-2 border-transparent hover:border-white/20 focus:border-indigo-400 transition-colors w-full pb-1 truncate"
                  placeholder="Merchant Name"
                />
                <div className="flex items-center gap-3 mt-2 flex-wrap">
                  <span className="text-gray-500 text-xs font-mono tracking-wide">ID: {storeId}</span>
                  <span className="text-gray-700 text-xs">|</span>
                  <span className="text-gray-500 text-xs font-mono tracking-wide">UPI: {merchantUpi}</span>
                </div>
              </div>

              {/* Right: clock + badge */}
              <div className="flex flex-col items-start md:items-end gap-2.5 flex-shrink-0">
                <div className="text-white font-mono text-xl tracking-widest tabular-nums">
                  {currentTime.toLocaleTimeString('en-IN', { hour12: true })}
                </div>
                <div
                  className="flex items-center gap-2 px-3.5 py-1.5 rounded-full"
                  style={{ background: 'rgba(99, 102, 241, 0.12)', border: '1px solid rgba(99, 102, 241, 0.25)' }}
                >
                  <span className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse flex-shrink-0" />
                  <span className="text-indigo-300 text-xs font-medium whitespace-nowrap">Powered by Amazon Nova</span>
                </div>
              </div>
            </div>
          </header>

          {/* ======== INLINE ERROR ======== */}
          {error && step !== 'error' && (
            <div
              className="rounded-xl p-4 animate-fade-in-up flex items-center gap-3"
              style={{ background: 'rgba(239, 68, 68, 0.12)', border: '1px solid rgba(239, 68, 68, 0.25)' }}
            >
              <svg className="w-5 h-5 text-red-400 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
              </svg>
              <span className="text-red-300 text-sm">{error}</span>
            </div>
          )}

          {/* ======== TRANSACTION CARD ======== */}
          {step !== 'success' && step !== 'error' && (
            <div className="glass-card rounded-2xl p-8 text-center animate-fade-in-up animate-glow-border">
              <p className="text-gray-400 text-xs tracking-[0.3em] uppercase mb-4 font-semibold">
                Total Amount
              </p>
              <div className="flex items-center justify-center gap-1 mb-3">
                <span className="text-gray-400 text-5xl font-extralight select-none">&#8377;</span>
                <input
                  type="number"
                  placeholder="0"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="bg-transparent text-white text-7xl font-bold outline-none text-center w-56 placeholder-white/10"
                  min="1"
                  step="1"
                  disabled={faceVerified}
                />
              </div>
              <p className="text-gray-600 text-xs font-mono mb-5">{txnRef}</p>

              {/* Tier badge */}
              {amount && (
                <div
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-xs font-bold tracking-wide"
                  style={{
                    background:
                      parseFloat(amount) < 200 ? 'rgba(34,197,94,0.12)'
                      : parseFloat(amount) < 1000 ? 'rgba(245,158,11,0.12)'
                      : 'rgba(239,68,68,0.12)',
                    color:
                      parseFloat(amount) < 200 ? '#4ade80'
                      : parseFloat(amount) < 1000 ? '#fbbf24'
                      : '#f87171',
                    border: `1px solid ${
                      parseFloat(amount) < 200 ? 'rgba(34,197,94,0.25)'
                      : parseFloat(amount) < 1000 ? 'rgba(245,158,11,0.25)'
                      : 'rgba(239,68,68,0.25)'
                    }`,
                  }}
                >
                  <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M2.166 4.999A11.954 11.954 0 0010 1.944 11.954 11.954 0 0017.834 5c.11.65.166 1.32.166 2.001 0 5.225-3.34 9.67-8 11.317C5.34 16.67 2 12.225 2 7c0-.682.057-1.35.166-2.001zm11.541 3.708a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                  </svg>
                  {tier}
                </div>
              )}

              {/* Merchant UPI */}
              <div className="mt-6 pt-5" style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                <label className="text-gray-500 text-xs block mb-1.5 tracking-wide uppercase">Merchant UPI</label>
                <input
                  type="text"
                  value={merchantUpi}
                  onChange={(e) => setMerchantUpi(e.target.value)}
                  className="bg-transparent text-gray-300 text-sm outline-none text-center border-b border-transparent hover:border-white/10 focus:border-indigo-400 transition-colors w-full max-w-xs mx-auto"
                  disabled={faceVerified}
                />
              </div>
            </div>
          )}

          {/* ======== NOVA AI RISK AGENT BANNER ======== */}
          {riskScore !== null && step !== 'success' && step !== 'error' && (
            <div className="glass-banner rounded-2xl p-5 animate-fade-in-up">
              <div className="flex items-start gap-4">
                {/* Brain / AI icon */}
                <div
                  className="flex-shrink-0 w-11 h-11 rounded-xl flex items-center justify-center"
                  style={{ background: 'rgba(245, 158, 11, 0.2)' }}
                >
                  <svg className="w-6 h-6 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 mb-2 flex-wrap">
                    <h3 className="text-amber-400 text-sm font-bold tracking-widest uppercase">
                      Nova AI Risk Agent
                    </h3>
                    <span
                      className="text-xs font-mono px-2 py-0.5 rounded"
                      style={{ background: 'rgba(245,158,11,0.15)', color: '#fbbf24' }}
                    >
                      Score: {riskScore}/100
                    </span>
                  </div>
                  <p className="text-amber-200/70 text-sm leading-relaxed">
                    {riskReasoning ||
                      `Risk assessment complete. Identity confidence: ${displayedConfidence}%. Recommended authentication tier: ${recommendedTier || tier}. Transaction within normal parameters.`}
                  </p>
                  {recommendedTier && (
                    <div
                      className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1 rounded-full"
                      style={{ background: 'rgba(245,158,11,0.12)', color: '#fbbf24', border: '1px solid rgba(245,158,11,0.2)' }}
                    >
                      <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                        <path d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" />
                      </svg>
                      Recommended: {recommendedTier}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ======== BIOMETRIC STATUS CARDS ======== */}
          {step !== 'success' && step !== 'error' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

              {/* ---- Face Scan Card ---- */}
              <div className="glass-card rounded-2xl p-5 animate-fade-in-up" style={{ animationDelay: '0.1s' }}>
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2.5">
                    <div
                      className="w-8 h-8 rounded-lg flex items-center justify-center"
                      style={{ background: 'rgba(99, 102, 241, 0.15)' }}
                    >
                      <svg className="w-4 h-4 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
                      </svg>
                    </div>
                    <h3 className="text-white text-sm font-semibold">Face Scan</h3>
                  </div>
                  {faceVerified && (
                    <div className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: 'rgba(34,197,94,0.15)' }}>
                      <svg className="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    </div>
                  )}
                </div>

                {/* Scanning state */}
                {scanning ? (
                  <div className="relative rounded-xl overflow-hidden animate-pulse-ring">
                    <video
                      ref={videoRef}
                      autoPlay
                      playsInline
                      muted
                      className="w-full rounded-xl"
                      style={{ border: '2px solid rgba(99, 102, 241, 0.5)' }}
                    />
                    <div className="absolute inset-0 scan-line-overlay rounded-xl" />
                    {challenge && (
                      <div
                        className="absolute bottom-3 left-3 right-3 text-center py-2 px-3 rounded-lg text-xs font-medium text-indigo-200"
                        style={{ background: 'rgba(99, 102, 241, 0.4)', backdropFilter: 'blur(8px)' }}
                      >
                        {challenge}
                      </div>
                    )}
                  </div>
                ) : faceVerified ? (
                  /* Verified state */
                  <div className="flex flex-col items-center justify-center py-5">
                    <div
                      className="w-16 h-16 rounded-full flex items-center justify-center mb-3"
                      style={{ background: 'rgba(34, 197, 94, 0.1)', border: '2px solid rgba(34, 197, 94, 0.35)' }}
                    >
                      <svg className="w-8 h-8 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    </div>
                    <span className="text-green-400 text-sm font-semibold mb-2">Verified</span>
                    {displayedConfidence > 0 && (
                      <div className="text-center">
                        <span className="text-4xl font-bold tabular-nums" style={{ color: getConfidenceColor() }}>
                          {displayedConfidence}%
                        </span>
                        <p className="text-gray-500 text-xs mt-1">Confidence Score</p>
                      </div>
                    )}
                  </div>
                ) : (
                  /* Idle state */
                  <div className="flex flex-col items-center justify-center py-7">
                    <div
                      className="w-16 h-16 rounded-full flex items-center justify-center mb-3"
                      style={{ background: 'rgba(99, 102, 241, 0.08)', border: '2px dashed rgba(99, 102, 241, 0.25)' }}
                    >
                      <svg className="w-7 h-7 text-indigo-400/40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0z" />
                      </svg>
                    </div>
                    <span className="text-gray-500 text-xs">Ready to scan</span>
                  </div>
                )}

                {/* Scan button */}
                {!faceVerified && !scanning && (
                  <button
                    onClick={handleScanCustomer}
                    disabled={loading || !amount}
                    className="w-full mt-3 py-3 rounded-xl text-sm font-bold text-white transition-all duration-300 disabled:opacity-25 disabled:cursor-not-allowed hover:scale-[1.02] active:scale-[0.98]"
                    style={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)' }}
                  >
                    {loading && scanning ? (
                      <span className="flex items-center justify-center gap-2">
                        <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                        </svg>
                        Scanning...
                      </span>
                    ) : (
                      'Start Face Scan'
                    )}
                  </button>
                )}
              </div>

              {/* ---- Fingerprint Card ---- */}
              <div className="glass-card rounded-2xl p-5 animate-fade-in-up" style={{ animationDelay: '0.2s' }}>
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2.5">
                    <div
                      className="w-8 h-8 rounded-lg flex items-center justify-center"
                      style={{ background: requiresFingerprint ? 'rgba(245, 158, 11, 0.15)' : 'rgba(107,114,128,0.1)' }}
                    >
                      <svg
                        className={`w-4 h-4 ${requiresFingerprint ? 'text-amber-400' : 'text-gray-600'}`}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={1.5}
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M7.864 4.243A7.5 7.5 0 0119.5 10.5c0 2.92-.556 5.709-1.568 8.268M5.742 6.364A7.465 7.465 0 004.5 10.5a48.667 48.667 0 00-1.573 8.13M12 10.5a3 3 0 11-6 0 3 3 0 016 0zm-3 3a7.5 7.5 0 017.5 7.5" />
                      </svg>
                    </div>
                    <h3 className="text-white text-sm font-semibold">Fingerprint</h3>
                  </div>
                  {fingerprintVerified && (
                    <div className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: 'rgba(34,197,94,0.15)' }}>
                      <svg className="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    </div>
                  )}
                </div>

                {/* Scanning fingerprint — touch-based pad */}
                {(scanningFingerprint || step === 'fingerprint') ? (
                  <div className="flex flex-col items-center">
                    {/* Fingerprint touch pad */}
                    <button
                      onClick={handleFingerprintTouch}
                      disabled={fingerprintScanning || loading}
                      className="relative w-28 h-28 rounded-full flex items-center justify-center mb-4 transition-all duration-300 cursor-pointer active:scale-95 disabled:cursor-wait"
                      style={{
                        background: fingerprintScanning
                          ? `conic-gradient(rgba(245,158,11,0.6) ${fingerprintProgress * 3.6}deg, rgba(245,158,11,0.08) ${fingerprintProgress * 3.6}deg)`
                          : 'rgba(245, 158, 11, 0.08)',
                        border: `3px solid ${fingerprintScanning ? 'rgba(245,158,11,0.7)' : 'rgba(245,158,11,0.25)'}`,
                        boxShadow: fingerprintScanning ? '0 0 30px rgba(245,158,11,0.3)' : 'none',
                      }}
                    >
                      {/* Inner fingerprint icon */}
                      <div
                        className="w-20 h-20 rounded-full flex items-center justify-center"
                        style={{ background: 'rgba(10,14,39,0.8)' }}
                      >
                        {fingerprintScanning ? (
                          <span className="text-amber-400 text-lg font-bold tabular-nums">{fingerprintProgress}%</span>
                        ) : (
                          <svg className="w-10 h-10 text-amber-400/60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M7.864 4.243A7.5 7.5 0 0119.5 10.5c0 2.92-.556 5.709-1.568 8.268M5.742 6.364A7.465 7.465 0 004.5 10.5a48.667 48.667 0 00-1.573 8.13M12 10.5a3 3 0 11-6 0 3 3 0 016 0zm-3 3a7.5 7.5 0 017.5 7.5" />
                          </svg>
                        )}
                      </div>
                    </button>
                    <span className="text-amber-300/70 text-xs font-medium mb-1">
                      {fingerprintScanning ? 'Scanning fingerprint...' : loading ? 'Verifying...' : 'Tap to scan fingerprint'}
                    </span>
                    <span className="text-gray-600 text-[10px]">Place INDEX finger on sensor</span>
                  </div>
                ) : fingerprintVerified ? (
                  /* Verified */
                  <div className="flex flex-col items-center justify-center py-5">
                    <div
                      className="w-16 h-16 rounded-full flex items-center justify-center mb-3"
                      style={{ background: 'rgba(34, 197, 94, 0.1)', border: '2px solid rgba(34, 197, 94, 0.35)' }}
                    >
                      <svg className="w-8 h-8 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    </div>
                    <span className="text-green-400 text-sm font-semibold">Verified</span>
                  </div>
                ) : (
                  /* Idle */
                  <div className="flex flex-col items-center justify-center py-7">
                    <div
                      className="w-16 h-16 rounded-full flex items-center justify-center mb-3"
                      style={{
                        background: requiresFingerprint ? 'rgba(245, 158, 11, 0.06)' : 'rgba(107,114,128,0.06)',
                        border: `2px dashed ${requiresFingerprint ? 'rgba(245, 158, 11, 0.2)' : 'rgba(107,114,128,0.15)'}`,
                      }}
                    >
                      <svg
                        className={`w-7 h-7 ${requiresFingerprint ? 'text-amber-400/30' : 'text-gray-700'}`}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={1.5}
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M7.864 4.243A7.5 7.5 0 0119.5 10.5c0 2.92-.556 5.709-1.568 8.268M5.742 6.364A7.465 7.465 0 004.5 10.5a48.667 48.667 0 00-1.573 8.13M12 10.5a3 3 0 11-6 0 3 3 0 016 0zm-3 3a7.5 7.5 0 017.5 7.5" />
                      </svg>
                    </div>
                    <span className="text-gray-600 text-xs">
                      {requiresFingerprint
                        ? faceVerified
                          ? 'Ready to scan'
                          : 'Waiting for face scan...'
                        : 'Not required'}
                    </span>

                    {requiresFingerprint && faceVerified && (
                      <button
                        onClick={handleStartFingerprintScan}
                        className="mt-4 w-full py-3 rounded-xl text-sm font-bold text-white transition-all duration-300 hover:scale-[1.02] active:scale-[0.98]"
                        style={{ background: 'linear-gradient(135deg, #f59e0b, #d97706)' }}
                      >
                        Start Fingerprint Scan
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ======== DISTRESS PIN ======== */}
          {step !== 'success' && step !== 'error' && (
            <div className="text-center">
              <button
                onClick={() => setShowDistressPin(!showDistressPin)}
                className="text-gray-700 text-xs hover:text-gray-400 transition-colors duration-300"
              >
                Distress PIN Access
              </button>
              {showDistressPin && (
                <div className="mt-3 glass-card rounded-xl p-4 max-w-xs mx-auto animate-fade-in-up">
                  <input
                    type="password"
                    placeholder="Enter Distress PIN"
                    value={distressPin}
                    onChange={(e) => setDistressPin(e.target.value)}
                    className="w-full bg-transparent text-white text-center text-sm outline-none border-b border-white/10 focus:border-red-400 transition-colors pb-2 placeholder-gray-600"
                    maxLength={6}
                  />
                </div>
              )}
            </div>
          )}

          {/* ======== OTP SECTION ======== */}
          {step === 'otp' && (
            <div className="glass-card rounded-2xl p-6 animate-fade-in-up">
              <div className="text-center mb-5">
                <div
                  className="mx-auto w-12 h-12 rounded-xl flex items-center justify-center mb-3"
                  style={{ background: 'rgba(239, 68, 68, 0.12)' }}
                >
                  <svg className="w-6 h-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                  </svg>
                </div>
                <h3 className="text-white font-bold text-lg">OTP Verification</h3>
                <p className="text-gray-400 text-xs mt-1">High-value transaction requires OTP confirmation</p>
              </div>
              <input
                type="text"
                placeholder="- - - - - -"
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').substring(0, 6))}
                className="w-full bg-transparent text-white text-4xl text-center outline-none tracking-[0.6em] font-mono border-b-2 border-white/10 focus:border-indigo-400 transition-colors pb-3 placeholder-white/10 mb-5"
                maxLength={6}
              />
              <button
                onClick={handleOTPSubmit}
                disabled={loading || otp.length !== 6}
                className="w-full py-3.5 rounded-xl text-sm font-bold text-white transition-all duration-300 disabled:opacity-25 disabled:cursor-not-allowed hover:scale-[1.02] active:scale-[0.98]"
                style={{ background: 'linear-gradient(135deg, #ef4444, #dc2626)' }}
              >
                {loading ? (
                  <span className="flex items-center justify-center gap-2">
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Verifying...
                  </span>
                ) : (
                  'Verify & Pay'
                )}
              </button>
            </div>
          )}

          {/* ======== COMPLETE PAYMENT BUTTON ======== */}
          {step !== 'success' && step !== 'error' && step !== 'otp' && (
            <button
              onClick={handleCompletePayment}
              disabled={!canCompletePayment() || loading}
              className="w-full py-5 rounded-2xl text-lg font-bold text-white transition-all duration-300 disabled:opacity-15 disabled:cursor-not-allowed hover:scale-[1.02] active:scale-[0.98] animate-fade-in-up"
              style={{
                background: canCompletePayment()
                  ? 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #a855f7 100%)'
                  : 'linear-gradient(135deg, #1f2937, #374151)',
                boxShadow: canCompletePayment()
                  ? '0 4px 30px rgba(99, 102, 241, 0.35)'
                  : 'none',
              }}
            >
              {loading ? (
                <span className="flex items-center justify-center gap-3">
                  <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Processing Payment...
                </span>
              ) : (
                <span className="flex items-center justify-center gap-3">
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
                  </svg>
                  COMPLETE PAYMENT
                </span>
              )}
            </button>
          )}

          {/* ======== FOOTER ======== */}
          <div className="text-center pt-2 pb-6">
            <p className="text-gray-700 text-xs tracking-wide">
              PulsePay Merchant Terminal v2.0 &middot; Biometric-secured payments
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
