interface SessionData {
  walletId: string;
  token: string;
  phone?: string;
  expiry?: string;
}

export function saveSession(data: SessionData) {
  if (typeof window === 'undefined') return;
  localStorage.setItem('pulsepay_token', data.token);
  localStorage.setItem('pulsepay_wallet_id', data.walletId);
  if (data.phone) localStorage.setItem('pulsepay_phone', data.phone);
  if (data.expiry) localStorage.setItem('pulsepay_expiry', data.expiry);
}

export function getSession(): SessionData | null {
  if (typeof window === 'undefined') return null;
  const token = localStorage.getItem('pulsepay_token');
  const walletId = localStorage.getItem('pulsepay_wallet_id');
  if (!token || !walletId) return null;

  // Check expiry
  const expiry = localStorage.getItem('pulsepay_expiry');
  if (expiry && new Date(expiry) < new Date()) {
    clearSession();
    return null;
  }

  return {
    token,
    walletId,
    phone: localStorage.getItem('pulsepay_phone') || undefined,
    expiry: expiry || undefined
  };
}

export function clearSession() {
  if (typeof window === 'undefined') return;
  localStorage.removeItem('pulsepay_token');
  localStorage.removeItem('pulsepay_wallet_id');
  localStorage.removeItem('pulsepay_phone');
  localStorage.removeItem('pulsepay_expiry');
}
