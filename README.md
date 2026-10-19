
<div align="center">

# 🤖 ME-AI

### Your Intelligent WhatsApp Companion

**An AI-powered WhatsApp assistant with conversational intelligence and voice interaction.**

<br>

![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-323330?style=for-the-badge&logo=javascript&logoColor=F7DF1E)
![Groq](https://img.shields.io/badge/Groq-F55036?style=for-the-badge)

<br>

[![GitHub](https://img.shields.io/badge/Developer-Chairulladn-181717?style=flat-square&logo=github)](https://github.com/Chairulladn)
![Status](https://img.shields.io/badge/Status-Active%20Development-2ea44f?style=flat-square)
![License](https://img.shields.io/badge/License-Not%20Specified-64748b?style=flat-square)

---

*Bringing artificial intelligence closer to everyday conversations.*

</div>

## ✨ Overview

**ME-AI** is a WhatsApp-based AI assistant designed to explore the possibilities of conversational artificial intelligence.

Built with **Node.js**, **Baileys**, and **Groq API**, ME-AI combines natural-language interactions with voice processing and automated messaging.

The goal is simple: **make AI interactions more natural, practical, and accessible.**

## 🚀 Features

| Feature | Description |
|---|---|
| 💬 **AI Chat** | Intelligent, context-aware conversations |
| 🎙️ **Voice Understanding** | Processes incoming voice messages |
| 🔊 **Voice Responses** | Generates spoken AI responses |
| 🖼️ **Image Understanding** | Supports AI-assisted image interpretation |
| ⚡ **Automation** | Handles WhatsApp interactions automatically |
| 🛡️ **Rate Limiting** | Helps control excessive requests |
| 🧩 **Modular Structure** | Separates AI, voice, commands, and utilities |

## 🛠️ Technology Stack

| Category | Technology |
|---|---|
| Runtime | Node.js |
| Language | JavaScript |
| WhatsApp Integration | Baileys |
| AI Inference | Groq API |
| Text-to-Speech | Edge TTS |
| Audio Processing | FFmpeg |
| Version Control | Git & GitHub |

## 🏗️ Project Structure

```text
ME-AI/
├── index.js
├── lib/
│   ├── ai.js
│   ├── commands.js
│   ├── connection.js
│   ├── database.js
│   ├── function.js
│   ├── rateLimiter.js
│   ├── sticker.js
│   ├── tts.js
│   └── voice.js
├── package.json
├── package-lock.json
├── .gitignore
└── README.md
```

## ⚙️ Getting Started

### 1. Prerequisites

Before getting started, make sure you have:

- Node.js and npm installed
- A valid Groq API key
- WhatsApp access for device pairing
- Any additional dependencies required by the project

### 2. Clone Repository

```bash
git clone https://github.com/Chairulladn/ME-AI.git
cd ME-AI
```

### 3. Install Dependencies

```bash
npm ci
```

### 4. Configure Environment

Create a `.env` file and configure the environment variables required by the application.

> **Security Notice:** Never commit API keys, tokens, passwords, or WhatsApp session credentials to a public repository.

### 5. Run ME-AI

Follow the startup script defined in `package.json` or the application's entry point.

## 🔐 Security

ME-AI uses environment-based configuration for sensitive information.

The following should remain private:

- `.env` — API keys and sensitive configuration
- `session/` — WhatsApp authentication credentials
- `node_modules/` — locally installed dependencies

Always review your code and Git history for exposed credentials before publishing.

## 🗺️ Development Focus

- [x] WhatsApp bot integration
- [x] AI-powered conversations
- [x] Voice input processing
- [x] AI-generated voice responses
- [ ] Expand automated testing
- [ ] Refine error handling

## 👨‍💻 Developer

<div align="center">

**Built and maintained by Chairulladn**

[![GitHub Profile](https://img.shields.io/badge/GitHub-Visit%20Profile-181717?style=for-the-badge&logo=github&logoColor=white)](https://github.com/Chairulladn)

<br>

*Built with curiosity. Improved through experimentation.*

**If you find this project interesting, consider giving it a ⭐!**

</div>
