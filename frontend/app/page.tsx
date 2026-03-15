import Link from 'next/link';

function ShieldIcon({ className = "w-10 h-10" }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z" />
    </svg>
  );
}

function CreditCardIcon({ className = "w-10 h-10" }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 0 0 2.25-2.25V6.75A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25v10.5A2.25 2.25 0 0 0 4.5 19.5Z" />
    </svg>
  );
}

function HomeIcon({ className = "w-10 h-10" }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
    </svg>
  );
}

function UserIcon({ className = "w-8 h-8" }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
    </svg>
  );
}

function CurrencyIcon({ className = "w-8 h-8" }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 8.25H9m6 3H9m3 6-3-3h1.5a3 3 0 1 0 0-6M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
    </svg>
  );
}

function CheckCircleIcon({ className = "w-8 h-8" }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
    </svg>
  );
}

function LockIcon({ className = "w-6 h-6" }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
    </svg>
  );
}

function BellAlertIcon({ className = "w-6 h-6" }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0M3.124 7.5A8.969 8.969 0 0 1 5.292 3m13.416 0a8.969 8.969 0 0 1 2.168 4.5" />
    </svg>
  );
}

function UsersIcon({ className = "w-6 h-6" }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z" />
    </svg>
  );
}

function ClockIcon({ className = "w-6 h-6" }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
    </svg>
  );
}

export default function Home() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-900 via-purple-900 to-indigo-900 flex items-center justify-center p-4 md:p-8">
      <div className="max-w-6xl w-full">
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
            <div className="bg-white rounded-2xl p-8 lg:p-10 hover:shadow-2xl transition transform hover:scale-105 cursor-pointer h-full">
              <div className="text-blue-600 mb-4"><ShieldIcon className="w-12 h-12 lg:w-14 lg:h-14" /></div>
              <h2 className="text-2xl lg:text-3xl font-bold text-gray-800 mb-3">Set Up My Wallet</h2>
              <p className="text-gray-600 lg:text-lg">
                Enroll your biometrics and create a secure 72-hour emergency wallet
              </p>
            </div>
          </Link>

          <Link href="/merchant">
            <div className="bg-white rounded-2xl p-8 lg:p-10 hover:shadow-2xl transition transform hover:scale-105 cursor-pointer h-full">
              <div className="text-purple-600 mb-4"><CreditCardIcon className="w-12 h-12 lg:w-14 lg:h-14" /></div>
              <h2 className="text-2xl lg:text-3xl font-bold text-gray-800 mb-3">Merchant Payment</h2>
              <p className="text-gray-600 lg:text-lg">
                Scan customers and accept biometric payments instantly
              </p>
            </div>
          </Link>

          <Link href="/dashboard">
            <div className="bg-white rounded-2xl p-8 lg:p-10 hover:shadow-2xl transition transform hover:scale-105 cursor-pointer h-full">
              <div className="text-indigo-600 mb-4"><HomeIcon className="w-12 h-12 lg:w-14 lg:h-14" /></div>
              <h2 className="text-2xl lg:text-3xl font-bold text-gray-800 mb-3">Relief Mode</h2>
              <p className="text-gray-600 lg:text-lg">
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
              <div className="text-blue-300 flex justify-center mb-3"><UserIcon className="w-10 h-10" /></div>
              <h4 className="text-lg font-semibold text-white mb-2">1. Enroll</h4>
              <p className="text-blue-200 text-sm">
                Scan your face and fingerprints to create your biometric wallet
              </p>
            </div>
            <div className="text-center">
              <div className="text-blue-300 flex justify-center mb-3"><CurrencyIcon className="w-10 h-10" /></div>
              <h4 className="text-lg font-semibold text-white mb-2">2. Fund</h4>
              <p className="text-blue-200 text-sm">
                Lock ₹1000-2000 via UPI for 72 hours
              </p>
            </div>
            <div className="text-center">
              <div className="text-blue-300 flex justify-center mb-3"><CheckCircleIcon className="w-10 h-10" /></div>
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
              <span className="text-blue-300 mt-0.5"><LockIcon /></span>
              <div>
                <h4 className="font-semibold">Adaptive Authentication</h4>
                <p className="text-sm text-blue-200">Face-only for small amounts, face+fingerprint for larger</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <span className="text-red-400 mt-0.5"><BellAlertIcon /></span>
              <div>
                <h4 className="font-semibold">Distress Mode</h4>
                <p className="text-sm text-blue-200">Use pinky finger to trigger SOS alert with GPS</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <span className="text-green-400 mt-0.5"><UsersIcon /></span>
              <div>
                <h4 className="font-semibold">Family Wallet</h4>
                <p className="text-sm text-blue-200">Add delegates with spending caps</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <span className="text-amber-400 mt-0.5"><ClockIcon /></span>
              <div>
                <h4 className="font-semibold">Auto-Expiry</h4>
                <p className="text-sm text-blue-200">72-hour wallet with automatic refund</p>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="text-center mt-8 text-blue-300 text-sm">
          <p>PulsePay - Powered by Amazon Nova</p>
        </div>
      </div>
    </div>
  );
}
