import Link from 'next/link';

export default function Home() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-900 via-purple-900 to-indigo-900 flex items-center justify-center p-4">
      <div className="max-w-4xl w-full">
        {/* Logo and Tagline */}
        <div className="text-center mb-12">
          <h1 className="text-6xl font-bold text-white mb-4">
            PulsePay
          </h1>
          <p className="text-2xl text-blue-200 mb-2">Your Body Is Your Wallet</p>
          <p className="text-lg text-blue-300">Biometric micro-wallet for emergency phone-less payments in India</p>
        </div>

        {/* Main Action Buttons */}
        <div className="grid md:grid-cols-3 gap-6 mb-12">
          <Link href="/enroll">
            <div className="bg-white rounded-2xl p-8 hover:shadow-2xl transition transform hover:scale-105 cursor-pointer">
              <div className="text-5xl mb-4">🛡️</div>
              <h2 className="text-2xl font-bold text-gray-800 mb-2">Set Up My Wallet</h2>
              <p className="text-gray-600">
                Enroll your biometrics and create a secure 72-hour emergency wallet
              </p>
            </div>
          </Link>

          <Link href="/merchant">
            <div className="bg-white rounded-2xl p-8 hover:shadow-2xl transition transform hover:scale-105 cursor-pointer">
              <div className="text-5xl mb-4">💳</div>
              <h2 className="text-2xl font-bold text-gray-800 mb-2">Merchant Payment</h2>
              <p className="text-gray-600">
                Scan customers and accept biometric payments instantly
              </p>
            </div>
          </Link>

          <Link href="/dashboard">
            <div className="bg-white rounded-2xl p-8 hover:shadow-2xl transition transform hover:scale-105 cursor-pointer">
              <div className="text-5xl mb-4">🏠</div>
              <h2 className="text-2xl font-bold text-gray-800 mb-2">Relief Mode</h2>
              <p className="text-gray-600">
                View your wallet status, extend time, or request early refund
              </p>
            </div>
          </Link>
        </div>

        {/* How It Works */}
        <div className="bg-white/10 backdrop-blur-lg rounded-2xl p-8 mb-8">
          <h3 className="text-2xl font-bold text-white mb-6 text-center">How It Works</h3>
          <div className="grid md:grid-cols-3 gap-6">
            <div className="text-center">
              <div className="text-4xl mb-3">👤</div>
              <h4 className="text-lg font-semibold text-white mb-2">1. Enroll</h4>
              <p className="text-blue-200 text-sm">
                Scan your face and fingerprints to create your biometric wallet
              </p>
            </div>
            <div className="text-center">
              <div className="text-4xl mb-3">💰</div>
              <h4 className="text-lg font-semibold text-white mb-2">2. Fund</h4>
              <p className="text-blue-200 text-sm">
                Lock ₹1000-2000 via UPI for 72 hours
              </p>
            </div>
            <div className="text-center">
              <div className="text-4xl mb-3">✅</div>
              <h4 className="text-lg font-semibold text-white mb-2">3. Pay</h4>
              <p className="text-blue-200 text-sm">
                Use your face and fingerprint to pay at merchants
              </p>
            </div>
          </div>
        </div>

        {/* Features */}
        <div className="bg-white/10 backdrop-blur-lg rounded-2xl p-8">
          <h3 className="text-2xl font-bold text-white mb-6 text-center">Key Features</h3>
          <div className="grid md:grid-cols-2 gap-4 text-white">
            <div className="flex items-start gap-3">
              <span className="text-2xl">🔒</span>
              <div>
                <h4 className="font-semibold">Adaptive Authentication</h4>
                <p className="text-sm text-blue-200">Face-only for small amounts, face+fingerprint for larger</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <span className="text-2xl">🚨</span>
              <div>
                <h4 className="font-semibold">Distress Mode</h4>
                <p className="text-sm text-blue-200">Use pinky finger to trigger SOS alert with GPS</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <span className="text-2xl">👨‍👩‍👧</span>
              <div>
                <h4 className="font-semibold">Family Wallet</h4>
                <p className="text-sm text-blue-200">Add delegates with spending caps</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <span className="text-2xl">⏱️</span>
              <div>
                <h4 className="font-semibold">Auto-Expiry</h4>
                <p className="text-sm text-blue-200">72-hour wallet with automatic refund</p>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="text-center mt-8 text-blue-300 text-sm">
          <p>PulsePay - Nova Hackathon Build</p>
        </div>
      </div>
    </div>
  );
}
