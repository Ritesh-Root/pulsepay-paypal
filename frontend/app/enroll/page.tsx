'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { saveSession } from '../../lib/session';
import { api, API_URL, CV_SERVICE_URL } from '../../lib/api';

export default function EnrollPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [faceHash, setFaceHash] = useState('');
  const [indexHash, setIndexHash] = useState('');
  const [distressHash, setDistressHash] = useState('');
  const [amount, setAmount] = useState(1000);
  const [salt, setSalt] = useState('');
  const [walletId, setWalletId] = useState('');
  const [expiry, setExpiry] = useState('');
  const [fundingMethod, setFundingMethod] = useState<'upi' | 'crypto' | ''>('');
  const [upiId, setUpiId] = useState('');
  const [cryptoWallet, setCryptoWallet] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [challenge, setChallenge] = useState('');
  const [confidence, setConfidence] = useState(0);
  const [captureStatus, setCaptureStatus] = useState('');

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const isMountedRef = useRef(true);

  const challenges = [
    'Please blink twice',
    'Turn your head slightly left',
    'Hold up 2 fingers'
  ];

  useEffect(() => {
    if (step === 2 || step === 3) {
      startCamera();
    } else {
      stopCamera();
    }
    // Set initial challenge when entering step 2
    if (step === 2) {
      setChallenge(challenges[Math.floor(Math.random() * challenges.length)]);
    }
    return () => {
      isMountedRef.current = false;
      stopCamera();
    };
  }, [step]);

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

  const handleSendOTP = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`${API_URL}/api/enroll/verify-aadhaar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone })
      });
      const data = await response.json();
      if (data.success) {
        setOtpSent(true);
        // Auto-fill mock OTP for demo
        if (data.mock_otp) {
          setOtp(data.mock_otp);
        }
      } else {
        setError(data.error || 'Failed to send OTP');
      }
    } catch (err) {
      setError('Network error. Please try again.');
    }
    setLoading(false);
  };

  const handleVerifyOTP = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`${API_URL}/api/enroll/verify-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, otp })
      });
      const data = await response.json();
      if (data.verified) {
        setTimeout(() => setStep(2), 500);
      } else {
        setError(data.error || 'Invalid OTP');
      }
    } catch (err) {
      setError('Network error. Please try again.');
    }
    setLoading(false);
  };

  const captureFrame = () => {
    if (!videoRef.current) return null;
    const canvas = document.createElement('canvas');
    canvas.width = videoRef.current.videoWidth;
    canvas.height = videoRef.current.videoHeight;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(videoRef.current, 0, 0);
      return canvas.toBlob((blob) => blob, 'image/jpeg');
    }
    return null;
  };

  const handleCaptureFace = async () => {
    // Pick a new random challenge on every scan attempt
    setChallenge(challenges[Math.floor(Math.random() * challenges.length)]);

    setLoading(true);
    setError('');
    setCaptureStatus('Capturing...');

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
      formData.append('image', blob, 'face.jpg');

      // Call both hash-face and liveness-check
      const [hashResponse, livenessResponse] = await Promise.all([
        fetch(`${CV_SERVICE_URL}/hash-face`, {
          method: 'POST',
          body: formData
        }),
        fetch(`${CV_SERVICE_URL}/liveness-check`, {
          method: 'POST',
          body: (() => {
            const fd = new FormData();
            fd.append('image', blob, 'face.jpg');
            fd.append('challenge_type', challenge);
            return fd;
          })()
        })
      ]);

      const hashData = await hashResponse.json();
      const livenessData = await livenessResponse.json();

      if (hashData.error || livenessData.error) {
        setError(hashData.error || livenessData.error);
        setCaptureStatus('');
        setLoading(false);
        return;
      }

      const conf = hashData.confidence || livenessData.confidence || 85;
      setConfidence(conf);

      if (livenessData.liveness_passed && conf > 70) {
        const hash = hashData.hash;
        setFaceHash(hash);
        // Generate random salt
        const randomSalt = Array.from(crypto.getRandomValues(new Uint8Array(32)))
          .map(b => b.toString(16).padStart(2, '0'))
          .join('');
        setSalt(randomSalt);
        setCaptureStatus(`✓ Face Captured: ${hash.substring(0, 12)}...`);
        setTimeout(() => setStep(3), 1500);
      } else {
        setError('Liveness check failed. Please try again.');
        setCaptureStatus('');
      }
    } catch (err) {
      setError('Failed to capture face. Please try again.');
      setCaptureStatus('');
    }
    setLoading(false);
  };

  const handleCaptureFingerprint = async (isDistress: boolean) => {
    setLoading(true);
    setError('');
    setCaptureStatus(isDistress ? 'Capturing pinky...' : 'Capturing index...');

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
        setCaptureStatus('');
        setLoading(false);
        return;
      }

      if (isDistress) {
        setDistressHash(data.hash);
        setCaptureStatus('✓ Both fingerprints enrolled! Index = payment, Pinky = SOS');
        setTimeout(() => setStep(4), 1500);
      } else {
        setIndexHash(data.hash);
        setCaptureStatus('✓ Index finger captured');
      }
    } catch (err) {
      setError('Failed to capture fingerprint. Please try again.');
      setCaptureStatus('');
    }
    setLoading(false);
  };

  const handleCreateWallet = async () => {
    setLoading(true);
    setError('');

    try {
      const response = await fetch(`${API_URL}/api/enroll/create-wallet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet_id_hash: faceHash,
          fingerprint_hash: indexHash,
          distress_hash: distressHash,
          salt,
          amount,
          phone,
          funding_method: fundingMethod,
          funding_address: fundingMethod === 'upi' ? upiId : cryptoWallet
        })
      });

      const data = await response.json();

      if (data.wallet_id) {
        setWalletId(data.wallet_id);
        // Save session for persistence
        if (data.token) {
          saveSession({
            walletId: data.wallet_id,
            token: data.token,
            phone,
            expiry: data.expiry
          });
        }
        setExpiry(new Date(data.expiry).toLocaleString());
        setStep(5);
      } else {
        setError(data.error || 'Failed to create wallet');
      }
    } catch (err) {
      setError('Network error. Please try again.');
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-900 via-purple-900 to-indigo-900 flex items-center justify-center p-4">
      <div className="max-w-2xl w-full bg-white rounded-3xl shadow-2xl p-8">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-blue-600 to-purple-600">
            PulsePay
          </h1>
          <p className="text-gray-600 mt-2">Your body is your wallet</p>
          <div className="flex justify-center gap-2 mt-4">
            {[1, 2, 3, 4].map((s) => (
              <div
                key={s}
                className={`h-2 w-12 rounded-full ${
                  step >= s ? 'bg-blue-600' : 'bg-gray-300'
                }`}
              />
            ))}
          </div>
        </div>

        {error && (
          <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
            {error}
          </div>
        )}

        {/* Step 1: Aadhaar Verification */}
        {step === 1 && (
          <div className="space-y-6">
            <h2 className="text-2xl font-semibold text-gray-800">Aadhaar Verification</h2>
            <input
              type="tel"
              placeholder="Enter phone number"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-gray-900"
              maxLength={10}
            />
            {!otpSent ? (
              <button
                onClick={handleSendOTP}
                disabled={loading || phone.length < 10}
                className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold hover:bg-blue-700 disabled:bg-gray-400 transition"
              >
                {loading ? 'Sending...' : 'Send OTP'}
              </button>
            ) : (
              <>
                <div className="text-green-600 font-medium">✓ OTP sent successfully</div>
                <input
                  type="text"
                  placeholder="Enter 6-digit OTP"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value)}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-gray-900"
                  maxLength={6}
                />
                <button
                  onClick={handleVerifyOTP}
                  disabled={loading || otp.length !== 6}
                  className="w-full bg-green-600 text-white py-3 rounded-lg font-semibold hover:bg-green-700 disabled:bg-gray-400 transition"
                >
                  {loading ? 'Verifying...' : 'Verify OTP'}
                </button>
              </>
            )}
          </div>
        )}

        {/* Step 2: Face Scan */}
        {step === 2 && (
          <div className="space-y-6">
            <h2 className="text-2xl font-semibold text-gray-800">Face Scan with Liveness</h2>
            <div className="bg-purple-100 text-purple-800 px-4 py-3 rounded-lg font-medium text-center">
              {challenge}
            </div>
            <div className="relative rounded-lg overflow-hidden">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                className="w-full rounded-lg"
              />
            </div>
            {captureStatus && (
              <div className="text-green-600 font-medium text-center">{captureStatus}</div>
            )}
            {confidence > 0 && (
              <div className="text-center">
                <div className="text-3xl font-bold text-blue-600">{confidence}%</div>
                <div className="text-gray-600">Confidence Score</div>
              </div>
            )}
            <button
              onClick={handleCaptureFace}
              disabled={loading}
              className="w-full bg-purple-600 text-white py-3 rounded-lg font-semibold hover:bg-purple-700 disabled:bg-gray-400 transition"
            >
              {loading ? 'Processing...' : 'Capture Face'}
            </button>
          </div>
        )}

        {/* Step 3: Fingerprint Scan */}
        {step === 3 && (
          <div className="space-y-6">
            <h2 className="text-2xl font-semibold text-gray-800">Fingerprint Scan</h2>
            {!indexHash ? (
              <>
                <p className="text-gray-600">Place your INDEX finger close to the camera lens</p>
                <div className="relative rounded-lg overflow-hidden">
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    className="w-full rounded-lg"
                  />
                </div>
                {captureStatus && (
                  <div className="text-green-600 font-medium text-center">{captureStatus}</div>
                )}
                <button
                  onClick={() => handleCaptureFingerprint(false)}
                  disabled={loading}
                  className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold hover:bg-blue-700 disabled:bg-gray-400 transition"
                >
                  {loading ? 'Processing...' : 'Capture Index Finger'}
                </button>
              </>
            ) : !distressHash ? (
              <>
                <div className="text-green-600 font-medium text-center">✓ Index finger captured</div>
                <p className="text-gray-600">Now place your PINKY finger close to the camera</p>
                <div className="relative rounded-lg overflow-hidden">
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    className="w-full rounded-lg"
                  />
                </div>
                {captureStatus && (
                  <div className="text-green-600 font-medium text-center">{captureStatus}</div>
                )}
                <button
                  onClick={() => handleCaptureFingerprint(true)}
                  disabled={loading}
                  className="w-full bg-orange-600 text-white py-3 rounded-lg font-semibold hover:bg-orange-700 disabled:bg-gray-400 transition"
                >
                  {loading ? 'Processing...' : 'Capture Pinky Finger (Distress)'}
                </button>
              </>
            ) : null}
          </div>
        )}

        {/* Step 4: Fund Wallet */}
        {step === 4 && (
          <div className="space-y-6">
            <h2 className="text-2xl font-semibold text-gray-800">Fund Your Wallet</h2>
            <div className="space-y-4">
              {/* Amount Slider */}
              <div>
                <label className="block text-gray-700 mb-2 font-medium">
                  Amount: ₹{amount}
                </label>
                <input
                  type="range"
                  min="1000"
                  max="2000"
                  step="100"
                  value={amount}
                  onChange={(e) => setAmount(parseInt(e.target.value))}
                  className="w-full accent-indigo-600"
                />
              </div>

              {/* Payment Method Selection */}
              <div>
                <label className="block text-gray-700 mb-3 font-medium">Choose Funding Method</label>
                <div className="grid grid-cols-2 gap-3">
                  {/* UPI Option */}
                  <button
                    type="button"
                    onClick={() => setFundingMethod('upi')}
                    className={`relative flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all ${
                      fundingMethod === 'upi'
                        ? 'border-indigo-500 bg-indigo-50 shadow-md'
                        : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    {fundingMethod === 'upi' && (
                      <div className="absolute top-2 right-2 w-5 h-5 bg-indigo-500 rounded-full flex items-center justify-center">
                        <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      </div>
                    )}
                    <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-green-500 to-emerald-600 flex items-center justify-center">
                      <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 0 0 2.25-2.25V6.75A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25v10.5A2.25 2.25 0 0 0 4.5 19.5Z" />
                      </svg>
                    </div>
                    <span className="font-semibold text-gray-800 text-sm">UPI Wallet</span>
                    <span className="text-xs text-gray-500">GPay, PhonePe, Paytm</span>
                  </button>

                  {/* Crypto Option */}
                  <button
                    type="button"
                    onClick={() => setFundingMethod('crypto')}
                    className={`relative flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all ${
                      fundingMethod === 'crypto'
                        ? 'border-orange-500 bg-orange-50 shadow-md'
                        : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    {fundingMethod === 'crypto' && (
                      <div className="absolute top-2 right-2 w-5 h-5 bg-orange-500 rounded-full flex items-center justify-center">
                        <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      </div>
                    )}
                    <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-orange-500 to-amber-600 flex items-center justify-center">
                      <svg className="w-7 h-7 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M20.893 13.393l-1.135-1.135a2.252 2.252 0 01-.421-.585l-1.08-2.16a.414.414 0 00-.663-.107l-.992.992a2.25 2.25 0 01-1.591.659h-3.002a2.25 2.25 0 01-1.591-.659l-.992-.992a.414.414 0 00-.663.107l-1.08 2.16a2.252 2.252 0 01-.421.585l-1.135 1.135a.414.414 0 00.107.663l2.16 1.08a2.25 2.25 0 01.585.421l1.135 1.135a.414.414 0 00.663-.107l.992-.992a2.25 2.25 0 011.591-.659h3.002a2.25 2.25 0 011.591.659l.992.992a.414.414 0 00.663-.107l1.135-1.135a2.25 2.25 0 01.421-.585l2.16-1.08a.414.414 0 00.107-.663z" />
                        <circle cx="12" cy="12" r="3" strokeLinecap="round" />
                      </svg>
                    </div>
                    <span className="font-semibold text-gray-800 text-sm">Crypto Wallet</span>
                    <span className="text-xs text-gray-500">MetaMask, WalletConnect</span>
                  </button>
                </div>
              </div>

              {/* UPI ID Input */}
              {fundingMethod === 'upi' && (
                <div className="animate-in slide-in-from-bottom-2">
                  <label className="block text-gray-700 mb-2 font-medium text-sm">Enter UPI ID</label>
                  <input
                    type="text"
                    placeholder="yourname@upi"
                    value={upiId}
                    onChange={(e) => setUpiId(e.target.value)}
                    className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-indigo-500 focus:outline-none text-gray-800 transition"
                  />
                  <div className="flex gap-2 mt-2">
                    {['@okicici', '@ybl', '@paytm'].map((suffix) => (
                      <button
                        key={suffix}
                        type="button"
                        onClick={() => setUpiId((prev) => prev.split('@')[0] + suffix)}
                        className="px-3 py-1 text-xs bg-gray-100 text-gray-600 rounded-full hover:bg-indigo-100 hover:text-indigo-700 transition"
                      >
                        {suffix}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Crypto Wallet Input */}
              {fundingMethod === 'crypto' && (
                <div className="animate-in slide-in-from-bottom-2">
                  <label className="block text-gray-700 mb-2 font-medium text-sm">Wallet Address or ENS</label>
                  <input
                    type="text"
                    placeholder="0x... or yourname.eth"
                    value={cryptoWallet}
                    onChange={(e) => setCryptoWallet(e.target.value)}
                    className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-orange-500 focus:outline-none text-gray-800 font-mono text-sm transition"
                  />
                  <div className="flex gap-2 mt-3">
                    <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-100 rounded-lg">
                      <div className="w-4 h-4 rounded-full bg-blue-500"></div>
                      <span className="text-xs text-gray-600 font-medium">ETH</span>
                    </div>
                    <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-100 rounded-lg">
                      <div className="w-4 h-4 rounded-full bg-purple-500"></div>
                      <span className="text-xs text-gray-600 font-medium">Polygon</span>
                    </div>
                    <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-100 rounded-lg">
                      <div className="w-4 h-4 rounded-full bg-yellow-500"></div>
                      <span className="text-xs text-gray-600 font-medium">BSC</span>
                    </div>
                  </div>
                  <p className="text-xs text-gray-400 mt-2">INR equivalent calculated at live exchange rates</p>
                </div>
              )}

              {/* Info */}
              <div className="bg-blue-50 p-4 rounded-lg">
                <p className="text-sm text-gray-700">
                  <strong>Expiry:</strong> 72 hours from now — auto-refunds if unused
                </p>
              </div>

              {/* Submit */}
              <button
                onClick={handleCreateWallet}
                disabled={loading || !fundingMethod}
                className={`w-full py-3 rounded-xl font-semibold transition disabled:bg-gray-300 disabled:cursor-not-allowed ${
                  fundingMethod === 'crypto'
                    ? 'bg-gradient-to-r from-orange-500 to-amber-600 text-white hover:from-orange-600 hover:to-amber-700'
                    : 'bg-gradient-to-r from-green-500 to-emerald-600 text-white hover:from-green-600 hover:to-emerald-700'
                }`}
              >
                {loading
                  ? 'Creating Wallet...'
                  : fundingMethod === 'crypto'
                  ? `Lock ₹${amount} via Crypto`
                  : fundingMethod === 'upi'
                  ? `Lock ₹${amount} via UPI`
                  : 'Select a funding method'}
              </button>
            </div>
          </div>
        )}

        {/* Step 5: Success */}
        {step === 5 && (
          <div className="space-y-6 text-center">
            <div className="text-green-500">
              <svg className="w-16 h-16 mx-auto" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z" />
              </svg>
            </div>
            <h2 className="text-3xl font-bold text-green-600">Wallet Created!</h2>
            <div className="space-y-2 text-gray-700">
              <p><strong>Wallet ID:</strong> {walletId.substring(0, 8)}...</p>
              <p><strong>Amount Locked:</strong> ₹{amount}</p>
              <p><strong>Funded via:</strong> {fundingMethod === 'crypto' ? 'Crypto Wallet' : 'UPI'}</p>
              <p><strong>Expires:</strong> {expiry}</p>
            </div>
            <button
              onClick={() => router.push(`/dashboard?wallet_id=${walletId}`)}
              className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold hover:bg-blue-700 transition"
            >
              Go to Dashboard
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
