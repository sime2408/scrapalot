export interface Session {
  id: string;
  user_id: string;
  title: string;
  conversation_name?: string;
  messages: Message[];
  createdAt: Date;
  updatedAt: Date;
  created_at?: string;
  updated_at?: string;
  modelId?: string | null;
  model_id?: string | null;
  collection_id?: string | null;
  session_folder_id?: string | null;
  lastMessageFetchTime?: number;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  feedback?: string | null;
  message_metadata?: Record<string, unknown>;
  session_id?: string;
  created_at?: string;
  updated_at?: string;
}

export interface Model {
  id: string;
  name: string;
  group: string;
  iconSrc: string;
  provider: string;
}

export interface DocumentCollection {
  id: string;
  name: string;
  description?: string;
  documentIds?: string[];
  documentCount?: number;
}
