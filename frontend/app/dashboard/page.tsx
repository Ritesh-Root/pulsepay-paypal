'use client';

import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'next/navigation';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000';
const CV_SERVICE_URL = process.env.NEXT_PUBLIC_CV_SERVICE_URL || 'http://localhost:8000';

export default function DashboardPage() {
  const searchParams = useSearchParams();
  const walletIdFromUrl = searchParams.get('wallet_id');

  const [walletId, setWalletId] = useState(walletIdFromUrl || '');
  const [wallet, setWallet] = useState<any>(null);
  const [transactions, setTransactions] = useState<any[]>([]);
  const [delegates, setDelegates] = useState<any[]>([]);
  const [timeLeft, setTimeLeft] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showAddDelegate, setShowAddDelegate] = useState(false);
  const [delegateName, setDelegateName] = useState('');
  const [spendingCap, setSpendingCap] = useState(500);
  const [cameraActive, setCameraActive] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (walletId) {
      fetchWalletData();
      fetchDelegates();
    }
  }, [walletId]);

  useEffect(() => {
    if (wallet) {
      const timer = setInterval(() => {
        const now = new Date().getTime();
        const expiry = new Date(wallet.expiry).getTime();
        const distance = expiry - now;

        if (distance < 0) {
          setTimeLeft('EXPIRED');
        } else {
          const hours = Math.floor(distance / (1000 * 60 * 60));
          const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
          const seconds = Math.floor((distance % (1000 * 60)) / 1000);
          setTimeLeft(`${hours}h ${minutes}m ${seconds}s`);
        }
      }, 1000);

      return () => clearInterval(timer);
    }
  }, [wallet]);

  const fetchWalletData = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`${API_URL}/api/wallet/${walletId}`);
      const data = await response.json();

      if (data.wallet) {
        setWallet(data.wallet);
        setTransactions(data.transactions || []);
      } else {
        setError(data.error || 'Wallet not found');
      }
    } catch (err) {
      setError('Failed to fetch wallet data');
    }
    setLoading(false);
  };

  const fetchDelegates = async () => {
    try {
      const response = await fetch(`${API_URL}/api/family/delegates/${walletId}`);
      const data = await response.json();
      setDelegates(data.delegates || []);
    } catch (err) {
      console.error('Failed to fetch delegates:', err);
    }
  };

  const handleExtendWallet = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`${API_URL}/api/wallet/extend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet_id: walletId })
      });
      const data = await response.json();
      if (data.success) {
        await fetchWalletData();
        alert('Wallet extended by 72 hours!');
      } else {
        setError(data.error || 'Failed to extend wallet');
      }
    } catch (err) {
      setError('Failed to extend wallet');
    }
    setLoading(false);
  };

  const handleRefundWallet = async () => {
    if (!confirm('Are you sure you want to refund and close this wallet?')) {
      return;
    }

    setLoading(true);
    setError('');
    try {
      const response = await fetch(`${API_URL}/api/wallet/refund`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet_id: walletId })
      });
      const data = await response.json();
      if (data.success) {
        alert(`Refunded ₹${(data.refunded_amount / 100).toFixed(2)}`);
        await fetchWalletData();
      } else {
        setError(data.error || 'Failed to refund wallet');
      }
    } catch (err) {
      setError('Failed to refund wallet');
    }
    setLoading(false);
  };

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 }
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      setCameraActive(true);
    } catch (err) {
      setError('Camera access denied');
    }
  };

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    setCameraActive(false);
  };

  const handleAddDelegate = async () => {
    if (!delegateName || !cameraActive) {
      setError('Please enter name and capture face');
      return;
    }

    setLoading(true);
    setError('');

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

      const hashResponse = await fetch(`${CV_SERVICE_URL}/hash-face`, {
        method: 'POST',
        body: formData
      });

      const hashData = await hashResponse.json();

      if (hashData.error) {
        setError(hashData.error);
        setLoading(false);
        return;
      }

      // Add delegate
      const response = await fetch(`${API_URL}/api/family/add-delegate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parent_wallet_id: walletId,
          delegate_name: delegateName,
          delegate_face_hash: hashData.hash,
          spending_cap: spendingCap * 100
        })
      });

      const data = await response.json();

      if (data.success) {
        alert('Delegate added successfully!');
        setShowAddDelegate(false);
        setDelegateName('');
        setSpendingCap(500);
        stopCamera();
        await fetchDelegates();
      } else {
        setError(data.error || 'Failed to add delegate');
      }
    } catch (err) {
      setError('Failed to add delegate');
    }
    setLoading(false);
  };

  if (loading && !wallet) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <div className="text-2xl text-gray-700">Loading...</div>
      </div>
    );
  }

  if (!walletId) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
        <div className="bg-white p-8 rounded-lg shadow-lg max-w-md w-full">
          <h2 className="text-2xl font-bold mb-4">Enter Wallet ID</h2>
          <input
            type="text"
            placeholder="Wallet ID"
            value={walletId}
            onChange={(e) => setWalletId(e.target.value)}
            className="w-full px-4 py-2 border rounded-lg mb-4 text-gray-900"
          />
          <button
            onClick={() => walletId && fetchWalletData()}
            className="w-full bg-blue-600 text-white py-2 rounded-lg hover:bg-blue-700"
          >
            Load Dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100 p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <h1 className="text-4xl font-bold text-gray-800">PulsePay Dashboard</h1>

        {error && (
          <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
            {error}
          </div>
        )}

        {wallet && (
          <>
            {/* Wallet Status Card */}
            <div className="bg-white rounded-lg shadow-lg p-6">
              <h2 className="text-2xl font-bold mb-4 text-gray-800">Wallet Status</h2>
              <div className="grid md:grid-cols-3 gap-4">
                <div>
                  <p className="text-gray-600">Balance</p>
                  <p className="text-3xl font-bold text-green-600">₹{(wallet.balance / 100).toFixed(2)}</p>
                </div>
                <div>
                  <p className="text-gray-600">Expiry Countdown</p>
                  <p className="text-2xl font-bold text-blue-600">{timeLeft}</p>
                </div>
                <div>
                  <p className="text-gray-600">Status</p>
                  <span className={`inline-block px-4 py-2 rounded-full font-semibold ${
                    wallet.active && new Date(wallet.expiry) > new Date()
                      ? 'bg-green-100 text-green-700'
                      : 'bg-red-100 text-red-700'
                  }`}>
                    {wallet.active && new Date(wallet.expiry) > new Date() ? 'Active' : 'Expired'}
                  </span>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="grid md:grid-cols-3 gap-4 mt-6">
                <button
                  onClick={handleExtendWallet}
                  disabled={loading}
                  className="bg-blue-600 text-white py-3 rounded-lg hover:bg-blue-700 disabled:bg-gray-400"
                >
                  Extend 72 Hours
                </button>
                <button
                  onClick={handleRefundWallet}
                  disabled={loading}
                  className="bg-orange-600 text-white py-3 rounded-lg hover:bg-orange-700 disabled:bg-gray-400"
                >
                  Refund Now
                </button>
                <button
                  disabled
                  className="bg-gray-600 text-white py-3 rounded-lg disabled:bg-gray-400"
                >
                  Rotate Key
                </button>
              </div>
            </div>

            {/* Transaction History */}
            <div className="bg-white rounded-lg shadow-lg p-6">
              <h2 className="text-2xl font-bold mb-4 text-gray-800">Transaction History</h2>
              {transactions.length === 0 ? (
                <p className="text-gray-600">No transactions yet</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left py-2 text-gray-700">Date</th>
                        <th className="text-left py-2 text-gray-700">Amount</th>
                        <th className="text-left py-2 text-gray-700">Merchant</th>
                        <th className="text-left py-2 text-gray-700">Auth Tier</th>
                        <th className="text-left py-2 text-gray-700">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {transactions.map((tx) => (
                        <tr key={tx.id} className="border-b">
                          <td className="py-2 text-gray-900">{new Date(tx.created_at).toLocaleDateString()}</td>
                          <td className="py-2 text-gray-900">₹{(tx.amount / 100).toFixed(2)}</td>
                          <td className="py-2 text-gray-900">{tx.merchant_upi}</td>
                          <td className="py-2">
                            <span className="px-2 py-1 bg-blue-100 text-blue-700 rounded text-sm">
                              {tx.auth_tier}
                            </span>
                          </td>
                          <td className="py-2">
                            <span className="px-2 py-1 bg-green-100 text-green-700 rounded text-sm">
                              {tx.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Family Wallet */}
            <div className="bg-white rounded-lg shadow-lg p-6">
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-2xl font-bold text-gray-800">Family Delegates</h2>
                <button
                  onClick={() => setShowAddDelegate(!showAddDelegate)}
                  className="bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700"
                >
                  Add Family Member
                </button>
              </div>

              {/* Add Delegate Modal */}
              {showAddDelegate && (
                <div className="border-2 border-green-500 rounded-lg p-4 mb-4 bg-green-50">
                  <h3 className="text-xl font-semibold mb-3 text-gray-800">Add New Delegate</h3>
                  <div className="space-y-4">
                    <input
                      type="text"
                      placeholder="Delegate Name"
                      value={delegateName}
                      onChange={(e) => setDelegateName(e.target.value)}
                      className="w-full px-4 py-2 border rounded-lg text-gray-900"
                    />
                    <div>
                      <label className="block mb-2 text-gray-700">Spending Cap: ₹{spendingCap}</label>
                      <input
                        type="range"
                        min="100"
                        max="5000"
                        step="100"
                        value={spendingCap}
                        onChange={(e) => setSpendingCap(parseInt(e.target.value))}
                        className="w-full"
                      />
                    </div>
                    {!cameraActive ? (
                      <button
                        onClick={startCamera}
                        className="w-full bg-blue-600 text-white py-2 rounded-lg hover:bg-blue-700"
                      >
                        Start Camera to Scan Face
                      </button>
                    ) : (
                      <>
                        <video
                          ref={videoRef}
                          autoPlay
                          playsInline
                          className="w-full rounded-lg"
                        />
                        <div className="flex gap-2">
                          <button
                            onClick={handleAddDelegate}
                            disabled={loading}
                            className="flex-1 bg-green-600 text-white py-2 rounded-lg hover:bg-green-700 disabled:bg-gray-400"
                          >
                            {loading ? 'Adding...' : 'Add Delegate'}
                          </button>
                          <button
                            onClick={stopCamera}
                            className="flex-1 bg-red-600 text-white py-2 rounded-lg hover:bg-red-700"
                          >
                            Cancel
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}

              {/* Delegates List */}
              {delegates.length === 0 ? (
                <p className="text-gray-600">No delegates added yet</p>
              ) : (
                <div className="space-y-2">
                  {delegates.map((delegate) => (
                    <div key={delegate.id} className="flex justify-between items-center p-4 border rounded-lg">
                      <div>
                        <p className="font-semibold text-gray-900">{delegate.delegate_name}</p>
                        <p className="text-sm text-gray-600">Cap: ₹{(delegate.spending_cap / 100).toFixed(2)}</p>
                      </div>
                      <span className={`px-3 py-1 rounded-full text-sm ${
                        delegate.active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-700'
                      }`}>
                        {delegate.active ? 'Active' : 'Inactive'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
