import axios from 'axios';
import { API_BASE_URL } from '@/lib/api';

export interface InvitationTokenInfo {
  email: string;
  recipient_name: string | null;
  expires_at: string;
  user_exists: boolean;
}

export interface InvitationRegisterData {
  token: string;
  username: string;
  password: string;
  firstName?: string;
  lastName?: string;
  licenseAgreementConsent: boolean;
  contentSharingConsent: boolean;
}

export interface InvitationRegisterResponse {
  user: {
    id: string;
    username: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    role: string;
  };
  tokens: {
    access_token: string;
    refresh_token: string | null;
    expires_in: number;
    token_type: string;
  };
}

export async function validateInvitationToken(token: string): Promise<InvitationTokenInfo> {
  const response = await axios.get(`${API_BASE_URL}/auth/invitation/validate`, {
    params: { token },
  });
  return response.data;
}

export async function registerWithInvitation(data: InvitationRegisterData): Promise<InvitationRegisterResponse> {
  // Backend uses SNAKE_CASE Jackson naming strategy
  const response = await axios.post(`${API_BASE_URL}/auth/invitation/register`, {
    token: data.token,
    username: data.username,
    password: data.password,
    first_name: data.firstName,
    last_name: data.lastName,
    license_agreement_consent: data.licenseAgreementConsent,
    content_sharing_consent: data.contentSharingConsent,
  });
  return response.data;
}
