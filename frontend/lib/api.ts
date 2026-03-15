const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000';
const CV_SERVICE_URL = process.env.NEXT_PUBLIC_CV_SERVICE_URL || 'http://localhost:8000';

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('pulsepay_token');
}

function getAuthHeaders(): Record<string, string> {
  const token = getToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

async function handleResponse(response: Response) {
  const data = await response.json();
  if (response.status === 401) {
    // Token expired - clear session
    if (typeof window !== 'undefined') {
      localStorage.removeItem('pulsepay_token');
      localStorage.removeItem('pulsepay_wallet_id');
      localStorage.removeItem('pulsepay_expiry');
    }
  }
  return data;
}

export const api = {
  async get(path: string) {
    const response = await fetch(`${API_URL}${path}`, {
      headers: getAuthHeaders()
    });
    return handleResponse(response);
  },

  async post(path: string, body: any) {
    const response = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(body)
    });
    return handleResponse(response);
  },

  async postForm(url: string, formData: FormData) {
    const response = await fetch(url, {
      method: 'POST',
      body: formData
    });
    return response.json();
  }
};

export { API_URL, CV_SERVICE_URL };
