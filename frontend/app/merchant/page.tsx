'use client';

import { useState, useRef, useEffect } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000';
const CV_SERVICE_URL = process.env.NEXT_PUBLIC_CV_SERVICE_URL || 'http://localhost:8000';

export default function MerchantPage() {
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
  const [step, setStep] = useState('scan'); // scan, fingerprint, otp, success, error
  const [displayedConfidence, setDisplayedConfidence] = useState(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const challenges = [
    'Please blink twice',
    'Turn your head slightly left',
    'Hold up 2 fingers'
  ];

  // Calculate tier based on amount
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

  useEffect(() => {
    if (scanning || step === 'fingerprint') {
      startCamera();
    } else {
      stopCamera();
    }
    return () => stopCamera();
  }, [scanning, step]);

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 }
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
    } catch (err) {
      setError('Camera access denied. Please enable camera permissions.');
    }
  };

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
  };

  const animateConfidence = (targetScore: number) => {
    setDisplayedConfidence(0);
    const duration = 2000; // 2 seconds
    const steps = 60; // 60 frames for smooth animation
    const increment = targetScore / steps;
    const intervalTime = duration / steps;

    let currentStep = 0;
    const interval = setInterval(() => {
      currentStep++;
      if (currentStep >= steps) {
        setDisplayedConfidence(targetScore);
        clearInterval(interval);
      } else {
        setDisplayedConfidence(Math.floor(currentStep * increment));
      }
    }, intervalTime);
  };

  const handleScanCustomer = async () => {
    if (!amount || parseFloat(amount) <= 0) {
      setError('Please enter a valid amount');
      return;
    }

    // Pick a new random challenge on every scan attempt
    setChallenge(challenges[Math.floor(Math.random() * challenges.length)]);

    setLoading(true);
    setError('');
    setScanning(true);

    try {
      // Capture face
      const canvas = document.createElement('canvas');
      canvas.width = videoRef.current!.videoWidth;
      canvas.height = videoRef.current!.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx?.drawImage(videoRef.current!, 0, 0);

      const blob = await new Promise<Blob>((resolve) => {
        canvas.toBlob((b) => resolve(b!), 'image/jpeg');
      });

      const formData = new FormData();
      formData.append('image', blob, 'face.jpg');

      // Hash face
      const hashResponse = await fetch(`${CV_SERVICE_URL}/hash-face`, {
        method: 'POST',
        body: formData
      });

      const hashData = await hashResponse.json();

      if (hashData.error) {
        setError(hashData.error);
        setScanning(false);
        setLoading(false);
        return;
      }

      setFaceHash(hashData.hash);
      setConfidence(hashData.confidence || 85);
      animateConfidence(hashData.confidence || 85);

      // Authenticate
      const authResponse = await fetch(`${API_URL}/api/payment/authenticate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          face_hash: hashData.hash,
          amount: parseFloat(amount),
          fingerprint_hash: null
        })
      });

      const authData = await authResponse.json();

      if (!authData.authenticated) {
        setError(authData.error || 'Authentication failed');
        setScanning(false);
        setLoading(false);
        return;
      }

      setWalletId(authData.wallet_id);
      setBalance(authData.balance);
      setConfidence(authData.confidence_score);

      // Check if needs fingerprint
      if (requiresFingerprint) {
        setStep('fingerprint');
        setScanning(false);
      } else if (requiresOTP) {
        setStep('otp');
        setScanning(false);
        stopCamera();
      } else {
        // Execute payment
        await executePayment(authData.wallet_id);
      }
    } catch (err) {
      setError('Scan failed. Please try again.');
      setScanning(false);
    }
    setLoading(false);
  };

  const handleCaptureFingerprint = async () => {
    setLoading(true);
    setError('');

    try {
      const canvas = document.createElement('canvas');
      canvas.width = videoRef.current!.videoWidth;
      canvas.height = videoRef.current!.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx?.drawImage(videoRef.current!, 0, 0);

      const blob = await new Promise<Blob>((resolve) => {
        canvas.toBlob((b) => resolve(b!), 'image/jpeg');
      });

      const formData = new FormData();
      formData.append('image', blob, 'finger.jpg');

      const response = await fetch(`${CV_SERVICE_URL}/hash-fingerprint`, {
        method: 'POST',
        body: formData
      });

      const data = await response.json();

      if (data.error) {
        setError(data.error);
        setLoading(false);
        return;
      }

      setFingerprintHash(data.hash);

      // Re-authenticate with fingerprint
      const authResponse = await fetch(`${API_URL}/api/payment/authenticate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          face_hash: faceHash,
          fingerprint_hash: data.hash,
          amount: parseFloat(amount)
        })
      });

      const authData = await authResponse.json();

      if (!authData.authenticated) {
        setError(authData.error || 'Fingerprint verification failed');
        setLoading(false);
        return;
      }

      if (requiresOTP) {
        setStep('otp');
        stopCamera();
      } else {
        await executePayment(authData.wallet_id);
      }
    } catch (err) {
      setError('Fingerprint capture failed. Please try again.');
    }
    setLoading(false);
  };

  const executePayment = async (wallet_id: string) => {
    setLoading(true);
    setError('');

    try {
      // Get GPS coordinates (mock)
      const gps_lat = 28.7041;
      const gps_lng = 77.1025;

      const response = await fetch(`${API_URL}/api/payment/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet_id,
          amount: parseFloat(amount),
          merchant_upi: merchantUpi,
          gps_lat,
          gps_lng
        })
      });

      const data = await response.json();

      if (data.transaction_id) {
        setTransactionId(data.transaction_id);
        setBalance(data.remaining_balance);
        setStep('success');
        setSuccess(true);
      } else {
        setError(data.error || 'Payment failed');
        setStep('error');
      }
    } catch (err) {
      setError('Payment execution failed. Please try again.');
      setStep('error');
    }
    setLoading(false);
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
  };

  const getTierColor = () => {
    const amountNum = parseFloat(amount) || 0;
    if (amountNum < 200) return 'text-green-600 bg-green-100';
    if (amountNum < 1000) return 'text-amber-600 bg-amber-100';
    return 'text-red-600 bg-red-100';
  };

  const getConfidenceColor = () => {
    const score = displayedConfidence;
    if (score >= 90) return 'text-green-600';
    if (score >= 70) return 'text-amber-600';
    return 'text-red-600';
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-900 via-teal-900 to-blue-900 flex items-center justify-center p-4">
      <div className="max-w-3xl w-full bg-white rounded-3xl shadow-2xl p-8">
        {/* Header */}
        <div className="text-center mb-6">
          <h1 className="text-3xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-green-600 to-teal-600">
            PulsePay Merchant
          </h1>
          <div className="mt-2 inline-block px-4 py-2 bg-green-100 text-green-700 rounded-full font-semibold">
            Ready to Scan
          </div>
        </div>

        {error && (
          <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
            {error}
          </div>
        )}

        {/* Success Screen */}
        {step === 'success' && (
          <div className="space-y-6 text-center">
            <div className="text-6xl">✅</div>
            <h2 className="text-3xl font-bold text-green-600">Payment Successful!</h2>
            <div className="space-y-2 text-gray-700">
              <p className="text-4xl font-bold">₹{amount}</p>
              <p><strong>Transaction ID:</strong> {transactionId.substring(0, 16)}...</p>
              <p><strong>Merchant:</strong> {merchantUpi}</p>
              <p><strong>Remaining Balance:</strong> ₹{(balance / 100).toFixed(2)}</p>
              <p><strong>Auth Tier:</strong> {tier}</p>
              <p className="text-sm text-gray-500">{new Date().toLocaleString()}</p>
            </div>
            <button
              onClick={resetScan}
              className="w-full bg-green-600 text-white py-3 rounded-lg font-semibold hover:bg-green-700 transition"
            >
              New Transaction
            </button>
          </div>
        )}

        {/* Error Screen */}
        {step === 'error' && (
          <div className="space-y-6 text-center">
            <div className="text-6xl">❌</div>
            <h2 className="text-3xl font-bold text-red-600">Payment Failed</h2>
            <p className="text-gray-700">{error}</p>
            <button
              onClick={resetScan}
              className="w-full bg-red-600 text-white py-3 rounded-lg font-semibold hover:bg-red-700 transition"
            >
              Try Again
            </button>
          </div>
        )}

        {/* Scan Screen */}
        {step === 'scan' && !success && (
          <div className="space-y-6">
            {/* Amount Input */}
            <div>
              <label className="block text-gray-700 mb-2 font-medium">Amount (₹)</label>
              <input
                type="number"
                placeholder="Enter amount in rupees"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent text-gray-900 text-xl"
                min="1"
                step="1"
              />
            </div>

            {/* Tier Badge */}
            {amount && (
              <div className={`text-center py-2 px-4 rounded-lg font-semibold ${getTierColor()}`}>
                {tier}
              </div>
            )}

            {/* Camera Preview */}
            {scanning && (
              <>
                <div className="bg-purple-100 text-purple-800 px-4 py-2 rounded-lg text-center">
                  {challenge}
                </div>
                <div className="relative rounded-lg overflow-hidden border-4 border-green-500">
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    className="w-full rounded-lg"
                  />
                  <div className="absolute inset-0 border-4 border-green-400 rounded-lg animate-pulse"></div>
                </div>
              </>
            )}

            {/* Confidence Score */}
            {confidence > 0 && (
              <div className="text-center">
                <div className={`text-6xl font-bold ${getConfidenceColor()}`}>{displayedConfidence}</div>
                <div className="text-gray-600">Identity Confidence Score</div>
              </div>
            )}

            {/* Scan Button */}
            {!scanning ? (
              <button
                onClick={handleScanCustomer}
                disabled={loading || !amount}
                className="w-full bg-green-600 text-white py-4 rounded-lg font-semibold text-xl hover:bg-green-700 disabled:bg-gray-400 transition flex items-center justify-center gap-2"
              >
                {loading ? (
                  <>
                    <svg className="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Processing...
                  </>
                ) : 'Scan Customer'}
              </button>
            ) : null}

            {/* Merchant UPI */}
            <div>
              <label className="block text-gray-700 mb-2 font-medium text-sm">Merchant UPI ID</label>
              <input
                type="text"
                value={merchantUpi}
                onChange={(e) => setMerchantUpi(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent text-gray-900"
              />
            </div>
          </div>
        )}

        {/* Fingerprint Screen */}
        {step === 'fingerprint' && (
          <div className="space-y-6">
            <h2 className="text-2xl font-semibold text-gray-800 text-center">Fingerprint Verification Required</h2>
            <p className="text-gray-600 text-center">Place your INDEX finger close to the camera</p>
            <div className="relative rounded-lg overflow-hidden border-4 border-amber-500">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                className="w-full rounded-lg"
              />
            </div>
            <button
              onClick={handleCaptureFingerprint}
              disabled={loading}
              className="w-full bg-amber-600 text-white py-3 rounded-lg font-semibold hover:bg-amber-700 disabled:bg-gray-400 transition flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <svg className="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  Processing...
                </>
              ) : 'Capture Fingerprint'}
            </button>
          </div>
        )}

        {/* OTP Screen */}
        {step === 'otp' && (
          <div className="space-y-6">
            <h2 className="text-2xl font-semibold text-gray-800 text-center">OTP Verification Required</h2>
            <p className="text-gray-600 text-center">High-value transaction requires OTP confirmation</p>
            <input
              type="text"
              placeholder="Enter 6-digit OTP"
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').substring(0, 6))}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent text-gray-900 text-center text-2xl tracking-widest"
              maxLength={6}
            />
            <button
              onClick={handleOTPSubmit}
              disabled={loading || otp.length !== 6}
              className="w-full bg-red-600 text-white py-3 rounded-lg font-semibold hover:bg-red-700 disabled:bg-gray-400 transition flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <svg className="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  Processing...
                </>
              ) : 'Verify & Pay'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
