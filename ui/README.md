# Chat Docs Collection

A modern UI for the Scrapalot chat application to interact with document collections.

[![Discord](https://img.shields.io/badge/Discord-Join%20our%20community-5865F2?logo=discord&logoColor=white)](https://discord.gg/mmuCqzFXs7)

> 💬 **Join the community** — questions, self-hosting help, and roadmap discussion live on our [Discord server](https://discord.gg/mmuCqzFXs7).

## Features

- Chat with AI about documents in your collections
- View documents side-by-side with chat
- Real-time streaming responses
- Well-organized document collections
- PDF viewing and highlighting
- Dark mode support

## Getting Started

### Prerequisites

- Node.js 18+ installed
- Scrapalot backend running (see below)

### Installing

1. Clone this repository
2. Install dependencies:

```bash
npm install
# or
yarn
# or
pnpm install
```

3. Copy the example environment file and configure it:

```bash
cp .env.example .env
```

4. Edit the `.env` file to point to your Scrapalot backend:

```
VITE_API_BASE_URL=http://localhost:8090/api/v1  # Change to your backend URL if needed
```

### Running

Start the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
```

The application will be available at [http://localhost:3000](http://localhost:3000).

## Connecting to Scrapalot Backend

This UI is designed to work with the Scrapalot chat backend. To connect:

1. Make sure the Scrapalot backend is running (typically on port 8090)
2. Configure the `VITE_API_BASE_URL` in your `.env` file to point to the backend
3. Ensure CORS is properly configured on the backend to allow requests from this frontend
4. Log in with the same credentials you use for the Scrapalot backend

## Development

### Building for Production

```bash
npm run build
# or
yarn build
# or
pnpm build
```

The built files will be in the `dist` directory, ready to be deployed.

### Preview Production Build

```bash
npm run preview
# or
yarn preview
# or
pnpm preview
```

## License

Scrapalot is **open-core**. This repository is part of the **proprietary, hosted Scrapalot product** (Pro / Team / Enterprise) — © 2024–2026 Scrapalot, all rights reserved.

A free, self-hostable **Community Edition** is published separately under the **AGPL-3.0** license. See [Editions](https://docs.scrapalot.app/getting-started/editions) for what each includes.
