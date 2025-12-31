# Fastermail

An AI-powered email triage agent for Fastmail. Automatically classifies incoming emails, applies labels, and sends daily digests of low-priority messages.

## Features

- **Smart Classification**: Uses Claude to classify emails into priority levels (Important, Needs Reply, FYI, Low Priority)
- **Automatic Labeling**: Creates Fastmail folders for each classification level
- **Sender Profiling**: Learns your communication patterns to improve classification
- **Email Digests**: Sends scheduled summaries of low-priority emails with one-click cleanup
- **JMAP Integration**: Native Fastmail API support via JMAP protocol

## How It Works

1. Polls your Fastmail inbox for new emails
2. Analyzes each email using Claude (Haiku) for fast, cost-effective classification
3. Applies labels under a `Fastermail/` folder hierarchy
4. Batches low-priority emails into digest summaries sent at configured times
5. Provides a cleanup link in digests to archive processed emails

## Setup

### Prerequisites

- Node.js 18+
- A Fastmail account with API access
- An Anthropic API key
- A Turso database (free tier works fine)

### Installation

```bash
npm install
cp .env.example .env
```

### Configuration

Edit `.env` with your credentials:

```env
# Fastmail API token (create at Settings > Privacy & Security > API tokens)
JMAP_TOKEN=your_fastmail_api_token

# Anthropic API key
ANTHROPIC_API_KEY=your_anthropic_api_key

# Your email address
USER_EMAIL=you@fastmail.com

# Turso database
TURSO_DATABASE_URL=libsql://your-db.turso.io
TURSO_AUTH_TOKEN=your_turso_token

# Optional: customize digest schedule (24h format)
DIGEST_TIMES=09:00,18:00

# Optional: base URL for cleanup links (if self-hosting)
BASE_URL=https://your-deployment.com
```

### Running

```bash
# Development
npm run dev

# Production
npm run build
npm start

# With PM2
npm run pm2:start
```

## Architecture

```
src/
├── index.ts          # Main entry point, HTTP server for cleanup
├── jmap/             # Fastmail JMAP client
├── triage/           # Email classification engine
├── sender/           # Sender profile management
├── digest/           # Digest generation and scheduling
├── cleanup/          # Post-digest email cleanup
└── db/               # Turso database layer
```

## Classification Labels

Emails are organized into `Fastermail/` subfolders:

- **Important**: Time-sensitive, requires immediate attention
- **Needs Reply**: Requires a response, but not urgent
- **FYI**: Worth reading, no action needed
- **Low Priority**: Newsletters, notifications, marketing

## License

LGPL-3.0
