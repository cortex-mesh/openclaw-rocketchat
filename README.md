# OpenClaw Rocket.Chat Plugin

A Rocket.Chat channel plugin for [OpenClaw](https://github.com/nichochar/open-claw). Polls Rocket.Chat channels for new messages, dispatches them through the OpenClaw agent system, and sends responses back — with reaction feedback (hourglass on start, checkmark on success, x on failure).

## Requirements

- Node.js >= 22
- OpenClaw >= 2026.2.0
- A Rocket.Chat instance with API access

## Installation

```bash
git clone https://github.com/cortex-mesh/openclaw-rocketchat.git
cd openclaw-rocketchat
npm install
```

## Configuration

Add to your `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "rocketchat": {
      "enabled": true,
      "url": "http://your-rocketchat:3000",
      "authToken": "your-auth-token",
      "userId": "your-user-id",
      "channel": "your-channel-name",
      "botUsername": "your-bot-username",
      "pollInterval": 2
    }
  },
  "plugins": {
    "allow": ["rocketchat"],
    "load": {
      "paths": ["/path/to/openclaw-rocketchat"]
    },
    "entries": {
      "rocketchat": { "enabled": true }
    }
  }
}
```

### Getting Rocket.Chat Credentials

1. Log in to your Rocket.Chat instance
2. Go to **My Account** > **Personal Access Tokens**
3. Create a new token — copy the **User Id** and **Token** values
4. Use these as `userId` and `authToken` in the config

### Config Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `url` | string | required | Rocket.Chat server URL |
| `authToken` | string | required | Personal access token |
| `userId` | string | required | User ID for the bot account |
| `channel` | string | required | Channel name to monitor (without #) |
| `botUsername` | string | — | Bot's username (for display) |
| `pollInterval` | number | `2` | Polling interval in seconds |

## How It Works

```
Rocket.Chat channel
        ↓ poll every 2s
[Plugin monitors channel history]
        ↓ new message detected
[Add hourglass reaction]
        ↓
[Dispatch to OpenClaw agent]
        ↓ agent responds
[Send reply to channel/thread]
        ↓
[Replace hourglass with checkmark (or x on error)]
```

The plugin:
- Polls the configured channel for new messages
- Skips its own messages, system messages, and bot messages
- Adds an hourglass reaction when processing starts
- Routes messages through OpenClaw's agent system
- Replies in the same thread (or creates a new thread)
- Replaces hourglass with checkmark on success, x on failure

## Development

```bash
# Run tests
npm test

# Run tests in watch mode
npm run test:watch
```

## License

MIT
