# zTools
zTools is a modern web utility suite designed to provide practical developer tools, featuring its primary capability: the **Boombox URL Converter**. The application enables users to convert YouTube video links or upload local audio files instantly into direct download links compatible with GTA SA-MP Top4Top hosting.
The project is built using a clean Node.js/Express backend architecture alongside a Pug-based frontend interface featuring a modern minimalist design style.
## Core Features
 * **Boombox URL Converter:** The signature feature of zTools to transform YouTube video URLs into MP3 audio files with selectable bitrate qualities (92 kbps, 128 kbps, 256 kbps, 320 kbps).
 * **Local Audio Uploader:** A companion feature allowing users to upload local audio files (MP3, WAV, M4A) directly to Top4Top storage.
 * **Vercel Optimized:** Configured to run smoothly within a serverless Vercel deployment environment.
 * **Modern UI/UX:** Responsive interface featuring automatic dark/light mode support and interactive tab navigation.
## Directory Structure
```text
├── public/           # Static files (CSS, JS, public assets)
├── src/
│   ├── views/        # Pug template views (layout, home page, API documentation)
│   └── index.ts      # Main Express server logic and API endpoints
├── package.json      # Project dependencies and configuration scripts
├── tsconfig.json     # TypeScript compiler options
└── README.md         # Project documentation

```
## System Prerequisites
Ensure your environment includes the following software:
 * Node.js (Version 18 or higher recommended)
 * NPM or Yarn
## Installation and Setup
 1. Clone or download the repository to your local machine.
 2. Install the required dependencies by executing the following command in your terminal:
   ```bash
   npm install
   
   ```
 3. Run the application in development mode:
   ```bash
   npm run dev:tsx
   
   ```
 4. Open your web browser and navigate to:
   ```text
   http://localhost:3000
   
   ```
## API Endpoint Documentation
The application exposes public API endpoints suitable for integration into Discord bots, WhatsApp bots, or third-party applications.
### 1. YouTube Audio Conversion (Boombox Converter)
 * **URL:** POST /api/ytdl
 * **Content-Type:** application/json
 * **Payload Example:**
   ```json
   {
     "url": "https://www.youtube.com/watch?v=jNQXAC9IVRw",
     "quality": 128
   }
   
   ```
 * **Success Response:**
   ```json
   {
     "title": "Me at the zoo",
     "url": "https://a.top4top.io/m_xxxxxxx.mp3"
   }
   
   ```
### 2. Local Audio Upload
 * **URL:** POST /api/upload
 * **Content-Type:** multipart/form-data
 * **Payload:** Form file attachment under the key file (Maximum size 4.5 MB due to serverless constraints).
 * **Success Response:**
   ```json
   {
     "title": "audio_sample.mp3",
     "url": "https://a.top4top.io/m_xxxxxxx.mp3"
   }
   
   ```
## License
This project is distributed under the MIT License. Feel free to use, modify, and distribute as needed.