import { Model } from '@/types';

// Define available models
export const models: Model[] = [
  {
    id: 'deepseek-1.5b',
    name: 'deepseek-r1',
    iconSrc: '/providers/deepseek.svg',
    group: 'ACTIVE',
    size: '1.5b',
  },
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    iconSrc: '/providers/openai.svg',
    group: 'ACTIVE',
    size: '4.0',
  },
  {
    id: 'claude-3',
    name: 'Claude 3',
    iconSrc: '/providers/anthropic.svg',
    group: 'ACTIVE',
    size: '3.0',
  },
  {
    id: 'deepseek-r1-14b',
    name: 'deepseek-r1',
    iconSrc: '/providers/ollama.svg',
    group: 'OLLAMA',
    size: '14b',
  },
  {
    id: 'deepseek-r1-32b-qwen-distill',
    name: 'deepseek-r1',
    iconSrc: '/providers/ollama.svg',
    group: 'OLLAMA',
    size: '32b-qwen-distill',
  },
  {
    id: 'jeffh-intfloat-multilingual-e5',
    name: 'jeffh/intfloat-multilingual-e5',
    iconSrc: '/providers/ollama.svg',
    group: 'OLLAMA',
    size: 'E5',
  },
  {
    id: 'llama3-1.8b-instruct-fp16',
    name: 'llama3',
    iconSrc: '/providers/ollama.svg',
    group: 'OLLAMA',
    size: '1.8b-instruct-fp16',
  },
  {
    id: 'nomic-embed-text-v2-moe',
    name: 'nomic-embed-text-v2-moe',
    iconSrc: '/providers/ollama.svg',
    group: 'OLLAMA',
    size: 'latest',
  },
];
